import { sanitizeBinaryOutput } from "@earendil-works/pi-agent-core";
import { digestOf } from "../../util/hash.ts";
import { BASELINE_PROCESSOR_ID, baselineObservation, type Observation, renderBashView } from "../../kernel/tools/baseline.ts";
import { countNewlines, type RawEnvelope } from "../../kernel/tools/raw.ts";
import { isKernelToolName, type KernelToolName } from "../../kernel/tools/specs.ts";

/**
 * Observation processor F (method v2: o = F(z)). A bundle ships a declarative
 * spec interpreted by this fixed kernel code — never executable plugins. F only
 * reshapes the text of a raw result the tool already produced: it cannot run
 * tools, read files, change error status, or touch the environment.
 */
export const PROCESSOR_FORMAT = "lily.processor/v1";

export interface ProcessorSpec {
	format: typeof PROCESSOR_FORMAT;
	description?: string;
	tools?: Partial<Record<KernelToolName, ProcessorRule[]>>;
}

export interface ProcessorRule {
	name?: string;
	when?: ProcessorMatcher;
	/** A pipeline, or `"baseline"` for Pi's default rendering. */
	steps: ProcessorStep[] | "baseline";
}

export interface ProcessorMatcher {
	/** Regex tested against the bash command. */
	command?: string;
	/** Regex tested against the path argument. */
	path?: string;
	exitCode?: number | "zero" | "nonzero";
	outputLinesGt?: number;
	outputBytesGt?: number;
	error?: boolean;
}

export type ProcessorStep =
	| { op: "stripAnsi" }
	| { op: "dropLines"; pattern: string }
	| { op: "keepLines"; pattern: string; context?: number }
	| { op: "truncateLines"; maxChars: number }
	| { op: "dedupe" }
	| { op: "collapseBlank" }
	| { op: "head"; lines?: number; bytes?: number }
	| { op: "tail"; lines?: number; bytes?: number }
	| { op: "headTail"; head: number; tail: number }
	| { op: "maxChars"; chars: number; keep?: "head" | "tail" }
	| { op: "prepend"; text: string }
	| { op: "append"; text: string }
	| { op: "note"; text?: string };

const MAX_RULES = 32;
const MAX_STEPS = 32;
const MAX_PATTERN = 256;
const MAX_TEMPLATE = 2000;
const MAX_LINE_SCAN = 10_000;

export class ProcessorSpecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProcessorSpecError";
	}
}

/** Rejects patterns with backreferences or nested quantifiers (catastrophic backtracking). */
function checkPattern(pattern: unknown, where: string): RegExp {
	if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_PATTERN) {
		throw new ProcessorSpecError(`${where}: pattern must be a non-empty string of at most ${MAX_PATTERN} chars`);
	}
	if (/\\[1-9]/.test(pattern) || /\(\?<?[=!]/.test(pattern)) {
		throw new ProcessorSpecError(`${where}: backreferences and lookaround are not allowed`);
	}
	if (/\([^()]*[+*][^()]*\)\s*[+*{]/.test(pattern)) {
		throw new ProcessorSpecError(`${where}: nested quantifiers are not allowed`);
	}
	try {
		return new RegExp(pattern);
	} catch (error) {
		throw new ProcessorSpecError(`${where}: invalid regex: ${(error as Error).message}`);
	}
}

function positiveInt(value: unknown, where: string): void {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000_000) {
		throw new ProcessorSpecError(`${where}: expected a non-negative integer`);
	}
}

function template(value: unknown, where: string): void {
	if (typeof value !== "string" || value.length > MAX_TEMPLATE) {
		throw new ProcessorSpecError(`${where}: expected a string of at most ${MAX_TEMPLATE} chars`);
	}
}

/** Validates an untrusted spec (e.g. from a proposer-written bundle). */
export function validateProcessorSpec(input: unknown): ProcessorSpec {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new ProcessorSpecError("spec must be an object");
	const spec = input as Record<string, unknown>;
	if (spec.format !== PROCESSOR_FORMAT) throw new ProcessorSpecError(`format must be "${PROCESSOR_FORMAT}"`);
	for (const key of Object.keys(spec)) {
		if (!["format", "description", "tools"].includes(key)) throw new ProcessorSpecError(`unknown field "${key}"`);
	}
	if (spec.tools !== undefined) {
		if (!spec.tools || typeof spec.tools !== "object") throw new ProcessorSpecError("tools must be an object");
		for (const [tool, rules] of Object.entries(spec.tools)) {
			if (!isKernelToolName(tool)) throw new ProcessorSpecError(`unknown tool "${tool}"`);
			if (!Array.isArray(rules) || rules.length > MAX_RULES) {
				throw new ProcessorSpecError(`tools.${tool} must be an array of at most ${MAX_RULES} rules`);
			}
			rules.forEach((rule, index) => validateRule(rule, `tools.${tool}[${index}]`));
		}
	}
	return input as ProcessorSpec;
}

function validateRule(rule: unknown, where: string): void {
	if (!rule || typeof rule !== "object") throw new ProcessorSpecError(`${where}: rule must be an object`);
	const r = rule as Record<string, unknown>;
	if (r.when !== undefined) {
		const when = r.when as Record<string, unknown>;
		if (!when || typeof when !== "object") throw new ProcessorSpecError(`${where}.when must be an object`);
		for (const [key, value] of Object.entries(when)) {
			if (key === "command" || key === "path") checkPattern(value, `${where}.when.${key}`);
			else if (key === "exitCode") {
				if (value !== "zero" && value !== "nonzero" && !Number.isInteger(value)) {
					throw new ProcessorSpecError(`${where}.when.exitCode must be an integer, "zero" or "nonzero"`);
				}
			} else if (key === "outputLinesGt" || key === "outputBytesGt") positiveInt(value, `${where}.when.${key}`);
			else if (key === "error") {
				if (typeof value !== "boolean") throw new ProcessorSpecError(`${where}.when.error must be boolean`);
			} else throw new ProcessorSpecError(`${where}.when: unknown matcher "${key}"`);
		}
	}
	if (r.steps === "baseline") return;
	if (!Array.isArray(r.steps) || r.steps.length > MAX_STEPS) {
		throw new ProcessorSpecError(`${where}.steps must be "baseline" or an array of at most ${MAX_STEPS} steps`);
	}
	r.steps.forEach((step, index) => validateStep(step, `${where}.steps[${index}]`));
}

function validateStep(step: unknown, where: string): void {
	const s = step as Record<string, unknown>;
	if (!s || typeof s !== "object" || typeof s.op !== "string") throw new ProcessorSpecError(`${where}: step needs an "op"`);
	switch (s.op) {
		case "stripAnsi":
		case "dedupe":
		case "collapseBlank":
			return;
		case "dropLines":
			checkPattern(s.pattern, `${where}.pattern`);
			return;
		case "keepLines":
			checkPattern(s.pattern, `${where}.pattern`);
			if (s.context !== undefined) positiveInt(s.context, `${where}.context`);
			return;
		case "truncateLines":
			positiveInt(s.maxChars, `${where}.maxChars`);
			return;
		case "head":
		case "tail":
			if (s.lines === undefined && s.bytes === undefined) throw new ProcessorSpecError(`${where}: needs lines or bytes`);
			if (s.lines !== undefined) positiveInt(s.lines, `${where}.lines`);
			if (s.bytes !== undefined) positiveInt(s.bytes, `${where}.bytes`);
			return;
		case "headTail":
			positiveInt(s.head, `${where}.head`);
			positiveInt(s.tail, `${where}.tail`);
			return;
		case "maxChars":
			positiveInt(s.chars, `${where}.chars`);
			if (s.keep !== undefined && s.keep !== "head" && s.keep !== "tail") {
				throw new ProcessorSpecError(`${where}.keep must be "head" or "tail"`);
			}
			return;
		case "prepend":
		case "append":
			template(s.text, `${where}.text`);
			return;
		case "note":
			if (s.text !== undefined) template(s.text, `${where}.text`);
			return;
		default:
			throw new ProcessorSpecError(`${where}: unknown op "${s.op}"`);
	}
}

export interface ObservationProcessor {
	/** Stable identity recorded with every observation derivation. */
	readonly id: string;
	process(raw: RawEnvelope): Observation;
}

export const baselineProcessor: ObservationProcessor = {
	id: BASELINE_PROCESSOR_ID,
	process: baselineObservation,
};

export function createProcessor(spec: ProcessorSpec | undefined): ObservationProcessor {
	if (!spec?.tools || Object.values(spec.tools).every((rules) => !rules || rules.length === 0)) return baselineProcessor;
	const validated = validateProcessorSpec(spec);
	return { id: digestOf(validated), process: (raw) => applyProcessor(validated, raw) };
}

function matches(when: ProcessorMatcher | undefined, raw: RawEnvelope): boolean {
	if (!when) return true;
	const arg = (name: string) => (typeof raw.args[name] === "string" ? (raw.args[name] as string) : undefined);
	if (when.command !== undefined && !new RegExp(when.command).test(arg("command") ?? "")) return false;
	if (when.path !== undefined && !new RegExp(when.path).test(arg("path") ?? "")) return false;
	if (when.error !== undefined && Boolean(raw.error) !== when.error) return false;
	if (when.exitCode !== undefined) {
		if (raw.tool !== "bash") return false;
		const code = raw.exec?.exitCode;
		if (when.exitCode === "zero" && code !== 0) return false;
		if (when.exitCode === "nonzero" && (code === 0 || code === null || code === undefined)) return false;
		if (typeof when.exitCode === "number" && code !== when.exitCode) return false;
	}
	const body = bodyText(raw);
	if (when.outputLinesGt !== undefined && countLines(body) <= when.outputLinesGt) return false;
	if (when.outputBytesGt !== undefined && Buffer.byteLength(body) <= when.outputBytesGt) return false;
	return true;
}

function bodyText(raw: RawEnvelope): string {
	if (raw.tool === "bash") return raw.output;
	if (raw.tool === "read" && raw.content?.kind === "text") return raw.content.text;
	return "";
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	return countNewlines(text) + (text.endsWith("\n") ? 0 : 1);
}

function vars(raw: RawEnvelope, totalLines: number, shownLines: number): Record<string, string> {
	const out: Record<string, string> = {
		tool: raw.tool,
		totalLines: String(totalLines),
		shownLines: String(shownLines),
	};
	for (const [key, value] of Object.entries(raw.args)) {
		if (typeof value === "string" || typeof value === "number") out[key] = String(value);
	}
	if (raw.tool === "bash") {
		out.exitCode = String(raw.exec?.exitCode ?? "");
		out.totalBytes = String(raw.exec?.totalBytes ?? Buffer.byteLength(raw.output));
		out.spillPath = raw.exec?.spillPath ?? "";
	}
	if (raw.tool === "read" && raw.content?.kind === "text") {
		out.startLine = String(raw.content.startLine);
		out.totalFileLines = String(raw.content.totalFileLines);
	}
	if (raw.tool === "edit") {
		out.diff = raw.diff ?? "";
		out.replaced = String(raw.replaced ?? "");
	}
	return out;
}

function fill(text: string, values: Record<string, string>): string {
	return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name: string) => values[name] ?? match);
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

function testLine(re: RegExp, line: string): boolean {
	return re.test(line.length > MAX_LINE_SCAN ? line.slice(0, MAX_LINE_SCAN) : line);
}

function byteHead(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function byteTail(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= maxBytes) return text;
	let start = bytes.byteLength - maxBytes;
	while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

function runSteps(steps: ProcessorStep[], input: string, raw: RawEnvelope): string {
	const totalLines = countLines(input);
	let lines = input.endsWith("\n") ? input.slice(0, -1).split("\n") : input.split("\n");
	if (input.length === 0) lines = [];
	let prefix = "";
	let suffix = "";
	const join = () => lines.join("\n");
	for (const step of steps) {
		switch (step.op) {
			case "stripAnsi":
				lines = lines.map((line) => line.replace(ANSI, ""));
				break;
			case "dropLines": {
				const re = new RegExp(step.pattern);
				lines = lines.filter((line) => !testLine(re, line));
				break;
			}
			case "keepLines": {
				const re = new RegExp(step.pattern);
				const context = step.context ?? 0;
				const keep = new Set<number>();
				lines.forEach((line, index) => {
					if (!testLine(re, line)) return;
					for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) keep.add(i);
				});
				lines = lines.filter((_, index) => keep.has(index));
				break;
			}
			case "truncateLines":
				lines = lines.map((line) => (line.length > step.maxChars ? `${line.slice(0, step.maxChars)}... [truncated]` : line));
				break;
			case "dedupe": {
				const out: string[] = [];
				let run = 0;
				for (let i = 0; i < lines.length; i++) {
					if (i > 0 && lines[i] === lines[i - 1]) {
						run++;
						continue;
					}
					if (run > 0) out.push(`[previous line repeated ${run} more time${run === 1 ? "" : "s"}]`);
					run = 0;
					out.push(lines[i]!);
				}
				if (run > 0) out.push(`[previous line repeated ${run} more time${run === 1 ? "" : "s"}]`);
				lines = out;
				break;
			}
			case "collapseBlank":
				lines = lines.filter((line, i) => !(line.trim() === "" && i > 0 && lines[i - 1]!.trim() === ""));
				break;
			case "head": {
				if (step.lines !== undefined) lines = lines.slice(0, step.lines);
				if (step.bytes !== undefined) lines = byteHead(join(), step.bytes).split("\n");
				break;
			}
			case "tail": {
				if (step.lines !== undefined) lines = step.lines === 0 ? [] : lines.slice(-step.lines);
				if (step.bytes !== undefined) lines = byteTail(join(), step.bytes).split("\n");
				break;
			}
			case "headTail":
				if (lines.length > step.head + step.tail) {
					const omitted = lines.length - step.head - step.tail;
					lines = [
						...lines.slice(0, step.head),
						`[... ${omitted} line${omitted === 1 ? "" : "s"} omitted ...]`,
						...(step.tail === 0 ? [] : lines.slice(-step.tail)),
					];
				}
				break;
			case "maxChars": {
				const text = join();
				if (text.length > step.chars) {
					lines = (step.keep === "tail" ? text.slice(text.length - step.chars) : text.slice(0, step.chars)).split("\n");
				}
				break;
			}
			case "prepend":
				prefix = `${fill(step.text, vars(raw, totalLines, lines.length))}${prefix}`;
				break;
			case "append":
				suffix = `${suffix}${fill(step.text, vars(raw, totalLines, lines.length))}`;
				break;
			case "note": {
				if (lines.length >= totalLines && join() === input.replace(/\n$/, "")) break;
				const values = vars(raw, totalLines, lines.length);
				const fallback =
					raw.tool === "bash" && values.spillPath
						? "[Showing {shownLines} of {totalLines} lines. Full output: {spillPath}]"
						: "[Showing {shownLines} of {totalLines} lines.]";
				suffix = `${suffix}\n\n${fill(step.text ?? fallback, values)}`;
				break;
			}
		}
	}
	return `${prefix}${join()}${suffix}`;
}

/** Applies the first matching rule; anything a rule may not reshape falls back to the baseline. */
export function applyProcessor(spec: ProcessorSpec, raw: RawEnvelope): Observation {
	const baseline = baselineObservation(raw);
	const rules = spec.tools?.[raw.tool];
	if (!rules) return baseline;
	// Kernel-owned outcomes: failed read/write/edit messages and images are never reshaped.
	if (raw.tool !== "bash" && raw.error) return baseline;
	if (raw.tool === "read" && raw.content?.kind === "image") return baseline;
	const rule = rules.find((candidate) => matches(candidate.when, raw));
	if (!rule || rule.steps === "baseline") return baseline;
	if (raw.tool === "bash") {
		const body = sanitizeBinaryOutput(runSteps(rule.steps, raw.output, raw));
		const text = raw.error ? (body ? `${body}\n\n${raw.error.message}` : raw.error.message) : body || "(no output)";
		return { content: [{ type: "text", text }], isError: Boolean(raw.error), details: renderBashView(raw).details };
	}
	const input = raw.tool === "read" && raw.content?.kind === "text" ? raw.content.text : textOf(baseline);
	return {
		content: [{ type: "text", text: runSteps(rule.steps, input, raw) }],
		isError: false,
		...(baseline.details ? { details: baseline.details } : {}),
	};
}

function textOf(observation: Observation): string {
	return observation.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}
