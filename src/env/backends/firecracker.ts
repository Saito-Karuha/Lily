import { type ChildProcess, execFile, spawn } from "node:child_process";
import { accessSync } from "node:fs";
import { access, chown, constants, copyFile, link, lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { sleep } from "../../util/async.ts";
import { LilyError } from "../../util/errors.ts";
import { EnvdClient } from "../envd-client.ts";
import type { BackendInstance, EnvironmentBackend, EnvironmentSpec, IsolationLevel } from "../types.ts";
import { hostProcessUsage } from "../usage.ts";
import { GUEST_PATHS } from "./container.ts";
import { DerivedFileCache, fileDigest } from "./file-cache.ts";

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
	/**
	 * Default ext4 root filesystem (a Linux userland with /opt/lily/bin/lily-envd, see
	 * scripts/firecracker), used when the spec names neither a `rootfs` nor an `image` from `images`.
	 */
	rootfs?: string;
	/** Root filesystems by image name: a spec's `image` selects one. */
	images?: Record<string, string>;
	/**
	 * How a VM gets a writable root filesystem (default "overlay"):
	 * - "overlay": the image is attached read-only and shared by all VMs; the VM's writes go to its
	 *   own sparse ext4 disk of `limits.diskMb` (default `diskMb`) that envd stacks on top with
	 *   overlayfs. Creation time does not depend on the image size. Needs overlayfs in the guest kernel.
	 * - "reflink": every VM gets a reflink copy of the image; fails unless the filesystem holding the
	 *   image and the Lily home supports reflinks (XFS, btrfs).
	 * - "copy": a reflink copy where possible, a full sparse copy otherwise (slow for large images).
	 */
	rootfsMode?: "overlay" | "reflink" | "copy";
	/** Writable disk of an overlay-mode VM when the spec has no `limits.diskMb`, in MiB. Default 4096. */
	diskMb?: number;
	/** Default vCPUs / memory when the spec has no limits. */
	vcpus?: number;
	memoryMb?: number;
	/** vsock port envd listens on inside the guest. */
	vsockPort?: number;
	/** `mkfs.ext4` (e2fsprogs ≥ 1.43) used to pack resource bundles into read-only drives. */
	mkfs?: string;
	/** Seconds to wait for the guest to boot and accept the controller. */
	bootTimeoutMs?: number;
	/**
	 * Directory for files shared between VMs: resource drives packed once per bundle digest, and
	 * image digests. Without it every VM packs its own resource drive.
	 */
	cacheDir?: string;
	/** Size budget of the resource drive cache, in MiB. Default 1024. */
	resourceCacheMb?: number;
}

const DEFAULT_PIDS = 1024;
const DEFAULT_DISK_MB = 4096;

/** `/dev/vda`, `/dev/vdb`, …: drives appear in configuration order. */
function driveDevice(index: number): string {
	return `/dev/vd${String.fromCharCode(97 + index)}`;
}

/**
 * One Firecracker microVM per environment (Linux + KVM).
 *
 * The guest kernel boots `lily-envd init --vm --vsock-port N` as PID 1; init starts a vsock
 * server child and the controller connects through Firecracker's vsock-over-UDS bridge
 * (`CONNECT <port>` handshake). The VM has no network device at all (only loopback), its own
 * kernel and its own writable root filesystem (by default an overlay over a shared read-only
 * image). The workspace is uploaded through envd after boot; the resource bundle is an ext4
 * image attached as a read-only drive, so not even root in the guest can modify it.
 */
export class FirecrackerBackend implements EnvironmentBackend {
	readonly name = "firecracker";
	readonly isolation: IsolationLevel = "vm";
	readonly #options: FirecrackerBackendOptions;
	readonly #drives: DerivedFileCache | undefined;

	constructor(options: FirecrackerBackendOptions) {
		this.#options = options;
		this.#drives = options.cacheDir ? new DerivedFileCache(join(options.cacheDir, "resources"), (options.resourceCacheMb ?? 1024) * 1024 * 1024) : undefined;
	}

	get #firecracker(): string {
		return this.#options.firecracker ?? "firecracker";
	}

	get #mode(): "overlay" | "reflink" | "copy" {
		return this.#options.rootfsMode ?? "overlay";
	}

	async probe(): Promise<{ available: boolean; reason?: string }> {
		if (process.platform !== "linux") return { available: false, reason: "Firecracker requires Linux with KVM" };
		try {
			await access("/dev/kvm", constants.R_OK | constants.W_OK);
		} catch {
			return { available: false, reason: "/dev/kvm is not accessible" };
		}
		const images = [this.#options.rootfs, ...Object.values(this.#options.images ?? {})].filter((p): p is string => Boolean(p));
		if (images.length === 0) return { available: false, reason: "no root filesystem configured (firecracker.rootfs or firecracker.images)" };
		for (const path of [this.#options.kernel, ...images]) {
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

	/** The root filesystem for a spec: its own `rootfs`, the one mapped to its `image`, or the default. */
	#rootfsFor(spec: EnvironmentSpec): string {
		if (spec.rootfs) return resolve(spec.rootfs);
		const images = this.#options.images;
		if (spec.image && images) {
			const mapped = images[spec.image];
			if (!mapped) throw new LilyError("invalid_environment", `The firecracker backend has no root filesystem for image ${spec.image} (known: ${Object.keys(images).join(", ") || "none"}; see firecracker.images)`);
			return resolve(mapped);
		}
		if (this.#options.rootfs) return resolve(this.#options.rootfs);
		throw new LilyError("invalid_environment", "The firecracker backend has no root filesystem: set firecracker.rootfs or firecracker.images, or give the spec a rootfs");
	}

	async create(envId: string, spec: EnvironmentSpec, stateDir: string): Promise<BackendInstance> {
		if (spec.initialState.kind === "mount") throw new LilyError("invalid_environment", "The firecracker backend copies workspaces in; host directory mounts are not supported");
		if (spec.limits?.network === "egress") throw new LilyError("invalid_environment", "The firecracker backend has no network device; egress is not supported");
		const rootfs = this.#rootfsFor(spec);
		try {
			await access(rootfs, constants.R_OK);
		} catch {
			throw new LilyError("invalid_environment", `Root filesystem ${rootfs} is not readable`);
		}
		// Hashing a large image takes seconds the first time (then it is cached): overlap it with the boot.
		const rootfsDigest = fileDigest(rootfs, this.#options.cacheDir ? join(this.#options.cacheDir, "digests.json") : undefined);
		rootfsDigest.catch(() => {});
		const mode = this.#mode;
		await mkdir(stateDir, { recursive: true });
		const jail = this.#options.jailer ? jailLayout(envId, stateDir, this.#firecracker) : undefined;
		// Files the VMM opens live in `root`: the state dir itself, or the jailer's chroot.
		const root = jail?.root ?? stateDir;
		const guestPath = (name: string) => (jail ? `/${name}` : join(root, name));
		// Hard links to files shared with other VMs (the image, cached drives): never chowned for a jail.
		const shared = new Set<string>();
		let child: ChildProcess | undefined;
		const details: Record<string, unknown> = { stateDir, rootfsMode: mode, jailer: Boolean(jail) };
		try {
			await mkdir(root, { recursive: true });
			const drives: Array<Record<string, unknown>> = [];
			const initArgs = [
				"init",
				"--vm",
				"--vsock-port",
				String(this.#options.vsockPort ?? 1024),
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
			if (mode === "overlay") {
				let image = rootfs;
				if (jail) {
					image = join(root, "rootfs.ext4");
					await this.#shareIntoJail(rootfs, image);
					shared.add(image);
				}
				drives.push({ drive_id: "rootfs", path_on_host: jail ? "/rootfs.ext4" : image, is_root_device: true, is_read_only: true });
				const diskMb = Math.max(64, Math.ceil(spec.limits?.diskMb ?? this.#options.diskMb ?? DEFAULT_DISK_MB));
				await this.#scratchDisk(join(root, "rw.ext4"), diskMb);
				drives.push({ drive_id: "rw", path_on_host: guestPath("rw.ext4"), is_root_device: false, is_read_only: false });
				initArgs.push("--overlay", driveDevice(drives.length - 1));
				details.diskMb = diskMb;
			} else {
				await copyImage(rootfs, join(root, "rootfs.ext4"), mode);
				drives.push({ drive_id: "rootfs", path_on_host: guestPath("rootfs.ext4"), is_root_device: true, is_read_only: false });
			}
			if (spec.resourcesDir) {
				const drive = await this.#resourceDrive(spec.resourcesDir, spec.resourcesDigest, root);
				let path = drive.path;
				if (jail && drive.cached) {
					path = join(root, "resources.ext4");
					await this.#shareIntoJail(drive.path, path);
					shared.add(path);
				}
				details.resourceDrive = drive.cached ? "cached" : "packed";
				drives.push({ drive_id: "resources", path_on_host: jail ? "/resources.ext4" : path, is_root_device: false, is_read_only: true });
				initArgs.push("--mount-ro", `${driveDevice(drives.length - 1)}:${GUEST_PATHS.resources}`);
			} else {
				initArgs.push("--mkdir", GUEST_PATHS.resources);
			}
			let kernel = this.#options.kernel;
			if (jail) {
				// A hard link when the jailed VMM can read the kernel, else a private copy (chowned below).
				if (await this.#linkIfReadable(kernel, join(root, "vmlinux"))) shared.add(join(root, "vmlinux"));
				else await copyFile(kernel, join(root, "vmlinux"));
				kernel = "/vmlinux";
			}
			// The kernel hands everything after "--" to init; Firecracker adds root=/dev/vda before it.
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
			if (jail) await chownTree(root, this.#options.uid ?? 1000, this.#options.gid ?? 1000, shared);
			const booted = Date.now();
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
				socket = await connectVsock(shortcut ?? uds, this.#options.vsockPort ?? 1024, this.#options.bootTimeoutMs ?? 60_000, child);
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
			details.bootMs = Date.now() - booted;
			const vm = child;
			const { digest, bytes } = await rootfsDigest;
			return {
				paths: GUEST_PATHS,
				client,
				details: { ...details, pid: vm.pid, vsock: join(root, "v.sock") },
				resourcesMounted: Boolean(spec.resourcesDir),
				workspaceProvided: false,
				rootfs: { path: rootfs, digest, bytes },
				usage: () => (vm.pid ? hostProcessUsage(vm.pid) : Promise.resolve(undefined)),
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

	/** An empty sparse ext4 disk for an overlay's upper layer (no journal: the disk dies with the VM). */
	async #scratchDisk(image: string, sizeMb: number): Promise<void> {
		await run("truncate", ["-s", `${sizeMb}M`, image]);
		await run(this.#options.mkfs ?? "mkfs.ext4", ["-q", "-F", "-m", "0", "-O", "^has_journal", "-E", "lazy_itable_init=1,nodiscard", "-L", "lily-rw", image], {
			timeout: 120_000,
		});
	}

	/** The bundle's read-only drive: from the cache when the bundle digest is known, else packed for this VM. */
	async #resourceDrive(dir: string, digest: string | undefined, root: string): Promise<{ path: string; cached: boolean }> {
		if (this.#drives && digest) {
			return { path: await this.#drives.get(digest.replace(/^sha256:/, ""), ".ext4", (path) => this.#packDrive(dir, path)), cached: true };
		}
		const path = join(root, "resources.ext4");
		await this.#packDrive(dir, path);
		return { path, cached: false };
	}

	/**
	 * Makes a file shared with other VMs visible in a jail's chroot without copying it: a hard link
	 * (the chroot must be on the same filesystem). The jailed VMM must be able to read it.
	 */
	async #shareIntoJail(file: string, target: string): Promise<void> {
		if (!(await this.#readableInJail(file))) throw new Error(`${file} must be readable by the jailer's uid ${this.#options.uid ?? 1000} (for example chmod 644)`);
		try {
			await link(file, target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EXDEV") {
				throw new Error(`${file} must be on the same filesystem as the Lily home to be shared with jailed VMs`);
			}
			throw error;
		}
	}

	async #readableInJail(file: string): Promise<boolean> {
		const st = await stat(file);
		const uid = this.#options.uid ?? 1000;
		const gid = this.#options.gid ?? 1000;
		return Boolean(st.mode & 0o004 || (st.uid === uid && st.mode & 0o400) || (st.gid === gid && st.mode & 0o040));
	}

	/** Hard-links `file` into a jail when the jailed VMM can read it there; false when it cannot (or the link fails). */
	async #linkIfReadable(file: string, target: string): Promise<boolean> {
		if (!(await this.#readableInJail(file))) return false;
		try {
			await link(file, target);
			return true;
		} catch {
			return false;
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

async function chownTree(dir: string, uid: number, gid: number, skip: Set<string>): Promise<void> {
	await chown(dir, uid, gid);
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (skip.has(path)) continue;
		if (entry.isDirectory()) await chownTree(path, uid, gid, skip);
		else await chown(path, uid, gid);
	}
}

/** A private writable copy of an image for one VM. */
async function copyImage(from: string, to: string, mode: "reflink" | "copy"): Promise<void> {
	if (mode === "copy") {
		// Reflink where the filesystem supports it (btrfs/xfs), sparse copy otherwise.
		await run("cp", ["--reflink=auto", "--sparse=always", from, to]);
		return;
	}
	try {
		await run("cp", ["--reflink=always", from, to]);
	} catch (error) {
		throw new Error(
			`Cannot reflink ${from}: the filesystem holding it and the Lily home must support reflinks (XFS, btrfs) and be the same filesystem. ` +
				`Use firecracker.rootfsMode "overlay" (the default) or "copy" instead (${((error as { stderr?: string }).stderr ?? "").trim()})`,
		);
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
