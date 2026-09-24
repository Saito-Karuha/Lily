// Stage-0 probe: confirms the Pi 0.85.1 seams Lily relies on.
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AgentHarness,
	BACKGROUND_CONTEXT,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	JsonlSessionRepo,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

const ctx = BACKGROUND_CONTEXT;

describe("pi seams", () => {
	it("runs a two-turn tool loop through AgentHarness on a JSONL session", async () => {
		const root = await mkdtemp(join(tmpdir(), "lily-probe-"));
		const ws = join(root, "ws");
		const env = new NodeExecutionEnv({ cwd: ws });
		await env.createDir(ws, undefined, ctx);
		await writeFile(join(ws, "a.txt"), "hello\nworld\n");
		const models = createModels();
		const faux = fauxProvider();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage([fauxText("reading"), fauxToolCall("read", { path: "a.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi; exit 3" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const sessionFs = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fileSystem: sessionFs, sessionsRoot: join(root, "sessions") });
		const session = await repo.create({ cwd: "/lily-probe" }, ctx);
		const requests: unknown[] = [];
		const recording = new Proxy(models, {
			get(target, prop, receiver) {
				if (prop === "streamSimple") {
					return (m: any, c: any, o: any) => {
						requests.push({ model: m.id, messages: c.messages.length, tools: c.tools?.length });
						return target.streamSimple(m, c, o);
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});
		const { harness } = await AgentHarness.create(
			{
				session,
				models: recording,
				model: faux.getModel(),
				tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
				toolContext: { env },
				systemPrompt: "You are a test agent.",
				toolExecution: "sequential",
			},
			ctx,
		);
		const events: string[] = [];
		harness.events.on("tool_end", (e) => {
			events.push(`${e.toolName}:${e.isError}`);
		});
		const lane = await harness.lane("main", ctx);
		const result = await lane.prompt("go", undefined, ctx);
		expect(result.ok).toBe(true);
		const entries = await lane.findEntries({ order: "oldestFirst" }, ctx);
		const roles = entries.map((e) => (e.type === "message" ? e.message.role : e.type));
		expect(roles).toEqual(["user", "assistant", "toolResult", "assistant", "toolResult", "assistant"]);
		const bashResult = entries[4];
		if (bashResult.type !== "message" || bashResult.message.role !== "toolResult") throw new Error("bad");
		expect(bashResult.message.isError).toBe(true);
		expect((bashResult.message.content[0] as any).text).toContain("Command exited with code 3");
		expect(events).toEqual(["read:false", "bash:true"]);
		expect(requests.length).toBe(3);
		await harness.close(ctx);
		// Reopen and fork
		const [meta] = await repo.list(undefined, ctx);
		const forked = await repo.fork(meta, { scope: "branch", branch: "main", entryId: entries[2].id, position: "at" }, ctx);
		const forkedEntries = await (await forked.branch("main", ctx))!.findEntries({ order: "oldestFirst" }, ctx);
		expect(forkedEntries.length).toBe(3);
		await forked.close(ctx);
		await repo.close(ctx);
		const text = await readFile(meta.path, "utf8");
		expect(text.split("\n")[0]).toContain('"kind":"header"');
	});
});
