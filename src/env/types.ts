import type { EnvdClient } from "./envd-client.ts";
import type { RemoteExecutionEnv } from "./remote-env.ts";

/**
 * How strongly an environment is separated from the host. Recorded in every run
 * manifest so experiments never silently mix isolation tiers.
 */
export type IsolationLevel =
	| "none" // envd runs as a plain host process (development only)
	| "process-sandbox" // host kernel, OS sandbox policy (macOS Seatbelt)
	| "container" // host kernel, namespaces + cgroups (runc)
	| "user-kernel" // gVisor: syscalls served by a user-space kernel
	| "vm"; // dedicated guest kernel (Apple container VM, Firecracker)

/** Logical paths as the agent sees them inside the environment. */
export interface EnvironmentPaths {
	workspace: string;
	resources: string;
	home: string;
	tmp: string;
}

/** How `/workspace` is populated when an environment is created. */
export type InitialState =
	| { kind: "empty" }
	/** Host directory copied into the environment (the host copy is never modified). */
	| { kind: "directory"; path: string; exclude?: string[] }
	/** Host `.tar.gz` extracted into the workspace. */
	| { kind: "archive"; path: string }
	/** Interactive use: the host directory itself is the workspace (read-write share). */
	| { kind: "mount"; path: string };

export interface EnvironmentLimits {
	cpus?: number;
	memoryMb?: number;
	pids?: number;
	diskMb?: number;
	/** "none" blocks all network access; "egress" allows outbound connections. Default "none". */
	network?: "none" | "egress";
}

export interface EnvironmentSpec {
	backend: string;
	/** Container / VM image for backends that use one. */
	image?: string;
	initialState: InitialState;
	/** Host directory of a materialized resource bundle, exposed read-only at `paths.resources`. */
	resourcesDir?: string;
	limits?: EnvironmentLimits;
	/** Extra environment variables for commands in the guest. */
	env?: Record<string, string>;
	/** Free-form label shown in listings (e.g. task id). */
	label?: string;
}

export interface EnvironmentInfo {
	envId: string;
	generation: number;
	backend: string;
	isolation: IsolationLevel;
	paths: EnvironmentPaths;
	image?: string;
	label?: string;
	createdAt: number;
	guest: { os: string; arch: string; hostname: string; uid: number; envdVersion: string };
	/** Backend-specific facts (container id, pid, …) for diagnostics. */
	details: Record<string, unknown>;
	limits: EnvironmentLimits;
	initialState: InitialState["kind"];
}

/** A live instance returned by a backend. */
export interface BackendInstance {
	paths: EnvironmentPaths;
	client: EnvdClient;
	details: Record<string, unknown>;
	/** Whether the backend already placed the resource bundle at `paths.resources`. */
	resourcesMounted: boolean;
	/** Whether the workspace was provided by the backend (mount) and must not be initialized. */
	workspaceProvided: boolean;
	destroy(): Promise<void>;
}

export interface EnvironmentBackend {
	readonly name: string;
	readonly isolation: IsolationLevel;
	/** Whether the backend can run on this host right now. */
	probe(): Promise<{ available: boolean; reason?: string }>;
	create(envId: string, spec: EnvironmentSpec, stateDir: string): Promise<BackendInstance>;
	/**
	 * Remove backend objects (containers, VMs, processes) of environments that belong to the
	 * calling Lily home (`owned`: every env id with a record there) but are not `live`. Objects of
	 * other Lily homes — or anything else that merely looks like Lily's — must never be touched.
	 */
	sweep?(live: Set<string>, owned: Set<string>): Promise<string[]>;
}

/** A provisioned environment as handed to the kernel. */
export interface EnvironmentLease {
	readonly info: EnvironmentInfo;
	readonly client: EnvdClient;
	readonly env: RemoteExecutionEnv;
	/** Tar.gz of the current workspace. */
	exportWorkspace(): Promise<Buffer>;
	destroy(): Promise<void>;
	readonly destroyed: boolean;
}
