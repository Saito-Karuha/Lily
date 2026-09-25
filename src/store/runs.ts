import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { EnvironmentInfo } from "../env/types.ts";
import type { PromptBlock } from "../kernel/system-prompt.ts";
import type { Component } from "../resources/bundle.ts";
import type { RouteRecord } from "../resources/router.ts";
import { JsonlFile, readJson, readJsonIfExists, writeJsonAtomic } from "../util/fsx.ts";
import type { Digest } from "../util/hash.ts";
import { safeSegment } from "./home.ts";

/** Identifies the kernel's model-visible behavior (tools, rendering, system prompt). Bump it when that changes, not on every release. */
export const LILY_KERNEL_VERSION = "lily-kernel/0.1.0";

/** Everything that determined a run's conditions, frozen before the first model call. */
export interface RunManifest {
	runId: string;
	sessionId: string;
	lane: string;
	createdAt: number;
	mode: "interactive" | "batch";
	prompt: { text: string; digest: Digest };
	kernel: {
		version: string;
		piAgentCore: string;
		piAi: string;
		toolsDigest: Digest;
		compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
		observationCapBytes: number;
	};
	model: { provider: string; modelId: string; api: string; thinkingLevel: string };
	bundle: { digest: Digest; name: string; componentDigests: Record<Component, Digest> } | null;
	processorId: string;
	systemPrompt: { digest: Digest; blocks: PromptBlock[] };
	environment: EnvironmentInfo;
	budget: { maxTurns?: number; timeoutMs?: number };
	/** Caller-supplied tags (session labels overlaid with the run's); Lily only records them. */
	labels?: Record<string, string>;
	/** Present when the session is bound to `@router`: which router chose `bundle`, and why. */
	route?: RouteRecord;
}

export type Fidelity = "semantic" | "request_exact" | "token_exact";
export type CallPurpose = "assistant" | "compaction" | "branch_summary" | "deferred" | "other";

/** One real model request, recorded at the model gateway boundary. */
export interface ModelCallRecord {
	callId: string;
	runId: string;
	sessionId: string;
	purpose: CallPurpose;
	attempt: number;
	model: { provider: string; modelId: string; api: string };
	startedAt: number;
	endedAt: number;
	/** pi-ai Context actually passed to the provider: {systemPrompt, messages, tools}. */
	contextRef: Digest;
	/** Request options without callbacks, signals or credentials. */
	optionsRef?: Digest;
	/** Provider-native payload after all transforms (what was sent, minus transport headers). */
	payloadRef?: Digest;
	/** Final assistant message (normalized). */
	responseRef: Digest;
	stopReason: string;
	errorMessage?: string;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
	/** Engine token evidence, when the endpoint returned it. */
	tokens?: { promptTokenIdsRef: Digest; outputTokenIdsRef: Digest; promptTokens: number; outputTokens: number };
	fidelity: Fidelity;
}

/** Per-run summary of one tool execution (the session ledger is the durable source). */
export interface ToolCallRecord {
	runId: string;
	invocationId: string;
	toolCallId: string;
	toolName: string;
	args: unknown;
	isError: boolean;
	rawRef: string;
	rawComplete: boolean;
	processorId: string;
	observationRef?: Digest;
	reconciled: boolean;
	durationMs: number;
	at: number;
}

export type RunStatus = "running" | "completed" | "failed" | "aborted" | "blocked" | "interrupted";

export interface RunOutcome {
	runId: string;
	status: RunStatus;
	/** Why the run ended when it did not complete normally. */
	reason?: string;
	error?: string;
	startedAt: number;
	endedAt: number;
	turns: number;
	toolCalls: number;
	modelCalls: number;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
	/** Final assistant text, if any. */
	finalText?: string;
	fromTipId?: string | null;
	tipId?: string | null;
}

/** Filesystem layout of one run: manifest, call records, tool records, outcome. */
export class RunStore {
	readonly dir: string;
	readonly calls: JsonlFile<ModelCallRecord>;
	readonly tools: JsonlFile<ToolCallRecord>;

	constructor(dir: string) {
		this.dir = dir;
		this.calls = new JsonlFile(join(dir, "calls.jsonl"));
		this.tools = new JsonlFile(join(dir, "tools.jsonl"));
	}

	writeManifest(manifest: RunManifest): Promise<void> {
		return writeJsonAtomic(join(this.dir, "manifest.json"), manifest);
	}

	readManifest(): Promise<RunManifest> {
		return readJson<RunManifest>(join(this.dir, "manifest.json"));
	}

	writeOutcome(outcome: RunOutcome): Promise<void> {
		return writeJsonAtomic(join(this.dir, "outcome.json"), outcome);
	}

	readOutcome(): Promise<RunOutcome | undefined> {
		return readJsonIfExists<RunOutcome>(join(this.dir, "outcome.json"));
	}

	/**
	 * Attaches caller data to a finished (or running) run — a score, a review, a
	 * label — under `name`. Lily stores annotations verbatim and includes them in
	 * exports; it never computes or interprets them.
	 */
	annotate(name: string, value: unknown): Promise<void> {
		return writeJsonAtomic(join(this.dir, "annotations", `${safeSegment(name, "annotation name")}.json`), value);
	}

	async readAnnotations(): Promise<Record<string, unknown>> {
		const dir = join(this.dir, "annotations");
		const names = await readdir(dir).catch(() => [] as string[]);
		const out: Record<string, unknown> = {};
		for (const file of names.filter((n) => n.endsWith(".json")).sort()) out[file.slice(0, -5)] = await readJson(join(dir, file));
		return out;
	}
}

export async function listRunIds(runsRoot: string): Promise<string[]> {
	try {
		return (await readdir(runsRoot)).filter((name) => name.startsWith("run_")).sort().reverse();
	} catch {
		return [];
	}
}
