import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { packageRoot } from "../env/envd-binary.ts";
import { type LilyConfig, loadConfig, saveConfig } from "../models/config.ts";
import { registerScriptedProvider } from "../models/registry.ts";
import { COMPONENT_DIRS, COMPONENTS, type Component } from "../resources/bundle.ts";
import { renderResources } from "../resources/render.ts";
import { loadRouter, ROUTED_BUNDLE } from "../resources/router.ts";
import { LilyRuntime } from "../runtime/runtime.ts";
import type { LilySession } from "../runtime/session.ts";
import { createApi, LILY_VERSION } from "../server/api.ts";
import { createHttpServer } from "../server/http.ts";
import { LilyHome } from "../store/home.ts";
import { listRunIds, RunStore } from "../store/runs.ts";
import { exportRun } from "../trajectory/export.ts";
import { renderTrajectoryMarkdown } from "../trajectory/render-md.ts";
import { writeJsonAtomic } from "../util/fsx.ts";
import { shortDigest } from "../util/hash.ts";
import { c, LILY_MARK } from "./theme.ts";
import { runInteractive } from "./tui/launch.ts";

const HELP = `${c.leaf(LILY_MARK)} ${c.bold("lily")} ${c.muted(`v${LILY_VERSION}`)} — a coding agent harness

${c.bold("Usage")}
  lily [prompt]                     interactive session in the current directory
  lily -p "<prompt>"                run once and print the answer (-p - reads stdin)
  lily -p "<prompt>" --json         run once and stream every event as JSON lines
  lily -c | --continue              continue the latest session for this directory
  lily -r | --resume <session>      resume a session (id or suffix)

${c.bold("Commands")}
  init                              import the example bundles and write a config
  sessions [--all]                  list sessions
  runs                              list recent runs
  show <run>                        print a run as markdown
  export <run> [-o file] [--raw] [--payloads]   export a run (lily.traj/v1)
  annotate <run> <name> <json>      attach data (a score, a review, …) to a run
  bundle import <dir> [--ref name] [--parent ref]…   publish a resource bundle
  bundle list | show <ref> | diff <a> <b> | ref <name> <target> | checkout <ref> <dir>
  bundle compose --from <ref> [--part C=<ref>]…      take component C (P M S U F) from another bundle
  env [backends] | sweep            execution environments
  doctor                            check the installation (node, models, bundles, backends)
  models [--all]                    list models
  serve [--port 7777] [--host h]    local HTTP API (see docs/api.md)
  config [key [value]]              read or change ~/.lily/config.json

${c.bold("Options")}
  --model <provider/id>   --thinking <level>   --backend <name>
  --bundle <ref|none|@router>   --router <module>   --label key=value (repeatable)
  --copy                  run in a fresh environment on a copy of the directory (the directory is never written)
  --home <dir> (default ~/.lily or $LILY_HOME)   --script <file|demo> (offline scripted model; demo = the bundled one)
`;

interface GlobalOptions {
	home?: string;
	model?: string;
	bundle?: string;
	backend?: string;
	thinking?: string;
	script?: string;
	router?: string;
	labels?: Record<string, string>;
	copy?: boolean;
	json?: boolean;
}

function fail(message: string): never {
	process.stderr.write(`${c.error("error")} ${message}\n`);
	process.exit(1);
}

const SCRIPT_MODEL = "scripted/script";

/** `--script demo` names the offline script shipped with the package. */
function scriptPath(script: string): string {
	return script === "demo" && !existsSync(resolve(script)) ? join(packageRoot(), "examples", "scripts", "chat.json") : resolve(script);
}

async function makeRuntime(options: GlobalOptions): Promise<LilyRuntime> {
	const config = await loadConfig(new LilyHome(options.home));
	// With --script the scripted model is the default everywhere (CLI, API) for this process only.
	if (options.script) config.model = SCRIPT_MODEL;
	const router = options.router ? await loadRouter(options.router) : undefined;
	const runtime = await LilyRuntime.create({ ...(options.home ? { home: options.home } : {}), config, ...(router ? { router } : {}) });
	if (options.script) await registerScriptedProvider(runtime.models, "script", scriptPath(options.script));
	return runtime;
}

function resolveModel(runtime: LilyRuntime, options: GlobalOptions): string {
	if (options.script) return SCRIPT_MODEL;
	const model = options.model ?? runtime.config.model;
	if (!model) fail("No model configured. Pass --model provider/model-id or run: lily config model <provider/model-id>");
	return model;
}

function resolveBundle(runtime: LilyRuntime, options: GlobalOptions): string | null {
	if (options.bundle === "none") return null;
	const bundle = options.bundle ?? runtime.config.bundle ?? null;
	if (bundle === ROUTED_BUNDLE && !runtime.router) fail("--bundle @router needs a router: pass --router <module> or set \"router\" in config.json");
	return bundle;
}

function parseLabels(values: unknown): Record<string, string> | undefined {
	const list = Array.isArray(values) ? values : typeof values === "string" ? [values] : [];
	if (list.length === 0) return undefined;
	const labels: Record<string, string> = {};
	for (const item of list) {
		const eq = String(item).indexOf("=");
		if (eq <= 0) fail(`--label expects key=value, got ${item}`);
		labels[String(item).slice(0, eq)] = String(item).slice(eq + 1);
	}
	return labels;
}

async function startSession(runtime: LilyRuntime, options: GlobalOptions, cwd: string): Promise<LilySession> {
	return runtime.createSession({
		mode: options.copy ? "batch" : "interactive",
		model: resolveModel(runtime, options),
		...(options.thinking ? { thinking: options.thinking as ThinkingLevel } : runtime.config.thinking ? { thinking: runtime.config.thinking } : {}),
		bundle: resolveBundle(runtime, options),
		environment: options.copy
			? runtime.isolatedEnvironment({ kind: "directory", path: cwd }, options.backend)
			: runtime.defaultEnvironment(cwd, options.backend),
		workspaceLabel: cwd,
		...(options.labels ? { labels: options.labels } : {}),
	});
}

async function findSession(runtime: LilyRuntime, ref: string): Promise<string> {
	const sessions = await runtime.listSessions();
	const matches = sessions.filter((s) => s.sessionId === ref || s.sessionId.endsWith(ref));
	if (matches.length === 0) fail(`No session matching ${ref}`);
	if (matches.length > 1) fail(`Ambiguous session ${ref}`);
	return matches[0]!.sessionId;
}

async function findRun(runtime: LilyRuntime, ref: string): Promise<string> {
	const ids = await listRunIds(runtime.home.runs);
	const matches = ids.filter((id) => id === ref || id.endsWith(ref));
	if (matches.length !== 1) fail(matches.length === 0 ? `No run matching ${ref}` : `Ambiguous run ${ref}`);
	return matches[0]!;
}

/**
 * Runs one prompt without the TUI. Text mode streams the answer to stdout and
 * progress to stderr; `json` mode writes every session event (including
 * streaming deltas) to stdout as one JSON object per line, ending with run_end.
 */
async function printMode(runtime: LilyRuntime, session: LilySession, prompt: string, options: { json?: boolean } = {}): Promise<number> {
	let streamed = false;
	const unsubscribe = session.events.subscribe((record) => {
		const { event } = record;
		if (options.json) {
			process.stdout.write(`${JSON.stringify(record)}\n`);
			return;
		}
		if (event.type === "message_delta" && event.kind === "text") {
			process.stdout.write(event.delta);
			streamed = true;
		} else if (event.type === "message_end" && streamed) {
			process.stdout.write("\n");
			streamed = false;
		} else if (event.type === "tool_start") {
			process.stderr.write(c.muted(`● ${event.toolName} ${JSON.stringify(event.args).slice(0, 160)}\n`));
		} else if (event.type === "tool_end" && event.isError) {
			process.stderr.write(c.warn(`  ✗ ${(event.content[0]?.text ?? "").split("\n").slice(-1)[0]}\n`));
		} else if (event.type === "notice") {
			process.stderr.write(`${c.muted(event.message)}\n`);
		}
	});
	const handle = await session.prompt(prompt);
	const outcome = await handle.done;
	unsubscribe();
	if (!options.json && outcome.status !== "completed") {
		process.stderr.write(c.error(`run ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}${outcome.error ? `: ${outcome.error}` : ""}\n`));
	}
	await runtime.close();
	return outcome.status === "completed" ? 0 : 1;
}

async function commandBundle(runtime: LilyRuntime, args: string[], values: Record<string, unknown>): Promise<void> {
	const [sub, ...rest] = args;
	const registry = runtime.registry;
	const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : []);
	switch (sub) {
		case "import": {
			const dir = resolve(rest[0] ?? fail("bundle import <dir>"));
			const parents = await Promise.all(list(values.parent).map((p) => registry.resolve(p)));
			const record = await registry.importDirectory(dir, parents.length ? { kind: "derived", parents } : { kind: "import", source: dir });
			if (typeof values.ref === "string") await registry.setRef(values.ref, record.digest);
			console.log(`${c.leaf("published")} ${record.manifest.name} ${record.digest}${values.ref ? ` as ${values.ref}` : ""}`);
			for (const warning of record.warnings) console.log(c.warn(`warning: ${warning}`));
			return;
		}
		case "list": {
			const refs = await registry.refs();
			const byDigest = new Map<string, string[]>();
			for (const [name, digest] of Object.entries(refs)) byDigest.set(digest, [...(byDigest.get(digest) ?? []), name]);
			for (const record of await registry.list()) {
				const names = byDigest.get(record.digest);
				console.log(`${c.leaf(shortDigest(record.digest))}  ${c.cream(record.manifest.name.padEnd(24))} ${c.muted(record.origin.kind.padEnd(9))} ${names ? c.sun(names.join(",")) : ""}`);
			}
			return;
		}
		case "show": {
			const record = await registry.get(rest[0] ?? fail("bundle show <ref>"));
			console.log(`${c.bold(record.manifest.name)} ${record.digest}\n${c.muted(record.manifest.description ?? "")}`);
			for (const component of COMPONENTS) {
				const files = record.files.filter((f) => f.path.startsWith(`${COMPONENT_DIRS[component]}/`)).length;
				console.log(`  ${component} ${shortDigest(record.componentDigests[component])}  ${files} files`);
			}
			const rendered = await renderResources(await registry.path(record.digest), record, "/opt/lily/resources");
			if (rendered.skills.length) console.log(`skills: ${rendered.skills.map((s) => s.name).join(", ")}`);
			return;
		}
		case "diff": {
			for (const change of await registry.diff(rest[0] ?? fail("bundle diff <a> <b>"), rest[1] ?? fail("bundle diff <a> <b>"))) {
				const mark = change.action === "add" ? c.leaf("+") : change.action === "delete" ? c.error("-") : c.sun("~");
				console.log(`${mark} ${change.component} ${change.path}`);
			}
			return;
		}
		case "ref": {
			const digest = await registry.setRef(rest[0] ?? fail("bundle ref <name> <target>"), rest[1] ?? fail("bundle ref <name> <target>"));
			console.log(`${rest[0]} → ${digest}`);
			return;
		}
		case "checkout": {
			await registry.checkout(rest[0] ?? fail("bundle checkout <ref> <dir>"), resolve(rest[1] ?? fail("bundle checkout <ref> <dir>")));
			console.log(`checked out into ${rest[1]}`);
			return;
		}
		case "compose": {
			const from = typeof values.from === "string" ? values.from : fail("bundle compose --from <ref> [--part C=<ref>]…");
			const parts = Object.fromEntries(COMPONENTS.map((component) => [component, from])) as Record<Component, string>;
			for (const part of list(values.part)) {
				const [component, ref] = part.split("=");
				if (!COMPONENTS.includes(component as Component) || !ref) fail(`--part expects C=<ref> with C one of ${COMPONENTS.join(" ")}, got ${part}`);
				parts[component as Component] = ref;
			}
			const record = await registry.compose(parts);
			if (typeof values.ref === "string") await registry.setRef(values.ref, record.digest);
			console.log(`${c.leaf("composed")} ${record.manifest.name} ${record.digest}`);
			return;
		}
		default:
			fail("bundle import|list|show|diff|ref|checkout|compose");
	}
}

export async function main(argv: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		strict: false,
		options: {
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
			print: { type: "string", short: "p" },
			continue: { type: "boolean", short: "c" },
			resume: { type: "string", short: "r" },
			home: { type: "string" },
			model: { type: "string" },
			bundle: { type: "string" },
			backend: { type: "string" },
			thinking: { type: "string" },
			script: { type: "string" },
			output: { type: "string", short: "o" },
			raw: { type: "boolean" },
			payloads: { type: "boolean" },
			ref: { type: "string" },
			parent: { type: "string", multiple: true },
			from: { type: "string" },
			part: { type: "string", multiple: true },
			router: { type: "string" },
			label: { type: "string", multiple: true },
			copy: { type: "boolean" },
			json: { type: "boolean" },
			port: { type: "string" },
			host: { type: "string" },
			all: { type: "boolean" },
		},
	});
	const options: GlobalOptions = {
		...(typeof values.home === "string" ? { home: values.home } : {}),
		...(typeof values.model === "string" ? { model: values.model } : {}),
		...(typeof values.bundle === "string" ? { bundle: values.bundle } : {}),
		...(typeof values.backend === "string" ? { backend: values.backend } : {}),
		...(typeof values.thinking === "string" ? { thinking: values.thinking } : {}),
		...(typeof values.script === "string" ? { script: values.script } : {}),
		...(typeof values.router === "string" ? { router: values.router } : {}),
		...(values.copy ? { copy: true } : {}),
		...(values.json ? { json: true } : {}),
	};
	const labels = parseLabels(values.label);
	if (labels) options.labels = labels;
	if (values.version) return void console.log(LILY_VERSION);
	if (values.help) return void process.stdout.write(HELP);
	const [command, ...args] = positionals;
	const cwd = process.cwd();

	switch (command) {
		case "help":
			process.stdout.write(HELP);
			return;
		case "init": {
			const home = new LilyHome(options.home);
			await home.init();
			const runtime = await makeRuntime(options);
			const examples = join(packageRoot(), "examples", "bundles");
			for (const name of ["base", "demo"]) {
				const record = await runtime.registry.importDirectory(join(examples, name));
				await runtime.registry.setRef(name, record.digest);
				console.log(`${c.leaf("bundle")} ${name} ${record.digest}`);
			}
			const config = await loadConfig(home);
			const next: LilyConfig = { ...config, bundle: config.bundle ?? "base", ...(options.model ? { model: options.model } : {}) };
			await saveConfig(home, next);
			console.log(`${c.leaf("config")} ${home.config}${next.model ? "" : c.muted("  (set a model: lily config model anthropic/<model-id>)")}`);
			await runtime.close();
			return;
		}
		case "config": {
			const home = new LilyHome(options.home);
			await home.init();
			const config = (await loadConfig(home)) as Record<string, unknown>;
			const [key, value] = args;
			if (!key) return void console.log(JSON.stringify(config, null, 2));
			if (value === undefined) return void console.log(JSON.stringify(config[key] ?? null, null, 2));
			let parsed: unknown = value;
			try {
				parsed = JSON.parse(value);
			} catch {
				// plain string
			}
			config[key] = parsed;
			await saveConfig(home, config as LilyConfig);
			console.log(`${key} = ${JSON.stringify(parsed)}`);
			return;
		}
		case "sessions": {
			const runtime = await makeRuntime(options);
			for (const s of await runtime.listSessions(values.all ? undefined : { mode: "interactive" })) {
				console.log(`${c.leaf(s.sessionId)}  ${c.cream((s.title ?? "(untitled)").slice(0, 50).padEnd(50))} ${c.muted(`${s.runs} runs · ${s.model} · ${new Date(s.updatedAt).toLocaleString()}`)}`);
			}
			await runtime.close();
			return;
		}
		case "runs": {
			const runtime = await makeRuntime(options);
			for (const runId of (await listRunIds(runtime.home.runs)).slice(0, 40)) {
				const store = new RunStore(runtime.home.run(runId));
				const manifest = await store.readManifest().catch(() => undefined);
				if (!manifest) continue;
				const outcome = await store.readOutcome();
				const labels = Object.entries(manifest.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(" ");
				const prompt = manifest.prompt.text.replace(/\s+/g, " ").slice(0, 60);
				console.log(`${c.leaf(runId)}  ${(outcome?.status ?? "running").padEnd(11)} ${c.muted(`${manifest.bundle?.name ?? "-"}`.padEnd(14))} ${prompt}${labels ? c.muted(`  ${labels}`) : ""}`);
			}
			await runtime.close();
			return;
		}
		case "show": {
			const runtime = await makeRuntime(options);
			const runId = await findRun(runtime, args[0] ?? fail("show <run>"));
			process.stdout.write(renderTrajectoryMarkdown(await exportRun(new RunStore(runtime.home.run(runId)), runtime.artifacts)));
			await runtime.close();
			return;
		}
		case "export": {
			const runtime = await makeRuntime(options);
			const runId = await findRun(runtime, args[0] ?? fail("export <run>"));
			const trajectory = await exportRun(new RunStore(runtime.home.run(runId)), runtime.artifacts, { includeRaw: Boolean(values.raw), includePayloads: Boolean(values.payloads) });
			const out = typeof values.output === "string" ? values.output : undefined;
			if (out) {
				await writeJsonAtomic(out, trajectory);
				console.log(`${runId} → ${out} (${trajectory.calls.length} calls, fidelity ${trajectory.fidelity})`);
			} else process.stdout.write(`${JSON.stringify(trajectory, null, 2)}\n`);
			await runtime.close();
			return;
		}
		case "bundle": {
			const runtime = await makeRuntime(options);
			await commandBundle(runtime, args, values);
			await runtime.close();
			return;
		}
		case "annotate": {
			const runtime = await makeRuntime(options);
			const runId = await findRun(runtime, args[0] ?? fail("annotate <run> <name> <json>"));
			const name = args[1] ?? fail("annotate <run> <name> <json>");
			const raw = args[2] ?? fail("annotate <run> <name> <json>");
			let value: unknown = raw;
			try {
				value = JSON.parse(raw);
			} catch {
				// plain string
			}
			await new RunStore(runtime.home.run(runId)).annotate(name, value);
			console.log(`${runId} ${name} = ${JSON.stringify(value)}`);
			await runtime.close();
			return;
		}
		case "env": {
			const runtime = await makeRuntime(options);
			const [sub] = args;
			if (sub === "backends" || !sub) {
				for (const backend of runtime.envs.backends()) {
					const probe = await backend.probe();
					console.log(`${probe.available ? c.leaf("●") : c.muted("○")} ${backend.name.padEnd(16)} ${c.muted(backend.isolation.padEnd(16))} ${probe.available ? "" : c.muted(probe.reason ?? "")}`);
				}
			} else if (sub === "sweep") {
				console.log(`removed ${(await runtime.envs.sweep()).length} stale environments`);
			} else fail("env backends|sweep");
			await runtime.close();
			return;
		}
		case "doctor": {
			const runtime = await makeRuntime(options);
			const line = (ok: boolean, label: string, detail = "") => console.log(`${ok ? c.leaf("✓") : c.warn("!")} ${label}${detail ? c.muted(`  ${detail}`) : ""}`);
			const [major, minor] = process.versions.node.split(".").map(Number);
			line(major! > 22 || (major === 22 && minor! >= 19), `node ${process.versions.node}`, "needs >= 22.19");
			line(true, `home ${runtime.home.root}`);
			const model = options.model ?? runtime.config.model;
			const available = await runtime.models.getAvailable();
			line(Boolean(model), `default model ${model ?? "(none)"}`, model ? "" : "lily config model <provider/model-id>");
			line(available.length > 0, `${available.length} models with credentials`, available.length ? "" : "set a provider API key or add a provider to config.json");
			const bundles = await runtime.registry.list();
			line(bundles.length > 0, `${bundles.length} bundles in the registry`, bundles.length ? "" : "lily init");
			for (const backend of runtime.envs.backends()) {
				const probe = await backend.probe();
				if (probe.available || ["local", "seatbelt"].includes(backend.name)) line(probe.available, `backend ${backend.name} (${backend.isolation})`, probe.reason ?? "");
			}
			const configured = runtime.defaultEnvironment(cwd).backend;
			line(Boolean(runtime.envs.backends().find((b) => b.name === configured)), `default backend ${configured}`);
			await runtime.close();
			return;
		}
		case "models": {
			const runtime = await makeRuntime(options);
			const models = values.all ? runtime.models.getModels() : await runtime.models.getAvailable();
			for (const m of models) console.log(`${m.provider}/${m.id}${c.muted(`  ${m.name}`)}`);
			if (!values.all && models.length === 0) console.log(c.muted("No configured providers found. Set an API key (e.g. ANTHROPIC_API_KEY) or add a provider to ~/.lily/config.json. Use --all to list every known model."));
			await runtime.close();
			return;
		}
		case "serve": {
			const runtime = await makeRuntime(options);
			const port = Number(values.port ?? runtime.config.server?.port ?? 7777);
			const host = typeof values.host === "string" ? values.host : (runtime.config.server?.host ?? "127.0.0.1");
			const server = createHttpServer({
				router: createApi(runtime),
				allowedHosts: host === "127.0.0.1" || host === "localhost" ? ["127.0.0.1", "localhost", "[::1]"] : undefined,
			});
			server.listen(port, host, () =>
				console.log(`${c.leaf(LILY_MARK)} lily API on ${c.underline(`http://${host}:${port}/api`)}${runtime.router ? c.muted(`  (router ${runtime.router.name})`) : ""}`),
			);
			const shutdown = async () => {
				server.close();
				await runtime.close();
				process.exit(0);
			};
			process.on("SIGINT", () => void shutdown());
			process.on("SIGTERM", () => void shutdown());
			return;
		}
		default: {
			// Interactive / print mode. Anything that is not a command is the prompt.
			const runtime = await makeRuntime(options);
			if (!(typeof values.print === "string" || (!process.stdin.isTTY && command))) {
				// The TUI resolves the session itself and shows a setup screen when no model is usable.
				const code = await runInteractive(runtime, {
					cwd,
					version: LILY_VERSION,
					...(options.script ? { model: SCRIPT_MODEL } : options.model ? { model: options.model } : {}),
					...(options.bundle ? { bundle: options.bundle } : {}),
					...(options.backend ? { backend: options.backend } : {}),
					...(options.thinking ? { thinking: options.thinking } : {}),
					...(typeof values.resume === "string" ? { resume: values.resume } : {}),
					...(values.continue ? { continue: true } : {}),
					...(command ? { initialPrompt: positionals.join(" ") } : {}),
					...(options.labels ? { labels: options.labels } : {}),
					...(options.copy ? { copy: true } : {}),
				});
				await runtime.close();
				process.exit(code);
			}
			let session: LilySession;
			if (typeof values.resume === "string") session = await runtime.openSession(await findSession(runtime, values.resume));
			else if (values.continue) {
				const latest = (await runtime.listSessions({ mode: "interactive" })).find((s) => s.workspaceLabel === cwd);
				session = latest ? await runtime.openSession(latest.sessionId) : await startSession(runtime, options, cwd);
			} else session = await startSession(runtime, options, cwd);
			// `-p -` reads the prompt from stdin; otherwise stdin is left alone (it may never close).
			const prompt = values.print === "-" ? await readStdin() : typeof values.print === "string" ? values.print : positionals.join(" ");
			process.exitCode = await printMode(runtime, session, prompt, { json: Boolean(options.json) });
			return;
		}
	}
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8").trim();
}
