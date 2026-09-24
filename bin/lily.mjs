#!/usr/bin/env node
// A source checkout runs the TypeScript sources directly (Node >= 22.19 strips types natively);
// the published package ships no src/ and runs the compiled JavaScript in dist/lib (Node refuses
// to strip types under node_modules).
import { existsSync } from "node:fs";

const source = new URL("../src/cli/main.ts", import.meta.url);
const compiled = new URL("../dist/lib/cli/main.js", import.meta.url);
const { main } = await import(existsSync(source) ? source.href : compiled.href);

main(process.argv.slice(2)).catch((error) => {
	process.stderr.write(`lily: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exit(1);
});
