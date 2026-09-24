import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { c, LILY_MARK, LILY_TAGLINE } from "../theme.ts";
import { isolationLabel, shortenPath } from "./format.ts";
import { hint } from "./style.ts";

export interface HeaderInfo {
	version: string;
	model?: string;
	thinking?: string;
	bundle?: string;
	backend?: string;
	isolation?: string;
	cwd: string;
	/** Shown instead of the session line (first-run setup). */
	note?: string;
}

const KEY_HINTS: Array<[string, string]> = [
	["/", "commands"],
	["@", "files"],
	["esc", "interrupt"],
	["ctrl+l", "model"],
	["ctrl+o", "expand"],
	["ctrl+t", "thinking"],
	["ctrl+c ×2", "exit"],
];

/** Compact welcome block: mark and version, what this session runs on, key hints. */
export class Header implements Component {
	#info: HeaderInfo;
	constructor(info: HeaderInfo) {
		this.#info = info;
	}
	set(info: HeaderInfo): void {
		this.#info = info;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const i = this.#info;
		// The setup screen brings its own welcome line.
		if (i.note) return [];
		const title = ` ${c.lavender(LILY_MARK)} ${c.bold("lily")} ${c.muted(i.version)}  ${c.sage(LILY_TAGLINE)}`;
		const lines = ["", truncateToWidth(title, width)];
		{
			const parts = [
				i.model ? i.model : c.warn("no model"),
				`thinking ${i.thinking ?? "off"}`,
				i.bundle ? `bundle ${i.bundle}` : "no bundle",
				i.backend ? `${i.backend}${i.isolation ? ` (${isolationLabel(i.isolation)})` : ""}` : "",
			].filter(Boolean);
			lines.push(truncateToWidth(`   ${c.muted(parts.join(" · "))}`, width, c.muted("…")));
			lines.push(truncateToWidth(`   ${c.muted(shortenPath(i.cwd))}`, width, c.muted("…")));
			// Key hints wrap onto as many lines as the width needs.
			let current = "   ";
			for (const [key, action] of KEY_HINTS) {
				const piece = hint(key, action);
				const sep = current.trim() ? c.muted(" · ") : "";
				if (visibleWidth(current) + visibleWidth(sep) + visibleWidth(piece) > width && current.trim()) {
					lines.push(current);
					current = `   ${piece}`;
				} else current += sep + piece;
			}
			if (current.trim()) lines.push(truncateToWidth(current, width));
		}
		return lines;
	}
}
