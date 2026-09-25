import { arch as hostArch, platform as hostPlatform } from "node:os";
import { join, resolve } from "node:path";
import { exists } from "../util/fsx.ts";
import { PACKAGE_ROOT } from "../util/package.ts";

export type GuestOs = "linux" | "darwin";
export type GuestArch = "amd64" | "arm64";

export function hostTarget(): { os: GuestOs; arch: GuestArch } {
	const os = hostPlatform() === "darwin" ? "darwin" : "linux";
	const arch = hostArch() === "arm64" ? "arm64" : "amd64";
	return { os, arch };
}

/** Path of the prebuilt lily-envd binary for a target (`npm run build:envd`). */
export async function envdBinary(os: GuestOs, arch: GuestArch): Promise<string> {
	const override = process.env.LILY_ENVD_DIR;
	const base = override ? resolve(override) : join(PACKAGE_ROOT, "dist", "envd");
	const path = join(base, `${os}-${arch}`, "lily-envd");
	if (!(await exists(path))) {
		throw new Error(`lily-envd binary not found at ${path}. Build it with: npm run build:envd`);
	}
	return path;
}

export function packageRoot(): string {
	return PACKAGE_ROOT;
}
