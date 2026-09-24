/** Types for the lily-envd wire protocol (docs/envd-protocol.md). */

export const ENVD_PROTOCOL_VERSION = 1;

export type EnvdErrorCode =
	| "not_found"
	| "permission_denied"
	| "not_directory"
	| "is_directory"
	| "exists"
	| "invalid"
	| "too_large"
	| "bad_request"
	| "unknown_method"
	| "spawn_error"
	| "shell_unavailable"
	| "exec_exists"
	| "exec_not_found"
	| "unknown";

export interface EnvdErrorPayload {
	code: EnvdErrorCode;
	message: string;
	path?: string;
}

export interface EnvdRequestFrame {
	t: "req";
	id: number;
	m: string;
	p: unknown;
}

export type EnvdResponseFrame =
	| { t: "res"; id: number; ok: true; r: unknown }
	| { t: "res"; id: number; ok: false; e: EnvdErrorPayload };

export interface EnvdEventFrame {
	t: "evt";
	m: string;
	p: unknown;
}

export interface HelloResult {
	protocol: number;
	version: string;
	os: string;
	arch: string;
	pid: number;
	uid: number;
	gid: number;
	cwd: string;
	home: string;
	tmp: string;
	shell: string | null;
	hostname: string;
}

export type EnvdFileKind = "file" | "directory" | "symlink" | "other";

export interface StatResult {
	name: string;
	path: string;
	kind: EnvdFileKind;
	size: number;
	mtimeMs: number;
	mode: number;
}

export interface ReadResult {
	data: string;
	size: number;
	eof: boolean;
}

export interface ExecStartParams {
	id: string;
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	inheritEnv?: boolean;
	timeoutMs?: number;
	maxStreamBytes?: number;
	spillPath?: string;
	maxSpillBytes?: number;
}

export interface ExecExit {
	id: string;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	cancelled: boolean;
	durationMs: number;
	totalBytes: number;
	streamedBytes: number;
	truncated: boolean;
	spillPath: string | null;
	spillBytes: number | null;
	spillTruncated: boolean;
	error: { code: string; message: string } | null;
}

export interface ExecOutputEvent {
	id: string;
	seq: number;
	data: string;
}

export interface ExecStatusResult {
	state: "running" | "exited" | "unknown";
	exit?: ExecExit;
}

export interface EnvdMethods {
	/** `env` is added to every command that inherits the environment (session defaults). */
	hello: { params: { protocol: number; env?: Record<string, string> }; result: HelloResult };
	ping: { params: Record<string, never>; result: Record<string, never> };
	"fs.stat": { params: { path: string }; result: StatResult };
	"fs.read": { params: { path: string; offset?: number; length?: number }; result: ReadResult };
	"fs.write": {
		params: { path: string; data: string; append?: boolean; mkdirs?: boolean; mode?: number };
		result: { bytes: number };
	};
	"fs.list": { params: { path: string }; result: { entries: StatResult[] } };
	"fs.realpath": { params: { path: string }; result: { path: string } };
	"fs.mkdir": { params: { path: string; recursive?: boolean }; result: Record<string, never> };
	"fs.remove": { params: { path: string; recursive?: boolean; force?: boolean }; result: Record<string, never> };
	"fs.rename": { params: { from: string; to: string }; result: Record<string, never> };
	"fs.mktemp": { params: { prefix?: string; suffix?: string; dir?: boolean }; result: { path: string } };
	"exec.start": { params: ExecStartParams; result: { pid: number } };
	"exec.cancel": { params: { id: string; graceMs?: number }; result: { signaled: boolean } };
	"exec.status": { params: { id: string }; result: ExecStatusResult };
	"upload.begin": {
		params: { id: string; root: string; maxBytes?: number; maxFiles?: number };
		result: Record<string, never>;
	};
	"upload.chunk": { params: { id: string; data: string }; result: { received: number } };
	"upload.end": { params: { id: string }; result: { files: number; bytes: number } };
	"download.begin": { params: { id: string; root: string; maxBytes?: number }; result: Record<string, never> };
	"download.read": { params: { id: string; length?: number }; result: { data: string; eof: boolean } };
	shutdown: { params: Record<string, never>; result: Record<string, never> };
}

export type EnvdMethod = keyof EnvdMethods;
