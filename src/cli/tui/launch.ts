import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { packageRoot } from "../../env/envd-binary.ts";
import { parseModelRef } from "../../models/config.ts";
import { registerScriptedProvider } from "../../models/registry.ts";
import { ROUTED_BUNDLE } from "../../resources/router.ts";
import type { LilyRuntime } from "../../runtime/runtime.ts";
import type { LilySession } from "../../runtime/session.ts";
import { c } from "../theme.ts";
import { InteractiveApp, type SetupPlan } from "../tui.ts";
import { PROVIDER_KEY_HINTS } from "./format.ts";
import type { NoticeLevel } from "./messages.ts";
import type { SetupProblem } from "./setup.ts";

export interface LaunchOptions {
	cwd: string;
	version: string;
	/** Explicit `--model` (or the scripted model with `--script`); otherwise config.model. */
	model?: string;
	/** Raw `--bundle`: a ref, a digest, "none" or "@router". */
	bundle?: string;
	backend?: string;
	thinking?: string;
	/** Raw `--resume` reference (id or suffix). */
	resume?: string;
	continue?: boolean;
	initialPrompt?: string;
	labels?: Record<string, string>;
	/** `--copy`: a fresh environment on a copy of the directory (never written back). */
	copy?: boolean;
}

const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function fail(message: string): number {
	process.stderr.write(`${c.error("error")} ${message}\n`);
	return 1;
}

/** Why `ref` cannot be used right now, or undefined when it can. */
export async function modelProblem(runtime: LilyRuntime, ref: string | undefined): Promise<SetupProblem | undefined> {
	if (!ref) return { kind: "missing" };
	let provider: string;
	let modelId: string;
	try {
		({ provider, modelId } = parseModelRef(ref));
	} catch {
		return { kind: "unknown", model: ref };
	}
	if (!runtime.models.getModel(provider, modelId)) return { kind: "unknown", model: ref };
	const auth = await runtime.models.checkAuth(provider).catch(() => undefined);
	if (!auth) {
		const env = PROVIDER_KEY_HINTS.find((h) => h.provider === provider)?.env;
		return { kind: "no-credentials", model: ref, ...(env ? { env } : {}) };
	}
	return undefined;
}

/**
 * Starts the interactive TUI: resumes or creates the session for `cwd`, or
 * shows the first-run setup screen when no usable model is configured.
 * Resolves with the process exit code once the user quits.
 */
export async function runInteractive(runtime: LilyRuntime, o: LaunchOptions): Promise<number> {
	const config = runtime.config;
	const bundle = o.bundle === "none" ? null : (o.bundle ?? config.bundle ?? null);
	if (bundle === ROUTED_BUNDLE && !runtime.router) return fail('--bundle @router needs a router: pass --router <module> or set "router" in config.json');
	const thinking = (o.thinking ?? config.thinking) as ThinkingLevel | undefined;
	if (thinking && !THINKING.includes(thinking)) return fail(`--thinking must be one of ${THINKING.join(", ")}`);
	const notices: Array<{ level: NoticeLevel; message: string }> = [];

	let bundleForNew = bundle;
	const newSession = async (model: string): Promise<LilySession> => {
		const init = {
			mode: o.copy ? ("batch" as const) : ("interactive" as const),
			model,
			...(thinking ? { thinking } : {}),
			environment: o.copy ? runtime.isolatedEnvironment({ kind: "directory", path: o.cwd }, o.backend) : runtime.defaultEnvironment(o.cwd, o.backend),
			workspaceLabel: o.cwd,
			...(o.labels ? { labels: o.labels } : {}),
		};
		try {
			return await runtime.createSession({ ...init, bundle: bundleForNew });
		} catch (error) {
			if (!bundleForNew || bundleForNew === ROUTED_BUNDLE || o.bundle) throw error;
			// A default bundle from config.json that is not in this registry must not block startup.
			notices.push({ level: "warning", message: `Default bundle "${bundleForNew}" is not in the registry (${(error as Error).message}); running without one. \`lily init\` imports the example bundles.` });
			bundleForNew = null;
			return runtime.createSession({ ...init, bundle: null });
		}
	};

	let session: LilySession | undefined;
	let setup: SetupPlan | undefined;
	try {
		if (o.resume) {
			const matches = (await runtime.listSessions()).filter((s) => s.sessionId === o.resume || s.sessionId.endsWith(o.resume!));
			if (matches.length !== 1) return fail(matches.length ? `Ambiguous session ${o.resume}` : `No session matching ${o.resume}`);
			session = await runtime.openSession(matches[0]!.sessionId);
		} else if (o.continue) {
			const latest = (await runtime.listSessions({ mode: "interactive" })).find((s) => s.workspaceLabel === o.cwd);
			if (latest) session = await runtime.openSession(latest.sessionId);
		}
		if (session) {
			const problem = await modelProblem(runtime, session.binding.model);
			if (problem) notices.push({ level: "warning", message: `This session's model ${session.binding.model} is not usable right now (${problem.kind}). Pick another with /model.` });
		} else {
			const model = o.model ?? config.model;
			const problem = await modelProblem(runtime, model);
			if (problem) {
				const script = join(packageRoot(), "examples", "scripts", "chat.json");
				setup = {
					problem,
					available: (await runtime.models.getAvailable()).filter((m) => m.provider !== "scripted"),
					...(existsSync(script)
						? {
								offline: async () => {
									if (!runtime.models.getModel("scripted", "script")) await registerScriptedProvider(runtime.models, "script", script);
									return "scripted/script";
								},
							}
						: {}),
				};
			} else session = await newSession(model!);
		}
	} catch (error) {
		return fail((error as Error).message);
	}

	const app = new InteractiveApp(runtime, session, {
		cwd: o.cwd,
		version: o.version,
		newSession,
		notices,
		...(setup ? { setup } : {}),
		...(o.initialPrompt ? { initialPrompt: o.initialPrompt } : {}),
	});
	await app.run();
	return 0;
}
