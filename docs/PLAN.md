# Lily — implementation plan and milestone tracker

Status legend: ✅ done and tested · 🧪 implemented, only partly verifiable here · ⏳ in progress · ✂️ removed on review

Design inputs (read-only, owned by the research team):
`everything_about_lily/lily_agent/*.md` (architecture), `everything_about_lily/method_design/method_pipeline_v2.md` (method).
How the design became code: [architecture.md](architecture.md). Decisions that refine or depart from the design: [decisions.md](decisions.md).

## Product definition

Lily is one kernel with two faces:

1. **A terminal coding agent people use every day** — `npm install -g lily-harness`, then `lily`: a Pi-style TUI with sessions that survive restarts, compaction, branching / fork / clone, model selection, steering and cancel. Every run's tools execute in an isolated environment.
2. **A clean trajectory generator** — the same kernel, driven through generic interfaces (SDK, `lily -p --json`, HTTP API), runs tasks in fresh isolated environments bound to immutable resource bundles and records call-level data (actual model inputs/outputs, raw tool outputs, observation derivations, token ids where available).

Lily provides mechanisms only. Datasets, checks/rewards, bundle search, routing policy and training live downstream and adapt to Lily's interfaces (D19).

## Round 1 milestones

### M0 — Foundations ✅
- [x] TypeScript on Node ≥ 22.19 (erasable-only syntax, `.ts` runs directly in a checkout); vitest; strict tsc
- [x] Pi packages pinned at exactly 0.85.1; stage-0 probe of the reused seams (`test/probe`)

### M1 — Execution plane ✅
- [x] `lily-envd` guest agent (Go, static, linux/darwin × amd64/arm64): fs primitives, exec with process groups, timeouts, cancel, spill, tar transfer with path safety, PID-1 `init` mode (VM mounts, vsock) — [envd-protocol.md](envd-protocol.md)
- [x] `EnvdClient`, `RemoteExecutionEnv`, `EnvironmentManager` (leases, concurrency cap, sweep, workspace export)
- [x] Backends: `local`, `seatbelt`, `apple-container`, `docker`, `podman`, `gvisor`, `firecracker` (verified in M11)

### M2 — Kernel ✅
- [x] Pi tool specs + raw executors + byte-identical baseline renderer; execution gateway with durable ledger; observation cap
- [x] System prompt assembly with block provenance; per-session recording model gateway; manifests; durable event log
- [x] `LilySession`/`LilyRuntime`: create/open/fork/clone, runs, cancel, steer, budgets, compaction, navigation, crash recovery

### M3 — Resource bundles ✅
- [x] Format, per-component digests, validation; immutable registry with refs, composition, diffs; renderer; processor DSL (F)
- ✂️ proposal/acceptance records → generic `derived` provenance (M9)

### M4 — Recording & export ✅
- [x] `lily.traj/v1` with provenance and fidelity; vLLM token capture → `token_exact`
- ✂️ teacher-view builder for one training method → generic `renderCallView` (M9)
- ✂️ SLIME adapter (M9)

### M5 — Product surfaces
- [x] CLI and TUI on pi-tui; HTTP API + SSE with durable cursor
- ✂️ web UI app (M10)

### M6 — Batch rollout & co-evolution control plane ✂️
- ✂️ task format/splits/judges, batch runner, proposer, MoH pools, synchronous task-run endpoint (D19)

### M7/M8 — Isolation acceptance, hardening, docs ✅
- [x] Seatbelt and Apple-container acceptance; failure injection (env killed mid-command, worker SIGKILL, cancellation, budgets)

## Round 2 milestones (after product review)

### M9 — Mechanisms, not policy ✅
- [x] Removed downstream logic: batch/judge/task format, proposer, proposal records, teacher views, MoH pools, SLIME adapter, `POST /api/tasks/run`
- [x] Router hook: sessions bound to `@router` ask `runtime.router` per run; decision recorded in `manifest.route`; `--router`, `config.router`, `examples/routers/by-label.mjs`
- [x] Generic labels (session + run), run annotations (`RunStore.annotate`, `lily annotate`, HTTP), bundle `derived` provenance with free-form data
- [x] `session.exec()` / `exportWorkspace()` for callers; `runtime.isolatedEnvironment()`; HTTP `mode: "batch"`, exec, workspace export, compose
- [x] `renderCallView()` (re-render a recorded call under other resources, no execution)
- [x] `lily -p --json` event stream; `--copy`; `--label`; TypeScript SDK entry (`src/index.ts`)
- [x] `examples/sdk/rollout.ts`: downstream orchestration built only on public interfaces, tested (`test/integration/sdk-example.test.ts`)
- [x] Path-parameter hardening (no `../` into LILY_HOME via encoded ids; bundle files limited to the index)

### M10 — Terminal product + release page ✅
- [x] npm package: compiled `dist/lib`, prebuilt envd binaries, `lily` bin; verified by packing and installing into a clean global prefix; `lily --script demo` works offline
- [x] TUI at pi/Claude-Code level: header, two-line footer (tokens, cost, context %), selectors (model — saved as default, resume, tree with summarize prompt and editor prefill, thinking, bundle), first-run setup screen, collapsible tool output and thinking, queued-steer display, `!command`, `@` file completion without `fd`, palette after `lily_sample2.png` checked on dark and light terminals — [tui.md](tui.md); pty tests at 100×30 and 80×24
- [x] Runtime support found while building it: abort during environment provisioning, `steer_queued` event, `session.prepare()`, single in-flight provisioning, navigation `customInstructions`
- [x] `site/`: static release page (hero after `lily_sample2.png`, install, intro, backends, demo replay recorded from the real TUI — `npm run site:demo`, docs rendered from `docs/` with link checking, changelog)

### M11 — Backend verification ✅
- [x] Parameterized backend acceptance suite (`test/isolation/backend-acceptance.test.ts`, `LILY_TEST_BACKEND`), 18–19 checks per backend
- [x] Passed: apple-container (host), docker, podman, gvisor, podman+gVisor (Linux VM), firecracker plain and jailed (KVM-enabled Linux VM via nested virtualization); 24 defects fixed along the way (D24); setup in `scripts/verify/`
- [x] Platform compatibility table and measured latencies ([environments.md](environments.md))
- Not covered: x86-64 hosts, Apple container on macOS 15, SELinux-enforcing hosts, `limits.diskMb`

## Testing

| Layer | How | Where |
|---|---|---|
| envd | Go unit + stdio end-to-end tests | `envd/*_test.go` |
| Pi seams | AgentHarness + JSONL + faux provider + fork | `test/probe` |
| Tools | Lily (raw → baseline) vs Pi core tools on the same directory | `test/integration/tool-equivalence.test.ts` |
| Runtime | Scripted model: skills/memory/F, records, export, views, routing, labels, exec, cancel, budget, env loss, steer, fork, reopen | `test/integration/runtime.test.ts` |
| Recovery | Worker SIGKILL mid-tool, reopen | `test/integration/recovery.test.ts` |
| Downstream example | `examples/sdk/rollout.ts` with router + checks + annotations | `test/integration/sdk-example.test.ts` |
| Token capture | Fake vLLM SSE through pi-ai's OpenAI adapter | `test/integration/token-capture.test.ts` |
| API | HTTP + SSE cursor, batch sessions, exec, workspace, annotations, compose, error codes, path hardening | `test/integration/server.test.ts` |
| Isolation | Seatbelt, Apple container VMs, parameterized backend suite (skipped when unavailable) | `test/isolation` |
| Units | Processor DSL, bundles/registry/render | `test/unit` |
| TUI | Pseudo-terminal keystroke tests | `test/tui/` |
| Package | `npm pack` → global install → `lily` from PATH | manual (see README) |
