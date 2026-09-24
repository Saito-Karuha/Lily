import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import { c } from "../theme.ts";

/** Markdown styling for assistant text. */
export const markdownTheme: MarkdownTheme = {
	heading: (t) => c.bold(c.leaf(t)),
	link: (t) => c.underline(c.lavender(t)),
	linkUrl: (t) => c.muted(t),
	code: (t) => c.sun(t),
	codeBlock: (t) => t,
	codeBlockBorder: (t) => c.muted(t),
	quote: (t) => c.italic(c.sage(t)),
	quoteBorder: (t) => c.muted(t),
	hr: (t) => c.muted(t),
	listBullet: (t) => c.leaf(t),
	bold: (t) => c.bold(t),
	italic: (t) => c.italic(t),
	strikethrough: (t) => c.strike(t),
	underline: (t) => c.underline(t),
};

/** Muted italic variant for expanded thinking blocks. */
export const thinkingMarkdownTheme: MarkdownTheme = {
	...markdownTheme,
	heading: (t) => c.italic(c.muted(c.bold(t))),
	code: (t) => c.muted(t),
	codeBlock: (t) => c.muted(t),
	listBullet: (t) => c.muted(t),
};

export const selectListTheme: SelectListTheme = {
	selectedPrefix: (t) => c.lavender(t),
	selectedText: (t) => c.bold(c.lavender(t)),
	description: (t) => c.muted(t),
	scrollInfo: (t) => c.muted(t),
	noMatch: (t) => c.muted(t),
};

export const editorTheme: EditorTheme = {
	borderColor: (s) => c.border(s),
	selectList: selectListTheme,
};

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** `key action` pair for hint lines. */
export function hint(key: string, action: string): string {
	return `${c.sage(key)} ${c.muted(action)}`;
}

export function hints(pairs: Array<[string, string]>, separator = c.muted(" · ")): string {
	return pairs.map(([key, action]) => hint(key, action)).join(separator);
}
