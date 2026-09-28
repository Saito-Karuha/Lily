# Lily HTTP API (v1)

`lily serve [--port 7777] [--host 127.0.0.1] [--router <module>] [--max-environments N] [--allow-root <dir>]…` serves this JSON API under `/api`. It is Lily's language-neutral control surface — for programs in any language that want to drive sessions, follow their events and read back what was recorded. It knows nothing about datasets, checks, rewards or training: callers build those on top (see [sdk.md](sdk.md) for the TypeScript equivalent and a worked example). With `--script <file|demo>` the offline scripted model becomes the default model for that server process. When bound to localhost, requests whose `Host` header is not `127.0.0.1`/`localhost` are rejected (DNS-rebinding protection).

Two options shape what a server accepts:

- **Capacity.** A server holds at most `--max-environments` environments at once (default `environment.maxConcurrent`, else 16). When all are in use, a request that needs a new one fails at once with 503 `capacity_exhausted` instead of waiting, so schedulers see the limit; `GET /api/status` reports it. Environments are released when their session is deleted or closed, or explicitly with `DELETE /api/sessions/:id/environment`.
- **Host paths.** Requests name host paths for workspaces, initial states, root filesystems and bundle imports. With `--allow-root <dir>` (repeatable) or `server.allowedRoots` in config.json, every such path must resolve, symlinks included, to one of those directories or below (403 `forbidden_path` otherwise). Without them, any existing path is accepted: the API trusts its clients, as `exec` on the `local` backend already does.

Errors are `{"error": {"code", "message"}}`:

| status | codes |
|---|---|
| 400 | `bad_request` (missing/invalid field, malformed JSON, unknown field in an environment spec or view request, path parameter containing `/`, `\`, `.` or `..`), `invalid_id`, `session_busy` (a run is active), `not_running` (steer without a run), `session_closed`, `unknown_model`, `no_router` (an `@router` session but no router configured), `invalid_environment` (a spec the backend cannot provide, e.g. `initialState: image` on `local`, an unknown backend or Firecracker image), `backend_unavailable`, `invalid_view`; errors reported by the environment's envd (`permission_denied`, `is_directory`, …) |
| 403 | `forbidden_host`, `forbidden_path` (a host path outside the allowed roots) |
| 404 | `not_found` (unknown session, run, call, entry, bundle, bundle file, route; a missing file in an environment; no live environment) |
| 413 | `too_large` (a request body or file over the limit) |
| 503 | `capacity_exhausted` — every environment slot is in use; `error.details.capacity` has the numbers |
| 500 | `internal` (a bug; please report) |

All ids are opaque strings: sessions are UUIDv7 (`01a0…`), runs are `run_<hex>`, bundles are `sha256:<64 hex>` digests (any unique prefix or a ref name such as `base` is accepted where a bundle is expected).

## Status and configuration

| Method | Path | Result |
|---|---|---|
| GET | `/api/status` | `{version, home, defaultModel, defaultBundle, router, openSessions, liveEnvironments, capacity: {environments: EnvironmentCapacity}}` — `router` is the configured bundle router's name or null |
| GET | `/api/models?available=1` | `[{provider, id, name, api, contextWindow, reasoning}]` — `available=1` only lists providers with credentials |
| GET | `/api/environments?usage=1` | `{backends: [{name, isolation, available, reason?}], live: [EnvironmentInfo (+ usage: EnvironmentUsage\|null with usage=1)], capacity: EnvironmentCapacity}` |

`EnvironmentCapacity`: `{max, live, provisioning, free, waiting, whenFull: "wait"|"reject"}` — `free` environments can be created now; `lily serve` always uses `reject`.

## Sessions

A session is one conversation tree plus its binding (model, bundle, environment spec). Runs happen inside sessions.

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/api/sessions?mode=interactive\|batch` | | `[SessionSummary]` newest first |
| POST | `/api/sessions` | `{mode?, workspace?, backend?, environment?, model?, bundle?, title?, labels?, budget?, prepare?}` | `{sessionId, binding, environment?}` (see below) |
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
| GET | `/api/sessions/:id/environment` | | `{info: EnvironmentInfo, usage: EnvironmentUsage\|null}` of the live environment; 404 when none is live |
| POST | `/api/sessions/:id/environment` | | `{info}` — provisions the environment now (a no-op for `@router` sessions, whose bundle is chosen per run) |
| DELETE | `/api/sessions/:id/environment` | | `{released: bool}` — destroys the live environment and frees its slot; the session stays usable and its next run or file operation provisions a fresh one from the initial state. 400 `session_busy` during a run |
| PUT | `/api/sessions/:id/files?path=<p>&mode=<octal>?` | raw bytes | `{path, bytes}` — writes one file (parent directories are created) |
| GET | `/api/sessions/:id/files?path=<p>` | | the file's bytes (`application/octet-stream`, ≤ 512 MiB) |
| POST | `/api/sessions/:id/upload?root=<dir>` | `.tar.gz` bytes | `{root, files, bytes}` — extracts the archive under `root` (default: the workspace) |
| GET | `/api/sessions/:id/download?path=<dir>` | | `application/gzip` tar of a directory (default: the workspace) |
| GET | `/api/sessions/:id/runs` | | `[RunSummary]` |

The file endpoints, like `exec`, act on the session's environment for the caller between runs (400 `session_busy` during one): the model never sees them and they are not recorded. They provision the environment when none is live. Paths are environment paths: absolute as given, relative ones below the workspace. Uploaded archives follow envd's rules (no absolute names, `..` or links out of the root; [envd-protocol.md](envd-protocol.md#archives-tar-gzip)); bodies are limited to 512 MiB.

Creating a session:

- `mode: "interactive"` (default): `workspace` (required unless `environment` is given) is a host directory used as the workspace — mounted live on backends that can share a host directory, copied otherwise.
- `mode: "batch"`: a fresh environment whose workspace starts as a copy of `workspace` (or empty when omitted); the host directory is never written. `mode` also decides whether the system prompt carries the current date (interactive only).
- `environment`: instead of `workspace`/`backend`, a full `EnvironmentSpec` (below) — for example a Firecracker root filesystem and an archive as the initial state. The session is the same as one created through the SDK with that spec.
- `prepare: true`: provision the environment before answering, and return its `EnvironmentInfo` as `environment`. If that fails — 503 `capacity_exhausted`, a backend error — the session is deleted and the error returned, so a session either has its environment or does not exist.
- `bundle`: a ref/digest/prefix, `"@router"` (the server's router chooses a bundle at the start of every run — start the server with `--router <module>` or set `router` in config.json), or `null` for no bundle; omit it for the configured default.
- `labels`: `{string: string}` recorded in every run manifest and shown to the router. `budget`: `{maxTurns?, timeoutMs?}` applied to every run.

`EnvironmentSpec` (as a request body; unknown fields are rejected):

```jsonc
{
  "backend": "firecracker",                 // default: the configured backend
  "image": "py311",                         // container image, or a name from firecracker.images; default: environment.image
  "rootfs": "/data/rootfs/py311.ext4",      // Firecracker only: this root filesystem (wins over image)
  "initialState": {"kind": "archive", "path": "/data/tasks/t1.tgz"},
      // {kind: "empty"} (default) | {kind: "directory", path, exclude?: [names]} | {kind: "archive", path}
      // | {kind: "mount", path} | {kind: "image"}: keep what the image has at /workspace
  "limits": {"cpus": 2, "memoryMb": 4096, "pids": 1024, "diskMb": 8192, "network": "none"},   // default: environment.limits; replaced whole
  "env": {"TASK_ID": "t1"},                 // extra variables for commands in the guest
  "label": "t1"                             // shown in listings
}
```

Host paths (`initialState.path`, `rootfs`) must exist and lie inside the allowed roots when those are configured.

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
| GET | `/api/runs/:id/trajectory?purpose=…&fields=…&encoding=delta` | a projection: only calls with the listed purposes (`assistant,compaction,branch_summary,deferred,other`), only the listed per-call fields (`context,provenance,response,options,payload,tokens,usage`), and with `encoding=delta` prompt token ids prefix-encoded against the previous call ([trajectory-format.md](trajectory-format.md#projections)). Any of the three parameters selects a projection |
| POST | `/api/runs/:id/calls/:callId/view` | body `CallViewRequest` → `{runId, callId, context?, payload?, target, report, model?}` — the call re-rendered under other resources (see below) |
| POST | `/api/runs/:id/calls/:callId/payload` | body `{context?}` → `{runId, callId, payload, recordedPayloadMatches?, model}` — the wire payload of the recorded context (then `recordedPayloadMatches` says whether it equals the payload that was sent; null when none was recorded), or of the given pi-ai `Context`, under the call's recorded request options |
| GET | `/api/runs/:id/markdown` | `text/markdown` rendering of the run |
| GET | `/api/runs/:id/annotations` | `{name: value}` |
| PUT | `/api/runs/:id/annotations/:name` | body: any JSON — attaches caller data (a score, a review, …) to the run under `name`; exports include it. Lily never interprets annotations |
| GET | `/api/artifacts/:digest` | the blob (JSON or text) |

`RunSummary`: `{runId, sessionId, createdAt, mode, prompt, model, bundle: {digest, name}|null, routedBy: string|null, labels, backend, isolation, status, reason?, turns?, toolCalls?, usage?, endedAt?, fromTipId: string|null, tipId: string|null}`. `fromTipId`/`tipId` are the conversation tip before and after the run (entry ids; `tipId` is null while the run is still going), so a client can place a run exactly in the entry tree. `status` ∈ `running | completed | failed | aborted | blocked | interrupted`.

`RunOutcome`: `{runId, status, reason?, error?, startedAt, endedAt, turns, toolCalls, modelCalls, usage: {input, output, cacheRead, cacheWrite, totalTokens, cost}, finalText?, fromTipId?, tipId?, environmentUsage?: {envId, cpuMs?, memoryPeakBytes?, source}}`. `environmentUsage.cpuMs` is the CPU time the environment used during the run; `memoryPeakBytes` is its peak since it was created (not reset between runs).

`RunManifest` (abridged): `{runId, sessionId, createdAt, mode, prompt: {text, digest}, kernel: {version, piAgentCore, piAi, toolsDigest, compaction, observationCapBytes}, model: ModelConfigRecord, bundle: {digest, name, componentDigests: {P,M,S,U,F}}|null, processorId, systemPrompt: {digest, blocks: [{kind, component?, componentDigest?, text}]}, environment: EnvironmentInfo, budget, labels?, route?: {router, requested: "@router", bundle, info?}}`.

`ModelConfigRecord`: `{provider, modelId, api, thinkingLevel, baseUrlDigest?, headersDigest?, contextWindow, maxTokens, reasoning, input, samplingParams?, compat?, thinkingLevelMap?, tokenCapture: "vllm"|"custom"|"none", configDigest}` — the configuration that shapes the run's requests (URL and headers only as digests; they may carry credentials). `configDigest` covers all of it, so runs whose requests could differ through configuration alone have different digests. Manifests written before 0.2 have only the first four fields.

`EnvironmentInfo`: `{envId, generation, backend, isolation: "none"|"process-sandbox"|"container"|"user-kernel"|"vm", paths: {workspace, resources, home, tmp}, image?, rootfs?: {path, digest, bytes}, createdAt, startupMs?, guest: {os, arch, hostname, uid, envdVersion}, details, limits, initialState}` — `rootfs` is the Firecracker image the VM booted from, `startupMs` the time from the provisioning request until the environment was ready.

`EnvironmentUsage`: `{cpuMs?, memoryPeakBytes?, source: "host"|"guest"}` since the environment was created. `host`: measured outside the guest (Firecracker's VMM process; the container's cgroup for docker, podman and gVisor), `guest`: read from the guest's own cgroup (Apple containers). The `local` and `seatbelt` backends do not measure.

### Call views and payloads

`CallViewRequest`: `{bundle?: ref|digest|null, replace?: ["attached_prompt"|"tool_guidance"|"skills"|"memory"], processor?: "from-resources"|"baseline", systemPrefix?, observationCapBytes?, output?: "context"|"payload"|"both"}`. It is `renderCallView` ([trajectory-format.md](trajectory-format.md#re-rendering-a-call-under-other-resources)) with the resources named by a bundle ref: `bundle` rebuilds the chosen system prompt blocks from that bundle (rendered for the run's guest paths; `null` for no resources; omitted keeps the recorded prompt), `processor` recomputes observations from the raw outputs with that bundle's processor or Pi's baseline (omitted keeps them), `systemPrefix` goes before the system prompt. `output` also asks for the wire payload of the view (`payload`, `both`), built as by the payload endpoint. `report` counts re-rendered observations; `target` is the recorded response. 400 `invalid_view` when the call cannot be re-assembled (its system prompt differs from the manifest's, or `from-resources` without a bundle).

Payloads are built by the provider's own request code (pi-ai's message conversion, compat handling, request options), stopped before anything is sent. `model` reports `{provider, modelId, configDigest, matchesManifest}`: `false` means the model's configuration on this server changed since the run, so the payload may differ from what the run would have sent. Rendering needs the provider configured on the server, as for a real request.

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
