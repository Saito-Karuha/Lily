import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { EnvironmentLimits, EnvironmentSpec, InitialState } from "../env/types.ts";
import type { CallPurpose } from "../store/runs.ts";
import type { CallField } from "../trajectory/export.ts";
import { CALL_FIELDS } from "../trajectory/export.ts";
import type { CallViewRequest } from "../trajectory/replay.ts";
import type { ResourceBlockKind } from "../trajectory/view.ts";
import { LilyError } from "../util/errors.ts";
import { HttpError } from "./http.ts";

type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, name: string, keys: readonly string[]): Json {
	if (!isObject(value)) throw new HttpError(400, `${name} must be an object`);
	const unknown = Object.keys(value).filter((key) => !keys.includes(key));
	if (unknown.length) throw new HttpError(400, `${name} has unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} (known: ${keys.join(", ")})`);
	return value;
}

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value === "") throw new HttpError(400, `${name} must be a non-empty string`);
	return value;
}

function positive(value: unknown, name: string, integer: boolean): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
		throw new HttpError(400, `${name} must be a positive ${integer ? "integer" : "number"}`);
	}
	return value;
}

/**
 * Host paths named in requests. With `roots` configured (`server.allowedRoots`, `--allow-root`), a
 * path must resolve (symlinks included) to one of them or below; without, any existing path is accepted.
 */
export class HostPaths {
	readonly #roots: Promise<string[]> | undefined;

	constructor(roots: string[] | undefined) {
		this.#roots = roots?.length ? Promise.all(roots.map((root) => realpath(resolve(root)).catch(() => resolve(root)))) : undefined;
	}

	get restricted(): boolean {
		return this.#roots !== undefined;
	}

	async check(value: unknown, name: string, kind: "file" | "directory" | "any" = "any"): Promise<string> {
		if (typeof value !== "string" || value === "") throw new HttpError(400, `${name} must be a host path`);
		const path = resolve(value);
		let real: string;
		try {
			real = await realpath(path);
		} catch {
			throw new HttpError(400, `${name}: ${path} does not exist`);
		}
		const roots = await this.#roots;
		if (roots && !roots.some((root) => within(root, real))) {
			throw new LilyError("forbidden_path", `${name}: ${path} is outside the directories this server may read (server.allowedRoots)`);
		}
		if (kind !== "any") {
			const st = await stat(real);
			if (kind === "file" ? !st.isFile() : !st.isDirectory()) throw new HttpError(400, `${name}: ${path} is not a ${kind}`);
		}
		return path;
	}
}

function within(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const ENVIRONMENT_KEYS = ["backend", "image", "rootfs", "initialState", "limits", "env", "label"] as const;
const LIMIT_KEYS = ["cpus", "memoryMb", "pids", "diskMb", "network"] as const;

async function initialState(value: unknown, paths: HostPaths): Promise<InitialState> {
	if (value === undefined) return { kind: "empty" };
	if (!isObject(value)) throw new HttpError(400, "environment.initialState must be an object");
	switch (value.kind) {
		case "empty":
		case "image":
			object(value, "environment.initialState", ["kind"]);
			return { kind: value.kind };
		case "archive":
			object(value, "environment.initialState", ["kind", "path"]);
			return { kind: "archive", path: await paths.check(value.path, "environment.initialState.path", "file") };
		case "mount":
			object(value, "environment.initialState", ["kind", "path"]);
			return { kind: "mount", path: await paths.check(value.path, "environment.initialState.path", "directory") };
		case "directory": {
			object(value, "environment.initialState", ["kind", "path", "exclude"]);
			const exclude = value.exclude;
			if (exclude !== undefined && (!Array.isArray(exclude) || exclude.some((e) => typeof e !== "string" || e === ""))) {
				throw new HttpError(400, "environment.initialState.exclude must be an array of names");
			}
			const path = await paths.check(value.path, "environment.initialState.path", "directory");
			return { kind: "directory", path, ...(exclude ? { exclude: exclude as string[] } : {}) };
		}
		default:
			throw new HttpError(400, `environment.initialState.kind must be one of empty, directory, archive, mount, image`);
	}
}

function limits(value: unknown): EnvironmentLimits {
	const limits = object(value, "environment.limits", LIMIT_KEYS);
	const out: EnvironmentLimits = {};
	const cpus = positive(limits.cpus, "environment.limits.cpus", false);
	const memoryMb = positive(limits.memoryMb, "environment.limits.memoryMb", false);
	const pids = positive(limits.pids, "environment.limits.pids", true);
	const diskMb = positive(limits.diskMb, "environment.limits.diskMb", false);
	if (cpus !== undefined) out.cpus = cpus;
	if (memoryMb !== undefined) out.memoryMb = memoryMb;
	if (pids !== undefined) out.pids = pids;
	if (diskMb !== undefined) out.diskMb = diskMb;
	if (limits.network !== undefined) {
		if (limits.network !== "none" && limits.network !== "egress") throw new HttpError(400, `environment.limits.network must be "none" or "egress"`);
		out.network = limits.network;
	}
	return out;
}

function guestEnv(value: unknown): Record<string, string> {
	if (!isObject(value)) throw new HttpError(400, "environment.env must be an object of strings");
	for (const [key, v] of Object.entries(value)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new HttpError(400, `environment.env: invalid variable name ${JSON.stringify(key)}`);
		if (typeof v !== "string" || v.includes("\0")) throw new HttpError(400, `environment.env.${key} must be a string`);
	}
	return value as Record<string, string>;
}

/**
 * An `EnvironmentSpec` from a request body. `defaults` supplies the backend, image and limits a
 * request leaves out (the configured ones, as `runtime.isolatedEnvironment` does); given fields
 * replace them whole.
 */
export async function parseEnvironment(value: unknown, paths: HostPaths, defaults: (initial: InitialState, backend?: string) => EnvironmentSpec): Promise<EnvironmentSpec> {
	const body = object(value, "environment", ENVIRONMENT_KEYS);
	const backend = optionalString(body.backend, "environment.backend");
	const spec = defaults(await initialState(body.initialState, paths), backend);
	const image = optionalString(body.image, "environment.image");
	if (image) spec.image = image;
	if (body.rootfs !== undefined) spec.rootfs = await paths.check(body.rootfs, "environment.rootfs", "file");
	if (body.limits !== undefined) spec.limits = limits(body.limits);
	if (body.env !== undefined) spec.env = guestEnv(body.env);
	const label = optionalString(body.label, "environment.label");
	if (label) spec.label = label;
	return spec;
}

const PURPOSES: CallPurpose[] = ["assistant", "compaction", "branch_summary", "deferred", "other"];

/** `?purpose=a,b&fields=x,y&encoding=delta` of the trajectory endpoint; undefined when none is given. */
export function parseProjection(query: URLSearchParams): { purposes?: CallPurpose[]; fields?: CallField[]; tokenEncoding?: "full" | "delta" } | undefined {
	const purpose = query.get("purpose");
	const fields = query.get("fields");
	const encoding = query.get("encoding");
	if (purpose === null && fields === null && encoding === null) return undefined;
	const list = (text: string) => text.split(",").map((s) => s.trim()).filter(Boolean);
	const out: { purposes?: CallPurpose[]; fields?: CallField[]; tokenEncoding?: "full" | "delta" } = {};
	if (purpose !== null) {
		const bad = list(purpose).filter((p) => !PURPOSES.includes(p as CallPurpose));
		if (bad.length) throw new HttpError(400, `purpose: unknown ${bad.join(", ")} (known: ${PURPOSES.join(", ")})`);
		out.purposes = list(purpose) as CallPurpose[];
	}
	if (fields !== null) {
		const bad = list(fields).filter((f) => !CALL_FIELDS.includes(f as CallField));
		if (bad.length) throw new HttpError(400, `fields: unknown ${bad.join(", ")} (known: ${CALL_FIELDS.join(", ")})`);
		out.fields = list(fields) as CallField[];
	}
	if (encoding !== null) {
		if (encoding !== "full" && encoding !== "delta") throw new HttpError(400, `encoding must be "full" or "delta"`);
		out.tokenEncoding = encoding;
	}
	return out;
}

const VIEW_KEYS = ["bundle", "replace", "processor", "systemPrefix", "observationCapBytes", "output"] as const;
const BLOCKS: ResourceBlockKind[] = ["attached_prompt", "tool_guidance", "skills", "memory"];

export function parseViewRequest(value: unknown): CallViewRequest {
	const body = object(value, "view request", VIEW_KEYS);
	const out: CallViewRequest = {};
	if (body.bundle !== undefined) {
		if (body.bundle !== null && (typeof body.bundle !== "string" || body.bundle === "")) throw new HttpError(400, "bundle must be a bundle ref, a digest or null");
		out.bundle = body.bundle as string | null;
	}
	if (body.replace !== undefined) {
		if (!Array.isArray(body.replace) || body.replace.some((b) => !BLOCKS.includes(b as ResourceBlockKind))) {
			throw new HttpError(400, `replace must be an array of ${BLOCKS.join(", ")}`);
		}
		out.replace = body.replace as ResourceBlockKind[];
	}
	if (body.processor !== undefined) {
		if (body.processor !== "from-resources" && body.processor !== "baseline") throw new HttpError(400, `processor must be "from-resources" or "baseline"`);
		out.processor = body.processor;
	}
	if (body.systemPrefix !== undefined) {
		if (typeof body.systemPrefix !== "string") throw new HttpError(400, "systemPrefix must be a string");
		out.systemPrefix = body.systemPrefix;
	}
	const cap = positive(body.observationCapBytes, "observationCapBytes", true);
	if (cap !== undefined) out.observationCapBytes = cap;
	if (body.output !== undefined) {
		if (body.output !== "context" && body.output !== "payload" && body.output !== "both") throw new HttpError(400, `output must be "context", "payload" or "both"`);
		out.output = body.output;
	}
	return out;
}
