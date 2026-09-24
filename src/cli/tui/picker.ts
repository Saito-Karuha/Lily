import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Input,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { c } from "../theme.ts";
import { hints } from "./style.ts";

export interface PickItem<T> {
	value: T;
	/** Primary text (may be styled). */
	label: string;
	/** Secondary text, shown muted in a second column. */
	description?: string;
	/** Text matched by the filter; defaults to label + description. */
	search?: string;
	/** Marked with ✓ (the current model, session, level…). */
	current?: boolean;
}

export interface PickerOptions<T> {
	title: string;
	subtitle?: string;
	items: PickItem<T>[] | Promise<PickItem<T>[]>;
	/** Initially selected item (defaults to the current one, else the first). */
	initial?: (item: PickItem<T>) => boolean;
	maxVisible?: number;
	onSelect: (item: PickItem<T>) => void;
	onCancel: () => void;
	/** Extra key hints before the standard ones. */
	hints?: Array<[string, string]>;
	/** A line under the list describing the selected item. */
	detail?: (item: PickItem<T>) => string | undefined;
	/** Handles extra keys (Tab…); return true when consumed. */
	onKey?: (data: string) => boolean;
	emptyText?: string;
	loadingText?: string;
	/** Type-to-filter (default true). */
	filter?: boolean;
	/** Labels get their own aligned column up to this share of the width. */
	labelShare?: number;
}

/**
 * A bordered list with type-to-filter, arrow navigation, Enter to select and
 * Esc to cancel: the building block of Lily's /model, /resume, /tree,
 * /thinking and /bundle pickers (layout after Pi's selectors).
 */
export class Picker<T> implements Component, Focusable {
	readonly #options: PickerOptions<T>;
	readonly #input: Input;
	#items: PickItem<T>[] = [];
	#filtered: PickItem<T>[] = [];
	#selected = 0;
	#loading = false;
	#status: { text: string; level: "info" | "error" } | undefined;
	#subtitle: string | undefined;
	#title: string;
	#focused = false;
	/** Tallest list drawn so far: filtering pads to it so the screen does not jump. */
	#rows = 0;

	constructor(options: PickerOptions<T>) {
		this.#options = options;
		this.#title = options.title;
		this.#subtitle = options.subtitle;
		this.#input = new Input({ prompt: `${c.lavender("›")} `, placeholder: "type to filter", placeholderStyle: (s) => c.muted(s) });
		if (Array.isArray(options.items)) this.setItems(options.items);
		else {
			this.#loading = true;
			void options.items.then(
				(items) => {
					this.#loading = false;
					this.setItems(items);
				},
				(error: Error) => {
					this.#loading = false;
					this.setStatus(error.message, "error");
				},
			);
		}
	}

	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		this.#input.focused = value;
	}

	selectedItem(): PickItem<T> | undefined {
		return this.#filtered[this.#selected];
	}

	setTitle(title: string, subtitle?: string): void {
		this.#title = title;
		this.#subtitle = subtitle;
	}

	setStatus(text: string | undefined, level: "info" | "error" = "info"): void {
		this.#status = text ? { text, level } : undefined;
	}

	/** Replaces the items, keeping the selection on the same value when possible. */
	setItems(items: PickItem<T>[], keep?: (item: PickItem<T>) => boolean): void {
		const previous = this.selectedItem();
		this.#items = items;
		this.#applyFilter();
		const want = keep ?? (previous ? (item: PickItem<T>) => item.value === previous.value : this.#options.initial ?? ((item: PickItem<T>) => Boolean(item.current)));
		const index = this.#filtered.findIndex(want);
		this.#selected = index >= 0 ? index : 0;
	}

	#applyFilter(): void {
		const query = this.#input.getValue().trim();
		this.#filtered =
			query && this.#options.filter !== false
				? fuzzyFilter(this.#items, query, (item) => item.search ?? stripTerminalSequences(`${item.label} ${item.description ?? ""}`))
				: this.#items;
		this.#selected = 0;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.#options.onKey?.(data)) return;
		const count = this.#filtered.length;
		const page = this.#options.maxVisible ?? 10;
		if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
			if (count) this.#selected = this.#selected === 0 ? count - 1 : this.#selected - 1;
		} else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
			if (count) this.#selected = this.#selected === count - 1 ? 0 : this.#selected + 1;
		} else if (matchesKey(data, "pageUp")) {
			this.#selected = Math.max(0, this.#selected - page);
		} else if (matchesKey(data, "pageDown")) {
			this.#selected = Math.min(Math.max(0, count - 1), this.#selected + page);
		} else if (matchesKey(data, "enter") || data === "\n") {
			const item = this.selectedItem();
			if (item) this.#options.onSelect(item);
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.#options.onCancel();
		} else if (this.#options.filter !== false) {
			const before = this.#input.getValue();
			this.#input.handleInput(data);
			if (this.#input.getValue() !== before) this.#applyFilter();
		}
	}

	render(width: number): string[] {
		const o = this.#options;
		const lines: string[] = [c.border("─".repeat(Math.max(1, width)))];
		lines.push(truncateToWidth(` ${c.bold(this.#title)}`, width, "…"));
		if (this.#subtitle) lines.push(truncateToWidth(` ${c.muted(this.#subtitle)}`, width, c.muted("…")));
		if (o.filter !== false) lines.push("", ` ${this.#input.render(Math.max(4, width - 2))[0] ?? ""}`);
		lines.push("");
		lines.push(...this.#renderList(width));
		const selected = this.selectedItem();
		const detail = selected ? o.detail?.(selected) : undefined;
		if (this.#status) lines.push("", truncateToWidth(` ${this.#status.level === "error" ? c.error(this.#status.text) : c.muted(this.#status.text)}`, width, "…"));
		else if (detail) lines.push("", truncateToWidth(` ${c.muted(detail)}`, width, "…"));
		else if (o.detail) lines.push("", "");
		const keys: Array<[string, string]> = [...(o.hints ?? []), ["↑↓", "move"], ["enter", "select"], ["esc", "cancel"]];
		lines.push("", truncateToWidth(` ${hints(keys)}`, width, "…"));
		lines.push(c.border("─".repeat(Math.max(1, width))));
		return lines;
	}

	#renderList(width: number): string[] {
		const lines = this.#listLines(width);
		this.#rows = Math.max(this.#rows, lines.length);
		while (lines.length < this.#rows) lines.push("");
		return lines;
	}

	#listLines(width: number): string[] {
		const o = this.#options;
		if (this.#loading) return [` ${c.muted(o.loadingText ?? "Loading…")}`];
		if (this.#filtered.length === 0) return [` ${c.muted(this.#items.length ? "No matches" : (o.emptyText ?? "Nothing to show"))}`];
		const maxVisible = Math.max(1, o.maxVisible ?? 10);
		const total = this.#filtered.length;
		const start = Math.max(0, Math.min(this.#selected - Math.floor(maxVisible / 2), total - maxVisible));
		const end = Math.min(total, start + maxVisible);
		const visible = this.#filtered.slice(start, end);
		const prefixWidth = 5;
		const widest = visible.reduce((w, item) => Math.max(w, visibleWidth(item.label)), 0);
		const share = o.labelShare ?? 0.45;
		const labelWidth = Math.max(8, Math.min(widest, Math.floor((width - prefixWidth) * share)));
		const lines: string[] = [];
		visible.forEach((item, i) => {
			const isSelected = start + i === this.#selected;
			const cursor = isSelected ? c.lavender("›") : " ";
			const mark = item.current ? c.leaf("✓") : " ";
			const plainLabel = truncateToWidth(item.label, item.description ? labelWidth : width - prefixWidth, "…");
			const label = isSelected ? c.bold(c.lavender(stripTerminalSequences(plainLabel))) : plainLabel;
			let line = ` ${cursor} ${mark} ${label}`;
			if (item.description) {
				const pad = " ".repeat(Math.max(2, labelWidth - visibleWidth(plainLabel) + 2));
				line += `${pad}${c.muted(item.description)}`;
			}
			lines.push(truncateToWidth(line, width, c.muted("…")));
		});
		if (start > 0 || end < total) lines.push(` ${c.muted(`  ${this.#selected + 1}/${total}`)}`);
		return lines;
	}
}
