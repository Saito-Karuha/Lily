import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type AgentHarnessTool,
} from "@earendil-works/pi-agent-core";
import type { ExecutionToolContext } from "@earendil-works/pi-agent-core";

/** The fixed kernel tool set. Schemas, descriptions and argument preparation come verbatim from Pi 0.85.1 core. */
export const KERNEL_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;
export type KernelToolName = (typeof KERNEL_TOOL_NAMES)[number];

export function isKernelToolName(name: string): name is KernelToolName {
	return (KERNEL_TOOL_NAMES as readonly string[]).includes(name);
}

export type PiToolSpec = AgentHarnessTool<ExecutionToolContext>;

/** Pi's own tool definitions; Lily replaces only `execute`. */
export function piToolSpecs(): Record<KernelToolName, PiToolSpec> {
	return {
		read: createReadTool() as PiToolSpec,
		bash: createBashTool() as PiToolSpec,
		edit: createEditTool() as PiToolSpec,
		write: createWriteTool() as PiToolSpec,
	};
}

/** One-line tool summaries used in the kernel system prompt (same wording as Pi's coding agent). */
export const TOOL_SNIPPETS: Record<KernelToolName, string> = {
	read: "Read file contents",
	bash: "Execute bash commands (ls, grep, find, etc.)",
	edit: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
	write: "Create or overwrite files",
};
