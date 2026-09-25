// Command lily-envd is Lily's guest agent. It runs inside an execution environment and serves
// filesystem and process primitives to the controller over newline-delimited JSON; see
// docs/envd-protocol.md.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

// Set to the lily-harness version by scripts/build-envd.mjs (-ldflags "-X main.version=...").
var version = "dev"

const usage = `usage:
  lily-envd serve --stdio [--cwd DIR] [--tmp DIR] [--home DIR] [--join-pids-cgroup]
  lily-envd serve --vsock-port PORT [--accept-loop] [--cwd DIR] [--tmp DIR] [--home DIR]
                 (--accept-loop: serve one controller after another instead of only the first)
  lily-envd init [--mkdir DIR[:1777]]... [--chown UID:GID] [--pids-max N] [--env-file FILE]
                 [--vm] [--mount-ro DEVICE:DIR]... [--readonly DIR]... [--vsock-port PORT]
                 (PID 1 of a container or VM: prepare dirs, reap orphans; with --vm mount
                  /proc,/sys,/dev and bring up lo; with --vsock-port run a vsock server child)
  lily-envd version
`

func main() {
	log.SetFlags(0)
	log.SetPrefix("lily-envd: ")
	os.Exit(run(os.Args[1:]))
}

// run executes a subcommand and returns the process exit status.
func run(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	switch args[0] {
	case "serve":
		return serve(args[1:])
	case "init":
		return initMain(args[1:])
	case "version":
		fmt.Println(version)
		return 0
	case "help", "-h", "--help":
		fmt.Print(usage)
		return 0
	}
	fmt.Fprintf(os.Stderr, "unknown command %q\n%s", args[0], usage)
	return 2
}

// serve runs the protocol over stdio or one vsock connection. It exits 0 on EOF or shutdown and
// 2 on usage and protocol errors.
func serve(args []string) int {
	fset := flag.NewFlagSet("serve", flag.ContinueOnError)
	stdio := fset.Bool("stdio", false, "serve over stdin/stdout")
	vsockPort := fset.Uint("vsock-port", 0, "serve the first connection accepted on this AF_VSOCK port (linux)")
	acceptLoop := fset.Bool("accept-loop", false, "with --vsock-port: keep accepting, serving one controller at a time")
	joinCgroup := fset.Bool("join-pids-cgroup", false, "join the pids cgroup that `init --pids-max` created (linux)")
	cwd := fset.String("cwd", "", "default working directory for commands (default: current directory)")
	tmp := fset.String("tmp", "", "temp directory (default: $TMPDIR or /tmp)")
	home := fset.String("home", "", "HOME for commands that inherit the environment")
	if err := fset.Parse(args); err != nil {
		return 2
	}
	if fset.NArg() > 0 || *stdio == (*vsockPort != 0) || *vsockPort > math.MaxUint32 || (*acceptLoop && *vsockPort == 0) {
		fmt.Fprint(os.Stderr, "serve needs exactly one of --stdio or --vsock-port PORT\n", usage)
		return 2
	}
	// A container's init creates these directories; `exec` may start this server a moment earlier.
	waitForDirs(10*time.Second, *cwd, *tmp)
	if *joinCgroup {
		joinPidsCgroup()
	}
	cfg, err := newConfig(*cwd, *tmp, *home)
	if err != nil {
		log.Print(err)
		return 2
	}

	// Handling SIGPIPE turns a write to a vanished controller into an EPIPE error instead of
	// killing envd before it can clean up. Unlike an ignored signal, a handled one is reset to
	// the default in children, which rely on SIGPIPE.
	signal.Notify(make(chan os.Signal, 1), syscall.SIGPIPE)

	if *acceptLoop {
		if err := serveVsockLoop(uint32(*vsockPort), cfg); err != nil {
			log.Print(err)
		}
		return 1
	}

	var in io.Reader = os.Stdin
	var out io.Writer = os.Stdout
	if *vsockPort != 0 {
		conn, err := acceptVsock(uint32(*vsockPort))
		if err != nil {
			log.Print(err)
			return 2
		}
		in, out = conn, conn
	}
	srv := newServer(cfg, out)

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		sig := <-sigs
		srv.Close()
		os.Exit(128 + int(sig.(syscall.Signal)))
	}()

	switch err := srv.Serve(in); {
	case err == nil:
		return 0
	case errors.Is(err, errFrameTooLong):
		log.Print(err)
		return 2
	default:
		log.Printf("reading requests: %v", err)
		return 1
	}
}

// waitForDirs waits until every non-empty dir exists, or the timeout passes.
func waitForDirs(timeout time.Duration, dirs ...string) {
	deadline := time.Now().Add(timeout)
	for _, dir := range dirs {
		for dir != "" && time.Now().Before(deadline) {
			if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
}

// newConfig resolves the serve flags into absolute paths, applying the defaults.
func newConfig(cwd, tmp, home string) (Config, error) {
	if cwd == "" {
		wd, err := os.Getwd()
		if err != nil {
			return Config{}, err
		}
		cwd = wd
	}
	if tmp == "" {
		tmp = os.TempDir()
	}
	var cfg Config
	var err error
	if cfg.Cwd, err = absDir("--cwd", cwd); err != nil {
		return Config{}, err
	}
	if cfg.Tmp, err = absDir("--tmp", tmp); err != nil {
		return Config{}, err
	}
	if home != "" {
		if cfg.Home, err = filepath.Abs(home); err != nil {
			return Config{}, fmt.Errorf("--home: %w", err)
		}
	}
	return cfg, nil
}

// absDir returns dir as an absolute path after checking that it is an existing directory.
func absDir(flagName, dir string) (string, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", fmt.Errorf("%s: %w", flagName, err)
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("%s: %w", flagName, err)
	}
	if !fi.IsDir() {
		return "", fmt.Errorf("%s: %s is not a directory", flagName, abs)
	}
	return abs, nil
}
