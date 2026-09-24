// Vendored from Pi 0.85.1 (packages/agent/src/harness/tools/path-utils.ts), MIT License,
// Copyright (c) 2025 Mario Zechner. Not exported by @earendil-works/pi-agent-core;
// kept byte-for-byte except for import paths so Lily tool semantics match Pi exactly.
import type { Context, ExecutionEnv } from "@earendil-works/pi-agent-core";

import { getOrThrow } from "@earendil-works/pi-agent-core";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

function normalizeToolPath(path: string): string {
	const normalized = path.replace(UNICODE_SPACES, " ");
	return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}

export async function resolveToolPath(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	return getOrThrow(await env.absolutePath(normalizeToolPath(path), context));
}

export async function resolveReadToolPath(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	const resolved = await resolveToolPath(env, path, context);
	const variants = [
		resolved,
		resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
		resolved.normalize("NFD"),
		resolved.replace(/'/g, "\u2019"),
		resolved.normalize("NFD").replace(/'/g, "\u2019"),
	];

	for (const variant of new Set(variants)) {
		if (getOrThrow(await env.exists(variant, context))) return variant;
	}
	return resolved;
}
