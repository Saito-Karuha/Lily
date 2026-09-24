import { resolve } from "node:path";
import type { ServerResponse } from "node:http";
import { COMPONENTS, type Component } from "../resources/bundle.ts";
import type { LilyRuntime } from "../runtime/runtime.ts";
import { readBinding } from "../runtime/session.ts";
import { listRunIds, RunStore } from "../store/runs.ts";
import { exportRun } from "../trajectory/export.ts";
import { renderTrajectoryMarkdown } from "../trajectory/render-md.ts";
import { HANDLED, HttpError, Router } from "./http.ts";

export const LILY_VERSION = "0.1.0";

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, `${name} is required`);
	return value;
}

function optionalLabels(value: unknown): Record<string, string> | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value) || Object.values(value).some((v) => typeof v !== "string")) {
		throw new HttpError(400, "labels must be an object of strings");
	}
	return value as Record<string, string>;
}

function optionalBudget(value: unknown): { maxTurns?: number; timeoutMs?: number } | undefined {
	if (value === undefined || value === null) return undefined;
	const budget = value as { maxTurns?: unknown; timeoutMs?: unknown };
	for (const key of ["maxTurns", "timeoutMs"] as const) {
		const v = budget[key];
		if (v !== undefined && (typeof v !== "number" || !(v > 0))) throw new HttpError(400, `budget.${key} must be a positive number`);
	}
	return budget as { maxTurns?: number; timeoutMs?: number };
}

/** Opens a run's store, or answers 404 when no run with that id was ever pinned. */
async function existingRun(runtime: LilyRuntime, runId: string): Promise<RunStore> {
	const store = new RunStore(runtime.home.run(runId));
	if (!(await store.readManifest().then(() => true, () => false))) throw new HttpError(404, "Unknown run");
	return store;
}

async function runSummary(runtime: LilyRuntime, runId: string) {
	const store = new RunStore(runtime.home.run(runId));
	const manifest = await store.readManifest().catch(() => undefined);
	if (!manifest) return undefined;
	const outcome = await store.readOutcome();
	return {
		runId,
		sessionId: manifest.sessionId,
		createdAt: manifest.createdAt,
		mode: manifest.mode,
		prompt: manifest.prompt.text.slice(0, 200),
		model: `${manifest.model.provider}/${manifest.model.modelId}`,
		bundle: manifest.bundle ? { digest: manifest.bundle.digest, name: manifest.bundle.name } : null,
		routedBy: manifest.route?.router ?? null,
		labels: manifest.labels ?? {},
		backend: manifest.environment.backend,
		isolation: manifest.environment.isolation,
		status: outcome?.status ?? "running",
		reason: outcome?.reason,
		turns: outcome?.turns,
		toolCalls: outcome?.toolCalls,
		usage: outcome?.usage,
		endedAt: outcome?.endedAt,
		fromTipId: outcome?.fromTipId ?? null,
		tipId: outcome?.tipId ?? null,
	};
}

/** Writes a session's events as Server-Sent Events: persisted events after the cursor, then live. */
async function streamEvents(runtime: LilyRuntime, sessionId: string, after: number, res: ServerResponse): Promise<void> {
	const session = await runtime.openSession(sessionId);
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	const write = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
	const buffered: unknown[] = [];
	let replaying = true;
	const unsubscribe = session.events.subscribe((event) => {
		if (replaying) buffered.push(event);
		else write(event);
	});
	let lastSeq = after;
	for (const event of await session.events.read(after)) {
		write(event);
		lastSeq = event.seq;
	}
	for (const event of buffered as Array<{ seq: number }>) {
		if (event.seq === -1 || event.seq > lastSeq) write(event);
	}
	replaying = false;
	write({ seq: -1, at: Date.now(), event: { type: "hello", sessionId, lastSeq: session.events.lastSeq, busy: session.busy, activeRunId: session.activeRunId ?? null } });
	const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
	res.on("close", () => {
		clearInterval(heartbeat);
		unsubscribe();
	});
}

/**
 * Lily's language-neutral control surface: sessions and runs, their event
 * streams, recorded trajectories, environments and resource bundles. It carries
 * no knowledge of datasets, rewards or training — callers build those on top.
 */
export function createApi(runtime: LilyRuntime): Router {
	const router = new Router();

	router.get("/api/status", async () => ({
		version: LILY_VERSION,
		home: runtime.home.root,
		defaultModel: runtime.config.model ?? null,
		defaultBundle: runtime.config.bundle ?? null,
		router: runtime.router?.name ?? null,
		openSessions: runtime.openSessions().length,
		liveEnvironments: runtime.envs.live().length,
	}));

	router.get("/api/models", async (ctx) => {
		const available = ctx.query.get("available") === "1";
		const models = available ? await runtime.models.getAvailable() : runtime.models.getModels();
		return models.map((m) => ({ provider: m.provider, id: m.id, name: m.name, api: m.api, contextWindow: m.contextWindow, reasoning: m.reasoning }));
	});

	router.get("/api/environments", async () => ({
		backends: await Promise.all(
			runtime.envs.backends().map(async (b) => ({ name: b.name, isolation: b.isolation, ...(await b.probe()) })),
		),
		live: runtime.envs.live().map((lease) => lease.info),
	}));

	// Sessions
	router.get("/api/sessions", async (ctx) => {
		const mode = ctx.query.get("mode");
		return runtime.listSessions(mode === "interactive" || mode === "batch" ? { mode } : undefined);
	});

	router.post("/api/sessions", async (ctx) => {
		const body = (await ctx.body()) as {
			workspace?: string;
			mode?: "interactive" | "batch";
			model?: string;
			bundle?: string | null;
			backend?: string;
			title?: string;
			labels?: unknown;
			budget?: unknown;
		};
		const mode = body.mode ?? "interactive";
		if (mode !== "interactive" && mode !== "batch") throw new HttpError(400, `mode must be "interactive" or "batch"`);
		const workspace = body.workspace ? resolve(body.workspace) : undefined;
		// interactive: the host directory is the workspace (mounted where the backend can);
		// batch: a fresh environment starts from a copy of it (or empty), the host is never written.
		const environment =
			mode === "interactive"
				? runtime.defaultEnvironment(requireString(workspace, "workspace"), body.backend)
				: runtime.isolatedEnvironment(workspace ? { kind: "directory", path: workspace } : { kind: "empty" }, body.backend);
		const labels = optionalLabels(body.labels);
		const budget = optionalBudget(body.budget);
		const session = await runtime.createSession({
			mode,
			model: body.model ?? requireString(runtime.config.model, "model (no default model configured)"),
			// An explicit null means "no bundle"; only a missing field falls back to the default.
			bundle: body.bundle !== undefined ? body.bundle : (runtime.config.bundle ?? null),
			environment,
			...(workspace ? { workspaceLabel: workspace } : {}),
			...(body.title ? { title: body.title } : {}),
			...(labels ? { labels } : {}),
			...(budget ? { budget } : {}),
		});
		return { sessionId: session.id, binding: session.binding };
	});

	router.get("/api/sessions/:id", async (ctx) => {
		const session = await runtime.openSession(ctx.params.id!);
		return {
			binding: session.binding,
			tipId: await session.tipId(),
			busy: session.busy,
			activeRunId: session.activeRunId ?? null,
			environment: session.lease?.info ?? null,
			lastSeq: session.events.lastSeq,
		};
	});

	router.patch("/api/sessions/:id", async (ctx) => {
		const session = await runtime.openSession(ctx.params.id!);
		const body = (await ctx.body()) as Record<string, string | null | undefined>;
		if (typeof body.model === "string") await session.setModel(body.model);
		if (body.bundle !== undefined) await session.setBundle(body.bundle);
		if (typeof body.thinking === "string") await session.setThinking(body.thinking as never);
		return session.binding;
	});

	router.delete("/api/sessions/:id", async (ctx) => {
		await runtime.deleteSession(ctx.params.id!);
		return { ok: true };
	});

	router.get("/api/sessions/:id/entries", async (ctx) => {
		const session = await runtime.openSession(ctx.params.id!);
		return ctx.query.get("scope") === "tree" ? session.allEntries() : session.branchEntries();
	});

	router.get("/api/sessions/:id/events", async (ctx) => {
		await streamEvents(runtime, ctx.params.id!, Number(ctx.query.get("after") ?? 0) || 0, ctx.res);
		return HANDLED;
	});

	router.post("/api/sessions/:id/prompt", async (ctx) => {
		const session = await runtime.openSession(ctx.params.id!);
		const body = (await ctx.body()) as { text?: string; labels?: unknown; budget?: unknown };
		const labels = optionalLabels(body.labels);
		const budget = optionalBudget(body.budget);
		const handle = await session.prompt(requireString(body.text, "text"), { ...(labels ? { labels } : {}), ...(budget ? { budget } : {}) });
		void handle.done.catch(() => {});
		return { runId: handle.runId };
	});

	router.post("/api/sessions/:id/abort", async (ctx) => {
		const session = await runtime.openSession(ctx.params.id!);
		await session.abort();
		return { ok: true };
	});

	router.post("/api/sessions/:id/steer", async (ctx) => {
		const session = await runtime.openSession(ctx.params.id!);
		const body = (await ctx.body()) as { text?: string };
		await session.steer(requireString(body.text, "text"));
		return { ok: true };
	});

	router.post("/api/sessions/:id/compact", async (ctx) => {
		const session = await runtime.openSession(ctx.params.id!);
		const body = (await ctx.body()) as { instructions?: string };
		return session.compact(body.instructions);
	});

	router.post("/api/sessions/:id/navigate", async (ctx) => {
		const session = await runtime.openSession(ctx.params.id!);
		const body = (await ctx.body()) as { targetId?: string | null; summarize?: boolean; customInstructions?: string };
		return session.navigate(body.targetId ?? null, {
			summarize: Boolean(body.summarize),
			...(typeof body.customInstructions === "string" ? { customInstructions: body.customInstructions } : {}),
		});
	});

	router.post("/api/sessions/:id/fork", async (ctx) => {
		const body = (await ctx.body()) as { entryId?: string; position?: "before" | "at"; workspace?: "initial" | "current" };
		const forked = await runtime.forkSession(ctx.params.id!, body);
		return { sessionId: forked.id, binding: forked.binding };
	});

	router.post("/api/sessions/:id/exec", async (ctx) => {
		const session = await runtime.openSession(ctx.params.id!);
		const body = (await ctx.body()) as { command?: string; timeoutMs?: number; cwd?: string };
		return session.exec(requireString(body.command, "command"), {
			...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {}),
			...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
		});
	});

	router.get("/api/sessions/:id/workspace", async (ctx) => {
		const session = await runtime.openSession(ctx.params.id!);
		const archive = await session.exportWorkspace();
		ctx.res.writeHead(200, { "content-type": "application/gzip", "content-disposition": `attachment; filename="workspace-${session.id}.tgz"` });
		ctx.res.end(archive);
		return HANDLED;
	});

	router.get("/api/sessions/:id/runs", async (ctx) => {
		const binding = await readBinding(runtime.home, ctx.params.id!);
		if (!binding) throw new HttpError(404, "Unknown session");
		const runs = await Promise.all(binding.runs.map((id) => runSummary(runtime, id)));
		return runs.filter(Boolean);
	});

	// Runs & trajectories
	router.get("/api/runs", async (ctx) => {
		const limit = Math.min(Number(ctx.query.get("limit") ?? 100) || 100, 1000);
		const ids = (await listRunIds(runtime.home.runs)).slice(0, limit);
		return (await Promise.all(ids.map((id) => runSummary(runtime, id)))).filter(Boolean);
	});

	router.get("/api/runs/:id", async (ctx) => {
		const store = await existingRun(runtime, ctx.params.id!);
		return { manifest: await store.readManifest(), outcome: (await store.readOutcome()) ?? null, annotations: await store.readAnnotations() };
	});

	router.get("/api/runs/:id/trajectory", async (ctx) => {
		const store = await existingRun(runtime, ctx.params.id!);
		return exportRun(store, runtime.artifacts, { includeRaw: ctx.query.get("raw") === "1", includePayloads: ctx.query.get("payloads") === "1" });
	});

	router.get("/api/runs/:id/markdown", async (ctx) => {
		const trajectory = await exportRun(await existingRun(runtime, ctx.params.id!), runtime.artifacts);
		ctx.res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
		ctx.res.end(renderTrajectoryMarkdown(trajectory));
		return HANDLED;
	});

	router.get("/api/runs/:id/annotations", async (ctx) => (await existingRun(runtime, ctx.params.id!)).readAnnotations());

	router.put("/api/runs/:id/annotations/:name", async (ctx) => {
		const store = await existingRun(runtime, ctx.params.id!);
		await store.annotate(ctx.params.name!, await ctx.body());
		return { ok: true };
	});

	router.get("/api/artifacts/:digest", async (ctx) => {
		const data = await runtime.artifacts.get(ctx.params.digest!).catch(() => {
			throw new HttpError(404, "Unknown artifact");
		});
		const text = data.toString("utf8");
		const isJson = text.startsWith("{") || text.startsWith("[");
		ctx.res.writeHead(200, { "content-type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8" });
		ctx.res.end(data);
		return HANDLED;
	});

	// Bundles
	router.get("/api/bundles", async () => ({ bundles: await runtime.registry.list(), refs: await runtime.registry.refs() }));

	router.post("/api/bundles/import", async (ctx) => {
		const body = (await ctx.body()) as { path?: string; ref?: string; parents?: string[]; data?: Record<string, unknown> };
		const dir = resolve(requireString(body.path, "path"));
		const parents = await Promise.all((body.parents ?? []).map((p) => runtime.registry.resolve(p)));
		const record = await runtime.registry.importDirectory(
			dir,
			parents.length || body.data ? { kind: "derived", parents, ...(body.data ? { data: body.data } : {}) } : { kind: "import", source: dir },
		);
		if (body.ref) await runtime.registry.setRef(body.ref, record.digest);
		return record;
	});

	router.post("/api/bundles/compose", async (ctx) => {
		const body = (await ctx.body()) as { parts?: Partial<Record<Component, string>>; name?: string; ref?: string };
		const parts = body.parts ?? {};
		for (const c of COMPONENTS) requireString(parts[c], `parts.${c}`);
		const record = await runtime.registry.compose(parts as Record<Component, string>, body.name);
		if (body.ref) await runtime.registry.setRef(body.ref, record.digest);
		return record;
	});

	router.put("/api/refs/:name", async (ctx) => {
		const body = (await ctx.body()) as { target?: string };
		return { name: ctx.params.name, digest: await runtime.registry.setRef(ctx.params.name!, requireString(body.target, "target")) };
	});

	router.get("/api/bundles/:ref", async (ctx) => {
		const record = await runtime.registry.get(ctx.params.ref!).catch((e: Error) => {
			throw new HttpError(404, e.message);
		});
		return {
			record,
			lineage: (await runtime.registry.lineage(record.digest)).map((r) => ({ digest: r.digest, name: r.manifest.name, origin: r.origin, createdAt: r.createdAt })),
		};
	});

	router.get("/api/bundles/:ref/files/*", async (ctx) => {
		const text = await runtime.registry.readText(ctx.params.ref!, ctx.params.rest!).catch((e: Error) => {
			throw new HttpError(404, e.message);
		});
		if (text === undefined) throw new HttpError(404, "No such file in bundle");
		ctx.res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		ctx.res.end(text);
		return HANDLED;
	});

	router.get("/api/bundles/:from/diff/:to", async (ctx) => runtime.registry.diff(ctx.params.from!, ctx.params.to!));

	return router;
}
