import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { removeTree } from "../util/tree.ts";
import type { LilyHome } from "../store/home.ts";
import { Semaphore } from "../util/async.ts";
import { readJsonIfExists, writeJsonAtomic } from "../util/fsx.ts";
import { newId } from "../util/ids.ts";
import { packDirectory } from "./archive.ts";
import { readFile } from "node:fs/promises";
import { RemoteExecutionEnv } from "./remote-env.ts";
import type {
	BackendInstance,
	EnvironmentBackend,
	EnvironmentInfo,
	EnvironmentLease,
	EnvironmentSpec,
} from "./types.ts";

export type EnvironmentStatus = "provisioning" | "ready" | "destroyed" | "lost" | "failed";

export interface EnvironmentRecord {
	envId: string;
	status: EnvironmentStatus;
	spec: EnvironmentSpec;
	info?: EnvironmentInfo;
	error?: string;
	updatedAt: number;
	/** Controller process that owns the lease. */
	ownerPid: number;
}

export interface EnvironmentManagerOptions {
	maxConcurrent?: number;
}

/**
 * Provisions and tracks execution environments. Every environment gets a fresh
 * id, a generation number and a durable record; the manager never hands the
 * same live environment to two owners.
 */
export class EnvironmentManager {
	readonly #home: LilyHome;
	readonly #backends = new Map<string, EnvironmentBackend>();
	readonly #leases = new Map<string, Lease>();
	readonly #slots: Semaphore;

	constructor(home: LilyHome, options: EnvironmentManagerOptions = {}) {
		this.#home = home;
		this.#slots = new Semaphore(options.maxConcurrent ?? 16);
	}

	register(backend: EnvironmentBackend): void {
		this.#backends.set(backend.name, backend);
	}

	backends(): EnvironmentBackend[] {
		return [...this.#backends.values()];
	}

	backend(name: string): EnvironmentBackend {
		const backend = this.#backends.get(name);
		if (!backend) throw new Error(`Unknown environment backend: ${name} (known: ${[...this.#backends.keys()].join(", ")})`);
		return backend;
	}

	live(): EnvironmentLease[] {
		return [...this.#leases.values()];
	}

	get(envId: string): EnvironmentLease | undefined {
		return this.#leases.get(envId);
	}

	async provision(spec: EnvironmentSpec): Promise<EnvironmentLease> {
		const backend = this.backend(spec.backend);
		const probe = await backend.probe();
		if (!probe.available) throw new Error(`Backend ${backend.name} unavailable: ${probe.reason}`);
		const release = await this.#slots.acquire();
		const envId = newId("env");
		const stateDir = this.#home.env(envId);
		const recordPath = join(stateDir, "env.json");
		const record: EnvironmentRecord = {
			envId,
			status: "provisioning",
			spec,
			updatedAt: Date.now(),
			ownerPid: process.pid,
		};
		await writeJsonAtomic(recordPath, record);
		let instance: BackendInstance | undefined;
		try {
			instance = await backend.create(envId, spec, join(stateDir, "state"));
			await this.#initialize(instance, spec);
			const guest = instance.client.info;
			const info: EnvironmentInfo = {
				envId,
				generation: 1,
				backend: backend.name,
				isolation: backend.isolation,
				paths: instance.paths,
				image: spec.image,
				label: spec.label,
				createdAt: Date.now(),
				guest: { os: guest.os, arch: guest.arch, hostname: guest.hostname, uid: guest.uid, envdVersion: guest.version },
				details: instance.details,
				limits: spec.limits ?? {},
				initialState: spec.initialState.kind,
			};
			const lease = new Lease(info, instance, async (status) => {
				this.#leases.delete(envId);
				release();
				await writeJsonAtomic(recordPath, { ...record, status, info, updatedAt: Date.now() });
			});
			this.#leases.set(envId, lease);
			await writeJsonAtomic(recordPath, { ...record, status: "ready", info, updatedAt: Date.now() });
			void instance.client.whenClosed().then(() => lease.markLost());
			return lease;
		} catch (error) {
			release();
			await instance?.destroy().catch(() => {});
			await writeJsonAtomic(recordPath, {
				...record,
				status: "failed",
				error: (error as Error).message,
				updatedAt: Date.now(),
			});
			throw error;
		}
	}

	async #initialize(instance: BackendInstance, spec: EnvironmentSpec): Promise<void> {
		const { client, paths } = instance;
		await client.request("fs.mkdir", { path: paths.workspace, recursive: true });
		if (!instance.workspaceProvided) {
			const state = spec.initialState;
			if (state.kind === "directory") {
				await client.upload(paths.workspace, await packDirectory(state.path, { exclude: state.exclude }));
			} else if (state.kind === "archive") {
				await client.upload(paths.workspace, await readFile(state.path));
			} else if (state.kind === "mount") {
				throw new Error(`Backend does not support mounted workspaces`);
			}
		}
		if (spec.resourcesDir && !instance.resourcesMounted) {
			await client.upload(paths.resources, await packDirectory(spec.resourcesDir));
			const exit = await client.exec({ command: `chmod -R a-w ${shellQuote(paths.resources)}` });
			if (exit.exitCode !== 0) throw new Error("Failed to make resources read-only");
		}
	}

	/** Destroys all leases owned by this process. */
	async destroyAll(): Promise<void> {
		await Promise.all(this.live().map((lease) => lease.destroy().catch(() => {})));
	}

	/**
	 * Marks environments left behind by dead controllers as lost, removes the
	 * state of ended environments older than `retentionMs`, and asks every
	 * backend to remove objects that no live record owns.
	 */
	async sweep(retentionMs = 24 * 60 * 60 * 1000): Promise<string[]> {
		const removed: string[] = [];
		const liveIds = new Set<string>();
		// Only environments recorded in this home are ever swept: other Lily homes on the same
		// machine (tests, a second server) run containers with the same naming scheme.
		const ownedIds = new Set<string>();
		let names: string[] = [];
		try {
			names = await readdir(this.#home.envs);
		} catch {
			return removed;
		}
		for (const name of names) {
			const dir = join(this.#home.envs, name);
			const recordPath = join(dir, "env.json");
			const record = await readJsonIfExists<EnvironmentRecord>(recordPath);
			if (!record) continue;
			ownedIds.add(record.envId);
			const active = record.status === "provisioning" || record.status === "ready";
			if (active && (this.#leases.has(record.envId) || isAlive(record.ownerPid))) {
				liveIds.add(record.envId);
				continue;
			}
			if (active) {
				await writeJsonAtomic(recordPath, { ...record, status: "lost", updatedAt: Date.now() });
				removed.push(record.envId);
			} else if (Date.now() - record.updatedAt > retentionMs) {
				await removeTree(dir);
			}
		}
		for (const backend of this.#backends.values()) {
			if (backend.sweep) removed.push(...(await backend.sweep(liveIds, ownedIds)));
		}
		return [...new Set(removed)];
	}
}

class Lease implements EnvironmentLease {
	readonly info: EnvironmentInfo;
	readonly env: RemoteExecutionEnv;
	readonly #instance: BackendInstance;
	readonly #onEnd: (status: EnvironmentStatus) => Promise<void>;
	#ended = false;

	constructor(info: EnvironmentInfo, instance: BackendInstance, onEnd: (status: EnvironmentStatus) => Promise<void>) {
		this.info = info;
		this.#instance = instance;
		this.#onEnd = onEnd;
		this.env = new RemoteExecutionEnv(instance.client, {
			cwd: info.paths.workspace,
			home: info.paths.home,
			tmp: info.paths.tmp,
		});
	}

	get client() {
		return this.#instance.client;
	}

	get destroyed(): boolean {
		return this.#ended;
	}

	exportWorkspace(): Promise<Buffer> {
		return this.#instance.client.download(this.info.paths.workspace);
	}

	async destroy(): Promise<void> {
		if (this.#ended) return;
		this.#ended = true;
		try {
			await this.#instance.destroy();
		} finally {
			await this.#onEnd("destroyed");
		}
	}

	async markLost(): Promise<void> {
		if (this.#ended) return;
		this.#ended = true;
		await this.#instance.destroy().catch(() => {});
		await this.#onEnd("lost");
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
