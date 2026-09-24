# Using the TUI

Run `lily` in a project directory. The directory becomes the session's workspace, and the agent's tools run in an isolated environment on it (see [environments.md](environments.md)).

```bash
lily                         # new session in this directory
lily "add a --verbose flag"  # new session, starting with a prompt
lily -c                      # continue the latest session for this directory
lily -r <session>            # resume a session by id or id suffix
lily --script demo           # offline, with the bundled scripted model
```

## The screen

- The **header** shows the version, the model and thinking level, the bound resource bundle, the environment backend and its isolation level, the directory, and the key hints.
- The **transcript** shows your messages, the assistant's markdown, and tool calls as cards. A card shows `$ command` with the tail of its live output, a `read`, an `edit` with a diff and +/− counts, or a `write`. Long outputs are collapsed, and errors are shown in red. Each run ends with a status line: done, aborted or failed, then turns, tool calls, duration, tokens and cost. Thinking is collapsed to one line.
- The **footer** shows the directory and session title, the bundle, the backend and isolation (● when the environment is ready), token usage and cost, context usage as a percentage of the model's window (amber above 70%, red above 90%), and the model. While a run is active, a spinner and the elapsed time appear on the editor's border.

The environment starts in the background as soon as the TUI opens, so the first prompt usually doesn't wait for it.

## Keys

| key | |
|---|---|
| Enter | send; while a run is active, **steer** it (the message is queued and the model sees it at its next turn) |
| Shift+Enter, Alt+Enter | new line |
| Esc | interrupt the run (also while the environment is starting); close a selector |
| Ctrl+C | clear the editor; interrupt a run; press twice to exit |
| Ctrl+D | exit (on an empty editor) |
| Ctrl+L | select the model |
| Ctrl+O | expand / collapse all tool output |
| Ctrl+T | show / hide thinking |
| ↑ / ↓ | prompt history |
| `@` | reference a file (fuzzy completion; uses `fd` when installed, otherwise a built-in `.gitignore`-aware index) |
| `!command` | run a shell command in the session's environment yourself; the model does not see it |

## Commands

Type `/` for the command menu with descriptions. Commands marked *idle* are refused while a run is active.

| command | |
|---|---|
| `/help` | commands and keys |
| `/model [provider/id]` | select the model from those your credentials unlock. The choice becomes the default for new sessions (scripted models are never saved) |
| `/thinking [level]` | thinking level, limited to the levels the model supports |
| `/bundle [ref\|none]` | bind a resource bundle for the next run (lists refs, unnamed bundles, `none`, and `@router` when a router is configured) |
| `/new` | new session in this directory *(idle)* |
| `/resume [id]`, `/sessions` | session selector with title, age, run count and folder; Tab switches between this folder and all *(idle)* |
| `/tree` | navigate the conversation tree *(idle)*; see below |
| `/goto <entry> [--summarize]` | move to an entry by id *(idle)* |
| `/fork [entry]` | new session that re-asks from an entry *(idle)* |
| `/clone` | copy this conversation into a new session *(idle)* |
| `/compact [instructions]` | summarize older context now *(idle)* |
| `/env` | show the execution environment (backend, isolation, paths, limits) |
| `/runs` | this session's runs |
| `/export [run] [file]` | write a run's trajectory (`lily.traj/v1`) |
| `/quit` | exit |

In every selector: ↑/↓ moves, typing filters, Enter selects, Esc cancels.

## Branching

`/tree` shows the conversation as a tree with your current position (◆). Tab cycles the filter between conversation, user messages and everything. After you pick an entry, Lily asks whether to summarize the branch you are leaving, which costs one model call.

- If you pick a **user message**, the conversation moves to just before it and its text goes back into the editor. Edit it and send, and the new answer becomes a sibling branch.
- If you pick any other entry, the conversation continues from there.

Branching moves only the conversation. **Files in the workspace are not rolled back.** Use `/fork` or `/clone` for a separate session. With `lily --copy`, each session works on its own copy of the directory.

## First run

When no model is configured, or the configured model has no credentials, `lily` opens a setup screen instead of failing. It lists the models your API keys unlock (pick one and it becomes the default). It also explains how to set a key (`export ANTHROPIC_API_KEY=…`), shows how to configure a self-hosted OpenAI-compatible endpoint, and offers the offline demo.

## Colors

The palette follows Lily's visual identity: lavender mark, olive and forest greys, pollen amber, rust for errors. Every accent keeps at least 3:1 contrast on dark and light terminals, and body text uses your terminal's default color. Lily falls back to 256 colors when truecolor is unavailable, and `NO_COLOR` is honored.
