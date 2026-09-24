//go:build linux

package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"

	"golang.org/x/sys/unix"
)

// vmSetup prepares a bare VM where envd is the kernel's init: the pseudo filesystems every
// program expects, cgroup v2, the loopback interface, a hostname, and a sane default environment
// for child processes.
func vmSetup() error {
	mounts := []struct {
		source, target, fstype string
		flags                  uintptr
		data                   string
	}{
		{"proc", "/proc", "proc", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC, ""},
		{"sysfs", "/sys", "sysfs", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC, ""},
		{"devtmpfs", "/dev", "devtmpfs", unix.MS_NOSUID, "mode=0755"},
		{"devpts", "/dev/pts", "devpts", unix.MS_NOSUID | unix.MS_NOEXEC, "gid=5,mode=620,ptmxmode=666"},
		{"tmpfs", "/dev/shm", "tmpfs", unix.MS_NOSUID | unix.MS_NODEV, "mode=1777"},
		{"tmpfs", "/run", "tmpfs", unix.MS_NOSUID | unix.MS_NODEV, "mode=0755"},
	}
	for _, m := range mounts {
		if err := os.MkdirAll(m.target, 0o755); err != nil {
			return err
		}
		if err := unix.Mount(m.source, m.target, m.fstype, m.flags, m.data); err != nil && !errors.Is(err, unix.EBUSY) {
			return fmt.Errorf("mount %s: %w", m.target, err)
		}
	}
	// cgroup v2 is optional (a kernel without it still boots); --pids-max needs it.
	if err := unix.Mount("cgroup2", "/sys/fs/cgroup", "cgroup2", unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, ""); err != nil && !errors.Is(err, unix.EBUSY) {
		log.Printf("init: mount /sys/fs/cgroup: %v", err)
	}
	// Nothing else configures networking in the VM; without lo even 127.0.0.1 is unreachable.
	if err := loopbackUp(); err != nil {
		log.Printf("init: loopback: %v", err)
	}
	_ = unix.Sethostname([]byte("lily"))
	for key, value := range map[string]string{
		"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"LANG": "C.UTF-8",
		"HOME": "/root",
	} {
		if os.Getenv(key) == "" {
			os.Setenv(key, value)
		}
	}
	return nil
}

// loopbackUp sets IFF_UP on lo; the kernel then assigns 127.0.0.1/8 and ::1 itself.
func loopbackUp() error {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	ifr, err := unix.NewIfreq("lo")
	if err != nil {
		return err
	}
	if err := unix.IoctlIfreq(fd, unix.SIOCGIFFLAGS, ifr); err != nil {
		return fmt.Errorf("SIOCGIFFLAGS: %w", err)
	}
	ifr.SetUint16(ifr.Uint16() | unix.IFF_UP)
	if err := unix.IoctlIfreq(fd, unix.SIOCSIFFLAGS, ifr); err != nil {
		return fmt.Errorf("SIOCSIFFLAGS: %w", err)
	}
	return nil
}

// mountReadOnly mounts an ext4 block device read-only at dir. With a device the VMM exposes
// read-only, not even root in the guest can make it writable.
func mountReadOnly(dev, dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := unix.Mount(dev, dir, "ext4", unix.MS_RDONLY|unix.MS_NOSUID|unix.MS_NODEV, "noload"); err != nil {
		return fmt.Errorf("mount %s on %s: %w", dev, dir, err)
	}
	return nil
}

// bindReadOnly makes dir a read-only bind mount of itself.
func bindReadOnly(dir string) error {
	if err := unix.Mount(dir, dir, "", unix.MS_BIND|unix.MS_REC, ""); err != nil {
		return fmt.Errorf("bind %s: %w", dir, err)
	}
	if err := unix.Mount("", dir, "", unix.MS_BIND|unix.MS_REMOUNT|unix.MS_RDONLY|unix.MS_NOSUID|unix.MS_NODEV, ""); err != nil {
		return fmt.Errorf("remount %s read-only: %w", dir, err)
	}
	return nil
}

// pidsCgroupDirs are where limitPids creates a cgroup when it cannot limit its own (a VM's root
// cgroup has no pids.max): cgroup v2, or the v1 pids hierarchy.
var pidsCgroupDirs = []string{"/sys/fs/cgroup/lily", "/sys/fs/cgroup/pids/lily"}

// limitPids caps the number of tasks of init and everything started after it.
//
//   - A container's own cgroup (the root of its cgroup namespace; Apple container VMs, gVisor's
//     in-sandbox v1 cgroupfs) has a pids.max: set it, which also covers `exec` sessions.
//   - A VM's real root cgroup has none: create a child cgroup and move init into it; children
//     inherit it and `serve --join-pids-cgroup` joins it.
func limitPids(max int) error {
	value := []byte(strconv.Itoa(max))
	for _, file := range []string{"/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/pids/pids.max"} {
		if exists(file) {
			if err := os.WriteFile(file, value, 0); err != nil {
				return fmt.Errorf("set %s: %w", file, err)
			}
			return nil
		}
	}
	var dir string
	switch {
	case exists("/sys/fs/cgroup/cgroup.controllers"):
		if err := os.WriteFile("/sys/fs/cgroup/cgroup.subtree_control", []byte("+pids"), 0); err != nil {
			return fmt.Errorf("enable pids controller: %w", err)
		}
		dir = pidsCgroupDirs[0]
	case exists("/sys/fs/cgroup/pids/cgroup.procs"):
		dir = pidsCgroupDirs[1]
	default:
		return errors.New("no cgroup v2 or v1 pids hierarchy under /sys/fs/cgroup")
	}
	if err := os.Mkdir(dir, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "pids.max"), value, 0); err != nil {
		return fmt.Errorf("set pids.max: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cgroup.procs"), []byte(strconv.Itoa(os.Getpid())), 0); err != nil {
		return fmt.Errorf("join %s: %w", dir, err)
	}
	return nil
}

// joinPidsCgroup moves this process into the cgroup limitPids created, if it created one.
func joinPidsCgroup() {
	for _, dir := range pidsCgroupDirs {
		if exists(filepath.Join(dir, "pids.max")) {
			if err := os.WriteFile(filepath.Join(dir, "cgroup.procs"), []byte(strconv.Itoa(os.Getpid())), 0); err != nil {
				log.Printf("joining %s: %v", dir, err)
			}
			return
		}
	}
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// serveVsockLoop accepts controller connections on an AF_VSOCK port forever, serving one at a
// time. When a controller disconnects, its running commands are killed (their outcome is
// unknown to it anyway) and the next controller may attach to the same machine.
func serveVsockLoop(port uint32, cfg Config) error {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("vsock socket: %w", err)
	}
	if err := unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: port}); err != nil {
		return fmt.Errorf("vsock bind port %d: %w", port, err)
	}
	if err := unix.Listen(fd, 4); err != nil {
		return fmt.Errorf("vsock listen: %w", err)
	}
	for {
		conn, _, err := unix.Accept4(fd, unix.SOCK_CLOEXEC)
		if errors.Is(err, unix.EINTR) || errors.Is(err, unix.ECONNABORTED) {
			continue
		}
		if err != nil {
			return fmt.Errorf("vsock accept: %w", err)
		}
		file := os.NewFile(uintptr(conn), fmt.Sprintf("vsock:%d", port))
		srv := newServer(cfg, file)
		if err := srv.Serve(file); err != nil {
			log.Printf("vsock session ended: %v", err)
		}
		srv.Close()
		file.Close()
	}
}
