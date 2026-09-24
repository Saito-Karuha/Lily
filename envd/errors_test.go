package main

import (
	"errors"
	"os"
	"syscall"
	"testing"
)

func TestNodeMessage(t *testing.T) {
	tests := []struct {
		errno          syscall.Errno
		op, path, dest string
		want           string
	}{
		{syscall.ENOENT, "open", "/workspace/x", "", "ENOENT: no such file or directory, open '/workspace/x'"},
		{syscall.EISDIR, "read", "", "", "EISDIR: illegal operation on a directory, read"},
		{syscall.EACCES, "open", "/etc/shadow", "", "EACCES: permission denied, open '/etc/shadow'"},
		{syscall.ENOTDIR, "scandir", "/workspace/a.txt", "", "ENOTDIR: not a directory, scandir '/workspace/a.txt'"},
		{syscall.EEXIST, "mkdir", "/workspace/d", "", "EEXIST: file already exists, mkdir '/workspace/d'"},
		{syscall.EPERM, "rm", "/p", "", "EPERM: operation not permitted, rm '/p'"},
		{syscall.EINVAL, "realpath", "/p", "", "EINVAL: invalid argument, realpath '/p'"},
		{syscall.ENOENT, "rename", "/a", "/b", "ENOENT: no such file or directory, rename '/a' -> '/b'"},
		{syscall.ENOTEMPTY, "rm", "/d", "", "ENOTEMPTY: directory not empty, rm '/d'"},
	}
	for _, tt := range tests {
		if got := nodeMessage(tt.errno, tt.op, tt.path, tt.dest); got != tt.want {
			t.Errorf("nodeMessage(%v, %q, %q, %q) = %q, want %q", tt.errno, tt.op, tt.path, tt.dest, got, tt.want)
		}
	}
}

func TestErrnoCodes(t *testing.T) {
	tests := map[syscall.Errno]string{
		syscall.ENOENT:    codeNotFound,
		syscall.EACCES:    codePermissionDenied,
		syscall.EPERM:     codePermissionDenied,
		syscall.ENOTDIR:   codeNotDirectory,
		syscall.EISDIR:    codeIsDirectory,
		syscall.EEXIST:    codeExists,
		syscall.EINVAL:    codeInvalid,
		syscall.ENOTEMPTY: codeUnknown,
		syscall.EXDEV:     codeUnknown,
	}
	for errno, want := range tests {
		if got := errnoCode(errno); got != want {
			t.Errorf("errnoCode(%v) = %q, want %q", errno, got, want)
		}
	}
}

func TestFsError(t *testing.T) {
	_, err := os.Open("/nonexistent/lily-envd")
	pe := fsError(err, "open", "/nonexistent/lily-envd")
	want := protoError{Code: codeNotFound, Message: "ENOENT: no such file or directory, open '/nonexistent/lily-envd'", Path: "/nonexistent/lily-envd"}
	if *pe != want {
		t.Errorf("fsError = %+v, want %+v", *pe, want)
	}

	// read and write carry no path in the message, like Node's fd-based errors.
	pe = fsError(&os.PathError{Op: "write", Path: "/f", Err: syscall.ENOSPC}, "write", "/f")
	if pe.Message != "ENOSPC: no space left on device, write" || pe.Path != "/f" || pe.Code != codeUnknown {
		t.Errorf("write error = %+v", *pe)
	}

	pe = fsError(errors.New("boom"), "open", "/f")
	if pe.Code != codeUnknown || pe.Message != "boom" {
		t.Errorf("non-errno error = %+v", *pe)
	}

	pe = renameError(&os.LinkError{Op: "rename", Old: "/a", New: "/b", Err: syscall.EXDEV}, "/a", "/b")
	if pe.Message != "EXDEV: cross-device link not permitted, rename '/a' -> '/b'" || pe.Path != "/a" {
		t.Errorf("renameError = %+v", *pe)
	}
}
