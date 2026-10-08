import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashRaw } from "../../src/kernel/tools/raw.ts";
import type { LedgerRecord } from "../../src/kernel/ledger.ts";
import type { LilyEvent } from "../../src/runtime/events.ts";
import type { LilyRuntime } from "../../src/runtime/runtime.ts";
import { RunStore } from "../../src/store/runs.ts";
import { exportRun } from "../../src/trajectory/export.ts";
import { renderCallView } from "../../src/trajectory/view.ts";
import { baselineProcessor } from "../../src/resources/processor/dsl.ts";
import { JsonlFile } from "../../src/util/fsx.ts";
import { testRuntime, turn } from "../helpers/runtime.ts";

let runtime: LilyRuntime | undefined;
afterEach(async () => {
	await runtime?.close();
	runtime = undefined;
});

function batch(commands: Array<[string, string]>) {
	return fauxAssistantMessage(commands.map(([id, command]) => fauxToolCall("bash", { command }, { id })), { stopReason: "toolUse" });
}

async function setup(toolExecution?: "sequential" | "parallel", budget?: { timeoutMs?: number }) {
	const t = await testRuntime();
	runtime = t.runtime;
	const session = await runtime.createSession({
		mode: "batch", model: "faux/faux-1", bundle: null,
		environment: { backend: "local", initialState: { kind: "empty" } },
		...(toolExecution === undefined ? {} : { toolExecution }),
		...(budget ? { budget } : {}),
	});
	await session.prepare();
	const events: LilyEvent[] = [];
	session.events.subscribe(({ event }) => events.push(event));
	return { ...t, session, events, workspace: session.lease!.info.paths.workspace };
}

function started(events: LilyEvent[], id: string): boolean {
	return events.some((e) => e.type === "tool_update" && e.toolCallId === id && e.text.includes(`start-${id}`));
}

function ended(events: LilyEvent[], id: string): boolean {
	return events.some((e) => e.type === "tool_end" && e.toolCallId === id);
}

function gated(id: string): string {
	return `printf 'start-${id}\\n'; while [ ! -f release-${id} ]; do sleep 0.02; done; printf 'done-${id}\\n'`;
}

const wait = { timeout: 5000, interval: 10 };

describe("same-turn tool execution", () => {
	it.each([undefined, "sequential"] as const)("keeps %s sessions sequential", async (mode) => {
		const t = await setup(mode);
		t.faux.setResponses([batch([["a", gated("a")], ["b", gated("b")]]), turn.text("done")]);
		const run = await t.session.prompt("two independent commands");
		await vi.waitFor(() => expect(started(t.events, "a")).toBe(true), wait);
		expect(started(t.events, "b")).toBe(false);
		await writeFile(join(t.workspace, "release-a"), "");
		await vi.waitFor(() => expect(started(t.events, "b")).toBe(true), wait);
		expect(ended(t.events, "a")).toBe(true);
		await writeFile(join(t.workspace, "release-b"), "");
		expect((await run.done).status).toBe("completed");
		const manifest = await new RunStore(t.runtime.home.run(run.runId)).readManifest();
		expect(manifest.kernel.toolExecution).toBe("sequential");
	});

	it("overlaps tools, waits for the whole turn, and aligns results and replay in source order", async () => {
		const t = await setup("parallel");
		t.faux.setResponses([batch([["a", gated("a")], ["b", gated("b")]]), (context) => {
			expect(ended(t.events, "a")).toBe(true);
			expect(ended(t.events, "b")).toBe(true);
			const results = context.messages.filter((m) => m.role === "toolResult");
			expect(results.map((m) => m.toolCallId)).toEqual(["a", "b"]);
			expect(results[0]!.content).toEqual([{ type: "text", text: "start-a\ndone-a\n" }]);
			expect(results[1]!.content).toEqual([{ type: "text", text: "start-b\ndone-b\n" }]);
			return turn.text("done");
		}]);
		const run = await t.session.prompt("two independent commands");
		await vi.waitFor(() => expect([started(t.events, "a"), started(t.events, "b")]).toEqual([true, true]), wait);
		await writeFile(join(t.workspace, "release-b"), "");
		await vi.waitFor(() => expect(ended(t.events, "b")).toBe(true), wait);
		expect(ended(t.events, "a")).toBe(false);
		expect(t.faux.state.callCount).toBe(1);
		await t.session.setModel("faux/faux-1");
		await t.session.setThinking("off");
		await t.session.setBundle(null);
		expect(t.session.toolExecution).toBe("parallel");
		expect(t.session.binding.toolExecution).toBe("parallel");
		await expect(t.session.prompt("change mode", { toolExecution: "sequential" } as never)).rejects.toMatchObject({ code: "invalid_tool_execution" });
		await writeFile(join(t.workspace, "release-a"), "");
		expect((await run.done).status).toBe("completed");
		const store = new RunStore(t.runtime.home.run(run.runId));
		const trajectory = await exportRun(store, t.runtime.artifacts, { includeRaw: true });
		expect(trajectory.manifest.kernel.toolExecution).toBe("parallel");
		expect(trajectory.tools.map((tool) => tool.toolCallId)).toEqual(["b", "a"]);
		for (const tool of trajectory.tools) {
			const raw = await t.runtime.artifacts.getJson<BashRaw>(tool.rawRef);
			expect(raw.output).toBe(`start-${tool.toolCallId}\ndone-${tool.toolCallId}\n`);
		}
		const call = trajectory.calls[1]!;
		expect(call.provenance.messages.filter((m) => m.origin === "tool_result").map((m) => m.toolCallId)).toEqual(["a", "b"]);
		const view = await renderCallView(call, trajectory.manifest, { processor: baselineProcessor }, t.runtime.artifacts);
		expect(view.context).toEqual(call.context);
		expect(view.report.rerendered).toBe(2);
		expect(t.faux.state.callCount).toBe(2);
	});

	it("preserves a successful sibling when another tool returns an ordinary error", async () => {
		const t = await setup("parallel");
		t.faux.setResponses([batch([["bad", "printf 'ordinary-error\\n'; exit 7"], ["good", `${gated("good")}; printf 'once\\n' >> effects.log`]]), turn.text("both returned")]);
		const run = await t.session.prompt("error and success");
		await vi.waitFor(() => expect(ended(t.events, "bad")).toBe(true), wait);
		expect(t.faux.state.callCount).toBe(1);
		await writeFile(join(t.workspace, "release-good"), "");
		expect((await run.done).status).toBe("completed");
		expect(await readFile(join(t.workspace, "effects.log"), "utf8")).toBe("once\n");
		const trajectory = await exportRun(new RunStore(t.runtime.home.run(run.runId)), t.runtime.artifacts);
		const results = trajectory.calls[1]!.context.messages.filter((m) => m.role === "toolResult");
		expect(results.map((m) => [m.toolCallId, m.isError])).toEqual([["bad", true], ["good", false]]);
		const ledger = await new JsonlFile<LedgerRecord>(join(t.runtime.home.sessionMeta(t.session.id), "ledger.jsonl")).readAll();
		expect(ledger.filter((r) => r.type === "dispatched")).toHaveLength(2);
		expect(ledger.filter((r) => r.type === "completed")).toHaveLength(2);
	});

	it.each(["abort", "timeout"] as const)("cancels every in-flight process group on %s", async (stop) => {
		const t = await setup("parallel", stop === "timeout" ? { timeoutMs: 2000 } : undefined);
		const command = (id: string) => `sleep 30 & child=$!; printf 'start-${id} pids:%s:%s\\n' "$$" "$child"; wait`;
		t.faux.setResponses([batch([["a", command("a")], ["b", command("b")]]), turn.text("must not be called")]);
		const run = await t.session.prompt("two long-running commands");
		await vi.waitFor(() => expect([started(t.events, "a"), started(t.events, "b")]).toEqual([true, true]), wait);
		if (stop === "abort") await t.session.abort();
		const outcome = await run.done;
		expect(outcome.status).toBe("aborted");
		expect(outcome.reason).toBe(stop === "abort" ? "user_cancelled" : "budget_time");
		expect(t.faux.state.callCount).toBe(1);
		const store = new RunStore(t.runtime.home.run(run.runId));
		const tools = await store.tools.readAll();
		expect(tools).toHaveLength(2);
		for (const tool of tools) {
			const raw = await t.runtime.artifacts.getJson<BashRaw>(tool.rawRef);
			expect(raw.exec?.cancelled).toBe(true);
			const match = /pids:(\d+):(\d+)/.exec(raw.output)!;
			expect(match).not.toBeNull();
			for (const pid of match.slice(1).map(Number)) {
				await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), wait);
			}
		}
		expect(t.events.filter((e) => e.type === "tool_end").every((e) => e.isError)).toBe(true);
		expect(t.events.at(-1)?.type).toBe("run_end");
	}, 12_000);

	it("does not dispatch remaining effects when cancellation wins during tool admission", async () => {
		const t = await setup("parallel");
		t.faux.setResponses([batch(Array.from({ length: 8 }, (_, i) => [`call-${i}`, `printf unwanted > effect-${i}`])), turn.text("must not be called")]);
		let cancellation: Promise<void> | undefined;
		t.session.events.subscribe(({ event }) => {
			if (event.type === "tool_start" && !cancellation) cancellation = t.session.abort();
		});
		const run = await t.session.prompt("cancel before dispatch");
		expect((await run.done).status).toBe("aborted");
		await cancellation;
		expect(t.faux.state.callCount).toBe(1);
		for (let i = 1; i < 8; i++) await expect(readFile(join(t.workspace, `effect-${i}`))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps simultaneous result records intact and tool schemas identical to sequential mode", async () => {
		const t = await setup("parallel");
		const commands: Array<[string, string]> = Array.from({ length: 16 }, (_, i) => [`call-${i}`, `printf result-${i}`]);
		t.faux.setResponses([batch(commands), turn.text("done"), turn.text("sequential")]);
		const run = await t.session.prompt("many independent commands");
		expect((await run.done).status).toBe("completed");
		const trajectory = await exportRun(new RunStore(t.runtime.home.run(run.runId)), t.runtime.artifacts);
		expect(trajectory.tools).toHaveLength(commands.length);
		expect(new Set(trajectory.tools.map((tool) => tool.invocationId)).size).toBe(commands.length);
		const results = trajectory.calls[1]!.context.messages.filter((m) => m.role === "toolResult");
		expect(results.map((m) => m.toolCallId)).toEqual(commands.map(([id]) => id));
		for (const [i, result] of results.entries()) expect(result.content).toEqual([{ type: "text", text: `result-${i}` }]);
		const sequential = await t.runtime.createSession({ mode: "batch", model: "faux/faux-1", bundle: null, environment: { backend: "local", initialState: { kind: "empty" } } });
		const other = await sequential.prompt("baseline");
		await other.done;
		const baseline = await exportRun(new RunStore(t.runtime.home.run(other.runId)), t.runtime.artifacts);
		expect(trajectory.manifest.kernel.toolsDigest).toBe(baseline.manifest.kernel.toolsDigest);
		expect(trajectory.calls[0]!.context.tools).toEqual(baseline.calls[0]!.context.tools);
		expect(trajectory.manifest.systemPrompt.blocks[0]).toEqual(baseline.manifest.systemPrompt.blocks[0]);
	});

	it("keeps concurrent sessions and their cancellation independent", async () => {
		const t = await setup("parallel");
		const second = await t.runtime.createSession({ mode: "batch", model: "faux/faux-1", bundle: null, toolExecution: "parallel", environment: { backend: "local", initialState: { kind: "empty" } } });
		await second.prepare();
		const secondEvents: LilyEvent[] = [];
		second.events.subscribe(({ event }) => secondEvents.push(event));
		t.faux.setResponses([batch([["a", gated("a")], ["b", gated("b")]]), batch([["a", gated("a")], ["b", gated("b")]]), turn.text("first done")]);
		const firstRun = await t.session.prompt("first session");
		const secondRun = await second.prompt("second session");
		await vi.waitFor(() => expect([started(t.events, "a"), started(t.events, "b"), started(secondEvents, "a"), started(secondEvents, "b")]).toEqual([true, true, true, true]), wait);
		await writeFile(join(t.workspace, "release-a"), "");
		await writeFile(join(t.workspace, "release-b"), "");
		expect((await firstRun.done).status).toBe("completed");
		expect(second.busy).toBe(true);
		expect(ended(secondEvents, "a")).toBe(false);
		await second.abort();
		expect((await secondRun.done).status).toBe("aborted");
		for (const [session, run] of [[t.session, firstRun], [second, secondRun]] as const) {
			const tools = await new RunStore(t.runtime.home.run(run.runId)).tools.readAll();
			expect(tools).toHaveLength(2);
			expect(tools.every((tool) => tool.runId === run.runId)).toBe(true);
			expect(session.busy).toBe(false);
		}
	});

	it("records each unknown outcome when the shared environment dies", async () => {
		const t = await setup("parallel");
		t.faux.setResponses([batch([["a", gated("a")], ["b", gated("b")]]), turn.text("must not be called")]);
		const run = await t.session.prompt("lose the environment");
		await vi.waitFor(() => expect([started(t.events, "a"), started(t.events, "b")]).toEqual([true, true]), wait);
		await t.session.lease!.destroy();
		expect((await run.done).status).toBe("blocked");
		expect(t.faux.state.callCount).toBe(1);
		const ledger = await new JsonlFile<LedgerRecord>(join(t.runtime.home.sessionMeta(t.session.id), "ledger.jsonl")).readAll();
		const dispatched = ledger.filter((r) => r.type === "dispatched");
		const unknown = ledger.filter((r) => r.type === "unknown");
		expect(dispatched).toHaveLength(2);
		expect(new Set(unknown.map((r) => r.invocationId))).toEqual(new Set(dispatched.map((r) => r.invocationId)));
		expect(ledger.filter((r) => r.type === "completed")).toHaveLength(0);
	});
});
