# Execution environments

Every tool call the agent makes (`read`, `write`, `edit`, `bash`) runs in the session's **environment** through Lily's guest agent `lily-envd`, a small static binary speaking a JSON-lines protocol ([envd-protocol.md](envd-protocol.md)). The Lily process itself (model calls, credentials, recording) never runs agent commands. What an environment can see and do depends on its **backend**.

All backends provide the following:

- **A clean environment.** The host's environment variables, API keys included, are never passed in. Commands get `HOME`, `PATH`, `TMPDIR` and the spec's own variables.
- **A workspace built from the session's initial state.** It is a host directory that is either `mount`ed live or copied in as a `directory`, an `archive`, `empty`, or `image`: whatever the container image or root filesystem ships at `/workspace` (container and VM backends). Every state except `image` and `mount` starts from exactly its own content; anything an image has at `/workspace` is removed first. Interactive sessions mount the project directory where the backend can. Batch-mode sessions and `lily --copy` always copy, so the host is never written.
- **The resource bundle, read-only.** The bound bundle is mounted at the environment's resources path.
- **Limits** (`cpus`, `memoryMb`, `pids`) where the backend supports them, and **no network** unless `network: "egress"` is set.
- **Process-tree control.** Timeouts and cancellation kill the whole process group, and orphaned processes are reaped.
- **Measurements.** Each environment records how long it took to provision (`startupMs`); the container and VM backends also report the CPU time and peak memory it used (`lease.usage()`, per run in `RunOutcome.environmentUsage`) — from the host where they can (Firecracker's VMM process, the container's cgroup for docker, podman and gVisor), from the guest's own cgroup otherwise (Apple containers).
- **Capacity.** A Lily process holds at most `environment.maxConcurrent` environments (default 16). Further requests wait for a slot, or under `lily serve` fail with `capacity_exhausted` so that a scheduler sees the limit ([api.md](api.md)).
- **Leases.** An environment that dies is noticed within about 0.1 s. A run whose tool call was in flight then ends `blocked`, never re-executing it. Environments left behind by a crashed Lily process are swept at the next start, and only environments recorded in the same `LILY_HOME` are touched.

## Backends

| backend | isolation | how | guest paths |
|---|---|---|---|
| `local` | none | a host process in a per-environment directory | host paths |
| `seatbelt` | process sandbox | macOS `sandbox-exec` with a deny-by-default profile. It can read system directories and its own environment, write only the workspace, home and tmp, and has no network | host paths |
| `docker` | container | one container per environment (runc) | `/workspace`, `/opt/lily/resources`, `/home/agent`, `/tmp` |
| `podman` | container | the same with Podman (crun) | same |
| `gvisor` | user-space kernel | docker or podman with gVisor's `runsc` runtime | same |
| `apple-container` | VM | Apple `container`: one lightweight Linux VM (own kernel) per environment | same |
| `firecracker` | microVM | one Firecracker microVM per environment. envd is the guest's init, the controller connects over vsock, the root filesystem is a writable overlay on a shared read-only image, and the bundle is a read-only ext4 drive | same |

The container and VM backends give every agent an identical view of the filesystem (`/workspace`, `/opt/lily/resources`, …), which matters when runs are compared or when several agents run the same task. The `local` and `seatbelt` backends expose real host paths.

## Choosing a backend

```bash
lily env backends                          # what this machine can run, and why not
lily --backend apple-container             # one session
lily config environment '{"backend":"apple-container","image":"docker.m.daocloud.io/library/python:3.12-slim","limits":{"cpus":2,"memoryMb":2048}}'
```

The default is `seatbelt` on macOS and `local` on Linux. Container and VM backends run any Linux image, because Lily injects `lily-envd` itself. Choose an image with the toolchain your projects need.

- **apple-container.** Install Apple's `container` (e.g. `brew install container`) and run `container system start`.
- **docker / podman.** Needs a Linux host with cgroup v2 (cpu, memory and pids controllers). Run rootful, or rootless with systemd cgroup delegation. Lily refuses to start when a rootless engine would silently ignore the limits.
- **gvisor.** Register `runsc` as a runtime, either in docker's `daemon.json` under `"runtimes"` or in podman's `containers.conf` under `[engine.runtimes]`. gVisor's default `systrap` platform needs no KVM.
- **firecracker.** Needs Linux with read/write access to `/dev/kvm` and Firecracker v1.x. You also need a guest kernel with virtio-mmio block, vsock and overlayfs, and root filesystems built from any image with `scripts/firecracker/build-rootfs.sh`. Enable it with `environment.firecracker = {kernel, rootfs, …}` (options: `images`, `rootfsMode`, `diskMb`, `firecracker`, `jailer`, `uid`, `gid`, `vcpus`, `memoryMb`, `vsockPort`, `mkfs`, `bootTimeoutMs`, `cacheDir`, `resourceCacheMb`; see below). The jailer mode requires running Lily as root. See [scripts/firecracker/README.md](../scripts/firecracker/README.md).

## Firecracker root filesystems

Every environment boots from an ext4 root filesystem: the spec's `rootfs` (a host path), else the one `firecracker.images` maps its `image` name to, else `firecracker.rootfs`. The environment's info (and so every run manifest) records the image's path, size and sha256 digest; the digest is computed once per image version and cached in `~/.lily/cache/firecracker`.

How a VM gets a writable root is `firecracker.rootfsMode`:

| mode | how | creation cost |
|---|---|---|
| `overlay` (default) | the image is attached read-only and shared by every VM; writes go to the VM's own sparse ext4 disk of `limits.diskMb` (default `firecracker.diskMb`, 4096 MiB), which envd stacks on top with overlayfs before anything else runs | independent of the image size; the image is never modified |
| `reflink` | a reflink copy of the image per VM | constant, but only where the image and the Lily home share a filesystem with reflinks (XFS, btrfs); fails with an explicit error elsewhere |
| `copy` | a reflink copy where possible, a full sparse copy otherwise (Lily 0.1's behaviour) | grows with the image's data |

In overlay mode `limits.diskMb` is the space the environment can write, and filling it fails inside the guest instead of growing a file on the host. The resource bundle of a run is packed into a read-only ext4 drive once per bundle digest and shared by every VM that mounts it (`cacheDir`, default `~/.lily/cache/firecracker`; `resourceCacheMb`, default 1024, bounds the cache, least recently used first out). Under the jailer, shared files (the image, cached drives, the kernel) are hard-linked into each chroot, so they must be on the same filesystem as the Lily home and readable by the jailer's uid.

## Platform compatibility

"VM isolation on" means each environment gets its own kernel (a VM or microVM). "Off" means process- or container-level isolation, or none. ✅ means verified end to end with the backend acceptance suite. ☑️ means supported by design but not run on that exact platform. ✗ means not available.

| host | VM isolation on | VM isolation off |
|---|---|---|
| **macOS 26+, Apple silicon** | ✅ `apple-container` (verified: M4, macOS 26.7, container 1.4.1) | ✅ `seatbelt` (default) · ✅ `local` · ☑️ `docker`/`podman` through Docker Desktop, Podman machine or colima |
| **macOS 15, Apple silicon** | ☑️ `apple-container`, which Apple supports on macOS 15 with networking limitations | ☑️ `seatbelt` · ✅ `local` · ☑️ `docker`/`podman` |
| **macOS, Intel** | ✗ (Apple `container` needs Apple silicon) | ☑️ `seatbelt` · ☑️ `local` · ☑️ `docker`/`podman` |
| **Linux arm64 with KVM** | ✅ `firecracker` (verified: Firecracker v1.17.0, with and without the jailer) | ✅ `docker` · ✅ `podman` · ✅ `gvisor` (docker + runsc, podman + runsc) · ✅ `local` |
| **Linux x86-64 with KVM** | ☑️ `firecracker` | ☑️ `docker` · ☑️ `podman` · ☑️ `gvisor` · ☑️ `local` |
| **Linux without KVM** (most containers, cloud VMs without nested virtualization) | ✗ | ✅/☑️ `gvisor` (systrap) · `docker` · `podman` · `local` |
| **Windows** | ✗ natively. Under WSL2 Lily behaves as on Linux, and Firecracker additionally needs nested virtualization enabled for WSL (untested) | ✗ natively · ☑️ under WSL2 as on Linux |

Lily itself (the TUI, CLI and SDK) runs wherever Node ≥ 22.19 runs on macOS or Linux. `lily-envd` ships prebuilt for macOS and Linux on arm64 and x86-64.

**How the Linux rows were verified.** The Linux arm64 results come from Linux VMs on the development Mac (Apple `container` VMs, Debian trixie, kernel 6.18). Docker CE 29.8, Podman 5.4 and gVisor ran inside such a VM. Firecracker ran with **nested virtualization**: a VM booted with a KVM-enabled build of the same kernel (`container run --kernel … --virtualization`, which needs an M3 or newer and macOS 15+) exposes `/dev/kvm`, and Firecracker microVMs run inside it. The scripts are in [scripts/verify/](../scripts/verify/README.md). x86-64 hosts were not available for testing.

## Measured on the development machine

These numbers come from Apple M4 hardware, with the Linux backends running inside a VM (Firecracker nested). They show relative cost, not a benchmark.

| backend | provision an environment | exec round trip (median) |
|---|---|---|
| apple-container | 0.7–0.8 s (creation is serialized: a second concurrent one ≈ 1.5 s) | 0.5–1.2 ms |
| docker | 0.10–0.16 s | 0.6 ms |
| gvisor | 0.10–0.13 s | 1.8 ms |
| podman | 0.22–0.35 s | 0.5 ms |
| podman + gVisor | 0.25–0.30 s | 1.6 ms |
| firecracker (nested) | 1.2–2.0 s one at a time (boot ≈ 1.2–1.9 s); 2.3 s for two and 5.2 s for four booting at once (1 GiB guests) | 1.9–2.2 ms |

Firecracker's creation time in overlay mode does not depend on the image: 1.4 s for the 2 GiB test image and for a 4 GiB image holding 1.6 GiB of data, where `copy` mode took 3.1–4.2 s (the Linux VM's disk is ext4, without reflinks). Hashing a new image took about 0.6 s per GiB of image size.

## Known limits

- `limits.diskMb` is only enforced by Firecracker in overlay mode.
- **gVisor.** Exceeding the memory limit kills the whole sandbox, so the environment is lost and the run ends `blocked`. The in-sandbox pids count can overshoot by about 10.
- **Firecracker.**
  - Egress networking is not supported.
  - The guest runs the `lily-envd` baked into its root filesystem, so rebuild the rootfs after upgrading Lily (overlay mode needs the envd of Lily 0.2 or later).
  - The first VM from a new image waits for the image's digest to be computed (a second or two per few GiB), once per image version.
  - Under nested virtualization, guests with 2 GiB of memory stall during early boot, badly when several boot at once (two at once: 22 s instead of 2.3 s with 1 GiB). With 1 GiB no stalls were seen.
- **Docker/Podman on SELinux-enforcing hosts.** Bind mounts are not relabeled (untested).
- **Rootful docker with a mounted workspace.** Files the agent creates end up owned by root on the host.
- **apple-container.** Apple adds one vCPU to each VM, so `cpus: 2` shows 3 inside.
- **Seatbelt** shows real host paths and relies on macOS's `sandbox-exec`, which Apple marks as deprecated but still ships.
