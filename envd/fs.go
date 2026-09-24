package main

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// maxReadBytes is the default and maximum length of one fs.read.
const maxReadBytes = 8 << 20

type pathParams struct {
	Path string `json:"path"`
}

// fileInfo is the stat object of fs.stat and fs.list.
type fileInfo struct {
	Name    string  `json:"name"`
	Path    string  `json:"path"`
	Kind    string  `json:"kind"`
	Size    int64   `json:"size"`
	MtimeMs float64 `json:"mtimeMs"`
	Mode    uint32  `json:"mode"`
}

// newFileInfo describes the lstat result fi of path.
func newFileInfo(path string, fi fs.FileInfo) fileInfo {
	kind := "other"
	switch mode := fi.Mode(); {
	case mode.IsRegular():
		kind = "file"
	case mode.IsDir():
		kind = "directory"
	case mode&fs.ModeSymlink != 0:
		kind = "symlink"
	}
	name := filepath.Base(path)
	if name == "/" {
		name = "" // Node's basename("/")
	}
	return fileInfo{
		Name:    name,
		Path:    path,
		Kind:    kind,
		Size:    fi.Size(),
		MtimeMs: float64(fi.ModTime().UnixNano()) / 1e6,
		Mode:    uint32(fi.Mode().Perm()),
	}
}

func (s *Server) fsStat(p *pathParams) (any, error) {
	if err := requireAbs("path", p.Path); err != nil {
		return nil, err
	}
	fi, err := os.Lstat(p.Path)
	if err != nil {
		return nil, fsError(err, "lstat", p.Path)
	}
	return newFileInfo(p.Path, fi), nil
}

type readParams struct {
	Path   string `json:"path"`
	Offset *int64 `json:"offset"`
	Length *int64 `json:"length"`
}

type readResult struct {
	Data []byte `json:"data"`
	Size int64  `json:"size"`
	EOF  bool   `json:"eof"`
}

func (s *Server) fsRead(p *readParams) (any, error) {
	if err := requireAbs("path", p.Path); err != nil {
		return nil, err
	}
	offset, err := limitParam("offset", p.Offset, 0)
	if err != nil {
		return nil, err
	}
	length, err := limitParam("length", p.Length, maxReadBytes)
	if err != nil {
		return nil, err
	}
	length = min(length, maxReadBytes)

	f, err := os.Open(p.Path)
	if err != nil {
		return nil, fsError(err, "open", p.Path)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, fsError(err, "fstat", p.Path)
	}
	if fi.IsDir() {
		return nil, errnoError(syscall.EISDIR, "read", p.Path)
	}
	if offset > 0 {
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			return nil, fsError(err, "read", p.Path)
		}
	}
	// Size the buffer from the reported size, but keep reading past it: files such as those in
	// /proc report a size of 0.
	var buf bytes.Buffer
	buf.Grow(int(min(length, max(fi.Size()-offset, 0))) + bytes.MinRead)
	if _, err := buf.ReadFrom(io.LimitReader(f, length)); err != nil {
		return nil, fsError(err, "read", p.Path)
	}
	return readResult{Data: buf.Bytes(), Size: fi.Size(), EOF: offset+int64(buf.Len()) >= fi.Size()}, nil
}

type writeParams struct {
	Path   string  `json:"path"`
	Data   []byte  `json:"data"`
	Append bool    `json:"append"`
	Mkdirs *bool   `json:"mkdirs"`
	Mode   *uint32 `json:"mode"`
}

func (s *Server) fsWrite(p *writeParams) (any, error) {
	if err := requireAbs("path", p.Path); err != nil {
		return nil, err
	}
	if p.Data == nil {
		return nil, badRequest("missing data")
	}
	mode := uint32(0o644)
	if p.Mode != nil {
		if *p.Mode > 0o777 {
			return nil, badRequest("mode must be permission bits (0 to 0o777)")
		}
		mode = *p.Mode
	}
	if p.Mkdirs == nil || *p.Mkdirs {
		if err := mkdirAll(filepath.Dir(p.Path)); err != nil {
			return nil, err
		}
	}
	flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	if p.Append {
		flags = os.O_WRONLY | os.O_CREATE | os.O_APPEND
	}
	f, err := os.OpenFile(p.Path, flags, os.FileMode(mode))
	if err != nil {
		return nil, fsError(err, "open", p.Path)
	}
	_, err = f.Write(p.Data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, fsError(err, "write", p.Path)
	}
	return map[string]int{"bytes": len(p.Data)}, nil
}

func (s *Server) fsList(p *pathParams) (any, error) {
	if err := requireAbs("path", p.Path); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(p.Path) // sorted by name
	if err != nil {
		return nil, fsError(err, "scandir", p.Path)
	}
	infos := make([]fileInfo, 0, len(entries))
	for _, e := range entries {
		full := filepath.Join(p.Path, e.Name())
		fi, err := os.Lstat(full)
		if errors.Is(err, fs.ErrNotExist) {
			continue // removed since the directory was read
		}
		if err != nil {
			return nil, fsError(err, "lstat", full)
		}
		infos = append(infos, newFileInfo(full, fi))
	}
	return map[string][]fileInfo{"entries": infos}, nil
}

func (s *Server) fsRealpath(p *pathParams) (any, error) {
	if err := requireAbs("path", p.Path); err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(p.Path)
	if err != nil {
		return nil, fsError(err, "realpath", p.Path)
	}
	return map[string]string{"path": resolved}, nil
}

type mkdirParams struct {
	Path      string `json:"path"`
	Recursive *bool  `json:"recursive"`
}

func (s *Server) fsMkdir(p *mkdirParams) (any, error) {
	if err := requireAbs("path", p.Path); err != nil {
		return nil, err
	}
	if p.Recursive == nil || *p.Recursive {
		if err := mkdirAll(p.Path); err != nil {
			return nil, err
		}
	} else if err := os.Mkdir(p.Path, 0o777); err != nil {
		return nil, fsError(err, "mkdir", p.Path)
	}
	return struct{}{}, nil
}

// mkdirAll creates path and any missing parents, failing like Node's mkdir({recursive: true}):
// an existing non-directory at path is EEXIST.
func mkdirAll(path string) error {
	err := os.MkdirAll(path, 0o777)
	if err == nil {
		return nil
	}
	if fi, serr := os.Stat(path); serr == nil && !fi.IsDir() {
		return errnoError(syscall.EEXIST, "mkdir", path)
	}
	return fsError(err, "mkdir", path)
}

type removeParams struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive"`
	Force     bool   `json:"force"`
}

func (s *Server) fsRemove(p *removeParams) (any, error) {
	if err := requireAbs("path", p.Path); err != nil {
		return nil, err
	}
	fi, err := os.Lstat(p.Path)
	if err != nil {
		if p.Force && errors.Is(err, fs.ErrNotExist) {
			return struct{}{}, nil
		}
		return nil, fsError(err, "rm", p.Path)
	}
	switch {
	case !fi.IsDir():
		err = os.Remove(p.Path)
	case p.Recursive:
		err = os.RemoveAll(p.Path)
	default:
		return nil, errnoError(syscall.EISDIR, "rm", p.Path)
	}
	if err != nil {
		return nil, fsError(err, "rm", p.Path)
	}
	return struct{}{}, nil
}

type renameParams struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func (s *Server) fsRename(p *renameParams) (any, error) {
	if err := requireAbs("from", p.From); err != nil {
		return nil, err
	}
	if err := requireAbs("to", p.To); err != nil {
		return nil, err
	}
	// unix.Rename rather than os.Rename: POSIX semantics, e.g. replacing an empty directory.
	if err := unix.Rename(p.From, p.To); err != nil {
		return nil, renameError(err, p.From, p.To)
	}
	return struct{}{}, nil
}

type mktempParams struct {
	Prefix *string `json:"prefix"`
	Suffix string  `json:"suffix"`
	Dir    bool    `json:"dir"`
}

func (s *Server) fsMktemp(p *mktempParams) (any, error) {
	prefix := "tmp-"
	if p.Prefix != nil {
		prefix = *p.Prefix
	}
	if strings.ContainsRune(prefix+p.Suffix, '/') {
		return nil, badRequest("prefix and suffix must not contain '/'")
	}
	pattern := prefix + "*" + p.Suffix
	if p.Dir {
		path, err := os.MkdirTemp(s.cfg.Tmp, pattern)
		if err != nil {
			return nil, fsError(err, "mkdtemp", filepath.Join(s.cfg.Tmp, prefix+"XXXXXX"))
		}
		return map[string]string{"path": path}, nil
	}
	f, err := os.CreateTemp(s.cfg.Tmp, pattern)
	if err != nil {
		return nil, fsError(err, "open", filepath.Join(s.cfg.Tmp, pattern))
	}
	f.Close()
	return map[string]string{"path": f.Name()}, nil
}
