# Decision log

Each entry records a choice made while implementing the design in `everything_about_lily/lily_agent/`, especially where the implementation refines or departs from it. Newest last.

## D1 — Pi's durable `AgentHarness` is the loop; one lane per session
Lily assembles `@earendil-works/pi-agent-core@0.85.1`'s `AgentHarness` + `JsonlSessionRepo` rather than forking Pi's CLI. Each Lily session uses a single lane `main` and is driven by one `LilySession` worker per process (single writer). The system prompt and tool context are functions that read the *pinned run* (model, bundle, prompt, processor, environment), so nothing changes under a running or resumed run. Pi's own session tree, compaction, branch summaries, forks and operation recovery are used unchanged. Stage-0 probe: `test/probe/pi-seams.test.ts`.

## D2 — Raw executors run in the controller over envd primitives (not a guest ToolService)
The design preferred running Pi's tools inside the guest. Lily instead keeps the four tools in the trusted controller, split into `executeRaw` (does the effect through envd file/exec primitives and returns a raw envelope *z*) and a pure baseline renderer. Reasons: (1) tool semantics stay byte-identical to Pi (verified by `test/integration/tool-equivalence.test.ts`), (2) *z* is explicit and structured before any display formatting, so F and later views (`renderCallView`) re-render from archives without re-running anything, (3) the guest agent stays a ~3 MB static Go binary that works in any image (Python-only SWE images included). The cost is a few extra RPCs per `edit` (sub-millisecond over stdio) and untrusted *text* passing through the controller — the same text is sent to the model anyway; sizes are capped (64 MiB read, 16 MiB bash stream, 256 KiB observation). No untrusted binary is parsed in the controller (images are only magic-byte sniffed and base64 encoded).

## D3 — Small, explicit vendoring from Pi
`src/kernel/tools/vendor/` holds three Pi 0.85.1 files that are not exported by the package (`edit-diff.ts`, `image.ts`, `path-utils.ts`), unchanged except import paths, MIT-attributed. Schemas, descriptions and `prepareArguments` are taken live from `createReadTool()` etc. This is the "small controlled fork" the design anticipated; nothing else of Pi is copied.

## D4 — F is a declarative DSL; errors stay kernel-owned
`observation/processor.json` (`lily.processor/v1`) is interpreted by fixed kernel code: first matching rule, steps such as `head/tail/headTail/keepLines/dropLines/truncateLines/dedupe/maxChars/note`, regexes screened for backreferences, lookaround and nested quantifiers. F may reshape bash output and successful read results only; failed read/write/edit messages and images always use the baseline, and failing bash commands always end with Pi's status line (`Command exited with code N`, timeouts, aborts). The kernel cap (256 KiB of text) applies after F. With no processor, the baseline renderer reproduces Pi exactly and is identified as `kernel:pi-baseline@0.85.1`.

## D5 — Replay goes through the invocation ledger
Lily's tools declare `replay: "safe"`, but the gateway never re-executes an effect: it fsyncs a `dispatched` record (keyed by Pi's invocation id) before the effect, archives *z* and writes `completed` after it. On replay, a completed invocation is served from the archive; a dispatched-but-unfinished one is recorded `unknown`, the run is stopped (`blocked`, reason `outcome_unknown`) and the model never sees a retryable error. A lost environment during a tool is treated the same way.

## D6 — Worker restart closes open runs as `interrupted` (no environment re-attach in v1)
When a session is reopened with an operation left open by a dead process, Lily requests a durable abort and records the run as `interrupted` (reason `worker_restarted`); the session is immediately usable for new prompts. Environments are owned by the controller process (local envd dies with its parent; container environments are swept), so re-attaching to a live environment is left for a later version. `test/integration/recovery.test.ts` kills a worker mid-command and checks that the effect ran exactly once.

## D7 — One recording model gateway per session
Found by a concurrent-runs test: a single `RecordingModels` shared by all sessions let concurrent runs write call records into each other's run. Each `LilySession` now wraps the shared registry in its own gateway; `before_request` purpose hints are per session too.

## D8 — Contexts are stored as deduplicated parts
Every model call records the exact pi-ai `Context` it was given, but as `{systemPromptRef, messageRefs[], toolsRef}` with each message a content-addressed blob, so a long run costs O(messages) storage instead of O(turns²). Provider payloads (the wire request) are stored whole when the adapter exposes them.

## D9 — Durable event log with ephemeral deltas
Each session has `events.jsonl` with a strictly increasing `seq` for every event except streaming deltas (`message_delta`, `tool_update`), which are broadcast live only. Clients reconnect with `?after=<seq>`; the SSE endpoint replays and then sends a `hello` marker before going live. The Pi transcript remains the source of truth for message content.

## D10 — envd merges stdout and stderr into one pipe
Pi reads two pipes and interleaves by arrival. envd gives the child the *same* pipe for both, so the combined stream preserves the real write order; per-stream attribution is not recorded. Background processes that keep the pipe open are cut off 100 ms after the shell exits (same rule as Pi); envd as PID 1 (`init`) reaps orphans.

## D11 — Isolation tiers and defaults
`seatbelt` (process sandbox) is the interactive default on macOS; `apple-container` (one VM with its own kernel per environment, verified on macOS 26) is the VM tier available on the development machine; `docker`/`podman` (`container`) and `gvisor` (`user-kernel`) share one CLI backend; `firecracker` (one microVM per environment) needs Linux/KVM (verified, see D24). Every manifest records the backend and isolation level so experiments never mix tiers silently. Guest commands run as root *inside* container/VM guests (the guest is the boundary); resources and the envd binary are read-only mounts.

## D12 — Skills and memory follow the "catalog first, read on demand" contract
The skills block is Pi's `formatSkillsForSystemPrompt` with guest paths; memory is announced by a fixed kernel sentence pointing at `memory/index.md`. There is no `/skill` expansion and no memory tool: the model reads files with its normal tools, so "did not choose / did not read / did not use" stay distinguishable in trajectories.

## D13 — No implicit project context
Pi's coding agent loads `AGENTS.md` and other files from ancestor directories. Lily does not: the kernel prompt is fixed and the task's files are visible through tools. This keeps K clean and runs reproducible.

## D14 — (withdrawn) Judging inside Lily
An earlier version judged batch items in a separate environment. Removed with D19: checking results is the caller's job (`session.exec` after the run, or its own environment).

## D15 — (withdrawn) Pool selection policy
An earlier version implemented Mixture-of-Harness pools. Removed with D19; see D20 for what replaced it.

## D16 — Date only in interactive prompts
The environment block includes the current date only for interactive runs; batch-mode runs omit it so identical conditions produce identical prompts.

## D17 — Token capture by teeing the HTTP stream
For vLLM (≥ 0.10.2) Lily adds `return_token_ids` via pi-ai's `samplingParams` and wraps the adapter's `fetch` to tee the SSE stream, reading `prompt_token_ids` (first chunk) and `choices[0].token_ids` (every chunk). pi-ai and the OpenAI SDK consume an unchanged stream. Calls with token evidence are `token_exact`; with a provider payload `request_exact`; otherwise `semantic`.

## D18 — Slash-command recovery in the TUI
pi-tui's editor can apply a stale autocomplete entry when Enter follows the last keystroke within ~80 ms (`/env` → `/eenv`). Lily recovers a known command name preceded by one of its own prefixes; anything else is reported as unknown.

## D19 — Lily provides mechanisms, never downstream policy
Lily is a product (a terminal coding agent) and, in research use, only a trajectory generator. The first version also contained downstream logic: a task-file format with splits and judges, a batch runner, a proposer workflow with proposal/acceptance records, teacher-view construction for one specific training method, Mixture-of-Harness pool allocation/selection, and a SLIME adapter. All of it was removed. Such logic hard-codes one experiment's choices into the harness, and it inverts the dependency: trainers and evaluators must adapt to Lily, not Lily to them. What remains is generic: isolated sessions (`batch` mode), labels and budgets per run, `session.exec`/`exportWorkspace` for callers to inspect environments, run annotations for callers' results, a bundle registry with composition and free-form derivation provenance, a router hook (D20), faithful recording and export, and `renderCallView` for re-rendering recorded calls under other resources. `examples/sdk/rollout.ts` shows downstream code built on these; it is an example, not part of the harness.

## D20 — Bundle routing is a hook
To let several bundles coexist behind one entry point, a session may bind the literal bundle `@router`. At the start of each run Lily calls `router.route({sessionId, runId, mode, prompt, labels})`, resolves the returned bundle, and records `{router, bundle, info}` in the manifest. The router is plain user code (an object or a module's default export, `--router` / `config.router` / `runtime.router`). Lily has no opinion on how it decides or how its set of bundles changes.

## D21 — The TUI is the product; the web page is a release page
The web app from the first round (sessions/runs/bundles pages) was removed. Lily is used in the terminal (`npm install -g lily-harness`, then `lily`). `site/` is a static release page (introduction, demo replay recorded from the real TUI, docs rendered from `docs/`, install command). `lily serve` remains as a JSON API only.

## D22 — Compiled JavaScript in the npm package
Node refuses to strip TypeScript types for files under `node_modules`, so the published package ships `dist/lib` (tsc with `rewriteRelativeImportExtensions`) plus the prebuilt `lily-envd` binaries. `bin/lily.mjs` runs `src/` when it exists (a source checkout) and `dist/lib` otherwise, so development never runs a stale build.

## D23 — Environment sweeps only touch environments recorded in the calling home
`EnvironmentManager.sweep()` used to let the Apple container backend delete every `lily-*` container not live in the current home, which also destroyed other homes' environments (a second server, concurrent tests). Backends now receive the set of environment ids recorded in the calling home and remove only those.

## D24 — Every isolation backend is verified by one acceptance suite
`test/isolation/backend-acceptance.test.ts` (selected with `LILY_TEST_BACKEND`) checks what isolation must mean on every backend: clean environment, read-only resources and envd, network off (loopback on) or egress, cpu/memory/pids limits, cross-environment isolation, orphan reaping, cancellation of process trees, workspace export, lost-lease detection, non-root users, and sweeps that never touch another home. It passed on apple-container (host), docker, podman, gvisor and podman+gVisor (in a Linux VM) and firecracker with and without the jailer (in a KVM-enabled Linux VM using Apple's nested virtualization). Running it found 24 defects, among them podman never being detected, gVisor's host pids limit killing sandboxes, VM-mode exit codes lost to PID 1's reaper, writable resources in Firecracker guests and an unusable jailer mode. The verification setup is scripted in `scripts/verify/`.

## D25 — Stopping the process destroys its environments
Container and VM environments are separate processes on the host (or inside a VM service) and outlive a Lily process that simply exits. The CLI therefore handles SIGHUP (terminal closed), SIGINT and SIGTERM in every mode: it destroys the runtime's environments, restores the terminal when it is still there, and exits with 128 + the signal number. A lease's teardown is single-flight: a second `destroy()` waits for the first instead of returning early, which previously let the process exit halfway through a teardown when two closers raced (`test/integration/signals.test.ts`). A process killed with SIGKILL still leaves its environments behind; the next start in the same `LILY_HOME` sweeps them (D23).

## D26 — One locale everywhere: C.UTF-8
Commands run with `LANG`/`LC_ALL` set to `C.UTF-8` on every backend. It exists on macOS and on glibc and musl Linux, whereas `en_US.UTF-8` is missing from most minimal Linux systems, where bash then prints a setlocale warning at the start of every command's output. Found by running the suite on Linux before the first release.

## D27 — Releases are tags
A release is a pushed tag `vX.Y.Z` that matches `package.json`. `.github/workflows/release.yml` tests the tag, builds the npm tarball and the `lily-envd` binaries, publishes to npm when an `NPM_TOKEN` secret exists and the version is new (a version already on npm is attached as the registry's own tarball), writes `SHA256SUMS`, and creates the GitHub release with the matching CHANGELOG section as notes. The release page is deployed from the same workflow once GitHub Pages is enabled (repository variable `PAGES_ENABLED`). Continuous integration runs on Linux for every push; macOS runs on demand because its runner minutes are expensive on private repositories.

