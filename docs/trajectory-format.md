# Trajectory export (`lily.traj/v1`)

`lily export <run> [--raw] [--payloads]` (or `GET /api/runs/:id/trajectory`) produces one JSON document per run. It is built from what was recorded at the real call boundaries — never reconstructed from the final transcript.

```jsonc
{
  "format": "lily.traj/v1",
  "exportedAt": 1758610000000,
  "manifest": RunManifest,          // frozen conditions: kernel, model and its effective configuration, bundle + component digests, prompt blocks, processor, environment (incl. root filesystem digest), budget, labels, route
  "outcome": RunOutcome,            // status, reason, turns, tool calls, usage, final text
  "annotations": { name: any },     // caller data attached to the run (lily annotate / PUT /api/runs/:id/annotations/:name), if any
  "fidelity": "semantic" | "request_exact" | "token_exact",   // lowest among policy turns (purpose "assistant")
  "calls": [ExportedCall],
  "tools": [ToolCallRecord (+ "raw" with --raw)]
}
```

## Tool execution mode and ordering

Since 0.2.2, each new manifest records `kernel.toolExecution` (`"sequential"` or `"parallel"`), fixed at session creation and pinned before the run's first model call. `RunStore.readManifest()` and exports interpret a missing historical field as `"sequential"`; they do not rewrite old files or change their kernel version, prompt or digests. Old session bindings are read with the same default.

In parallel mode, tool results in a recorded model context stay in the original assistant call order, even if they finish in another order. Events and the top-level `tools` array reflect execution/recording order, not necessarily model-context order. Associate records using `toolCallId`, `invocationId` and `rawRef`, never by array index. The next model request occurs only after the whole tool batch settles.

Cancellation and uncertainty remain distinct: Bash raw envelopes carry `exec.cancelled` / `exec.timedOut`; calls prevented by the harness have kernel-generated results and no real raw execution; lost in-flight effects have `unknown` ledger records (or a durable `dispatched` without `completed` after a crash), not fabricated raw output. The top-level `tools` list contains completed raw captures, not one guaranteed entry per planned call. The per-session invocation ledger remains the durable source for effect state. Run outcomes retain the existing `aborted`, `blocked`, `interrupted` and `failed` states.

Call views and observation re-rendering use the recorded IDs and raw artifacts as before. They neither replay tool effects nor simulate a new execution schedule.

## Calls

Each `ExportedCall` is one real model request:

| field | meaning |
|---|---|
| `callId`, `purpose`, `attempt` | purpose ∈ `assistant` (policy turn), `compaction`, `branch_summary`, `deferred` |
| `model` | provider, model id, API |
| `context` | the exact pi-ai `Context` sent: `systemPrompt`, `messages`, `tools` |
| `response` | the settled assistant message (text, thinking, tool calls, usage, stop reason) |
| `options` | the request options as recorded (sampling parameters, reasoning level, session id, …; no callbacks, signals or credentials) — with `context` they rebuild the payload ([below](#wire-payloads)) |
| `payload` | provider-native request body (with `--payloads`) |
| `tokens` | `{promptTokenIds, outputTokenIds}` when the engine returned them |
| `fidelity` | `token_exact` (engine token ids) › `request_exact` (wire payload) › `semantic` |
| `stopReason`, `errorMessage` | how the call settled (`stop`, `toolUse`, `length`, `error`, `aborted`); which calls to learn from is the consumer's choice |
| `provenance` | see below |

### Provenance

- `systemPromptMatchesManifest` — true when the call's system prompt is exactly the run's assembled prompt; then `systemBlocks` gives `{kind, component, componentDigest, start, end}` character spans for `kernel`, `attached_prompt` (P), `tool_guidance` (U), `skills` (S), `memory` (M) and `environment`.
- `messages[i]` — `origin` ∈ `user | assistant | tool_result | compaction_summary | branch_summary`. Tool results produced by a real execution carry `invocationId`, `rawRef` (artifact digest of the raw envelope), `rawComplete` and `processorId`; results synthesized by the kernel (unknown tool, invalid arguments) are marked `kernelGenerated`.

Why per call and not one long sequence: after compaction a call sees a summary instead of the old messages, and providers may drop or re-encode earlier thinking and tool calls. Concatenating calls would invent conditions no call actually had.

## Raw envelopes

`tools[i].raw` (or `GET /api/artifacts/:rawRef`) is the result *z* of one execution, captured before any formatting:

- `read`: `resolvedPath`, and `content` = `{kind: "text", startLine, totalFileLines, text (requested range), userLimitedLines?, firstLineBytes}` or `{kind: "image", mimeType, bytes, data}`
- `bash`: `output` (combined stdout+stderr in write order), `exec` = `{exitCode, signal, timedOut, cancelled, totalBytes, capturedBytes, spillPath}`
- `write`: `bytesWritten`; `edit`: `replaced`, `diff`, `patch`, `firstChangedLine`
- all: `args` (as executed), `error?`, `complete` (false when a kernel cap cut the capture), `durationMs`

## Re-rendering a call under other resources

A recorded call can be viewed under different resources without running anything — useful whenever something (a scorer, a reviewer, another model) should see the same history through a different system prompt or observation formatting. The SDK function `renderCallView(call, manifest, options, artifacts)` returns `{callId, context, target, report}`:

- the conversation (user turns, assistant turns, tool calls) is exactly as recorded, and `target` is the recorded response;
- `options.resources` (from `renderResources` on any bundle) rebuilds the chosen system prompt blocks — `options.replace` picks which of `attached_prompt`, `tool_guidance`, `skills`, `memory` (default: all four); the kernel and environment blocks always stay as recorded;
- `options.processor` (an `ObservationProcessor`, e.g. `baselineProcessor`, or `"from-resources"`) recomputes every tool observation from its archived raw output, then applies the kernel cap;
- `options.systemPrefix` prepends text to the system prompt.

`report` counts re-rendered observations and those kept as recorded (no raw archived, kernel-generated). Which blocks to swap, which processor to use and what prefix to add is entirely the caller's decision. For token-level use, tokenize the view's `context` with the policy's chat template and append the recorded `outputTokenIds` unchanged, so both contexts are evaluated on the same sampled output.

## Wire payloads

`renderCallPayload(models, model, context, options)` (SDK) builds the provider-native request body for a pi-ai context by running the provider's own request code — the same function that built the recorded `payload` — and stopping at its payload hook, before anything is sent. Given a call's recorded `context` and `options` it reproduces the recorded payload, which is how a consumer can check that the replay path matches the recording; given a view's context it gives the payload that context would have produced under the same conditions. `runtime.callPayload(runId, callId, context?)` and `POST /api/runs/:id/calls/:callId/payload` do this for stored runs and report `recordedPayloadMatches` and whether the model's configuration still matches the manifest's `model.configDigest`.

## Projections

A full export carries every call's whole context, so a long run moves O(turns²) messages. A projection selects what to export:

- `purposes`: only calls with these purposes (e.g. `assistant`);
- `fields`: only these per-call fields among `context`, `provenance`, `response`, `options`, `payload`, `tokens`, `usage` (identity and status fields — `callId`, `purpose`, `attempt`, `model`, times, `fidelity`, `stopReason`, `errorMessage` — are always present);
- `tokenEncoding: "delta"`: prompt token ids prefix-encoded.

SDK: `exportRunProjection(store, artifacts, {purposes, fields, tokenEncoding, includeRaw})`; HTTP: `GET /api/runs/:id/trajectory?purpose=assistant&fields=tokens,options&encoding=delta`. The document is a `lily.traj/v1` export with a `projection: {purposes?, fields, tokenEncoding}` member; `manifest`, `outcome`, `annotations`, `fidelity` and `tools` are as in a full export.

With delta encoding, each call's `tokens.promptTokenIds` is `{base, prefix, tail}` instead of an array. The reference sequence is the previous call in `calls` that has tokens (`base` names it): its decoded prompt ids followed by its output ids. The prompt is the first `prefix` ids of the reference followed by `tail`. The first call with tokens has `base: null, prefix: 0`. Successive calls of an agent loop usually extend the previous prompt and output, so `tail` holds only the new tool result and template tokens. Decoding is a single pass in order:

```python
seqs = {}
for call in doc["calls"]:
    t = call.get("tokens")
    if not t: continue
    p = t["promptTokenIds"]
    if isinstance(p, dict):
        ref = seqs[p["base"]] if p["base"] else []
        p = ref[:p["prefix"]] + p["tail"]
    t["promptTokenIds"] = p
    seqs[call["callId"]] = p + t["outputTokenIds"]
```

(`decodeTokenDeltas` in the SDK.)
