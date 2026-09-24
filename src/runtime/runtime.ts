import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, JsonlSessionRepo, type JsonlSessionMetadata } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { MutableModels } from "@earendil-works/pi-ai";
import { ContainerBackend } from "../env/backends/container.ts";
import { FirecrackerBackend } from "../env/backends/firecracker.ts";
import { LocalBackend } from "../env/backends/local.ts";
import { EnvironmentManager } from "../env/manager.ts";
import type { EnvironmentBackend, EnvironmentSpec } from "../env/types.ts";
import { type LilyConfig, loadConfig } from "../models/config.ts";
import type { TokenCaptureFactory } from "../models/recording.ts";
import { buildModels } from "../models/registry.ts";
import { vllmTokenCapture } from "../models/token-capture.ts";
import { BundleRegistry } from "../resources/registry.ts";
import { type BundleRouter, loadRouter } from "../resources/router.ts";
import { ArtifactStore } from "../store/artifacts.ts";
import { LilyHome } from "../store/home.ts";
import { LilyError } from "../util/errors.ts";
import type { SessionBinding } from "./binding.ts";
import { LilySession, readBinding, type RuntimeServices, type SessionInit } from "./session.ts";

const ctx = BACKGROUND_CONTEXT;

export interface RuntimeOptions {
	home?: string;
	config?: LilyConfig;
	/** Replace the model registry (tests inject faux providers). */
	models?: MutableModels;
	backends?: EnvironmentBackend[];
	maxConcurrentEnvironments?: number;
	tokenCapture?: TokenCaptureFactory;
	/** Bundle router for sessions bound to `@router` (default: the module named by `config.router`, if any). */
	router?: BundleRouter;
}

export interface SessionSummary {
	sessionId: string;
	title?: string;
	mode: SessionBinding["mode"];
	model: string;
	bundle: string | null;
	createdAt: number;
	updatedAt: number;
	runs: number;
	workspaceLabel?: string;
	labels?: Record<string, string>;
	parent?: SessionBinding["parent"];
	open: boolean;
	busy: boolean;
}

/**
 * Process-level composition root: data directory, model gateway, bundle
 * registry, environment manager and the open session workers.
 */
export class LilyRuntime {
	readonly home: LilyHome;
	readonly config: LilyConfig;
	/** Model registry shared by all sessions; each session records through its own gateway. */
	readonly models: MutableModels;
	readonly tokenCapture: TokenCaptureFactory | undefined;
	readonly registry: BundleRegistry;
	readonly envs: EnvironmentManager;
	readonly artifacts: ArtifactStore;
	readonly repo: JsonlSessionRepo;
	/** Consulted at the start of every run of a session bound to `@router`; may be replaced at any time. */
	router: BundleRouter | undefined;
	readonly #sessions = new Map<string, LilySession>();
	readonly #opening = new Map<string, Promise<LilySession>>();

	private constructor(home: LilyHome, config: LilyConfig, options: RuntimeOptions) {
		this.home = home;
		this.config = config;
		this.models = options.models ?? buildModels(config);
		const captureProviders = Object.entries(config.providers ?? {})
			.filter(([, provider]) => provider.tokenCapture === "vllm")
			.map(([id]) => id);
		this.tokenCapture = options.tokenCapture ?? (captureProviders.length ? vllmTokenCapture(captureProviders) : undefined);
		this.artifacts = new ArtifactStore(home.artifacts);
		this.registry = new BundleRegistry(home.registry);
		this.envs = new EnvironmentManager(home, { maxConcurrent: options.maxConcurrentEnvironments ?? 16 });
		const backends = options.backends ?? defaultBackends(config);
		for (const backend of backends) this.envs.register(backend);
		this.repo = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: home.root }), sessionsRoot: home.sessions });
		this.router = options.router;
	}

	static async create(options: RuntimeOptions = {}): Promise<LilyRuntime> {
		const home = new LilyHome(options.home);
		await home.init();
		const config = options.config ?? (await loadConfig(home));
		const router = options.router ?? (config.router ? await loadRouter(config.router, home.root) : undefined);
		const runtime = new LilyRuntime(home, config, { ...options, ...(router ? { router } : {}) });
		await runtime.envs.sweep();
		return runtime;
	}

	get services(): RuntimeServices {
		const runtime = this;
		return {
			home: this.home,
			config: this.config,
			models: this.models,
			...(this.tokenCapture ? { tokenCapture: this.tokenCapture } : {}),
			registry: this.registry,
			envs: this.envs,
			artifacts: this.artifacts,
			repo: this.repo,
			get router() {
				return runtime.router;
			},
		};
	}

	/** Default environment spec for interactive use in a host directory (optionally on another backend). */
	defaultEnvironment(workspace: string, backendOverride?: string): EnvironmentSpec {
		const backend = this.#backendName(backendOverride);
		// Backends that can share a host directory get a live mount; the others copy the directory in.
		const canMount = ["local", "seatbelt", "apple-container", "docker", "podman", "gvisor"].includes(backend);
		return this.isolatedEnvironment(canMount ? { kind: "mount", path: workspace } : { kind: "directory", path: workspace }, backend);
	}

	/**
	 * Spec for a fresh environment whose workspace starts as `initialState`
	 * (a copied host directory, an archive, or empty) — the host is never written.
	 */
	isolatedEnvironment(initialState: EnvironmentSpec["initialState"], backendOverride?: string): EnvironmentSpec {
		const env = this.config.environment;
		return {
			backend: this.#backendName(backendOverride),
			...(env?.image ? { image: env.image } : {}),
			initialState,
			...(env?.limits ? { limits: env.limits } : {}),
		};
	}

	#backendName(override?: string): string {
		return override ?? this.config.environment?.backend ?? (process.platform === "darwin" ? "seatbelt" : "local");
	}

	async createSession(init: SessionInit): Promise<LilySession> {
		const session = await LilySession.create(this.services, init);
		this.#sessions.set(session.id, session);
		return session;
	}

	/** Returns the open worker for a session, opening it (single writer per process) if needed. */
	async openSession(sessionId: string): Promise<LilySession> {
		const open = this.#sessions.get(sessionId);
		if (open) return open;
		const pending = this.#opening.get(sessionId);
		if (pending) return pending;
		const opening = LilySession.open(this.services, sessionId).then((session) => {
			this.#sessions.set(sessionId, session);
			return session;
		});
		this.#opening.set(sessionId, opening);
		try {
			return await opening;
		} finally {
			this.#opening.delete(sessionId);
		}
	}

	openSessions(): LilySession[] {
		return [...this.#sessions.values()];
	}

	async listSessions(filter?: { mode?: SessionBinding["mode"] }): Promise<SessionSummary[]> {
		const metas = await this.repo.list(undefined, ctx);
		const out: SessionSummary[] = [];
		for (const meta of metas) {
			const binding = await readBinding(this.home, meta.id);
			if (!binding) continue;
			if (filter?.mode && binding.mode !== filter.mode) continue;
			const open = this.#sessions.get(meta.id);
			out.push({
				sessionId: meta.id,
				...(binding.title ? { title: binding.title } : {}),
				mode: binding.mode,
				model: binding.model,
				bundle: binding.bundle,
				createdAt: binding.createdAt,
				updatedAt: Math.max(binding.updatedAt, meta.modifiedAt),
				runs: binding.runs.length,
				...(binding.workspaceLabel ? { workspaceLabel: binding.workspaceLabel } : {}),
				...(binding.labels ? { labels: binding.labels } : {}),
				...(binding.parent ? { parent: binding.parent } : {}),
				open: Boolean(open),
				busy: Boolean(open?.busy),
			});
		}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async closeSession(sessionId: string, options?: { destroyEnvironment?: boolean }): Promise<void> {
		const session = this.#sessions.get(sessionId);
		if (!session) return;
		this.#sessions.delete(sessionId);
		await session.close(options);
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.closeSession(sessionId);
		const meta = (await this.repo.list(undefined, ctx)).find((m) => m.id === sessionId);
		if (meta) await this.repo.delete(meta, ctx);
		await rm(this.home.sessionMeta(sessionId), { recursive: true, force: true });
	}

	/**
	 * Copies conversation history into a new session. `entryId` + `position`
	 * select the cut ("before" re-asks from that prompt, "at" continues from
	 * it). The workspace is never shared implicitly: mounted workspaces keep
	 * pointing at the same host directory; copied workspaces start from the
	 * source session's initial state unless `workspace: "current"` exports the
	 * live environment.
	 */
	async forkSession(
		sessionId: string,
		options: { entryId?: string; position?: "before" | "at"; scope?: "branch" | "tree"; workspace?: "initial" | "current" } = {},
	): Promise<LilySession> {
		const source = await this.openSession(sessionId);
		if (source.busy) throw new LilyError("session_busy", "Cannot fork while a run is active");
		const meta = (await this.repo.list(undefined, ctx)).find((m) => m.id === sessionId) as JsonlSessionMetadata;
		const forkOptions =
			options.scope === "tree"
				? ({ scope: "tree" } as const)
				: ({ scope: "branch", branch: "main", ...(options.entryId ? { entryId: options.entryId } : {}), position: options.position ?? "at" } as const);
		// The worker holds the source open; the repository forks from a coherent file prefix.
		const piSession = await this.repo.fork(meta, forkOptions, ctx);
		let spec = source.binding.environment.spec;
		if (options.workspace === "current" && spec.initialState.kind !== "mount" && source.lease) {
			const dir = await mkdtemp(join(this.home.root, "fork-"));
			const path = join(dir, "workspace.tgz");
			await writeFile(path, await source.lease.exportWorkspace());
			spec = { ...spec, initialState: { kind: "archive", path } };
		}
		const kind = options.scope === "tree" ? "tree" : options.entryId ? "fork" : "clone";
		return this.createSession({
			mode: source.binding.mode,
			model: source.binding.model,
			thinking: source.binding.thinking,
			bundle: source.binding.bundle,
			environment: spec,
			...(source.binding.title ? { title: `${source.binding.title} (${kind})` } : {}),
			...(source.binding.workspaceLabel ? { workspaceLabel: source.binding.workspaceLabel } : {}),
			...(source.binding.budget ? { budget: source.binding.budget } : {}),
			piSession,
			parent: { sessionId, entryId: options.entryId ?? null, kind },
		});
	}

	async close(): Promise<void> {
		await Promise.all([...this.#sessions.keys()].map((id) => this.closeSession(id)));
		await this.envs.destroyAll();
		await this.repo.close(ctx).catch(() => {});
	}
}

export function defaultBackends(config: LilyConfig): EnvironmentBackend[] {
	const extraReadPaths = config.environment?.seatbeltReadPaths ?? [];
	const defaultImage = config.environment?.image;
	const firecracker = config.environment?.firecracker;
	return [
		new LocalBackend(),
		new LocalBackend({ seatbelt: true, extraReadPaths }),
		new ContainerBackend({ dialect: "apple", ...(defaultImage ? { defaultImage } : {}) }),
		new ContainerBackend({ dialect: "docker", ...(defaultImage ? { defaultImage } : {}) }),
		new ContainerBackend({ dialect: "docker", runtime: "runsc", ...(defaultImage ? { defaultImage } : {}) }),
		new ContainerBackend({ dialect: "podman", ...(defaultImage ? { defaultImage } : {}) }),
		...(firecracker ? [new FirecrackerBackend(firecracker)] : []),
	];
}
