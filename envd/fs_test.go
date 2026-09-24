package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestFSWriteRead(t *testing.T) {
	t.Parallel()
	c, cfg := newTestServer(t)
	p := filepath.Join(cfg.Cwd, "sub", "dir", "a.txt")

	var w struct{ Bytes int }
	c.ok("fs.write", map[string]any{"path": p, "data": b64("hello")}, &w)
	if w.Bytes != 5 {
		t.Errorf("bytes = %d", w.Bytes)
	}
	var r readResult
	c.ok("fs.read", map[string]any{"path": p}, &r)
	if string(r.Data) != "hello" || r.Size != 5 || !r.EOF {
		t.Errorf("read = %q size %d eof %v", r.Data, r.Size, r.EOF)
	}
	c.ok("fs.read", map[string]any{"path": p, "offset": 1, "length": 2}, &r)
	if string(r.Data) != "el" || r.Size != 5 || r.EOF {
		t.Errorf("partial read = %q size %d eof %v", r.Data, r.Size, r.EOF)
	}
	c.ok("fs.read", map[string]any{"path": p, "offset": 5}, &r)
	if len(r.Data) != 0 || !r.EOF {
		t.Errorf("read at end = %q eof %v", r.Data, r.EOF)
	}

	c.ok("fs.write", map[string]any{"path": p, "data": b64(" world"), "append": true}, nil)
	c.ok("fs.read", map[string]any{"path": p}, &r)
	if string(r.Data) != "hello world" {
		t.Errorf("after append = %q", r.Data)
	}
	c.ok("fs.write", map[string]any{"path": p, "data": b64("new")}, nil)
	c.ok("fs.read", map[string]any{"path": p}, &r)
	if string(r.Data) != "new" {
		t.Errorf("after truncating write = %q", r.Data)
	}

	empty := filepath.Join(cfg.Cwd, "empty")
	c.ok("fs.write", map[string]any{"path": empty, "data": "", "mode": 0o600}, nil)
	if fi, err := os.Stat(empty); err != nil || fi.Size() != 0 || fi.Mode().Perm() != 0o600 {
		t.Errorf("empty file: %v %v", fi, err)
	}
	c.fail("fs.write", map[string]any{"path": empty}, codeBadRequest)

	missing := filepath.Join(cfg.Cwd, "nope", "f")
	e := c.fail("fs.write", map[string]any{"path": missing, "data": "", "mkdirs": false}, codeNotFound)
	if want := "ENOENT: no such file or directory, open '" + missing + "'"; e.Message != want || e.Path != missing {
		t.Errorf("error = %+v, want message %q", e, want)
	}
	e = c.fail("fs.write", map[string]any{"path": cfg.Cwd, "data": ""}, codeIsDirectory)
	if want := "EISDIR: illegal operation on a directory, open '" + cfg.Cwd + "'"; e.Message != want {
		t.Errorf("message = %q, want %q", e.Message, want)
	}

	link := filepath.Join(cfg.Cwd, "link")
	if err := os.Symlink(p, link); err != nil {
		t.Fatal(err)
	}
	c.ok("fs.read", map[string]any{"path": link}, &r)
	if string(r.Data) != "new" {
		t.Errorf("read through symlink = %q", r.Data)
	}
}

func TestFSReadErrors(t *testing.T) {
	t.Parallel()
	c, cfg := newTestServer(t)
	missing := filepath.Join(cfg.Cwd, "missing.txt")
	e := c.fail("fs.read", map[string]any{"path": missing}, codeNotFound)
	if want := "ENOENT: no such file or directory, open '" + missing + "'"; e.Message != want || e.Path != missing {
		t.Errorf("error = %+v, want %q", e, want)
	}
	e = c.fail("fs.read", map[string]any{"path": cfg.Cwd}, codeIsDirectory)
	if e.Message != "EISDIR: illegal operation on a directory, read" || e.Path != cfg.Cwd {
		t.Errorf("error = %+v", e)
	}
	e = c.fail("fs.read", map[string]any{"path": "relative.txt"}, codeBadRequest)
	if !strings.Contains(e.Message, "absolute") {
		t.Errorf("message = %q", e.Message)
	}
	c.fail("fs.read", map[string]any{"path": missing, "offset": -1}, codeBadRequest)

	if os.Getuid() != 0 {
		secret := filepath.Join(cfg.Cwd, "secret")
		if err := os.WriteFile(secret, []byte("x"), 0); err != nil {
			t.Fatal(err)
		}
		e = c.fail("fs.read", map[string]any{"path": secret}, codePermissionDenied)
		if want := "EACCES: permission denied, open '" + secret + "'"; e.Message != want {
			t.Errorf("message = %q, want %q", e.Message, want)
		}
	}
}

func TestFSStatList(t *testing.T) {
	t.Parallel()
	c, cfg := newTestServer(t)
	dir := cfg.Cwd
	file := filepath.Join(dir, "b.txt")
	if err := os.WriteFile(file, []byte("12345"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(file, 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "a"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("b.txt", filepath.Join(dir, "c")); err != nil {
		t.Fatal(err)
	}

	var st fileInfo
	c.ok("fs.stat", map[string]any{"path": file}, &st)
	if st.Name != "b.txt" || st.Path != file || st.Kind != "file" || st.Size != 5 || st.Mode != 0o640 {
		t.Errorf("stat = %+v", st)
	}
	if age := time.Since(time.UnixMilli(int64(st.MtimeMs))); age < 0 || age > time.Minute {
		t.Errorf("mtimeMs %v is not recent", st.MtimeMs)
	}
	c.ok("fs.stat", map[string]any{"path": filepath.Join(dir, "c")}, &st)
	if st.Kind != "symlink" {
		t.Errorf("stat of symlink = %+v", st)
	}
	missing := filepath.Join(dir, "zzz")
	e := c.fail("fs.stat", map[string]any{"path": missing}, codeNotFound)
	if want := "ENOENT: no such file or directory, lstat '" + missing + "'"; e.Message != want {
		t.Errorf("message = %q, want %q", e.Message, want)
	}

	var list struct{ Entries []fileInfo }
	c.ok("fs.list", map[string]any{"path": dir}, &list)
	var got []string
	for _, e := range list.Entries {
		got = append(got, e.Name+":"+e.Kind)
		if e.Path != filepath.Join(dir, e.Name) {
			t.Errorf("entry path %q", e.Path)
		}
	}
	if want := "a:directory b.txt:file c:symlink"; strings.Join(got, " ") != want {
		t.Errorf("list = %v, want %s", got, want)
	}
	e = c.fail("fs.list", map[string]any{"path": file}, codeNotDirectory)
	if want := "ENOTDIR: not a directory, scandir '" + file + "'"; e.Message != want {
		t.Errorf("message = %q, want %q", e.Message, want)
	}
	c.fail("fs.list", map[string]any{"path": missing}, codeNotFound)
}

func TestFSMkdirRemoveRename(t *testing.T) {
	t.Parallel()
	c, cfg := newTestServer(t)
	deep := filepath.Join(cfg.Cwd, "x", "y", "z")
	c.ok("fs.mkdir", map[string]any{"path": deep}, nil)
	if fi, err := os.Stat(deep); err != nil || !fi.IsDir() {
		t.Fatalf("mkdir -p: %v", err)
	}
	c.ok("fs.mkdir", map[string]any{"path": deep}, nil) // recursive tolerates existing directories
	e := c.fail("fs.mkdir", map[string]any{"path": deep, "recursive": false}, codeExists)
	if want := "EEXIST: file already exists, mkdir '" + deep + "'"; e.Message != want {
		t.Errorf("message = %q, want %q", e.Message, want)
	}
	c.fail("fs.mkdir", map[string]any{"path": filepath.Join(cfg.Cwd, "no", "parent"), "recursive": false}, codeNotFound)
	file := filepath.Join(cfg.Cwd, "f")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	c.fail("fs.mkdir", map[string]any{"path": file}, codeExists)
	c.fail("fs.mkdir", map[string]any{"path": filepath.Join(file, "sub")}, codeNotDirectory)

	moved := filepath.Join(cfg.Cwd, "g")
	c.ok("fs.rename", map[string]any{"from": file, "to": moved}, nil)
	if _, err := os.Stat(moved); err != nil {
		t.Errorf("renamed file: %v", err)
	}
	e = c.fail("fs.rename", map[string]any{"from": file, "to": moved}, codeNotFound)
	if want := "ENOENT: no such file or directory, rename '" + file + "' -> '" + moved + "'"; e.Message != want {
		t.Errorf("message = %q, want %q", e.Message, want)
	}

	c.ok("fs.remove", map[string]any{"path": moved}, nil)
	e = c.fail("fs.remove", map[string]any{"path": moved}, codeNotFound)
	if want := "ENOENT: no such file or directory, rm '" + moved + "'"; e.Message != want {
		t.Errorf("message = %q, want %q", e.Message, want)
	}
	c.ok("fs.remove", map[string]any{"path": moved, "force": true}, nil)
	top := filepath.Join(cfg.Cwd, "x")
	c.fail("fs.remove", map[string]any{"path": top}, codeIsDirectory)
	c.ok("fs.remove", map[string]any{"path": top, "recursive": true}, nil)
	if _, err := os.Stat(top); !os.IsNotExist(err) {
		t.Errorf("tree still exists: %v", err)
	}
}

func TestFSRealpath(t *testing.T) {
	t.Parallel()
	c, cfg := newTestServer(t)
	target := filepath.Join(cfg.Cwd, "target")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(cfg.Cwd, "link")
	if err := os.Symlink("target", link); err != nil {
		t.Fatal(err)
	}
	want, err := filepath.EvalSymlinks(target) // on macOS the temp dir itself sits behind /var -> /private/var
	if err != nil {
		t.Fatal(err)
	}
	var r struct{ Path string }
	c.ok("fs.realpath", map[string]any{"path": link}, &r)
	if r.Path != want {
		t.Errorf("realpath = %q, want %q", r.Path, want)
	}
	missing := filepath.Join(link, "missing")
	e := c.fail("fs.realpath", map[string]any{"path": missing}, codeNotFound)
	if want := "ENOENT: no such file or directory, realpath '" + missing + "'"; e.Message != want {
		t.Errorf("message = %q, want %q", e.Message, want)
	}
}

func TestFSMktemp(t *testing.T) {
	t.Parallel()
	c, cfg := newTestServer(t)
	var r struct{ Path string }
	c.ok("fs.mktemp", map[string]any{}, &r)
	if filepath.Dir(r.Path) != cfg.Tmp || !strings.HasPrefix(filepath.Base(r.Path), "tmp-") {
		t.Errorf("mktemp = %q", r.Path)
	}
	if fi, err := os.Stat(r.Path); err != nil || !fi.Mode().IsRegular() {
		t.Errorf("temp file: %v", err)
	}
	c.ok("fs.mktemp", map[string]any{"prefix": "run-", "suffix": ".d", "dir": true}, &r)
	base := filepath.Base(r.Path)
	if filepath.Dir(r.Path) != cfg.Tmp || !strings.HasPrefix(base, "run-") || !strings.HasSuffix(base, ".d") {
		t.Errorf("mktemp dir = %q", r.Path)
	}
	if fi, err := os.Stat(r.Path); err != nil || !fi.IsDir() {
		t.Errorf("temp dir: %v", err)
	}
	c.fail("fs.mktemp", map[string]any{"prefix": "a/b"}, codeBadRequest)
}
