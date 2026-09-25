# Getting started

## Install

Lily needs **Node.js 22.19 or newer** (macOS or Linux).

```bash
npm install -g lily-harness
lily --version
```

The package includes the prebuilt guest agent `lily-envd` for macOS and Linux (x86-64 and arm64), so no compiler is needed.

## Try it offline

```bash
cd some/project
lily --script demo
```

`--script demo` uses a small scripted model bundled with Lily. It lists the workspace and replies, which is enough to see the interface, the tools running in an isolated environment, and how runs are recorded, all without an API key.

## Connect a model

Set the API key of any provider supported by the Pi AI layer, then pick a model:

```bash
export ANTHROPIC_API_KEY=…          # or OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY, …
lily models                         # models whose provider has credentials
lily config model anthropic/claude-sonnet-4-5
```

When you start `lily` without a usable model, it opens a setup screen listing the models your keys unlock. Your choice is saved as the default. Inside the TUI, `/model` switches models at any time.

Self-hosted OpenAI-compatible servers (vLLM, SGLang, llama.cpp, …) are configured in `~/.lily/config.json`, see [configuration.md](configuration.md#self-hosted-models).

## Use it

```bash
cd my-project
lily                                  # interactive session in this directory
lily "explain how the build works"    # start with a prompt
lily -c                               # continue the latest session here
lily -p "fix the failing test"        # one run, answer on stdout
```

In the TUI, type a message and press Enter. While the agent works, you can type again to steer it; the message reaches the model at its next turn. Esc cancels the running turn. `/help` lists the commands, and [tui.md](tui.md) has the details.

## Where it runs

Every tool call the agent makes (read, write, edit, bash) runs in an isolated environment through Lily's guest agent. Your shell's environment variables, API keys included, never enter it. The default isolation depends on the platform:

- **macOS**: the Seatbelt sandbox. The agent can read system directories and the project, can write only the project and its own temp/home directories, and has no network.
- **Linux**: `local` (no isolation). Configure a container, gVisor or Firecracker backend for real isolation.

You can switch to stronger isolation. For example, on macOS 26 with Apple silicon, a lightweight VM per session:

```bash
lily env backends                     # what's available here
lily config environment '{"backend":"apple-container","image":"docker.m.daocloud.io/library/python:3.12-slim"}'
```

See [environments.md](environments.md) for all backends and platform support.

## What gets recorded

Lily keeps everything under `~/.lily` (or `$LILY_HOME`): sessions, and for every run a manifest of its exact conditions, every model call, every raw tool output, and the outcome.

```bash
lily runs                             # recent runs
lily show <run>                       # a run as markdown
lily export <run> --raw -o run.json   # full trajectory (lily.traj/v1)
```

To drive Lily from code instead (evaluation scripts, trainers, services), see [sdk.md](sdk.md).
