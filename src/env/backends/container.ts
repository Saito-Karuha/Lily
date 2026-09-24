import { type ChildProcess, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Semaphore } from "../../util/async.ts";
import { EnvdClient } from "../envd-client.ts";
import { envdBinary, type GuestArch, hostTarget } from "../envd-binary.ts";
import type { BackendInstance, EnvironmentBackend, EnvironmentPaths, EnvironmentSpec, IsolationLevel } from "../types.ts";

const run = promisify(execFile);

export type ContainerDialect = "apple" | "docker" | "podman";

export interface ContainerBackendOptions {
	dialect: ContainerDialect;
	/** Backend name used in specs and manifests (default: the dialect, or "gvisor" with runsc). */
	name?: string;
	/** CLI executable (default: `container`, `docker` or `podman`). */
	binary?: string;
	/** OCI runtime for docker/podman, e.g. "runsc" for gVisor. */
	runtime?: string;
	/** Image used when the spec does not name one. */
	defaultImage?: string;
	/**
	 * Numeric `UID:GID` commands run as (default: root inside the isolated guest). The workspace
	 * (unless it is a host mount) and home are handed to this user.
	 */
	user?: string;
}

/** Fixed guest layout: every environment presents the same paths to the agent. */
export const GUEST_PATHS: EnvironmentPaths = {
	workspace: "/workspace",
	resources: "/opt/lily/resources",
	home: "/home/agent",
	tmp: "/tmp",
};

const ENVD_GUEST_DIR = "/opt/lily/bin";
const NAME_PREFIX = "lily-";
const ENV_LABEL = "lily.env";
const DEFAULT_PIDS = 1024;

/**
 * Host environment the container CLI itself needs (daemon/socket selection, rootless runtime
 * dirs, contexts). It configures the CLI only: guest variables are always passed explicitly as
 * `-e KEY=VALUE`, so none of this reaches the environment.
 */
function cliEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "/" };
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (/^(DOCKER_|CONTAINER_|CONTAINERS_|PODMAN_|XDG_RUNTIME_DIR$|XDG_CONFIG_HOME$|XDG_DATA_HOME$|DBUS_SESSION_BUS_ADDRESS$|USER$|LOGNAME$|TMPDIR$)/.test(key)) {
			env[key] = value;
		}
	}
	return env;
}

/**
 * One container per environment through a container CLI:
 * - `apple`: Apple's `container` (macOS 26+) runs every container in its own
 *   lightweight VM with a dedicated Linux kernel → isolation "vm".
 * - `docker`/`podman` with runtime `runsc` (gVisor) → "user-kernel".
 * - plain `docker`/`podman` (runc/crun, shared host kernel) → "container".
 *
 * The guest's PID 1 is `lily-envd init` (prepares directories, applies the pids limit where the
 * runtime has none, reaps orphans); the controller talks to a `lily-envd serve --stdio` started
 * with `exec -i`. The envd binary and the resource bundle are read-only bind mounts; the
 * workspace lives on the guest's own disk unless the spec mounts a host directory (interactive
 * use). Nothing from the host environment is passed in.
 */
export class ContainerBackend implements EnvironmentBackend {
	readonly name: string;
	readonly isolation: IsolationLevel;
	readonly #options: ContainerBackendOptions;
	readonly #binary: string;
	readonly #createLock = new Semaphore(1);
	#host: Promise<{ arch: GuestArch; selinux: boolean }> | undefined;

	constructor(options: ContainerBackendOptions) {
		if (options.user !== undefined && !/^\d+(:\d+)?$/.test(options.user)) throw new Error(`ContainerBackend user must be numeric UID[:GID], got ${options.user}`);
		this.#options = options;
		this.#binary = options.binary ?? (options.dialect === "apple" ? "container" : options.dialect);
		this.name = options.name ?? (options.runtime === "runsc" ? "gvisor" : options.dialect === "apple" ? "apple-container" : options.dialect);
		this.isolation = options.dialect === "apple" ? "vm" : options.runtime === "runsc" ? "user-kernel" : "container";
	}

	/** Whether the pids limit is enforced by envd inside the guest rather than by the runtime. */
	get #guestPidsLimit(): boolean {
		return this.#options.dialect === "apple" || this.#options.runtime === "runsc";
	}

	#cli(args: string[], timeout: number) {
		return run(this.#binary, args, { timeout, maxBuffer: 16 * 1024 * 1024, env: cliEnvironment() });
	}

	async probe(): Promise<{ available: boolean; reason?: string }> {
		const { dialect, runtime } = this.#options;
		try {
			if (dialect === "apple") {
				const { stdout } = await this.#cli(["system", "status"], 30_000);
				if (!/status\s+running/.test(stdout)) return { available: false, reason: "container services are not running (container system start)" };
			} else if (dialect === "docker") {
				const { stdout } = await this.#cli(["info", "--format", "{{json .Runtimes}}"], 10_000);
				if (runtime && !stdout.includes(`"${runtime}"`)) return { available: false, reason: `runtime ${runtime} is not configured in docker (daemon.json "runtimes")` };
			} else {
				// podman has no runtime list in `info`; resolving the runtime is the check.
				await this.#cli([...(runtime ? ["--runtime", runtime] : []), "info", "--format", "{{.Host.OCIRuntime.Name}}"], 30_000);
			}
		} catch (error) {
			return { available: false, reason: `${this.#binary} unavailable: ${cliError(error)}` };
		}
		try {
			await envdBinary("linux", (await this.#hostFacts()).arch);
		} catch (error) {
			return { available: false, reason: (error as Error).message };
		}
		return { available: true };
	}

	/** Guest architecture (envd must match it) and whether bind mounts need SELinux relabeling. */
	#hostFacts(): Promise<{ arch: GuestArch; selinux: boolean }> {
		this.#host ??= (async () => {
			const { dialect } = this.#options;
			if (dialect === "apple") return { arch: hostTarget().arch, selinux: false };
			try {
				const format = dialect === "docker" ? "{{.Architecture}}|{{json .SecurityOptions}}" : "{{.Host.Arch}}|{{.Host.Security.SELinuxEnabled}}";
				const { stdout } = await this.#cli(["info", "--format", format], 30_000);
				const [arch = "", security = ""] = stdout.trim().split("|");
				return { arch: /aarch64|arm64/.test(arch) ? "arm64" : /x86_64|amd64/.test(arch) ? "amd64" : hostTarget().arch, selinux: /selinux|true/.test(security) };
			} catch {
				this.#host = undefined;
				return { arch: hostTarget().arch, selinux: false };
			}
		})();
		return this.#host;
	}

	#runArgs(envId: string, spec: EnvironmentSpec, envdDir: string, image: string, host: { arch: GuestArch; selinux: boolean }): string[] {
		const { dialect, runtime, user } = this.#options;
		const limits = spec.limits ?? {};
		const args = ["run", "-d", "--name", `${NAME_PREFIX}${envId}`, "--label", `${ENV_LABEL}=${envId}`];
		// Egress uses the CLI's default network (docker: bridge, podman: bridge or pasta, apple: default).
		if (limits.network !== "egress") args.push("--network", "none");
		// envd init prepares directories and must run as root whatever USER the image declares.
		// (No --workdir: podman refuses a workdir the image lacks; init creates /workspace, and
		// `serve` waits for it.)
		args.push("--user", "0:0");
		const initArgs = ["init", "--mkdir", GUEST_PATHS.workspace, "--mkdir", GUEST_PATHS.home, "--mkdir", `${GUEST_PATHS.tmp}:1777`];
		if (user) initArgs.push("--chown", user.includes(":") ? user : `${user}:${user}`);
		if (dialect === "apple") {
			args.push("--arch", host.arch);
			// Apple allocates whole vCPUs; memory has MiB granularity.
			if (limits.cpus) args.push("--cpus", String(Math.max(1, Math.ceil(limits.cpus))));
			if (limits.memoryMb) args.push("--memory", `${Math.ceil(limits.memoryMb)}M`);
		} else {
			args.push("--platform", `linux/${host.arch}`);
			if (runtime) args.push("--runtime", runtime);
			if (limits.cpus) args.push("--cpus", String(limits.cpus));
			if (limits.memoryMb) {
				// memory-swap = memory: the limit is not silently doubled by swap on hosts that have it.
				args.push("--memory", `${Math.ceil(limits.memoryMb)}m`, "--memory-swap", `${Math.ceil(limits.memoryMb)}m`);
			}
			// gVisor's sentry needs ~2 host tasks per guest process plus ~32 of its own, and dies when the
			// host limit is hit: keep that limit as a generous backstop and enforce the real one inside.
			const pids = limits.pids ?? DEFAULT_PIDS;
			args.push("--pids-limit", String(this.#guestPidsLimit ? pids * 4 + 128 : pids));
			args.push("--security-opt", "no-new-privileges");
		}
		// Apple has no pids flag; gVisor needs the limit inside the sandbox (see above): envd init
		// applies it with the guest kernel's pids cgroup and every `serve` session joins it.
		if (this.#guestPidsLimit) initArgs.push("--pids-max", String(limits.pids ?? DEFAULT_PIDS));
		for (const cap of ["NET_RAW", "MKNOD", "AUDIT_WRITE", "SYS_CHROOT", "SETPCAP"]) args.push("--cap-drop", cap);
		// Podman on SELinux hosts must relabel bind mounts for the container to read them.
		const relabel = dialect === "podman" && host.selinux ? ",relabel=shared" : "";
		args.push("--mount", `type=bind,source=${mountSource(envdDir)},target=${ENVD_GUEST_DIR},readonly${relabel}`);
		if (spec.resourcesDir) args.push("--mount", `type=bind,source=${mountSource(spec.resourcesDir)},target=${GUEST_PATHS.resources},readonly${relabel}`);
		if (spec.initialState.kind === "mount") args.push("--mount", `type=bind,source=${mountSource(spec.initialState.path)},target=${GUEST_PATHS.workspace}${relabel}`);
		args.push("--entrypoint", `${ENVD_GUEST_DIR}/lily-envd`, image, ...initArgs);
		// Podman's `--network none` namespace has lo down when the runtime starts (crun brings it up
		// itself, runsc does not), so gVisor would have no loopback: use gVisor's own "none" network.
		if (dialect === "podman" && runtime === "runsc" && limits.network !== "egress") args.unshift("--runtime-flag", "network=none");
		return args;
	}

	async create(envId: string, spec: EnvironmentSpec, _stateDir: string): Promise<BackendInstance> {
		const image = spec.image ?? this.#options.defaultImage ?? "python:3.12-slim";
		const host = await this.#hostFacts();
		const envdDir = (await envdBinary("linux", host.arch)).replace(/\/lily-envd$/, "");
		const name = `${NAME_PREFIX}${envId}`;
		await this.#start(name, this.#runArgs(envId, spec, envdDir, image, host), image);
		const envVars: Record<string, string> = {
			HOME: GUEST_PATHS.home,
			TMPDIR: GUEST_PATHS.tmp,
			LANG: "C.UTF-8",
			LC_ALL: "C.UTF-8",
			TERM: "dumb",
			LILY_ENV_ID: envId,
			...spec.env,
		};
		const execArgs = ["exec", "-i"];
		if (this.#options.user) execArgs.push("--user", this.#options.user);
		for (const [key, value] of Object.entries(envVars)) execArgs.push("-e", `${key}=${value}`);
		execArgs.push(name, `${ENVD_GUEST_DIR}/lily-envd`, "serve", "--stdio", "--cwd", GUEST_PATHS.workspace, "--tmp", GUEST_PATHS.tmp, "--home", GUEST_PATHS.home);
		if (this.#guestPidsLimit) execArgs.push("--join-pids-cgroup");
		const child = spawn(this.#binary, execArgs, { stdio: ["pipe", "pipe", "pipe"], env: cliEnvironment() });
		const stderr: string[] = [];
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 50) stderr.push(chunk.toString("utf8"));
		});
		// A failed spawn surfaces as a closed transport; without a listener it would crash the process.
		child.once("error", (error) => stderr.push(`${error.message}\n`));
		const client = new EnvdClient(child.stdout!, child.stdin!);
		try {
			await client.handshake({ timeoutMs: 60_000 });
		} catch (error) {
			child.kill("SIGKILL");
			const logs = await this.#cli(["logs", name], 15_000).then(
				(r) => `${r.stdout}${r.stderr}`.trim().split("\n").slice(-10).join("\n"),
				() => "",
			);
			await this.#remove(name);
			throw new Error(`lily-envd failed to start in ${name}: ${(error as Error).message}\n${stderr.join("")}${logs ? `\ncontainer log:\n${logs}` : ""}`);
		}
		try {
			await this.#checkLimits(client, spec);
		} catch (error) {
			await this.#destroy(name, child, client);
			throw error;
		}
		return {
			paths: GUEST_PATHS,
			client,
			details: { container: name, image, cli: this.#binary, runtime: this.#options.runtime ?? null, guestArch: host.arch },
			resourcesMounted: Boolean(spec.resourcesDir),
			workspaceProvided: spec.initialState.kind === "mount",
			destroy: () => this.#destroy(name, child, client),
		};
	}

	/**
	 * Runtimes can accept limits and silently not apply them — e.g. rootless podman/docker without
	 * a systemd-delegated cgroup (`cgroupfs` manager). The container's own cgroup files tell.
	 * (Not for gVisor, whose host cgroup is invisible inside, nor Apple, where init sets them.)
	 */
	async #checkLimits(client: EnvdClient, spec: EnvironmentSpec): Promise<void> {
		if (this.#guestPidsLimit) return;
		const read = async (...paths: string[]) => {
			for (const path of paths) {
				const text = await client.readFile(path, 256).then(
					(r) => r.data.toString("utf8").trim(),
					() => undefined,
				);
				if (text !== undefined) return text;
			}
			return undefined;
		};
		const pids = await read("/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/pids/pids.max");
		const memory = spec.limits?.memoryMb ? await read("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes") : undefined;
		const ignored = [
			...(pids === "max" ? ["pids"] : []),
			...(memory !== undefined && (memory === "max" || Number(memory) > 2 ** 60) ? ["memory"] : []),
		];
		if (ignored.length) {
			throw new Error(
				`${this.#binary} started the container without its ${ignored.join(" and ")} limit (rootless ${this.#binary} without a systemd-delegated cgroup?). ` +
					"Use the systemd cgroup manager with delegation, or a rootful daemon.",
			);
		}
	}

	/**
	 * Starts the container. Apple's container service can fail when several VMs
	 * are created at the same moment, so creation is serialized for that dialect
	 * and a failed attempt is cleaned up and retried once.
	 */
	async #start(name: string, args: string[], image: string): Promise<void> {
		const attempt = async () => this.#cli(args, 600_000);
		const once = async () => {
			try {
				await attempt();
			} catch (first) {
				await this.#remove(name);
				try {
					await attempt();
				} catch (error) {
					const detail = cliError(error) || cliError(first);
					throw new Error(`Failed to start ${this.name} environment from ${image}: ${detail}`);
				}
			}
		};
		if (this.#options.dialect === "apple") await this.#createLock.run(once);
		else await once();
	}

	async #destroy(name: string, child: ChildProcess, client: EnvdClient): Promise<void> {
		await client.shutdown();
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await this.#remove(name);
	}

	async #remove(name: string): Promise<void> {
		const args = this.#options.dialect === "apple" ? ["delete", "--force", name] : ["rm", "-f", name];
		// Apple's service occasionally fails an operation that races another one; retry once. Anything
		// still left is removed by the next sweep (its record stays in the home).
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await this.#cli(args, 120_000);
				return;
			} catch (error) {
				if (/no such container|not found/i.test(cliError(error))) return;
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}
	}

	/** Lists Lily containers (running or not) managed by this CLI. */
	async listContainers(): Promise<string[]> {
		try {
			if (this.#options.dialect === "apple") {
				const { stdout } = await this.#cli(["list", "--all", "--format", "json"], 30_000);
				const parsed = JSON.parse(stdout || "[]") as Array<{ configuration?: { id?: string; labels?: Record<string, string> } }>;
				return parsed
					.filter((c) => c.configuration?.labels?.[ENV_LABEL] !== undefined)
					.map((c) => c.configuration?.id ?? "")
					.filter((id) => id.startsWith(NAME_PREFIX));
			}
			const { stdout } = await this.#cli(["ps", "-a", "--filter", `label=${ENV_LABEL}`, "--format", "{{.Names}}"], 30_000);
			return stdout
				.split("\n")
				.map((s) => s.trim())
				.filter((s) => s.startsWith(NAME_PREFIX));
		} catch {
			return [];
		}
	}

	async sweep(live: Set<string>, owned: Set<string>): Promise<string[]> {
		const removed: string[] = [];
		for (const name of await this.listContainers()) {
			const envId = name.slice(NAME_PREFIX.length);
			if (live.has(envId) || !owned.has(envId)) continue;
			await this.#remove(name);
			removed.push(envId);
		}
		return removed;
	}
}

/** `--mount` takes comma-separated key=value pairs; a comma in a path cannot be expressed portably. */
function mountSource(path: string): string {
	if (path.includes(",")) throw new Error(`Cannot bind-mount a path containing a comma: ${path}`);
	return path;
}

function cliError(error: unknown): string {
	const stderr = (error as { stderr?: string }).stderr?.trim();
	const message = stderr || (error as Error)?.message || String(error);
	return message.split("\n").filter(Boolean).slice(-3).join(" ");
}
