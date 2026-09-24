/**
 * Lily's terminal palette, taken from its visual identity: deep olive / forest
 * ink, soft lily lavender, pollen amber and a rust accent on cream paper.
 *
 * The terminal background is unknown (and often wrong when guessed), so every
 * accent is a mid-luminance tone (relative luminance ≈ 0.2) that keeps a
 * contrast ratio of ≥ 3:1 against black, dark gray, white and cream paper
 * alike. Body text uses the terminal's default foreground, which is readable
 * by construction; "dim" uses the SGR faint attribute so it adapts to both
 * dark and light themes. Terminals without truecolor get hand-picked 256-color
 * equivalents. Set NO_COLOR to disable colors.
 */
const env = process.env;
const NO_COLOR = Boolean(env.NO_COLOR) || (!process.stdout.isTTY && !env.FORCE_COLOR);
const TRUECOLOR =
	env.COLORTERM === "truecolor" ||
	env.COLORTERM === "24bit" ||
	["iterm.app", "wezterm", "ghostty", "vscode", "kitty", "alacritty", "zed", "warpterminal"].includes((env.TERM_PROGRAM ?? "").toLowerCase()) ||
	Boolean(env.KITTY_WINDOW_ID || env.WT_SESSION || env.GHOSTTY_RESOURCES_DIR || env.ITERM_SESSION_ID);

/** Palette: truecolor hex plus the closest balanced 256-color index. */
export const PALETTE = {
	/** Lily lavender: the mark, focus, links, selection. */
	lavender: { hex: "#8A76BA", x256: 97 },
	/** Olive leaf: success, headings, the prompt glyph. */
	leaf: { hex: "#6E8B4E", x256: 65 },
	/** Forest ink wash: borders and rules. */
	forest: { hex: "#6F7F62", x256: 242 },
	/** Sage: secondary emphasis. */
	sage: { hex: "#7C9068", x256: 101 },
	/** Pollen amber: running, warnings, inline code. */
	sun: { hex: "#A07D34", x256: 136 },
	/** Rust: errors and removed lines. */
	error: { hex: "#C0634F", x256: 131 },
	/** Warm gray: metadata. */
	muted: { hex: "#7D8475", x256: 243 },
} as const;

type Style = (text: string) => string;

function hexRgb(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function fg(color: { hex: string; x256: number }): Style {
	if (NO_COLOR) return (text) => text;
	const [r, g, b] = hexRgb(color.hex);
	const open = TRUECOLOR ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${color.x256}m`;
	return (text) => `${open}${text}\x1b[39m`;
}

function sgr(open: number, close: number): Style {
	if (NO_COLOR) return (text) => text;
	return (text) => `\x1b[${open}m${text}\x1b[${close}m`;
}

const identity: Style = (text) => text;

export const c = {
	/** Default terminal foreground (readable on any background). */
	text: identity,
	/** Kept for older call sites: primary text is the default foreground. */
	cream: identity,
	lavender: fg(PALETTE.lavender),
	accent: fg(PALETTE.lavender),
	leaf: fg(PALETTE.leaf),
	success: fg(PALETTE.leaf),
	forest: fg(PALETTE.forest),
	border: fg(PALETTE.forest),
	sage: fg(PALETTE.sage),
	sun: fg(PALETTE.sun),
	warn: fg(PALETTE.sun),
	error: fg(PALETTE.error),
	muted: fg(PALETTE.muted),
	bold: sgr(1, 22),
	dim: sgr(2, 22),
	italic: sgr(3, 23),
	underline: sgr(4, 24),
	inverse: sgr(7, 27),
	strike: sgr(9, 29),
};

export const LILY_MARK = "❦";
export const LILY_TAGLINE = "Let good ideas run.";
