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

/**
 * How `/workspace` is populated when an environment is created. Except for `image` (and `mount`,
 * which shares a host directory), the workspace starts with exactly this content: anything an
 * image already has at the workspace path is removed first.
 */
export type InitialState =
	| { kind: "empty" }
	/** Host directory copied into the environment (the host copy is never modified). */
	| { kind: "directory"; path: string; exclude?: string[] }
	/** Host `.tar.gz` extracted into the workspace. */
	| { kind: "archive"; path: string }
	/** Interactive use: the host directory itself is the workspace (read-write share). */
	| { kind: "mount"; path: string }
	/** Whatever the image (container image or root filesystem) has at the workspace path, unchanged. */
	| { kind: "image" };

export interface EnvironmentLimits {
	cpus?: number;
	memoryMb?: number;
	pids?: number;
	/** Writable disk space: the Firecracker overlay layer's size. Other backends do not enforce it. */
	diskMb?: number;
	/** "none" blocks all network access; "egress" allows outbound connections. Default "none". */
	network?: "none" | "egress";
}

export interface EnvironmentSpec {
	backend: string;
	/**
	 * Image for backends that use one: a container image, or for Firecracker a name looked up in the
	 * backend's `images` map of root filesystems.
	 */
	image?: string;
	/** Host path of an ext4 root filesystem, for backends that boot one (Firecracker). Takes precedence over `image`. */
	rootfs?: string;
	initialState: InitialState;
	/** Host directory of a materialized resource bundle, exposed read-only at `paths.resources`. */
	resourcesDir?: string;
	/**
	 * Content digest of `resourcesDir` (a bundle digest). Backends may cache what they derive from the
	 * directory under this key; it must change whenever the directory's content does.
	 */
	resourcesDigest?: string;
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
	/** The root filesystem a VM booted from (Firecracker): host path, content digest and size. */
	rootfs?: RootfsInfo;
	label?: string;
	createdAt: number;
	/** Milliseconds from the provisioning request until the environment was ready (workspace and resources in place). */
	startupMs?: number;
	guest: { os: string; arch: string; hostname: string; uid: number; envdVersion: string };
	/** Backend-specific facts (container id, pid, …) for diagnostics. */
	details: Record<string, unknown>;
	limits: EnvironmentLimits;
	initialState: InitialState["kind"];
}

export interface RootfsInfo {
	path: string;
	digest: string;
	bytes: number;
}

/**
 * Resources an environment has used since it was created, measured by its backend. `host`
 * measurements come from the host (the VMM process, the container's cgroup) and cannot be
 * influenced by code in the guest; `guest` ones are read from the guest's own cgroup.
 */
export interface EnvironmentUsage {
	/** CPU time consumed, in milliseconds. */
	cpuMs?: number;
	/** Peak memory, in bytes. */
	memoryPeakBytes?: number;
	source: "host" | "guest";
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
	/** The root filesystem the environment booted from, when the backend boots one. */
	rootfs?: RootfsInfo;
	/** Resources used so far, when the backend can measure them. */
	usage?(): Promise<EnvironmentUsage | undefined>;
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
	/** Resources used since the environment was created; undefined when the backend cannot measure them. */
	usage(): Promise<EnvironmentUsage | undefined>;
	destroy(): Promise<void>;
	readonly destroyed: boolean;
}
