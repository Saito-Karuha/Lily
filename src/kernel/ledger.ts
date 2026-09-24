import type { JsonValue } from "@earendil-works/pi-agent-core";
import { JsonlFile } from "../util/fsx.ts";
import type { Digest } from "../util/hash.ts";

/**
 * Durable per-session record of every external tool effect, keyed by Pi's
 * invocation id (the reserved tool-result entry id, stable across replay).
 * `dispatched` is fsynced before the effect starts, so after a crash the
 * gateway can tell "never started" from "started, outcome unknown".
 */
export type LedgerRecord =
	| {
			type: "dispatched";
			invocationId: string;
			toolCallId: string;
			toolName: string;
			runId: string;
			operationId: string;
			envId: string;
			envGeneration: number;
			argsDigest: Digest;
			args: Record<string, JsonValue>;
			at: number;
	  }
	| {
			type: "completed";
			invocationId: string;
			rawRef: Digest;
			rawComplete: boolean;
			processorId: string;
			observationRef: Digest;
			isError: boolean;
			durationMs: number;
			at: number;
	  }
	| { type: "unknown"; invocationId: string; reason: string; at: number };

export interface InvocationState {
	dispatched?: Extract<LedgerRecord, { type: "dispatched" }>;
	completed?: Extract<LedgerRecord, { type: "completed" }>;
	unknown?: Extract<LedgerRecord, { type: "unknown" }>;
}

export class InvocationLedger {
	readonly #file: JsonlFile<LedgerRecord>;
	readonly #state = new Map<string, InvocationState>();
	#loaded = false;

	constructor(path: string) {
		this.#file = new JsonlFile<LedgerRecord>(path);
	}

	get path(): string {
		return this.#file.path;
	}

	async load(): Promise<void> {
		if (this.#loaded) return;
		for (const record of await this.#file.readAll()) this.#apply(record);
		this.#loaded = true;
	}

	get(invocationId: string): InvocationState | undefined {
		return this.#state.get(invocationId);
	}

	all(): Map<string, InvocationState> {
		return this.#state;
	}

	async append(record: LedgerRecord, durable = true): Promise<void> {
		await this.#file.append(record, { durable });
		this.#apply(record);
	}

	#apply(record: LedgerRecord): void {
		const state = this.#state.get(record.invocationId) ?? {};
		if (record.type === "dispatched") state.dispatched = record;
		else if (record.type === "completed") state.completed = record;
		else state.unknown = record;
		this.#state.set(record.invocationId, state);
	}
}
