# Backend verification setup (macOS host, Apple `container`)

Scripts used to run Lily's backend acceptance suite (`test/isolation/backend-acceptance.test.ts`)
for real on an Apple-silicon Mac: `apple-container` runs on the host; docker, podman and gVisor
run inside a long-lived Linux VM; Firecracker runs inside a second Linux VM that has `/dev/kvm`
through nested virtualization. All VMs are Apple `container` VMs named `lily-verify-*`.

| script | where | what |
| --- | --- | --- |
| `linux-vm.sh` | host | create/provision a verify VM, copy the repo in, run the suite there |
| `vm-setup.sh` | VM | installs Docker CE, Podman, gVisor (`runsc`, registered with both), Node 22, and with `--firecracker` Firecracker + jailer + Firecracker's CI guest kernel |
| `vm-services.sh` | VM | cgroup v2 delegation + starts containerd/dockerd (the VM has no systemd) |
| `build-kvm-kernel.sh` | host | builds a KVM-enabled arm64 guest kernel for Apple `container` |

Mirrors default to ones reachable from mainland China (TUNA for Debian/Docker CE, DaoCloud for
Docker Hub images, npmmirror for Node/npm, `ghproxy.net` for GitHub release downloads); override
with the variables at the top of `vm-setup.sh`.

## docker / podman / gVisor

```sh
scripts/verify/linux-vm.sh start        # lily-verify-linux: Debian trixie, 4 vCPU, 8 GiB
scripts/verify/linux-vm.sh sync         # repo without node_modules/web/dist/web, then npm ci
npm run build:envd && scripts/verify/linux-vm.sh sync   # after envd changes
for b in docker gvisor podman podman-gvisor; do scripts/verify/linux-vm.sh test $b; done
```

The VM needs `--cap-add ALL --masked-path NONE --read-only-path NONE` (nested runtimes need every
capability and writable `/proc/sys`, `/sys`); `--init` reaps the VM's own zombies. Apple's guest
kernel (Kata 6.18 config) already has everything Docker/Podman/gVisor need (cgroup v2 with
cpu/memory/pids, overlayfs, netfilter/nftables, bridge/veth, seccomp, user namespaces).
`vm-services.sh` moves all processes into a leaf cgroup and enables the controllers in the root's
`subtree_control`, then starts `containerd` and `dockerd` by hand.

## Firecracker (nested virtualization)

Requires Apple M3 or later and macOS 15 or later. The default Apple `container` kernel is built
without `CONFIG_VIRTUALIZATION`, so first build one with KVM (≈4 min on an M4, 8 vCPUs):

```sh
scripts/verify/build-kvm-kernel.sh /tmp/lily-verify         # -> /tmp/lily-verify/vmlinux-<ver>-kvm
VM=lily-verify-kvm KERNEL=/tmp/lily-verify/vmlinux-6.18.35-kvm scripts/verify/linux-vm.sh start
VM=lily-verify-kvm scripts/verify/linux-vm.sh sync
VM=lily-verify-kvm scripts/verify/linux-vm.sh fc-rootfs              # /root/fc/rootfs.ext4 from python:3.12-slim
VM=lily-verify-kvm scripts/verify/linux-vm.sh test firecracker
VM=lily-verify-kvm JAILER=1 scripts/verify/linux-vm.sh test firecracker   # under the jailer
```

`build-kvm-kernel.sh` starts from the running default kernel's own `/proc/config.gz`, sets
`CONFIG_VIRTUALIZATION=y CONFIG_KVM=y`, and builds `arch/arm64/boot/Image` (an uncompressed arm64
Image — the format of the default kernel). `KERNEL=…` makes `linux-vm.sh` pass
`--kernel <path> --virtualization`; the VM then has `/dev/kvm`. Rebuild the rootfs after every envd
change (the guest runs the envd baked into it).

## apple-container (host)

```sh
LILY_TEST_BACKEND=apple-container npx vitest --run test/isolation/backend-acceptance.test.ts
```

## Clean up

```sh
scripts/verify/linux-vm.sh rm; VM=lily-verify-kvm scripts/verify/linux-vm.sh rm
container list --all        # nothing named lily-* should remain
```
