import type { Context as AiContext, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { capObservation, type LilyToolMeta } from "../kernel/gateway.ts";
import { PROMPT_BLOCK_SEPARATOR, type PromptBlock, resourceBlocks } from "../kernel/system-prompt.ts";
import type { RawEnvelope } from "../kernel/tools/raw.ts";
import { baselineProcessor, createProcessor, type ObservationProcessor } from "../resources/processor/dsl.ts";
import type { RenderedResources } from "../resources/render.ts";
import type { ArtifactStore } from "../store/artifacts.ts";
import type { RunManifest } from "../store/runs.ts";
import type { ExportedCall } from "./export.ts";

/** Resource-derived system prompt blocks a view can replace. */
export type ResourceBlockKind = "attached_prompt" | "tool_guidance" | "skills" | "memory";
const RESOURCE_BLOCKS: ResourceBlockKind[] = ["attached_prompt", "tool_guidance", "skills", "memory"];

export interface ViewOptions {
	/**
	 * Resources to render the system prompt from (see `renderResources`); `null`
	 * means "no resources". Omit to keep the recorded system prompt.
	 */
	resources?: RenderedResources | null;
	/** Which resource blocks come from `resources` (default: all four). The others keep their recorded text. */
	replace?: ResourceBlockKind[];
	/**
	 * Observation processor used to re-render every tool result from its archived
	 * raw output: a rendered bundle's processor spec comes from `resources`, or
	 * pass a processor explicitly (`baselineProcessor` for Pi's native output).
	 * Omit to keep the recorded observations.
	 */
	processor?: ObservationProcessor | "from-resources";
	/** Text placed before the system prompt (for example context only a scorer should see). */
	systemPrefix?: string;
	observationCapBytes?: number;
}

export interface CallView {
	callId: string;
	context: AiContext;
	/** The recorded model output for this call, unchanged. */
	target: unknown;
	report: {
		systemPromptReplaced: ResourceBlockKind[];
		processorId?: string;
		rerendered: number;
		keptWithoutRaw: number;
		keptKernelGenerated: number;
		incompleteRaw: number;
	};
}

export class ViewError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ViewError";
	}
}

/**
 * Re-renders the context of one recorded model call under different
 * resources: the conversation (user turns, assistant turns, tool calls) stays
 * exactly as recorded, the chosen system prompt blocks are rebuilt from
 * `resources`, and tool observations are recomputed from their archived raw
 * outputs by another processor. Nothing is executed. What to swap, and why, is
 * the caller's decision (e.g. a scorer's view that differs from the policy's).
 */
export async function renderCallView(
	call: ExportedCall,
	manifest: RunManifest,
	options: ViewOptions,
	artifacts: ArtifactStore,
): Promise<CallView> {
	if (options.resources !== undefined && !call.provenance.systemPromptMatchesManifest) {
		throw new ViewError(`call ${call.callId}: its system prompt does not match the run manifest, so it cannot be re-assembled`);
	}
	const replace = options.resources !== undefined ? (options.replace ?? RESOURCE_BLOCKS) : [];
	let systemPrompt = call.context.systemPrompt ?? "";
	if (options.resources !== undefined) {
		systemPrompt = replaceBlocks(manifest.systemPrompt.blocks, options.resources ?? undefined, replace);
	}
	if (options.systemPrefix) systemPrompt = `${options.systemPrefix}${PROMPT_BLOCK_SEPARATOR}${systemPrompt}`;

	let processor: ObservationProcessor | undefined;
	if (options.processor === "from-resources") {
		if (options.resources === undefined) throw new ViewError(`processor "from-resources" needs resources`);
		processor = options.resources?.processor ? createProcessor(options.resources.processor) : baselineProcessor;
	} else {
		processor = options.processor;
	}
	const report: CallView["report"] = {
		systemPromptReplaced: replace,
		...(processor ? { processorId: processor.id } : {}),
		rerendered: 0,
		keptWithoutRaw: 0,
		keptKernelGenerated: 0,
		incompleteRaw: 0,
	};
	const cap = options.observationCapBytes ?? manifest.kernel.observationCapBytes;
	const messages: Message[] = [];
	for (const message of call.context.messages) {
		if (!processor || message.role !== "toolResult") {
			messages.push(message);
			continue;
		}
		const result = message as ToolResultMessage<{ lily?: LilyToolMeta }>;
		const lily = result.details?.lily;
		if (!lily) {
			report.keptKernelGenerated++;
			messages.push(message);
			continue;
		}
		let raw: RawEnvelope;
		try {
			raw = await artifacts.getJson<RawEnvelope>(lily.rawRef);
		} catch {
			report.keptWithoutRaw++;
			messages.push(message);
			continue;
		}
		if (!raw.complete) report.incompleteRaw++;
		const { observation } = capObservation(processor.process(raw), cap);
		report.rerendered++;
		messages.push({ ...result, content: observation.content, isError: observation.isError });
	}
	return {
		callId: call.callId,
		context: { systemPrompt, messages, ...(call.context.tools ? { tools: call.context.tools } : {}) },
		target: call.response,
		report,
	};
}

/** The recorded blocks in their original order, with the chosen resource blocks rebuilt from `resources`. */
function replaceBlocks(recorded: PromptBlock[], resources: RenderedResources | undefined, replace: ResourceBlockKind[]): string {
	const fresh = resources ? resourceBlocks(resources) : [];
	const order: PromptBlock["kind"][] = ["kernel", "attached_prompt", "tool_guidance", "skills", "memory", "environment"];
	const blocks = order.flatMap((kind) =>
		(replace as string[]).includes(kind) ? fresh.filter((b) => b.kind === kind) : recorded.filter((b) => b.kind === kind),
	);
	return blocks.map((b) => b.text).join(PROMPT_BLOCK_SEPARATOR);
}
