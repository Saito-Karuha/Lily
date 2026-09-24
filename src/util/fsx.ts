import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

/** Write via temp file + rename so readers never observe a partial file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
	await ensureDir(dirname(path));
	const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	const handle = await open(tmp, "w");
	try {
		await handle.writeFile(data);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Append-only JSON-lines file. Each append is one line; `durable` appends fsync
 * before resolving (used for ledger records that must precede an external effect).
 */
export class JsonlFile<T> {
	readonly path: string;
	#queue: Promise<void> = Promise.resolve();

	constructor(path: string) {
		this.path = path;
	}

	append(record: T, options?: { durable?: boolean }): Promise<void> {
		const line = `${JSON.stringify(record)}\n`;
		const next = this.#queue.then(async () => {
			await ensureDir(dirname(this.path));
			if (options?.durable) {
				const handle = await open(this.path, "a");
				try {
					await handle.write(line);
					await handle.sync();
				} finally {
					await handle.close();
				}
			} else {
				await appendFile(this.path, line);
			}
		});
		this.#queue = next.catch(() => {});
		return next;
	}

	/** Reads all complete lines; a torn trailing line (crash mid-append) is ignored. */
	async readAll(): Promise<T[]> {
		await this.#queue;
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		// The last element is either "" (text ends with a newline) or a torn line; both are dropped.
		const complete = text.split("\n").slice(0, -1);
		const out: T[] = [];
		for (const line of complete) {
			if (line.trim() === "") continue;
			out.push(JSON.parse(line) as T);
		}
		return out;
	}

	async flush(): Promise<void> {
		await this.#queue;
	}
}

export async function writeTextIfMissing(path: string, text: string): Promise<void> {
	if (await exists(path)) return;
	await ensureDir(dirname(path));
	await writeFile(path, text);
}
