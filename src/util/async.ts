/** A promise with externally accessible resolve/reject. */
export interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Counting semaphore for bounding concurrent work. */
export class Semaphore {
	#available: number;
	readonly #waiters: Array<() => void> = [];

	constructor(permits: number) {
		if (!Number.isInteger(permits) || permits < 1) throw new Error("Semaphore needs at least one permit");
		this.#available = permits;
	}

	async acquire(): Promise<() => void> {
		if (this.#available > 0) {
			this.#available--;
		} else {
			await new Promise<void>((resolve) => this.#waiters.push(resolve));
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.#waiters.shift();
			if (next) next();
			else this.#available++;
		};
	}

	async run<T>(task: () => Promise<T>): Promise<T> {
		const release = await this.acquire();
		try {
			return await task();
		} finally {
			release();
		}
	}
}
