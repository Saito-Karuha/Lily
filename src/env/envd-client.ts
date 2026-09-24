import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { newId } from "../util/ids.ts";
import {
	ENVD_PROTOCOL_VERSION,
	type EnvdErrorCode,
	type EnvdEventFrame,
	type EnvdMethod,
	type EnvdMethods,
	type EnvdResponseFrame,
	type ExecExit,
	type ExecOutputEvent,
	type ExecStartParams,
	type HelloResult,
} from "./protocol.ts";

/** Error returned by lily-envd for a failed request. */
export class EnvdError extends Error {
	readonly code: EnvdErrorCode;
	readonly path?: string;

	constructor(code: EnvdErrorCode, message: string, path?: string) {
		super(message);
		this.name = "EnvdError";
		this.code = code;
		this.path = path;
	}
}

/** The transport to envd closed; the outcome of in-flight work is unknown. */
export class EnvdClosedError extends Error {
	constructor(message = "Execution environment connection closed") {
		super(message);
		this.name = "EnvdClosedError";
	}
}

export interface EnvdRequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: unknown): void;
}

interface ExecWaiter {
	onOutput(data: Buffer, seq: number): void;
	onExit(exit: ExecExit): void;
}

export interface ExecRequest extends Omit<ExecStartParams, "id"> {
	id?: string;
}

export interface ExecHandlers {
	onOutput?: (data: Buffer, seq: number) => void;
	/** Called once envd acknowledged the start (before any output). */
	onStarted?: (pid: number) => void;
}

const MAX_CHUNK = 4 * 1024 * 1024;

/**
 * JSON-lines RPC client for one lily-envd process. The client owns request ids,
 * routes exec events, and turns a closed transport into {@link EnvdClosedError}
 * for every in-flight call.
 */
export class EnvdClient {
	readonly #output: Writable;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #execs = new Map<string, ExecWaiter>();
	readonly #closedPromise: Promise<void>;
	#nextId = 1;
	#closed = false;
	#closeReason: Error | undefined;
	#hello: HelloResult | undefined;
	#resolveClosed!: () => void;

	constructor(input: Readable, output: Writable) {
		this.#output = output;
		this.#closedPromise = new Promise((resolve) => {
			this.#resolveClosed = resolve;
		});
		const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
		lines.on("line", (line) => this.#onLine(line));
		lines.on("close", () => this.#markClosed(new EnvdClosedError()));
		output.on("error", (error) => this.#markClosed(new EnvdClosedError(`envd write failed: ${error.message}`)));
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Resolves when the transport has closed. */
	whenClosed(): Promise<void> {
		return this.#closedPromise;
	}

	get info(): HelloResult {
		if (!this.#hello) throw new Error("envd handshake not completed");
		return this.#hello;
	}

	/**
	 * Checks the protocol version. `env` becomes the session's default environment for commands
	 * that inherit it — for guests whose envd environment the controller cannot set otherwise.
	 */
	async handshake(options?: EnvdRequestOptions & { env?: Record<string, string> }): Promise<HelloResult> {
		const { env, ...requestOptions } = options ?? {};
		const hello = await this.request("hello", { protocol: ENVD_PROTOCOL_VERSION, ...(env ? { env } : {}) }, requestOptions);
		if (hello.protocol !== ENVD_PROTOCOL_VERSION) {
			throw new Error(`envd protocol mismatch: expected ${ENVD_PROTOCOL_VERSION}, got ${hello.protocol}`);
		}
		this.#hello = hello;
		return hello;
	}

	request<M extends EnvdMethod>(
		method: M,
		params: EnvdMethods[M]["params"],
		options?: EnvdRequestOptions,
	): Promise<EnvdMethods[M]["result"]> {
		if (this.#closed) return Promise.reject(this.#closeReason ?? new EnvdClosedError());
		if (options?.signal?.aborted) return Promise.reject(abortError());
		const id = this.#nextId++;
		return new Promise<EnvdMethods[M]["result"]>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				options?.signal?.removeEventListener("abort", onAbort);
				this.#pending.delete(id);
			};
			const onAbort = () => {
				cleanup();
				reject(abortError());
			};
			this.#pending.set(id, {
				resolve: (value) => {
					cleanup();
					resolve(value as EnvdMethods[M]["result"]);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});
			options?.signal?.addEventListener("abort", onAbort, { once: true });
			if (options?.timeoutMs !== undefined) {
				timer = setTimeout(() => {
					cleanup();
					reject(new Error(`envd request ${method} timed out after ${options.timeoutMs}ms`));
				}, options.timeoutMs);
			}
			this.#output.write(`${JSON.stringify({ t: "req", id, m: method, p: params })}\n`);
		});
	}

	/**
	 * Runs one command to completion. Aborting the signal sends `exec.cancel` and
	 * still waits for the exit event, so callers always learn how the process ended.
	 */
	async exec(request: ExecRequest, handlers: ExecHandlers = {}, signal?: AbortSignal): Promise<ExecExit> {
		const id = request.id ?? newId("exec");
		if (this.#execs.has(id)) throw new Error(`exec id already in use: ${id}`);
		let resolveExit!: (exit: ExecExit) => void;
		let rejectExit!: (error: unknown) => void;
		const exitPromise = new Promise<ExecExit>((resolve, reject) => {
			resolveExit = resolve;
			rejectExit = reject;
		});
		const buffered: Array<{ data: Buffer; seq: number }> = [];
		let started = false;
		this.#execs.set(id, {
			onOutput: (data, seq) => {
				if (started) handlers.onOutput?.(data, seq);
				else buffered.push({ data, seq });
			},
			onExit: (exit) => resolveExit(exit),
		});
		// Mark handled: if exec.start itself fails we never await the exit promise.
		exitPromise.catch(() => {});
		void this.#closedPromise.then(() => rejectExit(this.#closeReason ?? new EnvdClosedError()));
		const onAbort = () => {
			void this.request("exec.cancel", { id, graceMs: 2000 }).catch(() => {});
		};
		try {
			const { pid } = await this.request("exec.start", { ...request, id });
			started = true;
			handlers.onStarted?.(pid);
			for (const chunk of buffered.splice(0)) handlers.onOutput?.(chunk.data, chunk.seq);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			return await exitPromise;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.#execs.delete(id);
		}
	}

	/** Uploads a gzip-compressed tar archive and extracts it under `root`. */
	async upload(root: string, archive: Uint8Array, options?: { maxBytes?: number; maxFiles?: number }) {
		const id = newId("up");
		await this.request("upload.begin", { id, root, ...options });
		for (let offset = 0; offset < archive.byteLength; offset += MAX_CHUNK) {
			const chunk = archive.subarray(offset, Math.min(offset + MAX_CHUNK, archive.byteLength));
			await this.request("upload.chunk", { id, data: Buffer.from(chunk).toString("base64") });
		}
		return this.request("upload.end", { id });
	}

	/** Downloads `root` as a gzip-compressed tar archive. */
	async download(root: string, options?: { maxBytes?: number }): Promise<Buffer> {
		const id = newId("down");
		await this.request("download.begin", { id, root, ...options });
		const parts: Buffer[] = [];
		for (;;) {
			const { data, eof } = await this.request("download.read", { id, length: MAX_CHUNK });
			if (data) parts.push(Buffer.from(data, "base64"));
			if (eof) break;
		}
		return Buffer.concat(parts);
	}

	/** Reads a whole file (following symlinks), up to `maxBytes`. */
	async readFile(path: string, maxBytes = 64 * 1024 * 1024): Promise<{ data: Buffer; size: number; complete: boolean }> {
		const parts: Buffer[] = [];
		let offset = 0;
		let size = 0;
		for (;;) {
			const length = Math.min(8 * 1024 * 1024, maxBytes - offset);
			if (length <= 0) return { data: Buffer.concat(parts), size, complete: offset >= size };
			const result = await this.request("fs.read", { path, offset, length });
			const chunk = Buffer.from(result.data, "base64");
			parts.push(chunk);
			offset += chunk.byteLength;
			size = result.size;
			if (result.eof || chunk.byteLength === 0) return { data: Buffer.concat(parts), size, complete: true };
		}
	}

	async shutdown(): Promise<void> {
		if (this.#closed) return;
		try {
			await this.request("shutdown", {}, { timeoutMs: 5000 });
		} catch {
			// The process may exit before answering.
		}
	}

	#onLine(line: string): void {
		if (line.length === 0) return;
		let frame: EnvdResponseFrame | EnvdEventFrame;
		try {
			frame = JSON.parse(line);
		} catch {
			this.#markClosed(new EnvdClosedError(`envd sent malformed frame: ${line.slice(0, 200)}`));
			return;
		}
		if (frame.t === "res") {
			const pending = this.#pending.get(frame.id);
			if (!pending) return;
			if (frame.ok) pending.resolve(frame.r);
			else pending.reject(new EnvdError(frame.e.code, frame.e.message, frame.e.path));
			return;
		}
		if (frame.t === "evt") this.#onEvent(frame);
	}

	#onEvent(frame: EnvdEventFrame): void {
		if (frame.m === "exec.output") {
			const event = frame.p as ExecOutputEvent;
			this.#execs.get(event.id)?.onOutput(Buffer.from(event.data, "base64"), event.seq);
		} else if (frame.m === "exec.exit") {
			const exit = frame.p as ExecExit;
			this.#execs.get(exit.id)?.onExit(exit);
		}
	}

	#markClosed(reason: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#closeReason = reason;
		for (const pending of this.#pending.values()) pending.reject(reason);
		this.#pending.clear();
		this.#resolveClosed();
	}
}

function abortError(): Error {
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	return error;
}
