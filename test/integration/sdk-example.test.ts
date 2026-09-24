import { join } from "node:path";
import type { Context as AiContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { loadTasks, rollout } from "../../examples/sdk/rollout.ts";
import { loadRouter } from "../../src/resources/router.ts";
import type { LilyRuntime } from "../../src/runtime/runtime.ts";
import { RunStore } from "../../src/store/runs.ts";
import { exportRun } from "../../src/trajectory/export.ts";
import { EXAMPLES, testRuntime, turn } from "../helpers/runtime.ts";

let runtime: LilyRuntime | undefined;
afterEach(async () => {
	await runtime?.close();
	runtime = undefined;
	delete process.env.LILY_ROUTES;
});

function promptOf(context: AiContext): string {
	const first = context.messages.find((m) => m.role === "user") as { content: unknown } | undefined;
	return typeof first?.content === "string" ? first.content : JSON.stringify(first?.content ?? "");
}

describe("downstream code composes Lily's mechanisms (examples/sdk/rollout.ts)", () => {
	it("runs tasks concurrently in fresh environments, routes by label, checks and annotates each run", async () => {
		const t = await testRuntime();
		runtime = t.runtime;
		const base = await runtime.registry.importDirectory(join(EXAMPLES, "bundles/base"));
		const demo = await runtime.registry.importDirectory(join(EXAMPLES, "bundles/demo"));
		await runtime.registry.setRef("base", base.digest);
		await runtime.registry.setRef("demo", demo.digest);
		process.env.LILY_ROUTES = JSON.stringify({ bugfix: "demo", implement: "base" });
		runtime.router = await loadRouter(join(EXAMPLES, "routers/by-label.mjs"));

		// A scripted "policy": fixes calc-add, writes a wrong reverse_words, gives up on the rest.
		const solver = (context: AiContext) => {
			const prompt = promptOf(context);
			const turns = context.messages.filter((m) => m.role === "assistant").length;
			if (prompt.includes("calc.py")) {
				return [turn.tool("edit", { path: "calc.py", edits: [{ oldText: "return a - b", newText: "return a + b" }] }), turn.text("fixed")][turns]!;
			}
			if (prompt.includes("reverse_words")) {
				return [turn.tool("write", { path: "text_utils.py", content: "def reverse_words(s):\n    return s\n" }), turn.text("done")][turns]!;
			}
			return turn.text("I could not do it.");
		};
		t.faux.setResponses(Array.from({ length: 20 }, () => solver));

		const tasks = await loadTasks(join(EXAMPLES, "tasks/python/tasks.jsonl"));
		const results = await rollout(runtime, tasks, { model: "faux/faux-1", bundle: "@router", backend: "local", concurrency: 3 });
		expect(results.map((r) => [r.id, r.passed])).toEqual([
			["calc-add", true],
			["fizzbuzz", false],
			["reverse-words", false],
			["word-count", false],
		]);
		expect(results.every((r) => r.status === "completed")).toBe(true);

		const calc = await exportRun(new RunStore(runtime.home.run(results[0]!.runId)), runtime.artifacts);
		expect(calc.manifest.labels).toEqual({ task: "calc-add", group: "bugfix" });
		expect(calc.manifest.route).toMatchObject({ router: "by-label", bundle: demo.digest, info: { via: "group", group: "bugfix" } });
		expect(calc.annotations?.check).toMatchObject({ passed: true, exitCode: 0 });
		// The check never entered the agent's context.
		expect(JSON.stringify(calc.calls.map((c) => c.context))).not.toContain("LILY_CHECK");
		const fizz = await exportRun(new RunStore(runtime.home.run(results[1]!.runId)), runtime.artifacts);
		expect(fizz.manifest.route?.bundle).toBe(base.digest);
		// Every environment was torn down.
		expect(runtime.envs.live()).toHaveLength(0);
	});
});
