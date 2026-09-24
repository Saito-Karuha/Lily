import { chmod, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "./fsx.ts";

async function chmodTree(dir: string, fileMode: (mode: number) => number, dirMode: number): Promise<void> {
	if (!(await exists(dir))) return;
	await chmod(dir, 0o755).catch(() => {});
	for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) await chmodTree(path, fileMode, dirMode);
		else if (entry.isFile()) await chmod(path, fileMode((await stat(path)).mode & 0o777)).catch(() => {});
	}
	await chmod(dir, dirMode).catch(() => {});
}

/** Drops write permission on every file and directory (symlinks are skipped). */
export async function makeTreeReadOnly(dir: string): Promise<void> {
	await chmodTree(dir, (mode) => mode & 0o555, 0o555);
}

/** Restores owner write permission so the tree can be edited or removed. */
export async function makeTreeWritable(dir: string): Promise<void> {
	await chmodTree(dir, (mode) => mode | 0o200, 0o755);
}

/** Removes a tree even if parts of it were made read-only. */
export async function removeTree(dir: string): Promise<void> {
	await makeTreeWritable(dir);
	await rm(dir, { recursive: true, force: true });
}
