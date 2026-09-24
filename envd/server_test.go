package main

import (
	"bufio"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestReadFrame(t *testing.T) {
	br := bufio.NewReaderSize(strings.NewReader("abc\n\n"+strings.Repeat("x", 40)+"\nlast"), 16)
	for _, want := range []string{"abc", "", strings.Repeat("x", 40), "last"} {
		line, err := readFrame(br, 64)
		if err != nil || string(line) != want {
			t.Fatalf("readFrame = %q, %v; want %q", line, err, want)
		}
	}
	if _, err := readFrame(br, 64); err != io.EOF {
		t.Fatalf("readFrame at end = %v, want EOF", err)
	}

	for _, input := range []string{strings.Repeat("y", 65) + "\n", strings.Repeat("y", 100)} {
		br = bufio.NewReaderSize(strings.NewReader(input), 16)
		if _, err := readFrame(br, 64); !errors.Is(err, errFrameTooLong) {
			t.Errorf("readFrame(%d bytes) = %v, want errFrameTooLong", len(input), err)
		}
	}
	br = bufio.NewReaderSize(strings.NewReader(strings.Repeat("z", 64)+"\n"), 16)
	if line, err := readFrame(br, 64); err != nil || len(line) != 64 {
		t.Errorf("frame of exactly the limit: %d bytes, %v", len(line), err)
	}
}

func TestHelloAndPing(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	cfg := Config{Cwd: t.TempDir(), Tmp: t.TempDir(), Home: home}
	c := startServer(t, cfg)

	var hello helloResult
	c.ok("hello", map[string]any{"protocol": 1}, &hello)
	if hello.Protocol != 1 || hello.Version != version || hello.OS != runtime.GOOS || hello.Arch != runtime.GOARCH {
		t.Errorf("hello identity = %+v", hello)
	}
	if hello.PID != os.Getpid() || hello.UID != os.Getuid() || hello.GID != os.Getgid() {
		t.Errorf("hello ids = %+v", hello)
	}
	if hello.Cwd != cfg.Cwd || hello.Tmp != cfg.Tmp || hello.Home == nil || *hello.Home != home {
		t.Errorf("hello dirs = %+v", hello)
	}
	if hello.Shell == nil || !filepath.IsAbs(*hello.Shell) {
		t.Errorf("hello shell = %v", hello.Shell)
	}
	if want, _ := os.Hostname(); hello.Hostname != want {
		t.Errorf("hello hostname = %q, want %q", hello.Hostname, want)
	}
	c.fail("hello", map[string]any{"protocol": 2}, codeBadRequest)

	f := c.ok("ping", map[string]any{}, nil)
	if string(f.R) != "{}" {
		t.Errorf("ping result = %s", f.R)
	}
}

func TestDispatchErrors(t *testing.T) {
	t.Parallel()
	c, _ := newTestServer(t)
	e := c.fail("fs.nope", map[string]any{}, codeUnknownMethod)
	if e.Message != "unknown method 'fs.nope'" {
		t.Errorf("message = %q", e.Message)
	}
	c.fail("fs.stat", map[string]any{"path": 5}, codeBadRequest)
	c.fail("fs.stat", map[string]any{}, codeBadRequest)
	c.fail("fs.write", map[string]any{"path": "/tmp/x", "data": "not base64!"}, codeBadRequest)
	c.fail("fs.stat", nil, codeBadRequest) // null params: path is missing
}
