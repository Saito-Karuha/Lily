# Lily HTTP API (v1)

`lily serve [--port 7777] [--host 127.0.0.1] [--router <module>]` serves this JSON API under `/api`. It is Lily's language-neutral control surface — for programs in any language that want to drive sessions, follow their events and read back what was recorded. It knows nothing about datasets, checks, rewards or training: callers build those on top (see [sdk.md](sdk.md) for the TypeScript equivalent and a worked example). With `--script <file|demo>` the offline scripted model becomes the default model for that server process. When bound to localhost, requests whose `Host` header is not `127.0.0.1`/`localhost` are rejected (DNS-rebinding protection).

Errors are `{"error": {"code", "message"}}`:

| status | codes |
|---|---|
| 400 | `bad_request` (missing/invalid field, malformed JSON, path parameter containing `/`, `\`, `.` or `..`), `invalid_id`, `session_busy` (a run is active), `not_running` (steer without a run), `session_closed`, `unknown_model`, `no_router` (an `@router` session but no router configured) |
| 404 | `not_found` (unknown session, run, entry, bundle, bundle file, route) |
| 403 | `forbidden_host` |
| 500 | `internal` (a bug; please report) |

All ids are opaque strings: sessions are UUIDv7 (`01a0…`), runs are `run_<hex>`, bundles are `sha256:<64 hex>` digests (any unique prefix or a ref name such as `base` is accepted where a bundle is expected).

## Status and configuration

| Method | Path | Result |
|---|---|---|
| GET | `/api/status` | `{version, home, defaultModel, defaultBundle, router, openSessions, liveEnvironments}` — `router` is the configured bundle router's name or null |
| GET | `/api/models?available=1` | `[{provider, id, name, api, contextWindow, reasoning}]` — `available=1` only lists providers with credentials |
| GET | `/api/environments` | `{backends: [{name, isolation, available, reason?}], live: [EnvironmentInfo]}` |

## Sessions

A session is one conversation tree plus its binding (model, bundle, environment spec). Runs happen inside sessions.

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/api/sessions?mode=interactive\|batch` | | `[SessionSummary]` newest first |
| POST | `/api/sessions` | `{mode?, workspace?, model?, bundle?, backend?, title?, labels?, budget?}` | `{sessionId, binding}` (see below) |
| GET | `/api/sessions/:id` | | `{binding, tipId, busy, activeRunId, environment: EnvironmentInfo\|null, lastSeq}` |
| PATCH | `/api/sessions/:id` | `{model?, bundle? (ref or null), thinking?}` | `SessionBinding` (applies from the next run) |
| DELETE | `/api/sessions/:id` | | `{ok}` |
| GET | `/api/sessions/:id/entries?scope=branch\|tree` | | `[Entry]` Pi session entries, oldest first. `branch` = current path, `tree` = every entry (use `parentId` to build the tree) |
| GET | `/api/sessions/:id/events?after=<seq>` | | **SSE** stream (see below) |
| POST | `/api/sessions/:id/prompt` | `{text, labels?, budget?}` | `{runId}` — returns immediately; follow progress on the event stream. `labels` are overlaid on the session's for this run. 400 `session_busy` if a run is active |
| POST | `/api/sessions/:id/abort` | | `{ok}` once the run has stopped |
| POST | `/api/sessions/:id/steer` | `{text}` | `{ok}` — adds a user message to the *running* task (seen at the next turn); 400 `not_running` if idle |
| POST | `/api/sessions/:id/compact` | `{instructions?}` | `{status, entryId?}` |
| POST | `/api/sessions/:id/navigate` | `{targetId, summarize?, customInstructions?}` | `{status, tipId, editorText?}` — moves the conversation only; files are not rolled back. As in Pi's `/tree`, targeting a **user** message moves the tip to that message's parent and returns its text as `editorText` (re-ask or edit it); any other entry becomes the tip itself. `targetId: null` goes to the root |
| POST | `/api/sessions/:id/fork` | `{entryId?, position?: "before"\|"at", workspace?: "initial"\|"current"}` | `{sessionId, binding}` |
| POST | `/api/sessions/:id/exec` | `{command, timeoutMs?, cwd?}` | `{exitCode, signal, timedOut, output, truncated, durationMs}` — runs a shell command in the session's environment for the caller (e.g. to check the workspace after a run). Not part of any run: the model never sees it and it is not recorded. Provisions the environment if none is live; 400 `session_busy` during a run. `output` is the combined stdout/stderr tail (≤ 1 MiB) |
| GET | `/api/sessions/:id/workspace` | | `application/gzip` tar of the environment's workspace |
| GET | `/api/sessions/:id/runs` | | `[RunSummary]` |

Creating a session:

- `mode: "interactive"` (default): `workspace` (required) is a host directory used as the workspace — mounted live on backends that can share a host directory, copied otherwise.
- `mode: "batch"`: a fresh environment whose workspace starts as a copy of `workspace` (or empty when omitted); the host directory is never written.
- `bundle`: a ref/digest/prefix, `"@router"` (the server's router chooses a bundle at the start of every run — start the server with `--router <module>` or set `router` in config.json), or `null` for no bundle; omit it for the configured default.
- `labels`: `{string: string}` recorded in every run manifest and shown to the router. `budget`: `{maxTurns?, timeoutMs?}` applied to every run.

`SessionSummary`: `{sessionId, title?, mode, model, bundle, createdAt, updatedAt, runs, workspaceLabel?, labels?, parent?, open, busy}`.

`SessionBinding`: `{sessionId, createdAt, updatedAt, title?, mode, model, thinking, bundle: digest|"@router"|null, environment: {spec, current?}, runs: string[], parent?, workspaceLabel?, labels?, budget?}`.

### Entries (Pi session format)

```jsonc
{ "id": "…", "parentId": "…"|null, "seq": 12, "timestamp": 1758610000000, "type": "message",
  "message": { "role": "user", "content": "text or [{type:"text",text}]", "timestamp": … } }
// assistant: {"role":"assistant","content":[{"type":"thinking","thinking"},{"type":"text","text"},{"type":"toolCall","id","name","arguments"}],
//             "stopReason":"stop|toolUse|length|error|aborted","errorMessage"?,"usage":{input,output,cacheRead,cacheWrite,totalTokens,cost:{total}},"model","provider"}
// toolResult: {"role":"toolResult","toolCallId","toolName","content":[{"type":"text","text"}|{"type":"image","data","mimeType"}],"isError",
//              "details": {"lily": LilyToolMeta, "diff"?: "…"}}
// other entry types: {"type":"compaction","summary","tokensBefore"}, {"type":"branch_summary","summary","fromId"}
```

`LilyToolMeta`: `{invocationId, toolName, isError, rawRef, rawComplete, processorId, envId, envGeneration, durationMs, exitCode?, capped?, reconciled?}`. `rawRef` is an artifact digest (`GET /api/artifacts/:digest`) holding the raw tool envelope.

### Event stream

`GET /api/sessions/:id/events?after=<seq>` answers `text/event-stream`. Each message is `data: {"seq": n, "at": ms, "event": LilyEvent}`. Persisted events have increasing `seq` (a per-session event counter, unrelated to an entry's `seq`; take the starting cursor from `lastSeq` in `GET /api/sessions/:id` or the `hello` event); high-volume streaming events (`message_delta`, `tool_update`) have `seq: -1` and are never replayed. After replaying everything with `seq > after`, the server sends `{"seq": -1, "event": {"type": "hello", "sessionId", "lastSeq", "busy", "activeRunId"}}` and then streams live. Reconnect with the last seen positive `seq`.

`LilyEvent` types:

| type | fields |
|---|---|
| `session_created` | `sessionId, title?` |
| `run_start` | `runId, sessionId, prompt, model, bundle, envId` |
| `turn_start` | `runId, turn` |
| `message_start` | `runId, role` |
| `message_delta` | `runId, kind: "text"\|"thinking"\|"toolcall", contentIndex, delta` (ephemeral) |
| `message_end` | `runId, entryId?, message` (full AgentMessage as in entries) |
| `tool_start` | `runId, toolCallId, toolName, args` |
| `tool_update` | `runId, toolCallId, text` (ephemeral live output tail) |
| `tool_end` | `runId, toolCallId, toolName, isError, content: [{type, text?, mimeType?}], lily?: LilyToolMeta, diff?` |
| `compaction_start` / `compaction_end` | `runId?, reason` / `runId?, status, entryId?, error?` |
| `navigation_end` | `status, fromTipId, tipId, error?` |
| `retry` | `runId?, attempt, maxAttempts, delayMs, error` |
| `usage` | `input, output, cacheRead, cacheWrite, cost` (session totals) |
| `environment` | `status: "provisioning"\|"ready"\|"lost"\|"destroyed", info?: EnvironmentInfo, message?` |
| `steer_queued` | `runId, text` — a steering message was queued for the running task |
| `notice` | `level: "info"\|"warning"\|"error", message` |
| `run_end` | `runId, outcome: RunOutcome` |

## Runs and trajectories

| Method | Path | Result |
|---|---|---|
| GET | `/api/runs?limit=100` | `[RunSummary]` newest first |
| GET | `/api/runs/:id` | `{manifest: RunManifest, outcome: RunOutcome\|null, annotations: {name: value}}` |
| GET | `/api/runs/:id/trajectory?raw=1&payloads=1` | `ExportedTrajectory` (`lily.traj/v1`, see trajectory-format.md) |
| GET | `/api/runs/:id/markdown` | `text/markdown` rendering of the run |
| GET | `/api/runs/:id/annotations` | `{name: value}` |
| PUT | `/api/runs/:id/annotations/:name` | body: any JSON — attaches caller data (a score, a review, …) to the run under `name`; exports include it. Lily never interprets annotations |
| GET | `/api/artifacts/:digest` | the blob (JSON or text) |

`RunSummary`: `{runId, sessionId, createdAt, mode, prompt, model, bundle: {digest, name}|null, routedBy: string|null, labels, backend, isolation, status, reason?, turns?, toolCalls?, usage?, endedAt?, fromTipId: string|null, tipId: string|null}`. `fromTipId`/`tipId` are the conversation tip before and after the run (entry ids; `tipId` is null while the run is still going), so a client can place a run exactly in the entry tree. `status` ∈ `running | completed | failed | aborted | blocked | interrupted`.

`RunOutcome`: `{runId, status, reason?, error?, startedAt, endedAt, turns, toolCalls, modelCalls, usage: {input, output, cacheRead, cacheWrite, totalTokens, cost}, finalText?, fromTipId?, tipId?}`.

`RunManifest` (abridged): `{runId, sessionId, createdAt, mode, prompt: {text, digest}, kernel: {version, piAgentCore, piAi, toolsDigest, compaction, observationCapBytes}, model: {provider, modelId, api, thinkingLevel}, bundle: {digest, name, componentDigests: {P,M,S,U,F}}|null, processorId, systemPrompt: {digest, blocks: [{kind, component?, componentDigest?, text}]}, environment: EnvironmentInfo, budget, labels?, route?: {router, requested: "@router", bundle, info?}}`.

`EnvironmentInfo`: `{envId, generation, backend, isolation: "none"|"process-sandbox"|"container"|"user-kernel"|"vm", paths: {workspace, resources, home, tmp}, image?, createdAt, guest: {os, arch, hostname, uid, envdVersion}, limits, initialState}`.

## Resource bundles

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/bundles` | | `{bundles: [BundleRecord], refs: {name: digest}}` |
| POST | `/api/bundles/import` | `{path, ref?, parents?, data?}` | `BundleRecord` — with `parents` (refs/digests) and/or `data` (free-form JSON) the record's origin is `{kind: "derived", parents, data}` |
| POST | `/api/bundles/compose` | `{parts: {P, M, S, U, F}, name?, ref?}` | `BundleRecord` — a new bundle whose component C is taken from bundle `parts[C]` |
| PUT | `/api/refs/:name` | `{target}` | `{name, digest}` |
| GET | `/api/bundles/:ref` | | `{record: BundleRecord, lineage: [{digest, name, origin, createdAt}]}` (lineage follows the first parent of derived bundles) |
| GET | `/api/bundles/:ref/files/<path>` | | file text (only paths listed in the bundle's `files`) |
| GET | `/api/bundles/:from/diff/:to` | | `[{path, component, action: "add"\|"modify"\|"delete"}]` |

`BundleRecord`: `{digest, manifest: {format, name, description?, composite?}, componentDigests: {P,M,S,U,F}, files: [{path, size, sha256, executable}], warnings, createdAt, origin: {kind: "import", source?} | {kind: "composite", parts} | {kind: "derived", parents, data?}}`. Components: **P** attached prompt (`prompt/attached.md`), **U** tool guidance (`tools/*.md`), **S** skills (`skills/<name>/SKILL.md`), **M** memory (`memory/**`), **F** observation processor (`observation/processor.json`).
