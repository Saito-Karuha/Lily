import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalBackend } from "../../src/env/backends/local.ts";
import { LilyRuntime } from "../../src/runtime/runtime.ts";
import { RunStore } from "../../src/store/runs.ts";
import { exportRun } from "../../src/trajectory/export.ts";
import { tempDir } from "../helpers/env.ts";

/** A minimal vLLM-like OpenAI-compatible server that returns token ids when asked. */
function fakeVllm(): { server: Server; requests: any[] } {
	const requests: any[] = [];
	let call = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const payload = JSON.parse(body);
			requests.push(payload);
			const ids = payload.return_token_ids === true;
			res.writeHead(200, { "content-type": "text/event-stream" });
			const send = (chunk: object) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m1", ...chunk })}\n\n`);
			const promptIds = Array.from({ length: 5 + call * 10 }, (_, i) => 1000 + i);
			if (call === 0) {
				send({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null, ...(ids ? { token_ids: [] } : {}) }], ...(ids ? { prompt_token_ids: promptIds } : {}) });
				send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: '{"command": ' } }] }, finish_reason: null, ...(ids ? { token_ids: [11, 12, 13] } : {}) }] });
				send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"echo tokens"}' } }] }, finish_reason: null, ...(ids ? { token_ids: [14, 15] } : {}) }] });
				send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls", ...(ids ? { token_ids: [16] } : {}) }] });
			} else {
				send({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null, ...(ids ? { token_ids: [] } : {}) }], ...(ids ? { prompt_token_ids: promptIds } : {}) });
				send({ choices: [{ index: 0, delta: { content: "all " }, finish_reason: null, ...(ids ? { token_ids: [21] } : {}) }] });
				send({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: null, ...(ids ? { token_ids: [22] } : {}) }] });
				send({ choices: [{ index: 0, delta: {}, finish_reason: "stop", ...(ids ? { token_ids: [2] } : {}) }] });
			}
			call++;
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return { server, requests };
}

describe("token capture from a vLLM-compatible endpoint", () => {
	let fake: ReturnType<typeof fakeVllm>;
	let runtime: LilyRuntime;

	beforeAll(async () => {
		fake = fakeVllm();
		await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
		const port = (fake.server.address() as AddressInfo).port;
		runtime = await LilyRuntime.create({
			home: await tempDir("lily-home-"),
			config: {
				providers: {
					"fake-vllm": {
						api: "openai-completions",
						baseUrl: `http://127.0.0.1:${port}/v1`,
						models: [{ id: "m1", contextWindow: 32_768, maxTokens: 1024 }],
						tokenCapture: "vllm",
					},
				},
			},
			backends: [new LocalBackend()],
		});
	});

	afterAll(async () => {
		fake.server.close();
		await runtime.close();
	});

	it("requests token ids, records them per call, and exports token_exact calls", async () => {
		const session = await runtime.createSession({
			mode: "batch",
			model: "fake-vllm/m1",
			bundle: null,
			environment: { backend: "local", initialState: { kind: "empty" } },
		});
		const handle = await session.prompt("use a tool");
		const outcome = await handle.done;
		expect(outcome.status).toBe("completed");
		expect(outcome.finalText).toBe("all done");
		expect(fake.requests).toHaveLength(2);
		expect(fake.requests.every((r) => r.return_token_ids === true && r.stream === true)).toBe(true);

		const store = new RunStore(runtime.home.run(handle.runId));
		const calls = await store.calls.readAll();
		expect(calls.map((c) => c.fidelity)).toEqual(["token_exact", "token_exact"]);
		expect(calls[0]!.tokens?.promptTokens).toBe(5);
		expect(calls[0]!.payloadRef).toBeDefined();
		const trajectory = await exportRun(store, runtime.artifacts, { includePayloads: true, includeRaw: true });
		expect(trajectory.fidelity).toBe("token_exact");
		expect(trajectory.calls[0]!.tokens).toEqual({ promptTokenIds: [1000, 1001, 1002, 1003, 1004], outputTokenIds: [11, 12, 13, 14, 15, 16] });
		expect(trajectory.calls[1]!.tokens?.outputTokenIds).toEqual([21, 22, 2]);
		expect((trajectory.calls[0]!.payload as { return_token_ids?: boolean }).return_token_ids).toBe(true);
		expect((trajectory.tools[0]!.raw as { output: string }).output).toBe("tokens\n");
	});
});
