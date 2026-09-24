// Markdown → HTML for docs pages: heading anchors, highlighted code, wrapped tables and
// rewritten links (doc-to-doc links become generated pages; other repo files go to GitHub).
import { existsSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";
import { Marked, Renderer } from "marked";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("yaml", yaml);
const ALIASES = { sh: "bash", shell: "bash", zsh: "bash", console: "bash", js: "javascript", mjs: "javascript", ts: "typescript", jsonc: "json", jsonl: "json", py: "python", yml: "yaml", toml: "ini" };

export function escapeHtml(text) {
	return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function highlight(code, lang) {
	const name = ALIASES[lang] ?? lang;
	if (name && hljs.getLanguage(name)) {
		try {
			return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
		} catch {
			/* fall through to plain */
		}
	}
	return escapeHtml(code);
}

/** GitHub-like slugs that keep non-Latin letters (the docs are partly Chinese). */
export function slugify(text) {
	return (
		text
			.toLowerCase()
			.replace(/<[^>]+>/g, "")
			.replace(/&[a-z]+;|&#\d+;/g, "")
			.replace(/[^\p{L}\p{N}\s_-]/gu, "")
			.trim()
			.replace(/\s+/g, "-") || "section"
	);
}

/**
 * Renders one docs file.
 * @param {string} source markdown
 * @param {object} ctx
 * @param {string} ctx.file absolute path of the markdown file
 * @param {Map<string,string>} ctx.pages absolute md path → generated page href (relative to the page)
 * @param {string} ctx.repoRoot absolute path of the repository
 * @param {string} ctx.githubUrl
 * @param {string} ctx.branch
 * @param {(msg: string) => void} ctx.warn
 */
export function renderMarkdown(source, ctx) {
	const headings = [];
	const used = new Map();
	let h1 = null;
	const marked = new Marked({ gfm: true });

	const rewrite = (href) => {
		if (!href || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href;
		const [path, hash = ""] = href.split("#");
		if (!path) return href;
		const target = resolve(dirname(ctx.file), decodeURI(path));
		const page = ctx.pages.get(target);
		if (page) return page + (hash ? `#${hash}` : "");
		const rel = relative(ctx.repoRoot, target);
		if (rel.startsWith("..")) {
			ctx.warn(`link outside the repository: ${href}`);
			return href;
		}
		if (!existsSync(target)) ctx.warn(`broken link: ${href} (${rel} does not exist)`);
		else if (target.endsWith(".md")) ctx.warn(`link to ${rel}, which is not a docs page; pointing to GitHub`);
		const kind = existsSync(target) && statSync(target).isDirectory() ? "tree" : "blob";
		return `${ctx.githubUrl}/${kind}/${ctx.branch}/${rel.split("\\").join("/")}${hash ? `#${hash}` : ""}`;
	};

	marked.use({
		walkTokens(token) {
			if (token.type === "link" || token.type === "image") token.href = rewrite(token.href);
		},
		renderer: {
			heading({ tokens, depth }) {
				const inner = this.parser.parseInline(tokens);
				const plain = inner.replace(/<[^>]+>/g, "");
				let id = slugify(plain);
				const n = used.get(id) ?? 0;
				used.set(id, n + 1);
				if (n) id = `${id}-${n}`;
				if (depth === 1 && h1 === null) h1 = plain;
				if (depth === 2 || depth === 3) headings.push({ depth, id, text: plain });
				return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inner}</h${depth}>\n`;
			},
			code({ text, lang }) {
				const language = (lang || "").trim().split(/\s+/)[0];
				const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : "";
				return `<div class="code-block">${label}<pre><code class="hljs${language ? ` language-${escapeHtml(language)}` : ""}">${highlight(text, language)}</code></pre></div>\n`;
			},
			table(token) {
				const html = Renderer.prototype.table.call(this, token);
				return `<div class="table-wrap">${html}</div>\n`;
			},
		},
	});

	const html = marked.parse(source);
	return { html, headings, h1 };
}
