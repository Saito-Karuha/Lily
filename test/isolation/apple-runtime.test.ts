import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { Context as AiContext } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it } from "vitest";
import { ContainerBackend } from "../../src/env/backends/container.ts";
import { LilyRuntime } from "../../src/runtime/runtime.ts";
import { RunStore } from "../../src/store/runs.ts";
import { tempDir } from "../helpers/env.ts";
import { EXAMPLES, turn } from "../helpers/runtime.ts";

const IMAGE = process.env.LILY_TEST_IMAGE ?? "docker.m.daocloud.io/library/python:3.12-slim";
const backend = new ContainerBackend({ dialect: "apple", defaultImage: IMAGE });
const available = (await backend.probe()).available;

describe.skipIf(!available)("runtime on apple-container (VM per run)", () => {
	let runtime: LilyRuntime | undefined;
	afterAll(async () => {
		await runtime?.close();
	});

	it("runs a task in a fresh VM with the bundle at the fixed guest path, then lets the caller check the result there", async () => {
		const models = createModels();
		const faux = fauxProvider({ models: [{ id: "faux-1" }] });
		models.setProvider(faux.provider);
		runtime = await LilyRuntime.create({ home: await tempDir("lily-home-"), config: {}, models, backends: [backend] });
		const demo = await runtime.registry.importDirectory(join(EXAMPLES, "bundles/demo"));
		const solver = (context: AiContext) => {
			const i = context.messages.filter((m) => m.role === "assistant").length;
			const location = /<location>([^<]+)<\/location>/.exec(context.systemPrompt ?? "")![1]!;
			return [
				turn.tool("bash", { command: `pwd; uname -r; head -3 ${location}` }),
				turn.tool("edit", { path: "calc.py", edits: [{ oldText: "return a - b", newText: "return a + b" }] }),
				turn.text("done"),
			][i]!;
		};
		faux.setResponses(Array.from({ length: 5 }, () => solver));
		const session = await runtime.createSession({
			mode: "batch",
			model: "faux/faux-1",
			bundle: demo.digest,
			environment: runtime.isolatedEnvironment({ kind: "directory", path: join(EXAMPLES, "tasks/python/calc-add/repo") }, "apple-container"),
			labels: { task: "calc-add" },
		});
		const handle = await session.prompt("Fix add in calc.py", { includeDate: false });
		const outcome = await handle.done;
		expect(outcome.status).toBe("completed");

		const store = new RunStore(runtime.home.run(handle.runId));
		const manifest = await store.readManifest();
		expect(manifest.environment.isolation).toBe("vm");
		expect(manifest.environment.paths.workspace).toBe("/workspace");
		expect(manifest.systemPrompt.blocks.find((b) => b.kind === "skills")?.text).toContain("/opt/lily/resources/skills/run-tests/SKILL.md");
		const [probe] = await store.tools.readAll();
		const raw = await runtime.artifacts.getJson<{ output: string }>(probe!.rawRef);
		expect(raw.output).toContain("/workspace");
		expect(raw.output).toContain("name: run-tests");

		const check = await session.exec("python3 -c 'from calc import add; print(add(2, 3))'");
		expect(check.exitCode).toBe(0);
		expect(check.output.trim()).toBe("5");
	}, 600_000);
});
