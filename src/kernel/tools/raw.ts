import { type Context, type ExecutionEnv, getOrThrow, type JsonValue } from "@earendil-works/pi-agent-core";
import { type EnvdClient, EnvdClosedError } from "../../env/envd-client.ts";
import { signalNumber } from "../../env/remote-env.ts";
import type { KernelToolName } from "./specs.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./vendor/pi-edit-diff.ts";
import { detectSupportedImageMimeType, encodeBase64 } from "./vendor/pi-image.ts";
import { resolveReadToolPath, resolveToolPath } from "./vendor/pi-path-utils.ts";

/**
 * The raw result `z` of one real tool execution, captured before any display
 * formatting. Observation processors (F) and teaching views re-render from this
 * record; it is never re-derived by executing the tool again.
 */
export type RawEnvelope = ReadRaw | WriteRaw | EditRaw | BashRaw;

export interface RawCommon {
	/** Arguments exactly as executed (after Pi's argument preparation and validation). */
	args: Record<string, JsonValue>;
	/** Present when the tool failed (the equivalent Pi tool threw). */
	error?: { message: string };
	/** False when a kernel safety cap cut the capture; F only sees what was captured. */
	complete: boolean;
	durationMs: number;
}

export interface ReadRaw extends RawCommon {
	tool: "read";
	resolvedPath?: string;
	content?:
		| {
				kind: "text";
				/** 1-based first line of the selection. */
				startLine: number;
				totalFileLines: number;
				/** The requested range (offset/limit applied), possibly capped. */
				text: string;
				/** Lines selected by an explicit `limit`, when one was given. */
				userLimitedLines?: number;
				/** UTF-8 size of the first selected line (for the oversized-line hint). */
				firstLineBytes: number;
		  }
		| { kind: "image"; mimeType: string; bytes: number; data: string };
}

export interface WriteRaw extends RawCommon {
	tool: "write";
	resolvedPath?: string;
	bytesWritten?: number;
}

export interface EditRaw extends RawCommon {
	tool: "edit";
	resolvedPath?: string;
	replaced?: number;
	diff?: string;
	patch?: string;
	firstChangedLine?: number;
}

export interface BashRaw extends RawCommon {
	tool: "bash";
	/** Combined stdout+stderr in write order, decoded as UTF-8 (unsanitized). */
	output: string;
	exec?: {
		exitCode: number | null;
		signal: string | null;
		timedOut: boolean;
		cancelled: boolean;
		totalBytes: number;
		capturedBytes: number;
		/** Guest path holding the complete output, kept only when the display may need it. */
		spillPath: string | null;
		/** Error code from the shell layer (spawn failure etc.). */
		errorCode?: string;
	};
}

export interface RawLimits {
	/** Largest file `read` loads (Pi reads whole files; Lily refuses beyond this). */
	maxReadFileBytes: number;
	/** Cap on the selected text stored in a read envelope. */
	maxReadTextBytes: number;
	/** Cap on bash output streamed back from the guest. */
	maxBashBytes: number;
}

export const DEFAULT_RAW_LIMITS: RawLimits = {
	maxReadFileBytes: 64 * 1024 * 1024,
	maxReadTextBytes: 8 * 1024 * 1024,
	maxBashBytes: 16 * 1024 * 1024,
};

/** Spill files smaller than this are deleted: Pi only mentions the full-output file when output was truncated. */
const SPILL_KEEP_THRESHOLD_BYTES = 50 * 1024;
const SPILL_KEEP_THRESHOLD_LINES = 2000;

export interface RawExecContext {
	env: ExecutionEnv;
	shell: EnvdClient;
	invocationId: string;
	context: Context;
	/** Guest temp directory for bash spill files. */
	tmpDir: string;
	limits?: RawLimits;
	/** Live bash output for UIs (not persisted). */
	onOutput?: (text: string) => void;
}

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const utf8 = new TextEncoder();

function byteLength(text: string): number {
	return utf8.encode(text).byteLength;
}

function capUtf8(text: string, maxBytes: number): { text: string; complete: boolean } {
	const bytes = utf8.encode(text);
	if (bytes.byteLength <= maxBytes) return { text, complete: true };
	let end = maxBytes;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return { text: new TextDecoder().decode(bytes.subarray(0, end)), complete: false };
}

function aborted(context: Context): void {
	if (context.abortSignal?.aborted) throw new Error("Operation aborted");
}

export async function executeRaw(
	tool: KernelToolName,
	args: Record<string, JsonValue>,
	ctx: RawExecContext,
): Promise<RawEnvelope> {
	const started = Date.now();
	switch (tool) {
		case "read":
			return withTiming(started, readRaw(args, ctx));
		case "write":
			return withTiming(started, writeRaw(args, ctx));
		case "edit":
			return withTiming(started, editRaw(args, ctx));
		case "bash":
			return withTiming(started, bashRaw(args, ctx));
	}
}

async function withTiming<T extends RawEnvelope>(started: number, work: Promise<Omit<T, "durationMs">>): Promise<T> {
	const result = await work;
	return { ...result, durationMs: Date.now() - started } as T;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function readRaw(args: Record<string, JsonValue>, ctx: RawExecContext): Promise<Omit<ReadRaw, "durationMs">> {
	const limits = ctx.limits ?? DEFAULT_RAW_LIMITS;
	const path = args.path as string;
	const offset = args.offset as number | undefined;
	const limit = args.limit as number | undefined;
	let resolvedPath: string | undefined;
	try {
		resolvedPath = await resolveReadToolPath(ctx.env, path, ctx.context);
		const info = await ctx.env.fileInfo(resolvedPath, ctx.context);
		if (info.ok && info.value.kind === "file" && info.value.size > limits.maxReadFileBytes) {
			throw new Error(
				`File is too large to read (${info.value.size} bytes, limit ${limits.maxReadFileBytes}). Use offset/limit via bash tools such as sed or head.`,
			);
		}
		const bytes = getOrThrow(await ctx.env.readBinaryFile(resolvedPath, ctx.context));
		const mimeType = detectSupportedImageMimeType(bytes);
		if (mimeType) {
			return {
				tool: "read",
				args,
				resolvedPath,
				complete: true,
				content: { kind: "image", mimeType, bytes: bytes.byteLength, data: encodeBase64(bytes) },
			};
		}
		const allLines = new TextDecoder().decode(bytes).split("\n");
		const startLine = offset ? Math.max(0, offset - 1) : 0;
		if (startLine >= allLines.length) {
			throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
		}
		let selected: string;
		let userLimitedLines: number | undefined;
		if (limit !== undefined) {
			const endLine = Math.min(startLine + limit, allLines.length);
			selected = allLines.slice(startLine, endLine).join("\n");
			userLimitedLines = endLine - startLine;
		} else {
			selected = allLines.slice(startLine).join("\n");
		}
		const capped = capUtf8(selected, limits.maxReadTextBytes);
		return {
			tool: "read",
			args,
			resolvedPath,
			complete: capped.complete,
			content: {
				kind: "text",
				startLine: startLine + 1,
				totalFileLines: allLines.length,
				text: capped.text,
				...(userLimitedLines === undefined ? {} : { userLimitedLines }),
				firstLineBytes: byteLength(allLines[startLine] ?? ""),
			},
		};
	} catch (error) {
		return { tool: "read", args, resolvedPath, complete: true, error: { message: messageOf(error) } };
	}
}

async function writeRaw(args: Record<string, JsonValue>, ctx: RawExecContext): Promise<Omit<WriteRaw, "durationMs">> {
	const path = args.path as string;
	const content = args.content as string;
	let resolvedPath: string | undefined;
	try {
		resolvedPath = await resolveToolPath(ctx.env, path, ctx.context);
		aborted(ctx.context);
		getOrThrow(await ctx.env.writeFile(resolvedPath, content, ctx.context));
		aborted(ctx.context);
		return { tool: "write", args, resolvedPath, complete: true, bytesWritten: byteLength(content) };
	} catch (error) {
		return { tool: "write", args, resolvedPath, complete: true, error: { message: messageOf(error) } };
	}
}

function editAccessMessage(path: string, code: string): string {
	return `Could not edit file: ${path}. Error code: ${code}.`;
}

async function editRaw(args: Record<string, JsonValue>, ctx: RawExecContext): Promise<Omit<EditRaw, "durationMs">> {
	const path = args.path as string;
	const edits = args.edits as unknown as Edit[];
	let resolvedPath: string | undefined;
	try {
		if (!Array.isArray(edits) || edits.length === 0) {
			throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
		}
		resolvedPath = await resolveToolPath(ctx.env, path, ctx.context);
		aborted(ctx.context);
		const info = await ctx.env.fileInfo(resolvedPath, ctx.context);
		if (!info.ok) throw new Error(editAccessMessage(path, info.error.code));
		if (info.value.kind !== "file" && info.value.kind !== "symlink") {
			throw new Error(`Could not edit file: ${path}. Path is not a file.`);
		}
		const read = await ctx.env.readTextFile(resolvedPath, ctx.context);
		if (!read.ok) throw new Error(editAccessMessage(path, read.error.code));
		aborted(ctx.context);
		const { bom, text } = stripBom(read.value);
		const originalEnding = detectLineEnding(text);
		const normalized = normalizeToLF(text);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalized, edits, path);
		aborted(ctx.context);
		const written = await ctx.env.writeFile(resolvedPath, bom + restoreLineEndings(newContent, originalEnding), ctx.context);
		if (!written.ok) throw new Error(editAccessMessage(path, written.error.code));
		aborted(ctx.context);
		const diff = generateDiffString(baseContent, newContent);
		return {
			tool: "edit",
			args,
			resolvedPath,
			complete: true,
			replaced: edits.length,
			diff: diff.diff,
			patch: generateUnifiedPatch(path, baseContent, newContent),
			...(diff.firstChangedLine === undefined ? {} : { firstChangedLine: diff.firstChangedLine }),
		};
	} catch (error) {
		return { tool: "edit", args, resolvedPath, complete: true, error: { message: messageOf(error) } };
	}
}

async function bashRaw(args: Record<string, JsonValue>, ctx: RawExecContext): Promise<Omit<BashRaw, "durationMs">> {
	const limits = ctx.limits ?? DEFAULT_RAW_LIMITS;
	const command = args.command as string;
	const timeout = args.timeout as number | undefined;
	if (timeout !== undefined) {
		if (!Number.isFinite(timeout) || timeout <= 0) {
			return { tool: "bash", args, output: "", complete: true, error: { message: "Invalid timeout: must be a finite number of seconds" } };
		}
		if (timeout > MAX_TIMEOUT_SECONDS) {
			return {
				tool: "bash",
				args,
				output: "",
				complete: true,
				error: { message: `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds` },
			};
		}
	}
	const spillPath = `${ctx.tmpDir.replace(/\/$/, "")}/lily-bash-${ctx.invocationId.replace(/[^A-Za-z0-9_-]/g, "")}.log`;
	const chunks: Buffer[] = [];
	const liveDecoder = new TextDecoder();
	let exit: Awaited<ReturnType<EnvdClient["exec"]>>;
	try {
		exit = await ctx.shell.exec(
			{
				id: `bash-${ctx.invocationId}`,
				command,
				cwd: ctx.env.cwd,
				inheritEnv: true,
				timeoutMs: timeout === undefined ? undefined : Math.round(timeout * 1000),
				maxStreamBytes: limits.maxBashBytes,
				spillPath,
			},
			{
				onOutput: (data) => {
					chunks.push(data);
					ctx.onOutput?.(liveDecoder.decode(data, { stream: true }));
				},
			},
			ctx.context.abortSignal,
		);
	} catch (error) {
		// A lost environment means the command's outcome is unknown: not a tool error.
		if (error instanceof EnvdClosedError) throw error;
		return { tool: "bash", args, output: "", complete: true, error: { message: messageOf(error) } };
	}
	const bytes = Buffer.concat(chunks);
	const output = new TextDecoder().decode(bytes);
	const newlines = countNewlines(output);
	const needsSpill = exit.totalBytes > SPILL_KEEP_THRESHOLD_BYTES || newlines >= SPILL_KEEP_THRESHOLD_LINES;
	if (!needsSpill && exit.spillPath) {
		await ctx.shell.request("fs.remove", { path: exit.spillPath, force: true }).catch(() => {});
	}
	const execInfo: BashRaw["exec"] = {
		exitCode: exit.exitCode ?? (exit.signal ? 128 + signalNumber(exit.signal) : null),
		signal: exit.signal,
		timedOut: exit.timedOut,
		cancelled: exit.cancelled,
		totalBytes: exit.totalBytes,
		capturedBytes: bytes.byteLength,
		spillPath: needsSpill ? exit.spillPath : null,
		...(exit.error ? { errorCode: exit.error.code } : {}),
	};
	let error: BashRaw["error"];
	if (exit.error) error = { message: exit.error.message };
	else if (exit.timedOut) error = { message: `Command timed out after ${timeout} seconds` };
	else if (exit.cancelled || ctx.context.abortSignal?.aborted) error = { message: "Command aborted" };
	else if (execInfo.exitCode !== 0) error = { message: `Command exited with code ${execInfo.exitCode}` };
	return {
		tool: "bash",
		args,
		output,
		complete: !exit.truncated,
		exec: execInfo,
		...(error ? { error } : {}),
	};
}

export function countNewlines(text: string): number {
	let count = 0;
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count++;
	return count;
}
