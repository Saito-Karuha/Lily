import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { EnvironmentSpec } from "../env/types.ts";
import { LilyError } from "../util/errors.ts";

export type ToolExecutionMode = "sequential" | "parallel";

/** Missing fields in pre-0.2.2 bindings and manifests mean sequential execution. */
export function parseToolExecution(value: unknown): ToolExecutionMode {
	if (value === undefined) return "sequential";
	if (value === "sequential" || value === "parallel") return value;
	throw new LilyError("invalid_tool_execution", 'toolExecution must be "sequential" or "parallel"');
}

/** Lily-owned metadata for one Pi session: how its runs are configured and where they execute. */
export interface SessionBinding {
	sessionId: string;
	createdAt: number;
	updatedAt: number;
	title?: string;
	mode: "interactive" | "batch";
	/** "provider/model-id". */
	model: string;
	thinking: ThinkingLevel;
	/** Fixed at session creation; absent in old bindings means sequential. */
	readonly toolExecution?: ToolExecutionMode;
	/** Bound resource bundle digest, `@router` (the runtime's router chooses per run), or null for the bare kernel. */
	bundle: string | null;
	environment: {
		spec: EnvironmentSpec;
		/** Last environment this session used (it may no longer be alive). */
		current?: { envId: string; generation: number; backend: string; bundle: string | null };
	};
	runs: string[];
	parent?: { sessionId: string; entryId?: string | null; kind: "fork" | "clone" | "tree" };
	/** Human-facing workspace label (host directory for mounted workspaces). */
	workspaceLabel?: string;
	labels?: Record<string, string>;
	/** Budget applied to every run unless overridden. */
	budget?: { maxTurns?: number; timeoutMs?: number };
}
