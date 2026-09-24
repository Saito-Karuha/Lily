#!/bin/sh
# Runs INSIDE the Linux verify VM: prepares cgroup v2 delegation and starts containerd + dockerd
# (there is no systemd in the VM). Safe to run repeatedly.
set -eu

# Apple's vminitd puts the container at the VM's cgroup root. Move every process into a leaf so
# the root can delegate controllers to Docker/Podman (cgroup v2 "no internal processes" rule).
cg=/sys/fs/cgroup
if [ ! -d $cg/init ]; then mkdir $cg/init; fi
for pid in $(cat $cg/cgroup.procs); do echo "$pid" > $cg/init/cgroup.procs 2>/dev/null || true; done
for c in $(cat $cg/cgroup.controllers); do echo "+$c" > $cg/cgroup.subtree_control 2>/dev/null || true; done

# The VM's /proc/sys is writable only with --masked-path NONE --read-only-path NONE.
sysctl -qw net.ipv4.ip_forward=1 || true

if ! pgrep -x containerd >/dev/null; then
  setsid nohup containerd >/var/log/containerd.log 2>&1 < /dev/null &
  sleep 1
fi
if ! pgrep -x dockerd >/dev/null; then
  setsid nohup dockerd --containerd=/run/containerd/containerd.sock >/var/log/dockerd.log 2>&1 < /dev/null &
fi
for _ in $(seq 1 60); do
  docker info >/dev/null 2>&1 && break
  sleep 0.5
done
docker info --format 'docker {{.ServerVersion}} runtimes={{range $k, $v := .Runtimes}}{{$k}},{{end}} cgroup={{.CgroupVersion}}/{{.CgroupDriver}} storage={{.Driver}}'
podman info --format 'podman {{.Version.Version}} cgroup={{.Host.CgroupsVersion}}/{{.Host.CgroupManager}} runtime={{.Host.OCIRuntime.Name}} storage={{.Store.GraphDriverName}}'
