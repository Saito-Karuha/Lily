package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// waitGone polls until pid no longer exists (orphans are reaped asynchronously by init).
func waitGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		err := unix.Kill(pid, 0)
		if errors.Is(err, unix.ESRCH) {
			return
		}
		if time.Now().After(deadline) {
			unix.Kill(pid, unix.SIGKILL)
			t.Fatalf("process %d still exists (kill -0: %v)", pid, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestExecBasic(t *testing.T) {
	t.Parallel()
	c, _ := newTestServer(t)

	s := c.stream("echo")
	start := c.ok("exec.start", map[string]any{"id": "echo", "command": "echo hello"}, nil)
	exit := s.wait(10 * time.Second)
	if s.output.String() != "hello\n" {
		t.Errorf("output = %q", s.output.String())
	}
	if s.firstOutput < start.index || s.exitIndex < s.firstOutput {
		t.Errorf("frame order: response %d, first output %d, exit %d", start.index, s.firstOutput, s.exitIndex)
	}
	if exit.ExitCode == nil || *exit.ExitCode != 0 || exit.Signal != nil || exit.TimedOut || exit.Cancelled {
		t.Errorf("exit = %+v", exit)
	}
	if exit.TotalBytes != 6 || exit.StreamedBytes != 6 || exit.Truncated || exit.SpillPath != nil || exit.SpillBytes != nil || exit.Error != nil {
		t.Errorf("exit accounting = %+v", exit)
	}

	_, exit = runExec(t, c, map[string]any{"id": "three", "command": "exit 3"})
	if exit.ExitCode == nil || *exit.ExitCode != 3 {
		t.Errorf("exit code = %v", exit.ExitCode)
	}

	var st execStatusResult
	c.ok("exec.status", map[string]any{"id": "three"}, &st)
	if st.State != "exited" || st.Exit == nil || *st.Exit.ExitCode != 3 {
		t.Errorf("status = %+v", st)
	}
	st = execStatusResult{}
	c.ok("exec.status", map[string]any{"id": "nope"}, &st)
	if st.State != "unknown" || st.Exit != nil {
		t.Errorf("status of unknown = %+v", st)
	}
	c.fail("exec.start", map[string]any{"id": "three", "command": "true"}, codeExecExists)
}

func TestExecCombinedOrdering(t *testing.T) {
	t.Parallel()
	c, _ := newTestServer(t)
	s, exit := runExec(t, c, map[string]any{"id": "o", "command": "echo a; echo b 1>&2; echo c"})
	if s.output.String() != "a\nb\nc\n" {
		t.Errorf("output = %q", s.output.String())
	}
	if *exit.ExitCode != 0 {
		t.Errorf("exit = %+v", exit)
	}
}

func TestExecCwdAndEnv(t *testing.T) { // not parallel: uses t.Setenv
	home := t.TempDir()
	cfg := Config{Cwd: t.TempDir(), Tmp: t.TempDir(), Home: home}
	c := startServer(t, cfg)

	s, _ := runExec(t, c, map[string]any{"id": "pwd", "command": "pwd -P"})
	want, _ := filepath.EvalSymlinks(cfg.Cwd)
	if got := strings.TrimSpace(s.output.String()); got != want {
		t.Errorf("default cwd = %q, want %q", got, want)
	}
	other := t.TempDir()
	s, _ = runExec(t, c, map[string]any{"id": "pwd2", "command": "pwd -P", "cwd": other})
	want, _ = filepath.EvalSymlinks(other)
	if got := strings.TrimSpace(s.output.String()); got != want {
		t.Errorf("cwd = %q, want %q", got, want)
	}

	t.Setenv("LILY_ENVD_TEST_INHERITED", "yes")
	s, _ = runExec(t, c, map[string]any{"id": "env", "command": `echo "$HOME|$LILY_ENVD_TEST_INHERITED|$FOO"`, "env": map[string]string{"FOO": "bar"}})
	if got, want := s.output.String(), home+"|yes|bar\n"; got != want {
		t.Errorf("inherited env output = %q, want %q", got, want)
	}
	s, _ = runExec(t, c, map[string]any{"id": "noenv", "command": `echo "$HOME|$LILY_ENVD_TEST_INHERITED|$FOO"`, "env": map[string]string{"FOO": "bar"}, "inheritEnv": false})
	if got := s.output.String(); got != "||bar\n" {
		t.Errorf("isolated env output = %q", got)
	}
}

func TestExecStartErrors(t *testing.T) {
	t.Parallel()
	c, cfg := newTestServer(t)
	c.fail("exec.start", map[string]any{"id": "a"}, codeBadRequest)
	c.fail("exec.start", map[string]any{"command": "true"}, codeBadRequest)
	c.fail("exec.start", map[string]any{"id": "a", "command": "true", "cwd": "rel"}, codeBadRequest)
	c.fail("exec.start", map[string]any{"id": "a", "command": "true", "timeoutMs": 0}, codeBadRequest)
	c.fail("exec.start", map[string]any{"id": "a", "command": "true", "env": map[string]string{"A=B": "x"}}, codeBadRequest)
	missing := filepath.Join(cfg.Cwd, "missing")
	e := c.fail("exec.start", map[string]any{"id": "a", "command": "true", "cwd": missing}, codeSpawnError)
	if want := "ENOENT: no such file or directory, chdir '" + missing + "'"; e.Message != want {
		t.Errorf("message = %q, want %q", e.Message, want)
	}
	c.fail("exec.start", map[string]any{"id": "a", "command": "true", "spillPath": filepath.Join(missing, "log")}, codeSpawnError)
	// Failed starts do not consume the id.
	runExec(t, c, map[string]any{"id": "a", "command": "true"})
}

func TestExecTimeout(t *testing.T) {
	t.Parallel()
	c, _ := newTestServer(t)
	begin := time.Now()
	_, exit := runExec(t, c, map[string]any{"id": "t", "command": "sleep 30", "timeoutMs": 200})
	if elapsed := time.Since(begin); elapsed > 5*time.Second {
		t.Errorf("timeout took %v", elapsed)
	}
	if !exit.TimedOut || exit.ExitCode != nil || exit.Signal == nil || *exit.Signal != "SIGKILL" || exit.Cancelled {
		t.Errorf("exit = %+v", exit)
	}

	// A huge timeout (JavaScript's MAX_SAFE_INTEGER) must not overflow into an immediate kill.
	_, exit = runExec(t, c, map[string]any{"id": "huge", "command": "sleep 0.2", "timeoutMs": int64(1<<53 - 1)})
	if exit.TimedOut || exit.ExitCode == nil || *exit.ExitCode != 0 {
		t.Errorf("exit with huge timeout = %+v", exit)
	}
}

func TestExecCancelKillsGroup(t *testing.T) {
	t.Parallel()
	c, _ := newTestServer(t)
	s := c.stream("c")
	c.ok("exec.start", map[string]any{"id": "c", "command": "sleep 30 & echo $!; sleep 30"}, nil)
	s.waitOutput("\n", 10*time.Second)
	child, err := strconv.Atoi(strings.TrimSpace(s.output.String()))
	if err != nil {
		t.Fatalf("background pid: %v (output %q)", err, s.output.String())
	}

	var st execStatusResult
	c.ok("exec.status", map[string]any{"id": "c"}, &st)
	if st.State != "running" {
		t.Errorf("status = %+v", st)
	}
	var r struct{ Signaled bool }
	c.ok("exec.cancel", map[string]any{"id": "c"}, &r)
	if !r.Signaled {
		t.Fatal("cancel did not signal")
	}
	exit := s.wait(10 * time.Second)
	if !exit.Cancelled || exit.TimedOut || exit.ExitCode != nil || exit.Signal == nil || *exit.Signal != "SIGTERM" {
		t.Errorf("exit = %+v", exit)
	}
	waitGone(t, child)

	c.ok("exec.cancel", map[string]any{"id": "c"}, &r)
	if r.Signaled {
		t.Error("cancelling a finished exec signaled")
	}
	c.ok("exec.cancel", map[string]any{"id": "unknown"}, &r)
	if r.Signaled {
		t.Error("cancelling an unknown exec signaled")
	}
}

func TestExecCancelEscalatesToKill(t *testing.T) {
	t.Parallel()
	c, _ := newTestServer(t)
	s := c.stream("k")
	c.ok("exec.start", map[string]any{"id": "k", "command": "trap '' TERM; echo ready; sleep 30"}, nil)
	s.waitOutput("ready", 10*time.Second)
	begin := time.Now()
	c.ok("exec.cancel", map[string]any{"id": "k", "graceMs": 200}, nil)
	exit := s.wait(10 * time.Second)
	if elapsed := time.Since(begin); elapsed < 150*time.Millisecond || elapsed > 5*time.Second {
		t.Errorf("cancel took %v", elapsed)
	}
	if !exit.Cancelled || exit.Signal == nil || *exit.Signal != "SIGKILL" {
		t.Errorf("exit = %+v", exit)
	}
}

func TestExecBackgroundHolderDoesNotBlockExit(t *testing.T) {
	t.Parallel()
	c, _ := newTestServer(t)
	begin := time.Now()
	// The subshell keeps the output pipe open; envd must give up 100 ms after the shell exits.
	s, exit := runExec(t, c, map[string]any{"id": "bg", "command": "(sleep 2; echo late) & echo early"})
	if elapsed := time.Since(begin); elapsed > 1500*time.Millisecond {
		t.Errorf("exit took %v", elapsed)
	}
	if s.output.String() != "early\n" || *exit.ExitCode != 0 {
		t.Errorf("output %q, exit %+v", s.output.String(), exit)
	}
}

func TestExecTruncationAndSpill(t *testing.T) {
	t.Parallel()
	c, cfg := newTestServer(t)
	const total = 300000
	full := strings.Repeat("a\n", total/2)
	spillPath := filepath.Join(cfg.Tmp, "spill.log")
	s, exit := runExec(t, c, map[string]any{
		"id": "big", "command": "yes a | head -c 300000", "maxStreamBytes": 100000, "spillPath": spillPath,
	})
	if s.output.String() != full[:100000] {
		t.Errorf("streamed %d bytes, want the first 100000 bytes of the output", s.output.Len())
	}
	for _, n := range s.chunks {
		if n > outputChunkBytes {
			t.Errorf("chunk of %d bytes", n)
		}
	}
	if exit.TotalBytes != total || exit.StreamedBytes != 100000 || !exit.Truncated {
		t.Errorf("exit accounting = %+v", exit)
	}
	if exit.SpillPath == nil || *exit.SpillPath != spillPath || exit.SpillBytes == nil || *exit.SpillBytes != total || exit.SpillTruncated {
		t.Errorf("spill accounting = %+v", exit)
	}
	if data, err := os.ReadFile(spillPath); err != nil || string(data) != full {
		t.Errorf("spill file: %d bytes, %v", len(data), err)
	}

	_, exit = runExec(t, c, map[string]any{
		"id": "capped", "command": "yes a | head -c 300000", "spillPath": spillPath, "maxSpillBytes": 1000,
	})
	if *exit.SpillBytes != 1000 || !exit.SpillTruncated || exit.Truncated || exit.StreamedBytes != total {
		t.Errorf("capped spill = %+v", exit)
	}
	if fi, err := os.Stat(spillPath); err != nil || fi.Size() != 1000 {
		t.Errorf("capped spill file: %v", err)
	}
}

func TestExecHistoryIsBounded(t *testing.T) {
	t.Parallel()
	table := newExecTable()
	for i := range execHistorySize + 10 {
		p, err := table.reserve(strconv.Itoa(i))
		if err != nil {
			t.Fatal(err)
		}
		table.finish(p, &execExit{ID: p.id})
	}
	if state, _ := table.status("0"); state != "unknown" {
		t.Errorf("oldest exec state = %s", state)
	}
	if state, exit := table.status(strconv.Itoa(execHistorySize + 9)); state != "exited" || exit == nil {
		t.Errorf("newest exec state = %s", state)
	}
	if len(table.finished) != execHistorySize {
		t.Errorf("remembered %d execs", len(table.finished))
	}
}

func TestShutdownKillsRunningGroups(t *testing.T) {
	t.Parallel()
	pr, pw := io.Pipe()
	t.Cleanup(func() { pw.Close() })
	c := newTestClient(t, pw)
	srv := newServer(Config{Cwd: t.TempDir(), Tmp: t.TempDir()}, sink(c.deliver))
	done := make(chan error, 1)
	go func() { done <- srv.Serve(pr) }()

	var start struct{ PID int }
	c.ok("exec.start", map[string]any{"id": "s", "command": "sleep 60"}, &start)
	c.ok("shutdown", map[string]any{}, nil)
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Serve = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return after shutdown")
	}
	waitGone(t, start.PID)
}

func TestHelloSessionEnv(t *testing.T) {
	t.Parallel()
	cfg := Config{Cwd: t.TempDir(), Tmp: t.TempDir(), Home: t.TempDir()}
	c := startServer(t, cfg)
	c.fail("hello", map[string]any{"protocol": 1, "env": map[string]string{"A=B": "x"}}, codeBadRequest)
	c.ok("hello", map[string]any{"protocol": 1, "env": map[string]string{"LILY_SESSION": "s", "FOO": "session"}}, nil)
	s, _ := runExec(t, c, map[string]any{"id": "inherit", "command": `echo "$LILY_SESSION|$FOO"`, "env": map[string]string{"FOO": "request"}})
	if got := s.output.String(); got != "s|request\n" {
		t.Errorf("session env with override = %q", got)
	}
	s, _ = runExec(t, c, map[string]any{"id": "isolated", "command": `echo "$LILY_SESSION|$FOO"`, "inheritEnv": false})
	if got := s.output.String(); got != "|\n" {
		t.Errorf("isolated env = %q", got)
	}
}

func TestInitHelpers(t *testing.T) {
	t.Parallel()
	if uid, gid, err := parseOwner("1000:100"); err != nil || uid != 1000 || gid != 100 {
		t.Errorf("parseOwner = %d %d %v", uid, gid, err)
	}
	if uid, gid, err := parseOwner("7"); err != nil || uid != 7 || gid != 7 {
		t.Errorf("parseOwner(uid only) = %d %d %v", uid, gid, err)
	}
	if _, _, err := parseOwner("agent:agent"); err == nil {
		t.Error("parseOwner accepted names")
	}
	if got := unescapeMountPath(`/mnt/with\040space`); got != "/mnt/with space" {
		t.Errorf("unescapeMountPath = %q", got)
	}
}
