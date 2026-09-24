import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ensureDir, exists } from "../util/fsx.ts";
import { type Digest, sha256 } from "../util/hash.ts";

/**
 * Content-addressed, write-once blob store for raw tool outputs, model call
 * contexts and provider payloads. A digest names immutable bytes; storing the
 * same bytes twice is a no-op.
 */
export class ArtifactStore {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	pathOf(digest: Digest | string): string {
		const hex = digest.startsWith("sha256:") ? digest.slice(7) : digest;
		if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Invalid digest: ${digest}`);
		return join(this.root, "sha256", hex.slice(0, 2), hex.slice(2));
	}

	async put(data: string | Uint8Array): Promise<Digest> {
		const digest = sha256(data);
		const path = this.pathOf(digest);
		if (await exists(path)) return digest;
		await ensureDir(join(path, ".."));
		const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
		await writeFile(tmp, data);
		await rename(tmp, path);
		return digest;
	}

	async putJson(value: unknown): Promise<Digest> {
		return this.put(JSON.stringify(value));
	}

	async get(digest: Digest | string): Promise<Buffer> {
		const data = await readFile(this.pathOf(digest));
		if (sha256(data) !== (digest.startsWith("sha256:") ? digest : `sha256:${digest}`)) {
			throw new Error(`Artifact ${digest} is corrupt`);
		}
		return data;
	}

	async getJson<T>(digest: Digest | string): Promise<T> {
		return JSON.parse((await this.get(digest)).toString("utf8")) as T;
	}

	async has(digest: Digest | string): Promise<boolean> {
		return exists(this.pathOf(digest));
	}

	async size(digest: Digest | string): Promise<number> {
		return (await stat(this.pathOf(digest))).size;
	}

	async remove(digest: Digest | string): Promise<void> {
		await rm(this.pathOf(digest), { force: true });
	}
}
