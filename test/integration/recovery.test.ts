import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { LocalBackend } from "../../src/env/backends/local.ts";
import type { LedgerRecord } from "../../src/kernel/ledger.ts";
import { LilyRuntime } from "../../src/runtime/runtime.ts";
import { listRunIds, RunStore } from "../../src/store/runs.ts";
import { JsonlFile } from "../../src/util/fsx.ts";
import { tempDir } from "../helpers/env.ts";
import { testRuntime, turn } from "../helpers/runtime.ts";

const run = promisify(execFile);

describe("worker crash recovery", () => {
	it("reopens a session whose worker died mid-tool: the run is closed as interrupted and the effect is not repeated", async () => {
		const home = await tempDir("lily-home-");
		const workspace = await tempDir("lily-ws-");
		const fixture = join(import.meta.dirname, "../fixtures/crash-worker.ts");
		const child = await run(process.execPath, [fixture, home, workspace]).catch((error) => error as { stdout: string; signal?: string });
		expect((child as { signal?: string }).signal).toBe("SIGKILL");
		const sessionId = child.stdout.trim();
		expect(await readFile(join(workspace, "effects.log"), "utf8")).toBe("side-effect\n");

		const models = createModels();
		const faux = fauxProvider({ models: [{ id: "faux-1" }] });
		models.setProvider(faux.provider);
		faux.setResponses([turn.text("continuing after the crash")]);
		const runtime = await LilyRuntime.create({ home, config: { model: "faux/faux-1" }, models, backends: [new LocalBackend()] });
		try {
			const session = await runtime.openSession(sessionId);
			const [runId] = session.binding.runs;
			const outcome = await new RunStore(runtime.home.run(runId!)).readOutcome();
			expect(outcome?.status).toBe("interrupted");
			expect(outcome?.reason).toBe("worker_restarted");
			const ledger = await new JsonlFile<LedgerRecord>(join(runtime.home.sessionMeta(sessionId), "ledger.jsonl")).readAll();
			expect(ledger.filter((r) => r.type === "dispatched")).toHaveLength(1);
			expect(ledger.some((r) => r.type === "completed")).toBe(false);
			// The side effect ran exactly once, and the session is usable again.
			expect(await readFile(join(workspace, "effects.log"), "utf8")).toBe("side-effect\n");
			const next = await (await session.prompt("status?")).done;
			expect(next.status).toBe("completed");
			expect(next.finalText).toBe("continuing after the crash");
			const roles = (await session.messages()).map((m) => m.role);
			expect(roles[0]).toBe("user");
			expect(roles.at(-1)).toBe("assistant");
		} finally {
			await runtime.close();
		}
	});

	it("starts with files other tools leave in the data directory (Finder's .DS_Store)", async () => {
		const t = await testRuntime();
		t.faux.setResponses([turn.text("first"), turn.text("second")]);
		const workspace = await tempDir("lily-ws-");
		const session = await t.runtime.createSession({
			mode: "interactive",
			model: "faux/faux-1",
			bundle: null,
			environment: { backend: "local", initialState: { kind: "mount", path: workspace } },
		});
		expect((await (await session.prompt("hi")).done).status).toBe("completed");
		await t.runtime.close();

		const home = t.runtime.home;
		for (const dir of [home.root, home.envs, home.sessions, home.sessionMetaRoot, home.runs]) await writeFile(join(dir, ".DS_Store"), "\0\0\0\u0001Bud1");
		const models = createModels();
		const faux = fauxProvider({ models: [{ id: "faux-1" }] });
		models.setProvider(faux.provider);
		faux.setResponses([turn.text("after restart")]);
		const runtime = await LilyRuntime.create({ home: home.root, config: { model: "faux/faux-1" }, models, backends: [new LocalBackend()] });
		try {
			expect(await runtime.envs.sweep()).toEqual([]);
			expect((await runtime.listSessions()).map((s) => s.sessionId)).toEqual([session.id]);
			expect(await listRunIds(runtime.home.runs)).toHaveLength(1);
			const reopened = await runtime.openSession(session.id);
			expect((await (await reopened.prompt("again")).done).finalText).toBe("after restart");
		} finally {
			await runtime.close();
		}
	});
});
