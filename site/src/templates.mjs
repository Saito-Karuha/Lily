// HTML building blocks shared by every page. Every URL is relative (`base` is "" for pages
// at the site root and "../" for pages in docs/) so the site works on any static host.
import { escapeHtml } from "./markdown.mjs";

export const esc = escapeHtml;

export const icons = {
	arrow: `<svg class="icon" viewBox="0 0 24 12" aria-hidden="true"><path d="M1 6h20M16 1.5 21.5 6 16 10.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	copy: `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.25" y="5.25" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.75 3.25v-.5a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`,
	check: `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.5 3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	external: `<svg class="icon icon-ext" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5h5v5M9.5 2.5 3 9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	menu: `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5h12M2 8h12M2 11.5h12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
};

export function copyButton(text, label = "Copy") {
	return `<button class="copy-btn" type="button" data-copy="${esc(text)}" aria-label="${esc(`${label}: ${text}`)}"><span class="copy-idle">${icons.copy}<span>${esc(label)}</span></span><span class="copy-done">${icons.check}<span>Copied</span></span></button>`;
}

/** The "Compose. Run. Iterate." band from the concept: rules, serif title, mono corners. */
export function band(extraClass = "") {
	return `<div class="band ${extraClass}">
	<div class="band-side band-left"><span class="band-corner">Ideas take root</span></div>
	<p class="band-title">Compose. Run. Iterate.</p>
	<div class="band-side band-right"><span class="band-corner">With Lily</span></div>
</div>`;
}

export function siteHeader({ base, current, github, variant = "page" }) {
	const link = (href, label, key, external = false) =>
		`<a class="nav-link" href="${esc(href)}"${current === key ? ' aria-current="page"' : ""}${external ? ' rel="noopener"' : ""}>${label}</a>`;
	return `<header class="site-header site-header--${variant}">
	<a class="wordmark" href="${base}index.html" aria-label="Lily home">lily</a>
	<nav class="site-nav" aria-label="Main">
		${link(`${base}docs/index.html`, "Docs", "docs")}
		${link(github, "GitHub", "github", true)}
		${link(`${base}changelog.html`, "Changelog", "changelog")}
	</nav>
</header>`;
}

export function siteFooter({ base, github, pkg }) {
	const year = new Date().getFullYear();
	return `<footer class="site-footer">
	${band("band--footer")}
	<div class="footer-grid">
		<div class="footer-brand">
			<a class="wordmark wordmark--footer" href="${base}index.html">lily</a>
			<p>An agent harness for the way you build.</p>
		</div>
		<div class="footer-install">
			<p class="eyebrow">Install</p>
			<div class="mini-cmd"><code>npm install -g ${esc(pkg.name)}</code>${copyButton(`npm install -g ${pkg.name}`)}</div>
		</div>
		<nav class="footer-links" aria-label="Footer">
			<p class="eyebrow">Project</p>
			<a href="${base}docs/index.html">Docs</a>
			<a href="${esc(github)}" rel="noopener">GitHub</a>
			<a href="${base}changelog.html">Changelog</a>
			<a href="https://www.npmjs.com/package/${esc(pkg.name)}" rel="noopener">npm</a>
		</nav>
	</div>
	<div class="footer-legal">
		<span>© ${year} Lily contributors. Released under the ${esc(pkg.license)} License.</span>
		<span>Kernel from the Pi agent · v${esc(pkg.version)}</span>
	</div>
</footer>`;
}

export function layout({ title, description, base, bodyClass = "", header, content, footer, head = "", scripts = "" }) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#f2eee4">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<link rel="icon" href="${base}assets/favicon.svg" type="image/svg+xml">
<link rel="preload" href="${base}assets/fonts/source-serif-4-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${base}assets/fonts/ibm-plex-mono-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${base}assets/site.css">
${head}
</head>
<body class="${bodyClass}">
<a class="skip-link" href="#main">Skip to content</a>
${header}
<main id="main">
${content}
</main>
${footer}
<script src="${base}assets/main.js" defer></script>
${scripts}
</body>
</html>
`;
}
