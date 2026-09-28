# Firecracker backend

Lily's `firecracker` backend runs every environment in its own Firecracker microVM: a dedicated
guest kernel, no network device (loopback only), its own writable root filesystem — by default an
overlay of a private scratch disk on a read-only image shared by all VMs — and `lily-envd` as
PID 1. Init mounts the pseudo filesystems, brings up `lo`, stacks the overlay and pivots into it,
applies the pids limit (cgroup v2), mounts the resource bundle from a read-only drive, and starts
a vsock server child that the controller reaches through Firecracker's vsock-over-UDS bridge.

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
   virtio-mmio block + vsock, ext4, overlayfs, devtmpfs and cgroup v2 (pids).
3. Build a root filesystem from an OCI image, as root:
   `sudo scripts/firecracker/build-rootfs.sh python:3.12-slim ~/.lily/firecracker/rootfs.ext4 4096`
   The image's `ENV` is kept in `/opt/lily/image.env`. Rebuild the rootfs whenever lily-envd changes.
   Build one rootfs per task image you need; with `rootfsMode: "copy"` or `"reflink"` its size is the
   environment's disk, in the default overlay mode the environment writes to a separate disk of
   `limits.diskMb` (default `diskMb`, 4096 MiB) and the image is never modified.
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

   Optional:
   - `"images": {"py311": "/data/rootfs/py311.ext4", …}`: a spec's `image` picks a root filesystem
     (a spec can also name one directly with `rootfs`); manifests record the path and sha256 digest.
   - `"rootfsMode"`: `"overlay"` (default; creation time independent of the image size),
     `"reflink"` (a reflink copy per VM; fails unless the image and the Lily home share an XFS or
     btrfs filesystem) or `"copy"` (reflink where possible, else a full sparse copy); `"diskMb"`.
   - `"jailer": "/usr/local/bin/jailer", "uid": 1000, "gid": 1000` (Lily must then run as root; each
     VM gets a chroot under its state directory). Shared files — images, cached resource drives, the
     kernel — are hard-linked into the chroot: keep them on the Lily home's filesystem and readable
     by that uid (e.g. mode 644).
   - `"cacheDir"`, `"resourceCacheMb"`: resource drives are packed once per bundle digest and shared
     (default `~/.lily/cache/firecracker`, 1024 MiB); `"mkfs"`, `"vsockPort"`, `"bootTimeoutMs"`.

5. `lily env backends` should list `firecracker` as available.

Notes and limits:
- Workspaces are copied in (no host mounts) and `limits.network = "egress"` is rejected (no NIC).
- `limits.cpus` is rounded up to whole vCPUs, `limits.memoryMb` is the VM's RAM, `limits.pids` is a
  cgroup limit inside the guest. `limits.diskMb` is the overlay disk's size (in copy and reflink
  modes the image size is the disk).
- The agent is root inside its VM: `/opt/lily/bin` is a read-only bind mount (root could remount it,
  but envd is never re-executed), the resource drive is read-only at the VMM level.
- In copy mode the rootfs copy uses `cp --reflink=auto --sparse=always`: instant on btrfs/xfs, a
  sparse copy elsewhere, whose time grows with the image's data (≈ 3 s for 1.6 GiB).
- Controllers that crash leave their firecracker processes running; `lily env sweep` (and every
  runtime start) kills the VMs of this home's dead environments.
