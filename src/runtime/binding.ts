import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { EnvironmentSpec } from "../env/types.ts";

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
