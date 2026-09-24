package main

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// frame is any envd → controller frame, as seen by tests.
type frame struct {
	T  string          `json:"t"`
	ID int64           `json:"id"`
	OK bool            `json:"ok"`
	R  json.RawMessage `json:"r"`
	E  *protoError     `json:"e"`
	M  string          `json:"m"`
	P  json.RawMessage `json:"p"`

	index int // arrival position among all frames
}

// testClient speaks the protocol: it writes requests to w and routes the frames passed to deliver
// to the waiting caller (responses) or to per-exec queues (events).
type testClient struct {
	t       testing.TB
	w       io.Writer
	mu      sync.Mutex
	nextID  int64
	arrived int
	pending map[int64]chan frame
	events  map[string]chan frame
}

func newTestClient(t testing.TB, w io.Writer) *testClient {
	return &testClient{t: t, w: w, pending: make(map[int64]chan frame), events: make(map[string]chan frame)}
}

// deliver routes one frame; it must be called by a single producer, in arrival order.
func (c *testClient) deliver(line []byte) {
	var f frame
	if err := json.Unmarshal(line, &f); err != nil {
		c.t.Errorf("malformed frame %q: %v", line, err)
		return
	}
	c.mu.Lock()
	f.index = c.arrived
	c.arrived++
	var ch chan frame
	switch f.T {
	case "res":
		ch = c.pending[f.ID]
		delete(c.pending, f.ID)
	case "evt":
		var p struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(f.P, &p); err != nil {
			c.t.Errorf("event without id: %s", line)
		}
		ch = c.queueLocked(p.ID)
	}
	c.mu.Unlock()
	if ch == nil {
		c.t.Errorf("unexpected frame: %s", line)
		return
	}
	ch <- f
}

func (c *testClient) queueLocked(id string) chan frame {
	ch, ok := c.events[id]
	if !ok {
		ch = make(chan frame, 1<<14)
		c.events[id] = ch
	}
	return ch
}

// call sends a request and waits for its response.
func (c *testClient) call(method string, params any) frame {
	c.t.Helper()
	ch := make(chan frame, 1)
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	c.pending[id] = ch
	c.mu.Unlock()
	line, err := json.Marshal(map[string]any{"t": "req", "id": id, "m": method, "p": params})
	if err != nil {
		c.t.Fatal(err)
	}
	if _, err := c.w.Write(append(line, '\n')); err != nil {
		c.t.Fatalf("sending %s: %v", method, err)
	}
	select {
	case f := <-ch:
		return f
	case <-time.After(20 * time.Second):
		c.t.Fatalf("no response to %s", method)
		return frame{}
	}
}

// ok calls method, fails the test on an error response and decodes the result into out.
func (c *testClient) ok(method string, params, out any) frame {
	c.t.Helper()
	f := c.call(method, params)
	if !f.OK {
		c.t.Fatalf("%s %v: unexpected error %+v", method, params, f.E)
	}
	if out != nil {
		if err := json.Unmarshal(f.R, out); err != nil {
			c.t.Fatalf("%s: decoding %s: %v", method, f.R, err)
		}
	}
	return f
}

// fail calls method and expects an error response with the given code.
func (c *testClient) fail(method string, params any, code string) *protoError {
	c.t.Helper()
	f := c.call(method, params)
	if f.OK {
		c.t.Fatalf("%s %v: expected %s, got result %s", method, params, code, f.R)
	}
	if f.E.Code != code {
		c.t.Fatalf("%s %v: expected %s, got %+v", method, params, code, f.E)
	}
	return f.E
}

// execStream collects the events of one exec, checking that seq is contiguous from 0.
type execStream struct {
	c           *testClient
	id          string
	ch          chan frame
	output      bytes.Buffer
	chunks      []int // sizes of the output chunks
	firstOutput int   // arrival index of the first output event, -1 if none
	exit        *execExit
	exitIndex   int
}

func (c *testClient) stream(id string) *execStream {
	c.mu.Lock()
	defer c.mu.Unlock()
	return &execStream{c: c, id: id, ch: c.queueLocked(id), firstOutput: -1}
}

// next handles one event, failing the test if none arrives before the deadline.
func (s *execStream) next(deadline <-chan time.Time) {
	s.c.t.Helper()
	select {
	case f := <-s.ch:
		switch f.M {
		case "exec.output":
			var o execOutput
			if err := json.Unmarshal(f.P, &o); err != nil {
				s.c.t.Fatal(err)
			}
			if o.Seq != int64(len(s.chunks)) {
				s.c.t.Fatalf("exec %s: seq %d, want %d", s.id, o.Seq, len(s.chunks))
			}
			if s.exit != nil {
				s.c.t.Fatalf("exec %s: output after exit", s.id)
			}
			if s.firstOutput < 0 {
				s.firstOutput = f.index
			}
			s.chunks = append(s.chunks, len(o.Data))
			s.output.Write(o.Data)
		case "exec.exit":
			if s.exit != nil {
				s.c.t.Fatalf("exec %s: second exec.exit", s.id)
			}
			s.exit = new(execExit)
			if err := json.Unmarshal(f.P, s.exit); err != nil {
				s.c.t.Fatal(err)
			}
			s.exitIndex = f.index
		default:
			s.c.t.Fatalf("unexpected event %s", f.M)
		}
	case <-deadline:
		s.c.t.Fatalf("exec %s: timed out waiting for events (output so far %q)", s.id, s.output.String())
	}
}

// waitOutput reads events until the output contains substr.
func (s *execStream) waitOutput(substr string, timeout time.Duration) {
	s.c.t.Helper()
	deadline := time.After(timeout)
	for !strings.Contains(s.output.String(), substr) {
		if s.exit != nil {
			s.c.t.Fatalf("exec %s exited before printing %q (output %q)", s.id, substr, s.output.String())
		}
		s.next(deadline)
	}
}

// wait reads events until exec.exit and returns its payload.
func (s *execStream) wait(timeout time.Duration) *execExit {
	s.c.t.Helper()
	deadline := time.After(timeout)
	for s.exit == nil {
		s.next(deadline)
	}
	return s.exit
}

// sink passes every Write, which frameWriter guarantees to be one frame, to fn.
type sink func([]byte)

func (s sink) Write(b []byte) (int, error) {
	s(bytes.TrimSuffix(b, []byte("\n")))
	return len(b), nil
}

// startServer serves cfg in-process over a pipe until the test ends.
func startServer(t *testing.T, cfg Config) *testClient {
	pr, pw := io.Pipe()
	c := newTestClient(t, pw)
	srv := newServer(cfg, sink(c.deliver))
	done := make(chan error, 1)
	go func() { done <- srv.Serve(pr) }()
	t.Cleanup(func() {
		pw.Close()
		if err := <-done; err != nil {
			t.Errorf("Serve: %v", err)
		}
	})
	return c
}

// newTestServer starts a server with fresh cwd and temp directories.
func newTestServer(t *testing.T) (*testClient, Config) {
	cfg := Config{Cwd: t.TempDir(), Tmp: t.TempDir()}
	return startServer(t, cfg), cfg
}

// runExec starts command and waits for it to exit.
func runExec(t *testing.T, c *testClient, params map[string]any) (*execStream, *execExit) {
	t.Helper()
	id := params["id"].(string)
	s := c.stream(id)
	c.ok("exec.start", params, nil)
	return s, s.wait(20 * time.Second)
}
