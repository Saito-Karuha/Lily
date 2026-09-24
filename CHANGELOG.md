# Changelog

## 0.1.0 — unreleased

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
