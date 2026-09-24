package main

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultArchiveMaxBytes = 2 << 30
	defaultUploadMaxFiles  = 200000
	defaultReadChunkBytes  = 4 << 20
	maxReadChunkBytes      = 8 << 20 // keeps a base64 chunk well under the frame cap
)

// upload is an in-progress upload: compressed bytes accumulate in a temp file until upload.end.
type upload struct {
	tmpPath  string
	root     string
	maxBytes int64
	maxFiles int64

	mu       sync.Mutex
	file     *os.File // nil once the upload has ended or failed
	received int64
}

// download is a prepared archive being read out by download.read.
type download struct {
	tmpPath string
	size    int64

	mu   sync.Mutex
	file *os.File // nil once fully read
	sent int64
}

// discard closes and removes a transfer temp file.
func discard(f *os.File) {
	f.Close()
	os.Remove(f.Name())
}

func unknownTransfer(kind, id string) *protoError {
	return badRequest("unknown %s id '%s'", kind, id)
}

type uploadBeginParams struct {
	ID       string `json:"id"`
	Root     string `json:"root"`
	MaxBytes *int64 `json:"maxBytes"`
	MaxFiles *int64 `json:"maxFiles"`
}

func (s *Server) uploadBegin(p *uploadBeginParams) (any, error) {
	if p.ID == "" {
		return nil, badRequest("missing id")
	}
	if err := requireAbs("root", p.Root); err != nil {
		return nil, err
	}
	maxBytes, err := limitParam("maxBytes", p.MaxBytes, defaultArchiveMaxBytes)
	if err != nil {
		return nil, err
	}
	maxFiles, err := limitParam("maxFiles", p.MaxFiles, defaultUploadMaxFiles)
	if err != nil {
		return nil, err
	}
	if s.uploads.has(p.ID) {
		return nil, badRequest("upload '%s' is already in progress", p.ID)
	}
	if err := mkdirAll(p.Root); err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(s.cfg.Tmp, "lily-envd-upload-*.tar.gz")
	if err != nil {
		return nil, fsError(err, "open", s.cfg.Tmp)
	}
	u := &upload{tmpPath: f.Name(), root: p.Root, maxBytes: maxBytes, maxFiles: maxFiles, file: f}
	if !s.uploads.add(p.ID, u) {
		discard(f)
		return nil, badRequest("upload '%s' is already in progress", p.ID)
	}
	return struct{}{}, nil
}

type chunkParams struct {
	ID   string `json:"id"`
	Data []byte `json:"data"`
}

func (s *Server) uploadChunk(p *chunkParams) (any, error) {
	if p.Data == nil {
		return nil, badRequest("missing data")
	}
	u, ok := s.uploads.get(p.ID)
	if !ok {
		return nil, unknownTransfer("upload", p.ID)
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.file == nil {
		return nil, unknownTransfer("upload", p.ID)
	}
	// A failed chunk aborts the upload: the archive would be incomplete anyway.
	fail := func(err error) (any, error) {
		s.uploads.remove(p.ID)
		discard(u.file)
		u.file = nil
		return nil, err
	}
	if u.received+int64(len(p.Data)) > u.maxBytes {
		return fail(newError(codeTooLarge, "upload exceeds maxBytes (%d)", u.maxBytes))
	}
	if _, err := u.file.Write(p.Data); err != nil {
		return fail(fsError(err, "write", u.tmpPath))
	}
	u.received += int64(len(p.Data))
	return map[string]int64{"received": u.received}, nil
}

func (s *Server) uploadEnd(p *idParams) (any, error) {
	u, ok := s.uploads.remove(p.ID)
	if !ok {
		return nil, unknownTransfer("upload", p.ID)
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.file == nil {
		return nil, unknownTransfer("upload", p.ID)
	}
	f := u.file
	u.file = nil
	defer discard(f)

	// Two passes over the received archive: validate everything, then extract.
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	if err := scanArchive(f, u.maxBytes, u.maxFiles); err != nil {
		return nil, err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	files, size, err := unpackArchive(f, u.root)
	if err != nil {
		return nil, err
	}
	return map[string]int64{"files": files, "bytes": size}, nil
}

func invalidArchive(err error) *protoError {
	return newError(codeInvalid, "invalid archive: %v", err)
}

func invalidEntry(name, format string, args ...any) *protoError {
	return newError(codeInvalid, "invalid archive entry '%s': %s", name, fmt.Sprintf(format, args...))
}

// entryName converts a tar entry name into a clean slash-separated path relative to the extraction
// root, or "" for the root itself. Absolute names and ".." components are rejected.
func entryName(name string) (string, error) {
	if strings.HasPrefix(name, "/") {
		return "", invalidEntry(name, "absolute path")
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." {
			return "", invalidEntry(name, "path contains '..'")
		}
	}
	if clean := path.Clean(name); clean != "." {
		return clean, nil
	}
	return "", nil
}

func typeName(flag byte) string {
	switch flag {
	case tar.TypeChar:
		return "character device"
	case tar.TypeBlock:
		return "block device"
	case tar.TypeFifo:
		return "fifo"
	}
	return fmt.Sprintf("type %q", flag)
}

// scanArchive validates a tar.gz without touching the filesystem, so that statically detectable
// problems reject the upload before anything is written: names must stay inside the root, only
// regular files, directories, symlinks and hardlinks to earlier files of the archive are allowed,
// and the entry count and total file size must be within the limits.
func scanArchive(r io.Reader, maxBytes, maxFiles int64) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return invalidArchive(err)
	}
	tr := tar.NewReader(gz)
	files := make(map[string]bool) // regular files so far: valid hardlink targets
	var count, size int64
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return invalidArchive(err)
		}
		name, err := entryName(hdr.Name)
		if err != nil {
			return err
		}
		if name == "" {
			continue
		}
		switch hdr.Typeflag {
		case tar.TypeReg:
			if size += hdr.Size; size > maxBytes {
				return newError(codeTooLarge, "archive contents exceed maxBytes (%d)", maxBytes)
			}
			files[name] = true
		case tar.TypeLink:
			target, err := entryName(hdr.Linkname)
			if err != nil || !files[target] {
				return invalidEntry(hdr.Name, "hardlink target '%s' is not a file of the archive", hdr.Linkname)
			}
			files[name] = true
		case tar.TypeDir, tar.TypeSymlink:
			delete(files, name)
		default:
			return invalidEntry(hdr.Name, "unsupported %s", typeName(hdr.Typeflag))
		}
		if count++; count > maxFiles {
			return newError(codeTooLarge, "archive has more than maxFiles (%d) entries", maxFiles)
		}
	}
	if _, err := io.Copy(io.Discard, gz); err != nil { // reaches and verifies the gzip trailer
		return invalidArchive(err)
	}
	return nil
}

// dirMeta is a directory whose mode and mtime are applied after extraction, so that read-only
// directories can still receive their children and creating children does not reset the mtime.
type dirMeta struct {
	path  string
	mode  fs.FileMode
	mtime time.Time
}

// unpackArchive extracts an archive that passed scanArchive under root. Before each entry is
// created, its parent directory is resolved through existing symlinks (including ones the archive
// itself created) and must still be inside root.
func unpackArchive(r io.Reader, root string) (files, size int64, err error) {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return 0, 0, fsError(err, "realpath", root)
	}
	gz, err := gzip.NewReader(r)
	if err != nil {
		return 0, 0, invalidArchive(err)
	}
	tr := tar.NewReader(gz)
	var dirs []dirMeta
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return files, size, invalidArchive(err)
		}
		name, _ := entryName(hdr.Name) // validated by scanArchive
		if name == "" {
			continue
		}
		dest := filepath.Join(realRoot, filepath.FromSlash(name))
		parent, err := resolveParent(realRoot, dest, hdr.Name)
		if err != nil {
			return files, size, err
		}
		// Operate on the resolved path, so that later entries replacing a symlink in dest's
		// parent chain cannot redirect this entry, or the deferred directory updates below.
		dest = filepath.Join(parent, filepath.Base(dest))
		mode := fs.FileMode(hdr.Mode) & fs.ModePerm
		switch hdr.Typeflag {
		case tar.TypeDir:
			err = makeDir(dest)
			dirs = append(dirs, dirMeta{path: dest, mode: mode, mtime: hdr.ModTime})
		case tar.TypeReg:
			err = writeEntryFile(dest, tr, mode, hdr.ModTime)
			size += hdr.Size
		case tar.TypeSymlink:
			if err = clearPath(dest); err == nil {
				if err = os.Symlink(hdr.Linkname, dest); err != nil { // target stored verbatim
					err = fsError(err, "symlink", dest)
				}
			}
		case tar.TypeLink:
			target := filepath.Join(realRoot, filepath.FromSlash(path.Clean(hdr.Linkname)))
			err = linkEntry(realRoot, target, dest, hdr.Name)
		}
		if err != nil {
			return files, size, err
		}
		files++
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		d := dirs[i]
		if err := os.Chmod(d.path, d.mode); err != nil {
			return files, size, fsError(err, "chmod", d.path)
		}
		if err := os.Chtimes(d.path, d.mtime, d.mtime); err != nil {
			return files, size, fsError(err, "utime", d.path)
		}
	}
	return files, size, nil
}

// resolveParent returns the real path of p's parent directory, creating missing directories. The
// existing part of the parent must resolve, through any symlinks, to a location inside root.
func resolveParent(root, p, name string) (string, error) {
	parent := filepath.Dir(p)
	existing := parent
	for {
		_, err := os.Lstat(existing)
		if err == nil {
			break
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return "", fsError(err, "lstat", existing)
		}
		existing = filepath.Dir(existing)
	}
	resolved, err := filepath.EvalSymlinks(existing)
	if err != nil || !within(root, resolved) {
		return "", invalidEntry(name, "path resolves outside the root")
	}
	rest, err := filepath.Rel(existing, parent)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(resolved, rest) // the missing part is created as real directories
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return "", fsError(err, "mkdir", dir)
	}
	return dir, nil
}

// within reports whether the clean absolute path p is root or lies beneath it.
func within(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, "../")
}

// clearPath removes a non-directory at p so that a new entry can be created in its place without
// following an existing symlink.
func clearPath(p string) error {
	fi, err := os.Lstat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fsError(err, "lstat", p)
	}
	if fi.IsDir() {
		return errnoError(syscall.EISDIR, "open", p)
	}
	if err := os.Remove(p); err != nil {
		return fsError(err, "unlink", p)
	}
	return nil
}

// makeDir ensures p is a real directory, replacing a non-directory entry.
func makeDir(p string) error {
	fi, err := os.Lstat(p)
	switch {
	case err == nil && fi.IsDir():
		return nil
	case err == nil:
		if err := os.Remove(p); err != nil {
			return fsError(err, "unlink", p)
		}
	case !errors.Is(err, fs.ErrNotExist):
		return fsError(err, "lstat", p)
	}
	if err := os.Mkdir(p, 0o777); err != nil {
		return fsError(err, "mkdir", p)
	}
	return nil
}

// writeEntryFile creates the regular file p with the contents of r. O_EXCL guarantees that the
// file is new rather than an existing symlink being followed.
func writeEntryFile(p string, r io.Reader, mode fs.FileMode, mtime time.Time) error {
	if err := clearPath(p); err != nil {
		return err
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fsError(err, "open", p)
	}
	_, err = io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fsError(err, "write", p)
	}
	if err := os.Chmod(p, mode); err != nil {
		return fsError(err, "chmod", p)
	}
	if err := os.Chtimes(p, mtime, mtime); err != nil {
		return fsError(err, "utime", p)
	}
	return nil
}

// linkEntry creates the hardlink p to target, which must resolve to an already extracted regular
// file inside root. Linking the resolved path matters on macOS, where link(2) follows symlinks.
func linkEntry(root, target, p, name string) error {
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil || !within(root, resolved) {
		return invalidEntry(name, "hardlink target resolves outside the root")
	}
	if fi, err := os.Lstat(resolved); err != nil || !fi.Mode().IsRegular() {
		return invalidEntry(name, "hardlink target is not a regular file")
	}
	if err := clearPath(p); err != nil {
		return err
	}
	if err := os.Link(resolved, p); err != nil {
		return fsError(err, "link", p)
	}
	return nil
}

type downloadBeginParams struct {
	ID       string `json:"id"`
	Root     string `json:"root"`
	MaxBytes *int64 `json:"maxBytes"`
}

func (s *Server) downloadBegin(p *downloadBeginParams) (any, error) {
	if p.ID == "" {
		return nil, badRequest("missing id")
	}
	if err := requireAbs("root", p.Root); err != nil {
		return nil, err
	}
	maxBytes, err := limitParam("maxBytes", p.MaxBytes, defaultArchiveMaxBytes)
	if err != nil {
		return nil, err
	}
	if s.downloads.has(p.ID) {
		return nil, badRequest("download '%s' is already in progress", p.ID)
	}
	realRoot, err := filepath.EvalSymlinks(p.Root)
	if err != nil {
		return nil, fsError(err, "scandir", p.Root)
	}
	if fi, err := os.Stat(realRoot); err != nil {
		return nil, fsError(err, "scandir", p.Root)
	} else if !fi.IsDir() {
		return nil, errnoError(syscall.ENOTDIR, "scandir", p.Root)
	}
	f, err := os.CreateTemp(s.cfg.Tmp, "lily-envd-download-*.tar.gz")
	if err != nil {
		return nil, fsError(err, "open", s.cfg.Tmp)
	}
	size, err := writeArchive(f, realRoot, maxBytes)
	if err == nil {
		_, err = f.Seek(0, io.SeekStart)
	}
	if err != nil {
		discard(f)
		return nil, err
	}
	if !s.downloads.add(p.ID, &download{tmpPath: f.Name(), size: size, file: f}) {
		discard(f)
		return nil, badRequest("download '%s' is already in progress", p.ID)
	}
	return struct{}{}, nil
}

// cappedWriter passes writes through to w and fails once more than limit bytes would be written.
type cappedWriter struct {
	w        io.Writer
	limit, n int64
}

func (c *cappedWriter) Write(b []byte) (int, error) {
	if c.n+int64(len(b)) > c.limit {
		return 0, newError(codeTooLarge, "archive exceeds maxBytes (%d)", c.limit)
	}
	n, err := c.w.Write(b)
	c.n += int64(n)
	return n, err
}

// writeArchive writes a tar.gz of root's contents, with names relative to root, to f and returns
// its size. Symlinks are stored as symlinks; sockets, devices, fifos and f itself are skipped, and
// entries that vanish during the walk are ignored.
func writeArchive(f *os.File, root string, maxBytes int64) (int64, error) {
	self, err := f.Stat()
	if err != nil {
		return 0, err
	}
	cw := &cappedWriter{w: f, limit: maxBytes}
	gz := gzip.NewWriter(cw)
	tw := tar.NewWriter(gz)
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p != root && errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return fsError(err, "scandir", p)
		}
		if p == root {
			return nil
		}
		info, err := d.Info()
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return fsError(err, "lstat", p)
		}
		if os.SameFile(info, self) {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		return addEntry(tw, p, filepath.ToSlash(rel), info)
	})
	if err == nil {
		err = tw.Close()
	}
	if err == nil {
		err = gz.Close()
	}
	return cw.n, err
}

// addEntry appends the file p, described by its lstat info, to tw under name. Like tar, it
// truncates mtimes to whole seconds rather than letting archive/tar round them up.
func addEntry(tw *tar.Writer, p, name string, info fs.FileInfo) error {
	hdr := &tar.Header{Name: name, Mode: int64(info.Mode().Perm()), ModTime: info.ModTime().Truncate(time.Second)}
	switch mode := info.Mode(); {
	case mode.IsRegular():
		return addFile(tw, p, hdr, info.Size())
	case mode.IsDir():
		hdr.Typeflag, hdr.Name = tar.TypeDir, name+"/"
	case mode&fs.ModeSymlink != 0:
		target, err := os.Readlink(p)
		if err != nil {
			return fsError(err, "readlink", p)
		}
		hdr.Typeflag, hdr.Linkname = tar.TypeSymlink, target
	default:
		return nil // sockets, devices and fifos
	}
	return tw.WriteHeader(hdr)
}

// addFile appends the regular file p of the given size.
func addFile(tw *tar.Writer, p string, hdr *tar.Header, size int64) error {
	f, err := os.Open(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fsError(err, "open", p)
	}
	defer f.Close()
	hdr.Typeflag, hdr.Size = tar.TypeReg, size
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	if _, err := io.CopyN(tw, f, size); err != nil {
		if errors.Is(err, io.EOF) {
			return newError(codeUnknown, "'%s' shrank while it was being archived", p)
		}
		return fsError(err, "read", p)
	}
	return nil
}

type downloadReadParams struct {
	ID     string `json:"id"`
	Length *int64 `json:"length"`
}

type downloadReadResult struct {
	Data []byte `json:"data"`
	EOF  bool   `json:"eof"`
}

func (s *Server) downloadRead(p *downloadReadParams) (any, error) {
	length := int64(defaultReadChunkBytes)
	if p.Length != nil {
		if *p.Length <= 0 {
			return nil, badRequest("length must be positive")
		}
		length = min(*p.Length, maxReadChunkBytes)
	}
	d, ok := s.downloads.get(p.ID)
	if !ok {
		return nil, unknownTransfer("download", p.ID)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.file == nil {
		return nil, unknownTransfer("download", p.ID)
	}
	buf := make([]byte, min(length, d.size-d.sent))
	if _, err := io.ReadFull(d.file, buf); err != nil {
		return nil, fsError(err, "read", d.tmpPath)
	}
	d.sent += int64(len(buf))
	eof := d.sent >= d.size
	if eof {
		s.downloads.remove(p.ID)
		discard(d.file)
		d.file = nil
	}
	return downloadReadResult{Data: buf, EOF: eof}, nil
}
