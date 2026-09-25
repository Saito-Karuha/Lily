import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LilyRuntime } from "../../src/runtime/runtime.ts";
import { createApi } from "../../src/server/api.ts";
import { createHttpServer } from "../../src/server/http.ts";
import { EXAMPLES, sampleRepo, testRuntime, turn } from "../helpers/runtime.ts";
import { join } from "node:path";
import type { Server } from "node:http";

let runtime: LilyRuntime;
let server: Server;
let base: string;
let faux: Awaited<ReturnType<typeof testRuntime>>["faux"];

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${base}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	const body = await response.json();
	if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
	return body as T;
}

/** Reads SSE messages until `until` returns true. */
async function readEvents(path: string, until: (event: any) => boolean): Promise<any[]> {
	const controller = new AbortController();
	const response = await fetch(`${base}${path}`, { signal: controller.signal });
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const events: any[] = [];
	let buffer = "";
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index: number;
			while ((index = buffer.indexOf("\n\n")) !== -1) {
				const chunk = buffer.slice(0, index);
				buffer = buffer.slice(index + 2);
				if (!chunk.startsWith("data: ")) continue;
				const message = JSON.parse(chunk.slice(6));
				events.push(message);
				if (until(message)) return events;
			}
		}
	} finally {
		controller.abort();
	}
	return events;
}

beforeAll(async () => {
	const t = await testRuntime();
	runtime = t.runtime;
	faux = t.faux;
	await runtime.registry.setRef("demo", (await runtime.registry.importDirectory(join(EXAMPLES, "bundles/demo"))).digest);
	server = createHttpServer({ router: createApi(runtime), allowedHosts: ["127.0.0.1", "localhost"] });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	server.close();
	await runtime.close();
});

describe("HTTP API", () => {
	it("serves status, models, environments and bundles", async () => {
		expect((await api("/api/status")).version).toBe(JSON.parse(await readFile(join(import.meta.dirname, "../../package.json"), "utf8")).version);
		expect((await api("/api/models")).some((m: any) => m.provider === "faux")).toBe(true);
		const envs = await api("/api/environments");
		expect(envs.backends.find((b: any) => b.name === "local").available).toBe(true);
		const bundles = await api("/api/bundles");
		expect(bundles.refs.demo).toMatch(/^sha256:/);
		const detail = await api("/api/bundles/demo");
		expect(detail.record.manifest.name).toBe("demo");
		const file = await fetch(`${base}/api/bundles/demo/files/skills/run-tests/SKILL.md`);
		expect(await file.text()).toContain("name: run-tests");
	});

	it("rejects foreign Host headers", async () => {
		// fetch() cannot override Host, so use a raw request.
		const { request } = await import("node:http");
		const status = await new Promise<number>((resolve, reject) => {
			const req = request(`${base}/api/status`, { headers: { host: "evil.example" } }, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on("error", reject);
			req.end();
		});
		expect(status).toBe(403);
	});

	it("creates a session, runs a prompt, and streams durable events", async () => {
		faux.setResponses([turn.tool("bash", { command: "echo from-api" }), turn.text("all done")]);
		const workspace = await sampleRepo();
		const created = await api("/api/sessions", { method: "POST", body: JSON.stringify({ workspace, backend: "local", bundle: "demo" }) });
		const id = created.sessionId;
		const { runId } = await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "say hi" }) });
		const events = await readEvents(`/api/sessions/${id}/events?after=0`, (m) => m.event.type === "run_end");
		const types = events.map((m) => m.event.type);
		expect(types).toContain("hello");
		expect(types).toContain("tool_end");
		expect(events.at(-1).event.outcome.status).toBe("completed");
		const persisted = events.filter((m) => m.seq > 0);
		expect(persisted.every((m, i) => i === 0 || m.seq > persisted[i - 1].seq)).toBe(true);

		// Reconnecting after the last cursor replays nothing old.
		const lastSeq = persisted.at(-1).seq;
		const replay = await readEvents(`/api/sessions/${id}/events?after=${lastSeq}`, (m) => m.event.type === "hello");
		expect(replay.map((m) => m.event.type)).toEqual(["hello"]);

		const entries = await api(`/api/sessions/${id}/entries`);
		expect(entries.map((e: any) => e.message?.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const runs = await api(`/api/sessions/${id}/runs`);
		expect(runs[0].runId).toBe(runId);
		expect(runs[0].tipId).toBe(entries.at(-1).id);
		expect(runs[0].fromTipId).toBeNull();
		const run = await api(`/api/runs/${runId}`);
		expect(run.outcome.status).toBe("completed");
		const trajectory = await api(`/api/runs/${runId}/trajectory?raw=1`);
		expect(trajectory.format).toBe("lily.traj/v1");
		expect(trajectory.tools[0].raw.output).toBe("from-api\n");
		const rawRef = trajectory.tools[0].rawRef;
		expect((await api(`/api/artifacts/${rawRef}`)).tool).toBe("bash");
		const md = await (await fetch(`${base}/api/runs/${runId}/markdown`)).text();
		expect(md).toContain("# Run");
		const sessions = await api("/api/sessions");
		expect(sessions[0].sessionId).toBe(id);
		const forked = await api(`/api/sessions/${id}/fork`, { method: "POST", body: JSON.stringify({}) });
		expect(forked.binding.parent.sessionId).toBe(id);
	});

	it("gives external orchestrators generic primitives: isolated sessions, labels, exec, workspace export, annotations", async () => {
		faux.setResponses([turn.tool("edit", { path: "calc.py", edits: [{ oldText: "return a - b", newText: "return a + b" }] }), turn.text("fixed")]);
		const repo = join(EXAMPLES, "tasks/python/calc-add/repo");
		const created = await api("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ mode: "batch", workspace: repo, backend: "local", bundle: null, labels: { task: "calc-add" }, budget: { maxTurns: 5 } }),
		});
		expect(created.binding.environment.spec.initialState).toEqual({ kind: "directory", path: repo });
		const id = created.sessionId;
		const { runId } = await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "Fix add in calc.py", labels: { attempt: "0" } }) });
		await readEvents(`/api/sessions/${id}/events?after=0`, (m) => m.event.type === "run_end");

		// The caller checks the result its own way, in the same environment, outside the agent's context.
		const check = await api(`/api/sessions/${id}/exec`, { method: "POST", body: JSON.stringify({ command: "python3 -c 'from calc import add; print(add(2, 3))'" }) });
		expect(check.exitCode).toBe(0);
		expect(check.output.trim()).toBe("5");
		const tgz = await fetch(`${base}/api/sessions/${id}/workspace`);
		expect(tgz.headers.get("content-type")).toBe("application/gzip");
		expect((await tgz.arrayBuffer()).byteLength).toBeGreaterThan(100);
		// The host directory was copied, never written.
		const { readFile } = await import("node:fs/promises");
		expect(await readFile(join(repo, "calc.py"), "utf8")).toContain("return a - b");

		// …and attaches whatever it computed to the run; exports carry it.
		await api(`/api/runs/${runId}/annotations/check`, { method: "PUT", body: JSON.stringify({ passed: true, score: 1 }) });
		const trajectory = await api(`/api/runs/${runId}/trajectory`);
		expect(trajectory.manifest.labels).toEqual({ task: "calc-add", attempt: "0" });
		expect(trajectory.manifest.budget.maxTurns).toBe(5);
		expect(trajectory.annotations).toEqual({ check: { passed: true, score: 1 } });
		const runs = await api(`/api/sessions/${id}/runs`);
		expect(runs[0].labels).toEqual({ task: "calc-add", attempt: "0" });
		const bad = await fetch(`${base}/api/runs/${runId}/annotations/..%2Fmanifest`, { method: "PUT", body: "{}" });
		expect(bad.status).toBe(400);
	});

	it("composes bundles component by component", async () => {
		const baseBundle = await api("/api/bundles/import", { method: "POST", body: JSON.stringify({ path: join(EXAMPLES, "bundles/base"), ref: "base" }) });
		const composed = await api("/api/bundles/compose", {
			method: "POST",
			body: JSON.stringify({ parts: { P: "base", U: "base", F: "base", M: "demo", S: "demo" }, ref: "mixed" }),
		});
		const demo = await api("/api/bundles/demo");
		expect(composed.componentDigests.S).toBe(demo.record.componentDigests.S);
		expect(composed.componentDigests.P).toBe(baseBundle.componentDigests.P);
		expect((await api("/api/bundles")).refs.mixed).toBe(composed.digest);
		const missing = await fetch(`${base}/api/bundles/compose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: { P: "base" } }) });
		expect(missing.status).toBe(400);
	});

	it("returns structured errors", async () => {
		const response = await fetch(`${base}/api/runs/run_nope`);
		expect(response.status).toBe(404);
		expect((await response.json()).error.message).toMatch(/Unknown run/);
		for (const path of ["/api/runs/run_nope/trajectory", "/api/runs/run_nope/markdown", "/api/sessions/01nope", "/api/bundles/demo/files/nope.md"]) {
			const r = await fetch(`${base}${path}`);
			expect(r.status, path).toBe(404);
			expect(await r.text(), path).not.toContain(runtime.home.root);
		}
	});

	it("rejects path parameters that could escape LILY_HOME", async () => {
		for (const [method, path] of [
			["GET", "/api/runs/..%2F..%2Fetc/trajectory"],
			["DELETE", "/api/sessions/..%2Fsession-meta"],
			["GET", "/api/runs/..%2Fconfig/annotations"],
			["GET", "/api/bundles/demo/files/..%2F..%2F..%2Fconfig.json"],
			["GET", "/api/sessions/..%5C..%5Cx"],
		] as const) {
			const r = await fetch(`${base}${path}`, { method });
			expect(r.status, path).toBe(400);
		}
		// Only files listed in the bundle index are readable.
		const manifest = await fetch(`${base}/api/bundles/demo/files/manifest.json`);
		expect(manifest.status).toBe(200);
	});

	it("answers 400 for prompting a busy session and steering an idle one", async () => {
		faux.setResponses([turn.tool("bash", { command: "sleep 5" }), turn.text("done")]);
		const { sessionId } = await api("/api/sessions", { method: "POST", body: JSON.stringify({ workspace: await sampleRepo(), backend: "local" }) });
		const post = (path: string, body: unknown) => fetch(`${base}/api/sessions/${sessionId}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const idle = await post("steer", { text: "hello?" });
		expect(idle.status).toBe(400);
		expect((await idle.json()).error.code).toBe("not_running");
		await api(`/api/sessions/${sessionId}/prompt`, { method: "POST", body: JSON.stringify({ text: "go" }) });
		const busy = await post("prompt", { text: "again" });
		expect(busy.status).toBe(400);
		expect((await busy.json()).error.code).toBe("session_busy");
		await api(`/api/sessions/${sessionId}/abort`, { method: "POST" });
	});

	it("creates bundle-less sessions on request and navigates to a user message like Pi's /tree", async () => {
		runtime.config.bundle = "demo";
		let sessionId: string;
		try {
			const workspace = await sampleRepo();
			const withDefault = await api("/api/sessions", { method: "POST", body: JSON.stringify({ workspace, backend: "local" }) });
			expect(withDefault.binding.bundle).toMatch(/^sha256:/);
			const bare = await api("/api/sessions", { method: "POST", body: JSON.stringify({ workspace, backend: "local", bundle: null }) });
			expect(bare.binding.bundle).toBeNull();
			sessionId = bare.sessionId;
		} finally {
			delete runtime.config.bundle;
		}
		faux.setResponses([turn.text("first"), turn.text("second")]);
		const session = await runtime.openSession(sessionId);
		await (await session.prompt("one")).done;
		await (await session.prompt("two")).done;
		const entries = await api(`/api/sessions/${sessionId}/entries`);
		expect(entries.map((e: any) => e.message.role)).toEqual(["user", "assistant", "user", "assistant"]);
		const moved = await api(`/api/sessions/${sessionId}/navigate`, { method: "POST", body: JSON.stringify({ targetId: entries[2].id }) });
		expect(moved.tipId).toBe(entries[1].id);
		expect(moved.editorText).toBe("two");
		const toRoot = await api(`/api/sessions/${sessionId}/navigate`, { method: "POST", body: JSON.stringify({ targetId: entries[0].id }) });
		expect(toRoot.tipId).toBeNull();
		expect(toRoot.editorText).toBe("one");
		const toAnswer = await api(`/api/sessions/${sessionId}/navigate`, { method: "POST", body: JSON.stringify({ targetId: entries[3].id }) });
		expect(toAnswer.tipId).toBe(entries[3].id);
		expect(toAnswer.editorText).toBeUndefined();
	});
});
