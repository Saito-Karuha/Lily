package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"math/rand/v2"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// tarEntry is one entry of a test archive.
type tarEntry struct {
	name     string
	typeflag byte
	body     string
	linkname string
}

func makeTarGz(t *testing.T, entries ...tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		hdr := &tar.Header{Name: e.name, Typeflag: e.typeflag, Linkname: e.linkname, Mode: 0o644, ModTime: time.Unix(1600000000, 0)}
		if e.typeflag == tar.TypeReg {
			hdr.Size = int64(len(e.body))
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(tw, e.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// uploadArchive sends archive in chunks of chunkSize and returns the upload.end response.
func uploadArchive(t *testing.T, c *testClient, id string, params map[string]any, archive []byte, chunkSize int) frame {
	t.Helper()
	params["id"] = id
	c.ok("upload.begin", params, nil)
	for off := 0; off < len(archive); off += chunkSize {
		end := min(off+chunkSize, len(archive))
		var r struct{ Received int }
		c.ok("upload.chunk", map[string]any{"id": id, "data": archive[off:end]}, &r)
		if r.Received != end {
			t.Fatalf("received = %d, want %d", r.Received, end)
		}
	}
	return c.call("upload.end", map[string]any{"id": id})
}

// downloadArchive reads a whole download in chunks of chunkSize, returning the archive and the number of reads.
func downloadArchive(t *testing.T, c *testClient, id, root string, chunkSize int) ([]byte, int) {
	t.Helper()
	c.ok("download.begin", map[string]any{"id": id, "root": root}, nil)
	var archive []byte
	for reads := 1; ; reads++ {
		var r downloadReadResult
		c.ok("download.read", map[string]any{"id": id, "length": chunkSize}, &r)
		archive = append(archive, r.Data...)
		if r.EOF {
			return archive, reads
		}
	}
}

// snapshot describes every entry below root: kind, permissions, mtime and content or link target.
func snapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	out := make(map[string]string)
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == root {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch mode := info.Mode(); {
		case mode.IsRegular():
			data, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			out[rel] = fmt.Sprintf("file %o %d %x", mode.Perm(), info.ModTime().Unix(), sha256.Sum256(data))
		case mode.IsDir():
			out[rel] = fmt.Sprintf("dir %o %d", mode.Perm(), info.ModTime().Unix())
		case mode&fs.ModeSymlink != 0:
			target, err := os.Readlink(p)
			if err != nil {
				return err
			}
			out[rel] = "symlink " + target
		default:
			out[rel] = "other"
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestDownloadUploadRoundTrip(t *testing.T) {
	t.Parallel()
	c, cfg := newTestServer(t)
	src := filepath.Join(cfg.Cwd, "src")
	big := make([]byte, 200000)
	rng := rand.New(rand.NewPCG(1, 2))
	for i := range big {
		big[i] = byte(rng.Uint32())
	}
	files := []struct {
		name string
		data []byte
		mode fs.FileMode
	}{
		{"a.txt", []byte("hello"), 0o644},
		{"bin/run.sh", []byte("#!/bin/sh\necho hi\n"), 0o755},
		{"nested/deep/file.bin", big, 0o600},
	}
	for _, f := range files {
		p := filepath.Join(src, f.name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, f.data, f.mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, f.mode); err != nil {
			t.Fatal(err)
		}
	}
	for _, err := range []error{
		os.Mkdir(filepath.Join(src, "empty"), 0o700),
		os.Symlink("a.txt", filepath.Join(src, "link")),
		os.Symlink("/etc/hosts", filepath.Join(src, "abs-link")),
		unix.Mkfifo(filepath.Join(src, "pipe"), 0o644),
	} {
		if err != nil {
			t.Fatal(err)
		}
	}
	mtime := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	for _, name := range []string{"a.txt", "bin/run.sh", "nested/deep/file.bin", "empty", "bin", "nested/deep", "nested"} {
		if err := os.Chtimes(filepath.Join(src, name), mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}

	archive, reads := downloadArchive(t, c, "d", src, 16<<10)
	if reads < 2 {
		t.Errorf("archive of %d bytes arrived in %d read(s)", len(archive), reads)
	}
	c.fail("download.read", map[string]any{"id": "d"}, codeBadRequest) // released after eof

	dst := filepath.Join(cfg.Cwd, "dst", "sub")
	f := uploadArchive(t, c, "u", map[string]any{"root": dst}, archive, 10000)
	if !f.OK {
		t.Fatalf("upload.end: %+v", f.E)
	}
	var r struct{ Files, Bytes int }
	if err := json.Unmarshal(f.R, &r); err != nil {
		t.Fatal(err)
	}
	if r.Files != 9 || r.Bytes != 5+18+len(big) {
		t.Errorf("upload.end = %+v", r)
	}
	c.fail("upload.end", map[string]any{"id": "u"}, codeBadRequest) // released

	want := snapshot(t, src)
	if want["pipe"] != "other" {
		t.Fatalf("fifo missing from source: %v", want)
	}
	delete(want, "pipe") // special files are skipped
	got := snapshot(t, dst)
	if len(got) != len(want) {
		t.Errorf("extracted %d entries, want %d:\n got %v\nwant %v", len(got), len(want), got, want)
	}
	for name, w := range want {
		if got[name] != w {
			t.Errorf("%s: got %q, want %q", name, got[name], w)
		}
	}
}

func TestUploadRejectsUnsafeArchives(t *testing.T) {
	t.Parallel()
	c, cfg := newTestServer(t)
	outside := filepath.Join(cfg.Cwd, "outside")
	if err := os.Mkdir(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	reg := func(name string) tarEntry { return tarEntry{name: name, typeflag: tar.TypeReg, body: "x"} }
	tests := []struct {
		name    string
		archive []byte
		setup   func(root string) error
		params  map[string]any
		code    string
		clean   bool // nothing may be extracted
	}{
		{name: "dotdot", archive: makeTarGz(t, reg("ok.txt"), reg("../evil")), code: codeInvalid, clean: true},
		{name: "nested dotdot", archive: makeTarGz(t, reg("a/../../evil")), code: codeInvalid, clean: true},
		{name: "absolute", archive: makeTarGz(t, reg("ok.txt"), reg("/abs/evil")), code: codeInvalid, clean: true},
		{name: "symlink escape", archive: makeTarGz(t,
			tarEntry{name: "out", typeflag: tar.TypeSymlink, linkname: outside}, reg("out/pwned")), code: codeInvalid},
		{name: "relative symlink escape", archive: makeTarGz(t,
			tarEntry{name: "up", typeflag: tar.TypeSymlink, linkname: "../outside"}, reg("up/pwned")), code: codeInvalid},
		{name: "existing symlink escape", archive: makeTarGz(t, reg("pre/pwned")),
			setup: func(root string) error { return os.Symlink(outside, filepath.Join(root, "pre")) }, code: codeInvalid},
		{name: "char device", archive: makeTarGz(t, tarEntry{name: "dev", typeflag: tar.TypeChar}), code: codeInvalid, clean: true},
		{name: "fifo", archive: makeTarGz(t, tarEntry{name: "fifo", typeflag: tar.TypeFifo}), code: codeInvalid, clean: true},
		{name: "hardlink escape", archive: makeTarGz(t, tarEntry{name: "h", typeflag: tar.TypeLink, linkname: "../outside/x"}), code: codeInvalid, clean: true},
		{name: "absolute hardlink", archive: makeTarGz(t, tarEntry{name: "h", typeflag: tar.TypeLink, linkname: "/etc/hosts"}), code: codeInvalid, clean: true},
		{name: "hardlink to missing entry", archive: makeTarGz(t, tarEntry{name: "h", typeflag: tar.TypeLink, linkname: "nothere"}), code: codeInvalid, clean: true},
		{name: "too many files", archive: makeTarGz(t, reg("a"), reg("b"), reg("c")), params: map[string]any{"maxFiles": 2}, code: codeTooLarge, clean: true},
		{name: "too many bytes", archive: makeTarGz(t, tarEntry{name: "zeros", typeflag: tar.TypeReg, body: string(make([]byte, 100000))}),
			params: map[string]any{"maxBytes": 2000}, code: codeTooLarge, clean: true},
		{name: "not gzip", archive: []byte("definitely not a tarball"), code: codeInvalid, clean: true},
	}
	for i, tt := range tests {
		root := filepath.Join(cfg.Cwd, fmt.Sprintf("root-%d", i))
		if err := os.Mkdir(root, 0o755); err != nil {
			t.Fatal(err)
		}
		if tt.setup != nil {
			if err := tt.setup(root); err != nil {
				t.Fatal(err)
			}
		}
		before := snapshot(t, root)
		params := map[string]any{"root": root}
		for k, v := range tt.params {
			params[k] = v
		}
		f := uploadArchive(t, c, fmt.Sprintf("u%d", i), params, tt.archive, 1<<20)
		if f.OK || f.E.Code != tt.code {
			t.Errorf("%s: upload.end = ok %v %+v, want %s", tt.name, f.OK, f.E, tt.code)
		}
		if entries, _ := os.ReadDir(outside); len(entries) > 0 {
			t.Fatalf("%s: wrote outside the root: %v", tt.name, entries)
		}
		if _, err := os.Lstat(filepath.Join(cfg.Cwd, "evil")); err == nil {
			t.Fatalf("%s: wrote %s/evil", tt.name, cfg.Cwd)
		}
		if after := snapshot(t, root); tt.clean && len(after) != len(before) {
			t.Errorf("%s: partial extraction: %v", tt.name, after)
		}
	}
}

func TestUploadLimitsAndOverwrites(t *testing.T) {
	t.Parallel()
	c, cfg := newTestServer(t)
	root := filepath.Join(cfg.Cwd, "root")
	archive := makeTarGz(t, tarEntry{name: "f", typeflag: tar.TypeReg, body: "data"})

	// Compressed bytes beyond maxBytes abort the upload at the chunk that crosses the cap.
	c.ok("upload.begin", map[string]any{"id": "small", "root": root, "maxBytes": 10}, nil)
	c.fail("upload.chunk", map[string]any{"id": "small", "data": archive}, codeTooLarge)
	c.fail("upload.end", map[string]any{"id": "small"}, codeBadRequest)
	c.fail("upload.chunk", map[string]any{"id": "missing", "data": ""}, codeBadRequest)

	// Existing files are replaced without following symlinks; hardlinks within the archive work.
	target := filepath.Join(cfg.Cwd, "target")
	if err := os.WriteFile(target, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "f")); err != nil {
		t.Fatal(err)
	}
	archive = makeTarGz(t,
		tarEntry{name: "./f", typeflag: tar.TypeReg, body: "data"},
		tarEntry{name: "g", typeflag: tar.TypeLink, linkname: "f"})
	if f := uploadArchive(t, c, "over", map[string]any{"root": root}, archive, 1<<20); !f.OK {
		t.Fatalf("upload.end: %+v", f.E)
	}
	if data, _ := os.ReadFile(target); string(data) != "keep" {
		t.Errorf("symlink target was overwritten: %q", data)
	}
	fi, err := os.Lstat(filepath.Join(root, "f"))
	if err != nil || !fi.Mode().IsRegular() {
		t.Fatalf("f is not a regular file: %v %v", fi, err)
	}
	gi, err := os.Stat(filepath.Join(root, "g"))
	if err != nil || !os.SameFile(fi, gi) {
		t.Errorf("g is not a hardlink of f: %v", err)
	}
	if !fi.ModTime().Equal(time.Unix(1600000000, 0)) {
		t.Errorf("mtime = %v", fi.ModTime())
	}
}

func TestDownloadErrors(t *testing.T) {
	t.Parallel()
	c, cfg := newTestServer(t)
	c.fail("download.begin", map[string]any{"id": "x", "root": filepath.Join(cfg.Cwd, "missing")}, codeNotFound)
	file := filepath.Join(cfg.Cwd, "file")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	c.fail("download.begin", map[string]any{"id": "x", "root": file}, codeNotDirectory)
	if err := os.WriteFile(filepath.Join(cfg.Cwd, "big"), make([]byte, 1<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	c.fail("download.begin", map[string]any{"id": "x", "root": cfg.Cwd, "maxBytes": 100}, codeTooLarge)
	c.fail("download.read", map[string]any{"id": "x"}, codeBadRequest)
}
