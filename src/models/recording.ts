import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context as AiContext,
	createAssistantMessageEventStream,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ArtifactStore } from "../store/artifacts.ts";
import type { CallPurpose, Fidelity, ModelCallRecord } from "../store/runs.ts";
import type { Digest } from "../util/hash.ts";
import { newId } from "../util/ids.ts";

/** Where the gateway writes records for the run currently driving the session. */
export interface CallSink {
	runId: string;
	sessionId: string;
	record(record: ModelCallRecord): Promise<void>;
}

/** Engine-side token evidence captured from a response (see token-capture.ts). */
export interface TokenEvidence {
	promptTokenIds: number[];
	outputTokenIds: number[];
}

/** Optional per-request hook that wraps `fetch` to capture token ids for engines that return them. */
export type TokenCaptureFactory = (model: Model<Api>) =>
	| {
			fetch: typeof globalThis.fetch;
			patchOptions?: (options: ModelsSimpleStreamOptions) => ModelsSimpleStreamOptions;
			/** Resolves once the captured response has been fully read. */
			evidence(): Promise<TokenEvidence | undefined>;
	  }
	| undefined;

/** A model-visible context stored as deduplicated parts: messages repeat across calls, so each is one blob. */
export interface StoredContext {
	systemPromptRef?: Digest;
	messageRefs: Digest[];
	toolsRef?: Digest;
}

const SAFE_OPTION_KEYS = [
	"temperature",
	"maxTokens",
	"reasoning",
	"thinkingBudgets",
	"sessionId",
	"cacheRetention",
	"metadata",
	"transport",
	"samplingParams",
	"timeoutMs",
	"maxRetries",
	"maxRetryDelayMs",
	"toolChoice",
] as const;

function safeOptions(options: object | undefined): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!options) return out;
	for (const key of SAFE_OPTION_KEYS) {
		const value = (options as Record<string, unknown>)[key];
		if (value !== undefined && typeof value !== "function") out[key] = value;
	}
	return out;
}

/**
 * Model gateway: a pi-ai `Models` that records every real request made by the
 * harness — ordinary turns, compaction and branch summaries alike — with the
 * exact context, options and provider payload, and the settled response.
 */
export class RecordingModels implements Models {
	readonly inner: Models;
	readonly #artifacts: ArtifactStore;
	#sink: CallSink | undefined;
	#expected: { purpose: CallPurpose; attempt: number } | undefined;
	readonly #pending = new Set<Promise<void>>();
	#tokenCapture: TokenCaptureFactory | undefined;

	constructor(inner: Models, artifacts: ArtifactStore, options?: { tokenCapture?: TokenCaptureFactory }) {
		this.inner = inner;
		this.#artifacts = artifacts;
		this.#tokenCapture = options?.tokenCapture;
	}

	setSink(sink: CallSink | undefined): void {
		this.#sink = sink;
	}

	/** Declares the purpose of the next request (fed from the harness `before_request` hook). */
	expect(purpose: CallPurpose, attempt: number): void {
		this.#expected = { purpose, attempt };
	}

	/** Waits until every started record has been written. */
	async flush(): Promise<void> {
		while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
	}

	getProviders() {
		return this.inner.getProviders();
	}
	getProvider(id: string) {
		return this.inner.getProvider(id);
	}
	getModels(provider?: string) {
		return this.inner.getModels(provider);
	}
	getModel(provider: string, id: string) {
		return this.inner.getModel(provider, id);
	}
	refresh(...args: Parameters<Models["refresh"]>) {
		return this.inner.refresh(...args);
	}
	checkAuth(...args: Parameters<Models["checkAuth"]>) {
		return this.inner.checkAuth(...args);
	}
	getAvailable(...args: Parameters<Models["getAvailable"]>) {
		return this.inner.getAvailable(...args);
	}
	getAuth: Models["getAuth"] = ((target: never, overrides?: never) => this.inner.getAuth(target, overrides)) as Models["getAuth"];
	login(...args: Parameters<Models["login"]>) {
		return this.inner.login(...args);
	}
	logout(...args: Parameters<Models["logout"]>) {
		return this.inner.logout(...args);
	}
	streamDeferred(...args: Parameters<Models["streamDeferred"]>) {
		return this.inner.streamDeferred(...args);
	}
	fetchDeferred(...args: Parameters<Models["fetchDeferred"]>) {
		return this.inner.fetchDeferred(...args);
	}
	cancelDeferred(...args: Parameters<Models["cancelDeferred"]>) {
		return this.inner.cancelDeferred(...args);
	}

	stream<TApi extends Api>(model: Model<TApi>, context: AiContext, options?: ModelsApiStreamOptions<TApi>): AssistantMessageEventStream {
		return this.#streamRecorded(model as Model<Api>, context, options as ModelsSimpleStreamOptions | undefined, (m, c, o) =>
			this.inner.stream(m as Model<TApi>, c, o as ModelsApiStreamOptions<TApi>),
		);
	}

	async complete<TApi extends Api>(model: Model<TApi>, context: AiContext, options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: AiContext, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return this.#streamRecorded(model, context, options, (m, c, o) => this.inner.streamSimple(m, c, o));
	}

	async completeSimple(model: Model<Api>, context: AiContext, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	#streamRecorded(
		model: Model<Api>,
		context: AiContext,
		options: ModelsSimpleStreamOptions | undefined,
		start: (model: Model<Api>, context: AiContext, options: ModelsSimpleStreamOptions | undefined) => AssistantMessageEventStream,
	): AssistantMessageEventStream {
		const sink = this.#sink;
		const expected = this.#expected;
		this.#expected = undefined;
		if (!sink) return start(model, context, options);
		const startedAt = Date.now();
		let payload: unknown;
		const capture = this.#tokenCapture?.(model);
		let wrapped: ModelsSimpleStreamOptions = {
			...options,
			onPayload: async (original, m) => {
				const replaced = await options?.onPayload?.(original, m);
				payload = replaced ?? original;
				return replaced;
			},
			...(capture ? { fetch: capture.fetch } : {}),
		};
		if (capture?.patchOptions) wrapped = capture.patchOptions(wrapped);
		const innerStream = start(model, context, wrapped);
		const outer = createAssistantMessageEventStream();
		const forward = (async () => {
			try {
				for await (const event of innerStream) outer.push(event);
			} finally {
				const message = await innerStream.result();
				outer.end(message);
				await this.#write(sink, {
					purpose: expected?.purpose ?? "assistant",
					attempt: expected?.attempt ?? 1,
					model,
					context,
					options: wrapped,
					payload,
					message,
					startedAt,
					tokens: await capture?.evidence(),
				});
			}
		})();
		const tracked = forward.catch(() => {});
		this.#pending.add(tracked);
		void tracked.finally(() => this.#pending.delete(tracked));
		return outer;
	}

	async #write(
		sink: CallSink,
		input: {
			purpose: CallPurpose;
			attempt: number;
			model: Model<Api>;
			context: AiContext;
			options: object;
			payload: unknown;
			message: AssistantMessage;
			startedAt: number;
			tokens: TokenEvidence | undefined;
		},
	): Promise<void> {
		const artifacts = this.#artifacts;
		const contextRef = await storeContext(artifacts, input.context);
		const optionsRef = await artifacts.putJson(safeOptions(input.options));
		const payloadRef = input.payload === undefined ? undefined : await artifacts.putJson(input.payload);
		const responseRef = await artifacts.putJson(input.message);
		let tokens: ModelCallRecord["tokens"];
		if (input.tokens && input.tokens.outputTokenIds.length > 0) {
			tokens = {
				promptTokenIdsRef: await artifacts.putJson(input.tokens.promptTokenIds),
				outputTokenIdsRef: await artifacts.putJson(input.tokens.outputTokenIds),
				promptTokens: input.tokens.promptTokenIds.length,
				outputTokens: input.tokens.outputTokenIds.length,
			};
		}
		const fidelity: Fidelity = tokens ? "token_exact" : payloadRef ? "request_exact" : "semantic";
		const usage = input.message.usage;
		await sink.record({
			callId: newId("call"),
			runId: sink.runId,
			sessionId: sink.sessionId,
			purpose: input.purpose,
			attempt: input.attempt,
			model: { provider: input.model.provider, modelId: input.model.id, api: input.model.api },
			startedAt: input.startedAt,
			endedAt: Date.now(),
			contextRef,
			optionsRef,
			...(payloadRef ? { payloadRef } : {}),
			responseRef,
			stopReason: input.message.stopReason,
			...(input.message.errorMessage ? { errorMessage: input.message.errorMessage } : {}),
			...(usage
				? {
						usage: {
							input: usage.input,
							output: usage.output,
							cacheRead: usage.cacheRead,
							cacheWrite: usage.cacheWrite,
							totalTokens: usage.totalTokens,
						},
					}
				: {}),
			...(tokens ? { tokens } : {}),
			fidelity,
		});
	}
}

export async function storeContext(artifacts: ArtifactStore, context: AiContext): Promise<Digest> {
	const stored: StoredContext = {
		...(context.systemPrompt !== undefined ? { systemPromptRef: await artifacts.put(context.systemPrompt) } : {}),
		messageRefs: await Promise.all(context.messages.map((message) => artifacts.putJson(message))),
		...(context.tools ? { toolsRef: await artifacts.putJson(context.tools) } : {}),
	};
	return artifacts.putJson(stored);
}

export async function loadContext(artifacts: ArtifactStore, ref: Digest | string): Promise<AiContext> {
	const stored = await artifacts.getJson<StoredContext>(ref);
	return {
		...(stored.systemPromptRef ? { systemPrompt: (await artifacts.get(stored.systemPromptRef)).toString("utf8") } : {}),
		messages: await Promise.all(stored.messageRefs.map((r) => artifacts.getJson(r))),
		...(stored.toolsRef ? { tools: await artifacts.getJson(stored.toolsRef) } : {}),
	} as AiContext;
}
