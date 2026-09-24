import { existsSync } from "node:fs";
import { opendir, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	fuzzyMatch,
	type SlashCommand,
} from "@earendil-works/pi-tui";

/** `fd` (or Debian's `fdfind`) on PATH, which pi-tui uses for fast `@` file search. */
export function findFd(): string | null {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		for (const name of ["fd", "fdfind"]) {
			const candidate = join(dir, name);
			if (dir && existsSync(candidate)) return candidate;
		}
	}
	return null;
}

const ALWAYS_IGNORED = new Set([".git", ".hg", ".svn", "node_modules", ".DS_Store", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".next", ".turbo", ".cache"]);
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 12;
const INDEX_TTL_MS = 15_000;

interface FileEntry {
	path: string;
	name: string;
	isDirectory: boolean;
	depth: number;
}

/** Simple top-level .gitignore rules: plain names, `dir/`, `/name` and `*.ext`. */
async function ignoreRules(root: string): Promise<(name: string, rel: string) => boolean> {
	const names = new Set<string>();
	const anchored = new Set<string>();
	const suffixes: string[] = [];
	const text = await readFile(join(root, ".gitignore"), "utf8").catch(() => "");
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith("!")) continue;
		const clean = line.replace(/\/+$/, "");
		if (/^\*\.[^*/?[\]]+$/.test(clean)) suffixes.push(clean.slice(1));
		else if (clean.startsWith("/") && !/[*?[\]]/.test(clean)) anchored.add(clean.slice(1));
		else if (!/[*?[\]/]/.test(clean)) names.add(clean);
	}
	return (name, rel) => ALWAYS_IGNORED.has(name) || names.has(name) || anchored.has(rel) || suffixes.some((s) => name.endsWith(s));
}

/** Breadth-first listing of `root`, bounded in size and depth. */
async function indexFiles(root: string): Promise<FileEntry[]> {
	const ignored = await ignoreRules(root);
	const out: FileEntry[] = [];
	const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: "", depth: 0 }];
	while (queue.length && out.length < MAX_ENTRIES) {
		const { dir, rel, depth } = queue.shift()!;
		let handle: Awaited<ReturnType<typeof opendir>>;
		try {
			handle = await opendir(dir);
		} catch {
			continue;
		}
		for await (const entry of handle) {
			const path = rel ? `${rel}/${entry.name}` : entry.name;
			if (ignored(entry.name, path)) continue;
			const isDirectory = entry.isDirectory();
			out.push({ path, name: entry.name, isDirectory, depth });
			if (isDirectory && depth < MAX_DEPTH) queue.push({ dir: join(dir, entry.name), rel: path, depth: depth + 1 });
			if (out.length >= MAX_ENTRIES) break;
		}
	}
	return out;
}

function score(entry: FileEntry, query: string): number {
	if (!query) return entry.depth === 0 ? 20 : 1;
	const q = query.toLowerCase();
	const name = entry.name.toLowerCase();
	const path = entry.path.toLowerCase();
	let s = 0;
	if (q.includes("/")) {
		if (path.startsWith(q)) s = 90;
		else if (path.includes(q)) s = 40;
		else if (fuzzyMatch(q, path).matches) s = 5;
	} else if (name === q) s = 100;
	else if (name.startsWith(q)) s = 80;
	else if (name.includes(q)) s = 50;
	else if (path.includes(q)) s = 30;
	else if (fuzzyMatch(q, name).matches) s = 10;
	else if (fuzzyMatch(q, path).matches) s = 3;
	return s > 0 && entry.isDirectory ? s + 5 : s;
}

function atPrefix(textBeforeCursor: string): string | null {
	const match = textBeforeCursor.match(/(?:^|[\s"'=])(@(?:"[^"]*|[^\s]*))$/);
	return match ? match[1]! : null;
}

/**
 * Slash commands (with argument completion) and `@` file references. File
 * search uses `fd` when it is installed, otherwise a built-in bounded index of
 * the working directory (so `@` works on a fresh machine too).
 */
export class LilyAutocompleteProvider implements AutocompleteProvider {
	readonly triggerCharacters = ["@"];
	readonly #inner: CombinedAutocompleteProvider;
	readonly #useFd: boolean;
	readonly #root: string;
	#index: { at: number; entries: Promise<FileEntry[]> } | undefined;

	constructor(commands: SlashCommand[], root: string, fdPath: string | null = findFd()) {
		this.#inner = new CombinedAutocompleteProvider(commands, root, fdPath);
		this.#useFd = fdPath !== null;
		this.#root = root;
	}

	/** Starts indexing in the background so the first `@` is instant. */
	warm(): void {
		if (!this.#useFd) void this.#entries();
	}

	#entries(): Promise<FileEntry[]> {
		if (!this.#index || Date.now() - this.#index.at > INDEX_TTL_MS) this.#index = { at: Date.now(), entries: indexFiles(this.#root).catch(() => []) };
		return this.#index.entries;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		if (!this.#useFd) {
			const prefix = atPrefix((lines[cursorLine] ?? "").slice(0, cursorCol));
			if (prefix !== null) {
				const quoted = prefix.startsWith('@"');
				const query = prefix.slice(quoted ? 2 : 1);
				if (query.startsWith("/") || query.startsWith("~")) return this.#inner.getSuggestions(lines, cursorLine, cursorCol, options);
				const entries = await this.#entries();
				if (options.signal.aborted) return null;
				const ranked = entries
					.map((entry) => ({ entry, s: score(entry, query) }))
					.filter((r) => r.s > 0)
					.sort((a, b) => b.s - a.s || a.entry.depth - b.entry.depth || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path))
					.slice(0, 20);
				if (ranked.length === 0) return null;
				const items: AutocompleteItem[] = ranked.map(({ entry }) => {
					const target = entry.isDirectory ? `${entry.path}/` : entry.path;
					const value = quoted || target.includes(" ") ? `@"${target}"` : `@${target}`;
					return { value, label: entry.name + (entry.isDirectory ? "/" : ""), description: entry.path };
				});
				return { items, prefix };
			}
		}
		return this.#inner.getSuggestions(lines, cursorLine, cursorCol, options);
	}

	applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
		return this.#inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		return this.#inner.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
	}
}
