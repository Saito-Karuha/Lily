import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalBackend } from "../../src/env/backends/local.ts";
import { renderCallPayload } from "../../src/models/payload.ts";
import { customProvider } from "../../src/models/registry.ts";
import { renderResources } from "../../src/resources/render.ts";
import { LilyRuntime } from "../../src/runtime/runtime.ts";
import { createApi } from "../../src/server/api.ts";
import { createHttpServer } from "../../src/server/http.ts";
import { RunStore } from "../../src/store/runs.ts";
import { decodeTokenDeltas, exportRun, exportRunProjection, type TokenDelta } from "../../src/trajectory/export.ts";
import { renderCallView } from "../../src/trajectory/view.ts";
import { canonicalJson } from "../../src/util/hash.ts";
import { tempDir } from "../helpers/env.ts";
import { type FakeOpenAI, fakeOpenAI } from "../helpers/fake-openai.ts";
import { EXAMPLES, sampleRepo } from "../helpers/runtime.ts";

let fake: FakeOpenAI;
let runtime: LilyRuntime;
let server: Server;
let base: string;
let runId: string;
let sessionId: string;

const provider = (url: string, samplingParams?: Record<string, unknown>) => ({
	api: "openai-completions" as const,
	baseUrl: url,
	compat: { sendSessionAffinityHeaders: true },
	models: [{ id: "m1", contextWindow: 32_768, maxTokens: 1024, ...(samplingParams ? { samplingParams } : {}) }],
	tokenCapture: "vllm" as const,
});

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
	const body = await response.json();
	if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
	return body as T;
}

beforeAll(async () => {
	fake = await fakeOpenAI();
	runtime = await LilyRuntime.create({
		home: await tempDir("lily-home-"),
		config: { model: "fake/m1", providers: { fake: provider(fake.url) } },
		backends: [new LocalBackend()],
	});
	await runtime.registry.setRef("demo", (await runtime.registry.importDirectory(join(EXAMPLES, "bundles/demo"))).digest);
	await runtime.registry.setRef("base", (await runtime.registry.importDirectory(join(EXAMPLES, "bundles/base"))).digest);
	server = createHttpServer({ router: createApi(runtime) });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	fake.script([{ tool: "bash", args: { command: "seq 1 5" } }, { tool: "read", args: { path: "notes.txt", limit: 3 } }, { text: "all done" }]);
	const session = await runtime.createSession({
		mode: "batch",
		model: "fake/m1",
		bundle: "base",
		environment: { backend: "local", initialState: { kind: "directory", path: await sampleRepo() } },
	});
	sessionId = session.id;
	const handle = await session.prompt("look around");
	runId = handle.runId;
	expect((await handle.done).status).toBe("completed");
});

afterAll(async () => {
	server?.close();
	await runtime?.close();
	await fake?.close();
});

describe("replaying recorded calls", () => {
	it("rebuilds every recorded payload from the recorded context and options, without sending anything", async () => {
		const trajectory = await exportRun(new RunStore(runtime.home.run(runId)), runtime.artifacts, { includePayloads: true });
		expect(trajectory.calls).toHaveLength(3);
		const sent = fake.requests.length;
		for (const call of trajectory.calls) {
			expect(call.fidelity).toBe("token_exact");
			expect(call.options?.sessionId).toBe(`${sessionId}:main`);
			const result = await runtime.callPayload(runId, call.callId);
			expect(result.recordedPayloadMatches).toBe(true);
			expect(canonicalJson(result.payload)).toBe(canonicalJson(call.payload));
			expect(result.model).toMatchObject({ provider: "fake", modelId: "m1", matchesManifest: true });
			// The same through the SDK function, from the exported call alone.
			const model = runtime.models.getModel("fake", "m1")!;
			expect(canonicalJson(await renderCallPayload(runtime.models, model, call.context, call.options))).toBe(canonicalJson(call.payload));
		}
		expect(fake.requests.length).toBe(sent);
		const http = await api(`/api/runs/${runId}/calls/${trajectory.calls[1]!.callId}/payload`, { method: "POST", body: "{}" });
		expect(http.recordedPayloadMatches).toBe(true);
	});

	it("renders a view under another bundle, with its payload, identically over the SDK and HTTP", async () => {
		const store = new RunStore(runtime.home.run(runId));
		const trajectory = await exportRun(store, runtime.artifacts);
		const call = trajectory.calls[2]!;
		const request = { bundle: "demo", replace: ["attached_prompt", "tool_guidance"] as const, processor: "from-resources" as const, systemPrefix: "Guidance only the scorer sees.", output: "both" as const };
		const viewed = await runtime.callView(runId, call.callId, { ...request, replace: [...request.replace] });
		expect(viewed.context!.systemPrompt!.startsWith("Guidance only the scorer sees.")).toBe(true);
		expect(viewed.context!.systemPrompt).toContain("run the relevant tests");
		expect(viewed.report.rerendered).toBe(2);
		expect(viewed.target).toEqual(call.response);
		expect(viewed.model?.matchesManifest).toBe(true);
		const messages = (viewed.payload as { messages: Array<{ role: string; content: unknown }> }).messages;
		expect(messages[0]).toEqual({ role: "system", content: viewed.context!.systemPrompt });

		// Equal to composing the SDK pieces by hand.
		const demo = await runtime.registry.get("demo");
		const resources = await renderResources(await runtime.registry.path(demo.digest), demo, trajectory.manifest.environment.paths.resources);
		const view = await renderCallView(call, trajectory.manifest, { resources, replace: [...request.replace], processor: "from-resources", systemPrefix: request.systemPrefix }, runtime.artifacts);
		expect(view.context).toEqual(viewed.context);
		const payload = await renderCallPayload(runtime.models, runtime.models.getModel("fake", "m1")!, view.context, call.options);
		expect(canonicalJson(payload)).toBe(canonicalJson(viewed.payload));

		const http = await api(`/api/runs/${runId}/calls/${call.callId}/view`, { method: "POST", body: JSON.stringify(request) });
		expect(canonicalJson(http)).toBe(canonicalJson(viewed));
		const onlyPayload = await api(`/api/runs/${runId}/calls/${call.callId}/view`, { method: "POST", body: JSON.stringify({ ...request, output: "payload" }) });
		expect(onlyPayload.context).toBeUndefined();
		expect(canonicalJson(onlyPayload.payload)).toBe(canonicalJson(viewed.payload));
		// A payload for a caller-supplied context (the view's) over HTTP.
		const posted = await api(`/api/runs/${runId}/calls/${call.callId}/payload`, { method: "POST", body: JSON.stringify({ context: viewed.context }) });
		expect(canonicalJson(posted.payload)).toBe(canonicalJson(viewed.payload));
		expect(posted.recordedPayloadMatches).toBeUndefined();
	});

	it("rejects malformed view requests and unknown calls", async () => {
		const call = (await new RunStore(runtime.home.run(runId)).calls.readAll())[0]!;
		const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		expect((await post(`/api/runs/${runId}/calls/${call.callId}/view`, { replace: ["kernel"] })).status).toBe(400);
		expect((await post(`/api/runs/${runId}/calls/${call.callId}/view`, { nope: 1 })).status).toBe(400);
		const needsResources = await post(`/api/runs/${runId}/calls/${call.callId}/view`, { processor: "from-resources" });
		expect(needsResources.status).toBe(400);
		expect((await needsResources.json()).error.code).toBe("invalid_view");
		expect((await post(`/api/runs/${runId}/calls/call_nope/view`, {})).status).toBe(404);
		expect((await post(`/api/runs/${runId}/calls/${call.callId}/view`, { bundle: "no-such-bundle" })).status).toBe(404);
	});

	it("projects exports by purpose and field, with prefix-delta token ids that decode to the full export", async () => {
		const store = new RunStore(runtime.home.run(runId));
		const full = await exportRun(store, runtime.artifacts);
		const projected = await exportRunProjection(store, runtime.artifacts, { purposes: ["assistant"], fields: ["tokens"], tokenEncoding: "delta" });
		expect(projected.projection).toEqual({ purposes: ["assistant"], fields: ["tokens"], tokenEncoding: "delta" });
		expect(projected.calls.every((c) => c.context === undefined && c.response === undefined && c.tokens)).toBe(true);
		const deltas = projected.calls.map((c) => c.tokens!.promptTokenIds as TokenDelta);
		expect(deltas[0]).toMatchObject({ base: null, prefix: 0 });
		expect(deltas[1]!.base).toBe(projected.calls[0]!.callId);
		// Each prompt starts with the previous prompt and output: only the new ids travel.
		expect(deltas[1]!.prefix).toBe(full.calls[0]!.tokens!.promptTokenIds.length + full.calls[0]!.tokens!.outputTokenIds.length);
		expect(deltas[1]!.tail.length).toBeLessThan(full.calls[1]!.tokens!.promptTokenIds.length);
		const decoded = decodeTokenDeltas(projected);
		expect(decoded.calls.map((c) => c.tokens)).toEqual(full.calls.map((c) => c.tokens));
		expect(decoded.fidelity).toBe(full.fidelity);

		const http = await api(`/api/runs/${runId}/trajectory?purpose=assistant&fields=tokens,options&encoding=delta`);
		expect(decodeTokenDeltas(http).calls.map((c: any) => c.tokens)).toEqual(full.calls.map((c) => c.tokens));
		expect(http.calls[0].options).toEqual(full.calls[0]!.options);
		const bad = await fetch(`${base}/api/runs/${runId}/trajectory?fields=everything`);
		expect(bad.status).toBe(400);
	});

	it("records the model's effective configuration, so a sampling change shows in the manifest", async () => {
		const first = await new RunStore(runtime.home.run(runId)).readManifest();
		expect(first.model).toMatchObject({ provider: "fake", modelId: "m1", contextWindow: 32_768, maxTokens: 1024, tokenCapture: "vllm", compat: { sendSessionAffinityHeaders: true } });
		expect(first.model.baseUrlDigest).toMatch(/^sha256:/);
		expect(JSON.stringify(first)).not.toContain(fake.url);
		runtime.models.setProvider(customProvider("fake", provider(fake.url, { top_k: 20 })));
		try {
			fake.script([{ text: "again" }]);
			const session = await runtime.openSession(sessionId);
			const handle = await session.prompt("once more");
			await handle.done;
			const second = await new RunStore(runtime.home.run(handle.runId)).readManifest();
			expect(second.model.samplingParams).toEqual({ top_k: 20 });
			expect(second.model.configDigest).not.toBe(first.model.configDigest);
			expect(fake.requests.at(-1)!.body.top_k).toBe(20);
			// The earlier run's calls were made under another configuration: replays say so.
			const call = (await new RunStore(runtime.home.run(runId)).calls.readAll())[0]!;
			const replay = await runtime.callPayload(runId, call.callId);
			expect(replay.model.matchesManifest).toBe(false);
			expect(replay.recordedPayloadMatches).toBe(false);
		} finally {
			runtime.models.setProvider(customProvider("fake", provider(fake.url)));
		}
	});

	it("sends session affinity headers when the provider's compat asks for them", () => {
		const policyTurns = fake.requests.filter((r) => r.body.messages?.[0]?.role === "system");
		expect(policyTurns.length).toBeGreaterThan(0);
		for (const request of policyTurns) expect(request.headers["x-session-affinity"]).toBe(`${sessionId}:main`);
	});
});
