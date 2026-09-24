# lily-envd wire protocol (v1)

`lily-envd` is the only Lily component that runs **inside** an execution environment. It exposes filesystem and process primitives; it knows nothing about models, sessions, tool semantics, resource bundles, or other environments. Everything it returns is treated as untrusted data by the controller.

## Transport

- Newline-delimited JSON frames (UTF-8), one frame per line, over one bidirectional byte stream. v1 uses the process's **stdin/stdout** (`lily-envd serve --stdio`). stderr is for envd's own diagnostics only.
- Firecracker guests use the same framing over an AF_VSOCK stream. `lily-envd init --vm --vsock-port N` (the guest's PID 1) runs a `serve --vsock-port N --accept-loop` child that serves one controller at a time and is restarted if it dies; the server is deliberately not PID 1, whose orphan reaper would steal the exit statuses of the commands it runs.
- Maximum frame length: 16 MiB. A longer line is a protocol error (envd exits with status 2).
- When the stream reaches EOF, envd kills every running process group it started (SIGKILL) and exits with status 0. A controller that disappears therefore never leaves a half-owned command running *through envd*; background processes detached from those groups by the command itself are out of scope.

## Frames

```jsonc
// controller → envd
{"t":"req","id":7,"m":"fs.read","p":{"path":"/workspace/a.txt"}}
// envd → controller (success / failure)
{"t":"res","id":7,"ok":true,"r":{"data":"aGVsbG8=","size":5,"eof":true}}
{"t":"res","id":7,"ok":false,"e":{"code":"not_found","message":"ENOENT: no such file or directory, open '/workspace/a.txt'","path":"/workspace/a.txt"}}
// envd → controller (unsolicited)
{"t":"evt","m":"exec.output","p":{"id":"x1","seq":0,"data":"aGkK"}}
```

- `id` is a positive integer chosen by the controller; responses may arrive out of order.
- Binary data is always base64 (standard alphabet, padded) in a field named `data`.
- Paths in requests must be absolute (the controller resolves relative paths). A relative path is `bad_request`.
- envd handles requests concurrently; ordering between two in-flight requests is not guaranteed.

## Error model

`e.code` is one of:

| code | meaning |
|---|---|
| `not_found`, `permission_denied`, `not_directory`, `is_directory`, `exists`, `invalid` | filesystem errno classes (ENOENT, EACCES/EPERM, ENOTDIR, EISDIR, EEXIST, EINVAL) |
| `too_large` | a size cap from the request was exceeded |
| `bad_request` | malformed params (missing field, relative path, bad base64) |
| `unknown_method` | method not implemented |
| `spawn_error`, `shell_unavailable` | exec could not start |
| `exec_exists`, `exec_not_found` | duplicate or unknown exec id |
| `unknown` | anything else |

For filesystem errors, `e.message` mimics Node.js' formatting so the model-visible text matches Pi's local environment: `<ERRNO>: <description>, <syscall> '<path>'`, e.g.
`ENOENT: no such file or directory, open '/workspace/x'`, `EISDIR: illegal operation on a directory, read`, `EACCES: permission denied, open '/etc/shadow'`, `ENOTDIR: not a directory, scandir '/workspace/a.txt'`, `EEXIST: file already exists, mkdir '/workspace/d'`. Syscall names: `open` (read/write), `lstat` (stat), `scandir` (list), `realpath`, `mkdir`, `rm`, `rename`.

## Methods

### `hello`
`p: {protocol: 1, env?: {NAME: value}}` → `r: {protocol: 1, version, os, arch, pid, uid, gid, cwd, home, tmp, shell, hostname}`
`env` (optional) becomes the connection's default environment: it is added to every `exec` that inherits the environment. It exists for guests whose envd process environment the controller cannot set otherwise (e.g. a Firecracker guest started by the kernel, or `exec` into a container). Entries are validated (no empty names, no `=` or NUL). A later `hello` with `env` replaces it.
`shell` is the absolute path of bash if found (`/bin/bash`, `/usr/bin/bash`, `/usr/local/bin/bash`, `/opt/homebrew/bin/bash` or `bash` on PATH), otherwise `/bin/sh`, otherwise `null`.

### `ping`
`p: {}` → `r: {}`

### `fs.stat`
`p: {path}` → `r: {name, path, kind: "file"|"directory"|"symlink"|"other", size, mtimeMs, mode}` — lstat semantics (symlinks are not followed). `mode` is the permission bits (e.g. 420).

### `fs.read`
`p: {path, offset?: 0, length?: number}` → `r: {data, size, eof}` — follows symlinks. Returns at most `length` bytes (default and maximum 8 MiB per call) starting at `offset`; `size` is the file's total size; `eof` is true when `offset + len(data) >= size`. Reading a directory fails with `is_directory` (`EISDIR: illegal operation on a directory, read`).

### `fs.write`
`p: {path, data, append?: false, mkdirs?: true, mode?: 420}` → `r: {bytes}` — creates parent directories when `mkdirs`; truncates unless `append`. `mode` applies only when the file is created.

### `fs.list`
`p: {path}` → `r: {entries: [stat, …]}` — direct children, lstat each, sorted by name.

### `fs.realpath`
`p: {path}` → `r: {path}`

### `fs.mkdir`
`p: {path, recursive?: true}` → `r: {}`

### `fs.remove`
`p: {path, recursive?: false, force?: false}` → `r: {}` — `force` ignores `not_found`.

### `fs.rename`
`p: {from, to}` → `r: {}`

### `fs.mktemp`
`p: {prefix?: "tmp-", suffix?: "", dir?: false}` → `r: {path}` — created under envd's temp dir (`--tmp`, default `$TMPDIR` or `/tmp`).

### `exec.start`
```jsonc
p: {
  "id": "inv-…",            // controller-chosen, unique for the lifetime of this envd process
  "command": "npm test",     // run as: <shell> -c <command>
  "cwd": "/workspace",       // default: envd cwd
  "env": {"K": "V"},         // merged over the inherited env (or used alone if inheritEnv=false)
  "inheritEnv": true,        // inherit envd's own environment (which the backend constructed; never the host's)
  "timeoutMs": 120000,       // optional; no default timeout
  "maxStreamBytes": 16777216,// cap on output bytes sent as exec.output events (default 16 MiB)
  "spillPath": "/tmp/lily-bash-inv.log" // optional: write the complete output (up to maxSpillBytes) to this file
  "maxSpillBytes": 268435456 // default 256 MiB
}
→ r: {pid}
```
- The command runs in a **new process group** (setpgid) with stdin connected to `/dev/null`.
- stdout and stderr are the **same pipe** (like `2>&1`), so the stream preserves the real interleaving order of writes.
- Output is delivered as `exec.output` events `{id, seq, data}` (seq starts at 0, contiguous). Chunks are at most 64 KiB. After `maxStreamBytes` has been sent, envd keeps draining the pipe (and writing the spill file) but stops emitting output events.
- **Completion**: after the shell process exits, envd keeps reading until pipe EOF or until 100 ms pass without new output, whichever is first, then closes its read end (background jobs that still hold the pipe will get SIGPIPE on their next write, exactly like Pi's local environment). Then it emits exactly one `exec.exit`:

```jsonc
{"id","exitCode": 0|n|null, "signal": "SIGKILL"|null, "timedOut": false, "cancelled": false,
 "durationMs": 1234, "totalBytes": 5000, "streamedBytes": 5000, "truncated": false,
 "spillPath": "/tmp/…"|null, "spillBytes": 5000|null, "spillTruncated": false,
 "error": null | {"code","message"}}
```
  `exitCode` is null only when the process died from a signal; `truncated` means `streamedBytes < totalBytes`.
- **Timeout**: when `timeoutMs` elapses, envd sends SIGKILL to the whole process group and reports `timedOut: true`.
- A failure to spawn returns an error response (no events).

### `exec.cancel`
`p: {id, graceMs?: 2000}` → `r: {signaled: bool}` — SIGTERM to the process group, then SIGKILL after `graceMs` if the leader is still alive. The eventual `exec.exit` has `cancelled: true`. Cancelling an exited or unknown id returns `{signaled: false}`.

### `exec.status`
`p: {id}` → `r: {state: "running"|"exited"|"unknown", exit?: <exec.exit payload>}` — envd remembers the last 256 finished execs.

### Archives (tar + gzip)

Pull-based, chunked, so large workspaces never exceed the frame cap and the controller controls flow.

- `upload.begin` `p: {id, root, maxBytes?: 2 GiB, maxFiles?: 200000}` → `r: {}` — starts receiving a `.tar.gz` that will be extracted under `root` (created if missing).
- `upload.chunk` `p: {id, data}` → `r: {received}` — appends compressed bytes.
- `upload.end` `p: {id}` → `r: {files, bytes}` — extracts. Rejected entries fail the whole upload with `invalid`: absolute names, any `..` component, names that would resolve outside `root` through an existing symlink, device/fifo/socket entries, hardlinks pointing outside the archive. Regular files, directories and symlinks (whose targets are stored verbatim, never followed during extraction) are supported. Permission bits are masked with 0o777; ownership is the envd user; mtimes are preserved.
- `download.begin` `p: {id, root, maxBytes?: 2 GiB}` → `r: {}` — prepares a `.tar.gz` of `root`'s contents (paths relative to root, symlinks stored as symlinks, special files skipped).
- `download.read` `p: {id, length?: 4 MiB}` → `r: {data, eof}` — next chunk; after `eof` the transfer is released.

### `shutdown`
`p: {}` → `r: {}` then kills all running process groups and exits 0.

## Command line

```
lily-envd serve --stdio [--cwd DIR] [--tmp DIR] [--home DIR] [--join-pids-cgroup]
lily-envd serve --vsock-port PORT [--accept-loop] [...]
lily-envd init [--mkdir DIR[:1777]]… [--chown UID:GID] [--pids-max N] [--env-file FILE]
               [--mount-ro DEVICE:DIR]… [--readonly DIR]… [--vm] [--vsock-port PORT] [--cwd DIR] [--home DIR] [--tmp DIR]
lily-envd version
```

`serve`: `--home` sets `HOME` for children when inheriting; `--cwd` is the default exec cwd. `--accept-loop` (with `--vsock-port`) keeps accepting and serves one controller at a time. `--join-pids-cgroup` joins the pids cgroup created by `init --pids-max`, so commands started through a later `exec` into the container count against the limit. `serve` waits briefly for its working directories when started right after `init`.

`init` is the long-running first process of a container or VM environment: it prepares directories (`--mkdir`, owned by `--chown` except sticky tmp dirs and mount points), applies a task limit to everything below it through the cgroup v2 pids controller (`--pids-max`; used where the runtime's own limit is unsuitable, e.g. gVisor, whose host-side limit also counts the sandbox's threads), loads an image's `ENV` (`--env-file`, `KEY=VALUE` lines), and reaps orphans. On Linux it can mount ext4 block devices read-only (`--mount-ro`, e.g. a Firecracker drive holding the resource bundle) and bind-mount directories read-only onto themselves (`--readonly`). With `--vm` it is the kernel's init: it mounts `/proc`, `/sys`, `/dev`, `/dev/pts`, `/dev/shm`, `/run` and cgroup v2, brings up loopback, and sets hostname and defaults before anything else. envd never reads configuration files.
