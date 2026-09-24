#!/usr/bin/env bash
# Builds an arm64 guest kernel for Apple `container` with KVM enabled, so that a container
# started with `--virtualization` (nested virtualization, Apple M3+ / macOS 15+) gets /dev/kvm.
#
# Runs on the macOS host. The build happens inside a throwaway Apple container VM
# (lily-verify-kbuild); the result is an uncompressed arm64 `Image` — the same format as the
# default kernel in ~/Library/Application Support/com.apple.container/kernels/.
#
#   scripts/verify/build-kvm-kernel.sh [out-dir]      (default: /tmp/lily-verify)
#
# Environment:
#   KERNEL_VERSION   default: the running default kernel's version (read from a probe container)
#   KERNEL_MIRROR    default: https://mirrors.tuna.tsinghua.edu.cn/kernel
#   DEBIAN_MIRROR    default: mirrors.tuna.tsinghua.edu.cn
#   IMAGE            default: docker.m.daocloud.io/library/debian:trixie
#   CPUS / MEMORY    build VM size (default 8 / 8g)
set -euo pipefail

out=${1:-/tmp/lily-verify}
image=${IMAGE:-docker.m.daocloud.io/library/debian:trixie}
kernel_mirror=${KERNEL_MIRROR:-https://mirrors.tuna.tsinghua.edu.cn/kernel}
debian_mirror=${DEBIAN_MIRROR:-mirrors.tuna.tsinghua.edu.cn}
mkdir -p "$out"

# The default kernel's own configuration is the starting point (Kata's 6.x config: no modules,
# CONFIG_VIRTUALIZATION unset).
if [ ! -s "$out/default-kernel.config" ]; then
  container run --rm --name lily-verify-kconfig "$image" sh -c 'zcat /proc/config.gz' > "$out/default-kernel.config"
fi
version=${KERNEL_VERSION:-$(sed -n 's/^# Linux\/arm64 \([0-9.]*\) Kernel Configuration$/\1/p' "$out/default-kernel.config")}
[ -n "$version" ] || { echo "cannot determine kernel version" >&2; exit 1; }
major=${version%%.*}
echo "building linux $version (arm64 Image, KVM enabled) into $out"

cat > "$out/kbuild.sh" <<EOF
#!/bin/sh
set -eu
sed -i 's|deb.debian.org|$debian_mirror|g' /etc/apt/sources.list.d/debian.sources
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  build-essential bc bison flex libssl-dev libelf-dev xz-utils curl ca-certificates cpio kmod python3 >/dev/null
# The source tarball is cached in the output directory; the build tree lives on the VM's own disk.
[ -s /out/linux-$version.tar.xz ] || curl -fsSL -o /out/linux-$version.tar.xz.part $kernel_mirror/v$major.x/linux-$version.tar.xz
[ -s /out/linux-$version.tar.xz ] || mv /out/linux-$version.tar.xz.part /out/linux-$version.tar.xz
mkdir -p /build && cd /build
tar -xf /out/linux-$version.tar.xz
cd linux-$version
cp /out/default-kernel.config .config
./scripts/config --file .config -e VIRTUALIZATION -e KVM --set-str LOCALVERSION -kvm
make ARCH=arm64 olddefconfig >/dev/null
grep -E '^CONFIG_(VIRTUALIZATION|KVM)=' .config
grep -q '^CONFIG_KVM=y' .config || { echo 'CONFIG_KVM did not stick' >&2; exit 1; }
start=\$(date +%s)
make ARCH=arm64 -j\$(nproc) Image >/out/kbuild.log 2>&1 || { tail -50 /out/kbuild.log; exit 1; }
echo "kernel build took \$((\$(date +%s) - start))s"
cp arch/arm64/boot/Image /out/vmlinux-$version-kvm
cp .config /out/vmlinux-$version-kvm.config
echo "built /out/vmlinux-$version-kvm"
EOF
chmod +x "$out/kbuild.sh"

container delete --force lily-verify-kbuild >/dev/null 2>&1 || true
container run --rm --name lily-verify-kbuild --cpus "${CPUS:-8}" --memory "${MEMORY:-8g}" \
  --volume "$out:/out" "$image" /out/kbuild.sh
file "$out/vmlinux-$version-kvm"
