import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { LilyToolMeta } from "../../kernel/gateway.ts";
import { c } from "../theme.ts";
import { diffStats, renderDiffLines } from "./diff.ts";
import { formatDuration, oneLine, sanitizeOutput, shortenPath } from "./format.ts";

const PREVIEW_LINES = 5;
const DIFF_PREVIEW_LINES = 16;
const EXPANDED_MAX_LINES = 400;

type Args = Record<string, unknown>;

function str(value: unknown): string {
	return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function lineCount(text: string): number {
	const trimmed = text.replace(/\n+$/, "");
	return trimmed ? trimmed.split("\n").length : 0;
}

/**
 * One tool call, drawn like Pi's tool cards: a header line with the tool and a
 * summary of its arguments, then a short preview of live output, the result or
 * the diff. Long bodies collapse; Ctrl+O expands every card.
 */
export class ToolView implements Component {
	readonly toolName: string;
	readonly toolCallId: string;
	args: Args;
	status: "running" | "ok" | "error" = "running";
	output = "";
	diff: string | undefined;
	meta: Partial<LilyToolMeta> | undefined;
	/** A `!command` run by the user, not by the model. */
	local = false;
	readonly startedAt = Date.now();
	endedAt: number | undefined;
	readonly #expanded: () => boolean;
	readonly #frame: () => string;
	/** Rendered lines keyed by everything they depend on (the transcript re-renders every spinner frame). */
	#cache: { key: string; lines: string[] } | undefined;

	constructor(toolName: string, toolCallId: string, args: unknown, options: { expanded: () => boolean; frame: () => string }) {
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = (args && typeof args === "object" ? args : {}) as Args;
		this.#expanded = options.expanded;
		this.#frame = options.frame;
	}

	/** Live output while the tool runs. */
	update(text: string): void {
		this.output = text;
	}

	finish(result: { isError: boolean; text: string; diff?: string; meta?: Partial<LilyToolMeta> }): void {
		this.status = result.isError ? "error" : "ok";
		this.output = result.text;
		if (result.diff) this.diff = result.diff;
		if (result.meta) this.meta = result.meta;
		this.endedAt = Date.now();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const expanded = this.#expanded();
		const live = this.status === "running" ? `${this.#frame()}|${Math.floor((Date.now() - this.startedAt) / 1000)}` : "";
		const key = `${width}|${expanded}|${this.status}|${this.output.length}|${this.output.slice(-64)}|${this.diff?.length ?? 0}|${live}`;
		if (this.#cache?.key === key) return this.#cache.lines;
		const lines = ["", this.#header(width)];
		// Expanded output wraps long lines; collapsed previews keep one row per line.
		const wrap = expanded;
		const inner = Math.max(10, width - 5);
		for (const line of this.#body()) {
			for (const piece of wrap && visibleWidth(line) > inner ? wrapTextWithAnsi(line, inner) : [line]) lines.push(truncateToWidth(`   ${c.border("│")} ${piece}`, width, c.muted("…")));
		}
		this.#cache = { key, lines };
		return lines;
	}

	#title(): string {
		const a = this.args;
		const path = shortenPath(str(a.path ?? a.file_path));
		switch (this.toolName) {
			case "bash": {
				const command = str(a.command).trim();
				const [first = "", ...rest] = command.split("\n");
				const lead = this.local ? c.lavender("!") : "$";
				return `${c.bold(`${lead} ${first}`)}${rest.length ? c.muted(` (+${rest.length} line${rest.length === 1 ? "" : "s"})`) : ""}${a.timeout ? c.muted(` · timeout ${a.timeout}s`) : ""}${this.local ? c.muted(" · not sent to the model") : ""}`;
			}
			case "read": {
				const offset = typeof a.offset === "number" ? a.offset : undefined;
				const limit = typeof a.limit === "number" ? a.limit : undefined;
				const range = offset !== undefined || limit !== undefined ? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}` : "";
				return `${c.bold("read")} ${c.lavender(path)}${c.muted(range)}`;
			}
			case "edit": {
				let stats = "";
				if (this.diff) {
					const { added, removed } = diffStats(this.diff);
					stats = ` ${c.leaf(`+${added}`)} ${c.error(`-${removed}`)}`;
				} else if (Array.isArray(a.edits)) stats = c.muted(` · ${a.edits.length} edit${a.edits.length === 1 ? "" : "s"}`);
				return `${c.bold("edit")} ${c.lavender(path)}${stats}`;
			}
			case "write": {
				const n = lineCount(str(a.content));
				return `${c.bold("write")} ${c.lavender(path)}${c.muted(` · ${n} line${n === 1 ? "" : "s"}`)}`;
			}
			default:
				return `${c.bold(this.toolName)} ${c.muted(oneLine(this.args, 200))}`;
		}
	}

	#header(width: number): string {
		const glyph = this.status === "running" ? c.sun(this.#frame()) : this.status === "ok" ? c.leaf("●") : c.error("●");
		const elapsed = (this.endedAt ?? Date.now()) - this.startedAt;
		const duration = this.meta?.durationMs ?? elapsed;
		const metaParts: string[] = [];
		if (this.status === "running" ? elapsed >= 1000 : duration >= 500) metaParts.push(formatDuration(duration));
		if (this.status === "error" && typeof this.meta?.exitCode === "number") metaParts.push(`exit ${this.meta.exitCode}`);
		if (this.meta?.capped) metaParts.push("output capped");
		const meta = metaParts.length ? (this.status === "error" ? c.error(metaParts.join(" · ")) : c.muted(metaParts.join(" · "))) : "";
		const left = ` ${glyph} `;
		const metaWidth = visibleWidth(meta);
		const titleRoom = Math.max(4, width - visibleWidth(left) - (metaWidth ? metaWidth + 2 : 0));
		const title = truncateToWidth(this.#title(), titleRoom, c.muted("…"));
		if (!meta) return truncateToWidth(`${left}${title}`, width);
		const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(title) - metaWidth);
		return truncateToWidth(`${left}${title}${" ".repeat(gap)}${meta}`, width);
	}

	#body(): string[] {
		const expanded = this.#expanded();
		if (this.local && this.status === "running") return [];
		if (this.status === "error") return this.#errorBody(expanded);
		if (this.toolName === "edit" && this.diff && this.status === "ok") return this.#collapse(renderDiffLines(this.diff), expanded, DIFF_PREVIEW_LINES, "head", "diff lines");
		if (this.toolName === "write") {
			if (this.status === "running") return [];
			const content = sanitizeOutput(str(this.args.content)).replace(/\n+$/, "");
			if (!content) return [c.muted("(empty file)")];
			return this.#collapse(content.split("\n").map((l) => c.muted(l)), expanded, PREVIEW_LINES, "head", "lines");
		}
		if (this.toolName === "read") {
			if (this.status === "running") return [];
			const text = sanitizeOutput(this.output).replace(/\n+$/, "");
			const n = lineCount(text);
			if (!expanded) return [c.muted(`${n} line${n === 1 ? "" : "s"} · ctrl+o to show`)];
			return this.#collapse(text.split("\n").map((l) => c.muted(l)), true, PREVIEW_LINES, "head", "lines");
		}
		const text = sanitizeOutput(this.output).replace(/\s+$/, "");
		if (!text) return this.status === "ok" && this.toolName === "bash" ? [c.muted("(no output)")] : [];
		const lines = text.split("\n").map((l) => c.muted(l));
		return this.#collapse(lines, expanded && this.status !== "running", PREVIEW_LINES, "tail", "lines");
	}

	#errorBody(expanded: boolean): string[] {
		const text = sanitizeOutput(this.output).replace(/\s+$/, "");
		if (!text) return [c.error("failed")];
		const lines = text.split("\n");
		// Command output stays muted; the final line (the error or exit status) is in rust.
		const styled = lines.map((l, i) => (i === lines.length - 1 || this.toolName !== "bash" ? c.error(l) : c.muted(l)));
		return this.#collapse(styled, expanded, 8, "tail", "lines");
	}

	#collapse(lines: string[], expanded: boolean, preview: number, keep: "head" | "tail", unit: string): string[] {
		if (expanded) {
			if (lines.length <= EXPANDED_MAX_LINES) return lines;
			return [...lines.slice(0, EXPANDED_MAX_LINES), c.muted(`… ${lines.length - EXPANDED_MAX_LINES} more ${unit} (see /export for the full record)`)];
		}
		if (lines.length <= preview + 1) return lines;
		const hidden = lines.length - preview;
		const note = c.muted(`… ${hidden} ${keep === "tail" ? "earlier" : "more"} ${unit} · ctrl+o to expand`);
		return keep === "tail" ? [note, ...lines.slice(-preview)] : [...lines.slice(0, preview), note];
	}
}
