import { posix } from "node:path";
import {
	type Context,
	ExecutionError,
	type ExecutionEnv,
	err,
	FileError,
	type FileErrorCode,
	type FileInfo,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	sanitizeBinaryOutput,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-agent-core";
import { newId } from "../util/ids.ts";
import { EnvdClosedError, type EnvdClient, EnvdError } from "./envd-client.ts";
import type { StatResult } from "./protocol.ts";

const FILE_ERROR_CODES = new Set<FileErrorCode>([
	"aborted",
	"not_found",
	"permission_denied",
	"not_directory",
	"is_directory",
	"invalid",
	"not_supported",
	"unknown",
]);

function toFileError(error: unknown, path: string): FileError {
	if (error instanceof FileError) return error;
	if (error instanceof EnvdError) {
		const code = FILE_ERROR_CODES.has(error.code as FileErrorCode) ? (error.code as FileErrorCode) : "unknown";
		return new FileError(code, error.message, error.path ?? path, error);
	}
	if (error instanceof Error && error.name === "AbortError") return new FileError("aborted", "aborted", path, error);
	const cause = error instanceof Error ? error : new Error(String(error));
	return new FileError("unknown", cause.message, path, cause);
}

function toFileInfo(stat: StatResult, path: string): Result<FileInfo, FileError> {
	if (stat.kind === "other") return err(new FileError("invalid", "Unsupported file type", path));
	return ok({ name: stat.name, path: stat.path, kind: stat.kind, size: stat.size, mtimeMs: stat.mtimeMs });
}

/**
 * Pi {@link ExecutionEnv} implemented over lily-envd. Every path is interpreted
 * inside the guest; `~` means the guest home, never the host's.
 */
export class RemoteExecutionEnv implements ExecutionEnv {
	cwd: string;
	readonly client: EnvdClient;
	readonly home: string;
	readonly tmp: string;

	constructor(client: EnvdClient, options: { cwd: string; home: string; tmp: string }) {
		this.client = client;
		this.cwd = options.cwd;
		this.home = options.home;
		this.tmp = options.tmp;
	}

	resolve(path: string): string {
		let p = path;
		if (p === "~") p = this.home;
		else if (p.startsWith("~/")) p = posix.join(this.home, p.slice(2));
		else if (p.startsWith("file://")) p = decodeURIComponent(p.slice("file://".length));
		return posix.isAbsolute(p) ? posix.normalize(p) : posix.resolve(this.cwd, p);
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(this.resolve(path));
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(posix.join(...parts));
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const bytes = await this.readBinaryFile(path, context);
		if (!bytes.ok) return bytes;
		return ok(new TextDecoder().decode(bytes.value));
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		const text = await this.readTextFile(path, context);
		if (!text.ok) return text;
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const lines = text.value.split(/\r?\n/);
		if (text.value.endsWith("\n")) lines.pop();
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const resolved = this.resolve(path);
		if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", resolved));
		try {
			const { data } = await this.client.readFile(resolved);
			return ok(new Uint8Array(data));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#write(path, content, false, context);
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#write(path, content, true, context);
	}

	async #write(
		path: string,
		content: string | Uint8Array,
		append: boolean,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = this.resolve(path);
		if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", resolved));
		try {
			const data = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
			await this.client.request("fs.write", { path: resolved, data: data.toString("base64"), append, mkdirs: true });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async renameFile(sourcePath: string, destinationPath: string, _context: Context): Promise<Result<void, FileError>> {
		const from = this.resolve(sourcePath);
		try {
			await this.client.request("fs.rename", { from, to: this.resolve(destinationPath) });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, from));
		}
	}

	async fileInfo(path: string, _context: Context): Promise<Result<FileInfo, FileError>> {
		const resolved = this.resolve(path);
		try {
			return toFileInfo(await this.client.request("fs.stat", { path: resolved }), resolved);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async listDir(path: string, _context: Context): Promise<Result<FileInfo[], FileError>> {
		const resolved = this.resolve(path);
		try {
			const { entries } = await this.client.request("fs.list", { path: resolved });
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				const info = toFileInfo(entry, entry.path);
				if (info.ok) infos.push(info.value);
			}
			return ok(infos);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async canonicalPath(path: string, _context: Context): Promise<Result<string, FileError>> {
		const resolved = this.resolve(path);
		try {
			return ok((await this.client.request("fs.realpath", { path: resolved })).path);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const info = await this.fileInfo(path, context);
		if (info.ok) return ok(true);
		if (info.error.code === "not_found") return ok(false);
		return err(info.error);
	}

	async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		_context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = this.resolve(path);
		try {
			await this.client.request("fs.mkdir", { path: resolved, recursive: options?.recursive ?? true });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		_context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = this.resolve(path);
		try {
			await this.client.request("fs.remove", {
				path: resolved,
				recursive: options?.recursive ?? false,
				force: options?.force ?? false,
			});
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async createTempDir(prefix: string | undefined, _context: Context): Promise<Result<string, FileError>> {
		try {
			return ok((await this.client.request("fs.mktemp", { prefix: prefix ?? "tmp-", dir: true })).path);
		} catch (error) {
			return err(toFileError(error, this.tmp));
		}
	}

	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		_context: Context,
	): Promise<Result<string, FileError>> {
		try {
			return ok((await this.client.request("fs.mktemp", { ...options, dir: false })).path);
		} catch (error) {
			return err(toFileError(error, this.tmp));
		}
	}

	async exec(
		command: string,
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		if (options?.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0)) {
			return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
		}
		const limits = options?.capture?.limits;
		const maxBytes = limits?.maxBytes ?? 50 * 1024;
		const maxLines = limits?.maxLines ?? 2000;
		const retain = limits?.retain ?? "tail";
		// Keep a bounded window: enough bytes to render the retained view exactly.
		const windowBytes = maxBytes * 2 + 4096;
		let buffer = "";
		let head = "";
		let totalBytes = 0;
		let newlines = 0;
		const decoder = new TextDecoder();
		const id = newId("exec");
		const spillPath = options?.capture?.spill ? posix.join(this.tmp, `lily-bash-${id}.log`) : undefined;

		const view = () => {
			const source = retain === "head" ? head : buffer;
			const retained = retain === "head" ? truncateHead(source, { maxBytes, maxLines }) : truncateTail(source, { maxBytes, maxLines });
			const totalLines = newlines + (buffer.endsWith("\n") || totalBytes === 0 ? 0 : 1);
			const truncated = totalBytes > maxBytes || totalLines > maxLines;
			const { content, ...truncation } = retained;
			return {
				text: sanitizeBinaryOutput(content),
				truncation: {
					...truncation,
					truncated,
					truncatedBy: truncated ? (totalLines > maxLines ? ("lines" as const) : ("bytes" as const)) : null,
					totalBytes,
					totalLines,
				},
				...(truncated && spillPath ? { spillPath } : {}),
			};
		};

		try {
			const exit = await this.client.exec(
				{
					id,
					command,
					cwd: options?.cwd ? this.resolve(options.cwd) : this.cwd,
					env: options?.env,
					inheritEnv: options?.inheritEnv ?? true,
					timeoutMs: options?.timeout === undefined ? undefined : Math.round(options.timeout * 1000),
					spillPath,
				},
				{
					onOutput: (chunk) => {
						const text = decoder.decode(chunk, { stream: true });
						totalBytes += chunk.byteLength;
						for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) newlines++;
						if (head.length < windowBytes) head += text.slice(0, windowBytes - head.length);
						buffer += text;
						if (buffer.length > windowBytes * 2) buffer = buffer.slice(buffer.length - windowBytes);
						if (options?.onUpdate) options.onUpdate({ kind: "replace", output: view() }, context);
					},
				},
				context.abortSignal,
			);
			buffer += decoder.decode();
			const final = view();
			options?.onUpdate?.({ kind: "replace", output: final }, context);
			if (exit.error) return err(new ExecutionError("spawn_error", exit.error.message));
			if (exit.timedOut) return err(new ExecutionError("timeout", `timeout:${options?.timeout}`));
			if (exit.cancelled || context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
			const exitCode = exit.exitCode ?? 128 + signalNumber(exit.signal);
			const { text: _text, ...metadata } = final;
			return ok({ exitCode, ...metadata });
		} catch (error) {
			if (error instanceof EnvdError) {
				const code = error.code === "shell_unavailable" ? "shell_unavailable" : "spawn_error";
				return err(new ExecutionError(code, error.message, error));
			}
			if (error instanceof EnvdClosedError) return err(new ExecutionError("unknown", error.message, error));
			return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
		}
	}

	async cleanup(_context: Context): Promise<void> {}
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGTERM: 15 };

export function signalNumber(signal: string | null): number {
	return signal ? (SIGNALS[signal] ?? 0) : 0;
}
