package main

import (
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	defaultMaxStreamBytes = 16 << 20
	defaultMaxSpillBytes  = 256 << 20
	defaultCancelGraceMs  = 2000
	outputChunkBytes      = 64 << 10
	exitIdleGrace         = 100 * time.Millisecond
	execHistorySize       = 256
)

// bashCandidates are tried in order before bash on PATH and then /bin/sh.
var bashCandidates = []string{"/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"}

// findShell returns the absolute path of the shell that runs commands, or "" if there is none.
func findShell() string {
	for _, c := range bashCandidates {
		if isExecutable(c) {
			return c
		}
	}
	if p, err := exec.LookPath("bash"); err == nil && filepath.IsAbs(p) {
		return p
	}
	if isExecutable("/bin/sh") {
		return "/bin/sh"
	}
	return ""
}

func isExecutable(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular() && fi.Mode()&0o111 != 0
}

type execStartParams struct {
	ID             string            `json:"id"`
	Command        *string           `json:"command"`
	Cwd            string            `json:"cwd"`
	Env            map[string]string `json:"env"`
	InheritEnv     *bool             `json:"inheritEnv"`
	TimeoutMs      *int64            `json:"timeoutMs"`
	MaxStreamBytes *int64            `json:"maxStreamBytes"`
	SpillPath      string            `json:"spillPath"`
	MaxSpillBytes  *int64            `json:"maxSpillBytes"`
}

type execOutput struct {
	ID   string `json:"id"`
	Seq  int64  `json:"seq"`
	Data []byte `json:"data"`
}

// execExit is the payload of exec.exit, also returned by exec.status for finished execs.
type execExit struct {
	ID             string      `json:"id"`
	ExitCode       *int        `json:"exitCode"`
	Signal         *string     `json:"signal"`
	TimedOut       bool        `json:"timedOut"`
	Cancelled      bool        `json:"cancelled"`
	DurationMs     int64       `json:"durationMs"`
	TotalBytes     int64       `json:"totalBytes"`
	StreamedBytes  int64       `json:"streamedBytes"`
	Truncated      bool        `json:"truncated"`
	SpillPath      *string     `json:"spillPath"`
	SpillBytes     *int64      `json:"spillBytes"`
	SpillTruncated bool        `json:"spillTruncated"`
	Error          *protoError `json:"error"`
}

func (s *Server) execStart(p *execStartParams) (any, error) {
	if p.ID == "" {
		return nil, badRequest("missing id")
	}
	if p.Command == nil {
		return nil, badRequest("missing command")
	}
	cwd := s.cfg.Cwd
	if p.Cwd != "" {
		if err := requireAbs("cwd", p.Cwd); err != nil {
			return nil, err
		}
		cwd = p.Cwd
	}
	if p.SpillPath != "" {
		if err := requireAbs("spillPath", p.SpillPath); err != nil {
			return nil, err
		}
	}
	var timeout time.Duration
	if p.TimeoutMs != nil {
		if *p.TimeoutMs <= 0 {
			return nil, badRequest("timeoutMs must be positive")
		}
		timeout = millis(*p.TimeoutMs)
	}
	maxStream, err := limitParam("maxStreamBytes", p.MaxStreamBytes, defaultMaxStreamBytes)
	if err != nil {
		return nil, err
	}
	maxSpill, err := limitParam("maxSpillBytes", p.MaxSpillBytes, defaultMaxSpillBytes)
	if err != nil {
		return nil, err
	}
	env, err := s.childEnv(p.InheritEnv == nil || *p.InheritEnv, p.Env)
	if err != nil {
		return nil, err
	}
	shell := findShell()
	if shell == "" {
		return nil, newError(codeShellUnavailable, "no shell found (tried bash and /bin/sh)")
	}
	if fi, err := os.Stat(cwd); err != nil {
		return nil, spawnError(fsError(err, "chdir", cwd))
	} else if !fi.IsDir() {
		return nil, spawnError(errnoError(syscall.ENOTDIR, "chdir", cwd))
	}

	proc, err := s.execs.reserve(p.ID)
	if err != nil {
		return nil, err
	}
	var spill *spillFile
	if p.SpillPath != "" {
		f, err := os.OpenFile(p.SpillPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
		if err != nil {
			s.execs.release(proc)
			return nil, spawnError(fsError(err, "open", p.SpillPath))
		}
		spill = &spillFile{path: p.SpillPath, f: f, limit: maxSpill}
	}
	proc.start = time.Now()
	cmd, pr, err := startProcess(shell, *p.Command, cwd, env)
	if err != nil {
		s.execs.release(proc)
		if spill != nil {
			spill.f.Close()
			os.Remove(spill.path)
		}
		return nil, err
	}
	s.execs.started(proc, cmd.Process.Pid, timeout)
	go proc.reap(cmd, pr)
	// The pump starts only after the response is written, so {pid} precedes every exec.output.
	return deferred{
		result: map[string]int{"pid": cmd.Process.Pid},
		after:  func() { s.pump(proc, pr, spill, maxStream) },
	}, nil
}

// millis converts a millisecond count to a Duration, saturating instead of overflowing, so that
// a huge value such as Number.MAX_SAFE_INTEGER means "practically never".
func millis(ms int64) time.Duration {
	return time.Duration(min(ms, math.MaxInt64/int64(time.Millisecond))) * time.Millisecond
}

// spawnError re-labels a filesystem error that prevented a command from starting.
func spawnError(pe *protoError) *protoError {
	return &protoError{Code: codeSpawnError, Message: pe.Message, Path: pe.Path}
}

// childEnv builds a command's environment: envd's own (with HOME from --home and the session
// environment from hello) when inheriting, overlaid with overrides. exec.Cmd keeps the last value
// of duplicate keys.
func (s *Server) childEnv(inherit bool, overrides map[string]string) ([]string, error) {
	env := []string{} // non-nil: a nil Env would make exec.Cmd inherit envd's environment
	if inherit {
		env = os.Environ()
		if s.cfg.Home != "" {
			env = append(env, "HOME="+s.cfg.Home)
		}
		s.envMu.Lock()
		for k, v := range s.sessionEnv {
			env = append(env, k+"="+v)
		}
		s.envMu.Unlock()
	}
	for k, v := range overrides {
		if err := checkEnvEntry(k, v); err != nil {
			return nil, err
		}
		env = append(env, k+"="+v)
	}
	return env, nil
}

// checkEnvEntry rejects names and values that cannot be represented in an environment block.
func checkEnvEntry(k, v string) error {
	if k == "" || strings.ContainsAny(k, "=\x00") || strings.ContainsRune(v, 0) {
		return badRequest("invalid env entry %q", k)
	}
	return nil
}

// startProcess runs `shell -c command` in a new process group, with stdin from /dev/null and
// stdout and stderr sharing one pipe, whose read end it returns.
func startProcess(shell, command, cwd string, env []string) (*exec.Cmd, *os.File, error) {
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, nil, newError(codeSpawnError, "creating output pipe: %v", err)
	}
	cmd := &exec.Cmd{
		Path:        shell,
		Args:        []string{shell, "-c", command},
		Dir:         cwd,
		Env:         env,
		Stdout:      pw,
		Stderr:      pw,
		SysProcAttr: &syscall.SysProcAttr{Setpgid: true},
	}
	err = cmd.Start()
	pw.Close() // only the children hold the write end now, so EOF means all of them are done
	if err != nil {
		pr.Close()
		return nil, nil, newError(codeSpawnError, "spawn %s: %v", shell, err)
	}
	return cmd, pr, nil
}

// spillFile receives the complete output of an exec, up to limit bytes.
type spillFile struct {
	path  string
	f     *os.File
	limit int64
	bytes int64
	err   error // first write or close error; writing stops after it
}

func (sf *spillFile) write(b []byte) {
	if sf.err != nil {
		return
	}
	b = b[:min(int64(len(b)), max(sf.limit-sf.bytes, 0))]
	if len(b) == 0 {
		return
	}
	n, err := sf.f.Write(b)
	sf.bytes += int64(n)
	sf.err = err
}

func (sf *spillFile) close() {
	if err := sf.f.Close(); err != nil && sf.err == nil {
		sf.err = err
	}
}

// pump streams an exec's combined output as exec.output events until pipe EOF, or until the leader
// has exited and no output arrived for exitIdleGrace. It then closes the pipe, records the result
// and emits the single exec.exit, after all of the exec's output events.
func (s *Server) pump(p *execProc, pr *os.File, spill *spillFile, maxStream int64) {
	exit := &execExit{ID: p.id}
	var seq int64
	var readErr error
	var lastActive time.Time // when the last chunk was handled
	buf := make([]byte, outputChunkBytes)
	for {
		if exitAt, ok := p.exitTime(); ok {
			idleFrom := exitAt
			if lastActive.After(idleFrom) {
				idleFrom = lastActive
			}
			deadline := idleFrom.Add(exitIdleGrace)
			if !time.Now().Before(deadline) {
				break
			}
			pr.SetReadDeadline(deadline)
		}
		n, err := pr.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			exit.TotalBytes += int64(n)
			if room := maxStream - exit.StreamedBytes; room > 0 {
				out := chunk[:min(int64(n), room)]
				s.out.emit("exec.output", execOutput{ID: p.id, Seq: seq, Data: out})
				seq++
				exit.StreamedBytes += int64(len(out))
			}
			if spill != nil {
				spill.write(chunk)
			}
			lastActive = time.Now()
		}
		if err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				continue // the loop head decides whether the idle grace has really run out
			}
			if !errors.Is(err, io.EOF) {
				readErr = err
			}
			break
		}
	}
	pr.Close() // background writers still holding the pipe get SIGPIPE on their next write
	<-p.exited

	exit.DurationMs = time.Since(p.start).Milliseconds()
	exit.Truncated = exit.StreamedBytes < exit.TotalBytes
	exit.ExitCode, exit.Signal = exitStatus(p.state)
	if spill != nil {
		spill.close()
		exit.SpillPath, exit.SpillBytes = &spill.path, &spill.bytes
		exit.SpillTruncated = spill.bytes < exit.TotalBytes
	}
	switch {
	case p.waitErr != nil:
		exit.Error = newError(codeUnknown, "waiting for process: %v", p.waitErr)
	case readErr != nil:
		exit.Error = newError(codeUnknown, "reading output: %v", readErr)
	case spill != nil && spill.err != nil:
		pe := fsError(spill.err, "write", spill.path)
		exit.Error = &protoError{Code: pe.Code, Message: pe.Message}
	}
	s.execs.finish(p, exit)
	s.out.emit("exec.exit", exit)
}

// exitStatus extracts the exit code, or the signal name if the leader was killed by a signal.
func exitStatus(state *os.ProcessState) (*int, *string) {
	if state == nil {
		return nil, nil
	}
	if ws, ok := state.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		name := unix.SignalName(ws.Signal())
		if name == "" {
			name = fmt.Sprintf("SIG%d", int(ws.Signal()))
		}
		return nil, &name
	}
	code := state.ExitCode()
	return &code, nil
}

type execCancelParams struct {
	ID      string `json:"id"`
	GraceMs *int64 `json:"graceMs"`
}

func (s *Server) execCancel(p *execCancelParams) (any, error) {
	if p.ID == "" {
		return nil, badRequest("missing id")
	}
	graceMs, err := limitParam("graceMs", p.GraceMs, defaultCancelGraceMs)
	if err != nil {
		return nil, err
	}
	proc := s.execs.lookup(p.ID)
	signaled := proc != nil && proc.cancel(millis(graceMs))
	return map[string]bool{"signaled": signaled}, nil
}

type idParams struct {
	ID string `json:"id"`
}

type execStatusResult struct {
	State string    `json:"state"`
	Exit  *execExit `json:"exit,omitempty"`
}

func (s *Server) execStatus(p *idParams) (any, error) {
	if p.ID == "" {
		return nil, badRequest("missing id")
	}
	state, exit := s.execs.status(p.ID)
	return execStatusResult{State: state, Exit: exit}, nil
}

// execProc is one started command and its process group.
type execProc struct {
	id    string
	start time.Time

	// Set by reap before exited is closed; read only after receiving from exited.
	exited  chan struct{}
	exitAt  time.Time
	state   *os.ProcessState
	waitErr error

	mu        sync.Mutex
	pgid      int // 0 until the process has started
	timer     *time.Timer
	finished  bool // exec.exit recorded; the pgid may be reused and must not be signalled
	timedOut  bool
	cancelled bool
}

// reap waits for the leader to exit, then wakes the pump so it starts the post-exit idle countdown.
func (p *execProc) reap(cmd *exec.Cmd, pr *os.File) {
	err := cmd.Wait()
	var exitErr *exec.ExitError
	if err != nil && !errors.As(err, &exitErr) {
		p.waitErr = err
	}
	p.state = cmd.ProcessState
	p.exitAt = time.Now()
	close(p.exited)
	pr.SetReadDeadline(p.exitAt.Add(exitIdleGrace)) // unblock a Read waiting for output that may never come
}

// exitTime reports when the leader exited, if it has.
func (p *execProc) exitTime() (time.Time, bool) {
	select {
	case <-p.exited:
		return p.exitAt, true
	default:
		return time.Time{}, false
	}
}

// signalGroup sends sig to the process group and reports whether it was delivered. The caller
// holds p.mu.
func (p *execProc) signalGroup(sig syscall.Signal) bool {
	if p.finished || p.pgid == 0 {
		return false
	}
	return unix.Kill(-p.pgid, sig) == nil
}

// kill sends SIGKILL to the process group.
func (p *execProc) kill() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.signalGroup(unix.SIGKILL)
}

// expire enforces timeoutMs.
func (p *execProc) expire() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.signalGroup(unix.SIGKILL) {
		p.timedOut = true
	}
}

// cancel sends SIGTERM to the process group and SIGKILL after grace unless the exec has finished
// by then. It reports whether SIGTERM was delivered.
func (p *execProc) cancel(grace time.Duration) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.signalGroup(unix.SIGTERM) {
		return false
	}
	p.cancelled = true
	time.AfterFunc(grace, p.kill)
	return true
}

// execTable tracks running execs and remembers the exit payloads of the last execHistorySize.
type execTable struct {
	mu       sync.Mutex
	closed   bool // set by killAll; no new execs start
	running  map[string]*execProc
	finished map[string]*execExit
	order    []string // finished ids, oldest first
}

func newExecTable() *execTable {
	return &execTable{running: make(map[string]*execProc), finished: make(map[string]*execExit)}
}

// reserve registers a new exec under id, which must not be running or remembered.
func (t *execTable) reserve(id string) (*execProc, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil, newError(codeSpawnError, "envd is shutting down")
	}
	if _, ok := t.running[id]; ok || t.finished[id] != nil {
		return nil, newError(codeExecExists, "exec '%s' already exists", id)
	}
	p := &execProc{id: id, exited: make(chan struct{})}
	t.running[id] = p
	return p, nil
}

// release forgets an exec whose process failed to start.
func (t *execTable) release(p *execProc) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.running, p.id)
}

// started records the process group of p and arms its timeout. If killAll ran while the process
// was being spawned, the new group is killed right away.
func (t *execTable) started(p *execProc, pgid int, timeout time.Duration) {
	p.mu.Lock()
	p.pgid = pgid
	if timeout > 0 {
		p.timer = time.AfterFunc(timeout, p.expire)
	}
	p.mu.Unlock()
	t.mu.Lock()
	closed := t.closed
	t.mu.Unlock()
	if closed {
		p.kill()
	}
}

// finish marks p as finished, completes exit with its timeout and cancel flags, and moves it to
// the history.
func (t *execTable) finish(p *execProc, exit *execExit) {
	p.mu.Lock()
	p.finished = true
	if p.timer != nil {
		p.timer.Stop()
	}
	exit.TimedOut, exit.Cancelled = p.timedOut, p.cancelled
	p.mu.Unlock()

	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.running, p.id)
	t.finished[p.id] = exit
	t.order = append(t.order, p.id)
	if len(t.order) > execHistorySize {
		delete(t.finished, t.order[0])
		t.order = t.order[1:]
	}
}

// lookup returns the running exec with id, or nil.
func (t *execTable) lookup(id string) *execProc {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.running[id]
}

// status returns "running", "exited" with the exit payload, or "unknown".
func (t *execTable) status(id string) (string, *execExit) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, ok := t.running[id]; ok {
		return "running", nil
	}
	if exit, ok := t.finished[id]; ok {
		return "exited", exit
	}
	return "unknown", nil
}

// killAll SIGKILLs every running process group and refuses new execs.
func (t *execTable) killAll() {
	t.mu.Lock()
	t.closed = true
	procs := make([]*execProc, 0, len(t.running))
	for _, p := range t.running {
		procs = append(procs, p)
	}
	t.mu.Unlock()
	for _, p := range procs {
		p.kill()
	}
}
