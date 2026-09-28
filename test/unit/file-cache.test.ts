import { readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DerivedFileCache, fileDigest } from "../../src/env/backends/file-cache.ts";
import { Semaphore } from "../../src/util/async.ts";
import { sha256 } from "../../src/util/hash.ts";
import { tempDir } from "../helpers/env.ts";

describe("fileDigest", () => {
	it("hashes a file once per version and persists the result", async () => {
		const dir = await tempDir();
		const file = join(dir, "rootfs.ext4");
		const cache = join(dir, "digests.json");
		await writeFile(file, "image-v1");
		const first = await fileDigest(file, cache);
		expect(first).toEqual({ digest: sha256("image-v1"), bytes: 8 });
		expect(JSON.parse(await readFile(cache, "utf8"))[file].digest).toBe(first.digest);
		await writeFile(file, "image-v2!");
		await utimes(file, new Date(), new Date(Date.now() + 5000));
		expect((await fileDigest(file, cache)).digest).toBe(sha256("image-v2!"));
	});
});

describe("DerivedFileCache", () => {
	it("builds an entry once, even for concurrent callers, and makes it read-only", async () => {
		const cache = new DerivedFileCache(await tempDir(), 1024 * 1024);
		let builds = 0;
		const build = async (path: string) => {
			builds++;
			await new Promise((resolve) => setTimeout(resolve, 20));
			await writeFile(path, "packed");
		};
		const key = "a".repeat(64);
		const [a, b] = await Promise.all([cache.get(key, ".ext4", build), cache.get(key, ".ext4", build)]);
		expect(a).toBe(b);
		expect(await cache.get(key, ".ext4", build)).toBe(a);
		expect(builds).toBe(1);
		expect((await stat(a)).mode & 0o222).toBe(0);
		expect(await readFile(a, "utf8")).toBe("packed");
	});

	it("evicts the least recently used entries beyond its budget", async () => {
		const dir = await tempDir();
		const cache = new DerivedFileCache(dir, 20 * 1024);
		const build = (path: string) => writeFile(path, Buffer.alloc(8 * 1024, 1));
		const first = await cache.get("1".repeat(64), ".img", build);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await cache.get("2".repeat(64), ".img", build);
		await new Promise((resolve) => setTimeout(resolve, 20));
		// Touching the first entry makes the second the least recently used one.
		await cache.get("1".repeat(64), ".img", build);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await cache.get("3".repeat(64), ".img", build);
		const names = (await readdir(dir)).sort();
		expect(names).toContain(first.split("/").at(-1));
		expect(names).not.toContain(`${"2".repeat(64)}.img`);
		expect(names).toContain(`${"3".repeat(64)}.img`);
	});
});

describe("Semaphore.tryAcquire", () => {
	it("takes a permit only when one is free", () => {
		const sem = new Semaphore(1);
		const release = sem.tryAcquire();
		expect(release).toBeDefined();
		expect(sem.tryAcquire()).toBeUndefined();
		expect(sem.available).toBe(0);
		release!();
		expect(sem.available).toBe(1);
	});
});
