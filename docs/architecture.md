# Architecture

How Lily is put together. Details of individual choices are in [decisions.md](decisions.md), the guest protocol in [envd-protocol.md](envd-protocol.md), the HTTP surface in [api.md](api.md).

## 1. Components and trust boundary

```
                    ┌──────────── trusted control plane (the Lily process) ────────────┐
  TUI ────────┐     │                                                                   │
  lily -p ────┼ SDK ┤ LilyRuntime ── LilySession (one worker per session, single writer) │
  HTTP API ───┘     │     │            ├─ Pi AgentHarness (fixed kernel K)              │
                    │     │            ├─ RecordingModels (this session's model gateway) │──→ model providers
                    │     │            ├─ ExecutionGateway + invocation ledger           │
                    │     │            └─ EventLog (durable events with a cursor)         │
                    │     ├─ BundleRegistry (immutable bundles, refs, derivation)         │
                    │     ├─ BundleRouter (optional: picks a bundle per run for @router)  │
                    │     ├─ ArtifactStore (sha256-addressed raw outputs, contexts, …)    │
                    │     ├─ JsonlSessionRepo (Pi v4 session trees)                        │
                    │     └─ EnvironmentManager (leases, concurrency cap, sweep)           │
                    └────────────────────────────────┬──────────────────────────────────┘
                                                     │ JSON lines (stdio / vsock)
                    ┌──────────── one environment per session (untrusted) ─────────────┐
                    │ lily-envd: file and process primitives                             │
                    │ /workspace  /opt/lily/resources (read-only)  /home/agent  /tmp      │
                    │ no host environment variables, no credentials, no network default  │
                    └────────────────────────────────────────────────────────────────────┘
```

- **Sessions, the loop and environments have independent lifetimes.** Session data lives in `~/.lily/sessions` (Pi JSONL) and `~/.lily/session-meta/<id>` (binding, ledger, events) and survives the process. Environments are created and destroyed by the EnvironmentManager under leases. The loop (Pi's AgentHarness) lives as long as the session worker is open.
- **Untrusted code only runs inside environments.** The control plane receives data from envd (text, bytes) with size caps. The observation processor F is interpreted by fixed code in the control plane, and bundle content is never executed as control-plane code.

## 2. What happens in a run

1. `LilySession.prompt()` decides the run's bundle: either the bound digest, or, for sessions bound to `@router`, the router's choice, which is recorded. It then makes sure an environment with that bundle is live, recreating it and carrying the workspace over if the bundle changed. Concurrent callers share one in-flight provisioning. Next it renders the resources, assembles the system prompt (recording its blocks), picks the observation processor, and writes the **RunManifest**, including labels and route.
2. The session points call recording at this run and accepts the prompt on Pi's lane (with its own operation id), then drives it to completion.
3. Every model request (including compaction and branch summaries) goes through RecordingModels, which records the purpose, the context (stored deduplicated), options, provider payload, response, token evidence and fidelity.
4. Every tool call goes through the ExecutionGateway. It first checks the ledger, then durably writes `dispatched`, runs `executeRaw` in the environment, archives the raw envelope, applies F and the kernel cap, and writes `completed`. The result goes back to Pi with `details.lily` (raw reference, processor id, …).
5. At the end, the records are flushed and the **RunOutcome** is written (status, reason, turns, tool calls, usage, final text, conversation tips), followed by a `run_end` event.

Budgets: `maxTurns` is checked at turn ends and `timeoutMs` by a timer. Both stop through Pi's durable cancellation and record `budget_turns` / `budget_time`. An abort requested while the environment is still being provisioned is applied as soon as the operation exists.

## 3. Data layout (`$LILY_HOME`, default `~/.lily`)

```
config.json
sessions/--lily-<mode>--/<time>_<id>.jsonl   Pi v4 session files
session-meta/<sessionId>/binding.json        model, bundle, environment spec, labels, runs
session-meta/<sessionId>/ledger.jsonl        tool invocation ledger (dispatched/completed/unknown)
session-meta/<sessionId>/events.jsonl        Lily event log (seq cursor)
runs/<runId>/manifest.json | calls.jsonl | tools.jsonl | outcome.json | annotations/<name>.json
artifacts/sha256/ab/cdef…                    content-addressed objects
registry/objects/<digest>/                   read-only bundle directories
registry/records/<digest>.json               BundleRecord
registry/refs.json
envs/<envId>/env.json (+ state/)             environment records (working state for local/Seatbelt)
```

## 4. Fixed kernel K and resource bundle R

| K (fixed, never part of a bundle) | R = (P, M, S, U, F) |
|---|---|
| Pi 0.85.1 loop, sessions, compaction, branch summaries | `prompt/attached.md` → the `<additional_instructions>` block |
| schema, description, argument preparation and raw executors of the four tools | `tools/*.md` → the `<tool_guidance>` block (tool descriptions are unchanged) |
| system prompt skeleton and block order (kernel, P, U, S, M, environment) | `skills/<name>/SKILL.md` + files → skill catalog, read on demand |
| execution gateway, ledger, kernel caps, F interpreter | `memory/**` → fixed entry point `memory/index.md` |
| environment backends and isolation policy | `observation/processor.json` → F rules |

Bundles are published by content digest, and runs only reference digests. A bundle composed from others' components (`compose`) is itself a digest-identified bundle. Many bundles can coexist. Sessions bound to `@router` get a bundle chosen per run by user code, and Lily only calls the router and records the decision (`manifest.route`).

## 5. Recovery semantics

| Situation | Behaviour |
|---|---|
| UI / event stream disconnects | the run continues; clients resume with `after=<seq>` |
| model stream fails | Pi's effect-pending semantics (a synthesized interruption error or a retry within budget, each recorded as its own call) |
| environment lost during a tool call | the ledger records `unknown`; the run ends `blocked` (`outcome_unknown`) |
| worker crashes during a tool call | on reopen, the unfinished operation is durably cancelled and the run is `interrupted`; the side effect happened once |
| tool finished but its result was not committed | the ledger has `completed`; the result is taken from the archive, not re-executed |
| conversation navigation / fork | only the conversation moves; mounted workspaces keep pointing at the same directory, copied workspaces start from the initial state or an export of the current one |

## 6. Boundary with downstream systems

Lily provides mechanisms and no downstream policy. It has no dataset format, no evaluation or scoring, no bundle search or pool management, and no training-framework adapter. Downstream systems use generic interfaces and implement their policies themselves ([sdk.md](sdk.md)):

- **Sessions and runs.** `batch` mode runs in a fresh environment (host directories are only copied), and labels and budgets are recorded per run.
- **Environments.** `session.exec()` and `exportWorkspace()` let the caller inspect the environment after a run. Neither enters the model's context or the trajectory.
- **Bundles.** A registry, component-wise composition, derived provenance with free-form data, and the `@router` hook.
- **Records.** `lily.traj/v1` ([trajectory-format.md](trajectory-format.md)) holds per-call exact contexts, responses, token evidence and provenance, plus raw tool envelopes and run annotations. `renderCallView()` re-renders a recorded call under other resources without executing anything.
- **Entry points.** The TypeScript SDK, `lily -p --json`, and the HTTP API.

`examples/sdk/rollout.ts` shows downstream code that uses only these interfaces to run tasks concurrently, check results and annotate runs.

## 7. Departures from the original design notes

- Tools execute in the control plane over envd primitives, not in a guest-side tool service (D2).
- After a worker restart, surviving environments are not re-attached. Unfinished runs are recorded as interrupted (D6).
- VM-level isolation comes from Apple `container` on macOS and Firecracker on Linux/KVM; both, and the container backends, pass the same acceptance suite (D11, D24).
