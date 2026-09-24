# Firecracker backend

Lily's `firecracker` backend runs every environment in its own Firecracker microVM: a dedicated
guest kernel, no network device (loopback only), a private copy-on-write copy of the root
filesystem, and `lily-envd` as PID 1. Init mounts the pseudo filesystems, brings up `lo`, applies
the pids limit (cgroup v2), mounts the resource bundle from a read-only drive, and starts a
vsock server child that the controller reaches through Firecracker's vsock-over-UDS bridge.

Verified with Firecracker v1.17.0 (aarch64) and Firecracker's CI guest kernel 6.1.155, including
the jailer, inside an Apple `container` VM with nested virtualization (see `scripts/verify/`):
`LILY_TEST_BACKEND=firecracker npx vitest --run test/isolation/backend-acceptance.test.ts`.

1. Install Firecracker (and the jailer) from
   https://github.com/firecracker-microvm/firecracker/releases and make sure `/dev/kvm` is
   accessible to the user running Lily. `mkfs.ext4` (e2fsprogs ≥ 1.43) must be on `PATH`: resource
   bundles are packed into small read-only ext4 drives.
2. Get an uncompressed guest kernel built for Firecracker (`vmlinux` on x86_64, `Image` on aarch64),
   e.g. the CI kernels referenced in Firecracker's getting-started guide
   (`https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.15/$(uname -m)/vmlinux-6.1.155`). It needs
   virtio-mmio block + vsock, ext4, devtmpfs and cgroup v2 (pids).
3. Build a root filesystem from an OCI image, as root:
   `sudo scripts/firecracker/build-rootfs.sh python:3.12-slim ~/.lily/firecracker/rootfs.ext4 4096`
   The size is the environment's disk (the workspace lives on it). The image's `ENV` is kept in
   `/opt/lily/image.env`. Rebuild the rootfs whenever lily-envd changes.
4. Enable the backend in `~/.lily/config.json`:

   ```json
   {
     "environment": {
       "backend": "firecracker",
       "firecracker": {
         "kernel": "/home/me/.lily/firecracker/vmlinux",
         "rootfs": "/home/me/.lily/firecracker/rootfs.ext4",
         "vcpus": 2,
         "memoryMb": 2048
       }
     }
   }
   ```

   Optional: `"jailer": "/usr/local/bin/jailer", "uid": 1000, "gid": 1000` (Lily must then run as
   root; each VM gets a chroot under its state directory), `"mkfs"`, `"vsockPort"`, `"bootTimeoutMs"`.

5. `lily env backends` should list `firecracker` as available.

Notes and limits:
- Workspaces are copied in (no host mounts) and `limits.network = "egress"` is rejected (no NIC).
- `limits.cpus` is rounded up to whole vCPUs, `limits.memoryMb` is the VM's RAM, `limits.pids` is a
  cgroup limit inside the guest. `limits.diskMb` is not applied (the rootfs image size is the disk).
- The agent is root inside its VM: `/opt/lily/bin` is a read-only bind mount (root could remount it,
  but envd is never re-executed), the resource drive is read-only at the VMM level.
- The rootfs copy uses `cp --reflink=auto --sparse=always`: instant on btrfs/xfs, a sparse copy
  (~50 ms for a 200 MB python image) elsewhere.
- Controllers that crash leave their firecracker processes running; `lily env sweep` (and every
  runtime start) kills the VMs of this home's dead environments.
