import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type AgentHarnessTool,
	BACKGROUND_CONTEXT,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExecutionToolContext,
	type JsonValue,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EnvironmentLease } from "../../src/env/types.ts";
import { baselineObservation } from "../../src/kernel/tools/baseline.ts";
import { executeRaw } from "../../src/kernel/tools/raw.ts";
import type { KernelToolName } from "../../src/kernel/tools/specs.ts";
import { localEnvironment, tempDir } from "../helpers/env.ts";

const ctx = BACKGROUND_CONTEXT;
let dir: string;
let lease: EnvironmentLease;
let piEnv: NodeExecutionEnv;

const piTools: Record<KernelToolName, AgentHarnessTool<ExecutionToolContext>> = {
	read: createReadTool() as AgentHarnessTool<ExecutionToolContext>,
	write: createWriteTool() as AgentHarnessTool<ExecutionToolContext>,
	edit: createEditTool() as AgentHarnessTool<ExecutionToolContext>,
	bash: createBashTool() as AgentHarnessTool<ExecutionToolContext>,
};

const invocation = { invocationId: "inv", operationId: "op", turnId: "t", getMemo: async () => undefined, setMemo: async () => {} };

/** Pi's model-visible result: content text, or the thrown message for errors. */
async function runPi(tool: KernelToolName, args: Record<string, unknown>) {
	const spec = piTools[tool];
	const prepared = spec.prepareArguments ? spec.prepareArguments(args) : args;
	try {
		const result = await spec.execute("call", prepared as never, () => {}, { env: piEnv }, invocation, ctx);
		return { isError: false, content: result.content };
	} catch (error) {
		return { isError: true, content: [{ type: "text", text: (error as Error).message }] };
	}
}

let seq = 0;
async function runLily(tool: KernelToolName, args: Record<string, unknown>) {
	const spec = piTools[tool];
	const prepared = (spec.prepareArguments ? spec.prepareArguments(args) : args) as Record<string, JsonValue>;
	const raw = await executeRaw(tool, prepared, {
		env: lease.env,
		shell: lease.client,
		invocationId: `inv${seq++}`,
		context: ctx,
		tmpDir: lease.info.paths.tmp,
	});
	const observation = baselineObservation(raw);
	return { isError: observation.isError, content: observation.content };
}

/** Spill files live in different temp dirs; everything else must match byte for byte. */
function normalize(result: { isError: boolean; content: Array<{ type: string; text?: string; data?: string }> }) {
	return {
		isError: result.isError,
		content: result.content.map((part) => (part.type === "text" ? { ...part, text: part.text?.replace(/Full output: \S+\]/g, "Full output: <spill>]") } : part)),
	};
}

async function expectEquivalent(tool: KernelToolName, args: Record<string, unknown>, setup?: () => Promise<void>) {
	await setup?.();
	const pi = normalize(await runPi(tool, args));
	await setup?.();
	const lily = normalize(await runLily(tool, args));
	expect(lily).toEqual(pi);
	return lily;
}

beforeAll(async () => {
	dir = await tempDir("lily-equiv-");
	piEnv = new NodeExecutionEnv({ cwd: dir });
	({ lease } = await localEnvironment({ kind: "mount", path: dir }));
	expect(lease.info.paths.workspace).toBe(dir);
});

afterAll(async () => {
	await lease?.destroy();
});

const PNG_1x1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

describe("Lily tools reproduce Pi 0.85.1 core tool output", () => {
	it("read: plain, CRLF, unicode, offsets, limits and errors", async () => {
		await writeFile(join(dir, "small.txt"), "one\ntwo\nthree\n");
		await writeFile(join(dir, "crlf.txt"), "a\r\nb\r\nπ ✓ 日本\r\n");
		await expectEquivalent("read", { path: "small.txt" });
		await expectEquivalent("read", { path: "crlf.txt" });
		await expectEquivalent("read", { path: "small.txt", offset: 2 });
		await expectEquivalent("read", { path: "small.txt", offset: 1, limit: 1 });
		await expectEquivalent("read", { path: "small.txt", offset: 99 });
		const missing = await expectEquivalent("read", { path: "missing.txt" });
		expect(missing.isError).toBe(true);
		await expectEquivalent("read", { path: "." });
	});

	it("read: line truncation, byte truncation and an oversized first line", async () => {
		await writeFile(join(dir, "lines.txt"), Array.from({ length: 2600 }, (_, i) => `line ${i + 1}`).join("\n"));
		await writeFile(join(dir, "bytes.txt"), Array.from({ length: 900 }, (_, i) => `${i}:${"x".repeat(80)}`).join("\n"));
		await writeFile(join(dir, "wide.txt"), `${"w".repeat(60 * 1024)}\nnext\n`);
		const lines = await expectEquivalent("read", { path: "lines.txt" });
		expect(lines.content[0]?.text).toContain("Use offset=2001 to continue.");
		await expectEquivalent("read", { path: "lines.txt", offset: 2500, limit: 50 });
		await expectEquivalent("read", { path: "bytes.txt" });
		await expectEquivalent("read", { path: "wide.txt" });
	});

	it("read: images are returned as attachments", async () => {
		await writeFile(join(dir, "pixel.png"), PNG_1x1);
		const image = await expectEquivalent("read", { path: "pixel.png" });
		expect(image.content[1]?.type).toBe("image");
	});

	it("write: creates parent directories", async () => {
		await expectEquivalent("write", { path: "deep/nested/new.txt", content: "hello\n" });
	});

	it("edit: replacements, legacy arguments, CRLF/BOM preservation and failures", async () => {
		const reset = (text: string) => () => writeFile(join(dir, "code.py"), text);
		await expectEquivalent("edit", { path: "code.py", edits: [{ oldText: "return 1", newText: "return 2" }] }, reset("def f():\n    return 1\n"));
		await expectEquivalent(
			"edit",
			{ path: "code.py", edits: [{ oldText: "a = 1", newText: "a = 10" }, { oldText: "b = 2", newText: "b = 20" }] },
			reset("a = 1\nb = 2\nc = 3\n"),
		);
		await expectEquivalent("edit", { path: "code.py", oldText: "c = 3", newText: "c = 30" }, reset("a = 1\nb = 2\nc = 3\n"));
		await expectEquivalent("edit", { path: "code.py", edits: [{ oldText: "x", newText: "y" }] }, reset("﻿line x\r\nother\r\n"));
		const notFound = await expectEquivalent("edit", { path: "code.py", edits: [{ oldText: "absent", newText: "y" }] }, reset("abc\n"));
		expect(notFound.isError).toBe(true);
		await expectEquivalent("edit", { path: "code.py", edits: [{ oldText: "dup", newText: "y" }] }, reset("dup\ndup\n"));
		await expectEquivalent("edit", { path: "no-such.py", edits: [{ oldText: "a", newText: "b" }] });
		await expectEquivalent("edit", { path: "code.py", edits: [] }, reset("abc\n"));
	});

	it("bash: output, exit codes, empty output, stderr interleaving", async () => {
		await expectEquivalent("bash", { command: "echo hello" });
		await expectEquivalent("bash", { command: "echo out; echo err 1>&2; exit 4" });
		await expectEquivalent("bash", { command: "true" });
		await expectEquivalent("bash", { command: "printf 'no newline'" });
		await expectEquivalent("bash", { command: "ls -1 deep" });
	});

	it("bash: long output is tail-truncated with the same notice", async () => {
		const result = await expectEquivalent("bash", { command: "seq 1 5000" });
		expect(result.content[0]?.text).toContain("[Showing lines 3001-5000 of 5000. Full output: <spill>]");
		await expectEquivalent("bash", { command: "for i in $(seq 1 300); do printf '%0300d\\n' $i; done" });
		await expectEquivalent("bash", { command: "head -c 70000 /dev/zero | tr '\\0' 'z'" });
	});

	it("bash: timeouts and invalid timeouts", async () => {
		const timedOut = await expectEquivalent("bash", { command: "echo start; sleep 5", timeout: 1 });
		expect(timedOut.content[0]?.text).toBe("start\n\n\nCommand timed out after 1 seconds");
		await expectEquivalent("bash", { command: "echo x", timeout: -1 });
	});
});
