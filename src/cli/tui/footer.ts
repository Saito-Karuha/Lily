import { basename, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { c } from "../theme.ts";
import { formatCost, formatTokens, isolationLabel, shortenPath } from "./format.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface FooterState {
	cwd: string;
	title?: string;
	model?: string;
	contextWindow?: number;
	reasoning?: boolean;
	thinking?: string;
	bundle?: string;
	backend?: string;
	isolation?: string;
	envStatus: "idle" | "provisioning" | "ready" | "lost";
	usage: UsageTotals;
	/** Tokens in the model's context after the last response; null when unknown (after compaction). */
	contextTokens: number | null;
	busy: boolean;
	frame: string;
}

/** Left and right segments on one line; the left side is truncated first. */
export function spread(left: string, right: string, width: number): string {
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	if (!right) return truncateToWidth(left, width, c.muted("…"));
	if (lw + 2 + rw <= width) return `${left}${" ".repeat(width - lw - rw)}${right}`;
	if (rw + 12 <= width) {
		const l = truncateToWidth(left, width - rw - 2, c.muted("…"));
		return `${l}${" ".repeat(Math.max(2, width - visibleWidth(l) - rw))}${right}`;
	}
	return truncateToWidth(right, width, c.muted("…"));
}

/** Two-line status bar under the editor (layout after Pi's footer). */
export class Footer implements Component {
	readonly #state: () => FooterState;
	constructor(state: () => FooterState) {
		this.#state = state;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const s = this.#state();
		const inner = Math.max(10, width - 2);
		if (!s.model) return [` ${truncateToWidth(c.muted(shortenPath(s.cwd)), inner, c.muted("…"))}`, ` ${c.warn("no model yet")}`];
		const title = s.title ? ` • ${s.title.replace(/\s+/g, " ")}` : "";
		let where = `${shortenPath(s.cwd)}${title}`;
		// Keep the session title visible: a long directory shrinks to its last component first.
		if (title && visibleWidth(where) > inner - 40) where = `…${sep}${basename(s.cwd)}${title}`;
		const envState =
			s.envStatus === "provisioning" ? c.warn(" starting…") : s.envStatus === "lost" ? c.error(" lost") : s.envStatus === "ready" ? c.leaf(" ●") : "";
		const env = s.backend ? `${c.muted(`${s.backend}${s.isolation ? ` (${isolationLabel(s.isolation)})` : ""}`)}${envState}` : "";
		const bundle = s.bundle ? c.muted(`bundle ${s.bundle}`) : c.muted("no bundle");
		const line1 = spread(c.muted(where), [bundle, env].filter(Boolean).join(c.muted(" · ")), inner);

		const stats: string[] = [];
		const u = s.usage;
		if (u.input + u.cacheRead + u.cacheWrite) stats.push(`↑${formatTokens(u.input + u.cacheRead + u.cacheWrite)}`);
		if (u.output) stats.push(`↓${formatTokens(u.output)}`);
		if (u.cacheRead) stats.push(`R${formatTokens(u.cacheRead)}`);
		if (u.cost > 0) stats.push(formatCost(u.cost));
		let left = stats.length ? c.muted(stats.join(" ")) : "";
		if (s.contextWindow) {
			const pct = s.contextTokens === null ? undefined : (100 * s.contextTokens) / s.contextWindow;
			const text = `ctx ${pct === undefined ? "?" : `${pct.toFixed(pct < 10 ? 1 : 0)}%`}/${formatTokens(s.contextWindow)}`;
			const colored = pct !== undefined && pct > 90 ? c.error(text) : pct !== undefined && pct > 70 ? c.warn(text) : c.muted(text);
			left = left ? `${left}${c.muted(" · ")}${colored}` : colored;
		}
		if (s.busy) left = `${c.sun(s.frame)} ${left}`;
		const thinking = s.thinking && s.thinking !== "off" ? c.lavender(`• ${s.thinking}`) : s.reasoning ? c.muted("• thinking off") : "";
		const right = s.model ? `${c.muted(s.model)}${thinking ? ` ${thinking}` : ""}` : c.warn("no model");
		const line2 = spread(left, right, inner);
		return [` ${line1}`, ` ${line2}`];
	}
}
