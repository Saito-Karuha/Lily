/*
 * Diff rendering adapted from Pi's interactive mode
 * (pi-0.85.1/packages/coding-agent/src/modes/interactive/components/diff.ts, MIT).
 * Input is the line-numbered diff produced by the edit tool: "+12 text", "-12 text", " 12 text".
 */
import * as Diff from "diff";
import { c } from "../theme.ts";

function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1]!, lineNum: match[2]!, content: match[3]! };
}

const tabs = (text: string) => text.replace(/\t/g, "   ");

/** Word-level diff of one changed line, changed words in inverse video. */
function intraLine(oldContent: string, newContent: string): { removed: string; added: string } {
	let removed = "";
	let added = "";
	let firstRemoved = true;
	let firstAdded = true;
	for (const part of Diff.diffWords(oldContent, newContent)) {
		if (part.removed) {
			let value = part.value;
			if (firstRemoved) {
				const lead = value.match(/^(\s*)/)?.[1] ?? "";
				removed += lead;
				value = value.slice(lead.length);
				firstRemoved = false;
			}
			if (value) removed += c.inverse(value);
		} else if (part.added) {
			let value = part.value;
			if (firstAdded) {
				const lead = value.match(/^(\s*)/)?.[1] ?? "";
				added += lead;
				value = value.slice(lead.length);
				firstAdded = false;
			}
			if (value) added += c.inverse(value);
		} else {
			removed += part.value;
			added += part.value;
		}
	}
	return { removed, added };
}

/** Colored diff lines: additions in leaf green, removals in rust, context muted. */
export function renderDiffLines(diffText: string): string[] {
	const lines = diffText.replace(/\s+$/, "").split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const parsed = parseDiffLine(lines[i]!);
		if (!parsed) {
			out.push(c.muted(tabs(lines[i]!)));
			i++;
			continue;
		}
		if (parsed.prefix === "-") {
			const removed: Array<{ lineNum: string; content: string }> = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]!);
				if (!p || p.prefix !== "-") break;
				removed.push(p);
				i++;
			}
			const added: Array<{ lineNum: string; content: string }> = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]!);
				if (!p || p.prefix !== "+") break;
				added.push(p);
				i++;
			}
			if (removed.length === 1 && added.length === 1) {
				const pair = intraLine(tabs(removed[0]!.content), tabs(added[0]!.content));
				out.push(c.error(`-${removed[0]!.lineNum} ${pair.removed}`));
				out.push(c.leaf(`+${added[0]!.lineNum} ${pair.added}`));
			} else {
				for (const r of removed) out.push(c.error(`-${r.lineNum} ${tabs(r.content)}`));
				for (const a of added) out.push(c.leaf(`+${a.lineNum} ${tabs(a.content)}`));
			}
		} else if (parsed.prefix === "+") {
			out.push(c.leaf(`+${parsed.lineNum} ${tabs(parsed.content)}`));
			i++;
		} else {
			out.push(c.muted(` ${parsed.lineNum} ${tabs(parsed.content)}`));
			i++;
		}
	}
	return out;
}

/** Added / removed line counts of a line-numbered diff. */
export function diffStats(diffText: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diffText.split("\n")) {
		if (/^\+\s*\d/.test(line)) added++;
		else if (/^-\s*\d/.test(line)) removed++;
	}
	return { added, removed };
}
