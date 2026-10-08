import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseToolExecution } from "../../src/runtime/binding.ts";
import { readBinding, type SessionInit } from "../../src/runtime/session.ts";
import type { LilyRuntime } from "../../src/runtime/runtime.ts";
import { RunStore } from "../../src/store/runs.ts";
import { exportRun } from "../../src/trajectory/export.ts";
import { renderCallView } from "../../src/trajectory/view.ts";
import { EXAMPLES, testRuntime, turn } from "../helpers/runtime.ts";

let runtime: LilyRuntime | undefined;
afterEach(async () => {
	await runtime?.close();
	runtime = undefined;
});

const base: SessionInit = {
	mode: "batch", model: "faux/faux-1", bundle: null,
	environment: { backend: "local", initialState: { kind: "empty" } },
};

describe("tool execution configuration", () => {
	it("accepts only the two modes, with an explicit legacy default", async () => {
		expect(parseToolExecution(undefined)).toBe("sequential");
		expect(parseToolExecution("sequential")).toBe("sequential");
		expect(parseToolExecution("parallel")).toBe("parallel");
		const t = await testRuntime();
		runtime = t.runtime;
		for (const invalid of [null, "", "Parallel", "auto", 0, 2, true, {}, [], { mode: "parallel", maxConcurrency: 2 }]) {
			await expect(runtime.createSession({ ...base, toolExecution: invalid as never })).rejects.toMatchObject({ code: "invalid_tool_execution" });
		}
		expect(await runtime.listSessions()).toEqual([]);
	});

	it("persists the creation-time value through changes, reopen, fork and clone", async () => {
		const t = await testRuntime();
		runtime = t.runtime;
		t.faux.setResponses([turn.text("first"), turn.text("second")]);
		const init: SessionInit = { ...base, toolExecution: "parallel" };
		const session = await runtime.createSession(init);
		init.toolExecution = "sequential";
		expect(session.toolExecution).toBe("parallel");
		const binding = session.binding;
		await session.setModel("faux/faux-1");
		await session.setThinking("off");
		const demo = await runtime.registry.importDirectory(join(EXAMPLES, "bundles/demo"));
		await session.setBundle(demo.digest);
		expect(session.binding).toBe(binding);
		expect((await readBinding(runtime.home, session.id))?.toolExecution).toBe("parallel");
		await (await session.prompt("first")).done;
		for (const options of [{}, { scope: "tree" as const }, { entryId: (await session.tipId())! }]) {
			const forked = await runtime.forkSession(session.id, options);
			expect(forked.toolExecution).toBe("parallel");
			expect((await readBinding(runtime.home, forked.id))?.toolExecution).toBe("parallel");
		}
		await runtime.closeSession(session.id);
		const reopened = await runtime.openSession(session.id);
		expect(reopened.toolExecution).toBe("parallel");
		expect((await runtime.listSessions()).find((s) => s.sessionId === session.id)?.toolExecution).toBe("parallel");
		const run = await reopened.prompt("second");
		expect((await run.done).status).toBe("completed");
		expect((await new RunStore(runtime.home.run(run.runId)).readManifest()).kernel.toolExecution).toBe("parallel");
	});

	it("reads and exports legacy records as sequential without rewriting historical files", async () => {
		const t = await testRuntime();
		runtime = t.runtime;
		t.faux.setResponses([turn.tool("bash", { command: "printf legacy" }), turn.text("done"), turn.text("reopened")]);
		const session = await runtime.createSession(base);
		const run = await session.prompt("legacy run");
		await run.done;
		await runtime.closeSession(session.id);
		const bindingPath = join(runtime.home.sessionMeta(session.id), "binding.json");
		const manifestPath = join(runtime.home.run(run.runId), "manifest.json");
		const binding = JSON.parse(await readFile(bindingPath, "utf8"));
		delete binding.toolExecution;
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		delete manifest.kernel.toolExecution;
		manifest.kernel.version = "lily-kernel/0.1.1";
		const bindingText = JSON.stringify(binding);
		const manifestText = JSON.stringify(manifest);
		await writeFile(bindingPath, bindingText);
		await writeFile(manifestPath, manifestText);
		expect((await readBinding(runtime.home, session.id))?.toolExecution).toBe("sequential");
		const store = new RunStore(runtime.home.run(run.runId));
		const legacy = await store.readManifest();
		expect(legacy.kernel).toMatchObject({ version: "lily-kernel/0.1.1", toolExecution: "sequential" });
		const exported = await exportRun(store, runtime.artifacts);
		const call = exported.calls[1]!;
		expect((await renderCallView(call, exported.manifest, {}, runtime.artifacts)).context).toEqual(call.context);
		expect(await readFile(bindingPath, "utf8")).toBe(bindingText);
		expect(await readFile(manifestPath, "utf8")).toBe(manifestText);
		const reopened = await runtime.openSession(session.id);
		expect(reopened.toolExecution).toBe("sequential");
		const next = await reopened.prompt("continue");
		expect((await next.done).status).toBe("completed");
		expect((await new RunStore(runtime.home.run(next.runId)).readManifest()).kernel.toolExecution).toBe("sequential");
		expect(await readFile(manifestPath, "utf8")).toBe(manifestText);
	});

	it("rejects an invalid persisted mode instead of changing strategy on reopen", async () => {
		const t = await testRuntime();
		runtime = t.runtime;
		const session = await runtime.createSession(base);
		await runtime.closeSession(session.id);
		const path = join(runtime.home.sessionMeta(session.id), "binding.json");
		const saved = JSON.parse(await readFile(path, "utf8"));
		saved.toolExecution = "typo";
		await writeFile(path, JSON.stringify(saved));
		await expect(runtime.openSession(session.id)).rejects.toMatchObject({ code: "invalid_tool_execution" });
	});
});
