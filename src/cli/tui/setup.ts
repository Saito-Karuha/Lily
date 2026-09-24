import type { Api, Model } from "@earendil-works/pi-ai";
import { type Component, type Focusable, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { c, LILY_MARK } from "../theme.ts";
import { PROVIDER_KEY_HINTS, shortenPath } from "./format.ts";
import { Picker, type PickItem } from "./picker.ts";
import { modelItems } from "./pickers.ts";

export type SetupProblem = { kind: "missing" } | { kind: "unknown"; model: string } | { kind: "no-credentials"; model: string; env?: string };

export interface SetupOptions {
	problem: SetupProblem;
	/** Models whose providers have credentials. */
	available: readonly Model<Api>[];
	configPath: string;
	/** Bundled offline script, when present. */
	offlineScript: string | undefined;
	maxVisible: number;
	onModel(ref: string): void;
	onOffline(): void;
	onQuit(): void;
}

const OFFLINE = "\u0000offline";
const QUIT = "\u0000quit";

/**
 * First-run screen: shown instead of failing when no usable model is
 * configured. Lists models with credentials (the pick becomes the default),
 * otherwise explains how to add an API key or a self-hosted endpoint, and
 * offers the offline scripted demo.
 */
export class SetupScreen implements Component, Focusable {
	readonly #options: SetupOptions;
	readonly #picker: Picker<string>;
	#focused = false;

	constructor(options: SetupOptions) {
		this.#options = options;
		const actions: PickItem<string>[] = [];
		if (options.offlineScript) actions.push({ value: OFFLINE, label: c.sage("Try the offline demo"), description: "scripted model, no API key needed" });
		actions.push({ value: QUIT, label: c.muted("Quit"), description: "set up a provider and run lily again" });
		const hasModels = options.available.length > 0;
		this.#picker = new Picker<string>({
			title: hasModels ? "Choose a model to start" : "What next?",
			subtitle: hasModels ? `Providers with credentials in your environment · saved as the default in ${shortenPath(options.configPath)}` : undefined,
			items: [...modelItems(options.available, undefined, undefined), ...actions],
			maxVisible: options.maxVisible,
			filter: hasModels,
			onSelect: (item) => {
				if (item.value === OFFLINE) options.onOffline();
				else if (item.value === QUIT) options.onQuit();
				else options.onModel(item.value);
			},
			onCancel: () => options.onQuit(),
		});
	}

	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		this.#picker.focused = value;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		this.#picker.handleInput(data);
	}

	#intro(): string[] {
		const o = this.#options;
		const p = o.problem;
		const why =
			p.kind === "missing"
				? "No model is configured yet."
				: p.kind === "unknown"
					? `The configured model ${c.bold(p.model)} is not known to any provider.`
					: `The configured model ${c.bold(p.model)} has no credentials${p.env ? ` (set ${c.sun(p.env)})` : ""}.`;
		const lines = [`${c.lavender(LILY_MARK)} ${c.bold("Welcome to lily.")} ${why}`];
		if (o.available.length > 0) return lines;
		const others = PROVIDER_KEY_HINTS.slice(1, 3).map((h) => h.env).join(", ");
		lines.push(
			"",
			"No API key found in the environment. Set one, then start lily again:",
			`    ${c.sun("export ANTHROPIC_API_KEY=sk-ant-…")}  ${c.muted(`(or ${others}, …)`)}`,
			`Self-hosted OpenAI-compatible server? Add it to ${c.bold(shortenPath(o.configPath))}:`,
			...[
				'{ "model": "local/my-model",',
				'  "providers": { "local": {',
				'    "api": "openai-completions", "baseUrl": "http://localhost:8000/v1",',
				'    "models": [{ "id": "my-model" }] } } }',
			].map((l) => `    ${c.sage(l)}`),
			`No model at all? ${c.sun("lily --script demo")} runs an offline scripted model.`,
		);
		return lines;
	}

	render(width: number): string[] {
		const out: string[] = [""];
		for (const line of this.#intro()) {
			if (!line) out.push("");
			else for (const wrapped of wrapTextWithAnsi(line, Math.max(10, width - 2))) out.push(truncateToWidth(` ${wrapped}`, width));
		}
		out.push("");
		out.push(...this.#picker.render(width));
		return out;
	}
}
