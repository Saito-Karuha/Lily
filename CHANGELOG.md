# Changelog

## 0.2.2 — 2026-10-08

**Tool execution**
- SDK `createSession` and HTTP `POST /api/sessions` accept `toolExecution: "parallel"` for overlapping independent tool calls in one assistant message. The default remains `"sequential"`; no existing caller needs to change.
- The mode is fixed at session creation, persisted on reopen and inherited by forks/clones. The SDK exposes the effective value as `session.toolExecution`; invalid values and attempts at per-run overrides are rejected. There is no new global setting, CLI/TUI toggle or per-turn concurrency cap.
- Pi's existing durable harness supplies the whole-turn barrier and source-ordered model results. Ordinary errors preserve sibling results; abort and time limits cancel all in-flight process groups, and unknown effects after transport loss or worker crashes are not replayed.
- An already-aborted envd exec request no longer starts a command before cancelling it.
- Completed tool records are awaited and fsynced before returning to the loop. After a worker crash, missing per-run tool records are repaired from the durable ledger without replaying effects.
- Cancellation-time `tool_end.isError` reflects the recorded observation even when Pi skips its after-tool hook during abort.

**Compatibility and records**
- New manifests record `kernel.toolExecution`. Missing fields in old bindings/manifests mean sequential; reading them does not rewrite historical files.
- The kernel identifier is `lily-kernel/0.1.2`. Tool schemas, the fixed system prompt, default observation formatting, resource loading and isolation policies are unchanged; Pi dependencies remain at 0.85.1.

## 0.2.1 — 2026-10-07

**Fixes**
- The fixed system prompt now includes Pi's general read/edit/write usage guidelines: prefer `read` for files, batch independent edits against the original file, keep replacement text small and unique, and use `write` for new files or complete rewrites. When `read` cannot handle a file or line because of size limits, the prompt allows inspecting a bounded portion with `bash`.
- These guidelines apply even without a resource bundle. Tool schemas, execution, resource blocks and project-context loading are unchanged; Pi-specific environment-variable guidance is not included.

**Reproducibility**
- The model-visible prompt changed, so the kernel identifier is now `lily-kernel/0.1.1` (previously `lily-kernel/0.1.0`). Pi dependencies remain pinned to 0.85.1.

**Releases**
- The release workflow uses an explicit local tarball path for `npm publish`, preventing npm from interpreting `out/<package>.tgz` as a GitHub repository.

## 0.2.0 — 2026-09-28

Mechanisms for programs that drive many isolated runs — schedulers, evaluators, trainers — over the HTTP API or the SDK.

**Environments**
- Firecracker environments choose their root filesystem: `rootfs` in the spec, or an `image` name mapped by `firecracker.images`. The environment info (and every run manifest) records the image's path, size and sha256 digest.
- Firecracker VMs no longer copy their image. By default (`rootfsMode: "overlay"`) every VM attaches the image read-only and writes to its own sparse disk of `limits.diskMb` (default 4096 MiB), stacked with overlayfs by `lily-envd init --overlay`; creation time no longer depends on the image size, and `limits.diskMb` is enforced. `rootfsMode: "reflink"` keeps a reflink copy per VM and fails clearly where reflinks are unavailable; `"copy"` is the previous behaviour. The guest kernel needs overlayfs, and root filesystems must be rebuilt with this release's `lily-envd`.
- Resource bundles are packed into Firecracker drives once per bundle digest and shared by all VMs (`cacheDir`, `resourceCacheMb`).
- `initialState: {kind: "image"}` keeps what an image ships at `/workspace`. **Behaviour change:** every other initial state now starts from exactly its own content; `empty` used to show whatever the image had at `/workspace`.
- Capacity: `environment.maxConcurrent` (default 16). `lily serve --max-environments N` answers 503 `capacity_exhausted` when all slots are in use instead of holding the request; `/api/status` reports `capacity`.
- Each environment records `startupMs`; container and VM backends report CPU time and peak memory (`lease.usage()`, measured from the host for Firecracker, docker, podman and gVisor), and run outcomes carry `environmentUsage`.
- `session.releaseEnvironment()` frees an environment between runs; the next run starts a fresh one.
- Files between runs, for the caller and never recorded: `session.writeFile`, `readFile`, `upload`, `download`.
- Specification and backend errors are reported as `invalid_environment` / `backend_unavailable`.

**HTTP API**
- `POST /api/sessions` accepts a full `environment` spec (backend, image, rootfs, initial state, limits, env, label) and `prepare: true` (provision now; the session is deleted if that fails).
- `--allow-root <dir>` / `server.allowedRoots` confine the host paths requests may name (403 `forbidden_path`).
- New endpoints: `GET|POST|DELETE /api/sessions/:id/environment`, `PUT|GET /api/sessions/:id/files`, `POST /api/sessions/:id/upload`, `GET /api/sessions/:id/download`, `POST /api/runs/:id/calls/:callId/view`, `POST /api/runs/:id/calls/:callId/payload`.
- `GET /api/runs/:id/trajectory?purpose=…&fields=…&encoding=delta` exports projections.
- Environment-side errors (a missing file) are 4xx, not 500.

**Records and replay**
- `renderCallPayload()` builds the provider-native payload for any context with the provider's own request code, without sending it; it reproduces every recorded payload. `runtime.callPayload()` / `runtime.callView()` replay stored calls, with bundles named by ref.
- Exports include each call's recorded request `options`. `exportRunProjection()` selects calls and fields and prefix-encodes token ids; `decodeTokenDeltas()` restores them.
- Run manifests record the model's effective configuration: context window, max tokens, sampling parameters, compat, token capture mode, digests of the base URL and headers, and a `configDigest` over all of it.

**Models**
- Custom providers accept pi-ai `compat` settings (provider-wide and per model), for example `sendSessionAffinityHeaders` or `chatTemplateKwargs`.

## 0.1.2 — 2026-09-25

**Fixes**
- `lily --version`, the TUI header, the HTTP API and the SDK's `LILY_VERSION` reported 0.1.0 in the 0.1.1 package. They now read the version from the package, and `lily-envd` is built with the same version.

## 0.1.1 — 2026-09-25

**Fixes**
- Every command failed with `ENOTDIR` when `~/.lily/envs` contained a file, such as the `.DS_Store` that Finder creates when the folder is opened. The startup sweep now only looks at directories.

**Docs**
- Getting started explains how to uninstall. Registered bundles are stored read-only, so removing `~/.lily` needs `chmod -R u+w` before `rm -rf`.

**Releases**
- The release workflow can publish to npm with trusted publishing (repository variable `NPM_TRUSTED_PUBLISHING`).

## 0.1.0 — 2026-09-25

First release of Lily.

**Terminal agent**
- `lily`: interactive TUI in the current directory. Streaming answers, tool cards with diffs, steering while the agent works, Esc to cancel, sessions that survive restarts, compaction, conversation tree navigation, fork and clone, model and thinking-level selection.
- `lily -p "<prompt>"` for one-shot runs and `--json` for a JSON-lines event stream. Add `--copy` to work on a fresh copy of the directory.
- `lily --script demo` tries everything offline with a bundled scripted model.
- Built-in providers of the Pi AI layer (keys from environment variables) plus self-hosted OpenAI-compatible endpoints.

**Isolation**
- Every tool call runs through the guest agent `lily-envd` in an isolated environment. Host environment variables and credentials never enter it.
- Backends: `local`, `seatbelt` (macOS sandbox, the macOS default), `apple-container` (a lightweight VM per environment on macOS 26 / Apple silicon), `docker`, `podman`, `gvisor`, and `firecracker` (one microVM per environment on Linux + KVM). All container and VM backends pass the same acceptance suite (Linux arm64, including Firecracker under nested virtualization; x86-64 not yet tested).

**Resource bundles and recording**
- Immutable, content-addressed resource bundles with five components: attached prompt, memory, skills, tool guidance and observation processor. They are pinned per run, composable component by component, and carry free-form derivation provenance.
- Router hook: sessions bound to `@router` get a bundle chosen per run by a user-supplied module, and the decision is recorded.
- Every run is recorded with its exact conditions (manifest), every model call at the provider boundary (token ids from vLLM), raw tool outputs before formatting, the outcome, labels and annotations. `lily export` writes `lily.traj/v1`.

**Programmatic use**
- TypeScript SDK (`import { LilyRuntime } from "lily-harness"`), `lily -p --json`, and a local HTTP API (`lily serve`) with durable event streams.
