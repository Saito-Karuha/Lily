# Trajectory export (`lily.traj/v1`)

`lily export <run> [--raw] [--payloads]` (or `GET /api/runs/:id/trajectory`) produces one JSON document per run. It is built from what was recorded at the real call boundaries — never reconstructed from the final transcript.

```jsonc
{
  "format": "lily.traj/v1",
  "exportedAt": 1758610000000,
  "manifest": RunManifest,          // frozen conditions: kernel, model, bundle + component digests, prompt blocks, processor, environment, budget, labels, route
  "outcome": RunOutcome,            // status, reason, turns, tool calls, usage, final text
  "annotations": { name: any },     // caller data attached to the run (lily annotate / PUT /api/runs/:id/annotations/:name), if any
  "fidelity": "semantic" | "request_exact" | "token_exact",   // lowest among policy turns (purpose "assistant")
  "calls": [ExportedCall],
  "tools": [ToolCallRecord (+ "raw" with --raw)]
}
```

## Calls

Each `ExportedCall` is one real model request:

| field | meaning |
|---|---|
| `callId`, `purpose`, `attempt` | purpose ∈ `assistant` (policy turn), `compaction`, `branch_summary`, `deferred` |
| `model` | provider, model id, API |
| `context` | the exact pi-ai `Context` sent: `systemPrompt`, `messages`, `tools` |
| `response` | the settled assistant message (text, thinking, tool calls, usage, stop reason) |
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
