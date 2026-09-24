import { JsonlFile } from "../util/fsx.ts";

/** Event kinds that are broadcast live but not persisted (high-volume streaming deltas). */
export const EPHEMERAL_EVENTS = new Set(["message_delta", "tool_update"]);

export interface StoredEvent<E extends { type: string } = { type: string }> {
	seq: number;
	at: number;
	event: E;
}

export type EventListener<E extends { type: string }> = (event: StoredEvent<E>) => void;

/**
 * Durable, cursor-addressable event log for one session. Persistent events get
 * a strictly increasing `seq`; clients that reconnect read everything after
 * their cursor, then continue live. Ephemeral events carry `seq: -1`.
 */
export class EventLog<E extends { type: string }> {
	readonly #file: JsonlFile<StoredEvent<E>>;
	readonly #listeners = new Set<EventListener<E>>();
	#seq = 0;
	#loaded = false;

	constructor(path: string) {
		this.#file = new JsonlFile(path);
	}

	async load(): Promise<void> {
		if (this.#loaded) return;
		const events = await this.#file.readAll();
		this.#seq = events.at(-1)?.seq ?? 0;
		this.#loaded = true;
	}

	get lastSeq(): number {
		return this.#seq;
	}

	emit(event: E): StoredEvent<E> {
		const ephemeral = EPHEMERAL_EVENTS.has(event.type);
		const stored: StoredEvent<E> = { seq: ephemeral ? -1 : ++this.#seq, at: Date.now(), event };
		if (!ephemeral) void this.#file.append(stored).catch(() => {});
		for (const listener of this.#listeners) {
			try {
				listener(stored);
			} catch {
				// A failing subscriber must not break the run.
			}
		}
		return stored;
	}

	async read(afterSeq = 0, limit = 10_000): Promise<StoredEvent<E>[]> {
		await this.#file.flush();
		const events = await this.#file.readAll();
		return events.filter((e) => e.seq > afterSeq).slice(0, limit);
	}

	subscribe(listener: EventListener<E>): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async flush(): Promise<void> {
		await this.#file.flush();
	}
}
