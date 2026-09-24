import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { LocalBackend } from "../../src/env/backends/local.ts";
import { LilyRuntime } from "../../src/runtime/runtime.ts";
import { tempDir } from "./env.ts";

export const EXAMPLES = join(import.meta.dirname, "../../examples");

/** A runtime in a throwaway home with a scripted faux model registered as `faux/faux-1`. */
export async function testRuntime(options: { contextWindow?: number } = {}) {
	const home = await tempDir("lily-home-");
	const models = createModels();
	const faux = fauxProvider({
		models: [{ id: "faux-1", contextWindow: options.contextWindow ?? 128_000, maxTokens: 4096 }],
	});
	models.setProvider(faux.provider);
	const runtime = await LilyRuntime.create({
		home,
		config: { model: "faux/faux-1" },
		models,
		backends: [new LocalBackend()],
	});
	return { runtime, faux, home };
}

export const turn = {
	text: (text: string) => fauxAssistantMessage(text),
	tool: (name: string, args: Record<string, unknown>, text?: string) =>
		fauxAssistantMessage([...(text ? [fauxText(text)] : []), fauxToolCall(name, args as never)], { stopReason: "toolUse" }),
};

export type Step = FauxResponseStep;

/** A tiny Python project with a failing test. */
export async function sampleRepo(): Promise<string> {
	const dir = await tempDir("lily-repo-");
	await mkdir(join(dir, "src"));
	await mkdir(join(dir, "tests"));
	await writeFile(join(dir, "src", "calc.py"), "def add(a, b):\n    return a - b\n");
	await writeFile(join(dir, "tests", "test_calc.py"), "from src.calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n");
	await writeFile(join(dir, "notes.txt"), Array.from({ length: 400 }, (_, i) => `note ${i} mentions needle`).join("\n"));
	return dir;
}
