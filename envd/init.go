//go:build unix

package main

import (
	"bufio"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// initMain runs envd as a container's or VM's PID 1: it prepares the environment (mounts,
// directories, limits), then does nothing but reap orphaned processes (background jobs whose
// parent shell exited) until it is asked to stop. Without a reaper those processes would stay
// zombies for the whole run.
//
// With --vsock-port, init also starts a `serve --vsock-port N --accept-loop` child that serves
// controllers, and restarts it if it dies. The server must not live in this process: the reaper's
// wait4(-1) would steal the exit status of the commands it runs.
func initMain(args []string) int {
	fset := flag.NewFlagSet("init", flag.ContinueOnError)
	var dirs, readonly, drives stringList
	fset.Var(&dirs, "mkdir", "directory to create before idling (repeatable; /tmp-like paths ending in :1777 get the sticky bit)")
	fset.Var(&drives, "mount-ro", "DEVICE:DIR — mount an ext4 block device read-only at DIR (repeatable, linux)")
	fset.Var(&readonly, "readonly", "bind-mount DIR read-only onto itself (repeatable, linux)")
	owner := fset.String("chown", "", "UID:GID that owns the --mkdir directories (sticky tmp dirs and mount points excepted)")
	pidsMax := fset.Int("pids-max", 0, "limit the number of tasks of everything below init (cgroup pids controller, linux)")
	envFile := fset.String("env-file", "", "KEY=VALUE lines (an image's ENV) added to init's environment, which sessions inherit")
	vm := fset.Bool("vm", false, "envd is the kernel's init in a VM: mount /proc, /sys, /dev, … and bring up loopback first (linux)")
	vsockPort := fset.Uint("vsock-port", 0, "also serve controllers connecting on this AF_VSOCK port, one at a time (linux)")
	cwd := fset.String("cwd", "/workspace", "default working directory for vsock sessions")
	home := fset.String("home", "/home/agent", "HOME for commands in vsock sessions")
	tmp := fset.String("tmp", "/tmp", "temp directory for vsock sessions")
	if err := fset.Parse(args); err != nil || fset.NArg() > 0 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	uid, gid := -1, -1
	if *owner != "" {
		var err error
		if uid, gid, err = parseOwner(*owner); err != nil {
			log.Printf("init: --chown: %v", err)
			return 2
		}
	}
	if *vm {
		if err := vmSetup(); err != nil {
			log.Printf("init: %v", err)
			return 1
		}
	}
	if *envFile != "" {
		if err := loadEnvFile(*envFile); err != nil {
			log.Printf("init: --env-file: %v", err)
		}
	}
	for _, spec := range drives {
		dev, dir, ok := strings.Cut(spec, ":")
		if !ok || dev == "" || dir == "" {
			log.Printf("init: --mount-ro wants DEVICE:DIR, got %q", spec)
			return 2
		}
		if err := mountReadOnly(dev, dir); err != nil {
			log.Printf("init: %v", err)
			return 1
		}
	}
	mounts := mountPoints()
	for _, spec := range dirs {
		path, mode := spec, os.FileMode(0o755)
		if strings.HasSuffix(spec, ":1777") {
			path, mode = strings.TrimSuffix(spec, ":1777"), 0o1777
		}
		// Existing directories (e.g. a host directory mounted at /workspace) keep their mode.
		if _, err := os.Stat(path); err != nil {
			if err := os.MkdirAll(path, mode); err != nil {
				log.Printf("init: %v", err)
				return 1
			}
			if err := os.Chmod(path, mode); err != nil {
				log.Printf("init: %v", err)
			}
		}
		if uid >= 0 && mode != 0o1777 && !mounts[filepath.Clean(path)] {
			if err := os.Chown(path, uid, gid); err != nil {
				log.Printf("init: %v", err)
				return 1
			}
		}
	}
	for _, dir := range readonly {
		if err := bindReadOnly(dir); err != nil {
			log.Printf("init: %v", err)
			return 1
		}
	}
	if *pidsMax > 0 {
		if err := limitPids(*pidsMax); err != nil {
			log.Printf("init: --pids-max: %v", err)
			return 1
		}
	}

	sigs := make(chan os.Signal, 8)
	signal.Notify(sigs, syscall.SIGCHLD, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	server := 0
	var serverArgs []string
	if *vsockPort != 0 {
		exe, err := os.Executable()
		if err != nil {
			log.Printf("init: %v", err)
			return 1
		}
		serverArgs = []string{exe, "serve", "--vsock-port", strconv.FormatUint(uint64(*vsockPort), 10), "--accept-loop",
			"--cwd", *cwd, "--tmp", *tmp, "--home", *home}
		if server, err = startChild(serverArgs); err != nil {
			log.Printf("init: starting vsock server: %v", err)
			return 1
		}
	}
	for sig := range sigs {
		if sig != syscall.SIGCHLD {
			return 0
		}
		for _, pid := range reapAll() {
			if pid != server || server == 0 {
				continue
			}
			log.Printf("init: vsock server %d exited; restarting", pid)
			time.Sleep(200 * time.Millisecond)
			var err error
			if server, err = startChild(serverArgs); err != nil {
				log.Printf("init: restarting vsock server: %v", err)
				return 1
			}
		}
	}
	return 0
}

// startChild starts argv with init's environment and stdio and returns its pid. It is reaped
// by reapAll like every other child of init.
func startChild(argv []string) (int, error) {
	return syscall.ForkExec(argv[0], argv, &syscall.ProcAttr{Env: os.Environ(), Files: []uintptr{0, 1, 2}})
}

// reapAll collects every exited child without blocking and returns their pids.
func reapAll() []int {
	var pids []int
	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
		if pid <= 0 || err != nil {
			return pids
		}
		pids = append(pids, pid)
	}
}

// loadEnvFile sets every KEY=VALUE line of path in the process environment (blank lines and
// lines starting with # are skipped).
func loadEnvFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok || key == "" {
			return fmt.Errorf("malformed line %q", line)
		}
		os.Setenv(key, value)
	}
	return nil
}

// parseOwner parses "UID:GID" (numeric).
func parseOwner(s string) (int, int, error) {
	u, g, ok := strings.Cut(s, ":")
	if !ok {
		g = u
	}
	uid, err := strconv.Atoi(u)
	if err != nil || uid < 0 {
		return 0, 0, fmt.Errorf("invalid uid in %q", s)
	}
	gid, err := strconv.Atoi(g)
	if err != nil || gid < 0 {
		return 0, 0, fmt.Errorf("invalid gid in %q", s)
	}
	return uid, gid, nil
}

// mountPoints returns the set of mount points (linux: /proc/self/mountinfo; elsewhere empty).
func mountPoints() map[string]bool {
	points := map[string]bool{}
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return points
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) > 4 {
			points[unescapeMountPath(fields[4])] = true
		}
	}
	return points
}

// unescapeMountPath decodes the octal escapes (\040 etc.) of /proc/self/mountinfo paths.
func unescapeMountPath(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// stringList is a repeatable string flag.
type stringList []string

func (s *stringList) String() string     { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }
