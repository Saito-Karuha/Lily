import type { AgentMessage, OperationError } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EnvironmentInfo } from "../env/types.ts";
import type { LilyToolMeta } from "../kernel/gateway.ts";
import type { RunOutcome } from "../store/runs.ts";

/**
 * Events on a session's Lily event log. Everything except `message_delta` and
 * `tool_update` is persisted with a cursor so clients can reconnect.
 */
export type LilyEvent =
	| { type: "session_created"; sessionId: string; title?: string }
	| { type: "run_start"; runId: string; sessionId: string; prompt: string; model: string; bundle: string | null; envId: string }
	| { type: "run_end"; runId: string; outcome: RunOutcome }
	| { type: "turn_start"; runId: string; turn: number }
	| { type: "message_start"; runId: string; role: string }
	| { type: "message_delta"; runId: string; kind: "text" | "thinking" | "toolcall"; contentIndex: number; delta: string }
	| { type: "message_end"; runId: string; entryId?: string; message: AgentMessage }
	| { type: "tool_start"; runId: string; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_update"; runId: string; toolCallId: string; text: string }
	| {
			type: "tool_end";
			runId: string;
			toolCallId: string;
			toolName: string;
			isError: boolean;
			content: Array<{ type: string; text?: string; mimeType?: string }>;
			lily?: LilyToolMeta;
			/** Unified diff for successful edits (UI only). */
			diff?: string;
	  }
	| { type: "compaction_start"; runId?: string; reason: string }
	| { type: "compaction_end"; runId?: string; status: string; entryId?: string; error?: OperationError }
	| { type: "navigation_end"; status: string; fromTipId: string | null; tipId: string | null; error?: OperationError }
	| { type: "retry"; runId?: string; attempt: number; maxAttempts: number; delayMs: number; error: string }
	| { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
	| { type: "environment"; status: "provisioning" | "ready" | "lost" | "destroyed"; info?: EnvironmentInfo; message?: string }
	| { type: "steer_queued"; runId: string; text: string }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string };

export type { AssistantMessage };
