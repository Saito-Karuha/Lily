import { createHash } from "node:crypto";

export type Digest = `sha256:${string}`;

export function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export function sha256(data: string | Uint8Array): Digest {
	return `sha256:${sha256Hex(data)}`;
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const v = (value as Record<string, unknown>)[key];
			if (v !== undefined) out[key] = sortKeys(v);
		}
		return out;
	}
	return value;
}

export function digestOf(value: unknown): Digest {
	return sha256(canonicalJson(value));
}

export function shortDigest(digest: string, length = 12): string {
	const hex = digest.startsWith("sha256:") ? digest.slice(7) : digest;
	return hex.slice(0, length);
}
