#!/bin/sh
# Runs INSIDE the Linux verify VM (Debian trixie, root). Idempotent.
# Installs Docker CE, Podman, gVisor (runsc, registered as a Docker and Podman runtime), Node 22
# and, with --firecracker, Firecracker + jailer. Mirrors default to ones reachable from China.
#
#   vm-setup.sh [--firecracker]
set -eu

DEBIAN_MIRROR=${DEBIAN_MIRROR:-mirrors.tuna.tsinghua.edu.cn}
DOCKER_MIRROR=${DOCKER_MIRROR:-https://mirrors.tuna.tsinghua.edu.cn/docker-ce}
REGISTRY_MIRROR=${REGISTRY_MIRROR:-docker.m.daocloud.io}
NODE_VERSION=${NODE_VERSION:-v22.23.2}
NODE_MIRROR=${NODE_MIRROR:-https://registry.npmmirror.com/-/binary/node}
GVISOR_URL=${GVISOR_URL:-https://storage.googleapis.com/gvisor/releases/release/latest/$(uname -m)}
FIRECRACKER_VERSION=${FIRECRACKER_VERSION:-v1.17.0}
# github.com is often unreachable from China; a ghproxy-style prefix works ("" to disable).
GITHUB_PROXY=${GITHUB_PROXY-https://ghproxy.net/}
FC_KERNEL_URL=${FC_KERNEL_URL:-https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.15/$(uname -m)/vmlinux-6.1.155}
firecracker=0
[ "${1:-}" = "--firecracker" ] && firecracker=1

export DEBIAN_FRONTEND=noninteractive
if ! grep -q "$DEBIAN_MIRROR" /etc/apt/sources.list.d/debian.sources; then
  sed -i "s|deb.debian.org|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources
fi
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg xz-utils zstd git procps iproute2 \
  psmisc e2fsprogs rsync python3 sudo iptables uidmap slirp4netns passt fuse-overlayfs crun podman >/dev/null

# Docker CE (current upstream release) instead of Debian's older docker.io.
if ! command -v dockerd >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "$DOCKER_MIRROR/linux/debian/gpg" -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] $DOCKER_MIRROR/linux/debian trixie stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io >/dev/null
fi

# gVisor
if ! command -v runsc >/dev/null; then
  tmp=$(mktemp -d)
  (cd "$tmp" && curl -fsSLO "$GVISOR_URL/gvisor.tar.zstd" && curl -fsSLO "$GVISOR_URL/gvisor.tar.zstd.sha512" \
    && sha512sum -c gvisor.tar.zstd.sha512 && tar --zstd -xf gvisor.tar.zstd -C /usr/local/bin)
  rm -rf "$tmp"
fi

mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<EOF
{
  "registry-mirrors": ["https://$REGISTRY_MIRROR"],
  "runtimes": { "runsc": { "path": "/usr/local/bin/runsc" } }
}
EOF

# Podman: resolve docker.io through the mirror; runsc as an extra OCI runtime.
mkdir -p /etc/containers/registries.conf.d /etc/containers/containers.conf.d
cat > /etc/containers/registries.conf.d/50-lily-mirror.conf <<EOF
unqualified-search-registries = ["docker.io"]
[[registry]]
prefix = "docker.io"
location = "docker.io"
[[registry.mirror]]
location = "$REGISTRY_MIRROR"
EOF
cat > /etc/containers/containers.conf.d/50-lily-runsc.conf <<EOF
[engine.runtimes]
runsc = ["/usr/local/bin/runsc"]
EOF

# Node.js
if ! node --version 2>/dev/null | grep -q "^${NODE_VERSION}$"; then
  arch=$(uname -m | sed 's/aarch64/arm64/; s/x86_64/x64/')
  curl -fsSL "$NODE_MIRROR/$NODE_VERSION/node-$NODE_VERSION-linux-$arch.tar.xz" | tar -xJ -C /usr/local --strip-components=1
fi
npm config set registry https://registry.npmmirror.com >/dev/null

if [ "$firecracker" = 1 ] && ! command -v firecracker >/dev/null; then
  arch=$(uname -m)
  url=${GITHUB_PROXY}https://github.com/firecracker-microvm/firecracker/releases/download/$FIRECRACKER_VERSION/firecracker-$FIRECRACKER_VERSION-$arch.tgz
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/fc.tgz" "$url"
  curl -fsSL --retry 3 -o "$tmp/fc.tgz.sha256.txt" "$url.sha256.txt"
  (cd "$tmp" && sed "s| .*| fc.tgz|" fc.tgz.sha256.txt | sha256sum -c -)
  tar -xzf "$tmp/fc.tgz" -C "$tmp"
  install -m 0755 "$tmp/release-$FIRECRACKER_VERSION-$arch/firecracker-$FIRECRACKER_VERSION-$arch" /usr/local/bin/firecracker
  install -m 0755 "$tmp/release-$FIRECRACKER_VERSION-$arch/jailer-$FIRECRACKER_VERSION-$arch" /usr/local/bin/jailer
  rm -rf "$tmp"
fi
# Guest kernel for Firecracker: Firecracker's own CI build.
if [ "$firecracker" = 1 ] && [ ! -s /root/fc/vmlinux ]; then
  mkdir -p /root/fc
  curl -fsSL --retry 3 -o /root/fc/vmlinux.part "$FC_KERNEL_URL" && mv /root/fc/vmlinux.part /root/fc/vmlinux
fi

echo "docker:  $(docker --version)"
echo "podman:  $(podman --version)"
echo "runsc:   $(runsc --version | head -1)"
echo "node:    $(node --version)"
command -v firecracker >/dev/null && echo "firecracker: $(firecracker --version | head -1)"
exit 0
