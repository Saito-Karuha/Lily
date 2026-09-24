import type { Entry } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionSummary } from "../../runtime/runtime.ts";
import { c } from "../theme.ts";
import { formatAge, formatTokens, oneLine, shortenPath, textParts } from "./format.ts";
import type { PickItem } from "./picker.ts";

// ── models ──────────────────────────────────────────────────────────────────

export function modelItems(models: readonly Model<Api>[], current: string | undefined, defaultModel: string | undefined): PickItem<string>[] {
	const ref = (m: Model<Api>) => `${m.provider}/${m.id}`;
	const rank = (m: Model<Api>) => (ref(m) === current ? 0 : ref(m) === defaultModel ? 1 : 2);
	return [...models]
		.sort((a, b) => rank(a) - rank(b) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
		.map((m) => ({
			value: ref(m),
			label: m.id,
			description: `${m.provider}${ref(m) === defaultModel ? " · default" : ""}${m.contextWindow ? ` · ${formatTokens(m.contextWindow)} ctx` : ""}${m.reasoning ? " · reasoning" : ""}`,
			search: `${m.provider}/${m.id} ${m.name}${ref(m) === defaultModel ? " default" : ""}`,
			current: ref(m) === current,
		}));
}

// ── sessions ────────────────────────────────────────────────────────────────

export function sessionItems(sessions: SessionSummary[], currentId: string | undefined, now = Date.now()): PickItem<string>[] {
	return sessions.map((s) => ({
		value: s.sessionId,
		label: oneLine(s.title ?? "(untitled)", 80),
		description: [formatAge(s.updatedAt, now), `${s.runs} run${s.runs === 1 ? "" : "s"}`, shortenPath(s.workspaceLabel)].filter(Boolean).join(" · "),
		search: `${s.title ?? ""} ${s.workspaceLabel ?? ""} ${s.sessionId}`,
		current: s.sessionId === currentId,
	}));
}

// ── conversation tree ───────────────────────────────────────────────────────

export type TreeFilter = "conversation" | "user" | "all";
export const TREE_FILTERS: TreeFilter[] = ["conversation", "user", "all"];

/** `value` is the entry id; null is the start of the conversation. */
export type TreeValue = string | null;

interface ToolCallInfo {
	name: string;
	args: Record<string, unknown>;
}

/** Markdown source flattened for a one-line preview (fences, backticks, emphasis removed). */
export function plainPreview(text: string, max: number): string {
	return oneLine(
		text
			.replace(/```[^\n]*\n?/g, " ")
			.replace(/`([^`]*)`/g, "$1")
			.replace(/(\*\*|__)(.*?)\1/g, "$2")
			.replace(/^\s*(#+|[-*+]|\d+\.)\s+/gm, "")
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"),
		max,
	);
}

function toolCallLabel(call: ToolCallInfo | undefined, fallback: string): string {
	if (!call) return `[${fallback}]`;
	const a = call.args;
	const target = call.name === "bash" ? oneLine(a.command ?? "", 50) : shortenPath(String(a.path ?? a.file_path ?? ""));
	return `[${call.name}: ${target}]`;
}

function entryText(entry: Entry, calls: Map<string, ToolCallInfo>): { text: string; kind: "user" | "assistant" | "tools" | "result" | "meta" } {
	if (entry.type === "compaction") return { text: c.sun(`[compaction · ${formatTokens(entry.tokensBefore)} tokens summarized]`), kind: "meta" };
	if (entry.type === "branch_summary") return { text: `${c.sun("[branch summary]")} ${oneLine(entry.summary, 160)}`, kind: "meta" };
	if (entry.type === "custom") return { text: c.muted(`[${entry.customType}]`), kind: "meta" };
	const message = entry.message as { role: string; content?: unknown; stopReason?: string; errorMessage?: string; toolCallId?: string; toolName?: string };
	if (message.role === "user") return { text: `${c.lavender("user:")} ${oneLine(textParts(message.content), 200)}`, kind: "user" };
	if (message.role === "assistant") {
		const text = plainPreview(textParts(message.content), 200);
		if (text) return { text: `${c.leaf("assistant:")} ${text}`, kind: "assistant" };
		if (message.stopReason === "aborted") return { text: `${c.leaf("assistant:")} ${c.muted("(interrupted)")}`, kind: "assistant" };
		if (message.errorMessage) return { text: `${c.leaf("assistant:")} ${c.error(oneLine(message.errorMessage, 120))}`, kind: "assistant" };
		const names = Array.isArray(message.content) ? message.content.filter((p: { type: string }) => p.type === "toolCall").map((p: { name: string }) => p.name) : [];
		return { text: `${c.leaf("assistant:")} ${c.muted(`(tool calls: ${names.join(", ") || "none"})`)}`, kind: "tools" };
	}
	if (message.role === "toolResult") return { text: c.muted(toolCallLabel(calls.get(message.toolCallId ?? ""), message.toolName ?? "tool")), kind: "result" };
	return { text: c.muted(`[${message.role}]`), kind: "meta" };
}

function visibleIn(filter: TreeFilter, kind: ReturnType<typeof entryText>["kind"]): boolean {
	if (filter === "all") return true;
	if (filter === "user") return kind === "user";
	return kind === "user" || kind === "assistant" || kind === "meta";
}

/**
 * Flattens the session tree into picker rows with branch connectors, the
 * active path marked • and the current position marked ◆ (after Pi's /tree).
 * Single-child chains stay flat; children of a branch point are indented.
 */
export function treeItems(entries: Entry[], tipId: string | null, filter: TreeFilter): PickItem<TreeValue>[] {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const children = new Map<string | null, Entry[]>();
	const calls = new Map<string, ToolCallInfo>();
	for (const e of entries) {
		const parent = e.parentId && byId.has(e.parentId) ? e.parentId : null;
		children.set(parent, [...(children.get(parent) ?? []), e]);
		if (e.type === "message" && e.message.role === "assistant" && Array.isArray(e.message.content)) {
			for (const part of e.message.content) if (part.type === "toolCall") calls.set(part.id, { name: part.name, args: (part.arguments ?? {}) as Record<string, unknown> });
		}
	}
	const active = new Set<string>();
	for (let id = tipId; id; id = byId.get(id)?.parentId ?? null) active.add(id);
	const containsActive = (e: Entry) => active.has(e.id);
	const order = (list: Entry[]) => [...list].sort((a, b) => Number(containsActive(b)) - Number(containsActive(a)) || a.seq - b.seq);

	const items: PickItem<TreeValue>[] = [
		{ value: null, label: `${tipId === null ? `${c.sun("◆")} ` : ""}${c.muted("(start of conversation)")}`, search: "start root beginning" },
	];
	// gutters[i] = whether ancestor branch column i continues below this row.
	const stack: Array<{ entry: Entry; indent: number; connector: "├─ " | "└─ " | ""; gutters: boolean[] }> = [];
	const roots = order(children.get(null) ?? []);
	for (let i = roots.length - 1; i >= 0; i--) {
		const last = i === roots.length - 1;
		stack.push(roots.length > 1 ? { entry: roots[i]!, indent: 1, connector: last ? "└─ " : "├─ ", gutters: [!last] } : { entry: roots[i]!, indent: 0, connector: "", gutters: [] });
	}
	while (stack.length) {
		const { entry, indent, connector, gutters } = stack.pop()!;
		const { text, kind } = entryText(entry, calls);
		if (visibleIn(filter, kind) || entry.id === tipId) {
			let prefix = "";
			for (let i = 0; i < indent - (connector ? 1 : 0); i++) prefix += gutters[i] ? "│  " : "   ";
			prefix += connector;
			const marker = entry.id === tipId ? `${c.sun("◆")} ` : active.has(entry.id) ? `${c.leaf("•")} ` : "";
			items.push({
				value: entry.id,
				label: `${c.muted(prefix)}${marker}${text}`,
				search: `${kind} ${textParts((entry as { message?: { content?: unknown } }).message?.content)} ${entry.type === "branch_summary" ? entry.summary : ""}`,
			});
		}
		const kids = order(children.get(entry.id) ?? []);
		const branching = kids.length > 1;
		const childIndent = branching ? indent + 1 : indent;
		for (let i = kids.length - 1; i >= 0; i--) {
			const last = i === kids.length - 1;
			const childGutters = branching ? [...gutters.slice(0, indent), !last] : gutters;
			stack.push({ entry: kids[i]!, indent: childIndent, connector: branching ? (last ? "└─ " : "├─ ") : "", gutters: childGutters });
		}
	}
	return items;
}

/** One-line description of a tree entry for the picker's detail line. */
export function treeDetail(entry: Entry | undefined, now = Date.now()): string {
	if (!entry) return "Enter: go back to an empty conversation";
	const age = formatAge(entry.timestamp, now);
	const when = age === "now" ? "just now" : `${age} ago`;
	const id = entry.id.slice(-8);
	if (entry.type === "message" && entry.message.role === "user") return `${id} · ${when} · Enter goes back to just before this prompt and puts it in the editor`;
	return `${id} · ${when} · Enter continues the conversation from here`;
}
