package main

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// envdProcess is a lily-envd subprocess served over its stdio.
type envdProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	client *testClient
	stderr bytes.Buffer
	exited chan struct{} // closed once stdout is drained and the process reaped
}

func startEnvd(t *testing.T, bin string, args ...string) *envdProcess {
	t.Helper()
	p := &envdProcess{cmd: exec.Command(bin, append([]string{"serve", "--stdio"}, args...)...), exited: make(chan struct{})}
	var err error
	if p.stdin, err = p.cmd.StdinPipe(); err != nil {
		t.Fatal(err)
	}
	stdout, err := p.cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	p.cmd.Stderr = &p.stderr
	if err := p.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p.client = newTestClient(t, p.stdin)
	go func() {
		defer close(p.exited)
		br := bufio.NewReader(stdout)
		for {
			line, err := br.ReadBytes('\n')
			if len(line) > 0 {
				p.client.deliver(bytes.TrimSuffix(line, []byte("\n")))
			}
			if err != nil {
				break
			}
		}
		p.cmd.Wait() // only after all reads from stdout, as os/exec requires
	}()
	t.Cleanup(func() {
		p.cmd.Process.Kill()
		<-p.exited
	})
	return p
}

// wait waits for envd to exit and returns its exit status.
func (p *envdProcess) wait(t *testing.T) int {
	t.Helper()
	select {
	case <-p.exited:
		return p.cmd.ProcessState.ExitCode()
	case <-time.After(10 * time.Second):
		t.Fatalf("envd did not exit; stderr: %s", p.stderr.String())
		return -1
	}
}

func TestEndToEnd(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and runs the binary")
	}
	bin := filepath.Join(t.TempDir(), "lily-envd")
	build := exec.Command("go", "build", "-o", bin, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}

	t.Run("version", func(t *testing.T) {
		out, err := exec.Command(bin, "version").Output()
		if err != nil || strings.TrimSpace(string(out)) != version {
			t.Errorf("version = %q, %v", out, err)
		}
	})

	t.Run("usage errors", func(t *testing.T) {
		var exitErr *exec.ExitError
		for _, args := range [][]string{{}, {"serve"}, {"serve", "--stdio", "--cwd", "/nonexistent/lily"}, {"bogus"}} {
			err := exec.Command(bin, args...).Run()
			if !errors.As(err, &exitErr) || exitErr.ExitCode() != 2 {
				t.Errorf("%v: %v, want exit status 2", args, err)
			}
		}
		if runtime.GOOS != "linux" {
			out, err := exec.Command(bin, "serve", "--vsock-port", "5000").CombinedOutput()
			if !errors.As(err, &exitErr) || exitErr.ExitCode() != 2 || !strings.Contains(string(out), "only supported on linux") {
				t.Errorf("--vsock-port: %v %s", err, out)
			}
		}
	})

	t.Run("stdin EOF kills process groups", func(t *testing.T) {
		cwd := t.TempDir()
		p := startEnvd(t, bin, "--cwd", cwd, "--tmp", t.TempDir())
		c := p.client

		var hello helloResult
		c.ok("hello", map[string]any{"protocol": 1}, &hello)
		if hello.PID != p.cmd.Process.Pid || hello.Version != version || hello.Cwd != cwd {
			t.Errorf("hello = %+v", hello)
		}
		file := filepath.Join(cwd, "note.txt")
		c.ok("fs.write", map[string]any{"path": file, "data": b64("over stdio")}, nil)
		var r readResult
		c.ok("fs.read", map[string]any{"path": file}, &r)
		if string(r.Data) != "over stdio" {
			t.Errorf("read = %q", r.Data)
		}

		s := c.stream("sleep")
		var start struct{ PID int }
		c.ok("exec.start", map[string]any{"id": "sleep", "command": "sleep 60 & echo $!; sleep 60"}, &start)
		s.waitOutput("\n", 10*time.Second)
		child, err := strconv.Atoi(strings.TrimSpace(s.output.String()))
		if err != nil {
			t.Fatalf("background pid: %v", err)
		}

		p.stdin.Close()
		if code := p.wait(t); code != 0 {
			t.Errorf("exit status %d; stderr: %s", code, p.stderr.String())
		}
		waitGone(t, start.PID)
		waitGone(t, child)
	})

	t.Run("shutdown", func(t *testing.T) {
		p := startEnvd(t, bin)
		var start struct{ PID int }
		p.client.ok("exec.start", map[string]any{"id": "s", "command": "sleep 60"}, &start)
		p.client.ok("shutdown", map[string]any{}, nil)
		if code := p.wait(t); code != 0 {
			t.Errorf("exit status %d; stderr: %s", code, p.stderr.String())
		}
		waitGone(t, start.PID)
	})

	t.Run("oversized frame", func(t *testing.T) {
		p := startEnvd(t, bin)
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			line := append(bytes.Repeat([]byte("x"), maxFrameBytes+1), '\n')
			p.stdin.Write(line) // fails with EPIPE once envd exits
		}()
		if code := p.wait(t); code != 2 {
			t.Errorf("exit status %d, want 2", code)
		}
		if !strings.Contains(p.stderr.String(), "16 MiB") {
			t.Errorf("stderr = %q", p.stderr.String())
		}
		p.stdin.Close()
		wg.Wait()
	})
}
