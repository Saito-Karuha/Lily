import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { LilyAutocompleteProvider } from "../../src/cli/tui/autocomplete.ts";
import { diffStats, renderDiffLines } from "../../src/cli/tui/diff.ts";
import { Footer, type FooterState, spread } from "../../src/cli/tui/footer.ts";
import { formatAge, formatTokens, sanitizeOutput } from "../../src/cli/tui/format.ts";
import { Header } from "../../src/cli/tui/header.ts";
import { AssistantView, NoticeView, RunFooterView, UserMessageView } from "../../src/cli/tui/messages.ts";
import { Picker } from "../../src/cli/tui/picker.ts";
import { plainPreview, treeItems } from "../../src/cli/tui/pickers.ts";
import { ToolView } from "../../src/cli/tui/tool-view.ts";
import { resolveCommandName } from "../../src/cli/tui.ts";

const plain = (lines: string[]) => lines.map((l) => stripTerminalSequences(l));
const WIDTHS = [20, 41, 80, 100, 160];

function expectFits(render: (width: number) => string[]) {
	for (const width of WIDTHS) for (const line of render(width)) expect(visibleWidth(line), `width ${width}: ${JSON.stringify(stripTerminalSequences(line))}`).toBeLessThanOrEqual(width);
}

let seq = 0;
function msg(id: string, parentId: string | null, role: "user" | "assistant" | "toolResult", text: string, extra: Record<string, unknown> = {}): Entry {
	const content = role === "toolResult" ? [{ type: "text", text }] : text ? [{ type: "text", text }] : [];
	return { id, parentId, seq: ++seq, timestamp: Date.now(), type: "message", message: { role, content, ...extra } } as unknown as Entry;
}

describe("commands", () => {
	it("recovers names mangled by a stale slash completion", () => {
		expect(resolveCommandName("eenv")).toBe("env");
		expect(resolveCommandName("hehelp")).toBe("help");
		expect(resolveCommandName("tree")).toBe("tree");
		expect(resolveCommandName("nope")).toBe("nope");
	});
});

describe("formatting", () => {
	it("formats tokens and ages compactly", () => {
		expect(formatTokens(950)).toBe("950");
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(128_000)).toBe("128k");
		expect(formatTokens(1_000_000)).toBe("1.0M");
		expect(formatAge(Date.now() - 5 * 60_000)).toBe("5m");
		expect(formatAge(Date.now() - 3 * 86_400_000)).toBe("3d");
	});

	it("makes tool output safe to draw", () => {
		expect(sanitizeOutput("\x1b[31mred\x1b[0m\tx\n10%\r50%\r100%\x07")).toBe("red    x\n100%");
	});

	it("flattens markdown for one-line previews", () => {
		expect(plainPreview("Fixed `nme` → **name**.\n\n```py\nprint(1)\n```\n- a [link](http://x)", 200)).toBe("Fixed nme → name. print(1) a link");
	});
});

describe("tree", () => {
	// root user → assistant → (branch) user "b1" → assistant ; user "b2" (current)
	const entries = [
		msg("u1", null, "user", "first question"),
		msg("a1", "u1", "assistant", "First answer"),
		msg("u2", "a1", "user", "branch one"),
		msg("a2", "u2", "assistant", "", { content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }] }),
		msg("r2", "a2", "toolResult", "out", { toolCallId: "t1", toolName: "bash" }),
		msg("u3", "a1", "user", "branch two"),
	];

	it("draws branches with connectors and marks the current position", () => {
		const rows = treeItems(entries, "u3", "conversation").map((item) => stripTerminalSequences(item.label));
		expect(rows[0]).toContain("(start of conversation)");
		expect(rows).toContain("• user: first question");
		expect(rows).toContain("• assistant: First answer");
		// The branch containing the current position comes first.
		expect(rows[3]).toBe("├─ ◆ user: branch two");
		expect(rows[4]).toBe("└─ user: branch one");
		// Tool-only assistant messages and tool results are hidden in the conversation view.
		expect(rows.some((r) => r.includes("[bash: ls]"))).toBe(false);
	});

	it("shows tool results under the all filter and only prompts under user", () => {
		const all = treeItems(entries, "u3", "all").map((item) => stripTerminalSequences(item.label));
		expect(all.some((r) => r.includes("[bash: ls]"))).toBe(true);
		expect(all.some((r) => r.includes("(tool calls: bash)"))).toBe(true);
		const users = treeItems(entries, "u3", "user").map((item) => stripTerminalSequences(item.label));
		expect(users.filter((r) => r.includes("assistant:"))).toEqual([]);
	});
});

describe("diff", () => {
	const diff = " 1 def greet(name):\n-2     return 'Hello ' + nme\n+2     return f'Hello {name}!'\n 3";
	it("colors changed lines and counts them", () => {
		expect(diffStats(diff)).toEqual({ added: 1, removed: 1 });
		const lines = plain(renderDiffLines(diff));
		expect(lines[1]).toBe("-2     return 'Hello ' + nme");
		expect(lines[2]).toBe("+2     return f'Hello {name}!'");
	});
});

describe("tool view", () => {
	const view = (name: string, args: unknown, expanded = false) => new ToolView(name, "id", args, { expanded: () => expanded, frame: () => "⠋" });

	it("keeps the tail of long bash output and hints at ctrl+o", () => {
		const v = view("bash", { command: "seq 1 20" });
		v.finish({ isError: false, text: Array.from({ length: 20 }, (_, i) => String(i + 1)).join("\n") });
		const lines = plain(v.render(80));
		expect(lines[1]).toContain("$ seq 1 20");
		expect(lines.some((l) => l.includes("15 earlier lines · ctrl+o to expand"))).toBe(true);
		expect(lines.at(-1)).toContain("20");
		const expanded = view("bash", { command: "seq 1 20" }, true);
		expanded.finish({ isError: false, text: Array.from({ length: 20 }, (_, i) => String(i + 1)).join("\n") });
		expect(plain(expanded.render(80)).filter((l) => /│ \d+$/.test(l))).toHaveLength(20);
	});

	it("summarizes edits with a diff and counts", () => {
		const v = view("edit", { path: "app.py", edits: [{ oldText: "a", newText: "b" }] });
		v.finish({ isError: false, text: "ok", diff: "-1 a\n+1 b" });
		const lines = plain(v.render(80));
		expect(lines[1]).toContain("edit app.py +1 -1");
		expect(lines).toContain("   │ -1 a");
	});

	it("never renders wider than the terminal", () => {
		const long = "x".repeat(300);
		for (const [name, args, text] of [
			["bash", { command: `echo ${long}\nsecond line` }, `${long}\n${"界".repeat(200)}`],
			["read", { path: `/${long}/file.ts`, offset: 10, limit: 5 }, long],
			["write", { path: "a.txt", content: `${long}\n${long}` }, ""],
			["custom_tool", { deep: { value: long } }, long],
		] as const) {
			const running = view(name, args);
			running.update(text);
			expectFits((w) => running.render(w));
			const done = view(name, args, true);
			done.finish({ isError: name === "custom_tool", text });
			expectFits((w) => done.render(w));
		}
	});
});

describe("transcript components", () => {
	it("collapses thinking unless expanded", () => {
		let expanded = false;
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "step one\nstep two" },
				{ type: "text", text: "Answer **bold**" },
			],
			stopReason: "stop",
		} as unknown as AssistantMessage;
		const v = new AssistantView(() => expanded, message);
		expect(plain(v.render(80)).join("\n")).toContain("thought · 2 lines");
		expanded = true;
		const open = plain(v.render(80)).join("\n");
		expect(open).toContain("step one");
		expect(open).toContain("Answer bold");
	});

	it("streams deltas and shows errors", () => {
		const v = new AssistantView(() => false);
		v.appendDelta("text", 0, "Hel");
		v.appendDelta("text", 0, "lo");
		expect(plain(v.render(40)).join("\n")).toContain("Hello");
		v.setMessage({ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" } as unknown as AssistantMessage);
		expect(plain(v.render(40)).join("\n")).toContain("✗ rate limited");
	});

	it("fits every component in narrow terminals", () => {
		const long = "word ".repeat(80);
		expectFits((w) => new UserMessageView(long).render(w));
		expectFits((w) => new NoticeView("warning", long).render(w));
		expectFits((w) =>
			new RunFooterView({ runId: "r", status: "failed", reason: "x", error: long, startedAt: 0, endedAt: 1234, turns: 3, toolCalls: 2, modelCalls: 3, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: 0.5 } }).render(w),
		);
		expectFits((w) => new Header({ version: "v0.1.0", model: `provider/${long}`, thinking: "high", bundle: long, backend: "seatbelt", isolation: "process-sandbox", cwd: `/tmp/${long}` }).render(w));
		const state: FooterState = {
			cwd: `/tmp/${"deep/".repeat(30)}`,
			title: long,
			model: "anthropic/claude-sonnet-4-5",
			contextWindow: 200_000,
			reasoning: true,
			thinking: "medium",
			bundle: "base",
			backend: "seatbelt",
			isolation: "process-sandbox",
			envStatus: "provisioning",
			usage: { input: 12_000, output: 3400, cacheRead: 1000, cacheWrite: 0, cost: 0.0123 },
			contextTokens: 150_000,
			busy: true,
			frame: "⠋",
		};
		expectFits((w) => new Footer(() => state).render(w));
		expect(stripTerminalSequences(spread("left", "right", 20))).toBe(`left${" ".repeat(11)}right`);
	});
});

describe("picker", () => {
	it("filters, navigates and selects", () => {
		let chosen: string | undefined;
		let cancelled = false;
		const picker = new Picker<string>({
			title: "Pick",
			items: ["alpha", "beta", "gamma"].map((value) => ({ value, label: value, description: `the ${value}`, current: value === "beta" })),
			onSelect: (item) => {
				chosen = item.value;
			},
			onCancel: () => {
				cancelled = true;
			},
		});
		expect(picker.selectedItem()?.value).toBe("beta");
		picker.handleInput("\x1b[B");
		expect(picker.selectedItem()?.value).toBe("gamma");
		for (const ch of "alp") picker.handleInput(ch);
		expect(plain(picker.render(60)).some((l) => l.includes("gamma"))).toBe(false);
		picker.handleInput("\r");
		expect(chosen).toBe("alpha");
		picker.handleInput("\x1b");
		expect(cancelled).toBe(true);
		expectFits((w) => picker.render(w));
	});
});

describe("@ file completion without fd", () => {
	it("finds files by name anywhere in the tree and skips ignored directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "lily-ac-"));
		await mkdir(join(root, "src", "utils"), { recursive: true });
		await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
		await writeFile(join(root, "src", "utils", "strings.ts"), "");
		await writeFile(join(root, "node_modules", "pkg", "strings.js"), "");
		await writeFile(join(root, ".gitignore"), "build/\n*.log\n");
		await mkdir(join(root, "build"));
		await writeFile(join(root, "build", "strings.out"), "");
		await writeFile(join(root, "strings.log"), "");
		const provider = new LilyAutocompleteProvider([], root, null);
		const line = "look at @stri";
		const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
		expect(result?.prefix).toBe("@stri");
		expect(result?.items.map((i) => i.value)).toEqual(["@src/utils/strings.ts"]);
		const applied = provider.applyCompletion([line], 0, line.length, result!.items[0]!, result!.prefix);
		expect(applied.lines[0]).toBe("look at @src/utils/strings.ts ");
	});
});
