// Builds the static site into site/dist/.
//
//   node scripts/build.mjs            (npm run build)
//
// Inputs: src/ (templates, styles, client script, art), docs.json + the markdown files it
// lists (missing ones are skipped with a warning), ../CHANGELOG.md (optional) and
// demo/demo.json (the recorded TUI session; see scripts/record-demo.mjs).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GITHUB_BRANCH, GITHUB_URL, SITE_DESCRIPTION, SITE_TITLE } from "../src/config.mjs";
import { landingPage } from "../src/landing.mjs";
import { renderMarkdown } from "../src/markdown.mjs";
import { esc, icons, layout, siteFooter, siteHeader } from "../src/templates.mjs";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(SITE, "..");
const DIST = join(SITE, "dist");
const ASSETS = join(DIST, "assets");
const nodeModule = (p) => join(SITE, "node_modules", p);

let warnings = 0;
const warn = (message) => {
	warnings++;
	console.warn(`\x1b[33mwarn\x1b[39m ${message}`);
};

export async function build() {
	const started = Date.now();
	warnings = 0;
	rmSync(DIST, { recursive: true, force: true });
	mkdirSync(join(ASSETS, "fonts"), { recursive: true });
	mkdirSync(join(DIST, "docs"), { recursive: true });

	const rootPkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
	const pkg = { name: rootPkg.name ?? "lily-harness", version: rootPkg.version ?? "0.0.0", license: rootPkg.license ?? "MIT" };
	const node = (rootPkg.engines?.node ?? ">=22.19.0").replace(/^>=\s*/, "≥ ").replace(/\.0$/, "");

	// ---------------------------------------------------------------- assets
	const fontCss = buildFonts();
	const styles = readdirSync(join(SITE, "src/styles"))
		.filter((f) => f.endsWith(".css"))
		.sort()
		.map((f) => `/* ${f} */\n${readFileSync(join(SITE, "src/styles", f), "utf8")}`);
	writeFileSync(join(ASSETS, "site.css"), [fontCss, ...styles].join("\n"));
	copyFileSync(join(SITE, "src/client/main.js"), join(ASSETS, "main.js"));
	for (const f of readdirSync(join(SITE, "src/assets"))) copyFileSync(join(SITE, "src/assets", f), join(ASSETS, f));
	writeFileSync(join(DIST, ".nojekyll"), "");

	// ---------------------------------------------------------------- demo
	const demoPath = join(SITE, "demo/demo.json");
	let demoTitle = "lily";
	if (existsSync(demoPath)) {
		const demo = readFileSync(demoPath, "utf8");
		demoTitle = JSON.parse(demo).title ?? demoTitle;
		writeFileSync(join(ASSETS, "demo-data.js"), `window.__LILY_DEMO__=${demo.trim()};\n`);
	} else {
		warn("demo/demo.json is missing — run `npm run record-demo`; the player will show a placeholder");
	}

	// ---------------------------------------------------------------- docs
	const manifest = JSON.parse(readFileSync(join(SITE, "docs.json"), "utf8"));
	const docs = [];
	for (const entry of manifest) {
		const file = resolve(SITE, entry.file);
		if (!existsSync(file)) {
			warn(`docs: ${entry.file} not found — skipping "${entry.title}"`);
			continue;
		}
		docs.push({ ...entry, path: file });
	}
	const docPages = new Map(docs.map((d) => [d.path, `${d.slug}.html`]));
	const changelogPath = join(REPO, "CHANGELOG.md");
	docPages.set(changelogPath, "../changelog.html");
	const sections = groupSections(docs);

	for (const [i, doc] of docs.entries()) {
		const source = readFileSync(doc.path, "utf8");
		const { html, headings, h1 } = renderMarkdown(source, {
			file: doc.path,
			pages: docPages,
			repoRoot: REPO,
			githubUrl: GITHUB_URL,
			branch: GITHUB_BRANCH,
			warn: (m) => warn(`docs/${doc.slug}: ${m}`),
		});
		const body = h1 ? html : `<h1>${esc(doc.title)}</h1>\n${html}`;
		const prev = docs[i - 1];
		const next = docs[i + 1];
		const content = `<div class="docs-shell">
	${docsNav(sections, doc.slug)}
	<article class="docs-main">
		<p class="eyebrow docs-crumb">${esc(doc.section ?? "Docs")}</p>
		<div class="prose">
${body}
		</div>
		<nav class="docs-pager" aria-label="Pagination">
			${prev ? `<a class="prev" href="${esc(prev.slug)}.html"><small>Previous</small><span>${esc(prev.title)}</span></a>` : ""}
			${next ? `<a class="next" href="${esc(next.slug)}.html"><small>Next</small><span>${esc(next.title)}</span></a>` : ""}
		</nav>
		<p class="docs-source">Source: <a href="${esc(`${GITHUB_URL}/blob/${GITHUB_BRANCH}/${relative(REPO, doc.path)}`)}" rel="noopener">${esc(relative(REPO, doc.path))}</a></p>
	</article>
	${toc(headings)}
</div>`;
		write(`docs/${doc.slug}.html`, page({ title: `${doc.title} · Lily docs`, base: "../", current: "docs", content, bodyClass: "page-docs", pkg }));
	}

	// Docs index: every page, grouped.
	const indexContent = `<div class="docs-shell">
	${docsNav(sections, null)}
	<article class="docs-main">
		<p class="eyebrow docs-crumb">Documentation</p>
		<div class="prose"><h1>Lily docs</h1>
		<p>Lily is a terminal coding agent: the Pi agent's kernel, tools executed in isolated environments through <code>lily-envd</code>, resource bundles pinned per run, and a full-fidelity record of every run. Start with the guide, or jump to the reference.</p></div>
		<div class="docs-index-grid">
			${
				sections.length
					? sections
							.map(
								(s) => `<section>
				<p class="eyebrow" style="margin-bottom:14px">${esc(s.name)}</p>
				<div class="doc-cards">${s.docs
					.map((d) => `<a class="doc-card" href="${esc(d.slug)}.html"><span class="doc-card-title">${esc(d.title)}</span><span class="doc-card-arrow">${icons.arrow}</span></a>`)
					.join("")}</div>
			</section>`,
							)
							.join("\n")
					: `<p class="docs-missing">No docs pages were found. Add markdown files listed in <code>site/docs.json</code>.</p>`
			}
		</div>
	</article>
</div>`;
	write("docs/index.html", page({ title: "Docs · Lily", base: "../", current: "docs", content: indexContent, bodyClass: "page-docs", pkg }));

	// ---------------------------------------------------------------- changelog
	let changelogBody;
	if (existsSync(changelogPath)) {
		const { html, h1 } = renderMarkdown(readFileSync(changelogPath, "utf8"), {
			file: changelogPath,
			pages: new Map([...docs.map((d) => [d.path, `docs/${d.slug}.html`])]),
			repoRoot: REPO,
			githubUrl: GITHUB_URL,
			branch: GITHUB_BRANCH,
			warn: (m) => warn(`changelog: ${m}`),
		});
		changelogBody = h1 ? html : `<h1>Changelog</h1>\n${html}`;
	} else {
		warn("CHANGELOG.md not found — writing a placeholder changelog page");
		changelogBody = `<h1>Changelog</h1>\n<p>Release notes will appear here with the first release of <code>${esc(pkg.name)}</code>.</p>`;
	}
	write(
		"changelog.html",
		page({
			title: "Changelog · Lily",
			base: "",
			current: "changelog",
			bodyClass: "page-changelog",
			pkg,
			content: `<div class="changelog-shell"><article class="docs-main"><p class="eyebrow docs-crumb">Releases</p><div class="prose">${changelogBody}</div></article></div>`,
		}),
	);

	// ---------------------------------------------------------------- landing
	write(
		"index.html",
		layout({
			title: SITE_TITLE,
			description: SITE_DESCRIPTION,
			base: "",
			bodyClass: "page-home",
			header: siteHeader({ base: "", current: "home", github: GITHUB_URL, variant: "home" }),
			content: landingPage({ pkg, node, docs, github: GITHUB_URL, demoTitle }),
			footer: siteFooter({ base: "", github: GITHUB_URL, pkg }),
			head: `<link rel="preload" href="assets/lily-art.webp" as="image" type="image/webp">`,
		}),
	);

	checkLinks();
	console.log(`built ${relative(process.cwd(), DIST) || "."} in ${Date.now() - started} ms · ${docs.length} docs pages${warnings ? ` · ${warnings} warning(s)` : ""}`);
}

/** Warns about relative links in dist/ that point at missing files or missing #anchors. */
function checkLinks() {
	const pages = new Map();
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".html")) pages.set(path, readFileSync(path, "utf8"));
		}
	};
	walk(DIST);
	const ids = new Map();
	const idsOf = (path) => {
		if (!ids.has(path)) ids.set(path, new Set([...(pages.get(path) ?? "").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
		return ids.get(path);
	};
	for (const [path, html] of pages) {
		for (const [, attr, raw] of html.matchAll(/\s(href|src)="([^"]*)"/g)) {
			const value = raw.replace(/&amp;/g, "&");
			if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) continue;
			const [file, hash] = value.split("#");
			const target = file ? resolve(dirname(path), decodeURIComponent(file)) : path;
			const where = relative(DIST, path);
			if (!existsSync(target)) {
				warn(`${where}: ${attr}="${value}" points to a missing file`);
				continue;
			}
			if (hash && target.endsWith(".html") && !idsOf(target).has(decodeURIComponent(hash))) warn(`${where}: link "${value}" — no element with id "${hash}"`);
		}
	}
}

function page({ title, base, current, content, bodyClass, pkg }) {
	return layout({
		title,
		description: SITE_DESCRIPTION,
		base,
		bodyClass,
		header: siteHeader({ base, current, github: GITHUB_URL, variant: "page" }),
		content,
		footer: siteFooter({ base, github: GITHUB_URL, pkg }),
	});
}

function write(path, html) {
	const out = join(DIST, path);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, html);
}

function groupSections(docs) {
	const sections = [];
	for (const doc of docs) {
		const name = doc.section ?? "Docs";
		let section = sections.find((s) => s.name === name);
		if (!section) sections.push((section = { name, docs: [] }));
		section.docs.push(doc);
	}
	return sections;
}

function docsNav(sections, currentSlug) {
	const current = sections.flatMap((s) => s.docs).find((d) => d.slug === currentSlug);
	const groups = sections
		.map(
			(s) => `<div class="docs-nav-group">
			<p class="eyebrow">${esc(s.name)}</p>
			<ul>${s.docs.map((d) => `<li><a href="${esc(d.slug)}.html"${d.slug === currentSlug ? ' aria-current="page"' : ""}>${esc(d.title)}</a></li>`).join("")}</ul>
		</div>`,
		)
		.join("\n");
	const overview = `<div class="docs-nav-group"><ul><li><a href="index.html"${currentSlug === null ? ' aria-current="page"' : ""}>Overview</a></li></ul></div>`;
	// Two copies of the same list: a plain one for wide screens, a collapsible one for phones.
	return `<aside class="docs-nav" aria-label="Documentation">
		<div class="docs-nav-desktop">${overview}${groups}</div>
		<details class="docs-nav-mobile">
			<summary class="docs-nav-toggle">${icons.menu}<span>Docs</span><span class="current">${esc(current?.title ?? "Overview")}</span></summary>
			<div class="docs-nav-panel">${overview}${groups}</div>
		</details>
	</aside>`;
}

function toc(headings) {
	if (headings.length < 2) return `<aside class="docs-toc" aria-hidden="true"></aside>`;
	return `<aside class="docs-toc" aria-label="On this page">
		<p class="eyebrow">On this page</p>
		<ul>${headings.map((h) => `<li class="toc-${h.depth}"><a href="#${esc(h.id)}">${h.text}</a></li>`).join("")}</ul>
	</aside>`;
}

/** Copies the woff2 files the site uses and returns their @font-face rules. */
function buildFonts() {
	const wanted = [
		["@fontsource-variable/source-serif-4/opsz.css", ["latin", "latin-ext"]],
		["@fontsource-variable/source-serif-4/opsz-italic.css", ["latin"]],
		["@fontsource-variable/ibm-plex-sans/wght.css", ["latin", "latin-ext"]],
		["@fontsource-variable/ibm-plex-sans/wght-italic.css", ["latin"]],
		["@fontsource/ibm-plex-mono/400.css", ["latin", "latin-ext"]],
		["@fontsource/ibm-plex-mono/500.css", ["latin"]],
		["@fontsource/ibm-plex-mono/400-italic.css", ["latin"]],
	];
	const rules = [];
	for (const [cssFile, subsets] of wanted) {
		const cssPath = nodeModule(cssFile);
		if (!existsSync(cssPath)) {
			warn(`font stylesheet ${cssFile} not found — run npm install in site/`);
			continue;
		}
		const css = readFileSync(cssPath, "utf8");
		for (const block of css.split(/(?=\/\*)/)) {
			const name = block.match(/\/\*\s*([\w-]+)\s*\*\//)?.[1];
			if (!name || !subsets.some((s) => new RegExp(`-${s}-(?:opsz|wght|\\d{3})`).test(name))) continue;
			const url = block.match(/url\(\.\/files\/([^)]+\.woff2)\)/)?.[1];
			if (!url) continue;
			copyFileSync(join(dirname(cssPath), "files", url), join(ASSETS, "fonts", url));
			rules.push(
				block
					.replace(/\/\*[^*]*\*\/\s*/, "")
					.replace(/src:[^;]+;/, `src: url(fonts/${url}) format("woff2");`)
					.trim(),
			);
		}
	}
	return `/* fonts (self-hosted from @fontsource) */\n${rules.join("\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	build().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
