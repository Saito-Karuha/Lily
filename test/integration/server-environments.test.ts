import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import * as tar from "tar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalBackend } from "../../src/env/backends/local.ts";
import { LilyRuntime } from "../../src/runtime/runtime.ts";
import { createApi } from "../../src/server/api.ts";
import { createHttpServer } from "../../src/server/http.ts";
import { type RunManifest, RunStore } from "../../src/store/runs.ts";
import { tempDir } from "../helpers/env.ts";
import { turn } from "../helpers/runtime.ts";

let runtime: LilyRuntime;
let faux: ReturnType<typeof fauxProvider>;
let server: Server;
let restricted: Server;
let base: string;
let restrictedBase: string;
let allowed: string;

async function request(root: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
	const response = await fetch(`${root}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
	const text = await response.text();
	return { status: response.status, body: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
}

async function ok(path: string, init?: RequestInit, root = base): Promise<any> {
	const { status, body } = await request(root, path, init);
	if (status !== 200) throw new Error(`${status} ${JSON.stringify(body)}`);
	return body;
}

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
	const models = createModels();
	faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 4096 }] });
	models.setProvider(faux.provider);
	runtime = await LilyRuntime.create({
		home: await tempDir("lily-home-"),
		config: { model: "faux/faux-1", environment: { backend: "local" } },
		models,
		backends: [new LocalBackend()],
		maxConcurrentEnvironments: 2,
		whenEnvironmentsFull: "reject",
	});
	allowed = await tempDir("lily-allowed-");
	server = createHttpServer({ router: createApi(runtime) });
	restricted = createHttpServer({ router: createApi(runtime, { allowedRoots: [allowed] }) });
	for (const s of [server, restricted]) await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	restrictedBase = `http://127.0.0.1:${(restricted.address() as AddressInfo).port}`;
});

afterAll(async () => {
	server?.close();
	restricted?.close();
	await runtime?.close();
});

describe("HTTP sessions with a full environment spec", () => {
	it("creates the same session as the SDK from an EnvironmentSpec", async () => {
		const repo = join(allowed, "repo");
		await mkdir(join(repo, "skip"), { recursive: true });
		await writeFile(join(repo, "a.txt"), "hello\n");
		await writeFile(join(repo, "skip", "x"), "x");
		const environment = {
			backend: "local",
			initialState: { kind: "directory", path: repo, exclude: ["skip"] },
			limits: { cpus: 1, memoryMb: 512, pids: 64 },
			env: { TASK_ID: "t-1" },
			label: "t-1",
		};
		const created = await ok("/api/sessions", post({ mode: "batch", bundle: null, environment, labels: { task: "t-1" } }));
		const sdk = await runtime.createSession({ mode: "batch", model: "faux/faux-1", bundle: null, environment: environment as never, labels: { task: "t-1" }, workspaceLabel: repo });
		expect(created.binding.environment.spec).toEqual(sdk.binding.environment.spec);
		expect(created.binding.workspaceLabel).toBe(repo);

		const manifests: RunManifest[] = [];
		for (const id of [created.sessionId, sdk.id]) {
			faux.setResponses([turn.tool("bash", { command: "cat a.txt; ls; echo $TASK_ID" }), turn.text("ok")]);
			const session = await runtime.openSession(id);
			const handle = await session.prompt("inspect");
			await handle.done;
			const store = new RunStore(runtime.home.run(handle.runId));
			manifests.push(await store.readManifest());
			const tools = await store.tools.readAll();
			expect((await runtime.artifacts.getJson<{ output: string }>(tools[0]!.rawRef)).output).toBe("hello\na.txt\nt-1\n");
			await session.releaseEnvironment();
		}
		const comparable = (m: RunManifest) => ({
			kernel: m.kernel,
			model: m.model,
			bundle: m.bundle,
			processorId: m.processorId,
			labels: m.labels,
			environment: { backend: m.environment.backend, isolation: m.environment.isolation, limits: m.environment.limits, initialState: m.environment.initialState, label: m.environment.label },
			blocks: m.systemPrompt.blocks.map((b) => b.kind),
		});
		expect(comparable(manifests[0]!)).toEqual(comparable(manifests[1]!));
		expect(manifests[0]!.environment.startupMs).toBeGreaterThanOrEqual(0);
	});

	it("validates specs and keeps host paths inside the allowed roots", async () => {
		const outside = await tempDir("lily-outside-");
		await writeFile(join(outside, "secret.txt"), "no");
		for (const [environment, status] of [
			[{ initialState: { kind: "tarball" } }, 400],
			[{ initialState: { kind: "directory" } }, 400],
			[{ limits: { cpus: -1 } }, 400],
			[{ limits: { network: "open" } }, 400],
			[{ env: { "BAD-NAME": "x" } }, 400],
			[{ nope: true }, 400],
			[{ initialState: { kind: "directory", path: join(allowed, "missing") } }, 400],
		] as const) {
			const r = await request(base, "/api/sessions", post({ mode: "batch", environment }));
			expect(r.status, JSON.stringify(environment)).toBe(status);
		}
		expect((await request(base, "/api/sessions", post({ environment: {}, workspace: allowed }))).status).toBe(400);

		// Restricted server: inside is fine, outside (directly or through a symlink) is forbidden.
		expect((await request(restrictedBase, "/api/sessions", post({ mode: "batch", environment: { initialState: { kind: "directory", path: allowed } } }))).status).toBe(200);
		await symlink(outside, join(allowed, "escape"));
		for (const path of [outside, join(allowed, "escape"), join(allowed, "..")]) {
			const r = await request(restrictedBase, "/api/sessions", post({ mode: "batch", environment: { initialState: { kind: "directory", path } } }));
			expect(r.status, path).toBe(403);
			expect(r.body.error.code).toBe("forbidden_path");
		}
		expect((await request(restrictedBase, "/api/sessions", post({ workspace: outside }))).status).toBe(403);
		expect((await request(restrictedBase, "/api/bundles/import", post({ path: outside }))).status).toBe(403);
		// The unrestricted server accepts any existing path.
		expect((await request(base, "/api/sessions", post({ mode: "batch", environment: { initialState: { kind: "directory", path: outside } } }))).status).toBe(200);
	});

	it("reports capacity and refuses environments beyond it", async () => {
		const status = await ok("/api/status");
		expect(status.capacity.environments).toMatchObject({ max: 2, whenFull: "reject" });
		const live = status.capacity.environments.live as number;
		const sessions: string[] = [];
		for (let i = live; i < 2; i++) {
			const created = await ok("/api/sessions", post({ mode: "batch", prepare: true }));
			expect(created.environment.envId).toMatch(/^env_/);
			sessions.push(created.sessionId);
		}
		expect((await ok("/api/status")).capacity.environments).toMatchObject({ live: 2, free: 0 });
		const refused = await request(base, "/api/sessions", post({ mode: "batch", prepare: true }));
		expect(refused.status).toBe(503);
		expect(refused.body.error.code).toBe("capacity_exhausted");
		expect(refused.body.error.details.capacity.max).toBe(2);
		// A session created without preparing fails at its first prompt instead, and records no run.
		const lazy = await ok("/api/sessions", post({ mode: "batch" }));
		const prompt = await request(base, `/api/sessions/${lazy.sessionId}/prompt`, post({ text: "hi" }));
		expect(prompt.status).toBe(503);
		expect(await ok(`/api/sessions/${lazy.sessionId}/runs`)).toEqual([]);
		// Releasing an environment frees its slot; the session stays usable.
		expect(await ok(`/api/sessions/${sessions[0]}/environment`, { method: "DELETE" })).toEqual({ released: true });
		expect((await ok("/api/status")).capacity.environments.free).toBe(1);
		expect((await request(base, `/api/sessions/${sessions[0]}/environment`)).status).toBe(404);
		faux.setResponses([turn.text("fine")]);
		const run = await ok(`/api/sessions/${lazy.sessionId}/prompt`, post({ text: "hi" }));
		const session = await runtime.openSession(lazy.sessionId);
		await session.idle();
		expect((await new RunStore(runtime.home.run(run.runId)).readOutcome())?.status).toBe("completed");
		for (const id of [...sessions, lazy.sessionId]) await ok(`/api/sessions/${id}/environment`, { method: "DELETE" });
	});

	it("moves files in and out of a live environment between runs, outside any run", async () => {
		const { sessionId } = await ok("/api/sessions", post({ mode: "batch" }));
		const put = await ok(`/api/sessions/${sessionId}/files?path=hidden/test_check.py&mode=755`, { method: "PUT", body: "print('checked')\n", headers: { "content-type": "application/octet-stream" } });
		expect(put.bytes).toBe(17);
		const exec = await ok(`/api/sessions/${sessionId}/exec`, post({ command: "python3 hidden/test_check.py && test -x hidden/test_check.py && echo exec-ok" }));
		expect(exec.output).toBe("checked\nexec-ok\n");
		const got = await fetch(`${base}/api/sessions/${sessionId}/files?path=hidden/test_check.py`);
		expect(await got.text()).toBe("print('checked')\n");
		expect((await request(base, `/api/sessions/${sessionId}/files?path=nope.txt`)).status).toBe(404);

		const src = await tempDir();
		await mkdir(join(src, "tests"));
		await writeFile(join(src, "tests", "t.txt"), "from tar\n");
		const archive = join(src, "up.tgz");
		await tar.c({ gzip: true, cwd: src, file: archive, portable: true }, ["tests"]);
		const uploaded = await ok(`/api/sessions/${sessionId}/upload?root=incoming`, { method: "POST", body: await readFile(archive), headers: { "content-type": "application/gzip" } });
		expect(uploaded.files).toBeGreaterThan(0);
		expect((await ok(`/api/sessions/${sessionId}/exec`, post({ command: "cat incoming/tests/t.txt" }))).output).toBe("from tar\n");
		const down = await fetch(`${base}/api/sessions/${sessionId}/download?path=incoming`);
		expect(down.headers.get("content-type")).toBe("application/gzip");
		const dir = await tempDir();
		await writeFile(join(dir, "d.tgz"), Buffer.from(await down.arrayBuffer()));
		await tar.x({ file: join(dir, "d.tgz"), cwd: dir });
		expect(await readFile(join(dir, "tests", "t.txt"), "utf8")).toBe("from tar\n");

		// A run in the same environment sees the files, and its records contain none of these operations.
		faux.setResponses([turn.tool("bash", { command: "ls hidden incoming" }), turn.text("seen")]);
		const { runId } = await ok(`/api/sessions/${sessionId}/prompt`, post({ text: "look" }));
		await (await runtime.openSession(sessionId)).idle();
		const tools = await new RunStore(runtime.home.run(runId)).tools.readAll();
		expect(tools.map((t) => t.toolName)).toEqual(["bash"]);
		expect((await runtime.artifacts.getJson<{ output: string }>(tools[0]!.rawRef)).output).toContain("test_check.py");
		await ok(`/api/sessions/${sessionId}/environment`, { method: "DELETE" });
	});

	it("refuses file transfers during a run", async () => {
		const { sessionId } = await ok("/api/sessions", post({ mode: "batch" }));
		faux.setResponses([turn.tool("bash", { command: "sleep 3" }), turn.text("done")]);
		await ok(`/api/sessions/${sessionId}/prompt`, post({ text: "wait" }));
		const busy = await request(base, `/api/sessions/${sessionId}/files?path=x.txt`, { method: "PUT", body: "x" });
		expect(busy.status).toBe(400);
		expect(busy.body.error.code).toBe("session_busy");
		await ok(`/api/sessions/${sessionId}/abort`, { method: "POST" });
		await ok(`/api/sessions/${sessionId}/environment`, { method: "DELETE" });
	});

	it("rejects an image initial state on a backend without images", async () => {
		const r = await request(base, "/api/sessions", post({ mode: "batch", environment: { initialState: { kind: "image" } }, prepare: true }));
		expect(r.status).toBe(400);
		expect(r.body.error.code).toBe("invalid_environment");
		expect(r.body.error.message).toMatch(/no image/);
	});
});
