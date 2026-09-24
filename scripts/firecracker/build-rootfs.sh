#!/usr/bin/env bash
# Builds a Firecracker root filesystem for Lily's experimental firecracker backend.
# Run as root on a Linux host with docker (or podman: CONTAINER_CLI=podman) and
# e2fsprogs >= 1.43 (mkfs.ext4 -d).
#
#   scripts/firecracker/build-rootfs.sh python:3.12-slim ~/.lily/firecracker/rootfs.ext4 4096
#
# The image's filesystem is exported, lily-envd is installed at /opt/lily/bin/lily-envd
# (the kernel runs it as init), the image's ENV is saved to /opt/lily/image.env (init loads
# it), and the result is packed into a sparse ext4 image of the given size. The size is the
# environment's disk: the workspace lives on this filesystem.
#
# Rebuild the image whenever lily-envd changes: the guest runs the envd baked in here.
set -euo pipefail

image=${1:?usage: build-rootfs.sh <image> <out.ext4> [size-MiB]}
out=${2:?usage: build-rootfs.sh <image> <out.ext4> [size-MiB]}
size=${3:-4096}
cli=${CONTAINER_CLI:-docker}

if [ "$(id -u)" != 0 ]; then
  # Without root, tar cannot restore file ownership (setuid binaries, root-owned trees break).
  echo "build-rootfs.sh must run as root" >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64) goarch=amd64 ;;
  aarch64 | arm64) goarch=arm64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
root="$(cd "$(dirname "$0")/../.." && pwd)"
envd="$root/dist/envd/linux-$goarch/lily-envd"
[ -x "$envd" ] || { echo "missing $envd; run: npm run build:envd" >&2; exit 1; }

work=$(mktemp -d)
cid=""
cleanup() {
  [ -n "$cid" ] && "$cli" rm -f "$cid" >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT
mkdir "$work/rootfs"
# The image must match the host (and so the VM) architecture.
cid=$("$cli" create --platform "linux/$goarch" "$image" /bin/true)
"$cli" export "$cid" | tar -x -C "$work/rootfs"
"$cli" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$cid" > "$work/image.env"

install -D -m 0755 "$envd" "$work/rootfs/opt/lily/bin/lily-envd"
install -m 0644 "$work/image.env" "$work/rootfs/opt/lily/image.env"
mkdir -p "$work/rootfs"/{workspace,home/agent,opt/lily/resources,proc,sys,dev,run,tmp}
chmod 1777 "$work/rootfs/tmp"
# A container image's resolv.conf/hosts/hostname are bind-mount artefacts; give the VM static ones.
printf '127.0.0.1 localhost lily\n::1 localhost ip6-localhost ip6-loopback\n' > "$work/rootfs/etc/hosts"
printf 'lily\n' > "$work/rootfs/etc/hostname"
: > "$work/rootfs/etc/resolv.conf"

mkdir -p "$(dirname "$out")"
rm -f "$out"
truncate -s "${size}M" "$out"
mkfs.ext4 -q -F -L lily-root -d "$work/rootfs" "$out"
echo "rootfs: $out ($(du -h "$out" | cut -f1) used of ${size} MiB; envd $("$envd" version))"
