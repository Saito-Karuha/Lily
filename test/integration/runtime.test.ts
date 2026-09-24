import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context as AiContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBackend } from "../../src/env/backends/local.ts";
import type { LedgerRecord } from "../../src/kernel/ledger.ts";
import type { BashRaw } from "../../src/kernel/tools/raw.ts";
import { renderResources } from "../../src/resources/render.ts";
import type { LilyRuntime } from "../../src/runtime/runtime.ts";
import { RunStore } from "../../src/store/runs.ts";
import { exportRun } from "../../src/trajectory/export.ts";
import { baselineProcessor } from "../../src/resources/processor/dsl.ts";
import { renderCallView } from "../../src/trajectory/view.ts";
import { JsonlFile } from "../../src/util/fsx.ts";
import { EXAMPLES, sampleRepo, testRuntime, turn } from "../helpers/runtime.ts";

let runtime: LilyRuntime | undefined;
afterEach(async () => {
	await runtime?.close();
	runtime = undefined;
});

function skillLocation(context: AiContext): string {
	const match = /<location>([^<]+)<\/location>/.exec(context.systemPrompt ?? "");
	if (!match) throw new Error("no skill catalog in system prompt");
	return match[1]!;
}

describe("Lily runtime end to end (scripted model, local environment)", () => {
	it("runs a multi-turn task with skills, memory and an observation processor, and records everything", async () => {
		const t = await testRuntime();
		runtime = t.runtime;
		const demo = await runtime.registry.importDirectory(join(EXAMPLES, "bundles/demo"));
		const repo = await sampleRepo();
		t.faux.setResponses([
			(context) => turn.tool("read", { path: skillLocation(context) }, "Let me check the testing skill."),
			turn.tool("bash", { command: "grep -rn needle ." }),
			turn.tool("edit", { path: "src/calc.py", edits: [{ oldText: "return a - b", newText: "return a + b" }] }),
			turn.tool("bash", { command: "python3 -m pytest -q 2>&1 | tail -3 || true" }),
			turn.text("Fixed `add` and the test passes."),
		]);
		const session = await runtime.createSession({
			mode: "batch",
			model: "faux/faux-1",
			bundle: demo.digest,
			environment: { backend: "local", initialState: { kind: "directory", path: repo } },
		});
		const handle = await session.prompt("Fix the failing test.", { includeDate: false, labels: { task: "calc", split: "train" } });
		const outcome = await handle.done;
		expect(outcome.status).toBe("completed");
		expect(outcome.turns).toBe(5);
		expect(outcome.toolCalls).toBe(4);
		expect(outcome.finalText).toBe("Fixed `add` and the test passes.");

		const store = new RunStore(runtime.home.run(handle.runId));
		const manifest = await store.readManifest();
		expect(manifest.bundle?.digest).toBe(demo.digest);
		expect(manifest.systemPrompt.blocks.map((b) => b.kind)).toEqual(["kernel", "attached_prompt", "tool_guidance", "skills", "memory", "environment"]);
		expect(manifest.processorId).toMatch(/^sha256:/);
		expect(manifest.environment.isolation).toBe("none");
		expect(manifest.labels).toEqual({ task: "calc", split: "train" });

		// The copied workspace was edited; the host repo was not.
		const lease = session.lease!;
		expect(await readFile(join(lease.info.paths.workspace, "src/calc.py"), "utf8")).toContain("a + b");
		expect(await readFile(join(repo, "src/calc.py"), "utf8")).toContain("a - b");

		// Model calls: one per turn, with the exact system prompt the manifest describes.
		const calls = await store.calls.readAll();
		expect(calls).toHaveLength(5);
		expect(calls.every((c) => c.purpose === "assistant")).toBe(true);

		// Tool records: raw archived before formatting; F shortened the grep output, raw kept all 400 lines.
		const tools = await store.tools.readAll();
		expect(tools.map((r) => r.toolName)).toEqual(["read", "bash", "edit", "bash"]);
		const grep = tools[1]!;
		const raw = await runtime.artifacts.getJson<BashRaw>(grep.rawRef);
		expect(raw.output.trim().split("\n")).toHaveLength(400);
		const trajectory = await exportRun(store, runtime.artifacts);
		const grepObservation = trajectory.calls[2]!.context.messages.at(-1)!;
		const grepText = (grepObservation as { content: Array<{ text: string }> }).content[0]!.text;
		expect(grepText.split("\n").length).toBeLessThan(210);
		expect(grepText).toContain("[Showing 200 of 400 lines.");

		// Provenance links every observation to its raw envelope.
		const provenance = trajectory.calls[4]!.provenance;
		expect(provenance.systemPromptMatchesManifest).toBe(true);
		const toolResults = provenance.messages.filter((m) => m.origin === "tool_result");
		expect(toolResults).toHaveLength(4);
		expect(toolResults.every((m) => m.rawRef?.startsWith("sha256:"))).toBe(true);
		expect(trajectory.calls.every((c) => c.purpose === "assistant" && c.stopReason !== "error")).toBe(true);

		// Ledger: dispatched then completed for each invocation.
		const ledger = await new JsonlFile<LedgerRecord>(join(runtime.home.sessionMeta(session.id), "ledger.jsonl")).readAll();
		expect(ledger.filter((r) => r.type === "dispatched")).toHaveLength(4);
		expect(ledger.filter((r) => r.type === "completed")).toHaveLength(4);

		// Event log persisted with a cursor.
		const events = await session.events.read(0);
		const types = events.map((e) => e.event.type);
		expect(types).toContain("run_start");
		expect(types.filter((t) => t === "tool_end")).toHaveLength(4);
		expect(types.at(-1)).toBe("run_end");
		expect(events.every((e, i) => i === 0 || e.seq > events[i - 1]!.seq)).toBe(true);

		// Re-render the last call under other resources: attached prompt and tool guidance from the base
		// bundle (which has none), skills/memory as recorded, observations recomputed from the same raw
		// outputs with Pi's baseline processor. The conversation and the target stay as recorded.
		const base = await runtime.registry.importDirectory(join(EXAMPLES, "bundles/base"));
		const other = await renderResources(await runtime.registry.path(base.digest), base, manifest.environment.paths.resources);
		const view = await renderCallView(
			trajectory.calls[4]!,
			manifest,
			{ resources: other, replace: ["attached_prompt", "tool_guidance"], processor: baselineProcessor, systemPrefix: "<note>scorer only</note>" },
			runtime.artifacts,
		);
		expect(view.report.rerendered).toBe(4);
		expect(view.report.systemPromptReplaced).toEqual(["attached_prompt", "tool_guidance"]);
		expect(view.context.systemPrompt!.startsWith("<note>scorer only</note>\n\n")).toBe(true);
		expect(view.context.systemPrompt).not.toContain("<additional_instructions>");
		expect(view.context.systemPrompt).toContain("<available_skills>");
		const rerenderedGrep = (view.context.messages[4] as { content: Array<{ text: string }> }).content[0]!.text;
		expect(rerenderedGrep).toContain("note 399 mentions needle");
		expect(view.context.messages.filter((m) => m.role !== "toolResult")).toEqual(trajectory.calls[4]!.context.messages.filter((m) => m.role !== "toolResult"));
		expect(view.target).toEqual(trajectory.calls[4]!.response);

		// Without resources or a processor the view is exactly the recorded context.
		const same = await renderCallView(trajectory.calls[4]!, manifest, {}, runtime.artifacts);
		expect(same.context).toEqual(trajectory.calls[4]!.context);
	});

	it("cancels a running command and ends the run as aborted", async () => {
		const t = await testRuntime();
		runtime = t.runtime;
		t.faux.setResponses([turn.tool("bash", { command: "sleep 30" }), turn.text("unreachable")]);
		const session = await runtime.createSession({
			mode: "batch",
			model: "faux/faux-1",
			bundle: null,
			environment: { backend: "local", initialState: { kind: "empty" } },
		});
		const handle = await session.prompt("wait");
		setTimeout(() => void session.abort(), 400);
		const started = Date.now();
		const outcome = await handle.done;
		expect(outcome.status).toBe("aborted");
		expect(outcome.reason).toBe("user_cancelled");
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("stops at the turn budget", async () => {
		const t = await testRuntime();
		runtime = t.runtime;
		t.faux.setResponses(Array.from({ length: 10 }, () => turn.tool("bash", { command: "echo again" })));
		const session = await runtime.createSession({
			mode: "batch",
			model: "faux/faux-1",
			bundle: null,
			environment: { backend: "local", initialState: { kind: "empty" } },
			budget: { maxTurns: 3 },
		});
		const outcome = await (await session.prompt("loop")).done;
		expect(outcome.status).toBe("aborted");
		expect(outcome.reason).toBe("budget_turns");
		expect(outcome.turns).toBe(3);
	});

	it("blocks the run when the environment dies mid-command (outcome unknown, never re-run)", async () => {
		const t = await testRuntime();
		runtime = t.runtime;
		t.faux.setResponses([turn.tool("bash", { command: "sleep 20" }), turn.text("unreachable")]);
		const session = await runtime.createSession({
			mode: "batch",
			model: "faux/faux-1",
			bundle: null,
			environment: { backend: "local", initialState: { kind: "empty" } },
		});
		const handle = await session.prompt("go");
		await new Promise((r) => setTimeout(r, 500));
		process.kill(session.lease!.info.details.pid as number, "SIGKILL");
		const outcome = await handle.done;
		expect(outcome.status).toBe("blocked");
		expect(outcome.reason).toBe("outcome_unknown");
		const ledger = await new JsonlFile<LedgerRecord>(join(runtime.home.sessionMeta(session.id), "ledger.jsonl")).readAll();
		expect(ledger.some((r) => r.type === "unknown")).toBe(true);
	});

	it("steers a running task: the queued message reaches the model at the next turn", async () => {
		const t = await testRuntime();
		runtime = t.runtime;
		t.faux.setResponses([
			turn.tool("bash", { command: "sleep 1" }),
			(context) => {
				const texts = context.messages.filter((m) => m.role === "user").map((m) => JSON.stringify((m as { content: unknown }).content));
				return turn.text(texts.some((x) => x.includes("also mention bananas")) ? "saw the steer: bananas" : "no steer");
			},
		]);
		const session = await runtime.createSession({
			mode: "interactive",
			model: "faux/faux-1",
			bundle: null,
			environment: { backend: "local", initialState: { kind: "empty" } },
		});
		const handle = await session.prompt("start");
		await new Promise((r) => setTimeout(r, 300));
		await session.steer("also mention bananas");
		const outcome = await handle.done;
		expect(outcome.finalText).toBe("saw the steer: bananas");
		const queued = (await session.events.read(0)).filter((e) => e.event.type === "steer_queued");
		expect(queued.map((e) => e.event)).toEqual([{ type: "steer_queued", runId: handle.runId, text: "also mention bananas" }]);
		await expect(session.steer("too late")).rejects.toThrow(/No run is active/);
	});

	it("honours an abort that arrives while the environment is still being provisioned, and can prepare ahead", async () => {
		const t = await testRuntime();
		runtime = t.runtime;
		const local = new LocalBackend();
		runtime.envs.register({
			name: "slow",
			isolation: local.isolation,
			probe: () => local.probe(),
			create: async (...args: Parameters<LocalBackend["create"]>) => {
				await new Promise((r) => setTimeout(r, 700));
				return local.create(...args);
			},
		});
		t.faux.setResponses([turn.tool("bash", { command: "echo should-not-run > ran.txt" }), turn.text("unreachable")]);
		const session = await runtime.createSession({
			mode: "batch",
			model: "faux/faux-1",
			bundle: null,
			environment: { backend: "slow", initialState: { kind: "empty" } },
		});
		const starting = session.prompt("go");
		await new Promise((r) => setTimeout(r, 150));
		await session.abort();
		expect(session.busy).toBe(false);
		const outcome = await (await starting).done;
		expect(outcome.status).toBe("aborted");
		expect(outcome.reason).toBe("user_cancelled");
		expect(outcome.toolCalls).toBe(0);

		const warm = await runtime.createSession({
			mode: "batch",
			model: "faux/faux-1",
			bundle: null,
			environment: { backend: "local", initialState: { kind: "empty" } },
		});
		expect(warm.lease).toBeUndefined();
		const lease = await warm.prepare();
		expect(lease?.info.backend).toBe("local");
		expect(warm.lease).toBe(lease);

		// Concurrent callers share one in-flight provisioning instead of creating a second environment.
		const racing = await runtime.createSession({
			mode: "batch",
			model: "faux/faux-1",
			bundle: null,
			environment: { backend: "slow", initialState: { kind: "empty" } },
		});
		const before = runtime.envs.live().length;
		const [prepared, ran] = await Promise.all([racing.prepare(), racing.exec("echo hi")]);
		expect(ran.output.trim()).toBe("hi");
		expect(racing.lease).toBe(prepared);
		expect(runtime.envs.live().length).toBe(before + 1);
	});

	it("routes each run of an @router session through the runtime's router and records the decision", async () => {
		const t = await testRuntime();
		runtime = t.runtime;
		const base = await runtime.registry.importDirectory(join(EXAMPLES, "bundles/base"));
		const demo = await runtime.registry.importDirectory(join(EXAMPLES, "bundles/demo"));
		await runtime.registry.setRef("demo", demo.digest);
		const seen: Array<Record<string, string>> = [];
		runtime.router = {
			name: "by-group",
			route: ({ labels }) => {
				seen.push(labels);
				return labels.group === "fancy" ? { bundle: "demo", info: { group: "fancy" } } : { bundle: base.digest };
			},
		};
		t.faux.setResponses([turn.text("one"), turn.text("two"), turn.text("three")]);
		const session = await runtime.createSession({
			mode: "batch",
			model: "faux/faux-1",
			bundle: "@router",
			labels: { owner: "test" },
			environment: { backend: "local", initialState: { kind: "empty" } },
		});
		expect(session.binding.bundle).toBe("@router");
		const first = await session.prompt("a", { labels: { group: "fancy" } });
		await first.done;
		const second = await session.prompt("b", { labels: { group: "plain" } });
		await second.done;
		expect(seen).toEqual([
			{ owner: "test", group: "fancy" },
			{ owner: "test", group: "plain" },
		]);
		const m1 = await new RunStore(runtime.home.run(first.runId)).readManifest();
		const m2 = await new RunStore(runtime.home.run(second.runId)).readManifest();
		expect(m1.bundle?.digest).toBe(demo.digest);
		expect(m1.route).toEqual({ router: "by-group", requested: "@router", bundle: demo.digest, info: { group: "fancy" } });
		expect(m1.systemPrompt.blocks.map((b) => b.kind)).toContain("skills");
		expect(m2.bundle?.digest).toBe(base.digest);
		expect(m2.route?.bundle).toBe(base.digest);
		expect(m2.labels).toEqual({ owner: "test", group: "plain" });

		// A router is required: without one the run fails before any model call.
		runtime.router = undefined;
		await expect(session.prompt("c")).rejects.toThrow(/no router is configured/);
	});

	it("lets the caller exec in the session environment and export the workspace between runs", async () => {
		const t = await testRuntime();
		runtime = t.runtime;
		const repo = await sampleRepo();
		t.faux.setResponses([turn.tool("bash", { command: "echo changed > marker.txt" }), turn.text("done")]);
		const session = await runtime.createSession({
			mode: "batch",
			model: "faux/faux-1",
			bundle: null,
			environment: { backend: "local", initialState: { kind: "directory", path: repo } },
		});
		await (await session.prompt("change something")).done;
		const check = await session.exec("cat marker.txt && ls src");
		expect(check.exitCode).toBe(0);
		expect(check.output).toContain("changed");
		expect(check.output).toContain("calc.py");
		const failing = await session.exec("exit 3");
		expect(failing.exitCode).toBe(3);
		const archive = await session.exportWorkspace();
		expect(archive.byteLength).toBeGreaterThan(100);
		// exec is outside the run: nothing was added to the conversation or the run records.
		expect((await session.messages()).filter((m) => m.role === "toolResult")).toHaveLength(1);
	});

	it("forks a conversation into a new session and continues independently", async () => {
		const t = await testRuntime();
		runtime = t.runtime;
		const repo = await sampleRepo();
		t.faux.setResponses([turn.tool("bash", { command: "echo first" }), turn.text("first answer"), turn.text("second answer")]);
		const session = await runtime.createSession({
			mode: "interactive",
			model: "faux/faux-1",
			bundle: null,
			environment: { backend: "local", initialState: { kind: "mount", path: repo } },
		});
		await (await session.prompt("one")).done;
		const entries = await session.branchEntries();
		const forked = await runtime.forkSession(session.id);
		expect(forked.binding.parent?.kind).toBe("clone");
		expect((await forked.branchEntries()).map((e) => e.id)).toEqual(entries.map((e) => e.id));
		const outcome = await (await forked.prompt("two")).done;
		expect(outcome.finalText).toBe("second answer");
		expect(await session.branchEntries()).toHaveLength(entries.length);
		const sessions = await runtime.listSessions();
		expect(sessions.map((s) => s.sessionId).sort()).toEqual([session.id, forked.id].sort());
	});

	it("reopens a session from disk in a new runtime and continues the conversation", async () => {
		const t = await testRuntime();
		runtime = t.runtime;
		t.faux.setResponses([turn.text("hello"), turn.text("again")]);
		const repo = await sampleRepo();
		const session = await runtime.createSession({
			mode: "interactive",
			model: "faux/faux-1",
			bundle: null,
			environment: { backend: "local", initialState: { kind: "mount", path: repo } },
		});
		await (await session.prompt("hi")).done;
		const id = session.id;
		await runtime.close();
		const { LilyRuntime } = await import("../../src/runtime/runtime.ts");
		const { LocalBackend } = await import("../../src/env/backends/local.ts");
		runtime = await LilyRuntime.create({ home: t.home, config: { model: "faux/faux-1" }, models: t.runtime.models, backends: [new LocalBackend()] });
		const reopened = await runtime.openSession(id);
		expect((await reopened.messages()).map((m) => m.role)).toEqual(["user", "assistant"]);
		const outcome = await (await reopened.prompt("more")).done;
		expect(outcome.finalText).toBe("again");
		expect(reopened.binding.runs).toHaveLength(2);
	});
});
