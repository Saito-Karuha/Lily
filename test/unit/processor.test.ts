import { describe, expect, it } from "vitest";
import { baselineObservation } from "../../src/kernel/tools/baseline.ts";
import type { BashRaw, ReadRaw } from "../../src/kernel/tools/raw.ts";
import { applyProcessor, createProcessor, validateProcessorSpec } from "../../src/resources/processor/dsl.ts";

function bash(command: string, output: string, exitCode = 0): BashRaw {
	return {
		tool: "bash",
		args: { command },
		output,
		complete: true,
		durationMs: 1,
		exec: { exitCode, signal: null, timedOut: false, cancelled: false, totalBytes: Buffer.byteLength(output), capturedBytes: Buffer.byteLength(output), spillPath: "/tmp/spill.log" },
		...(exitCode === 0 ? {} : { error: { message: `Command exited with code ${exitCode}` } }),
	};
}

const textOf = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? "").join("");

describe("observation processor DSL", () => {
	it("falls back to the Pi baseline when no rule matches", () => {
		const spec = validateProcessorSpec({
			format: "lily.processor/v1",
			tools: { bash: [{ when: { command: "^grep" }, steps: [{ op: "head", lines: 1 }] }] },
		});
		const raw = bash("ls", "a\nb\n");
		expect(applyProcessor(spec, raw)).toEqual(baselineObservation(raw));
	});

	it("truncates long search output and appends a note", () => {
		const spec = validateProcessorSpec({
			format: "lily.processor/v1",
			tools: {
				bash: [{ when: { command: "^\\s*(grep|rg)\\b", outputLinesGt: 3 }, steps: [{ op: "head", lines: 2 }, { op: "note" }] }],
			},
		});
		const raw = bash("grep -rn foo .", "l1\nl2\nl3\nl4\nl5\n");
		expect(textOf(applyProcessor(spec, raw))).toBe("l1\nl2\n\n[Showing 2 of 5 lines. Full output: /tmp/spill.log]");
	});

	it("keeps the kernel error status line for failing commands", () => {
		const spec = validateProcessorSpec({ format: "lily.processor/v1", tools: { bash: [{ steps: [{ op: "tail", lines: 1 }] }] } });
		const observation = applyProcessor(spec, bash("make", "x\ny\nfatal\n", 2));
		expect(observation.isError).toBe(true);
		expect(textOf(observation)).toBe("fatal\n\nCommand exited with code 2");
	});

	it("never reshapes kernel-owned read errors", () => {
		const spec = validateProcessorSpec({ format: "lily.processor/v1", tools: { read: [{ steps: [{ op: "prepend", text: "X" }] }] } });
		const raw: ReadRaw = { tool: "read", args: { path: "nope" }, complete: true, durationMs: 1, error: { message: "ENOENT: no such file or directory, open '/w/nope'" } };
		expect(applyProcessor(spec, raw)).toEqual(baselineObservation(raw));
	});

	it("supports dedupe, keepLines with context, headTail and templates", () => {
		const spec = validateProcessorSpec({
			format: "lily.processor/v1",
			tools: {
				bash: [
					{
						steps: [
							{ op: "dedupe" },
							{ op: "keepLines", pattern: "ERR", context: 1 },
							{ op: "prepend", text: "exit={exitCode} lines={totalLines}\n" },
						],
					},
				],
			},
		});
		const out = textOf(applyProcessor(spec, bash("run", "ok\nok\nok\nwarn\nERR boom\nafter\nend\n")));
		expect(out).toBe("exit=0 lines=7\nwarn\nERR boom\nafter");
		const ht = validateProcessorSpec({ format: "lily.processor/v1", tools: { bash: [{ steps: [{ op: "headTail", head: 1, tail: 1 }] }] } });
		expect(textOf(applyProcessor(ht, bash("x", "1\n2\n3\n4\n")))).toBe("1\n[... 2 lines omitted ...]\n4");
	});

	it("rejects unsafe or malformed specs", () => {
		expect(() => validateProcessorSpec({ format: "nope" })).toThrow(/format/);
		expect(() => validateProcessorSpec({ format: "lily.processor/v1", tools: { python: [] } })).toThrow(/unknown tool/);
		expect(() =>
			validateProcessorSpec({ format: "lily.processor/v1", tools: { bash: [{ steps: [{ op: "dropLines", pattern: "(a+)+$" }] }] } }),
		).toThrow(/nested quantifiers/);
		expect(() =>
			validateProcessorSpec({ format: "lily.processor/v1", tools: { bash: [{ steps: [{ op: "dropLines", pattern: "(a)\\1" }] }] } }),
		).toThrow(/backreferences/);
		expect(() => validateProcessorSpec({ format: "lily.processor/v1", tools: { bash: [{ steps: [{ op: "eval" }] }] } })).toThrow(/unknown op/);
	});

	it("identifies processors by content digest, baseline by kernel id", () => {
		expect(createProcessor(undefined).id).toBe("kernel:pi-baseline@0.85.1");
		const a = createProcessor({ format: "lily.processor/v1", tools: { bash: [{ steps: [{ op: "stripAnsi" }] }] } });
		const b = createProcessor({ tools: { bash: [{ steps: [{ op: "stripAnsi" }] }] }, format: "lily.processor/v1" });
		expect(a.id).toMatch(/^sha256:/);
		expect(a.id).toBe(b.id);
	});
});
