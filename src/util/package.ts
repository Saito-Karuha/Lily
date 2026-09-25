import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
	name?: string;
	version?: string;
}

function readManifest(dir: string): PackageManifest | undefined {
	const path = join(dir, "package.json");
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as PackageManifest) : undefined;
}

/** The installed package's root, found from this module whether it runs from `src/` or compiled `dist/lib/`. */
function findPackageRoot(start: string): string {
	for (let dir = start; ; dir = dirname(dir)) {
		if (readManifest(dir)?.name === "lily-harness") return dir;
		if (dirname(dir) === dir) return resolve(start, "../..");
	}
}

export const PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

export const PACKAGE_VERSION = readManifest(PACKAGE_ROOT)?.version ?? "0.0.0";
