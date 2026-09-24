// Records the landing-page demo from the real Lily TUI and converts it for the player.
//
//   npm run record-demo                  record (python3 + pty) and convert
//   npm run record-demo -- --convert     only re-convert demo/session.cast
//
// 1. scripts/record-demo.py drives `lily --script …` in a pseudo-terminal following
//    demo/storyboard.json and writes demo/session.cast (asciicast v2, raw bytes + timing).
// 2. This script replays the cast through a headless xterm and snapshots the screen after
//    each burst of output. Screens become rows of styled runs, deduplicated into a line
//    table, so a frame is just a list of line ids: demo/demo.json.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";

const { Terminal } = xterm;
const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STORYBOARD = join(SITE, "demo/storyboard.json");
const CAST = join(SITE, "demo/session.cast");
const OUT = join(SITE, "demo/demo.json");

const FRAME_GAP = 1 / 50; // merge output bursts closer than this (seconds)

// Inverse video on default colours swaps the player's own colours (set in CSS).
const DEFAULT_FG = "var(--term-fg)";
const DEFAULT_BG = "var(--term-bg)";
// ANSI 0–15, tuned to the site's palette; 16–255 are the standard xterm cube and greys.
const BASE16 = ["#2b3326", "#d27a68", "#9fbd87", "#d9c27e", "#8fa9c0", "#bf9bb8", "#8fbcb2", "#d6d6c4", "#6a7462", "#e59a88", "#b7d69f", "#e8d69a", "#a9c1d6", "#d3b2cc", "#a8d3c9", "#f4f2e6"];
function paletteColor(n) {
	if (n < 16) return BASE16[n];
	if (n < 232) {
		const i = n - 16;
		const level = (v) => (v === 0 ? 0 : 55 + v * 40);
		return hex((level(Math.floor(i / 36)) << 16) | (level(Math.floor(i / 6) % 6) << 8) | level(i % 6));
	}
	const g = 8 + (n - 232) * 10;
	return hex((g << 16) | (g << 8) | g);
}
const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;

function record() {
	const result = spawnSync("python3", [join(SITE, "scripts/record-demo.py"), STORYBOARD, CAST], { stdio: "inherit" });
	if (result.error) throw new Error(`could not run python3: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`recording failed (exit ${result.status})`);
}

/** Replaces the local user name and home path (they show up in `ls -la`, paths, …). */
function redactor() {
	const user = (() => {
		try {
			return userInfo().username;
		} catch {
			return "";
		}
	})();
	const home = homedir();
	return (text) => {
		let out = text;
		if (home && home.length > 1) out = out.split(home).join("~");
		if (user && user.length >= 3) {
			// Same width, so `ls -l` columns stay aligned.
			const stand = "lily".padEnd(user.length, " ").slice(0, Math.max(user.length, 4));
			out = out.replace(new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), stand);
		}
		return out;
	};
}

async function convert() {
	const board = JSON.parse(readFileSync(STORYBOARD, "utf8"));
	const [headerLine, ...eventLines] = readFileSync(CAST, "utf8").split("\n").filter(Boolean);
	const header = JSON.parse(headerLine);
	const cols = header.width;
	const rows = header.height;
	const idleLimit = board.idleLimit ?? 1.2;
	const redact = redactor();

	// Output events with idle gaps capped (like asciinema's idle_time_limit).
	const events = [];
	let last = 0;
	let clock = 0;
	for (const line of eventLines) {
		const [t, kind, data] = JSON.parse(line);
		if (kind !== "o") continue;
		clock += Math.min(t - last, idleLimit);
		last = t;
		events.push([clock, data]);
	}
	if (!events.length) throw new Error("the cast has no output");

	const term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true, convertEol: false });
	const write = (data) => new Promise((done) => term.write(data, done));

	const styles = [{}];
	const styleIds = new Map([["{}", 0]]);
	const lines = [];
	const lineIds = new Map();
	const frames = [];
	let cursorVisible = true;
	let lastKey = "";
	const cell = term.buffer.active.getNullCell();

	const colorOf = (value, rgb, palette) => (rgb ? hex(value) : palette ? paletteColor(value) : null);

	const styleId = (c) => {
		let fg = colorOf(c.getFgColor(), c.isFgRGB(), c.isFgPalette());
		let bg = colorOf(c.getBgColor(), c.isBgRGB(), c.isBgPalette());
		if (c.isBold() && c.isFgPalette() && c.getFgColor() < 8) fg = paletteColor(c.getFgColor() + 8);
		if (c.isInverse()) [fg, bg] = [bg ?? DEFAULT_BG, fg ?? DEFAULT_FG];
		const k = [c.isBold() && "b", c.isItalic() && "i", c.isUnderline() && "u", c.isStrikethrough() && "s", c.isDim() && "d", c.isInvisible() && "h"].filter(Boolean).join(" ");
		const css = [fg && `color:${fg}`, bg && `background:${bg}`].filter(Boolean).join(";");
		const style = {};
		if (css) style.c = css;
		if (k) style.k = k;
		const key = JSON.stringify(style);
		let id = styleIds.get(key);
		if (id === undefined) {
			id = styles.length;
			styles.push(style);
			styleIds.set(key, id);
		}
		return id;
	};

	const serializeLine = (y) => {
		const line = term.buffer.active.getLine(y);
		const runs = [];
		if (line) {
			for (let x = 0; x < cols; x++) {
				line.getCell(x, cell);
				if (cell.getWidth() === 0) continue; // second half of a wide character
				const chars = cell.getChars() || " ";
				const id = styleId(cell);
				const lastRun = runs[runs.length - 1];
				if (lastRun && lastRun[1] === id) lastRun[0] += chars;
				else runs.push([chars, id]);
			}
		}
		// Trailing blanks in the default style carry no information.
		while (runs.length) {
			const lastRun = runs[runs.length - 1];
			const style = styles[lastRun[1]];
			if (style.c?.includes("background")) break;
			const trimmed = lastRun[0].replace(/\s+$/, "");
			if (trimmed) {
				lastRun[0] = trimmed;
				break;
			}
			runs.pop();
		}
		for (const run of runs) run[0] = redact(run[0]);
		const key = JSON.stringify(runs);
		let id = lineIds.get(key);
		if (id === undefined) {
			id = lines.length;
			lines.push(runs);
			lineIds.set(key, id);
		}
		return id;
	};

	const snapshot = (t) => {
		if (term.modes.synchronizedOutputMode) return; // mid-frame: the TUI will finish it
		const buffer = term.buffer.active;
		const ids = [];
		for (let y = 0; y < rows; y++) ids.push(serializeLine(buffer.viewportY + y));
		const frame = [Math.round(t * 1000) / 1000, ids, buffer.cursorX, buffer.cursorY, cursorVisible ? 1 : 0];
		const key = JSON.stringify(frame.slice(1));
		if (key === lastKey) return;
		lastKey = key;
		frames.push(frame);
	};

	serializeLine(-1); // line 0 = empty
	for (let i = 0; i < events.length; i++) {
		const [t, data] = events[i];
		for (const m of data.matchAll(/\x1b\[\?25([hl])/g)) cursorVisible = m[1] === "h";
		await write(data);
		const next = events[i + 1];
		if (!next || next[0] - t >= FRAME_GAP) snapshot(t);
	}
	const hold = board.hold ?? 2; // keep the final screen up for a moment before "ended"
	const duration = Math.round((events[events.length - 1][0] + hold) * 1000) / 1000;

	const out = { v: 1, title: board.title ?? header.title ?? "lily", cols, rows, duration, recordedAt: new Date((header.timestamp ?? Date.now() / 1000) * 1000).toISOString(), styles, lines, frames };
	writeFileSync(OUT, `${JSON.stringify(out)}\n`);
	const kb = (Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(0);
	console.log(`record-demo: wrote demo/demo.json — ${frames.length} frames, ${lines.length} unique lines, ${styles.length} styles, ${duration.toFixed(1)}s, ${kb} KB`);
}

const convertOnly = process.argv.includes("--convert");
try {
	if (!convertOnly) record();
	await convert();
	console.log("record-demo: run `npm run build` to publish it into dist/");
} catch (error) {
	console.error(`record-demo: ${error.message}`);
	process.exit(1);
}
