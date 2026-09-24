// The landing page (index.html).
import { band, copyButton, esc, icons } from "./templates.mjs";
import { highlight } from "./markdown.mjs";

const BACKENDS = [
	{ name: "local", level: "None", note: "Plain host process — development and tests only", platform: "macOS, Linux", strength: 0 },
	{ name: "seatbelt", level: "Process sandbox", note: "Default on macOS. No reads outside system dirs and its own environment, writes only to workspace, home and tmp, no network by default", platform: "macOS", strength: 1 },
	{ name: "docker / podman", level: "Container", note: "Shares the host kernel; meant for controlled development use", platform: "Docker or Podman host", strength: 2 },
	{ name: "gvisor", level: "User-space kernel", note: "Docker with the runsc runtime", platform: "Linux", strength: 3 },
	{ name: "apple-container", level: "VM", note: "A lightweight VM with its own Linux kernel per environment", platform: "macOS 26+, Apple silicon", strength: 4 },
	{ name: "firecracker", level: "microVM", note: "Verified on arm64", platform: "Linux + KVM", strength: 4 },
];

function codeBlock(code, lang, { copy = true, label } = {}) {
	return `<div class="snippet">${label ? `<span class="snippet-label">${esc(label)}</span>` : ""}${copy ? copyButton(code) : ""}<pre><code class="hljs">${highlight(code, lang)}</code></pre></div>`;
}

function pips(n) {
	return `<span class="pips" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<i${i <= n ? ' class="on"' : ""}></i>`).join("")}</span>`;
}

export function landingPage({ pkg, node, docs, github, demoTitle }) {
	const install = `npm install -g ${pkg.name}`;
	const scriptExample = `[
  { "text": "Let me look around.",
    "toolCalls": [
      { "name": "bash", "arguments": { "command": "ls -la" } }
    ] },
  { "text": "All set." }
]`;
	const vllmConfig = `{
  "model": "local-vllm/Qwen/Qwen3-8B",
  "providers": {
    "local-vllm": {
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "models": [{ "id": "Qwen/Qwen3-8B", "contextWindow": 32768, "maxTokens": 8192 }],
      "tokenCapture": "vllm"
    }
  }
}`;
	const docCards = docs
		.map(
			(d) => `<a class="doc-card" href="docs/${esc(d.slug)}.html">
				<span class="doc-card-section">${esc(d.section ?? "Docs")}</span>
				<span class="doc-card-title">${esc(d.title)}</span>
				<span class="doc-card-arrow">${icons.arrow}</span>
			</a>`,
		)
		.join("\n");

	return `
<section class="hero" aria-labelledby="hero-title">
	<div class="hero-copy">
		<p class="eyebrow eyebrow--hero">AI Agent Harness</p>
		<h1 class="hero-title" id="hero-title">Let good <span class="nowrap">ideas run.</span></h1>
		<p class="hero-sub">An agent harness for the way you build.</p>
		<div class="hero-actions">
			<a class="btn btn-solid" href="#install">Start building ${icons.arrow}</a>
			<a class="btn btn-outline" href="docs/index.html">Read docs</a>
		</div>
		<div class="hero-term" role="img" aria-label="Terminal: $ lily, then the prompt ship the next idea, and the reply Ready when you are.">
			<p><span class="hero-term-prompt">$</span> lily</p>
			<p><span class="hero-term-prompt">&gt;</span> ship the next idea<span class="caret"></span></p>
			<p>Ready when you are.</p>
		</div>
	</div>
	<div class="hero-art" aria-hidden="true">
		<img src="assets/lily-art.webp" width="840" height="996" alt="" decoding="async" fetchpriority="high">
	</div>
	<div class="hero-taglines" aria-hidden="true">
		<p class="tagline tagline--one">Curiosity<br>builds<br>a kinder<br>tomorrow</p>
		<p class="tagline tagline--two">Small<br>agents<br>brighter<br>worlds</p>
	</div>
	${band("band--hero")}
</section>

<section class="section section-install" id="install" aria-labelledby="install-title">
	<div class="install-top">
	<div class="section-head section-head--stack">
		<p class="eyebrow"><span class="eyebrow-num">01</span> Install</p>
		<h2 class="section-title" id="install-title">One command, then <code class="title-code">lily</code>.</h2>
		<p class="lede">Lily lives in your terminal. Install it from npm and start it in any project directory — the directory becomes the agent's workspace.</p>
	</div>
		<div class="install-main">
			<div class="cmd" role="group" aria-label="Install commands">
				<div class="cmd-bar"><span class="cmd-dot"></span><span class="cmd-dot"></span><span class="cmd-dot"></span><span class="cmd-title">~/your-project</span></div>
				<div class="cmd-line"><span class="cmd-prompt">$</span><code>${esc(install)}</code>${copyButton(install)}</div>
				<div class="cmd-line"><span class="cmd-prompt">$</span><code>lily</code>${copyButton("lily")}</div>
			</div>
			<p class="install-req"><span class="req-badge">Node.js ${esc(node)}</span> Container and VM backends additionally use their own runtime — Docker, Podman, gVisor, Apple <code>container</code> or Firecracker — when it is installed.</p>
		</div>
	</div>
	<div class="install-steps">
			<article class="step">
				<h3><span class="step-num">a</span> Try it offline</h3>
				<p>No API key yet? <code>lily --script demo</code> runs the real TUI, tools and recording against a scripted model bundled with the package.</p>
				${codeBlock("lily --script demo", "bash")}
				<p>Or script your own: <code>lily --script &lt;file&gt;</code> replays replies and tool calls from a JSON file.</p>
				${codeBlock(scriptExample, "json", { label: "script.json" })}
			</article>
			<article class="step">
				<h3><span class="step-num">b</span> Connect a model</h3>
				<p>Export the API key of any provider Lily's model layer (pi-ai) supports, then pick a model:</p>
				${codeBlock(`export ANTHROPIC_API_KEY=...\nlily config model anthropic/claude-sonnet-4-5\nlily models   # models with configured credentials`, "bash")}
				<details class="more">
					<summary>Self-hosted: vLLM, SGLang or any OpenAI-compatible server</summary>
					<p>Add a provider to <code>~/.lily/config.json</code>. With <code>"tokenCapture": "vllm"</code>, Lily also records the engine's real prompt and sampled token ids (vLLM ≥ 0.10.2).</p>
					${codeBlock(vllmConfig, "json", { label: "~/.lily/config.json" })}
				</details>
			</article>
		</div>
</section>

<section class="section section-about" id="about" aria-labelledby="about-title">
	<div class="section-head">
		<p class="eyebrow"><span class="eyebrow-num">02</span> What Lily is</p>
		<h2 class="section-title" id="about-title">A coding agent you use every day, and a clean trajectory generator.</h2>
		<p class="lede">Lily is a terminal coding agent built around the Pi agent's kernel. Around it, Lily adds three things: every run is isolated, every run is pinned to its resources, and every run is recorded exactly.</p>
	</div>

	<div class="stack" aria-label="How Lily is put together">
		<div class="stack-row">
			<p class="stack-label">You</p>
			<ul class="chips">
				<li>TUI <code>lily</code></li>
				<li>TypeScript SDK</li>
				<li><code>lily -p --json</code> event stream</li>
				<li>Local HTTP API <code>lily serve</code></li>
			</ul>
		</div>
		<div class="stack-row stack-row--core">
			<p class="stack-label">Lily</p>
			<div class="stack-core">
				<div><strong>Pi kernel</strong><span>agent loop · read / bash / edit / write · sessions · compaction</span></div>
				<div><strong>Resource bundles</strong><span>immutable, content-addressed, pinned per run · pluggable router</span></div>
				<div><strong>Recorder</strong><span>exact model I/O · raw tool outputs · token ids · trajectories</span></div>
			</div>
		</div>
		<div class="stack-link"><span>JSON lines over stdio / vsock</span></div>
		<div class="stack-row stack-row--env">
			<p class="stack-label">Environment</p>
			<div class="stack-env"><strong>lily-envd</strong><span>a small guest agent that runs the tools inside a Seatbelt sandbox, a container, gVisor or a per-run VM — never with your host's environment variables or credentials</span></div>
		</div>
	</div>

	<div class="features">
		<article class="feature">
			<p class="feature-kicker">Kernel</p>
			<h3>The Pi agent at the core</h3>
			<p>The agent loop, the four tools — <code>read</code>, <code>bash</code>, <code>edit</code>, <code>write</code> — sessions and compaction come from Pi. Lily keeps that kernel fixed, so what varies between runs is what you chose to vary.</p>
		</article>
		<article class="feature">
			<p class="feature-kicker">Isolation</p>
			<h3>Every run in its own environment</h3>
			<p>Tools execute through <code>lily-envd</code>, a small guest agent, from a macOS Seatbelt sandbox up to a per-run lightweight VM — Apple <code>container</code> on macOS, Firecracker on Linux/KVM — with Docker, Podman and gVisor in between.</p>
		</article>
		<article class="feature">
			<p class="feature-kicker">Resources</p>
			<h3>Bundles, pinned per run</h3>
			<p>What shapes the agent — attached prompt, memory, skills, tool guidance and the observation processor — lives in immutable, content-addressed resource bundles. A run pins its bundle before the first model call; a pluggable bundle router (<code>--router &lt;module&gt; --bundle @router</code>) lets several bundles coexist.</p>
		</article>
		<article class="feature">
			<p class="feature-kicker">Recording</p>
			<h3>Full fidelity, every time</h3>
			<p>Each run records the exact model inputs and outputs, raw tool outputs before they are formatted for the model, and token ids when served by vLLM. Export any run as a trajectory for research and post-training.</p>
		</article>
		<article class="feature">
			<p class="feature-kicker">Interfaces</p>
			<h3>Script it, embed it, serve it</h3>
			<p>Beyond the TUI: a TypeScript SDK (<code>import { LilyRuntime } from "lily-harness"</code>), a JSON-lines event stream from <code>lily -p "…" --json</code>, and a local HTTP API with <code>lily serve</code>.</p>
		</article>
		<article class="feature">
			<p class="feature-kicker">One harness</p>
			<h3>Daily driver and data source</h3>
			<p>The same harness you code with is a clean trajectory generator: isolated environments, pinned resources and exact records keep runs comparable, whether they come from you or from a script.</p>
		</article>
	</div>
</section>

<section class="section section-demo" id="demo" aria-labelledby="demo-title">
	<div class="section-head section-head--center">
		<p class="eyebrow"><span class="eyebrow-num">03</span> See it run</p>
		<h2 class="section-title" id="demo-title">A real session, replayed.</h2>
		<p class="lede">Recorded from the Lily TUI in a pseudo-terminal, using the offline scripted model (<code>--script</code>), so no API key was involved.</p>
	</div>
	<div class="player" data-player data-src="assets/demo-data.js" data-title="${esc(demoTitle)}">
		<div class="player-bar">
			<span class="cmd-dot"></span><span class="cmd-dot"></span><span class="cmd-dot"></span>
			<span class="player-title">${esc(demoTitle)}</span>
			<button class="player-btn" type="button" data-action="toggle" aria-label="Play">
				<svg class="icon icon-play" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z" fill="currentColor"/></svg>
				<svg class="icon icon-pause" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" fill="currentColor"/></svg>
				<svg class="icon icon-replay" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M4.5 1.8v3.2h3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
				<span class="player-btn-label">Play</span>
			</button>
		</div>
		<div class="player-screen" aria-hidden="true"><div class="player-rows"></div></div>
		<div class="player-progress" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="player-progress-fill"></span></div>
		<noscript><p class="player-noscript">The demo replay needs JavaScript.</p></noscript>
	</div>
</section>

<section class="section section-isolation" id="isolation" aria-labelledby="isolation-title">
	<div class="section-head">
		<p class="eyebrow"><span class="eyebrow-num">04</span> Isolation backends</p>
		<h2 class="section-title" id="isolation-title">Choose how much wall to put around the agent.</h2>
		<p class="lede">All four tools always run through <code>lily-envd</code>; the backend decides what surrounds it. Host environment variables, API keys included, never enter the environment. Check what your machine supports with <code>lily env backends</code>, pick one per run with <code>--backend &lt;name&gt;</code>.</p>
	</div>
	<div class="table-wrap table-wrap--backends">
		<table class="backends">
			<thead><tr><th scope="col">Backend</th><th scope="col">Isolation</th><th scope="col">Platform</th><th scope="col">Notes</th></tr></thead>
			<tbody>
				${BACKENDS.map(
					(b) => `<tr>
					<th scope="row"><code>${esc(b.name)}</code></th>
					<td><span class="level">${pips(b.strength)}<span>${esc(b.level)}</span></span></td>
					<td>${esc(b.platform)}</td>
					<td class="muted-cell">${esc(b.note)}</td>
				</tr>`,
				).join("\n")}
			</tbody>
		</table>
	</div>
</section>

<section class="section section-docs" id="docs" aria-labelledby="docs-title">
	<div class="section-head">
		<p class="eyebrow"><span class="eyebrow-num">05</span> Documentation</p>
		<h2 class="section-title" id="docs-title">Read the docs.</h2>
		<p class="lede">From the first session to the formats underneath: bundles, trajectories and the envd protocol.</p>
	</div>
	<div class="doc-cards">
		${docCards}
	</div>
</section>
`;
}
