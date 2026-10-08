# Configuration

Lily reads `~/.lily/config.json` (`$LILY_HOME/config.json`). `lily config` prints it, `lily config <key>` prints one key, and `lily config <key> <json-or-string>` sets one. All keys are optional.

```jsonc
{
  "model": "anthropic/claude-sonnet-4-5",     // default model, "provider/model-id"
  "thinking": "medium",                       // off | minimal | low | medium | high | xhigh | max
  "bundle": "base",                           // default resource bundle (ref/digest), or "@router"
  "router": "/path/to/router.mjs",            // bundle router module (see sdk.md#routing)
  "providers": { … },                         // self-hosted / custom endpoints (below)
  "environment": {
    "backend": "seatbelt",                    // local | seatbelt | apple-container | docker | podman | gvisor | firecracker
    "image": "python:3.12-slim",              // image for container/VM backends
    "limits": { "cpus": 2, "memoryMb": 2048, "pids": 512, "network": "none" },   // network: none | egress; diskMb (Firecracker)
    "maxConcurrent": 16,                      // environments one Lily process may hold at once
    "seatbeltReadPaths": ["/opt/homebrew"],   // extra host paths the Seatbelt sandbox may read
    "firecracker": { "kernel": "…/vmlinux", "rootfs": "…/rootfs.ext4" }   // enables the Firecracker backend (below)
  },
  "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 },
  "allowAmbientCredentials": false,           // let providers use host credential files (gcloud ADC, AWS profiles)
  "server": { "port": 7777, "host": "127.0.0.1", "allowedRoots": ["/data/tasks"] }   // allowedRoots: host paths the HTTP API may read
}
```

Command-line flags override the config for one invocation: `--model`, `--thinking`, `--bundle`, `--backend`, `--router`, `--home`.

`toolExecution` is **not a global configuration key**. Since 0.2.2, SDK and HTTP callers can choose `"parallel"` at session creation; the default is `"sequential"`. The choice is persisted with the session and cannot be changed per run. CLI/TUI-created sessions remain sequential, while reopening a session preserves its saved mode. See [same-turn tool execution](sdk.md#same-turn-tool-execution).

## Credentials

Built-in providers read their API keys from environment variables, for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY` and `MOONSHOT_API_KEY`. `lily models` lists what your keys unlock, and `lily models --all` lists every known model. By default Lily does not read host credential files. Set `allowAmbientCredentials: true` to allow them. Credentials are used on the host only and never enter the agent's environment.

## Self-hosted models

Any OpenAI-compatible server works as a custom provider:

```json
{
  "model": "local-vllm/Qwen/Qwen3-8B",
  "providers": {
    "local-vllm": {
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "models": [{ "id": "Qwen/Qwen3-8B", "contextWindow": 32768, "maxTokens": 8192 }],
      "tokenCapture": "vllm"
    }
  }
}
```

| provider field | |
|---|---|
| `api` | `openai-completions`, `openai-responses` or `anthropic-messages` |
| `baseUrl` | the endpoint |
| `apiKeyEnv` | environment variable holding the key (omit for keyless local servers) |
| `headers` | extra request headers |
| `compat` | pi-ai compatibility settings for every model of the provider, e.g. for `openai-completions`: `sendSessionAffinityHeaders` (send the session key as `x-session-affinity`, for engines and routers that keep a session on one replica or cache), `thinkingFormat` (for a model with `reasoning: true`: `"qwen-chat-template"` sends `chat_template_kwargs: {enable_thinking, preserve_thinking: true}` from the thinking level; `"chat-template"` sends the `chatTemplateKwargs` you give), `supportsDeveloperRole`, `maxTokensField` |
| `models[]` | `{id, name?, contextWindow?, maxTokens?, reasoning?, input?: ["text","image"], samplingParams?, compat?}` — a model's `compat` keys override the provider's |
| `tokenCapture: "vllm"` | ask vLLM (≥ 0.10.2) for prompt and sampled token ids (`return_token_ids`), so recorded calls are `token_exact` |

Everything here that shapes requests — the model's limits, sampling parameters, `compat`, the token capture mode, and digests of `baseUrl` and `headers` — is recorded in every run manifest (`manifest.model`, with a `configDigest`), so runs made under different settings can be told apart. The session key a request carries is `<session id>:main`.

## Firecracker

`environment.firecracker` enables the backend on Linux with KVM ([environments.md](environments.md#firecracker-root-filesystems), [scripts/firecracker/README.md](../scripts/firecracker/README.md)):

| key | |
|---|---|
| `kernel` | uncompressed guest kernel (required) |
| `rootfs` | default root filesystem |
| `images` | `{name: rootfs path}`: a spec's `image` picks one |
| `rootfsMode` | `overlay` (default), `reflink` or `copy` |
| `diskMb` | writable space of an overlay VM when the spec has no `limits.diskMb` (default 4096) |
| `vcpus`, `memoryMb` | defaults when the spec has no limits (2, 2048) |
| `jailer`, `uid`, `gid` | run every VM under Firecracker's jailer as that user (Lily must run as root) |
| `cacheDir`, `resourceCacheMb` | shared resource drives and image digests (default `~/.lily/cache/firecracker`, 1024 MiB) |
| `firecracker`, `mkfs`, `vsockPort`, `bootTimeoutMs` | binaries and protocol details |

## Resource bundles

`lily init` imports the two example bundles (`base`, which is empty, and `demo`) and sets `bundle: "base"`. Your own bundles are imported with `lily bundle import <dir> --ref <name>` ([bundle-format.md](bundle-format.md)). Use `--bundle none` to run the bare kernel.

## Data directory

```
~/.lily/
  config.json
  sessions/        Pi-format session files (conversation trees)
  session-meta/    per-session binding, event log, tool invocation ledger
  runs/<run>/      manifest.json, calls.jsonl, tools.jsonl, outcome.json, annotations/
  artifacts/       content-addressed blobs (contexts, responses, raw tool outputs)
  registry/        resource bundles (immutable) and refs
  envs/            environment records (and working state of local/Seatbelt environments)
  cache/           derived files that can be deleted at any time (Firecracker resource drives, image digests)
```
