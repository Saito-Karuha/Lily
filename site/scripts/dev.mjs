// Builds the site, serves dist/ and rebuilds when sources, docs or the demo change.
//
//   node scripts/dev.mjs [--port 4173]      (npm run dev; reload the browser after a change)
import { existsSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";
import { serve } from "./serve.mjs";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(SITE, "..");

await build();
serve({ dir: join(SITE, "dist") });

let timer = null;
const rebuild = (what) => {
	clearTimeout(timer);
	timer = setTimeout(async () => {
		console.log(`change in ${what} — rebuilding`);
		try {
			await build();
		} catch (error) {
			console.error(error);
		}
	}, 150);
};
for (const dir of [join(SITE, "src"), join(SITE, "demo"), join(REPO, "docs")]) {
	if (existsSync(dir)) watch(dir, { recursive: true }, (_, file) => rebuild(file ?? dir));
}
watch(join(SITE, "docs.json"), () => rebuild("docs.json"));
watch(REPO, (_, file) => file === "CHANGELOG.md" && rebuild(file));
