import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { RunOutcome } from "../../store/runs.ts";
import { c } from "../theme.ts";
import { formatCost, formatDuration, formatTokens } from "./format.ts";
import { markdownTheme, thinkingMarkdownTheme } from "./style.ts";

/** Wraps `text` under a one-column glyph: first line gets `lead`, the rest `indent`. */
function hanging(text: string, width: number, lead: string, indent: string, style: (s: string) => string = (s) => s): string[] {
	const inner = Math.max(8, width - visibleWidth(lead));
	const out: string[] = [];
	for (const [i, line] of wrapTextWithAnsi(text, inner).entries()) out.push(truncateToWidth(`${i === 0 ? lead : indent}${style(line)}`, width));
	return out;
}

/** A single pre-styled line, truncated to the width. */
export class Line implements Component {
	#text: string;
	constructor(text = "") {
		this.#text = text;
	}
	setText(text: string): void {
		this.#text = text;
	}
	invalidate(): void {}
	render(width: number): string[] {
		return this.#text ? [truncateToWidth(this.#text, width)] : [];
	}
}

/** The user's prompt (or a steering message) in the transcript. */
export class UserMessageView implements Component {
	readonly text: string;
	readonly #kind: "prompt" | "steer";
	constructor(text: string, kind: "prompt" | "steer" = "prompt") {
		this.text = text;
		this.#kind = kind;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const lead = this.#kind === "steer" ? ` ${c.sage("↳")} ` : ` ${c.bold(c.lavender("›"))} `;
		const body = this.text.replace(/\t/g, "    ").replace(/\s+$/, "");
		return ["", ...hanging(body, width, lead, "   ", this.#kind === "steer" ? c.sage : (s) => s)];
	}
}

export type NoticeLevel = "info" | "warning" | "error" | "success";

export class NoticeView implements Component {
	readonly #level: NoticeLevel;
	readonly #message: string;
	constructor(level: NoticeLevel, message: string) {
		this.#level = level;
		this.#message = message;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const glyph = { info: c.muted("·"), warning: c.warn("!"), error: c.error("✗"), success: c.leaf("✓") }[this.#level];
		const style = { info: c.muted, warning: c.warn, error: c.error, success: c.muted }[this.#level];
		return ["", ...hanging(this.#message, width, ` ${glyph} `, "   ", style)];
	}
}

interface Block {
	kind: "text" | "thinking";
	text: string;
	md?: Markdown;
}

/**
 * One assistant message: markdown text blocks and collapsible thinking, updated
 * live from deltas and replaced by the final message at `message_end`.
 */
export class AssistantView implements Component {
	readonly #blocks = new Map<number, Block>();
	readonly #thinkingExpanded: () => boolean;
	#streaming = true;
	#footer: string | undefined;

	constructor(thinkingExpanded: () => boolean, message?: AssistantMessage) {
		this.#thinkingExpanded = thinkingExpanded;
		if (message) this.setMessage(message);
	}

	get hasContent(): boolean {
		for (const block of this.#blocks.values()) if (block.text.trim()) return true;
		return Boolean(this.#footer);
	}

	appendDelta(kind: "text" | "thinking", index: number, delta: string): void {
		let block = this.#blocks.get(index);
		if (!block) {
			block = { kind, text: "" };
			this.#blocks.set(index, block);
		}
		block.text += delta;
		block.md?.setText(block.text.trim());
	}

	setMessage(message: AssistantMessage): void {
		this.#streaming = false;
		this.#blocks.clear();
		message.content.forEach((part, index) => {
			if (part.type === "text" && part.text.trim()) this.#blocks.set(index, { kind: "text", text: part.text });
			else if (part.type === "thinking" && part.thinking.trim()) this.#blocks.set(index, { kind: "thinking", text: part.thinking });
		});
		const hasToolCalls = message.content.some((part) => part.type === "toolCall");
		if (message.stopReason === "error") this.#footer = c.error(`✗ ${message.errorMessage || "The model returned an error"}`);
		else if (message.stopReason === "length") this.#footer = c.warn("! Response was cut off (output token limit)");
		else if (message.stopReason === "aborted" && !hasToolCalls) this.#footer = c.warn("⊘ Interrupted");
	}

	invalidate(): void {
		for (const block of this.#blocks.values()) block.md?.invalidate();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const ordered = [...this.#blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
		for (const block of ordered) {
			const text = block.text.trim();
			if (!text) continue;
			lines.push("");
			if (block.kind === "text") {
				block.md ??= new Markdown(text, 1, 0, markdownTheme);
				lines.push(...block.md.render(width));
			} else lines.push(...this.#renderThinking(block, text, width));
		}
		if (this.#footer) lines.push("", truncateToWidth(` ${this.#footer}`, width));
		return lines;
	}

	#renderThinking(block: Block, text: string, width: number): string[] {
		const count = text.split("\n").length;
		if (!this.#thinkingExpanded()) {
			const label = this.#streaming
				? `${c.lavender("∴")} ${c.italic(c.muted(`thinking… ${text.split("\n").at(-1)!.replace(/\s+/g, " ")}`))}`
				: `${c.lavender("∴")} ${c.italic(c.muted(`thought · ${count} line${count === 1 ? "" : "s"}`))}  ${c.muted("ctrl+t to show")}`;
			return [truncateToWidth(` ${label}`, width)];
		}
		block.md ??= new Markdown(text, 0, 0, thinkingMarkdownTheme, { color: (s) => c.muted(s), italic: true });
		const body = block.md.render(Math.max(10, width - 4)).map((line) => truncateToWidth(` ${c.muted("│")}  ${line}`, width));
		return [truncateToWidth(` ${c.lavender("∴")} ${c.italic(c.muted("thinking"))}`, width), ...body];
	}
}

/** Summary line printed when a run ends. */
export class RunFooterView implements Component {
	readonly #outcome: RunOutcome;
	constructor(outcome: RunOutcome) {
		this.#outcome = outcome;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const o = this.#outcome;
		const status =
			o.status === "completed"
				? c.leaf("✓ done")
				: o.status === "aborted"
					? c.warn(`⊘ cancelled${o.reason && o.reason !== "user_cancelled" ? ` (${o.reason})` : ""}`)
					: c.error(`✗ ${o.status}${o.reason ? ` (${o.reason})` : ""}`);
		const parts = [`${o.turns} turn${o.turns === 1 ? "" : "s"}`, `${o.toolCalls} tool${o.toolCalls === 1 ? "" : "s"}`, formatDuration(o.endedAt - o.startedAt)];
		if (o.usage.input || o.usage.output) parts.push(`↑${formatTokens(o.usage.input + o.usage.cacheRead + o.usage.cacheWrite)} ↓${formatTokens(o.usage.output)}`);
		if (o.usage.cost > 0) parts.push(formatCost(o.usage.cost));
		const lines = ["", truncateToWidth(` ${status}${c.muted(` · ${parts.join(" · ")}`)}`, width)];
		if (o.error && o.status !== "completed") lines.push(...hanging(o.error, width, "   ", "   ", c.error));
		return lines;
	}
}
