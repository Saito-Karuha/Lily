import type { Component } from "../resources/bundle.ts";
import { type RenderedResources, skillCatalog } from "../resources/render.ts";
import type { Digest } from "../util/hash.ts";
import { KERNEL_TOOL_NAMES, TOOL_SNIPPETS } from "./tools/specs.ts";

export type PromptBlockKind = "kernel" | "attached_prompt" | "tool_guidance" | "skills" | "memory" | "environment";

/** One contiguous region of the system prompt and where it came from. */
export interface PromptBlock {
	kind: PromptBlockKind;
	component?: Component;
	componentDigest?: Digest;
	text: string;
}

export interface AssembledPrompt {
	text: string;
	blocks: PromptBlock[];
}

export const PROMPT_BLOCK_SEPARATOR = "\n\n";

/** Fixed kernel instructions (part of K; never edited by the proposer). */
export const KERNEL_PROMPT = `You are an expert coding assistant operating inside Lily, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${KERNEL_TOOL_NAMES.map((name) => `- ${name}: ${TOOL_SNIPPETS[name]}`).join("\n")}

Guidelines:
- Use bash for file operations like ls, rg, find
- Be concise in your responses
- Show file paths clearly when working with files`;

export interface PromptEnvironment {
	workspace: string;
	/** ISO date to include, if any. Omitted in training runs for reproducibility. */
	date?: string;
}

/**
 * Assemble(K, R): the kernel prompt, then each resource component in its own
 * delimited region, then environment facts. Block boundaries are recorded so a
 * teaching view can swap exactly the P/U regions and nothing else.
 */
export function assembleSystemPrompt(resources: RenderedResources | undefined, env: PromptEnvironment): AssembledPrompt {
	const blocks: PromptBlock[] = [{ kind: "kernel", text: KERNEL_PROMPT }];
	if (resources) blocks.push(...resourceBlocks(resources));
	blocks.push({
		kind: "environment",
		text: [env.date ? `Current date: ${env.date}` : undefined, `Current working directory: ${env.workspace}`]
			.filter(Boolean)
			.join("\n"),
	});
	return { text: blocks.map((b) => b.text).join(PROMPT_BLOCK_SEPARATOR), blocks };
}

/** Prompt regions contributed by a bundle, in fixed order: P, U, S, M. */
export function resourceBlocks(resources: RenderedResources): PromptBlock[] {
	const blocks: PromptBlock[] = [];
	const digests = resources.componentDigests;
	if (resources.attachedPrompt) {
		blocks.push({
			kind: "attached_prompt",
			component: "P",
			componentDigest: digests.P,
			text: `<additional_instructions>\n${resources.attachedPrompt}\n</additional_instructions>`,
		});
	}
	const guidance = KERNEL_TOOL_NAMES.filter((name) => resources.toolGuidance[name]);
	if (guidance.length > 0) {
		const body = guidance.map((name) => `<tool name="${name}">\n${resources.toolGuidance[name]}\n</tool>`).join("\n");
		blocks.push({
			kind: "tool_guidance",
			component: "U",
			componentDigest: digests.U,
			text: `<tool_guidance>\nAdditional guidance for using the tools:\n${body}\n</tool_guidance>`,
		});
	}
	const catalog = skillCatalog(resources);
	if (catalog) blocks.push({ kind: "skills", component: "S", componentDigest: digests.S, text: catalog });
	if (resources.memoryLocation) {
		const entry = resources.memoryHasIndex
			? `Start with ${resources.memoryLocation}/index.md, which describes what the library contains.`
			: `List the directory to see what it contains.`;
		blocks.push({
			kind: "memory",
			component: "M",
			componentDigest: digests.M,
			text: `<memory location="${resources.memoryLocation}">\nA read-only library of notes from previous work is available at ${resources.memoryLocation}. ${entry} Read relevant entries with the read tool when they may help with the current task.\n</memory>`,
		});
	}
	return blocks;
}
