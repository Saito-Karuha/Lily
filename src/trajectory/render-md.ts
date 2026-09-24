import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExportedTrajectory } from "./export.ts";

function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = text.slice(0, Math.floor(max * 0.6));
	const tail = text.slice(text.length - Math.floor(max * 0.3));
	return `${head}\n… [${text.length - head.length - tail.length} characters omitted] …\n${tail}`;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type: string; text?: string; mimeType?: string }) => (part.type === "text" ? (part.text ?? "") : `[${part.type}${part.mimeType ? ` ${part.mimeType}` : ""}]`))
		.join("");
}

/**
 * Human- and model-readable rendering of one run: prompt, every assistant turn
 * (thinking, text, tool calls), the observations the model saw, the outcome
 * and any annotations. Used by `lily show` and handy as input for other agents.
 */
export function renderTrajectoryMarkdown(trajectory: ExportedTrajectory, options: { maxObservationChars?: number; maxThinkingChars?: number } = {}): string {
	const maxObs = options.maxObservationChars ?? 4000;
	const maxThinking = options.maxThinkingChars ?? 2000;
	const m = trajectory.manifest;
	const lines: string[] = [];
	lines.push(`# Run ${m.runId}`);
	lines.push("");
	const labels = Object.entries(m.labels ?? {});
	if (labels.length) lines.push(`- labels: ${labels.map(([k, v]) => `${k}=${v}`).join(", ")}`);
	lines.push(`- model: ${m.model.provider}/${m.model.modelId}`);
	lines.push(`- bundle: ${m.bundle ? `${m.bundle.name} ${m.bundle.digest.slice(0, 19)}` : "(none)"}${m.route ? ` (routed by ${m.route.router})` : ""}`);
	const outcome = trajectory.outcome;
	if (outcome) {
		lines.push(`- status: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}, ${outcome.turns} turns, ${outcome.toolCalls} tool calls`);
	}
	lines.push("");
	lines.push("## Prompt");
	lines.push("");
	lines.push(m.prompt.text);

	const lastAssistantCall = [...trajectory.calls].reverse().find((c) => c.purpose === "assistant");
	const messages: Message[] = lastAssistantCall ? [...lastAssistantCall.context.messages, lastAssistantCall.response as Message] : [];
	let turn = 0;
	for (const message of messages) {
		if (message.role === "assistant") {
			turn++;
			const assistant = message as AssistantMessage;
			lines.push("");
			lines.push(`## Turn ${turn} — assistant${assistant.stopReason !== "toolUse" && assistant.stopReason !== "stop" ? ` (${assistant.stopReason})` : ""}`);
			for (const part of assistant.content) {
				if (part.type === "thinking" && part.thinking.trim()) {
					lines.push("");
					lines.push(`<thinking>\n${clip(part.thinking.trim(), maxThinking)}\n</thinking>`);
				} else if (part.type === "text" && part.text.trim()) {
					lines.push("");
					lines.push(part.text.trim());
				} else if (part.type === "toolCall") {
					lines.push("");
					lines.push(`**tool call** \`${part.name}\``);
					lines.push("```json");
					lines.push(clip(JSON.stringify(part.arguments, null, 2), maxObs));
					lines.push("```");
				}
			}
		} else if (message.role === "toolResult") {
			const result = message as ToolResultMessage;
			lines.push("");
			lines.push(`**observation** (${result.toolName}${result.isError ? ", error" : ""})`);
			lines.push("```");
			lines.push(clip(contentText(result.content), maxObs));
			lines.push("```");
		} else if (message.role === "user" && turn > 0) {
			lines.push("");
			lines.push(`## User`);
			lines.push("");
			lines.push(clip(contentText(message.content), maxObs));
		}
	}
	for (const [name, value] of Object.entries(trajectory.annotations ?? {})) {
		lines.push("");
		lines.push(`## Annotation: ${name}`);
		lines.push("```json");
		lines.push(clip(JSON.stringify(value, null, 2), maxObs));
		lines.push("```");
	}
	return `${lines.join("\n")}\n`;
}
