import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted completion: a tool call or a text answer. */
export type FakeTurn = { tool: string; args: Record<string, unknown> } | { text: string };

export interface FakeOpenAI {
	server: Server;
	url: string;
	requests: Array<{ body: any; headers: IncomingHttpHeaders }>;
	/** Queues the turns the next requests answer with (one per request, in order). */
	script(turns: FakeTurn[]): void;
	close(): Promise<void>;
}

/**
 * A minimal OpenAI-compatible streaming server (vLLM flavour): answers each request with the next
 * scripted turn and, when asked for `return_token_ids`, returns prompt and output token ids whose
 * prompt grows by the previous prompt plus output, as an agent loop's would.
 */
export async function fakeOpenAI(): Promise<FakeOpenAI> {
	const requests: FakeOpenAI["requests"] = [];
	let turns: FakeTurn[] = [];
	let history: number[] = [];
	let serial = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const payload = JSON.parse(body);
			requests.push({ body: payload, headers: req.headers });
			const ids = payload.return_token_ids === true;
			const turn = turns.shift() ?? { text: "done" };
			res.writeHead(200, { "content-type": "text/event-stream" });
			const send = (chunk: object) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: payload.model, ...chunk })}\n\n`);
			// Prompt ids: the previous prompt and output, then a few new ones (tool result, template).
			const promptIds = [...history, ...Array.from({ length: 7 }, () => 1000 + serial++)];
			const output: number[] = [];
			const out = (n: number) => {
				const ids = Array.from({ length: n }, () => 500 + serial++);
				output.push(...ids);
				return ids;
			};
			send({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null, ...(ids ? { token_ids: [] } : {}) }], ...(ids ? { prompt_token_ids: promptIds } : {}) });
			if ("tool" in turn) {
				const args = JSON.stringify(turn.args);
				const a = out(3);
				send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${serial}`, type: "function", function: { name: turn.tool, arguments: args } }] }, finish_reason: null, ...(ids ? { token_ids: a } : {}) }] });
				const b = out(1);
				send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls", ...(ids ? { token_ids: b } : {}) }] });
			} else {
				const a = out(2);
				send({ choices: [{ index: 0, delta: { content: turn.text }, finish_reason: null, ...(ids ? { token_ids: a } : {}) }] });
				const b = out(1);
				send({ choices: [{ index: 0, delta: {}, finish_reason: "stop", ...(ids ? { token_ids: b } : {}) }] });
			}
			history = [...promptIds, ...output];
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	return {
		server,
		url,
		requests,
		script(next) {
			turns = [...next];
			history = [];
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
