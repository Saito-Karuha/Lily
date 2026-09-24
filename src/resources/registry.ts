import { cp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, exists, readJson, readJsonIfExists, writeJsonAtomic } from "../util/fsx.ts";
import type { Digest } from "../util/hash.ts";
import { shortDigest } from "../util/hash.ts";
import { newId } from "../util/ids.ts";
import { makeTreeReadOnly as makeReadOnly, makeTreeWritable as makeWritable } from "../util/tree.ts";
import {
	BUNDLE_FORMAT,
	type BundleFile,
	type BundleIndex,
	type BundleManifest,
	COMPONENT_DIRS,
	COMPONENTS,
	type Component,
	componentOf,
	indexBundle,
} from "./bundle.ts";

/**
 * Where a bundle came from. `derived` covers every bundle produced from others
 * (an edit, a candidate written by some external process, …); `data` is free-form
 * provenance for whoever produced it — Lily stores it and never interprets it.
 */
export type BundleOrigin =
	| { kind: "import"; source?: string }
	| { kind: "composite"; parts: Record<Component, Digest> }
	| { kind: "derived"; parents: Digest[]; data?: Record<string, unknown> };

export interface BundleRecord extends BundleIndex {
	createdAt: number;
	origin: BundleOrigin;
}

export interface FileChange {
	path: string;
	component: Component | "manifest";
	action: "add" | "modify" | "delete";
}

/**
 * Immutable, content-addressed store of resource bundles. Publishing never
 * overwrites: a changed bundle is a new digest. Refs (`base`, `latest`, …) are
 * the only mutable pointers, and runs always resolve them to a digest before
 * starting.
 */
export class BundleRegistry {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	#objectDir(digest: Digest): string {
		return join(this.root, "objects", shortDigest(digest, 64));
	}

	#recordPath(digest: Digest): string {
		return join(this.root, "records", `${shortDigest(digest, 64)}.json`);
	}

	get #refsPath(): string {
		return join(this.root, "refs.json");
	}

	/** Validates a directory and publishes it (idempotent for identical content). */
	async importDirectory(dir: string, origin: BundleOrigin = { kind: "import", source: dir }): Promise<BundleRecord> {
		const staging = join(this.root, "staging", newId("stage"));
		await ensureDir(join(this.root, "staging"));
		try {
			await cp(dir, staging, { recursive: true, verbatimSymlinks: true });
			return await this.#publishStaged(staging, origin);
		} finally {
			await makeWritable(staging);
			await rm(staging, { recursive: true, force: true });
		}
	}

	async #publishStaged(staging: string, origin: BundleOrigin): Promise<BundleRecord> {
		const index = await indexBundle(staging);
		const target = this.#objectDir(index.digest);
		const existing = await readJsonIfExists<BundleRecord>(this.#recordPath(index.digest));
		if (existing && (await exists(target))) return existing;
		await ensureDir(join(this.root, "objects"));
		if (!(await exists(target))) {
			// The caller removes `staging` afterwards; after the rename it no longer exists.
			// (Moving a directory needs it writable, so permissions are dropped after the move.)
			await rename(staging, target);
			await makeReadOnly(target);
		}
		const record: BundleRecord = { ...index, createdAt: Date.now(), origin };
		await writeJsonAtomic(this.#recordPath(index.digest), record);
		return record;
	}

	/** Resolves a full digest, a unique digest prefix (≥6 hex chars), or a ref name. */
	async resolve(ref: string): Promise<Digest> {
		const refs = await this.refs();
		if (refs[ref]) return refs[ref];
		const hex = ref.startsWith("sha256:") ? ref.slice(7) : ref;
		if (/^[0-9a-f]{6,64}$/.test(hex)) {
			const matches = (await this.#recordHexes()).filter((h) => h.startsWith(hex));
			if (matches.length === 1) return `sha256:${matches[0]}`;
			if (matches.length > 1) throw new Error(`Ambiguous bundle prefix: ${ref}`);
		}
		throw new Error(`Unknown bundle: ${ref}`);
	}

	async #recordHexes(): Promise<string[]> {
		try {
			return (await readdir(join(this.root, "records"))).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
		} catch {
			return [];
		}
	}

	async get(ref: string): Promise<BundleRecord> {
		const digest = await this.resolve(ref);
		return readJson<BundleRecord>(this.#recordPath(digest));
	}

	async list(): Promise<BundleRecord[]> {
		const records: BundleRecord[] = [];
		for (const hex of await this.#recordHexes()) records.push(await readJson<BundleRecord>(join(this.root, "records", `${hex}.json`)));
		return records.sort((a, b) => b.createdAt - a.createdAt);
	}

	async refs(): Promise<Record<string, Digest>> {
		return (await readJsonIfExists<Record<string, Digest>>(this.#refsPath)) ?? {};
	}

	async setRef(name: string, target: string): Promise<Digest> {
		if (!/^[A-Za-z][A-Za-z0-9._/-]{0,127}$/.test(name)) throw new Error(`Invalid ref name: ${name}`);
		const digest = await this.resolve(target);
		const refs = await this.refs();
		refs[name] = digest;
		await writeJsonAtomic(this.#refsPath, refs);
		return digest;
	}

	/** Read-only directory holding the bundle's files. */
	async path(ref: string): Promise<string> {
		return this.#objectDir(await this.resolve(ref));
	}

	async readText(ref: string, path: string): Promise<string | undefined> {
		const record = await this.get(ref);
		if (!record.files.some((f) => f.path === path)) return undefined;
		const dir = await this.path(record.digest);
		try {
			return await readFile(join(dir, path), "utf8");
		} catch {
			return undefined;
		}
	}

	/** Writable copy for editing; publish the result with `importDirectory(dir, {kind: "derived", …})`. */
	async checkout(ref: string, dest: string): Promise<void> {
		await cp(await this.path(ref), dest, { recursive: true });
		await makeWritable(dest);
	}

	/** Builds the bundle whose component c comes from bundle `parts[c]`. */
	async compose(parts: Record<Component, string>, name?: string): Promise<BundleRecord> {
		const resolved = {} as Record<Component, Digest>;
		for (const c of COMPONENTS) resolved[c] = await this.resolve(parts[c]);
		const staging = join(this.root, "staging", newId("compose"));
		await ensureDir(staging);
		try {
			for (const c of COMPONENTS) {
				const source = join(this.#objectDir(resolved[c]), COMPONENT_DIRS[c]);
				if (await exists(source)) await cp(source, join(staging, COMPONENT_DIRS[c]), { recursive: true });
			}
			const names = await Promise.all(COMPONENTS.map(async (c) => (await this.get(resolved[c])).manifest.name));
			const manifest: BundleManifest = {
				format: BUNDLE_FORMAT,
				name: name ?? `composite(${[...new Set(names)].join("+")})`,
				composite: resolved,
			};
			await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
			await makeWritable(staging);
			return await this.#publishStaged(staging, { kind: "composite", parts: resolved });
		} finally {
			await makeWritable(staging);
			await rm(staging, { recursive: true, force: true });
		}
	}

	async diff(fromRef: string, toRef: string): Promise<FileChange[]> {
		const [from, to] = await Promise.all([this.get(fromRef), this.get(toRef)]);
		return diffFiles(from.files, to.files);
	}

	/** Components whose content differs between two bundles. */
	async changedComponents(fromRef: string, toRef: string): Promise<Component[]> {
		const [from, to] = await Promise.all([this.get(fromRef), this.get(toRef)]);
		return COMPONENTS.filter((c) => from.componentDigests[c] !== to.componentDigests[c]);
	}

	/** Ancestry of a bundle following the first parent of derived bundles (newest first). */
	async lineage(ref: string): Promise<BundleRecord[]> {
		const chain: BundleRecord[] = [];
		let current: BundleRecord | undefined = await this.get(ref);
		const seen = new Set<string>();
		while (current && !seen.has(current.digest)) {
			seen.add(current.digest);
			chain.push(current);
			const parent: Digest | undefined = current.origin.kind === "derived" ? current.origin.parents[0] : undefined;
			current = parent ? await this.get(parent).catch(() => undefined) : undefined;
		}
		return chain;
	}
}

export function diffFiles(from: BundleFile[], to: BundleFile[]): FileChange[] {
	const before = new Map(from.map((f) => [f.path, f]));
	const after = new Map(to.map((f) => [f.path, f]));
	const changes: FileChange[] = [];
	for (const [path, file] of after) {
		const old = before.get(path);
		const component = componentOf(path) ?? "manifest";
		if (!old) changes.push({ path, component, action: "add" });
		else if (old.sha256 !== file.sha256 || old.executable !== file.executable) changes.push({ path, component, action: "modify" });
	}
	for (const path of before.keys()) {
		if (!after.has(path)) changes.push({ path, component: componentOf(path) ?? "manifest", action: "delete" });
	}
	return changes.sort((a, b) => a.path.localeCompare(b.path));
}
