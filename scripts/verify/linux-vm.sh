#!/usr/bin/env bash
# Host-side driver (macOS + Apple `container`) for the Linux verify VM used to exercise Lily's
# docker / podman / gvisor (and, with a KVM kernel, firecracker) backends.
#
#   scripts/verify/linux-vm.sh start            create + provision the VM (idempotent)
#   scripts/verify/linux-vm.sh sync             copy the repo in (no node_modules/web/dist/web) + npm ci
#   scripts/verify/linux-vm.sh fc-rootfs [img]  build /root/fc/rootfs.ext4 from an image (default python:3.12-slim)
#   scripts/verify/linux-vm.sh test <backend> [vitest args]
#                                               run test/isolation/backend-acceptance.test.ts in the VM
#                                               (docker|gvisor|podman|podman-gvisor|firecracker)
#   scripts/verify/linux-vm.sh shell            interactive shell
#   scripts/verify/linux-vm.sh rm               delete the VM
#
# Environment:
#   VM       VM name (default lily-verify-linux; must start with lily-verify-)
#   CPUS/MEMORY  VM size (default 4 / 8g)
#   KERNEL   custom guest kernel (e.g. one from build-kvm-kernel.sh); adds --virtualization so
#            the VM gets /dev/kvm (Apple M3+ and macOS 15+ only). Also installs Firecracker and
#            its CI guest kernel (/root/fc/vmlinux).
#   JAILER=1 (test firecracker) run the VMs under Firecracker's jailer
#   IMAGE    default docker.m.daocloud.io/library/debian:trixie
set -euo pipefail

vm=${VM:-lily-verify-linux}
image=${IMAGE:-docker.m.daocloud.io/library/debian:trixie}
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
case "$vm" in lily-verify-*) ;; *) echo "VM must be named lily-verify-*" >&2; exit 1 ;; esac

running() { container list --format json 2>/dev/null | grep -q "\"id\":\"$vm\""; }
vexec() { container exec "$vm" "$@"; }

start() {
  if ! container list --all --format json | grep -q "\"id\":\"$vm\""; then
    args=(run -d --name "$vm" --label lily.verify=1 --init --cpus "${CPUS:-4}" --memory "${MEMORY:-8g}"
      # Nested containers need every capability and unmasked /proc, /sys.
      --cap-add ALL --masked-path NONE --read-only-path NONE)
    if [ -n "${KERNEL:-}" ]; then args+=(--kernel "$KERNEL" --virtualization); fi
    container "${args[@]}" "$image" sleep infinity >/dev/null
  elif ! running; then
    container start "$vm" >/dev/null
  fi
  setup_arg=""
  if [ -n "${KERNEL:-}" ]; then setup_arg=--firecracker; fi
  container exec -i "$vm" sh -s -- $setup_arg < "$here/vm-setup.sh"
  container exec -i "$vm" sh -s < "$here/vm-services.sh"
  vexec sh -c 'uname -a; ls -l /dev/kvm 2>/dev/null || echo "no /dev/kvm"'
}

sync_repo() {
  # Host node_modules contain darwin-only native bindings: copy sources only and npm ci inside.
  COPYFILE_DISABLE=1 tar -C "$repo" --no-mac-metadata --exclude ./node_modules --exclude ./web --exclude ./dist/web --exclude ./.git \
    --no-xattrs -cf - . | container exec -i "$vm" sh -c 'mkdir -p /root/lily && tar -xf - -C /root/lily 2>/dev/null'
  vexec sh -c 'cd /root/lily && { [ -d node_modules ] && cmp -s package-lock.json node_modules/.package-lock.json.src; } \
    || { npm ci --no-audit --no-fund --loglevel=error && cp package-lock.json node_modules/.package-lock.json.src; }'
}

run_test() {
  backend=${1:?backend}
  shift
  extra=""
  if [ "$backend" = firecracker ]; then
    extra="LILY_FC_KERNEL=/root/fc/vmlinux LILY_FC_ROOTFS=/root/fc/rootfs.ext4 ${JAILER:+LILY_FC_JAILER=/usr/local/bin/jailer}"
  fi
  vexec sh -c "cd /root/lily && LILY_TEST_BACKEND=$backend $extra ${LILY_TEST_ENV:-} npx vitest --run test/isolation/backend-acceptance.test.ts $*"
}

fc_rootfs() {
  vexec sh -c "cd /root/lily && scripts/firecracker/build-rootfs.sh ${1:-python:3.12-slim} /root/fc/rootfs.ext4 ${FC_ROOTFS_MB:-2048}"
}

cmd=${1:-}
shift || true
case "$cmd" in
  start) start ;;
  sync) sync_repo ;;
  fc-rootfs) fc_rootfs "$@" ;;
  test) run_test "$@" ;;
  shell) container exec -it "$vm" bash ;;
  rm) container delete --force "$vm" ;;
  *) sed -n '2,24p' "$0"; exit 2 ;;
esac
