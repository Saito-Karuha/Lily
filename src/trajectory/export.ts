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
	const toolRecords = await store.tools.readAll();
	const assembled = manifest.systemPrompt.blocks.map((b) => b.text).join(PROMPT_BLOCK_SEPARATOR);
	const calls: ExportedCall[] = [];
	for (const record of records) {
		const context = await loadContext(artifacts, record.contextRef);
		const response = await artifacts.getJson(record.responseRef);
		const matches = context.systemPrompt === assembled;
		calls.push({
			callId: record.callId,
			purpose: record.purpose,
			attempt: record.attempt,
			model: record.model,
			startedAt: record.startedAt,
			endedAt: record.endedAt,
			fidelity: record.fidelity,
			stopReason: record.stopReason,
			...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
			...(record.usage ? { usage: record.usage } : {}),
			context,
			provenance: {
				systemPromptMatchesManifest: matches,
				systemBlocks: matches ? blockSpans(manifest.systemPrompt.blocks) : [],
				messages: messageProvenance(context.messages),
			},
			response,
			...(options.includePayloads && record.payloadRef ? { payload: await artifacts.getJson(record.payloadRef) } : {}),
			...(record.tokens
				? {
						tokens: {
							promptTokenIds: await artifacts.getJson<number[]>(record.tokens.promptTokenIdsRef),
							outputTokenIds: await artifacts.getJson<number[]>(record.tokens.outputTokenIdsRef),
						},
					}
				: {}),
		});
	}
	const tools = await Promise.all(
		toolRecords.map(async (tool) => (options.includeRaw ? { ...tool, raw: await artifacts.getJson(tool.rawRef) } : tool)),
	);
	const turnFidelities = calls.filter((c) => c.purpose === "assistant").map((c) => FIDELITY_ORDER.indexOf(c.fidelity));
	const fidelity = FIDELITY_ORDER[turnFidelities.length ? Math.min(...turnFidelities) : 0]!;
	return {
		format: TRAJECTORY_FORMAT,
		exportedAt: Date.now(),
		manifest,
		...(outcome ? { outcome } : {}),
		...(Object.keys(annotations).length ? { annotations } : {}),
		fidelity,
		calls,
		tools,
	};
}
