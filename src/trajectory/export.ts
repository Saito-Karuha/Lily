import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { Context as AiContext, Message } from "@earendil-works/pi-ai";
import { BRANCH_SUMMARY_PREFIX, COMPACTION_SUMMARY_PREFIX } from "@earendil-works/pi-agent-core";
import type { LilyToolMeta } from "../kernel/gateway.ts";
import { PROMPT_BLOCK_SEPARATOR, type PromptBlock } from "../kernel/system-prompt.ts";
import { loadContext } from "../models/recording.ts";
import type { ArtifactStore } from "../store/artifacts.ts";
import type { Fidelity, ModelCallRecord, RunManifest, RunOutcome, RunStore, ToolCallRecord } from "../store/runs.ts";

export const TRAJECTORY_FORMAT = "lily.traj/v1";

export type MessageOrigin = "user" | "assistant" | "tool_result" | "compaction_summary" | "branch_summary" | "other";

/** Where one message in a call's context came from. */
export interface MessageProvenance {
	index: number;
	role: string;
	origin: MessageOrigin;
	toolCallId?: string;
	/** For tool results produced by a real execution: the raw envelope and the processor that rendered it. */
	invocationId?: string;
	rawRef?: string;
	rawComplete?: boolean;
	processorId?: string;
	/** Kernel-generated results (unknown tool, invalid arguments, blocked) have no raw execution. */
	kernelGenerated?: boolean;
}

export interface CallProvenance {
	/** True when the call's system prompt equals the run's assembled prompt, so blocks are exact. */
	systemPromptMatchesManifest: boolean;
	systemBlocks: Array<Omit<PromptBlock, "text"> & { start: number; end: number }>;
	messages: MessageProvenance[];
}

export interface ExportedCall {
	callId: string;
	purpose: ModelCallRecord["purpose"];
	attempt: number;
	model: ModelCallRecord["model"];
	startedAt: number;
	endedAt: number;
	fidelity: Fidelity;
	stopReason: string;
	errorMessage?: string;
	usage?: ModelCallRecord["usage"];
	context: AiContext;
	provenance: CallProvenance;
	response: unknown;
	/** Request options as recorded (no callbacks, signals or credentials): what `renderCallPayload` needs to rebuild the payload. */
	options?: Record<string, unknown>;
	payload?: unknown;
	tokens?: { promptTokenIds: number[]; outputTokenIds: number[] };
}

export interface ExportedTrajectory {
	format: typeof TRAJECTORY_FORMAT;
	exportedAt: number;
	manifest: RunManifest;
	outcome?: RunOutcome;
	/** Caller data attached with `RunStore.annotate` (e.g. an evaluator's score). */
	annotations?: Record<string, unknown>;
	/** Lowest fidelity among the run's policy turns (calls with purpose "assistant"). */
	fidelity: Fidelity;
	calls: ExportedCall[];
	tools: Array<ToolCallRecord & { raw?: unknown }>;
}

export interface ExportOptions {
	includePayloads?: boolean;
	includeRaw?: boolean;
}

/** Per-call fields a projection can select; identity and status fields are always present. */
export type CallField = "context" | "provenance" | "response" | "options" | "payload" | "tokens" | "usage";
export const CALL_FIELDS: readonly CallField[] = ["context", "provenance", "response", "options", "payload", "tokens", "usage"];

export interface ProjectionOptions {
	/** Only calls with these purposes (default: all). */
	purposes?: ModelCallRecord["purpose"][];
	/** Only these per-call fields (default: all of them). */
	fields?: CallField[];
	/** "delta" prefix-encodes each call's prompt token ids against the previous exported call's tokens. */
	tokenEncoding?: "full" | "delta";
	includeRaw?: boolean;
}

/**
 * Prompt token ids as a delta: the first `prefix` ids are those of the reference sequence, the
 * previous call in `calls` that carries tokens (`base`) — its decoded prompt ids followed by its
 * output ids — and `tail` follows them. The first call with tokens has `base: null, prefix: 0`.
 */
export interface TokenDelta {
	base: string | null;
	prefix: number;
	tail: number[];
}

export type ProjectedCall = Pick<ExportedCall, "callId" | "purpose" | "attempt" | "model" | "startedAt" | "endedAt" | "fidelity" | "stopReason" | "errorMessage"> &
	Partial<Pick<ExportedCall, "context" | "provenance" | "response" | "options" | "payload" | "usage">> & {
		tokens?: { promptTokenIds: number[] | TokenDelta; outputTokenIds: number[] };
	};

export interface ProjectedTrajectory extends Omit<ExportedTrajectory, "calls"> {
	projection: { purposes?: ModelCallRecord["purpose"][]; fields: CallField[]; tokenEncoding: "full" | "delta" };
	calls: ProjectedCall[];
}

const FIDELITY_ORDER: Fidelity[] = ["semantic", "request_exact", "token_exact"];

function textOf(message: Message): string {
	const content = (message as { content: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: { type: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

export function messageProvenance(messages: Message[]): MessageProvenance[] {
	return messages.map((message, index) => {
		const base = { index, role: message.role };
		if (message.role === "assistant") return { ...base, origin: "assistant" };
		if (message.role === "toolResult") {
			const result = message as ToolResultMessage<{ lily?: LilyToolMeta }>;
			const lily = result.details?.lily;
			return lily
				? {
						...base,
						origin: "tool_result",
						toolCallId: result.toolCallId,
						invocationId: lily.invocationId,
						rawRef: lily.rawRef,
						rawComplete: lily.rawComplete,
						processorId: lily.processorId,
					}
				: { ...base, origin: "tool_result", toolCallId: result.toolCallId, kernelGenerated: true };
		}
		if (message.role === "user") {
			const text = textOf(message);
			if (text.startsWith(COMPACTION_SUMMARY_PREFIX)) return { ...base, origin: "compaction_summary" };
			if (text.startsWith(BRANCH_SUMMARY_PREFIX)) return { ...base, origin: "branch_summary" };
			return { ...base, origin: "user" };
		}
		return { ...base, origin: "other" };
	});
}

export function blockSpans(blocks: PromptBlock[]): CallProvenance["systemBlocks"] {
	let offset = 0;
	return blocks.map((block, i) => {
		const start = offset;
		const end = start + block.text.length;
		offset = end + (i < blocks.length - 1 ? PROMPT_BLOCK_SEPARATOR.length : 0);
		const { text: _text, ...rest } = block;
		return { ...rest, start, end };
	});
}

/** Lowest fidelity among policy turns (calls with purpose "assistant"). */
function runFidelity(records: ModelCallRecord[]): Fidelity {
	const turns = records.filter((c) => c.purpose === "assistant").map((c) => FIDELITY_ORDER.indexOf(c.fidelity));
	return FIDELITY_ORDER[turns.length ? Math.min(...turns) : 0]!;
}

async function buildCall(record: ModelCallRecord, manifest: RunManifest, artifacts: ArtifactStore, fields: ReadonlySet<CallField>): Promise<ProjectedCall> {
	const call: ProjectedCall = {
		callId: record.callId,
		purpose: record.purpose,
		attempt: record.attempt,
		model: record.model,
		startedAt: record.startedAt,
		endedAt: record.endedAt,
		fidelity: record.fidelity,
		stopReason: record.stopReason,
		...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
	};
	if (fields.has("usage") && record.usage) call.usage = record.usage;
	if (fields.has("context") || fields.has("provenance")) {
		const context = await loadContext(artifacts, record.contextRef);
		if (fields.has("context")) call.context = context;
		if (fields.has("provenance")) {
			const matches = context.systemPrompt === manifest.systemPrompt.blocks.map((b) => b.text).join(PROMPT_BLOCK_SEPARATOR);
			call.provenance = {
				systemPromptMatchesManifest: matches,
				systemBlocks: matches ? blockSpans(manifest.systemPrompt.blocks) : [],
				messages: messageProvenance(context.messages),
			};
		}
	}
	if (fields.has("response")) call.response = await artifacts.getJson(record.responseRef);
	if (fields.has("options") && record.optionsRef) call.options = await artifacts.getJson<Record<string, unknown>>(record.optionsRef);
	if (fields.has("payload") && record.payloadRef) call.payload = await artifacts.getJson(record.payloadRef);
	if (fields.has("tokens") && record.tokens) {
		call.tokens = {
			promptTokenIds: await artifacts.getJson<number[]>(record.tokens.promptTokenIdsRef),
			outputTokenIds: await artifacts.getJson<number[]>(record.tokens.outputTokenIdsRef),
		};
	}
	return call;
}

async function exportTools(store: RunStore, artifacts: ArtifactStore, includeRaw: boolean): Promise<Array<ToolCallRecord & { raw?: unknown }>> {
	const records = await store.tools.readAll();
	return Promise.all(records.map(async (tool) => (includeRaw ? { ...tool, raw: await artifacts.getJson(tool.rawRef) } : tool)));
}

/**
 * Builds the call-level export of one run. Every call carries the context the
 * model actually received (not a reconstruction from the final transcript),
 * its provenance, and the response; tools carry raw envelope references.
 */
export async function exportRun(store: RunStore, artifacts: ArtifactStore, options: ExportOptions = {}): Promise<ExportedTrajectory> {
	const manifest = await store.readManifest();
	const outcome = await store.readOutcome();
	const annotations = await store.readAnnotations();
	const records = await store.calls.readAll();
	const fields = new Set(CALL_FIELDS.filter((f) => f !== "payload" || options.includePayloads));
	const calls: ExportedCall[] = [];
	for (const record of records) calls.push((await buildCall(record, manifest, artifacts, fields)) as ExportedCall);
	return {
		format: TRAJECTORY_FORMAT,
		exportedAt: Date.now(),
		manifest,
		...(outcome ? { outcome } : {}),
		...(Object.keys(annotations).length ? { annotations } : {}),
		fidelity: runFidelity(records),
		calls,
		tools: await exportTools(store, artifacts, Boolean(options.includeRaw)),
	};
}

/**
 * A projection of a run's export: only some calls, only some per-call fields, and optionally
 * token ids prefix-encoded (successive calls of an agent loop share most of their prompt), so a
 * consumer that needs, say, only the token ids of policy turns does not move every context.
 * `decodeTokenDeltas` restores the full arrays.
 */
export async function exportRunProjection(store: RunStore, artifacts: ArtifactStore, projection: ProjectionOptions = {}): Promise<ProjectedTrajectory> {
	const manifest = await store.readManifest();
	const outcome = await store.readOutcome();
	const annotations = await store.readAnnotations();
	const records = await store.calls.readAll();
	const selected = projection.fields ? CALL_FIELDS.filter((f) => projection.fields!.includes(f)) : [...CALL_FIELDS];
	const fields = new Set(selected);
	const encoding = projection.tokenEncoding ?? "full";
	const calls: ProjectedCall[] = [];
	let reference: { callId: string; ids: number[] } | undefined;
	for (const record of records) {
		if (projection.purposes && !projection.purposes.includes(record.purpose)) continue;
		const call = await buildCall(record, manifest, artifacts, fields);
		if (call.tokens) {
			const prompt = call.tokens.promptTokenIds as number[];
			const full = [...prompt, ...call.tokens.outputTokenIds];
			if (encoding === "delta") {
				const prefix = reference ? commonPrefix(reference.ids, prompt) : 0;
				call.tokens.promptTokenIds = { base: reference?.callId ?? null, prefix, tail: prompt.slice(prefix) };
			}
			reference = { callId: call.callId, ids: full };
		}
		calls.push(call);
	}
	return {
		format: TRAJECTORY_FORMAT,
		exportedAt: Date.now(),
		manifest,
		...(outcome ? { outcome } : {}),
		...(Object.keys(annotations).length ? { annotations } : {}),
		fidelity: runFidelity(records),
		projection: { ...(projection.purposes ? { purposes: projection.purposes } : {}), fields: selected, tokenEncoding: encoding },
		calls,
		tools: await exportTools(store, artifacts, Boolean(projection.includeRaw)),
	};
}

/** Replaces every `TokenDelta` of a projection by the full token id array it encodes. */
export function decodeTokenDeltas(trajectory: ProjectedTrajectory): ProjectedTrajectory {
	const sequences = new Map<string, number[]>();
	const calls = trajectory.calls.map((call) => {
		if (!call.tokens) return call;
		const encoded = call.tokens.promptTokenIds;
		let prompt: number[];
		if (Array.isArray(encoded)) prompt = encoded;
		else {
			const base = encoded.base === null ? [] : sequences.get(encoded.base);
			if (!base) throw new Error(`call ${call.callId}: unknown token base ${encoded.base}`);
			if (encoded.prefix > base.length) throw new Error(`call ${call.callId}: prefix ${encoded.prefix} exceeds its base`);
			prompt = [...base.slice(0, encoded.prefix), ...encoded.tail];
		}
		sequences.set(call.callId, [...prompt, ...call.tokens.outputTokenIds]);
		return { ...call, tokens: { promptTokenIds: prompt, outputTokenIds: call.tokens.outputTokenIds } };
	});
	return { ...trajectory, projection: { ...trajectory.projection, tokenEncoding: "full" }, calls };
}

function commonPrefix(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) i++;
	return i;
}

/** One recorded call of a run, as in `exportRun` (payload included when recorded). */
export async function exportCall(store: RunStore, artifacts: ArtifactStore, callId: string): Promise<{ manifest: RunManifest; call: ExportedCall } | undefined> {
	const record = (await store.calls.readAll()).find((c) => c.callId === callId);
	if (!record) return undefined;
	const manifest = await store.readManifest();
	return { manifest, call: (await buildCall(record, manifest, artifacts, new Set(CALL_FIELDS))) as ExportedCall };
}
