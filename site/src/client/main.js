// Lily site client script: copy buttons, docs TOC highlighting and the demo player.
(() => {
	"use strict";

	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

	/* ------------------------------------------------------------ copy */

	async function copyText(text) {
		try {
			if (navigator.clipboard && window.isSecureContext) {
				await navigator.clipboard.writeText(text);
				return true;
			}
		} catch {
			/* fall back below */
		}
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.select();
		let ok = false;
		try {
			ok = document.execCommand("copy");
		} catch {
			ok = false;
		}
		area.remove();
		return ok;
	}

	function copyButton(text) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "copy-btn";
		button.dataset.copy = text;
		button.setAttribute("aria-label", "Copy code");
		button.innerHTML =
			'<span class="copy-idle"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.25" y="5.25" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.75 3.25v-.5a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg><span>Copy</span></span>' +
			'<span class="copy-done"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.5 3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Copied</span></span>';
		return button;
	}

	// Docs code blocks get a copy button too.
	for (const block of document.querySelectorAll(".prose .code-block")) {
		const code = block.querySelector("code");
		if (code) block.appendChild(copyButton(code.textContent.replace(/\n$/, "")));
	}

	document.addEventListener("click", async (event) => {
		const button = event.target.closest?.("[data-copy]");
		if (!button) return;
		const ok = await copyText(button.dataset.copy);
		if (!ok) return;
		button.classList.add("is-copied");
		clearTimeout(button._copyTimer);
		button._copyTimer = setTimeout(() => button.classList.remove("is-copied"), 1600);
	});

	/* ------------------------------------------------------------ docs TOC */

	const tocLinks = [...document.querySelectorAll(".docs-toc a[href^='#']")];
	if (tocLinks.length && "IntersectionObserver" in window) {
		const byId = new Map(tocLinks.map((a) => [decodeURIComponent(a.getAttribute("href").slice(1)), a]));
		const headings = [...byId.keys()].map((id) => document.getElementById(id)).filter(Boolean);
		const visible = new Set();
		const update = () => {
			let current = headings.find((h) => visible.has(h)) ?? null;
			if (!current) {
				// Nothing in view: the last heading above the viewport is the current section.
				for (const h of headings) if (h.getBoundingClientRect().top < 120) current = h;
			}
			for (const a of tocLinks) a.classList.toggle("is-active", current !== null && byId.get(current.id) === a);
		};
		const observer = new IntersectionObserver(
			(entries) => {
				for (const e of entries) (e.isIntersecting ? visible.add(e.target) : visible.delete(e.target));
				update();
			},
			{ rootMargin: "-72px 0px -60% 0px" },
		);
		for (const h of headings) observer.observe(h);
	}

	/* ------------------------------------------------------------ demo player */

	function loadScript(src) {
		return new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = src;
			script.async = true;
			script.onload = () => resolve();
			script.onerror = () => reject(new Error(`failed to load ${src}`));
			document.head.appendChild(script);
		});
	}

	const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

	class Player {
		constructor(root) {
			this.root = root;
			this.rowsEl = root.querySelector(".player-rows");
			this.button = root.querySelector("[data-action='toggle']");
			this.label = root.querySelector(".player-btn-label");
			this.progress = root.querySelector(".player-progress");
			this.fill = root.querySelector(".player-progress-fill");
			this.state = "loading";
			this.time = 0;
			this.frame = -1;
			this.userPaused = false;
			this.rowEls = [];
			this.rowIds = [];
			this.lineHtml = [];
			this.raf = 0;
			this.overlay = document.createElement("button");
			this.overlay.type = "button";
			this.overlay.className = "player-overlay";
			this.overlay.innerHTML = '<span><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z" fill="currentColor"/></svg><span class="player-overlay-label">Play demo</span></span>';
			root.appendChild(this.overlay);
			this.setState("loading");
		}

		async init() {
			try {
				if (!window.__LILY_DEMO__) await loadScript(this.root.dataset.src);
			} catch {
				/* handled below */
			}
			const data = window.__LILY_DEMO__;
			if (!data || !data.frames || !data.frames.length) {
				this.rowsEl.innerHTML = '<p class="player-empty">The demo recording is not available.</p>';
				this.button.hidden = true;
				return;
			}
			this.data = data;
			this.root.style.setProperty("--cols", data.cols);
			this.root.style.setProperty("--rows", data.rows);
			this.rowsEl.style.position = "relative";
			for (let y = 0; y < data.rows; y++) {
				const row = document.createElement("div");
				row.className = "player-row";
				this.rowsEl.appendChild(row);
				this.rowEls.push(row);
				this.rowIds.push(-1);
			}
			this.cursor = document.createElement("span");
			this.cursor.className = "player-cursor";
			Object.assign(this.cursor.style, { position: "absolute", width: "1ch", height: "1.32em", left: "0", top: "0", display: "none" });
			this.rowsEl.appendChild(this.cursor);

			this.button.addEventListener("click", () => this.toggle());
			this.overlay.addEventListener("click", () => this.toggle());
			this.root.querySelector(".player-screen")?.addEventListener("click", () => {
				if (this.state === "ended") this.toggle();
			});
			this.progress.addEventListener("click", (e) => {
				const rect = this.progress.getBoundingClientRect();
				this.seek(((e.clientX - rect.left) / rect.width) * this.data.duration);
			});
			this.progress.addEventListener("keydown", (e) => {
				const step = this.data.duration / 20;
				if (e.key === "ArrowRight") this.seek(this.time + step);
				else if (e.key === "ArrowLeft") this.seek(this.time - step);
				else if (e.key === " " || e.key === "Enter") this.toggle();
				else return;
				e.preventDefault();
			});

			if (reducedMotion) {
				this.seek(this.data.duration);
				this.setState("idle");
				return;
			}
			this.seek(0);
			this.setState("idle");
			if ("IntersectionObserver" in window) {
				new IntersectionObserver(
					(entries) => {
						for (const e of entries) {
							if (e.isIntersecting && e.intersectionRatio >= 0.45) {
								if (this.state === "idle" || (this.state === "paused" && !this.userPaused)) this.play();
							} else if (!e.isIntersecting && this.state === "playing") {
								this.pause(false);
							}
						}
					},
					{ threshold: [0, 0.45] },
				).observe(this.root);
			}
		}

		setState(state) {
			this.state = state;
			this.root.dataset.state = state;
			const label = state === "playing" ? "Pause" : state === "ended" ? "Replay" : "Play";
			if (this.label) this.label.textContent = label;
			this.button?.setAttribute("aria-label", `${label} demo`);
			const overlayLabel = this.overlay.querySelector(".player-overlay-label");
			if (overlayLabel) overlayLabel.textContent = state === "ended" ? "Replay" : "Play demo";
		}

		toggle() {
			if (!this.data) return;
			if (this.state === "playing") this.pause(true);
			else if (this.state === "ended") {
				this.seek(0);
				this.play();
			} else this.play();
		}

		play() {
			if (this.time >= this.data.duration) this.seek(0);
			this.userPaused = false;
			this.setState("playing");
			this.startedAt = performance.now() - this.time * 1000;
			cancelAnimationFrame(this.raf);
			const tick = (now) => {
				if (this.state !== "playing") return;
				this.time = Math.min((now - this.startedAt) / 1000, this.data.duration);
				this.renderAt(this.time);
				if (this.time >= this.data.duration) {
					this.setState("ended");
					return;
				}
				this.raf = requestAnimationFrame(tick);
			};
			this.raf = requestAnimationFrame(tick);
		}

		pause(byUser) {
			cancelAnimationFrame(this.raf);
			this.userPaused = byUser;
			this.setState("paused");
		}

		seek(t) {
			this.time = Math.max(0, Math.min(t, this.data.duration));
			this.startedAt = performance.now() - this.time * 1000;
			this.renderAt(this.time);
			if (this.state === "ended" && this.time < this.data.duration) this.setState("paused");
		}

		frameAt(t) {
			const frames = this.data.frames;
			let lo = 0;
			let hi = frames.length - 1;
			while (lo < hi) {
				const mid = (lo + hi + 1) >> 1;
				if (frames[mid][0] <= t) lo = mid;
				else hi = mid - 1;
			}
			return lo;
		}

		renderAt(t) {
			const index = this.frameAt(t);
			if (index !== this.frame) {
				this.frame = index;
				this.draw(this.data.frames[index]);
			}
			const pct = (t / this.data.duration) * 100;
			this.fill.style.width = `${pct}%`;
			this.progress.setAttribute("aria-valuenow", String(Math.round(pct)));
		}

		html(id) {
			let html = this.lineHtml[id];
			if (html !== undefined) return html;
			const runs = this.data.lines[id];
			html = "";
			for (const [text, styleId] of runs) {
				const style = this.data.styles[styleId];
				const t = escapeHtml(text);
				if (!style || (!style.c && !style.k)) html += t;
				else html += `<span${style.k ? ` class="${style.k}"` : ""}${style.c ? ` style="${style.c}"` : ""}>${t}</span>`;
			}
			this.lineHtml[id] = html;
			return html;
		}

		draw(frame) {
			const [, ids, cx, cy, cursorOn] = frame;
			for (let y = 0; y < this.rowEls.length; y++) {
				const id = ids[y] ?? 0;
				if (this.rowIds[y] !== id) {
					this.rowIds[y] = id;
					this.rowEls[y].innerHTML = this.html(id);
				}
			}
			if (cursorOn) {
				this.cursor.style.display = "block";
				this.cursor.style.left = `${cx}ch`;
				this.cursor.style.top = `${cy * 1.32}em`;
			} else this.cursor.style.display = "none";
		}
	}

	for (const root of document.querySelectorAll("[data-player]")) {
		const player = new Player(root);
		// Load the recording when the player gets close to the viewport.
		if ("IntersectionObserver" in window) {
			const io = new IntersectionObserver(
				(entries) => {
					if (entries.some((e) => e.isIntersecting)) {
						io.disconnect();
						player.init();
					}
				},
				{ rootMargin: "600px 0px" },
			);
			io.observe(root);
		} else player.init();
	}
})();
