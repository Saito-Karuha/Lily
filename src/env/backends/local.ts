import { type ChildProcess, spawn } from "node:child_process";
import { cp, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "../../util/fsx.ts";
import { makeTreeReadOnly, removeTree } from "../../util/tree.ts";
import { EnvdClient } from "../envd-client.ts";
import { envdBinary, hostTarget } from "../envd-binary.ts";
import type { BackendInstance, EnvironmentBackend, EnvironmentPaths, EnvironmentSpec, IsolationLevel } from "../types.ts";

export interface LocalBackendOptions {
	/** Wrap envd in a macOS Seatbelt profile (deny-by-default filesystem, optional network). */
	seatbelt?: boolean;
	/** Extra host paths the sandbox may read (toolchains outside the default system locations). */
	extraReadPaths?: string[];
}

const DEFAULT_PATH_DIRS = [
	"/opt/homebrew/bin",
	"/opt/homebrew/sbin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
	"/usr/sbin",
	"/sbin",
];

/** Host directories every sandboxed command may read (system, toolchains). */
const SYSTEM_READ_PATHS = [
	"/usr",
	"/bin",
	"/sbin",
	"/opt",
	"/System",
	"/Library",
	"/Applications/Xcode.app",
	"/private/etc",
	"/private/var/db/timezone",
	"/private/var/select",
	"/dev",
];

/**
 * Runs lily-envd as a host process in a per-environment state directory.
 *
 * Without Seatbelt this provides no isolation at all and is meant for
 * development and tests. With Seatbelt (macOS) the process may only read system
 * locations plus its own environment directory, may only write inside its
 * workspace/home/tmp, and has no network unless `limits.network = "egress"`.
 * Paths are real host paths: the "same view for every agent" guarantee needs a
 * container or VM backend.
 */
export class LocalBackend implements EnvironmentBackend {
	readonly name: string;
	readonly isolation: IsolationLevel;
	readonly #options: LocalBackendOptions;

	constructor(options: LocalBackendOptions = {}) {
		this.#options = options;
		this.name = options.seatbelt ? "seatbelt" : "local";
		this.isolation = options.seatbelt ? "process-sandbox" : "none";
	}

	async probe(): Promise<{ available: boolean; reason?: string }> {
		try {
			const target = hostTarget();
			await envdBinary(target.os, target.arch);
		} catch (error) {
			return { available: false, reason: (error as Error).message };
		}
		if (this.#options.seatbelt) {
			if (process.platform !== "darwin") return { available: false, reason: "Seatbelt requires macOS" };
			if (!(await exists("/usr/bin/sandbox-exec"))) return { available: false, reason: "sandbox-exec not found" };
		}
		return { available: true };
	}

	async create(envId: string, spec: EnvironmentSpec, stateDir: string): Promise<BackendInstance> {
		await mkdir(stateDir, { recursive: true });
		const root = await realpath(stateDir);
		const mount = spec.initialState.kind === "mount" ? await realpath(spec.initialState.path) : undefined;
		const paths: EnvironmentPaths = {
			workspace: mount ?? join(root, "workspace"),
			resources: join(root, "resources"),
			home: join(root, "home"),
			tmp: join(root, "tmp"),
		};
		for (const dir of [paths.home, paths.tmp, paths.resources]) await mkdir(dir, { recursive: true });
		if (!mount) await mkdir(paths.workspace, { recursive: true });
		if (spec.resourcesDir) {
			await cp(spec.resourcesDir, paths.resources, { recursive: true });
			await makeTreeReadOnly(paths.resources);
		}

		const target = hostTarget();
		const binary = await envdBinary(target.os, target.arch);
		const env = guestEnvironment(paths, envId, spec.env);
		const args = ["serve", "--stdio", "--cwd", paths.workspace, "--tmp", paths.tmp, "--home", paths.home];
		let command = binary;
		let commandArgs = args;
		if (this.#options.seatbelt) {
			const profile = seatbeltProfile({
				readPaths: [...SYSTEM_READ_PATHS, ...(this.#options.extraReadPaths ?? []), root, binary, ...(mount ? [mount] : [])],
				writePaths: [paths.workspace, paths.home, paths.tmp],
				network: spec.limits?.network ?? "none",
			});
			command = "/usr/bin/sandbox-exec";
			commandArgs = ["-p", profile, binary, ...args];
		}
		const child = spawn(command, commandArgs, { cwd: paths.workspace, env, stdio: ["pipe", "pipe", "pipe"] });
		const stderr: string[] = [];
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 100) stderr.push(chunk.toString("utf8"));
		});
		const client = new EnvdClient(child.stdout!, child.stdin!);
		try {
			await client.handshake({ timeoutMs: 10_000 });
		} catch (error) {
			child.kill("SIGKILL");
			throw new Error(`lily-envd failed to start: ${(error as Error).message}\n${stderr.join("")}`);
		}
		return {
			paths,
			client,
			details: { pid: child.pid, stateDir: root, seatbelt: Boolean(this.#options.seatbelt) },
			resourcesMounted: Boolean(spec.resourcesDir),
			workspaceProvided: Boolean(mount),
			destroy: () => destroyLocal(child, client, root),
		};
	}
}

async function destroyLocal(child: ChildProcess, client: EnvdClient, root: string): Promise<void> {
	await client.shutdown();
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await new Promise((resolve) => child.once("exit", resolve));
	}
	await removeTree(root);
}

function guestEnvironment(paths: EnvironmentPaths, envId: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
	// Never inherit the host environment: it holds API keys and host configuration.
	return {
		PATH: DEFAULT_PATH_DIRS.join(":"),
		HOME: paths.home,
		TMPDIR: paths.tmp,
		LANG: "en_US.UTF-8",
		LC_ALL: "en_US.UTF-8",
		TERM: "dumb",
		SHELL: "/bin/bash",
		USER: process.env.USER ?? "agent",
		LILY_ENV_ID: envId,
		...extra,
	};
}

function quote(path: string): string {
	return JSON.stringify(path);
}

/**
 * Seatbelt (SBPL) profile: deny by default, allow reading system locations and
 * the environment's own directory, writing only its workspace/home/tmp.
 * The process/IPC/sysctl allowances follow Anthropic's open-source
 * sandbox-runtime (@anthropic-ai/sandbox-runtime); unlike it, Lily denies reads
 * of the rest of the host filesystem (e.g. the user's home directory).
 */
export function seatbeltProfile(options: {
	readPaths: string[];
	writePaths: string[];
	network: "none" | "egress";
}): string {
	const read = options.readPaths.map((p) => `  (subpath ${quote(p)})`).join("\n");
	const write = options.writePaths.map((p) => `  (subpath ${quote(p)})`).join("\n");
	return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow process-info* (target same-sandbox))
(allow signal (target same-sandbox))
(allow mach-priv-task-port (target same-sandbox))
(allow user-preference-read)
(allow mach-lookup
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.logd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.coreservices.launchservicesd")
  (global-name "com.apple.lsd.mapdb"))
(allow ipc-posix-shm)
(allow ipc-posix-sem)
(allow iokit-get-properties)
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read*
  (literal "/")
${read})
(allow file-write*
${write}
  (literal "/dev/null")
  (literal "/dev/tty")
  (subpath "/dev/fd"))
(allow file-ioctl
  (literal "/dev/null")
  (literal "/dev/tty")
  (literal "/dev/urandom")
  (literal "/dev/random"))
${options.network === "egress" ? "(allow network*)" : "(deny network*)"}
`;
}
