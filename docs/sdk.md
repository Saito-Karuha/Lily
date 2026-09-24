# Programmatic use

Lily is a terminal agent first, but everything the TUI does is available to programs. There are three ways in, all driving the same runtime:

| Interface | Use it when |
|---|---|
| **TypeScript SDK** — `import { LilyRuntime } from "lily-harness"` | your code runs in Node (orchestrators, evaluation scripts, services) |
| **`lily -p "<prompt>" --json`** | you want one run from any language: spawn the CLI and read JSON lines |
| **`lily serve`** — HTTP API ([api.md](api.md)) | a long-lived process in any language drives many sessions, follows event streams, fetches trajectories |

Lily provides mechanisms, not policies. It runs sessions in isolated environments, pins and records every run, stores resource bundles, and calls a router when asked to. Datasets, checks, rewards, scheduling, and deciding which bundle is better all belong to the caller. The integration pattern is always the same: **your system adapts to Lily's interfaces**, and Lily contains nothing specific to your system.

## A first program

```ts
import { LilyRuntime, exportRun, RunStore } from "lily-harness";

const runtime = await LilyRuntime.create();            // ~/.lily (or LILY_HOME), config.json, default backends
const session = await runtime.createSession({
  mode: "batch",                                       // fresh environment; the host is never written
  model: "anthropic/claude-sonnet-4-5",
  bundle: "base",                                      // a ref, digest, "@router", or null
  environment: runtime.isolatedEnvironment({ kind: "directory", path: "./my-repo" }, "apple-container"),
  labels: { task: "fix-login" },
  budget: { maxTurns: 30 },
});

session.events.subscribe(({ event }) => {
  if (event.type === "tool_start") console.log("tool", event.toolName);
});

const run = await session.prompt("The login test fails. Fix it.");
const outcome = await run.done;                        // {status, reason?, turns, toolCalls, usage, finalText, …}

const check = await session.exec("python -m pytest -q", { timeoutMs: 120_000 });   // your check, outside the run
await new RunStore(runtime.home.run(run.runId)).annotate("tests", { passed: check.exitCode === 0 });

const trajectory = await exportRun(new RunStore(runtime.home.run(run.runId)), runtime.artifacts, { includeRaw: true });
await runtime.close();                                 // closes sessions and destroys their environments
```

`mode: "interactive"` with `runtime.defaultEnvironment(dir)` is what the TUI uses: the directory itself is the workspace (mounted live on backends that can share a host directory).

## Sessions and runs

A **session** is one conversation tree plus its binding (model, thinking level, bundle, environment spec, labels, budget). A **run** is one prompt and everything it causes: model calls, tool calls, until the agent stops, is aborted, or hits its budget. Everything that determines a run is frozen in its manifest before the first model call, including the kernel version, model, bundle and component digests, system prompt blocks, observation processor, environment, budget, labels and route.

| `LilySession` | |
|---|---|
| `prompt(text, {labels?, budget?})` → `{runId, done}` | start a run; `done` resolves with the `RunOutcome` |
| `abort()` · `steer(text)` | cancel the run · add a user message the model sees at its next turn |
| `exec(command, {timeoutMs?, cwd?})` | run a command in the session's environment for *you* (not recorded, not seen by the model) — between runs only |
| `exportWorkspace()` | gzip'd tar of the workspace |
| `compact()` · `navigate(entryId)` · `setModel` · `setBundle` · `setThinking` | same operations as the TUI |
| `events` | durable event log (`subscribe`, `read(afterSeq)`); event types in [api.md](api.md#event-stream) |

`runtime.forkSession(id, {entryId, position})` copies a conversation, and `runtime.openSession(id)` reopens one from disk. Sessions are single-writer: one open worker per session per process.

## Environments

Every tool call runs through `lily-envd` in the session's environment. Each environment starts from its `initialState`: a host directory, which is `mount`ed live or copied as `directory`, an `archive`, or `empty`. The chosen backend sets the isolation level ([environments.md](environments.md)). Specs are plain objects, so `runtime.isolatedEnvironment(initialState, backend)` is only a convenience that fills in the configured image and limits.

```ts
{ backend: "apple-container", image: "python:3.12-slim", initialState: { kind: "archive", path: "/tmp/state.tgz" },
  limits: { cpus: 2, memoryMb: 2048, network: "none" } }
```

For lower-level use, `runtime.envs.provision(spec)` returns a lease (`lease.client` is the envd client with `exec`, `readFile`, `upload`, `download`). Environments leaked by a crashed process are cleaned up by `runtime.envs.sweep()`, which `LilyRuntime.create` calls.

## Resource bundles

A bundle is an immutable, content-addressed directory with five components: attached prompt P, memory M, skills S, tool guidance U and observation processor F ([bundle-format.md](bundle-format.md)). The registry is `runtime.registry`:

```ts
const base = await runtime.registry.importDirectory("./bundles/base");
await runtime.registry.setRef("base", base.digest);
const edited = await runtime.registry.importDirectory("./work/candidate",
  { kind: "derived", parents: [base.digest], data: { author: "my-search", fromRuns: ["run_…"] } });
const mixed = await runtime.registry.compose({ P: "base", U: "base", F: "base", M: edited.digest, S: edited.digest });
await runtime.registry.changedComponents(base.digest, edited.digest);   // e.g. ["M", "S"]
```

`data` is stored verbatim and never interpreted. `registry.lineage(ref)` follows first parents.

## Routing

Several bundles can coexist, and a session can leave the choice to a **router**. Bind a session to the literal bundle `"@router"`, and at the start of every run Lily calls the runtime's router and records its decision in the manifest (`manifest.route = {router, requested: "@router", bundle, info}`).

```ts
import type { BundleRouter } from "lily-harness";

const router: BundleRouter = {
  name: "by-group",
  route: ({ labels, prompt, sessionId, runId, mode }) =>
    ({ bundle: labels.group === "bugfix" ? "fixer-v3" : "base", info: { group: labels.group } }),
};
runtime.router = router;                 // or LilyRuntime.create({ router }); may be replaced at any time
```

From the CLI, or for `lily serve`, a router is an ES module whose default export is either such an object or a bare `route` function:

```bash
lily --router ./my-router.mjs --bundle @router --label group=bugfix
```

It can also be set in `config.json` (`"router": "/path/to/router.mjs"`), which makes it available to the TUI too. `examples/routers/by-label.mjs` is a minimal example. How the router decides, and how its set of bundles grows or shrinks, is up to the router.

## Labels and annotations

**Labels** (`{string: string}`) are set on sessions and per run. They are recorded in the manifest and passed to the router, and Lily does nothing else with them. **Annotations** attach arbitrary JSON to a finished run under a name (`RunStore.annotate(name, value)`, `lily annotate`, `PUT /api/runs/:id/annotations/:name`). Exports include them.

## What is recorded, and reading it back

Per run, Lily records the manifest; every model call at the provider boundary, including the exact context, options and provider payload, the response, and, for vLLM with `tokenCapture: "vllm"`, prompt and output token ids; every tool call's raw output before formatting (content-addressed artifacts); the processor that formatted it; and the outcome. `exportRun(store, artifacts, {includeRaw, includePayloads})` assembles a `lily.traj/v1` document ([trajectory-format.md](trajectory-format.md)) with per-call provenance and a fidelity level (`semantic` < `request_exact` < `token_exact`).

`renderCallView(call, manifest, {resources, replace, processor, systemPrefix}, artifacts)` re-renders one recorded call's context under other resources without executing anything. The history stays as recorded, the chosen system prompt blocks come from another bundle, and observations are recomputed from the archived raw outputs by another processor.

## One-shot runs from any language: `lily -p --json`

```bash
lily -p "Fix the failing test" --json --copy --bundle base --label task=t1 > events.jsonl
```

Each line is `{"seq", "at", "event"}`, with the same events as the HTTP stream ([api.md](api.md#event-stream)). The stream ends with `run_end`, whose `outcome` holds the status and whose `runId` locates the run for `lily export <runId> --raw`. The exit code is 0 when the run completed. `--copy` runs on a fresh copy of the current directory instead of the directory itself.

## A worked example

[`examples/sdk/rollout.ts`](../examples/sdk/rollout.ts) is a small external orchestrator of the kind a trainer or evaluation harness would write. It reads its own task file, runs tasks concurrently in fresh environments with labels and optional routing, checks each result with a script run through `session.exec` after the run, annotates the run with the result, and exports trajectories. All task, check and score logic lives in that file, and Lily only supplies the mechanisms. `test/integration/sdk-example.test.ts` runs it against a scripted model.

```bash
node examples/sdk/rollout.ts --model <provider/model-id> --backend apple-container --concurrency 4 --out ./trajs
```
