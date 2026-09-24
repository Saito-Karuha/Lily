// Compiles the library to dist/lib (plain JavaScript + declarations) for the npm package.
// Node refuses to strip types under node_modules, so the published package must not rely on it.
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(join(root, "dist", "lib"), { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.build.json")], { stdio: "inherit" });
cpSync(join(root, "src", "kernel", "tools", "vendor", "LICENSE-pi"), join(root, "dist", "lib", "kernel", "tools", "vendor", "LICENSE-pi"));
console.log("built dist/lib");
