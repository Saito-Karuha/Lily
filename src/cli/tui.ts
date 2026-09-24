import { basename } from "node:path";
import type { Entry, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, getSupportedThinkingLevels, type Model, type ToolResultMessage } from "@earendil-works/pi-ai";
import { type Component, Container, ProcessTerminal, type SlashCommand, Spacer, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import type { LilyToolMeta } from "../kernel/gateway.ts";
import { loadConfig, parseModelRef, saveConfig } from "../models/config.ts";
import { ROUTED_BUNDLE } from "../resources/router.ts";
import type { LilyEvent } from "../runtime/events.ts";
import type { LilyRuntime } from "../runtime/runtime.ts";
import type { LilySession } from "../runtime/session.ts";
import { type RunOutcome, RunStore } from "../store/runs.ts";
import { exportRun } from "../trajectory/export.ts";
import { writeJsonAtomic } from "../util/fsx.ts";
import { shortDigest } from "../util/hash.ts";
import { c, LILY_MARK } from "./theme.ts";
import { LilyAutocompleteProvider } from "./tui/autocomplete.ts";
import { LilyEditor } from "./tui/editor.ts";
import { Footer, type FooterState, type UsageTotals } from "./tui/footer.ts";
import { formatDuration, formatTokens, isolationLabel, oneLine, shortenPath, textParts } from "./tui/format.ts";
import { Header, type HeaderInfo } from "./tui/header.ts";
import { AssistantView, Line, NoticeView, type NoticeLevel, RunFooterView, UserMessageView } from "./tui/messages.ts";
import { Picker, type PickItem } from "./tui/picker.ts";
import { modelItems, sessionItems, TREE_FILTERS, type TreeFilter, type TreeValue, treeDetail, treeItems } from "./tui/pickers.ts";
import { SetupScreen, type SetupProblem } from "./tui/setup.ts";
import { hint, SPINNER_FRAMES } from "./tui/style.ts";
import { ToolView } from "./tui/tool-view.ts";

interface CommandSpec extends SlashCommand {
	/** Refused while a run is active. */
	idleOnly?: boolean;
}

const THINKING_DESCRIPTIONS: Record<string, string> = {
	off: "no reasoning",
	minimal: "very brief reasoning",
	low: "light reasoning",
	medium: "moderate reasoning",
	high: "deep reasoning",
	xhigh: "extra-high reasoning",
	max: "maximum reasoning",
};
const ALL_THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const COMMANDS: CommandSpec[] = [
	{ name: "help", description: "Commands and keys" },
	{ name: "model", description: "Pick the model (saved as default)", argumentHint: "[provider/id]" },
	{ name: "thinking", description: "Set the thinking level", argumentHint: "[level]" },
	{ name: "bundle", description: "Bind a resource bundle", argumentHint: "[ref|none]" },
	{ name: "new", description: "Start a new session here", idleOnly: true },
	{ name: "resume", description: "Resume a session", argumentHint: "[id]", idleOnly: true },
	{ name: "sessions", description: "Browse sessions", idleOnly: true },
	{ name: "tree", description: "Navigate the conversation tree", idleOnly: true },
	{ name: "goto", description: "Jump to an entry id", argumentHint: "<entry> [--summarize]", idleOnly: true },
	{ name: "fork", description: "New session re-asking from an entry", argumentHint: "[entry]", idleOnly: true },
	{ name: "clone", description: "Copy this conversation to a new session", idleOnly: true },
	{ name: "compact", description: "Summarize older context", argumentHint: "[instructions]", idleOnly: true },
	{ name: "env", description: "Show the execution environment" },
	{ name: "runs", description: "List this session's runs" },
	{ name: "export", description: "Export a run's trajectory as JSON", argumentHint: "[run] [file]" },
	{ name: "quit", description: "Exit lily" },
];

/**
 * Maps a typed command to a known one. Pressing Enter right after typing while
 * the slash menu is still updating can make the editor apply a stale completion
 * ("/env" → "/eenv", "/help" → "/hehelp"): a known name preceded by one of its
 * own prefixes is recovered; anything else is returned unchanged.
 */
export function resolveCommandName(typed: string): string {
	const names = COMMANDS.map((command) => command.name).concat("exit");
	if (names.includes(typed)) return typed;
	for (const name of names) {
		if (typed.length > name.length && typed.endsWith(name) && name.startsWith(typed.slice(0, typed.length - name.length))) return name;
	}
	return typed;
}

/** First-run setup, when no usable model is configured. */
export interface SetupPlan {
	problem: SetupProblem;
	available: readonly Model<Api>[];
	/** Registers the bundled offline scripted model and returns its ref; undefined when unavailable. */
	offline?: () => Promise<string>;
}

export interface InteractiveOptions {
	cwd: string;
	version?: string;
	/** Submitted as the first prompt once the UI is up. */
	initialPrompt?: string;
	/** Creates a session for this directory with the given model (used by /new and after setup). */
	newSession?: (model: string) => Promise<LilySession>;
	/** Show the first-run setup screen before any session exists. */
	setup?: SetupPlan;
	/** Shown once the UI is up (warnings from startup). */
	notices?: Array<{ level: NoticeLevel; message: string }>;
}

interface Status {
	label: string;
	since: number;
}

function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(totals: UsageTotals, usage: AssistantMessage["usage"] | undefined): void {
	if (!usage) return;
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.cost += usage.cost?.total ?? 0;
}

function contextOf(usage: AssistantMessage["usage"] | undefined): number | null {
	if (!usage) return null;
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Lily's interactive terminal UI: a Pi-style chat over one session. Everything
 * in the transcript comes from the session's event log, the same stream API
 * clients consume; selectors replace the editor while open.
 */
export class InteractiveApp {
	readonly #runtime: LilyRuntime;
	#session: LilySession | undefined;
	readonly #options: InteractiveOptions;
	readonly #cwd: string;
	readonly #tui = new TuiMainScreen(new ProcessTerminal());
	readonly #header: Header;
	readonly #transcript = new Container();
	readonly #pending = new Container();
	readonly #slot = new Container();
	readonly #editor: LilyEditor;
	readonly #footer: Footer;
	readonly #autocomplete: LilyAutocompleteProvider;
	#unsubscribe: (() => void) | undefined;
	#assistant: AssistantView | undefined;
	readonly #tools = new Map<string, ToolView>();
	#toolsExpanded = false;
	#thinkingExpanded = false;
	#usage = emptyUsage();
	#contextTokens: number | null = null;
	#envStatus: FooterState["envStatus"] = "idle";
	#status: Status | undefined;
	#flash: { text: string; until: number } | undefined;
	#frame = 0;
	#timer: ReturnType<typeof setInterval> | undefined;
	#queued: string[] = [];
	#shownPrompt: string | undefined;
	#bundleLabel: string | undefined;
	#lastCtrlC = 0;
	#picker: Component | undefined;
	#exit!: () => void;
	#exited = false;
	#noticesShown = 0;
	/** Background environment warm-up (`session.prepare()`); prompts wait for it. */
	#preparing: Promise<unknown> | undefined;
	/** A submitted prompt waiting for the warm-up; Esc cancels it. */
	#waiting: { cancelled: boolean } | undefined;
	/** Cancels a running `!command`. */
	#shellAbort: AbortController | undefined;

	constructor(runtime: LilyRuntime, session: LilySession | undefined, options: InteractiveOptions) {
		this.#runtime = runtime;
		this.#session = session;
		this.#options = options;
		this.#cwd = options.cwd;
		this.#header = new Header(this.#headerInfo());
		this.#editor = new LilyEditor(this.#tui, { paddingX: 1, autocompleteMaxVisible: 8 });
		this.#autocomplete = new LilyAutocompleteProvider(this.#slashCommands(), options.cwd);
		this.#editor.setAutocompleteProvider(this.#autocomplete);
		this.#editor.onSubmit = (text) => void this.#submit(text);
		this.#editor.status = () => this.#borderStatus();
		this.#editor.actions = {
			escape: () => this.#onEscape(),
			ctrlC: () => this.#onCtrlC(),
			exit: () => this.#quit(),
			selectModel: () => void this.#run(() => this.#openModelPicker()),
			toggleTools: () => this.#toggleTools(),
			toggleThinking: () => this.#toggleThinking(),
		};
		this.#footer = new Footer(() => this.#footerState());
	}

	async run(): Promise<void> {
		this.#tui.addChild(this.#header);
		this.#tui.addChild(this.#transcript);
		this.#tui.addChild(this.#pending);
		this.#tui.addChild(new Spacer(1));
		this.#tui.addChild(this.#slot);
		this.#tui.addChild(this.#footer);
		this.#slot.addChild(this.#editor);
		this.#tui.setFocus(this.#editor);
		const done = new Promise<void>((resolve) => {
			this.#exit = resolve;
		});
		if (this.#session) await this.#attach(this.#session);
		this.#tui.start();
		this.#updateTitle();
		this.#autocomplete.warm();
		this.#timer = setInterval(() => this.#tick(), 80);
		this.#flushNotices();
		if (this.#options.setup) this.#showSetup(this.#options.setup);
		else {
			void this.#probeBackend();
			if (this.#options.initialPrompt) void this.#submit(this.#options.initialPrompt);
		}
		await done;
		clearInterval(this.#timer);
		this.#unsubscribe?.();
		this.#tui.stop();
	}

	// ── state for header / footer / border ────────────────────────────────

	#model(ref: string | undefined): Model<Api> | undefined {
		if (!ref) return undefined;
		try {
			const { provider, modelId } = parseModelRef(ref);
			return this.#runtime.models.getModel(provider, modelId);
		} catch {
			return undefined;
		}
	}

	#backendIsolation(name: string): string | undefined {
		try {
			return this.#runtime.envs.backend(name).isolation;
		} catch {
			return undefined;
		}
	}

	#headerInfo(): HeaderInfo {
		const s = this.#session;
		const version = this.#options.version ? `v${this.#options.version}` : "";
		if (!s) return { version, cwd: this.#cwd, note: "first-run setup" };
		const backend = s.lease?.info.backend ?? s.binding.environment.spec.backend;
		return {
			version,
			model: s.binding.model,
			thinking: s.binding.thinking,
			...(this.#bundleLabel ? { bundle: this.#bundleLabel } : {}),
			backend,
			...(() => {
				const isolation = s.lease?.info.isolation ?? this.#backendIsolation(backend);
				return isolation ? { isolation } : {};
			})(),
			cwd: this.#cwd,
		};
	}

	#footerState(): FooterState {
		const s = this.#session;
		const model = this.#model(s?.binding.model);
		const backend = s ? (s.lease?.info.backend ?? s.binding.environment.spec.backend) : undefined;
		const isolation = s?.lease?.info.isolation ?? (backend ? this.#backendIsolation(backend) : undefined);
		return {
			cwd: this.#cwd,
			...(s?.binding.title ? { title: s.binding.title } : {}),
			...(s ? { model: s.binding.model, thinking: s.binding.thinking } : {}),
			...(model ? { contextWindow: model.contextWindow, reasoning: model.reasoning } : {}),
			...(this.#bundleLabel ? { bundle: this.#bundleLabel } : {}),
			...(backend ? { backend } : {}),
			...(isolation ? { isolation } : {}),
			envStatus: this.#envStatus,
			usage: this.#usage,
			contextTokens: this.#contextTokens,
			busy: Boolean(s?.busy),
			frame: SPINNER_FRAMES[this.#frame % SPINNER_FRAMES.length]!,
		};
	}

	/** Terminal window title: `❦ lily · <session title> · <dir>` (as Pi does). */
	#updateTitle(): void {
		const title = this.#session?.binding.title;
		this.#tui.terminal.setTitle(`${LILY_MARK} lily${title ? ` · ${oneLine(title, 40)}` : ""} · ${basename(this.#cwd)}`);
	}

	#spinner(): string {
		return SPINNER_FRAMES[this.#frame % SPINNER_FRAMES.length]!;
	}

	#borderStatus(): string | undefined {
		if (this.#flash && Date.now() < this.#flash.until) return c.muted(this.#flash.text);
		const busy = this.#session?.busy;
		if (!this.#status && !busy) return undefined;
		const status = this.#status ?? { label: "Working…", since: Date.now() };
		const elapsed = Date.now() - status.since;
		return `${c.sun(this.#spinner())} ${c.sage(status.label)}${elapsed >= 1000 ? c.muted(` ${formatDuration(elapsed)}`) : ""}${busy ? `${c.muted(" · ")}${hint("esc", "interrupt")}` : ""}`;
	}

	#setStatus(label: string | undefined): void {
		if (!label) this.#status = undefined;
		else if (this.#status?.label !== label) this.#status = { label, since: this.#status?.since ?? Date.now() };
		this.#tui.requestRender();
	}

	#tick(): void {
		const animating = Boolean(this.#status || this.#session?.busy || this.#flash);
		if (this.#flash && Date.now() >= this.#flash.until) this.#flash = undefined;
		if (!animating) return;
		this.#frame++;
		this.#tui.requestRender();
	}

	#flashHint(text: string, ms = 1500): void {
		this.#flash = { text, until: Date.now() + ms };
		this.#tui.requestRender();
	}

	async #refreshBundleLabel(): Promise<void> {
		const bundle = this.#session?.binding.bundle;
		if (!bundle) this.#bundleLabel = undefined;
		else if (bundle === ROUTED_BUNDLE) this.#bundleLabel = ROUTED_BUNDLE;
		else {
			const refs = await this.#runtime.registry.refs().catch(() => ({}) as Record<string, string>);
			const name = Object.entries(refs).find(([, digest]) => digest === bundle)?.[0];
			if (name) this.#bundleLabel = name;
			else {
				const record = await this.#runtime.registry.get(bundle).catch(() => undefined);
				this.#bundleLabel = record ? `${record.manifest.name}@${shortDigest(record.digest, 8)}` : shortDigest(bundle, 8);
			}
		}
		this.#tui.requestRender();
	}

	// ── transcript helpers ───────────────────────────────────────────────

	#append(component: Component): void {
		this.#transcript.addChild(component);
		this.#tui.requestRender();
	}

	#notice(level: NoticeLevel, message: string): void {
		this.#append(new NoticeView(level, message));
	}

	/** Startup notices, including ones added while creating a session later. */
	#flushNotices(): void {
		const notices = this.#options.notices ?? [];
		for (; this.#noticesShown < notices.length; this.#noticesShown++) this.#notice(notices[this.#noticesShown]!.level, notices[this.#noticesShown]!.message);
	}

	#block(lines: string[]): void {
		this.#append(new Spacer(1));
		this.#append(new Text(lines.join("\n"), 1, 0));
	}

	#toolView(name: string, id: string, args: unknown): ToolView {
		return new ToolView(name, id, args, { expanded: () => this.#toolsExpanded, frame: () => this.#spinner() });
	}

	#renderPending(): void {
		this.#pending.clear();
		if (this.#queued.length === 0) return;
		this.#pending.addChild(new Spacer(1));
		for (const text of this.#queued) this.#pending.addChild(new Line(` ${c.sage("↳")} ${c.muted(`steer: ${oneLine(text, 400)}`)}`));
		this.#pending.addChild(new Line(`   ${c.muted("delivered at the next turn boundary")}`));
		this.#tui.requestRender();
	}

	#toggleTools(): void {
		this.#toolsExpanded = !this.#toolsExpanded;
		this.#flashHint(this.#toolsExpanded ? "tool output expanded (ctrl+o to collapse)" : "tool output collapsed");
	}

	#toggleThinking(): void {
		this.#thinkingExpanded = !this.#thinkingExpanded;
		this.#flashHint(this.#thinkingExpanded ? "thinking shown (ctrl+t to hide)" : "thinking hidden");
	}

	// ── session attach / replay ──────────────────────────────────────────

	async #attach(session: LilySession): Promise<void> {
		this.#unsubscribe?.();
		this.#session = session;
		this.#transcript.clear();
		this.#tools.clear();
		this.#assistant = undefined;
		this.#queued = [];
		this.#renderPending();
		this.#status = undefined;
		this.#envStatus = session.lease ? "ready" : "idle";
		await this.#refreshBundleLabel();
		this.#header.set(this.#headerInfo());
		await this.#replay(session);
		this.#unsubscribe = session.events.subscribe((stored) => {
			try {
				this.#onEvent(stored.event);
			} catch (error) {
				this.#notice("error", `UI error: ${(error as Error).message}`);
			}
		});
		this.#updateTitle();
		this.#tui.requestRender(true);
	}

	async #replay(session: LilySession): Promise<void> {
		const [branch, all] = await Promise.all([session.branchEntries(), session.allEntries()]);
		this.#usage = emptyUsage();
		for (const entry of all) if (entry.type === "message" && entry.message.role === "assistant") addUsage(this.#usage, (entry.message as AssistantMessage).usage);
		this.#contextTokens = 0;
		// Run footers come back from each run's outcome, placed after the entry the run ended on.
		const outcomes = await Promise.all(session.binding.runs.slice(-200).map((id) => new RunStore(this.#runtime.home.run(id)).readOutcome().catch(() => undefined)));
		const footers = new Map<string, RunOutcome>();
		for (const outcome of outcomes) if (outcome?.tipId) footers.set(outcome.tipId, outcome);
		const pending = new Map<string, ToolView>();
		for (const entry of branch) {
			this.#replayEntry(entry, pending);
			const outcome = footers.get(entry.id);
			if (outcome) this.#transcript.addChild(new RunFooterView(outcome));
		}
		for (const view of pending.values()) if (view.status === "running") view.finish({ isError: true, text: "(no result recorded)" });
	}

	#replayEntry(entry: Entry, pending: Map<string, ToolView>): void {
		if (entry.type === "compaction") {
			this.#contextTokens = null;
			this.#notice("info", `context compacted · ${formatTokens(entry.tokensBefore)} tokens summarized`);
			return;
		}
		if (entry.type === "branch_summary") {
			this.#notice("info", "returned from another branch · its summary is kept in context");
			return;
		}
		if (entry.type !== "message") return;
		const message = entry.message;
		if (message.role === "user") this.#transcript.addChild(new UserMessageView(textParts(message.content)));
		else if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			this.#transcript.addChild(new AssistantView(() => this.#thinkingExpanded, assistant));
			this.#contextTokens = contextOf(assistant.usage);
			for (const part of assistant.content) {
				if (part.type !== "toolCall") continue;
				const view = this.#toolView(part.name, part.id, part.arguments);
				pending.set(part.id, view);
				this.#transcript.addChild(view);
			}
		} else if (message.role === "toolResult") {
			const result = message as ToolResultMessage<{ diff?: string; lily?: LilyToolMeta }>;
			const view = pending.get(result.toolCallId);
			if (!view) return;
			view.finish({
				isError: result.isError,
				text: textParts(result.content),
				...(typeof result.details?.diff === "string" ? { diff: result.details.diff } : {}),
				...(result.details?.lily ? { meta: result.details.lily } : {}),
			});
		}
	}

	// ── live events ──────────────────────────────────────────────────────

	#onEvent(event: LilyEvent): void {
		switch (event.type) {
			case "environment":
				if (event.status === "provisioning") {
					this.#envStatus = "provisioning";
					// A background warm-up shows only in the footer; a waiting prompt shows it in the border.
					if (this.#shownPrompt || this.#session?.busy) this.#setStatus("Preparing the environment…");
				} else if (event.status === "ready") {
					this.#envStatus = "ready";
					if (this.#status?.label === "Preparing the environment…") this.#setStatus("Starting…");
				} else if (event.status === "lost") {
					this.#envStatus = "lost";
					this.#notice("error", "The execution environment was lost; the next run starts a fresh one.");
				} else this.#envStatus = "idle";
				break;
			case "message_end": {
				const role = event.message.role;
				if (role === "user") {
					const text = textParts((event.message as { content?: unknown }).content);
					const index = this.#queued.findIndex((q) => q.trim() === text.trim());
					if (index >= 0) {
						this.#queued.splice(index, 1);
						this.#renderPending();
						this.#append(new UserMessageView(text, "steer"));
					}
				} else if (role === "assistant") {
					const message = event.message as AssistantMessage;
					const view = this.#assistant ?? new AssistantView(() => this.#thinkingExpanded);
					if (!this.#assistant) this.#append(view);
					view.setMessage(message);
					addUsage(this.#usage, message.usage);
					this.#contextTokens = contextOf(message.usage) ?? this.#contextTokens;
					this.#assistant = undefined;
					if (this.#session?.busy) this.#setStatus("Working…");
				}
				break;
			}
			case "run_start":
				if (this.#shownPrompt?.trim() !== event.prompt.trim()) this.#append(new UserMessageView(event.prompt));
				this.#shownPrompt = event.prompt;
				this.#setStatus("Working…");
				break;
			case "message_start":
				if (event.role === "assistant") {
					this.#assistant = new AssistantView(() => this.#thinkingExpanded);
					this.#append(this.#assistant);
					this.#setStatus("Thinking…");
				}
				break;
			case "message_delta":
				if (event.kind === "toolcall") this.#setStatus("Writing a tool call…");
				else {
					if (!this.#assistant) {
						this.#assistant = new AssistantView(() => this.#thinkingExpanded);
						this.#append(this.#assistant);
					}
					this.#assistant.appendDelta(event.kind, event.contentIndex, event.delta);
					this.#setStatus(event.kind === "thinking" ? "Thinking…" : "Writing…");
				}
				break;
			case "tool_start": {
				const view = this.#toolView(event.toolName, event.toolCallId, event.args);
				this.#tools.set(event.toolCallId, view);
				this.#append(view);
				this.#setStatus(`Running ${event.toolName}…`);
				break;
			}
			case "tool_update":
				this.#tools.get(event.toolCallId)?.update(event.text);
				break;
			case "tool_end": {
				const view = this.#tools.get(event.toolCallId);
				view?.finish({
					isError: event.isError,
					text: event.content.map((p) => p.text ?? `[${p.type}]`).join(""),
					...(event.diff ? { diff: event.diff } : {}),
					...(event.lily ? { meta: event.lily } : {}),
				});
				this.#setStatus("Working…");
				break;
			}
			case "compaction_start":
				this.#setStatus(event.reason === "manual" ? "Compacting context…" : "Context is filling up · compacting…");
				break;
			case "compaction_end":
				if (event.status === "completed") {
					this.#contextTokens = null;
					this.#notice("info", "context compacted · older turns are now a summary");
				} else this.#notice("warning", `Compaction ${event.status}${event.error ? `: ${event.error.message}` : ""}`);
				this.#setStatus(this.#session?.busy ? "Working…" : undefined);
				break;
			case "retry":
				this.#notice("warning", `Provider error, retrying in ${Math.round(event.delayMs / 1000)}s (${event.attempt}/${event.maxAttempts}): ${oneLine(event.error, 160)}`);
				this.#setStatus(`Retrying (${event.attempt}/${event.maxAttempts})…`);
				break;
			case "steer_queued":
				// Steers typed here are already pending; show ones sent by other clients too.
				if (!this.#queued.some((q) => q.trim() === event.text.trim())) {
					this.#queued.push(event.text);
					this.#renderPending();
				}
				break;
			case "notice":
				this.#notice(event.level, event.message);
				break;
			case "run_end": {
				this.#append(new RunFooterView(event.outcome));
				this.#updateTitle();
				this.#setStatus(undefined);
				this.#shownPrompt = undefined;
				this.#assistant = undefined;
				if (this.#queued.length) {
					const leftover = this.#queued.join("\n\n");
					this.#queued = [];
					this.#renderPending();
					if (!this.#editor.getText().trim()) {
						this.#editor.setText(leftover);
						this.#notice("warning", "A steering message was not delivered before the run ended; it is back in the editor.");
					} else this.#notice("warning", `Not delivered: ${oneLine(leftover, 200)}`);
				}
				break;
			}
			default:
				break;
		}
		this.#tui.requestRender();
	}

	// ── keys ─────────────────────────────────────────────────────────────

	#onEscape(): void {
		const s = this.#session;
		if (this.#shellAbort) {
			this.#shellAbort.abort();
			this.#flashHint("interrupting…", 2000);
		} else if (this.#waiting) {
			this.#waiting.cancelled = true;
			this.#flashHint("cancelled", 1500);
		} else if (s?.busy) {
			this.#flashHint("interrupting…", 2000);
			void s.abort();
		}
	}

	#onCtrlC(): void {
		const now = Date.now();
		const again = now - this.#lastCtrlC < 1200;
		this.#lastCtrlC = now;
		if (again) return this.#quit();
		if (this.#editor.getText()) {
			this.#editor.setText("");
			this.#flashHint("cleared · ctrl+c again to exit");
		} else if (this.#waiting) {
			this.#waiting.cancelled = true;
			this.#flashHint("cancelled · ctrl+c again to exit", 2000);
		} else if (this.#session?.busy) {
			this.#flashHint("interrupting · ctrl+c again to exit", 2000);
			void this.#session.abort();
		} else this.#flashHint("press ctrl+c again to exit");
		this.#tui.requestRender();
	}

	#quit(): void {
		if (this.#exited) return;
		this.#exited = true;
		this.#exit();
	}

	// ── pickers ──────────────────────────────────────────────────────────

	#maxVisible(): number {
		return Math.max(4, Math.min(14, this.#tui.terminal.rows - 16));
	}

	#showPicker(component: Component): void {
		this.#picker = component;
		this.#slot.clear();
		this.#slot.addChild(component);
		this.#tui.setFocus(component);
		this.#tui.requestRender();
	}

	#closePicker(): void {
		this.#picker = undefined;
		this.#slot.clear();
		this.#slot.addChild(this.#editor);
		this.#tui.setFocus(this.#editor);
		// The screen shrinks by the picker's height; redraw so the editor stays at the bottom
		// (and the header shows the current model / thinking / bundle).
		if (this.#session) this.#header.set(this.#headerInfo());
		this.#tui.requestRender(true);
	}

	/** Runs an async UI action, reporting failures in the transcript. */
	async #run(action: () => Promise<void> | void): Promise<void> {
		try {
			await action();
		} catch (error) {
			this.#notice("error", (error as Error).message);
		}
		this.#tui.requestRender();
	}

	#requireSession(): LilySession {
		if (!this.#session) throw new Error("Pick a model first.");
		return this.#session;
	}

	#requireIdle(): LilySession {
		const s = this.#requireSession();
		if (s.busy) throw new Error("A run is active: wait for it to finish, or press Esc to interrupt it.");
		return s;
	}

	async #defaultModel(): Promise<string | undefined> {
		return (await loadConfig(this.#runtime.home).catch(() => ({}) as { model?: string })).model;
	}

	/** Uses `ref` for this session and saves it as the default in config.json. */
	async #selectModel(ref: string): Promise<void> {
		const s = this.#requireSession();
		await s.setModel(ref);
		let saved = false;
		if (!ref.startsWith("scripted/")) {
			const config = await loadConfig(this.#runtime.home);
			if (config.model !== ref) await saveConfig(this.#runtime.home, { ...config, model: ref });
			saved = true;
		}
		this.#header.set(this.#headerInfo());
		this.#notice("success", `model ${ref}${saved ? " · saved as default" : ""}${s.busy ? " · applies to the next run" : ""}`);
	}

	async #openModelPicker(): Promise<void> {
		const s = this.#requireSession();
		if (this.#picker) return;
		const current = s.binding.model;
		const items = Promise.all([this.#runtime.models.getAvailable(), this.#defaultModel()]).then(([models, def]) => modelItems(models, current, def));
		this.#showPicker(
			new Picker<string>({
				title: "Select model",
				subtitle: "Models from providers with credentials · the choice becomes your default",
				items,
				maxVisible: this.#maxVisible(),
				loadingText: "Loading models…",
				emptyText: "No provider has credentials. Set an API key (e.g. ANTHROPIC_API_KEY) or add a provider to config.json.",
				detail: (item) => {
					const m = this.#model(item.value);
					return m ? `${m.name} · ${formatTokens(m.contextWindow)} context · max output ${formatTokens(m.maxTokens)}` : undefined;
				},
				onSelect: (item) => {
					this.#closePicker();
					void this.#run(() => (item.value === current ? undefined : this.#selectModel(item.value)));
				},
				onCancel: () => this.#closePicker(),
			}),
		);
	}

	#openThinkingPicker(): void {
		const s = this.#requireSession();
		const model = this.#model(s.binding.model);
		const levels = (model ? getSupportedThinkingLevels(model) : ALL_THINKING) as ThinkingLevel[];
		const items: PickItem<ThinkingLevel>[] = levels.map((level) => ({ value: level, label: level, description: THINKING_DESCRIPTIONS[level] ?? "", current: level === s.binding.thinking }));
		this.#showPicker(
			new Picker<ThinkingLevel>({
				title: "Thinking level",
				subtitle: model && !model.reasoning ? `${model.id} does not reason; only "off" applies` : "Applies from the next model call",
				items,
				maxVisible: this.#maxVisible(),
				filter: false,
				labelShare: 0.3,
				onSelect: (item) => {
					this.#closePicker();
					void this.#run(async () => {
						await s.setThinking(item.value);
						this.#header.set(this.#headerInfo());
						this.#notice("success", `thinking ${item.value}`);
					});
				},
				onCancel: () => this.#closePicker(),
			}),
		);
	}

	async #bundleItems(current: string | null): Promise<PickItem<string | null>[]> {
		const registry = this.#runtime.registry;
		const [refs, records] = await Promise.all([registry.refs(), registry.list()]);
		const items: PickItem<string | null>[] = [{ value: null, label: "none", description: "bare kernel, no resources", current: current === null }];
		if (this.#runtime.router) items.push({ value: ROUTED_BUNDLE, label: ROUTED_BUNDLE, description: `router ${this.#runtime.router.name} picks per run`, current: current === ROUTED_BUNDLE });
		const named = new Set<string>();
		for (const [name, digest] of Object.entries(refs).sort()) {
			named.add(digest);
			const record = records.find((r) => r.digest === digest);
			items.push({ value: name, label: name, description: `${record?.manifest.name ?? "?"} · ${shortDigest(digest, 12)}`, current: digest === current });
		}
		for (const record of records) {
			if (named.has(record.digest)) continue;
			items.push({ value: record.digest, label: `${record.manifest.name}@${shortDigest(record.digest, 8)}`, description: record.manifest.description ? oneLine(record.manifest.description, 80) : record.origin.kind, current: record.digest === current });
		}
		return items;
	}

	#openBundlePicker(): void {
		const s = this.#requireSession();
		this.#showPicker(
			new Picker<string | null>({
				title: "Resource bundle",
				subtitle: "Prompt, memory, skills, tools and observation processing · takes effect at the next run",
				items: this.#bundleItems(s.binding.bundle),
				maxVisible: this.#maxVisible(),
				loadingText: "Loading bundles…",
				onSelect: (item) => {
					this.#closePicker();
					void this.#run(() => this.#bindBundle(item.value));
				},
				onCancel: () => this.#closePicker(),
			}),
		);
	}

	async #bindBundle(ref: string | null): Promise<void> {
		const s = this.#requireSession();
		if (ref === ROUTED_BUNDLE && !this.#runtime.router) throw new Error("@router needs a router: start lily with --router <module> or set \"router\" in config.json");
		const bound = await s.setBundle(ref);
		await this.#refreshBundleLabel();
		this.#header.set(this.#headerInfo());
		this.#notice("success", bound ? `bundle ${this.#bundleLabel} · applies from the next run (the environment is refreshed)` : "bundle removed · the next run uses the bare kernel");
	}

	#openSessionPicker(): void {
		const current = this.#session?.id;
		let scope: "here" | "all" = "here";
		let all: Awaited<ReturnType<LilyRuntime["listSessions"]>> = [];
		const subtitle = () => (scope === "here" ? `This folder (${shortenPath(this.#cwd)}) · tab shows all folders` : "All folders · tab shows this folder only");
		const build = () => sessionItems(scope === "here" ? all.filter((x) => x.workspaceLabel === this.#cwd) : all, current);
		const picker: Picker<string> = new Picker<string>({
			title: "Resume a session",
			subtitle: subtitle(),
			items: this.#runtime.listSessions({ mode: "interactive" }).then((sessions) => {
				all = sessions;
				if (!sessions.some((x) => x.workspaceLabel === this.#cwd)) scope = "all";
				picker.setTitle("Resume a session", subtitle());
				return build();
			}),
			maxVisible: this.#maxVisible(),
			loadingText: "Loading sessions…",
			emptyText: "No sessions here yet (tab: all folders)",
			hints: [["tab", "scope"]],
			detail: (item) => `session ${item.value}`,
			onKey: (data) => {
				if (data !== "\t") return false;
				scope = scope === "here" ? "all" : "here";
				picker.setTitle("Resume a session", subtitle());
				picker.setItems(build());
				return true;
			},
			onSelect: (item) => {
				this.#closePicker();
				if (item.value === current) return;
				void this.#run(async () => this.#switch(await this.#runtime.openSession(item.value)));
			},
			onCancel: () => this.#closePicker(),
		});
		this.#showPicker(picker);
	}

	async #openTreePicker(initial?: TreeValue): Promise<void> {
		const s = this.#requireIdle();
		const [entries, tip] = await Promise.all([s.allEntries(), s.tipId()]);
		if (entries.length === 0) {
			this.#notice("info", "The conversation is empty.");
			return;
		}
		const byId = new Map(entries.map((e) => [e.id, e]));
		let filter: TreeFilter = "conversation";
		const subtitle = () => `Filter: ${filter} · tab cycles conversation / user / all · files in the workspace are not rolled back`;
		const picker: Picker<TreeValue> = new Picker<TreeValue>({
			title: "Conversation tree",
			subtitle: subtitle(),
			items: treeItems(entries, tip, filter),
			initial: (item: PickItem<TreeValue>) => item.value === (initial !== undefined ? initial : tip),
			maxVisible: this.#maxVisible(),
			labelShare: 1,
			hints: [["tab", "filter"]],
			detail: (item) => treeDetail(item.value ? byId.get(item.value) : undefined),
			onKey: (data) => {
				if (data !== "\t") return false;
				filter = TREE_FILTERS[(TREE_FILTERS.indexOf(filter) + 1) % TREE_FILTERS.length]!;
				picker.setTitle("Conversation tree", subtitle());
				picker.setItems(treeItems(entries, tip, filter));
				return true;
			},
			onSelect: (item) => {
				if (item.value === tip) {
					this.#closePicker();
					this.#notice("info", "Already at this point.");
					return;
				}
				this.#askSummarize(item.value);
			},
			onCancel: () => this.#closePicker(),
		});
		this.#showPicker(picker);
	}

	/** Pi-style follow-up: keep a summary of the branch being left? */
	#askSummarize(target: TreeValue): void {
		const picker = new Picker<boolean>({
			title: "Summarize the branch you are leaving?",
			subtitle: "A summary keeps what was learned there in context (uses the model)",
			items: [
				{ value: false, label: "No summary", description: "just move" },
				{ value: true, label: "Summarize", description: "add a branch summary, then move" },
			],
			filter: false,
			labelShare: 0.3,
			onSelect: (item) => {
				this.#closePicker();
				void this.#run(() => this.#navigate(target, item.value));
			},
			onCancel: () => {
				this.#closePicker();
				void this.#run(() => this.#openTreePicker(target));
			},
		});
		this.#showPicker(picker);
	}

	async #navigate(target: TreeValue, summarize: boolean): Promise<void> {
		const s = this.#requireIdle();
		if (summarize) this.#setStatus("Summarizing the branch…");
		let result: Awaited<ReturnType<LilySession["navigate"]>>;
		try {
			result = await s.navigate(target, { summarize });
		} finally {
			this.#setStatus(undefined);
		}
		await this.#attach(s);
		if (result.editorText !== undefined) {
			if (!this.#editor.getText().trim()) this.#editor.setText(result.editorText);
			else this.#notice("info", "The editor was not empty, so the selected prompt was not copied into it.");
		}
		this.#notice("info", `moved to ${result.tipId ? result.tipId.slice(-8) : "the start"}${result.status !== "completed" ? ` (${result.status})` : ""} · workspace files were not rolled back`);
	}

	// ── setup (first run) ────────────────────────────────────────────────

	#showSetup(plan: SetupPlan): void {
		const screen = new SetupScreen({
			problem: plan.problem,
			available: plan.available,
			configPath: this.#runtime.home.config,
			offlineScript: plan.offline ? "demo" : undefined,
			maxVisible: this.#maxVisible(),
			onModel: (ref) =>
				void this.#run(async () => {
					const config = await loadConfig(this.#runtime.home);
					await saveConfig(this.#runtime.home, { ...config, model: ref });
					await this.#startWith(ref, `model ${ref} · saved as default in ${shortenPath(this.#runtime.home.config)}`);
				}),
			onOffline: () =>
				void this.#run(async () => {
					const ref = await plan.offline!();
					await this.#startWith(ref, "offline demo · a scripted model replays canned turns (nothing is sent anywhere)");
				}),
			onQuit: () => this.#quit(),
		});
		this.#showPicker(screen);
	}

	async #startWith(model: string, message: string): Promise<void> {
		const create = this.#options.newSession;
		if (!create) throw new Error("Cannot create a session");
		const session = await create(model);
		this.#closePicker();
		await this.#attach(session);
		this.#flushNotices();
		this.#notice("success", message);
		void this.#probeBackend();
		if (this.#options.initialPrompt) void this.#submit(this.#options.initialPrompt);
	}

	/** Checks the backend, then starts the environment in the background so the first prompt is fast. */
	async #probeBackend(): Promise<void> {
		const s = this.#session;
		if (!s) return;
		const name = s.binding.environment.spec.backend;
		try {
			const probe = await this.#runtime.envs.backend(name).probe();
			if (!probe.available) {
				this.#notice("warning", `Backend ${name} is not available${probe.reason ? `: ${probe.reason}` : ""}. Runs will fail until it is; try --backend local (no isolation).`);
				return;
			}
		} catch (error) {
			this.#notice("warning", `Backend ${name}: ${(error as Error).message}`);
			return;
		}
		if (s !== this.#session || s.busy || s.lease || this.#preparing) return;
		const preparing = s
			.prepare()
			.catch((error: Error) => {
				if (s === this.#session) this.#notice("warning", `Could not start the ${name} environment: ${error.message}`);
			})
			.finally(() => {
				if (this.#preparing === preparing) this.#preparing = undefined;
				this.#tui.requestRender();
			});
		this.#preparing = preparing;
	}

	/** Waits for a background warm-up; false when the user cancelled meanwhile. */
	async #afterWarmup(): Promise<boolean> {
		if (!this.#preparing) return true;
		const waiting = { cancelled: false };
		this.#waiting = waiting;
		this.#setStatus("Preparing the environment…");
		try {
			await this.#preparing;
		} finally {
			this.#waiting = undefined;
		}
		return !waiting.cancelled;
	}

	// ── input ────────────────────────────────────────────────────────────

	async #submit(raw: string): Promise<void> {
		const text = raw.trim();
		if (!text) return;
		this.#editor.addToHistory(raw);
		this.#editor.setText("");
		if (text.startsWith("/")) return this.#run(() => this.#command(text));
		if (text.startsWith("!")) return this.#run(() => this.#shell(text.slice(1).trim()));
		const s = this.#session;
		if (!s) return this.#notice("warning", "Pick a model first.");
		if (s.busy) {
			this.#queued.push(text);
			this.#renderPending();
			try {
				await s.steer(text);
			} catch (error) {
				this.#queued = this.#queued.filter((q) => q !== text);
				this.#renderPending();
				this.#notice("warning", (error as Error).message);
			}
			return;
		}
		this.#shownPrompt = text;
		this.#append(new UserMessageView(text));
		if (!(await this.#afterWarmup())) {
			this.#shownPrompt = undefined;
			this.#setStatus(undefined);
			this.#editor.setText(text);
			return this.#notice("info", "Not sent; the prompt is back in the editor.");
		}
		this.#setStatus(s.lease ? "Starting…" : "Preparing the environment…");
		try {
			const handle = await s.prompt(text);
			void handle.done.catch((error: Error) => this.#notice("error", error.message));
		} catch (error) {
			this.#shownPrompt = undefined;
			this.#setStatus(undefined);
			this.#notice("error", (error as Error).message);
		}
	}

	/** `!command`: runs in the session's environment without involving the model (Pi's `!`). */
	async #shell(command: string): Promise<void> {
		if (!command) throw new Error("!<command> runs a shell command in the environment; the model does not see it.");
		const s = this.#requireIdle();
		if (this.#shellAbort) throw new Error("A shell command is already running (Esc interrupts it).");
		if (!(await this.#afterWarmup())) return this.#setStatus(undefined);
		const view = this.#toolView("bash", `shell-${Date.now()}`, { command });
		view.local = true;
		this.#append(view);
		this.#setStatus(s.lease ? "Running…" : "Preparing the environment…");
		const abort = new AbortController();
		this.#shellAbort = abort;
		try {
			const result = await s.exec(command, { timeoutMs: 10 * 60_000, signal: abort.signal });
			const failed = result.exitCode !== 0 || result.timedOut || Boolean(result.signal);
			const tail = result.timedOut ? "(timed out)" : result.signal ? `(killed by ${result.signal})` : failed ? `exit ${result.exitCode}` : "";
			view.finish({ isError: failed, text: `${result.output}${tail ? `\n${tail}` : ""}`, meta: { durationMs: result.durationMs, exitCode: result.exitCode, capped: result.truncated } });
		} catch (error) {
			view.finish({ isError: true, text: abort.signal.aborted ? "interrupted" : (error as Error).message });
		} finally {
			this.#shellAbort = undefined;
			this.#setStatus(undefined);
		}
	}

	#slashCommands(): SlashCommand[] {
		const withArgs: Record<string, SlashCommand["getArgumentCompletions"]> = {
			model: async (prefix) => {
				const models = await this.#runtime.models.getAvailable();
				const q = prefix.toLowerCase();
				return models
					.map((m) => `${m.provider}/${m.id}`)
					.filter((ref) => ref.toLowerCase().includes(q))
					.slice(0, 30)
					.map((ref) => ({ value: ref, label: ref }));
			},
			thinking: (prefix) => ALL_THINKING.filter((l) => l.startsWith(prefix)).map((l) => ({ value: l, label: l, description: THINKING_DESCRIPTIONS[l] })),
			bundle: async (prefix) => {
				const refs = Object.keys(await this.#runtime.registry.refs());
				return ["none", ...(this.#runtime.router ? [ROUTED_BUNDLE] : []), ...refs].filter((r) => r.startsWith(prefix)).map((r) => ({ value: r, label: r }));
			},
		};
		return COMMANDS.map(({ name, description, argumentHint }) => ({
			name,
			...(description ? { description } : {}),
			...(argumentHint ? { argumentHint } : {}),
			...(withArgs[name] ? { getArgumentCompletions: withArgs[name] } : {}),
		}));
	}

	async #command(input: string): Promise<void> {
		const [typed = "", ...rest] = input.slice(1).split(/\s+/);
		const name = resolveCommandName(typed);
		const arg = rest.join(" ").trim();
		const spec = COMMANDS.find((cmd) => cmd.name === name);
		if (spec?.idleOnly) this.#requireIdle();
		const runtime = this.#runtime;
		switch (name) {
			case "help":
				return this.#help();
			case "quit":
			case "exit":
				return this.#quit();
			case "model":
				if (!arg) return this.#openModelPicker();
				this.#model(arg) ?? (() => {
					throw new Error(`Unknown model ${arg}. /model lists the available ones.`);
				})();
				return this.#selectModel(arg);
			case "thinking": {
				if (!arg) return this.#openThinkingPicker();
				if (!ALL_THINKING.includes(arg as ThinkingLevel)) throw new Error(`Thinking level must be one of ${ALL_THINKING.join(", ")}`);
				await this.#requireSession().setThinking(arg as ThinkingLevel);
				this.#header.set(this.#headerInfo());
				return this.#notice("success", `thinking ${arg}`);
			}
			case "bundle":
				if (!arg) return this.#openBundlePicker();
				return this.#bindBundle(arg === "none" ? null : arg);
			case "new": {
				const s = this.#requireSession();
				const next = this.#options.newSession
					? await this.#options.newSession(s.binding.model)
					: await runtime.createSession({
							mode: "interactive",
							model: s.binding.model,
							thinking: s.binding.thinking,
							bundle: s.binding.bundle,
							environment: runtime.defaultEnvironment(this.#cwd),
							workspaceLabel: this.#cwd,
						});
				if (next.binding.thinking !== s.binding.thinking) await next.setThinking(s.binding.thinking);
				await this.#switch(next);
				return this.#notice("info", `new session ${next.id.slice(-12)}`);
			}
			case "sessions":
				return this.#openSessionPicker();
			case "resume": {
				if (!arg) return this.#openSessionPicker();
				const matches = (await runtime.listSessions()).filter((x) => x.sessionId === arg || x.sessionId.endsWith(arg));
				if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous session ${arg}` : `No session matching ${arg}`);
				return this.#switch(await runtime.openSession(matches[0]!.sessionId));
			}
			case "tree":
				return this.#openTreePicker();
			case "goto": {
				const summarize = /(^|\s)--summarize(\s|$)/.test(arg);
				const id = arg.replace("--summarize", "").trim();
				if (!id) throw new Error("/goto <entry id> — or use /tree to pick one");
				const entry = (await this.#requireSession().allEntries()).find((e) => e.id === id || e.id.endsWith(id));
				if (!entry) throw new Error(`No entry matching ${id}`);
				return this.#navigate(entry.id, summarize);
			}
			case "fork":
			case "clone": {
				const s = this.#requireSession();
				let entryId: string | undefined;
				if (name === "fork" && arg) {
					entryId = (await s.allEntries()).find((e) => e.id === arg || e.id.endsWith(arg))?.id;
					if (!entryId) throw new Error(`No entry matching ${arg}`);
				}
				const forked = await runtime.forkSession(s.id, entryId ? { entryId, position: "before" } : {});
				await this.#switch(forked);
				return this.#notice("info", `${name === "fork" ? "forked" : "cloned"} into session ${forked.id.slice(-12)}`);
			}
			case "compact": {
				const s = this.#requireSession();
				this.#setStatus("Compacting context…");
				try {
					const result = await s.compact(arg || undefined);
					if (result.status !== "completed") this.#notice("warning", `Compaction ${result.status}`);
				} finally {
					this.#setStatus(undefined);
				}
				return;
			}
			case "env":
				return this.#showEnv();
			case "runs": {
				const s = this.#requireSession();
				const lines: string[] = [];
				for (const runId of s.binding.runs.slice(-15)) {
					const outcome = await new RunStore(runtime.home.run(runId)).readOutcome();
					const status = outcome ? (outcome.status === "completed" ? c.leaf(outcome.status) : c.warn(outcome.status)) : c.sun("running");
					lines.push(`${c.lavender(runId)}  ${status}${outcome ? c.muted(`  ${outcome.turns} turns · ${outcome.toolCalls} tools · ${formatDuration(outcome.endedAt - outcome.startedAt)}`) : ""}`);
				}
				return this.#block(lines.length ? lines : [c.muted("no runs yet")]);
			}
			case "export": {
				const s = this.#requireSession();
				const [runArg, file] = rest;
				const runId = runArg ? s.binding.runs.find((r) => r === runArg || r.endsWith(runArg)) : s.binding.runs.at(-1);
				if (!runId) throw new Error("No run to export");
				const path = file ?? `${runId}.traj.json`;
				await writeJsonAtomic(path, await exportRun(new RunStore(runtime.home.run(runId)), runtime.artifacts, { includeRaw: true }));
				return this.#notice("success", `exported ${runId} → ${path}`);
			}
			default:
				throw new Error(`Unknown command /${name}. Type /help for the list.`);
		}
	}

	#help(): void {
		const width = Math.max(...COMMANDS.map((cmd) => cmd.name.length + (cmd.argumentHint ? cmd.argumentHint.length + 1 : 0))) + 3;
		const lines = COMMANDS.map((cmd) => {
			const usage = `/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ""}`;
			return `${c.lavender(`/${cmd.name}`)}${cmd.argumentHint ? c.muted(` ${cmd.argumentHint}`) : ""}${" ".repeat(Math.max(2, width - usage.length))}${c.muted(cmd.description ?? "")}`;
		});
		const keys: Array<[string, string]> = [
			["enter", "send (while a run is active: steer it)"],
			["shift+enter / alt+enter", "new line"],
			["esc", "interrupt the run · close a picker"],
			["ctrl+c", "clear the editor · twice to exit"],
			["ctrl+d", "exit (empty editor)"],
			["ctrl+l", "select model"],
			["ctrl+o", "expand / collapse tool output"],
			["ctrl+t", "show / hide thinking"],
			["!command", "run a shell command in the environment (the model does not see it)"],
			["@", "reference a file"],
			["↑ / ↓", "prompt history"],
		];
		const keyWidth = Math.max(...keys.map(([k]) => k.length)) + 2;
		this.#block([
			c.bold("Commands"),
			...lines,
			"",
			c.bold("Keys"),
			...keys.map(([k, v]) => `${c.sage(k)}${" ".repeat(keyWidth - k.length)}${c.muted(v)}`),
		]);
	}

	#showEnv(): void {
		const s = this.#requireSession();
		const lease = s.lease;
		const spec = s.binding.environment.spec;
		if (!lease) {
			const isolation = this.#backendIsolation(spec.backend);
			return this.#block([
				`${c.bold(spec.backend)}${isolation ? c.muted(` · ${isolationLabel(isolation)}`) : ""} ${c.muted("· not started yet (it starts with the first run)")}`,
				c.muted(`workspace ${spec.initialState.kind}${"path" in spec.initialState && spec.initialState.path ? ` ${shortenPath(spec.initialState.path)}` : ""}`),
			]);
		}
		const i = lease.info;
		this.#block([
			`${c.bold(i.backend)}${c.muted(` · ${isolationLabel(i.isolation)} · ${i.envId}`)}`,
			`${c.muted("workspace")} ${i.paths.workspace}${i.initialState === "mount" ? c.muted(` (live mount of ${shortenPath(this.#cwd)})`) : c.muted(` (${i.initialState})`)}`,
			`${c.muted("resources")} ${i.paths.resources}`,
			`${c.muted("guest")}     ${i.guest.os}/${i.guest.arch} · envd ${i.guest.envdVersion}`,
		]);
	}

	async #switch(next: LilySession): Promise<void> {
		const previous = this.#session;
		if (previous && next.id === previous.id) return;
		await this.#attach(next);
		if (previous && !previous.busy) await this.#runtime.closeSession(previous.id, { destroyEnvironment: true });
		void this.#probeBackend();
	}
}
