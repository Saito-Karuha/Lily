import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as tar from "tar";

/** Packs a host directory's contents into an in-memory `.tar.gz`. */
export async function packDirectory(dir: string, options?: { exclude?: string[] }): Promise<Buffer> {
	const excluded = new Set(options?.exclude ?? []);
	const entries = (await readdir(dir)).filter((name) => !excluded.has(name));
	const chunks: Buffer[] = [];
	const sink = new PassThrough();
	sink.on("data", (chunk: Buffer) => chunks.push(chunk));
	const done = new Promise<void>((resolve, reject) => {
		sink.on("end", resolve);
		sink.on("error", reject);
	});
	if (entries.length === 0) {
		// An empty but valid tar.gz.
		tar.c({ gzip: true, cwd: dir, portable: true }, []).pipe(sink);
	} else {
		tar
			.c(
				{
					gzip: true,
					cwd: dir,
					portable: true,
					follow: false,
					filter: (path) => !path.split("/").some((part) => excluded.has(part)),
				},
				entries,
			)
			.pipe(sink);
	}
	await done;
	return Buffer.concat(chunks);
}

/** Extracts a `.tar.gz` buffer into a host directory. */
export async function unpackToDirectory(archive: Buffer, dir: string): Promise<void> {
	const scratch = await mkdtemp(join(tmpdir(), "lily-unpack-"));
	const file = join(scratch, "a.tgz");
	try {
		await writeFile(file, archive);
		await tar.x({ file, cwd: dir, strict: true, preservePaths: false });
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** Lists entry paths in a `.tar.gz` buffer. */
export async function listArchive(archive: Buffer): Promise<string[]> {
	const names: string[] = [];
	const parser = new tar.Parser({ onReadEntry: (entry) => { names.push(entry.path); entry.resume(); } });
	await new Promise<void>((resolve, reject) => {
		parser.on("end", resolve);
		parser.on("error", reject);
		parser.end(archive);
	});
	return names;
}
