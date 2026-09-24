import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentHarness,
	type AgentLane,
	type AgentMessage,
	AgentHarness as Harness,
	BACKGROUND_CONTEXT,
	type Entry,
	type JsonlSessionMetadata,
	type JsonlSessionRepo,
	type OperationResultRecord,
	type Session,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import type { EnvironmentManager } from "../env/manager.ts";
import type { EnvironmentLease, EnvironmentSpec } from "../env/types.ts";
import { createLilyTools, DEFAULT_OBSERVATION_CAP_BYTES, ExecutionGateway, type LilyToolContext } from "../kernel/gateway.ts";
import { InvocationLedger } from "../kernel/ledger.ts";
import { assembleSystemPrompt } from "../kernel/system-prompt.ts";
import type { LilyConfig } from "../models/config.ts";
import { parseModelRef } from "../models/config.ts";
import { RecordingModels, type TokenCaptureFactory } from "../models/recording.ts";
import type { BundleRecord, BundleRegistry } from "../resources/registry.ts";
import { baselineProcessor, createProcessor } from "../resources/processor/dsl.ts";
import { renderResources } from "../resources/render.ts";
import { type BundleRouter, ROUTED_BUNDLE, type RouteRecord } from "../resources/router.ts";
import type { ArtifactStore } from "../store/artifacts.ts";
import { EventLog } from "../store/event-log.ts";
import type { LilyHome } from "../store/home.ts";
import { LILY_KERNEL_VERSION, type ModelCallRecord, type RunManifest, type RunOutcome, RunStore } from "../store/runs.ts";
import { deferred } from "../util/async.ts";
import { readJsonIfExists, writeJsonAtomic } from "../util/fsx.ts";
import { LilyError } from "../util/errors.ts";
import { digestOf, sha256 } from "../util/hash.ts";
import { newId } from "../util/ids.ts";
import type { SessionBinding } from "./binding.ts";
import type { LilyEvent } from "./events.ts";

export const PI_VERSION = "0.85.1";
const LANE = "main";

export interface RuntimeServices {
	home: LilyHome;
	config: LilyConfig;
	models: Models;
	tokenCapture?: TokenCaptureFactory;
	registry: BundleRegistry;
	envs: EnvironmentManager;
	artifacts: ArtifactStore;
	repo: JsonlSessionRepo;
	/** Chooses the bundle of each run in sessions bound to `@router`. */
	router?: BundleRouter;
}

export interface SessionInit {
	mode: "interactive" | "batch";
	model: string;
	thinking?: ThinkingLevel;
	/** Bundle ref or digest, `@router` to let the runtime's router choose per run, or null for the bare kernel. */
	bundle: string | null;
	environment: EnvironmentSpec;
	title?: string;
	workspaceLabel?: string;
	labels?: Record<string, string>;
	budget?: { maxTurns?: number; timeoutMs?: number };
	/** Existing Pi session to bind (forks); otherwise a new one is created. */
	piSession?: Session<JsonlSessionMetadata>;
	parent?: SessionBinding["parent"];
}

export interface RunOptions {
	budget?: { maxTurns?: number; timeoutMs?: number };
	/** Overlaid on the session's labels; recorded in the manifest and shown to the router. */
	labels?: Record<string, string>;
	/** Include the current date in the system prompt (interactive default). */
	includeDate?: boolean;
}

export interface RunHandle {
	runId: string;
	done: Promise<RunOutcome>;
}

interface PinnedRun {
	runId: string;
	manifest: RunManifest;
	systemPrompt: string;
	gateway: ExecutionGateway;
	store: RunStore;
}

interface ActiveRun {
	runId: string;
	operationId?: string;
	startedAt: number;
	turns: number;
	toolCalls: number;
	calls: ModelCallRecord[];
	reason?: string;
	status?: RunOutcome["status"];
	lastAssistant?: AssistantMessage;
	timer?: ReturnType<typeof setTimeout>;
	maxTurns?: number;
}

const ctx = BACKGROUND_CONTEXT;

function bindingPath(home: LilyHome, sessionId: string): string {
	return join(home.sessionMeta(sessionId), "binding.json");
}

async function resolveBinding(services: RuntimeServices, ref: string | null): Promise<string | null> {
	if (ref === null) return null;
	if (ref === ROUTED_BUNDLE) return ROUTED_BUNDLE;
	return services.registry.resolve(ref);
}

export async function readBinding(home: LilyHome, sessionId: string): Promise<SessionBinding | undefined> {
	return readJsonIfExists<SessionBinding>(bindingPath(home, sessionId));
}

/**
 * One open Lily session: a single-writer loop worker over a Pi AgentHarness.
 * Each run pins its model, bundle, system prompt, observation processor and
 * environment in a manifest before the first model call; the harness reads the
 * pinned values, so nothing changes under a running (or resumed) run.
 */
export class LilySession {
	readonly id: string;
	readonly events: EventLog<LilyEvent>;
	binding: SessionBinding;
	readonly #services: RuntimeServices;
	readonly #session: Session<JsonlSessionMetadata>;
	readonly #ledger: InvocationLedger;
	/** This session's model gateway: records every request of its runs (never shared across sessions). */
	readonly #models: RecordingModels;
	#harness!: AgentHarness<LilyToolContext>;
	#lane!: AgentLane;
	#lease: EnvironmentLease | undefined;
	#leaseBundle: string | null = null;
	/** Environment being provisioned right now; concurrent callers share it instead of creating a second one. */
	#provisioning: { bundle: string | null; promise: Promise<EnvironmentLease> } | undefined;
	#pinned: PinnedRun | undefined;
	#active: ActiveRun | undefined;
	#runChain: Promise<unknown> = Promise.resolve();
	#closed = false;

	private constructor(services: RuntimeServices, session: Session<JsonlSessionMetadata>, binding: SessionBinding) {
		this.#services = services;
		this.#session = session;
		this.binding = binding;
		this.id = session.metadata.id;
		this.events = new EventLog<LilyEvent>(join(services.home.sessionMeta(this.id), "events.jsonl"));
		this.#ledger = new InvocationLedger(join(services.home.sessionMeta(this.id), "ledger.jsonl"));
		this.#models = new RecordingModels(services.models, services.artifacts, { tokenCapture: services.tokenCapture });
	}

	static async create(services: RuntimeServices, init: SessionInit): Promise<LilySession> {
		const bundleDigest = await resolveBinding(services, init.bundle);
		const piSession = init.piSession ?? (await services.repo.create({ cwd: `/lily/${init.mode}` }, ctx));
		const now = Date.now();
		const binding: SessionBinding = {
			sessionId: piSession.metadata.id,
			createdAt: now,
			updatedAt: now,
			...(init.title ? { title: init.title } : {}),
			mode: init.mode,
			model: init.model,
			thinking: init.thinking ?? "off",
			bundle: bundleDigest,
			environment: { spec: init.environment },
			runs: [],
			...(init.parent ? { parent: init.parent } : {}),
			...(init.workspaceLabel ? { workspaceLabel: init.workspaceLabel } : {}),
			...(init.labels ? { labels: init.labels } : {}),
			...(init.budget ? { budget: init.budget } : {}),
		};
		await writeJsonAtomic(bindingPath(services.home, binding.sessionId), binding);
		const session = new LilySession(services, piSession, binding);
		await session.#attach();
		session.events.emit({ type: "session_created", sessionId: session.id, title: init.title });
		if (init.title) await session.#harness.setName(init.title, ctx);
		return session;
	}

	static async open(services: RuntimeServices, sessionId: string): Promise<LilySession> {
		const binding = await readBinding(services.home, sessionId);
		if (!binding) throw new LilyError("not_found", `Unknown Lily session: ${sessionId}`);
		const metadata = (await services.repo.list(undefined, ctx)).find((m) => m.id === sessionId);
		if (!metadata) throw new Error(`Session store has no session ${sessionId}`);
		const piSession = await services.repo.open(metadata, ctx);
		const session = new LilySession(services, piSession, binding);
		await session.#attach();
		return session;
	}

	get metadata(): JsonlSessionMetadata {
		return this.#session.metadata;
	}

	get busy(): boolean {
		return this.#active !== undefined;
	}

	get activeRunId(): string | undefined {
		return this.#active?.runId;
	}

	get lease(): EnvironmentLease | undefined {
		return this.#lease && !this.#lease.destroyed ? this.#lease : undefined;
	}

	#model(ref: string): Model<Api> {
		const { provider, modelId } = parseModelRef(ref);
		const model = this.#models.getModel(provider, modelId);
		if (!model) throw new LilyError("unknown_model", `Unknown model ${ref}. Configure the provider or check the model id.`);
		return model;
	}

	async #attach(): Promise<void> {
		await this.events.load();
		await this.#ledger.load();
		const compaction = this.#services.config.compaction;
		const { harness, open } = await Harness.create<LilyToolContext>(
			{
				session: this.#session,
				models: this.#models,
				model: this.#model(this.binding.model),
				thinkingLevel: this.binding.thinking,
				tools: createLilyTools(),
				toolContext: () => {
					if (!this.#pinned) throw new Error("No run is active: tools need a pinned run environment");
					return { gateway: this.#pinned.gateway };
				},
				systemPrompt: () => this.#pinned?.systemPrompt ?? assembleSystemPrompt(undefined, { workspace: "/workspace" }).text,
				toolExecution: "sequential",
				compaction: {
					enabled: compaction?.enabled ?? true,
					reserveTokens: compaction?.reserveTokens ?? 16_384,
					keepRecentTokens: compaction?.keepRecentTokens ?? 20_000,
				},
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 2000 },
			},
			ctx,
		);
		this.#harness = harness;
		this.#installHooks();
		this.#lane = await harness.lane(LANE, ctx);
		for (const operation of open) await this.#recover(operation.operationId);
	}

	#installHooks(): void {
		const hooks = this.#harness.hooks;
		hooks.on("before_request", (event) => {
			this.#models.expect(event.step, event.attempt);
			return undefined;
		});
		hooks.on("after_tool", (event) => {
			const details = event.details as { lily?: { isError?: boolean } } | undefined;
			return details?.lily?.isError ? { isError: true } : undefined;
		});
		const events = this.#harness.events;
		const runId = () => this.#active?.runId ?? "";
		events.on("turn_start", () => {
			const active = this.#active;
			if (!active) return;
			active.turns++;
			this.events.emit({ type: "turn_start", runId: active.runId, turn: active.turns });
		});
		events.on("turn_end", (event) => {
			const active = this.#active;
			if (!active) return;
			active.lastAssistant = event.message;
			if (active.maxTurns !== undefined && active.turns >= active.maxTurns && event.toolResults.length > 0) {
				this.#stop("budget_turns");
			}
		});
		events.on("message_start", (event) => {
			this.events.emit({ type: "message_start", runId: runId(), role: event.message.role });
		});
		events.on("message_update", (event) => {
			const e = event.event;
			if (e.type === "text_delta" || e.type === "thinking_delta" || e.type === "toolcall_delta") {
				const kind = e.type === "text_delta" ? "text" : e.type === "thinking_delta" ? "thinking" : "toolcall";
				this.events.emit({ type: "message_delta", runId: runId(), kind, contentIndex: e.contentIndex, delta: e.delta });
			}
		});
		events.on("message_end", (event) => {
			this.events.emit({ type: "message_end", runId: runId(), entryId: event.entryId, message: event.message });
		});
		events.on("tool_start", (event) => {
			if (this.#active) this.#active.toolCalls++;
			this.events.emit({ type: "tool_start", runId: runId(), toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
		});
		events.on("tool_update", (event) => {
			const text = event.partialResult.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			this.events.emit({ type: "tool_update", runId: runId(), toolCallId: event.toolCallId, text });
		});
		events.on("tool_end", (event) => {
			const details = event.result.details as { lily?: import("../kernel/gateway.ts").LilyToolMeta; diff?: string } | undefined;
			this.events.emit({
				type: "tool_end",
				runId: runId(),
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
				content: event.result.content.map((part) =>
					part.type === "text" ? { type: "text", text: part.text } : { type: "image", mimeType: part.mimeType },
				),
				...(details?.lily ? { lily: details.lily } : {}),
				...(typeof details?.diff === "string" ? { diff: details.diff } : {}),
			});
		});
		events.on("compaction_start", (event) => {
			this.events.emit({ type: "compaction_start", runId: this.#active?.runId, reason: event.reason });
		});
		events.on("compaction_end", (event) => {
			this.events.emit({
				type: "compaction_end",
				runId: this.#active?.runId,
				status: event.status,
				...(event.status === "completed" ? { entryId: event.entryId } : {}),
				...(event.status === "failed" ? { error: event.error } : {}),
			});
		});
		events.on("navigation_end", (event) => {
			this.events.emit({
				type: "navigation_end",
				status: event.status,
				fromTipId: event.fromTipId,
				tipId: event.tipId,
				...(event.status === "failed" ? { error: event.error } : {}),
			});
		});
		events.on("retry_scheduled", (event) => {
			this.events.emit({
				type: "retry",
				runId: this.#active?.runId,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				error: event.errorMessage,
			});
		});
		events.on("usage", (event) => {
			const t = event.totals;
			this.events.emit({ type: "usage", input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, cost: t.cost.total });
		});
		events.on("fault", (event) => {
			this.events.emit({ type: "notice", level: "error", message: `Harness fault (${event.code}): ${event.message}` });
		});
	}

	async #saveBinding(): Promise<void> {
		this.binding.updatedAt = Date.now();
		await writeJsonAtomic(bindingPath(this.#services.home, this.id), this.binding);
	}

	/** Makes sure a live environment with the requested bundle exists for this session. */
	async #ensureEnvironment(bundle: string | null): Promise<EnvironmentLease> {
		while (this.#provisioning) {
			const inFlight = this.#provisioning;
			if (inFlight.bundle === bundle) return inFlight.promise;
			await inFlight.promise.catch(() => {});
		}
		if (this.lease && this.#leaseBundle === bundle) return this.lease;
		const promise = this.#provisionEnvironment(bundle);
		this.#provisioning = { bundle, promise };
		try {
			return await promise;
		} finally {
			if (this.#provisioning?.promise === promise) this.#provisioning = undefined;
		}
	}

	async #provisionEnvironment(bundle: string | null): Promise<EnvironmentLease> {
		const envs = this.#services.envs;
		const spec = this.binding.environment.spec;
		if (this.lease && this.#leaseBundle === bundle) return this.lease;
		let initialState = spec.initialState;
		let carried: string | undefined;
		if (this.lease) {
			// Bundle changed: re-create the environment, carrying the workspace over.
			if (spec.initialState.kind !== "mount") {
				const archive = await this.lease.exportWorkspace();
				carried = await mkdtemp(join(tmpdir(), "lily-carry-"));
				await writeFile(join(carried, "workspace.tgz"), archive);
				initialState = { kind: "archive", path: join(carried, "workspace.tgz") };
			}
			this.events.emit({ type: "notice", level: "info", message: "Re-creating the environment to apply a different resource bundle." });
			await this.lease.destroy();
		} else if (this.binding.environment.current && this.binding.runs.length > 0 && spec.initialState.kind !== "mount") {
			this.events.emit({
				type: "notice",
				level: "warning",
				message: "The previous environment is gone; starting a fresh one from the session's initial workspace.",
			});
		}
		this.events.emit({ type: "environment", status: "provisioning" });
		try {
			const resourcesDir = bundle ? await this.#services.registry.path(bundle) : undefined;
			const lease = await envs.provision({ ...spec, initialState, ...(resourcesDir ? { resourcesDir } : {}) });
			this.#lease = lease;
			this.#leaseBundle = bundle;
			this.binding.environment.current = { envId: lease.info.envId, generation: lease.info.generation, backend: lease.info.backend, bundle };
			await this.#saveBinding();
			void lease.client.whenClosed().then(() => {
				if (!lease.destroyed || this.#lease === lease) {
					this.events.emit({ type: "environment", status: lease.destroyed ? "destroyed" : "lost", info: lease.info });
				}
			});
			this.events.emit({ type: "environment", status: "ready", info: lease.info });
			return lease;
		} finally {
			if (carried) await rm(carried, { recursive: true, force: true });
		}
	}

	/** The bundle this run uses: the bound one, or the router's choice for `@router` sessions. */
	async #chooseBundle(runId: string, prompt: string, labels: Record<string, string>): Promise<{ bundle: BundleRecord | undefined; route?: RouteRecord }> {
		const { registry, router } = this.#services;
		if (this.binding.bundle !== ROUTED_BUNDLE) {
			return { bundle: this.binding.bundle ? await registry.get(this.binding.bundle) : undefined };
		}
		if (!router) throw new LilyError("no_router", "This session is bound to @router but no router is configured (lily --router <module>)");
		const decision = await router.route({ sessionId: this.id, runId, mode: this.binding.mode, prompt, labels });
		const bundle = decision.bundle ? await registry.get(decision.bundle) : undefined;
		return {
			bundle,
			route: { router: router.name, requested: ROUTED_BUNDLE, bundle: bundle?.digest ?? null, ...(decision.info ? { info: decision.info } : {}) },
		};
	}

	async #pin(runId: string, prompt: string, options: RunOptions): Promise<PinnedRun> {
		const { registry, artifacts } = this.#services;
		const labels = { ...this.binding.labels, ...options.labels };
		const { bundle, route } = await this.#chooseBundle(runId, prompt, labels);
		const lease = await this.#ensureEnvironment(bundle?.digest ?? null);
		const resources = bundle
			? await renderResources(await registry.path(bundle.digest), bundle, lease.info.paths.resources)
			: undefined;
		const includeDate = options.includeDate ?? this.binding.mode === "interactive";
		const assembled = assembleSystemPrompt(resources, {
			workspace: lease.info.paths.workspace,
			...(includeDate ? { date: new Date().toISOString().slice(0, 10) } : {}),
		});
		const processor = resources?.processor ? createProcessor(resources.processor) : baselineProcessor;
		const model = this.#model(this.binding.model);
		const compaction = await this.#harness.getCompactionSettings(ctx);
		const tools = createLilyTools().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
		const budget = { ...this.binding.budget, ...options.budget };
		const manifest: RunManifest = {
			runId,
			sessionId: this.id,
			lane: LANE,
			createdAt: Date.now(),
			mode: this.binding.mode,
			prompt: { text: prompt, digest: sha256(prompt) },
			kernel: {
				version: LILY_KERNEL_VERSION,
				piAgentCore: PI_VERSION,
				piAi: PI_VERSION,
				toolsDigest: digestOf(tools),
				compaction,
				observationCapBytes: DEFAULT_OBSERVATION_CAP_BYTES,
			},
			model: { provider: model.provider, modelId: model.id, api: model.api, thinkingLevel: this.binding.thinking },
			bundle: bundle ? { digest: bundle.digest, name: bundle.manifest.name, componentDigests: bundle.componentDigests } : null,
			processorId: processor.id,
			systemPrompt: { digest: sha256(assembled.text), blocks: assembled.blocks },
			environment: lease.info,
			budget,
			...(Object.keys(labels).length ? { labels } : {}),
			...(route ? { route } : {}),
		};
		const store = new RunStore(this.#services.home.run(runId));
		await store.writeManifest(manifest);
		const gateway = new ExecutionGateway({
			runId,
			lease,
			ledger: this.#ledger,
			artifacts,
			processor,
			onOutcomeUnknown: () => this.#stop("outcome_unknown", "blocked"),
			onEnvironmentUnavailable: () => this.#stop("environment_lost", "failed"),
			onSettled: ({ invocationId, toolCallId, raw, meta }) => {
				void store.tools.append({
					runId,
					invocationId,
					toolCallId,
					toolName: meta.toolName,
					args: raw.args,
					isError: meta.isError,
					rawRef: meta.rawRef,
					rawComplete: meta.rawComplete,
					processorId: meta.processorId,
					reconciled: Boolean(meta.reconciled),
					durationMs: meta.durationMs,
					at: Date.now(),
				});
			},
		});
		return { runId, manifest, systemPrompt: assembled.text, gateway, store };
	}

	/** Requests a durable abort of the active run, recording why. */
	#stop(reason: string, status: RunOutcome["status"] = "aborted"): void {
		const active = this.#active;
		if (!active || active.reason) return;
		active.reason = reason;
		active.status = status;
		if (active.operationId) void this.#lane.requestAbort(active.operationId, ctx).catch(() => {});
	}

	/** Starts a run; resolves once it is accepted. `done` settles when it ends. */
	async prompt(text: string, options: RunOptions = {}): Promise<RunHandle> {
		if (this.#closed) throw new LilyError("session_closed", "Session is closed");
		if (this.#active) throw new LilyError("session_busy", "A run is already active in this session");
		const runId = newId("run");
		const active: ActiveRun = { runId, startedAt: Date.now(), turns: 0, toolCalls: 0, calls: [] };
		this.#active = active;
		// Covers the whole run, including environment provisioning, so abort()/idle() wait for it.
		const finished = deferred<void>();
		this.#runChain = finished.promise;
		try {
			const pinned = await this.#pin(runId, text, options);
			this.#pinned = pinned;
			active.maxTurns = pinned.manifest.budget.maxTurns;
			await this.#syncLaneConfig();
			this.#models.setSink({
				runId,
				sessionId: this.id,
				record: async (record) => {
					active.calls.push(record);
					await pinned.store.calls.append(record);
				},
			});
			this.binding.runs.push(runId);
			if (!this.binding.title) {
				this.binding.title = text.replace(/\s+/g, " ").trim().slice(0, 80);
				await this.#harness.setName(this.binding.title, ctx);
			}
			await this.#saveBinding();
			const operationId = this.#session.idGenerator.next();
			const accepted = await this.#lane.accept({ kind: "prompt", prompt: text, operationId }, ctx);
			if (!accepted.ok) throw new Error(`Run was not accepted: ${accepted.error.message}`);
			active.operationId = operationId;
			// An abort (or budget stop) requested while the run was still being prepared had no operation to cancel yet.
			if (active.reason) void this.#lane.requestAbort(operationId, ctx).catch(() => {});
			this.events.emit({
				type: "run_start",
				runId,
				sessionId: this.id,
				prompt: text,
				model: this.binding.model,
				bundle: this.binding.bundle,
				envId: pinned.manifest.environment.envId,
			});
			if (pinned.manifest.budget.timeoutMs) {
				active.timer = setTimeout(() => this.#stop("budget_time"), pinned.manifest.budget.timeoutMs);
			}
			const done = this.#drive(operationId, active, pinned);
			void done.then(
				() => finished.resolve(),
				() => finished.resolve(),
			);
			return { runId, done };
		} catch (error) {
			finished.resolve();
			this.#active = undefined;
			this.#models.setSink(undefined);
			// A manifest may already exist: close the run with a terminal outcome so it never looks "running".
			if (this.#pinned?.runId === runId) {
				const now = Date.now();
				await this.#pinned.store
					.writeOutcome({
						runId,
						status: "failed",
						reason: "start_failed",
						error: error instanceof Error ? error.message : String(error),
						startedAt: active.startedAt,
						endedAt: now,
						turns: 0,
						toolCalls: 0,
						modelCalls: 0,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
					})
					.catch(() => {});
			}
			throw error;
		}
	}

	async #syncLaneConfig(): Promise<void> {
		const { provider, modelId } = parseModelRef(this.binding.model);
		const current = await this.#lane.getModel(ctx);
		if (!current || current.provider !== provider || current.id !== modelId) await this.#lane.setModel({ provider, modelId }, ctx);
		if ((await this.#lane.getThinkingLevel(ctx)) !== this.binding.thinking) await this.#lane.setThinkingLevel(this.binding.thinking, ctx);
	}

	async #drive(operationId: string, active: ActiveRun, pinned: PinnedRun): Promise<RunOutcome> {
		let record: OperationResultRecord | undefined;
		let error: string | undefined;
		try {
			for (;;) {
				const result = await this.#lane.drive({ operationId, waitForRetry: true }, ctx);
				if (!result.ok) throw result.error;
				if (result.value.kind === "settled") {
					record = result.value.outcome;
					break;
				}
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		return this.#finish(active, pinned, record, error);
	}

	async #finish(active: ActiveRun, pinned: PinnedRun, record: OperationResultRecord | undefined, error?: string): Promise<RunOutcome> {
		if (active.timer) clearTimeout(active.timer);
		await this.#models.flush();
		await pinned.store.calls.flush();
		await pinned.store.tools.flush();
		const status: RunOutcome["status"] =
			active.status ?? (error ? "failed" : record?.status === "completed" ? "completed" : record?.status === "aborted" ? "aborted" : "failed");
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
		for (const call of active.calls) {
			if (!call.usage) continue;
			usage.input += call.usage.input;
			usage.output += call.usage.output;
			usage.cacheRead += call.usage.cacheRead;
			usage.cacheWrite += call.usage.cacheWrite;
			usage.totalTokens += call.usage.totalTokens;
		}
		for (const call of active.calls) {
			const response = await this.#services.artifacts.getJson<AssistantMessage>(call.responseRef).catch(() => undefined);
			usage.cost += response?.usage?.cost?.total ?? 0;
		}
		const finalText = active.lastAssistant?.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("")
			.trim();
		const outcome: RunOutcome = {
			runId: active.runId,
			status,
			...(active.reason ? { reason: active.reason } : {}),
			...(error || record?.error ? { error: error ?? record?.error?.message } : {}),
			startedAt: active.startedAt,
			endedAt: Date.now(),
			turns: active.turns,
			toolCalls: active.toolCalls,
			modelCalls: active.calls.length,
			usage,
			...(finalText ? { finalText } : {}),
			...(record ? { fromTipId: record.fromTipId, tipId: record.tipId } : {}),
		};
		await pinned.store.writeOutcome(outcome);
		this.#models.setSink(undefined);
		this.#active = undefined;
		this.events.emit({ type: "run_end", runId: active.runId, outcome });
		await this.events.flush();
		return outcome;
	}

	/**
	 * An operation left open by a previous process. Tools are replayed only
	 * through the ledger (completed results are re-fetched; unknown effects stop
	 * the run), so resuming never repeats a side effect blindly.
	 */
	async #recover(operationId: string): Promise<void> {
		const runId = [...this.binding.runs].reverse()[0];
		const store = runId ? new RunStore(this.#services.home.run(runId)) : undefined;
		const manifest = await store?.readManifest().catch(() => undefined);
		const existing = runId ? await store?.readOutcome() : undefined;
		if (!runId || !store || !manifest || existing) {
			await this.#abandon(operationId);
			return;
		}
		const active: ActiveRun = { runId, operationId, startedAt: manifest.createdAt, turns: 0, toolCalls: 0, calls: [] };
		const gatewayUnavailable = new ExecutionGateway({
			runId,
			lease: deadLease(manifest),
			ledger: this.#ledger,
			artifacts: this.#services.artifacts,
			// Reconciled results are served from the stored observation, so the processor is never consulted.
			processor: baselineProcessor,
			onOutcomeUnknown: () => this.#stop("outcome_unknown", "blocked"),
		});
		this.#pinned = { runId, manifest, systemPrompt: "", gateway: gatewayUnavailable, store };
		this.#active = active;
		// The environment of the previous process is gone; stop the operation cleanly.
		active.reason = "worker_restarted";
		active.status = "interrupted";
		await this.#lane.requestAbort(operationId, ctx).catch(() => {});
		const done = this.#drive(operationId, active, this.#pinned);
		this.#runChain = done.catch(() => {});
		await done;
	}

	async #abandon(operationId: string): Promise<void> {
		await this.#lane.requestAbort(operationId, ctx).catch(() => {});
		await this.#lane.drive({ operationId }, ctx).catch(() => {});
	}

	async abort(): Promise<void> {
		const active = this.#active;
		if (!active) return;
		if (!active.reason) {
			active.reason = "user_cancelled";
			active.status = "aborted";
		}
		if (active.operationId) await this.#lane.requestAbort(active.operationId, ctx).catch(() => {});
		await this.#runChain;
	}

	/** Waits for the active run, if any, to end. */
	async idle(): Promise<void> {
		await this.#runChain;
	}

	/**
	 * Adds a user message to the active run; the model sees it at the next turn
	 * boundary (Pi's steering queue). It becomes part of the same run and its
	 * recorded contexts.
	 */
	async steer(text: string): Promise<void> {
		if (!this.#active) throw new LilyError("not_running", "No run is active; send a new prompt instead");
		const runId = this.#active.runId;
		const result = await this.#lane.steer(text, undefined, ctx);
		if (!result.ok) throw new Error(result.error.message);
		this.events.emit({ type: "steer_queued", runId, text });
	}

	/**
	 * Runs a shell command in this session's environment on behalf of the caller
	 * (for example to check the workspace after a run). It is not part of any
	 * run: the model never sees it and it is not recorded as a tool call.
	 * Provisions the environment if none is live. Only allowed between runs.
	 */
	async exec(
		command: string,
		options: { timeoutMs?: number; cwd?: string; maxOutputBytes?: number; signal?: AbortSignal } = {},
	): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean; output: string; truncated: boolean; durationMs: number }> {
		if (this.#active) throw new LilyError("session_busy", "Cannot exec while a run is active");
		const lease = this.lease ?? (await this.#ensureEnvironment(this.binding.bundle === ROUTED_BUNDLE ? null : this.binding.bundle));
		const max = options.maxOutputBytes ?? 1024 * 1024;
		const chunks: Buffer[] = [];
		let kept = 0;
		let dropped = false;
		const exit = await lease.client.exec(
			{
				command,
				cwd: options.cwd ?? lease.info.paths.workspace,
				...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
			},
			{
				onOutput: (data) => {
					chunks.push(data);
					kept += data.byteLength;
					while (kept > max && chunks.length > 1) {
						kept -= chunks.shift()!.byteLength;
						dropped = true;
					}
				},
			},
			options.signal,
		);
		let output = Buffer.concat(chunks);
		if (output.byteLength > max) {
			output = output.subarray(output.byteLength - max);
			dropped = true;
		}
		return {
			exitCode: exit.exitCode,
			signal: exit.signal,
			timedOut: exit.timedOut,
			output: output.toString("utf8"),
			truncated: dropped || exit.truncated,
			durationMs: exit.durationMs,
		};
	}

	/**
	 * Provisions the environment for the bound bundle ahead of the first prompt (e.g. while a UI starts),
	 * so the first run does not wait for it. A no-op for `@router` sessions, whose bundle is only known per run.
	 */
	async prepare(): Promise<EnvironmentLease | undefined> {
		if (this.#closed) throw new LilyError("session_closed", "Session is closed");
		if (this.#active || this.binding.bundle === ROUTED_BUNDLE) return this.lease;
		return this.#ensureEnvironment(this.binding.bundle);
	}

	/** gzip'd tar of the environment's workspace (provisions one if none is live). Only allowed between runs. */
	async exportWorkspace(): Promise<Buffer> {
		if (this.#active) throw new LilyError("session_busy", "Cannot export the workspace while a run is active");
		const lease = this.lease ?? (await this.#ensureEnvironment(this.binding.bundle === ROUTED_BUNDLE ? null : this.binding.bundle));
		return lease.exportWorkspace();
	}

	async compact(customInstructions?: string): Promise<{ status: string; entryId?: string }> {
		if (this.#active) throw new LilyError("session_busy", "Cannot compact while a run is active");
		const result = await this.#lane.compact(customInstructions ? { customInstructions } : undefined, ctx);
		if (!result.ok) throw new Error(result.error.message);
		return { status: result.value.compaction.status, ...(result.value.compaction.tipId ? { entryId: result.value.compaction.tipId } : {}) };
	}

	/**
	 * Moves the conversation to another entry (history only: the workspace is not rolled back).
	 * Like Pi's /tree, choosing a user message moves to its parent and returns the message text
	 * as `editorText`, so re-asking does not stack two user messages.
	 */
	async navigate(
		targetId: string | null,
		options?: { summarize?: boolean; customInstructions?: string },
	): Promise<{ status: string; tipId: string | null; editorText?: string }> {
		if (this.#active) throw new LilyError("session_busy", "Cannot navigate while a run is active");
		let target = targetId;
		let editorText: string | undefined;
		if (targetId !== null) {
			const entry = await this.#session.getEntry(targetId, ctx);
			if (!entry) throw new LilyError("not_found", `Unknown entry ${targetId}`);
			if (entry.type === "message" && entry.message.role === "user") {
				target = entry.parentId;
				const content = entry.message.content;
				editorText =
					typeof content === "string"
						? content
						: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			}
		}
		const result = await this.#lane.navigateTree(target, options, ctx);
		if (!result.ok) throw new Error(result.error.message);
		return { status: result.value.navigation.status, tipId: result.value.navigation.tipId, ...(editorText !== undefined ? { editorText } : {}) };
	}

	async setModel(ref: string): Promise<void> {
		this.#model(ref);
		this.binding.model = ref;
		await this.#saveBinding();
	}

	async setThinking(level: ThinkingLevel): Promise<void> {
		this.binding.thinking = level;
		await this.#saveBinding();
	}

	/** Binds another bundle (or `@router`); it takes effect at the next run (never mid-run). */
	async setBundle(ref: string | null): Promise<string | null> {
		this.binding.bundle = await resolveBinding(this.#services, ref);
		await this.#saveBinding();
		return this.binding.bundle;
	}

	async tipId(): Promise<string | null> {
		return this.#lane.getTipId(ctx);
	}

	/** Entries on the current branch, oldest first (context view, including compactions). */
	async branchEntries(): Promise<Entry[]> {
		return this.#lane.findEntries({ order: "oldestFirst" }, ctx);
	}

	/** Every entry in the session tree (for tree navigation). */
	async allEntries(): Promise<Entry[]> {
		return this.#session.findEntries({ order: "asc", limit: 100_000 }, ctx);
	}

	async messages(): Promise<AgentMessage[]> {
		return (await this.branchEntries()).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
	}

	async close(options: { destroyEnvironment?: boolean } = {}): Promise<void> {
		if (this.#closed) return;
		if (this.#active) await this.abort();
		this.#closed = true;
		await this.#harness.close(ctx).catch(() => {});
		if (options.destroyEnvironment ?? true) await this.#lease?.destroy().catch(() => {});
		await this.events.flush();
	}
}

/** A lease stand-in for recovery when the original environment no longer exists. */
function deadLease(manifest: RunManifest): EnvironmentLease {
	const unavailable = () => Promise.reject(new Error("Environment from a previous process is not available"));
	return {
		info: manifest.environment,
		client: { closed: true } as EnvironmentLease["client"],
		env: undefined as unknown as EnvironmentLease["env"],
		exportWorkspace: unavailable,
		destroy: async () => {},
		destroyed: true,
	};
}
