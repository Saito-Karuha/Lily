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
    "limits": { "cpus": 2, "memoryMb": 2048, "pids": 512, "network": "none" },   // network: none | egress
    "seatbeltReadPaths": ["/opt/homebrew"],   // extra host paths the Seatbelt sandbox may read
    "firecracker": { "kernel": "…/vmlinux", "rootfs": "…/rootfs.ext4" }   // enables the Firecracker backend
  },
  "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 },
  "allowAmbientCredentials": false,           // let providers use host credential files (gcloud ADC, AWS profiles)
  "server": { "port": 7777, "host": "127.0.0.1" }
}
```

Command-line flags override the config for one invocation: `--model`, `--thinking`, `--bundle`, `--backend`, `--router`, `--home`.

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
| `models[]` | `{id, name?, contextWindow?, maxTokens?, reasoning?, input?: ["text","image"], samplingParams?}` |
| `tokenCapture: "vllm"` | ask vLLM (≥ 0.10.2) for prompt and sampled token ids (`return_token_ids`), so recorded calls are `token_exact` |

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
```
