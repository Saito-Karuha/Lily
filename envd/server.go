package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sync"
)

const protocolVersion = 1

// Config holds the command-line settings of a serve session. All paths are absolute.
type Config struct {
	Cwd  string // default exec cwd
	Tmp  string // directory for fs.mktemp and transfer buffers
	Home string // HOME for children that inherit the environment; empty keeps envd's own
}

// Server handles the requests of one controller connection.
type Server struct {
	cfg       Config
	out       *frameWriter
	execs     *execTable
	uploads   registry[*upload]
	downloads registry[*download]
	quit      chan struct{}
	quitOnce  sync.Once

	envMu      sync.Mutex
	sessionEnv map[string]string // set by hello; applied to every exec that inherits the environment
}

// newServer returns a server that writes its frames to out.
func newServer(cfg Config, out io.Writer) *Server {
	return &Server{
		cfg:   cfg,
		out:   &frameWriter{w: out},
		execs: newExecTable(),
		quit:  make(chan struct{}),
	}
}

// Serve handles requests read from r until EOF, a read or protocol error, or a shutdown request,
// then kills every running process group and releases all transfers. It returns nil on EOF and
// shutdown, and errFrameTooLong for an oversized frame.
func (s *Server) Serve(r io.Reader) error {
	errc := make(chan error, 1)
	go func() { errc <- s.readLoop(r) }()
	var err error
	select {
	case err = <-errc:
	case <-s.quit:
	}
	s.Close()
	return err
}

// Close kills all running process groups and removes transfer temp files.
func (s *Server) Close() {
	s.execs.killAll()
	s.uploads.each(func(u *upload) { os.Remove(u.tmpPath) })
	s.downloads.each(func(d *download) { os.Remove(d.tmpPath) })
}

func (s *Server) readLoop(r io.Reader) error {
	br := bufio.NewReaderSize(r, 64<<10)
	for {
		line, err := readFrame(br, maxFrameBytes)
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if len(bytes.TrimSpace(line)) > 0 {
			go s.handle(line)
		}
	}
}

// handler implements one method; it decodes its own params.
type handler func(s *Server, params json.RawMessage) (any, error)

// deferred is returned by handlers that must act only after their response has been written.
type deferred struct {
	result any
	after  func()
}

// method adapts a typed handler into a handler, decoding params into a fresh *P. Absent or null
// params leave every field at its zero value.
func method[P any](fn func(*Server, *P) (any, error)) handler {
	return func(s *Server, raw json.RawMessage) (any, error) {
		p := new(P)
		if len(raw) > 0 && string(raw) != "null" {
			if err := json.Unmarshal(raw, p); err != nil {
				return nil, badRequest("invalid params: %v", err)
			}
		}
		return fn(s, p)
	}
}

var handlers = map[string]handler{
	"hello":          method((*Server).hello),
	"ping":           method((*Server).ping),
	"shutdown":       method((*Server).shutdown),
	"fs.stat":        method((*Server).fsStat),
	"fs.read":        method((*Server).fsRead),
	"fs.write":       method((*Server).fsWrite),
	"fs.list":        method((*Server).fsList),
	"fs.realpath":    method((*Server).fsRealpath),
	"fs.mkdir":       method((*Server).fsMkdir),
	"fs.remove":      method((*Server).fsRemove),
	"fs.rename":      method((*Server).fsRename),
	"fs.mktemp":      method((*Server).fsMktemp),
	"exec.start":     method((*Server).execStart),
	"exec.cancel":    method((*Server).execCancel),
	"exec.status":    method((*Server).execStatus),
	"upload.begin":   method((*Server).uploadBegin),
	"upload.chunk":   method((*Server).uploadChunk),
	"upload.end":     method((*Server).uploadEnd),
	"download.begin": method((*Server).downloadBegin),
	"download.read":  method((*Server).downloadRead),
}

// handle decodes one request frame, runs its handler and writes the response.
func (s *Server) handle(line []byte) {
	var req request
	if err := json.Unmarshal(line, &req); err != nil {
		log.Printf("dropping malformed frame: %v", err)
		return
	}
	if req.ID <= 0 {
		log.Printf("dropping frame without a positive id")
		return
	}
	if req.T != "req" {
		s.out.respond(req.ID, nil, badRequest("unexpected frame type %q", req.T))
		return
	}
	h, ok := handlers[req.M]
	if !ok {
		s.out.respond(req.ID, nil, newError(codeUnknownMethod, "unknown method '%s'", req.M))
		return
	}
	result, after, err := s.run(h, req)
	s.out.respond(req.ID, result, err)
	if after != nil {
		after()
	}
}

// run calls h, turning a panic into an "unknown" error so that one faulty request cannot take down
// envd (and with it the controller's hold on running process groups).
func (s *Server) run(h handler, req request) (result any, after func(), err error) {
	defer func() {
		if v := recover(); v != nil {
			log.Printf("panic in %s: %v\n%s", req.M, v, debug.Stack())
			result, after, err = nil, nil, newError(codeUnknown, "internal error: %v", v)
		}
	}()
	result, err = h(s, req.P)
	if d, ok := result.(deferred); ok {
		result, after = d.result, d.after
	}
	return result, after, err
}

type helloParams struct {
	Protocol *int `json:"protocol"`
	// Env is added to the environment of every command that inherits it, for controllers that
	// cannot set envd's own environment (e.g. a VM whose envd is the kernel's init).
	Env map[string]string `json:"env"`
}

type helloResult struct {
	Protocol int     `json:"protocol"`
	Version  string  `json:"version"`
	OS       string  `json:"os"`
	Arch     string  `json:"arch"`
	PID      int     `json:"pid"`
	UID      int     `json:"uid"`
	GID      int     `json:"gid"`
	Cwd      string  `json:"cwd"`
	Home     *string `json:"home"`
	Tmp      string  `json:"tmp"`
	Shell    *string `json:"shell"`
	Hostname string  `json:"hostname"`
}

func (s *Server) hello(p *helloParams) (any, error) {
	if p.Protocol != nil && *p.Protocol != protocolVersion {
		return nil, badRequest("unsupported protocol %d (envd speaks %d)", *p.Protocol, protocolVersion)
	}
	for k, v := range p.Env {
		if err := checkEnvEntry(k, v); err != nil {
			return nil, err
		}
	}
	if p.Env != nil {
		s.envMu.Lock()
		s.sessionEnv = p.Env
		s.envMu.Unlock()
	}
	home := s.cfg.Home
	if home == "" {
		home = os.Getenv("HOME")
	}
	hostname, _ := os.Hostname() // "" when unavailable
	return helloResult{
		Protocol: protocolVersion,
		Version:  version,
		OS:       runtime.GOOS,
		Arch:     runtime.GOARCH,
		PID:      os.Getpid(),
		UID:      os.Getuid(),
		GID:      os.Getgid(),
		Cwd:      s.cfg.Cwd,
		Home:     nullable(home),
		Tmp:      s.cfg.Tmp,
		Shell:    nullable(findShell()),
		Hostname: hostname,
	}, nil
}

func (s *Server) ping(*struct{}) (any, error) { return struct{}{}, nil }

// shutdown responds, then makes Serve kill all process groups and return.
func (s *Server) shutdown(*struct{}) (any, error) {
	return deferred{result: struct{}{}, after: func() { s.quitOnce.Do(func() { close(s.quit) }) }}, nil
}

// nullable returns nil for the empty string, which encodes as JSON null.
func nullable(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}

// limitParam returns *v, or def when v is absent; negative values are rejected.
func limitParam(name string, v *int64, def int64) (int64, error) {
	if v == nil {
		return def, nil
	}
	if *v < 0 {
		return 0, badRequest("%s must not be negative", name)
	}
	return *v, nil
}

// requireAbs checks that the request field name holds an absolute path.
func requireAbs(name, path string) error {
	if path == "" {
		return badRequest("missing %s", name)
	}
	if !filepath.IsAbs(path) {
		return &protoError{Code: codeBadRequest, Message: fmt.Sprintf("%s must be absolute: '%s'", name, path), Path: path}
	}
	return nil
}

// registry is a concurrency-safe map of in-progress transfers by id.
type registry[T any] struct {
	mu sync.Mutex
	m  map[string]T
}

// add stores v under id unless the id is taken; it reports whether v was stored.
func (r *registry[T]) add(id string, v T) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.m[id]; ok {
		return false
	}
	if r.m == nil {
		r.m = make(map[string]T)
	}
	r.m[id] = v
	return true
}

func (r *registry[T]) has(id string) bool {
	_, ok := r.get(id)
	return ok
}

func (r *registry[T]) get(id string) (T, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.m[id]
	return v, ok
}

func (r *registry[T]) remove(id string) (T, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.m[id]
	delete(r.m, id)
	return v, ok
}

func (r *registry[T]) each(fn func(T)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, v := range r.m {
		fn(v)
	}
}
