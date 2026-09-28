import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "../../util/fsx.ts";
import { sha256Hex } from "../../util/hash.ts";
import { newId } from "../../util/ids.ts";

const digests = new Map<string, Promise<string>>();

/**
 * sha256 of a (possibly multi-GB) file, computed once per file version: results are kept in
 * memory and, with `cacheFile`, on disk, keyed by path, device, inode, size and mtime.
 */
export function fileDigest(path: string, cacheFile?: string): Promise<{ digest: string; bytes: number }> {
	return (async () => {
		const st = await stat(path);
		const version = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
		const key = `${path}\0${version}`;
		let pending = digests.get(key);
		if (!pending) {
			pending = (async () => {
				const cached = cacheFile ? await readJsonIfExists<Record<string, { version: string; digest: string }>>(cacheFile).catch(() => undefined) : undefined;
				const hit = cached?.[path];
				if (hit?.version === version) return hit.digest;
				const hash = createHash("sha256");
				for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk as Buffer);
				const digest = `sha256:${hash.digest("hex")}`;
				if (cacheFile) {
					const latest = (await readJsonIfExists<Record<string, { version: string; digest: string }>>(cacheFile).catch(() => undefined)) ?? {};
					await writeJsonAtomic(cacheFile, { ...latest, [path]: { version, digest } }).catch(() => {});
				}
				return digest;
			})();
			digests.set(key, pending);
			pending.catch(() => digests.delete(key));
		}
		return { digest: await pending, bytes: st.size };
	})();
}

/**
 * Files derived from immutable inputs (e.g. a bundle packed into an ext4 image), shared by every
 * VM that needs them and kept up to a size budget, least recently used first out. Entries are
 * read-only; a file still open by a running VM stays valid after eviction.
 */
export class DerivedFileCache {
	readonly dir: string;
	readonly #maxBytes: number;
	readonly #building = new Map<string, Promise<string>>();

	constructor(dir: string, maxBytes: number) {
		this.dir = dir;
		this.#maxBytes = maxBytes;
	}

	/** Path of the entry for `key`, calling `build(tmpPath)` to create it if it is not cached yet. */
	get(key: string, suffix: string, build: (path: string) => Promise<void>): Promise<string> {
		const name = `${/^[0-9a-f]{64}$/.test(key) ? key : sha256Hex(key)}${suffix}`;
		const path = join(this.dir, name);
		const inFlight = this.#building.get(name);
		if (inFlight) return inFlight;
		const pending = (async () => {
			try {
				const now = new Date();
				await utimes(path, now, now);
				return path;
			} catch {
				// Not cached yet.
			}
			await mkdir(this.dir, { recursive: true });
			const tmp = join(this.dir, `.${newId("tmp")}${suffix}`);
			try {
				await build(tmp);
				await chmod(tmp, 0o444);
				await rename(tmp, path);
			} finally {
				await rm(tmp, { force: true });
			}
			await this.#evict(name);
			return path;
		})();
		this.#building.set(name, pending);
		void pending.then(
			() => this.#building.delete(name),
			() => this.#building.delete(name),
		);
		return pending;
	}

	async #evict(keep: string): Promise<void> {
		const entries: Array<{ name: string; bytes: number; used: number }> = [];
		for (const name of await readdir(this.dir).catch(() => [] as string[])) {
			if (name.startsWith(".")) continue;
			const st = await stat(join(this.dir, name)).catch(() => undefined);
			if (st?.isFile()) entries.push({ name, bytes: st.blocks * 512, used: st.mtimeMs });
		}
		let total = entries.reduce((sum, e) => sum + e.bytes, 0);
		for (const entry of entries.sort((a, b) => a.used - b.used)) {
			if (total <= this.#maxBytes) break;
			if (entry.name === keep) continue;
			await rm(join(this.dir, entry.name), { force: true });
			total -= entry.bytes;
		}
	}
}
