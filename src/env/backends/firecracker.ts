import { type ChildProcess, execFile, spawn } from "node:child_process";
import { accessSync } from "node:fs";
import { access, chown, constants, copyFile, link, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { sleep } from "../../util/async.ts";
import { EnvdClient } from "../envd-client.ts";
import type { BackendInstance, EnvironmentBackend, EnvironmentSpec, IsolationLevel } from "../types.ts";
import { GUEST_PATHS } from "./container.ts";

const run = promisify(execFile);

export interface FirecrackerBackendOptions {
	/** Path to the firecracker binary. */
	firecracker?: string;
	/**
	 * Optional jailer binary; when set, every VM runs inside a jailer chroot (under its state
	 * directory) as `uid`/`gid`. The jailer must run as root.
	 */
	jailer?: string;
	uid?: number;
	gid?: number;
	/** Uncompressed guest kernel (vmlinux / arm64 Image) built for Firecracker. */
	kernel: string;
	/** ext4 root filesystem containing a Linux userland and /opt/lily/bin/lily-envd (see scripts/firecracker). */
	rootfs: string;
	/** Default vCPUs / memory when the spec has no limits. */
	vcpus?: number;
	memoryMb?: number;
	/** vsock port envd listens on inside the guest. */
	vsockPort?: number;
	/** `mkfs.ext4` (e2fsprogs ≥ 1.43) used to pack resource bundles into read-only drives. */
	mkfs?: string;
	/** Seconds to wait for the guest to boot and accept the controller. */
	bootTimeoutMs?: number;
}

const DEFAULT_PIDS = 1024;

/**
 * One Firecracker microVM per environment (Linux + KVM).
 *
 * The guest kernel boots `lily-envd init --vm --vsock-port N` as PID 1; init starts a vsock
 * server child and the controller connects through Firecracker's vsock-over-UDS bridge
 * (`CONNECT <port>` handshake). The VM has no network device at all (only loopback), a private
 * copy-on-write copy of the root filesystem, and its own kernel. The workspace is uploaded
 * through envd after boot; the resource bundle is packed into an ext4 image attached as a
 * read-only drive, so not even root in the guest can modify it.
 */
export class FirecrackerBackend implements EnvironmentBackend {
	readonly name = "firecracker";
	readonly isolation: IsolationLevel = "vm";
	readonly #options: FirecrackerBackendOptions;

	constructor(options: FirecrackerBackendOptions) {
		this.#options = options;
	}

	get #firecracker(): string {
		return this.#options.firecracker ?? "firecracker";
	}

	async probe(): Promise<{ available: boolean; reason?: string }> {
		if (process.platform !== "linux") return { available: false, reason: "Firecracker requires Linux with KVM" };
		try {
			await access("/dev/kvm", constants.R_OK | constants.W_OK);
		} catch {
			return { available: false, reason: "/dev/kvm is not accessible" };
		}
		for (const path of [this.#options.kernel, this.#options.rootfs]) {
			try {
				await access(path, constants.R_OK);
			} catch {
				return { available: false, reason: `missing ${path}` };
			}
		}
		for (const [binary, args] of [
			[this.#firecracker, ["--version"]],
			[this.#options.mkfs ?? "mkfs.ext4", ["-V"]],
			...(this.#options.jailer ? [[this.#options.jailer, ["--version"]]] : []),
		] as Array<[string, string[]]>) {
			try {
				await run(binary, args, { timeout: 10_000 });
			} catch (error) {
				return { available: false, reason: `${binary} unavailable: ${(error as Error).message.split("\n")[0]}` };
			}
		}
		if (this.#options.jailer && process.getuid?.() !== 0) return { available: false, reason: "the jailer must run as root" };
		return { available: true };
	}

	async create(envId: string, spec: EnvironmentSpec, stateDir: string): Promise<BackendInstance> {
		if (spec.initialState.kind === "mount") throw new Error("The firecracker backend copies workspaces in; host directory mounts are not supported");
		if (spec.limits?.network === "egress") throw new Error("The firecracker backend has no network device; egress is not supported");
		await mkdir(stateDir, { recursive: true });
		const jail = this.#options.jailer ? jailLayout(envId, stateDir, this.#firecracker) : undefined;
		// Files the VMM opens live in `root`: the state dir itself, or the jailer's chroot.
		const root = jail?.root ?? stateDir;
		const guestPath = (name: string) => (jail ? `/${name}` : join(root, name));
		let child: ChildProcess | undefined;
		try {
			await mkdir(root, { recursive: true });
			// Reflink where the filesystem supports it (btrfs/xfs), sparse copy otherwise.
			await run("cp", ["--reflink=auto", "--sparse=always", this.#options.rootfs, join(root, "rootfs.ext4")]);
			const drives: Array<Record<string, unknown>> = [
				{ drive_id: "rootfs", path_on_host: guestPath("rootfs.ext4"), is_root_device: true, is_read_only: false },
			];
			const port = this.#options.vsockPort ?? 1024;
			const initArgs = [
				"init",
				"--vm",
				"--vsock-port",
				String(port),
				"--mkdir",
				GUEST_PATHS.workspace,
				"--mkdir",
				GUEST_PATHS.home,
				"--mkdir",
				`${GUEST_PATHS.tmp}:1777`,
				"--readonly",
				"/opt/lily/bin",
				// The image's ENV, saved by scripts/firecracker/build-rootfs.sh.
				"--env-file",
				"/opt/lily/image.env",
				"--pids-max",
				String(spec.limits?.pids ?? DEFAULT_PIDS),
			];
			if (spec.resourcesDir) {
				await this.#packDrive(spec.resourcesDir, join(root, "resources.ext4"));
				drives.push({ drive_id: "resources", path_on_host: guestPath("resources.ext4"), is_root_device: false, is_read_only: true });
				// Drives appear in configuration order after the root device: vda, vdb, …
				initArgs.push("--mount-ro", `/dev/vd${String.fromCharCode(97 + drives.length - 1)}:${GUEST_PATHS.resources}`);
			} else {
				initArgs.push("--mkdir", GUEST_PATHS.resources);
			}
			let kernel = this.#options.kernel;
			if (jail) {
				await linkOrCopy(kernel, join(root, "vmlinux"));
				kernel = "/vmlinux";
			}
			// The kernel hands everything after "--" to init; Firecracker adds root=/dev/vda rw before it.
			const bootArgs = ["console=ttyS0", "reboot=k", "panic=1", "pci=off", "quiet", "init=/opt/lily/bin/lily-envd", "--", ...initArgs].join(" ");
			const config = {
				"boot-source": { kernel_image_path: kernel, boot_args: bootArgs },
				drives,
				"machine-config": {
					// Whole vCPUs only (Firecracker supports 1–32).
					vcpu_count: Math.min(32, Math.max(1, Math.ceil(spec.limits?.cpus ?? this.#options.vcpus ?? 2))),
					mem_size_mib: Math.max(128, Math.ceil(spec.limits?.memoryMb ?? this.#options.memoryMb ?? 2048)),
				},
				vsock: { guest_cid: 3, uds_path: guestPath("v.sock") },
			};
			await writeFile(join(root, "vm.json"), JSON.stringify(config, null, 2));
			if (jail) await chownTree(root, this.#options.uid ?? 1000, this.#options.gid ?? 1000);
			child = this.#launch(envId, jail ? "/vm.json" : join(root, "vm.json"), stateDir);
			const log: string[] = [];
			child.stdout?.on("data", (d: Buffer) => log.length < 400 && log.push(d.toString()));
			child.stderr?.on("data", (d: Buffer) => log.length < 400 && log.push(d.toString()));
			child.once("error", (error) => log.push(`${error.message}\n`));
			let socket: Socket;
			// sun_path holds 108 bytes and libuv silently truncates longer paths: connect through a
			// short symlink when the state directory is deep (always, under the jailer's chroot).
			const uds = join(root, "v.sock");
			const shortcut = Buffer.byteLength(uds) > 100 ? join(tmpdir(), `lily-vsock-${jailId(envId).slice(-24)}.sock`) : undefined;
			try {
				if (shortcut) {
					await rm(shortcut, { force: true });
					await symlink(uds, shortcut);
				}
				socket = await connectVsock(shortcut ?? uds, port, this.#options.bootTimeoutMs ?? 60_000, child);
			} catch (error) {
				throw new Error(`microVM ${envId} did not come up: ${(error as Error).message}\n${log.join("").slice(-3000)}`);
			} finally {
				if (shortcut) await rm(shortcut, { force: true });
			}
			const client = new EnvdClient(socket, socket);
			try {
				await client.handshake({ timeoutMs: 30_000, env: guestEnvironment(envId, spec.env) });
			} catch (error) {
				socket.destroy();
				throw new Error(`lily-envd in microVM ${envId} did not answer: ${(error as Error).message}\n${log.join("").slice(-3000)}`);
			}
			const vm = child;
			return {
				paths: GUEST_PATHS,
				client,
				details: { pid: vm.pid, stateDir, vsock: join(root, "v.sock"), jailer: Boolean(jail) },
				resourcesMounted: Boolean(spec.resourcesDir),
				workspaceProvided: false,
				destroy: async () => {
					await client.shutdown().catch(() => {});
					socket.destroy();
					await stopProcess(vm);
					await rm(stateDir, { recursive: true, force: true });
				},
			};
		} catch (error) {
			if (child) await stopProcess(child);
			await rm(stateDir, { recursive: true, force: true }).catch(() => {});
			throw error;
		}
	}

	/** Packs a directory into a small ext4 image (no journal; it is attached read-only). */
	async #packDrive(dir: string, image: string): Promise<void> {
		const bytes = await treeBytes(dir);
		const sizeMb = Math.ceil((bytes * 1.3) / (1024 * 1024)) + 16;
		await run("truncate", ["-s", `${sizeMb}M`, image]);
		await run(this.#options.mkfs ?? "mkfs.ext4", ["-q", "-F", "-O", "^has_journal", "-L", "lily-res", "-d", dir, image], { timeout: 120_000 });
	}

	#launch(envId: string, configPath: string, stateDir: string): ChildProcess {
		const id = jailId(envId);
		if (!this.#options.jailer) {
			return spawn(this.#firecracker, ["--id", id, "--no-api", "--config-file", configPath], { cwd: stateDir, stdio: ["ignore", "pipe", "pipe"] });
		}
		// Jailer: chroot + dropped privileges + seccomp; config paths are relative to the chroot.
		return spawn(
			this.#options.jailer,
			[
				"--id",
				id,
				// The jailer copies this file into the chroot and needs its real path.
				"--exec-file",
				resolveExecutable(this.#firecracker),
				"--uid",
				String(this.#options.uid ?? 1000),
				"--gid",
				String(this.#options.gid ?? 1000),
				"--chroot-base-dir",
				join(stateDir, "jail"),
				// The jailer passes --id (and its start time) to firecracker itself.
				"--",
				"--no-api",
				"--config-file",
				configPath,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
	}

	/**
	 * Kills microVMs left running by dead controllers (their firecracker processes outlive the
	 * controller). A VM is recognised by its state directory in the process command line.
	 */
	async sweep(live: Set<string>, owned: Set<string>): Promise<string[]> {
		const removed: string[] = [];
		let pids: string[];
		try {
			pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
		} catch {
			return removed;
		}
		for (const pid of pids) {
			let cmdline: string;
			try {
				cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ");
			} catch {
				continue;
			}
			if (!/(^|\/)(firecracker|jailer)\S* /.test(cmdline)) continue;
			for (const envId of owned) {
				if (live.has(envId) || !cmdline.includes(`--id ${jailId(envId)} `)) continue;
				try {
					process.kill(Number(pid), "SIGKILL");
					removed.push(envId);
				} catch {
					// Already gone.
				}
			}
		}
		return removed;
	}
}

/** Absolute path of a command, searching PATH for bare names. */
function resolveExecutable(command: string): string {
	if (command.includes("/")) return command;
	for (const dir of (process.env.PATH ?? "").split(":")) {
		const candidate = join(dir || ".", command);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// keep looking
		}
	}
	return command;
}

/** Firecracker/jailer instance ids: alphanumerics and hyphens, at most 64 characters. */
function jailId(envId: string): string {
	return envId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
}

function jailLayout(envId: string, stateDir: string, firecracker: string): { root: string } {
	return { root: join(stateDir, "jail", basename(firecracker), jailId(envId), "root") };
}

function guestEnvironment(envId: string, extra?: Record<string, string>): Record<string, string> {
	return {
		HOME: GUEST_PATHS.home,
		TMPDIR: GUEST_PATHS.tmp,
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		TERM: "dumb",
		LILY_ENV_ID: envId,
		...extra,
	};
}

async function stopProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGKILL");
	await Promise.race([exited, sleep(5000)]);
}

async function linkOrCopy(from: string, to: string): Promise<void> {
	try {
		await link(from, to);
	} catch {
		await copyFile(from, to);
	}
}

async function chownTree(dir: string, uid: number, gid: number): Promise<void> {
	await chown(dir, uid, gid);
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) await chownTree(path, uid, gid);
		else await chown(path, uid, gid);
	}
}

/** Approximate on-disk bytes of a tree (file sizes plus a block per entry). */
async function treeBytes(dir: string): Promise<number> {
	let total = 4096;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) total += await treeBytes(path);
		else total += (await lstat(path)).size + 4096;
	}
	return total;
}

/** Firecracker's host side of vsock: connect to the UDS, send `CONNECT <port>`, expect `OK <n>`. */
export async function connectVsock(path: string, port: number, timeoutMs: number, child: Pick<ChildProcess, "exitCode">): Promise<Socket> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`firecracker exited with ${child.exitCode}`);
		try {
			return await new Promise<Socket>((resolve, reject) => {
				const socket = connect(path);
				let buffer = "";
				// Firecracker holds the connection until the guest answers; never wait past the deadline.
				const timer = setTimeout(() => {
					socket.destroy();
					reject(new Error("no answer from the guest"));
				}, Math.max(100, deadline - Date.now()));
				const fail = (error: Error) => {
					clearTimeout(timer);
					reject(error);
				};
				const onData = (chunk: Buffer) => {
					buffer += chunk.toString("utf8");
					const newline = buffer.indexOf("\n");
					if (newline === -1) return;
					socket.off("data", onData);
					clearTimeout(timer);
					const line = buffer.slice(0, newline);
					if (!line.startsWith("OK ")) {
						socket.destroy();
						reject(new Error(`vsock handshake failed: ${line}`));
						return;
					}
					// Hold further data until the envd client attaches its reader.
					socket.pause();
					const rest = buffer.slice(newline + 1);
					if (rest) socket.unshift(Buffer.from(rest, "utf8"));
					resolve(socket);
				};
				socket.once("connect", () => socket.write(`CONNECT ${port}\n`));
				socket.on("data", onData);
				socket.once("error", fail);
				socket.once("close", () => fail(new Error("vsock closed during handshake")));
			});
		} catch (error) {
			lastError = error;
			await sleep(100);
		}
	}
	throw new Error(`timed out connecting to guest vsock: ${(lastError as Error)?.message ?? "unknown"}`);
}
