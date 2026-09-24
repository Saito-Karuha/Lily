# Resource bundles (`lily.bundle/v1`)

A resource bundle is everything about the agent that is meant to vary: R = (P, M, S, U, F). Everything else — the loop, tool schemas and implementations, prompt assembly, compaction, storage, isolation — is the fixed kernel K. Who writes bundles (a person, a script, another agent) is outside Lily.

## Layout

| Path | Component | How it reaches the model |
|---|---|---|
| `manifest.json` | — | `{"format": "lily.bundle/v1", "name": "...", "description": "..."}` (composite bundles add `composite: {P,M,S,U,F → digest}`) |
| `prompt/attached.md` | **P** attached prompt | System prompt region `<additional_instructions>…</additional_instructions>` after the kernel prompt. ≤ 16 KiB. |
| `tools/{read,bash,edit,write}.md` | **U** tool guidance | Region `<tool_guidance>` with one `<tool name="…">` per file. Tool descriptions and schemas are never modified. ≤ 4 KiB each. |
| `skills/<name>/SKILL.md` (+ any files) | **S** skills | The catalog (`<available_skills>`: name, description, location) is in the system prompt; the model reads SKILL.md and runs bundled scripts with its tools. |
| `memory/**` | **M** memory | A fixed kernel sentence points to `<resources>/memory/index.md`; entries are read with the normal tools. Read-only during runs. |
| `observation/processor.json` | **F** observation processor | Applied to every raw tool result before the model sees it (see below). |

Inside an environment the bundle is visible read-only at `paths.resources` (`/opt/lily/resources` in container/VM backends). The paths shown in the catalog are always the paths the model can actually read.

Validation (kernel rules, enforced on every publish): only the entries above; no symlinks, devices or odd file names; ≤ 2000 files, ≤ 2 MiB per file, ≤ 32 MiB total; skill directories match `^[a-z0-9][a-z0-9-]{0,63}$` and their SKILL.md frontmatter has `name` (equal to the directory) and `description` (≤ 1024 chars); the processor spec must validate. Nothing in a bundle is executed during validation.

## Identity

Files are hashed individually; each component digest is the digest of its file list (path, size, sha256, executable bit); the bundle digest covers the manifest hash and the five component digests. Two bundles with identical skills share the same `S` digest even if everything else differs, so "do these two bundles differ in component C?" is a digest comparison (`registry.changedComponents`).

## Registry

- `importDirectory(dir)` validates a copy, publishes it read-only under `registry/objects/<digest>` and writes a `BundleRecord` (idempotent).
- Refs (`base`, `latest`, …) are the only mutable pointers; runs always resolve to a digest before starting.
- `compose({P, M, S, U, F})` builds a bundle whose component C comes from bundle `parts[C]` (`lily bundle compose --from base --part M=other --part S=other`).
- `importDirectory(dir, {kind: "derived", parents, data})` publishes a bundle derived from others; `data` is free-form provenance (who produced it, why, from which runs) stored verbatim and never interpreted. `lineage` walks first parents; `checkout` makes a writable copy to edit.
- Several bundles coexist in one registry; sessions bind one explicitly, or bind `@router` to let a router module choose a bundle at the start of every run (see [sdk.md](sdk.md#routing)).

## Observation processor (`lily.processor/v1`)

```json
{
  "format": "lily.processor/v1",
  "tools": {
    "bash": [
      { "name": "short-search", "when": { "command": "^\\s*(grep|rg)\\b", "outputLinesGt": 200 },
        "steps": [ { "op": "truncateLines", "maxChars": 300 }, { "op": "head", "lines": 200 }, { "op": "note" } ] },
      { "steps": "baseline" }
    ]
  }
}
```

- Rules per tool; the first rule whose `when` matches applies; no match or `"baseline"` gives Pi's default output.
- Matchers: `command`, `path` (regex), `exitCode` (number, `"zero"`, `"nonzero"`), `outputLinesGt`, `outputBytesGt`, `error`.
- Steps: `stripAnsi`, `dropLines{pattern}`, `keepLines{pattern, context?}`, `truncateLines{maxChars}`, `dedupe`, `collapseBlank`, `head{lines?|bytes?}`, `tail{lines?|bytes?}`, `headTail{head, tail}`, `maxChars{chars, keep?}`, `prepend{text}`, `append{text}`, `note{text?}`. Templates may use `{exitCode} {totalLines} {shownLines} {spillPath} {path} {command} {startLine} {totalFileLines} {diff}`.
- Safety: regexes ≤ 256 chars, no backreferences, lookaround or nested quantifiers; long lines are matched on their first 10 000 chars; ≤ 32 rules per tool and ≤ 32 steps per rule.
- What F cannot do: change whether a result is an error, reshape failed read/write/edit messages or images, drop the exit status of a failing command (the kernel appends it), exceed the kernel cap (256 KiB), read files, or run tools.

The processor's identity is the digest of its spec (`kernel:pi-baseline@0.85.1` when there is none) and is recorded with every observation, so another processor can later re-render the same archived raw output (`renderCallView`, see trajectory-format.md).
