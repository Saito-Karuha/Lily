import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, formatSize, sanitizeBinaryOutput, truncateHead, truncateTail } from "@earendil-works/pi-agent-core";
import type { BashRaw, EditRaw, RawEnvelope, ReadRaw, WriteRaw } from "./raw.ts";
import { countNewlines } from "./raw.ts";

/** What the model sees for one tool call, before the kernel envelope and hard cap. */
export interface Observation {
	content: Array<TextContent | ImageContent>;
	isError: boolean;
	/** Structured details for UIs (diff, truncation); never shown to the model. */
	details?: Record<string, unknown>;
}

/** Identifier of the built-in processor that reproduces Pi 0.85.1's own tool output. */
export const BASELINE_PROCESSOR_ID = "kernel:pi-baseline@0.85.1";

function text(value: string): TextContent {
	return { type: "text", text: value };
}

/**
 * Pi-equivalent rendering of a raw envelope: for every input it produces the
 * same model-visible text Pi's core tools would have returned (errors become
 * `isError` observations whose text equals the message Pi throws).
 */
export function baselineObservation(raw: RawEnvelope): Observation {
	switch (raw.tool) {
		case "read":
			return baselineRead(raw);
		case "write":
			return baselineWrite(raw);
		case "edit":
			return baselineEdit(raw);
		case "bash":
			return baselineBash(raw);
	}
}

function errorObservation(message: string): Observation {
	return { content: [text(message)], isError: true };
}

function baselineRead(raw: ReadRaw): Observation {
	if (raw.error || !raw.content) return errorObservation(raw.error?.message ?? "read failed");
	const content = raw.content;
	if (content.kind === "image") {
		if (content.mimeType === "image/bmp") {
			return {
				content: [
					text("Read image file [image/bmp]\n[Image omitted: configure an imageProcessor to convert BMP images.]"),
				],
				isError: false,
			};
		}
		return {
			content: [text(`Read image file [${content.mimeType}]`), { type: "image", data: content.data, mimeType: content.mimeType }],
			isError: false,
		};
	}
	return { content: [text(renderReadText(raw))], isError: false, details: readDetails(raw) };
}

function readDetails(raw: ReadRaw): Record<string, unknown> | undefined {
	if (raw.content?.kind !== "text") return undefined;
	const truncation = truncateHead(raw.content.text);
	return truncation.truncated ? { truncation: { ...truncation, content: undefined } } : undefined;
}

/** Pi's read tool text for a text selection (`truncateHead` + continuation hints). */
export function renderReadText(raw: ReadRaw): string {
	if (raw.content?.kind !== "text") return "";
	const { startLine, totalFileLines, text: selected, userLimitedLines, firstLineBytes } = raw.content;
	const path = raw.args.path as string;
	const truncation = truncateHead(selected);
	if (truncation.firstLineExceedsLimit) {
		return `[Line ${startLine} is ${formatSize(firstLineBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLine}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
	}
	if (truncation.truncated) {
		const endLine = startLine + truncation.outputLines - 1;
		const next = endLine + 1;
		if (truncation.truncatedBy === "lines") {
			return `${truncation.content}\n\n[Showing lines ${startLine}-${endLine} of ${totalFileLines}. Use offset=${next} to continue.]`;
		}
		return `${truncation.content}\n\n[Showing lines ${startLine}-${endLine} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${next} to continue.]`;
	}
	const startIndex = startLine - 1;
	if (userLimitedLines !== undefined && startIndex + userLimitedLines < totalFileLines) {
		const remaining = totalFileLines - (startIndex + userLimitedLines);
		return `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${startIndex + userLimitedLines + 1} to continue.]`;
	}
	return truncation.content;
}

function baselineWrite(raw: WriteRaw): Observation {
	if (raw.error) return errorObservation(raw.error.message);
	return { content: [text(`Successfully wrote to ${raw.args.path as string}`)], isError: false };
}

function baselineEdit(raw: EditRaw): Observation {
	if (raw.error) return errorObservation(raw.error.message);
	return {
		content: [text(`Successfully replaced ${raw.replaced} block(s) in ${raw.args.path as string}.`)],
		isError: false,
		details: { diff: raw.diff, patch: raw.patch, firstChangedLine: raw.firstChangedLine },
	};
}

export interface BashView {
	text: string;
	truncated: boolean;
	notice?: string;
	details?: Record<string, unknown>;
}

/** Pi's bounded tail view of bash output with its "Full output" notice. */
export function renderBashView(raw: BashRaw): BashView {
	const output = raw.output;
	const totalBytes = raw.exec?.totalBytes ?? Buffer.byteLength(output);
	const newlines = countNewlines(output);
	const totalLines = newlines + (output.endsWith("\n") || totalBytes === 0 ? 0 : 1);
	const tail = truncateTail(output);
	const truncated = totalBytes > DEFAULT_MAX_BYTES || totalLines > tail.maxLines;
	const viewText = sanitizeBinaryOutput(tail.content);
	if (!truncated) return { text: viewText, truncated: false };
	const spillPath = raw.exec?.spillPath ?? undefined;
	const truncatedBy = totalLines > tail.maxLines ? "lines" : "bytes";
	const startLine = totalLines - tail.outputLines + 1;
	const endLine = totalLines;
	let notice: string;
	if (tail.lastLinePartial) {
		const lastNewline = output.lastIndexOf("\n");
		const lastLineBytes = Buffer.byteLength(lastNewline === -1 ? output : output.slice(lastNewline + 1));
		notice = `[Showing last ${formatSize(tail.outputBytes)} of line ${endLine} (line is ${formatSize(lastLineBytes)}). Full output: ${spillPath}]`;
	} else if (truncatedBy === "lines") {
		notice = `[Showing lines ${startLine}-${endLine} of ${totalLines}. Full output: ${spillPath}]`;
	} else {
		notice = `[Showing lines ${startLine}-${endLine} of ${totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${spillPath}]`;
	}
	const { content: _content, ...truncation } = tail;
	return {
		text: viewText,
		truncated: true,
		notice,
		details: {
			truncation: { ...truncation, truncated: true, truncatedBy, totalBytes, totalLines },
			fullOutputPath: spillPath,
		},
	};
}

function baselineBash(raw: BashRaw): Observation {
	const view = renderBashView(raw);
	const outputText = view.notice ? `${view.text}\n\n${view.notice}` : view.text;
	if (raw.error) {
		return {
			content: [text(outputText ? `${outputText}\n\n${raw.error.message}` : raw.error.message)],
			isError: true,
			...(view.details ? { details: view.details } : {}),
		};
	}
	return { content: [text(outputText || "(no output)")], isError: false, ...(view.details ? { details: view.details } : {}) };
}
