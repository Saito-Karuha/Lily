import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

/** Text of a message content field (string or content parts). */
export function textParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((p: { type: string; text?: string }) => (p.type === "text" ? (p.text ?? "") : "")).join("");
}

/** Collapses whitespace and clips to `max` characters. */
export function oneLine(value: unknown, max = 120): string {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
}

/** Compact token counts: 950, 1.2k, 34k, 1.5M (adapted from Pi's footer, MIT). */
export function formatTokens(count: number): string {
	if (count < 1000) return String(Math.round(count));
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	return `${m}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

/** Relative age: now, 5m, 3h, 2d, 1w, 4mo, 1y (as in Pi's session picker). */
export function formatAge(timestamp: number, now = Date.now()): string {
	const mins = Math.floor((now - timestamp) / 60_000);
	if (mins < 1) return "now";
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

export function formatCost(cost: number): string {
	if (cost <= 0) return "$0";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

/** `~/…` for absolute paths inside the home directory; other paths unchanged. */
export function shortenPath(path: string | undefined): string {
	if (!path) return "";
	if (!isAbsolute(path)) return path;
	const home = homedir();
	const rel = relative(home, path);
	if (rel === "") return "~";
	if (!rel.startsWith("..") && !isAbsolute(rel)) return `~${sep}${rel}`;
	return path;
}

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g;

/**
 * Makes tool output safe to draw: strips terminal escape sequences and control
 * characters, resolves carriage-return progress lines, expands tabs.
 */
export function sanitizeOutput(text: string): string {
	return text
		.replace(ANSI_PATTERN, "")
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => {
			const cr = line.lastIndexOf("\r");
			const last = cr >= 0 ? line.slice(cr + 1) : line;
			return last.replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
		})
		.join("\n");
}

export const ISOLATION_LABELS: Record<string, string> = {
	none: "no isolation",
	"process-sandbox": "sandboxed",
	container: "container",
	"user-kernel": "gVisor",
	vm: "VM",
};

export function isolationLabel(level: string | undefined): string {
	return level ? (ISOLATION_LABELS[level] ?? level) : "";
}

/** Common provider API-key variables, for setup hints (pi-ai reads these). */
export const PROVIDER_KEY_HINTS: Array<{ provider: string; env: string; example: string }> = [
	{ provider: "anthropic", env: "ANTHROPIC_API_KEY", example: "anthropic/claude-sonnet-4-5" },
	{ provider: "openai", env: "OPENAI_API_KEY", example: "openai/gpt-5" },
	{ provider: "google", env: "GEMINI_API_KEY", example: "google/gemini-2.5-pro" },
	{ provider: "openrouter", env: "OPENROUTER_API_KEY", example: "openrouter/…" },
	{ provider: "deepseek", env: "DEEPSEEK_API_KEY", example: "deepseek/deepseek-chat" },
	{ provider: "groq", env: "GROQ_API_KEY", example: "groq/…" },
	{ provider: "xai", env: "XAI_API_KEY", example: "xai/grok-4" },
	{ provider: "mistral", env: "MISTRAL_API_KEY", example: "mistral/…" },
];
