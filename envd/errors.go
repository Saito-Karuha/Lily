package main

import (
	"errors"
	"fmt"
	"syscall"

	"golang.org/x/sys/unix"
)

// Error codes of the protocol's error model.
const (
	codeNotFound         = "not_found"
	codePermissionDenied = "permission_denied"
	codeNotDirectory     = "not_directory"
	codeIsDirectory      = "is_directory"
	codeExists           = "exists"
	codeInvalid          = "invalid"
	codeTooLarge         = "too_large"
	codeBadRequest       = "bad_request"
	codeUnknownMethod    = "unknown_method"
	codeSpawnError       = "spawn_error"
	codeShellUnavailable = "shell_unavailable"
	codeExecExists       = "exec_exists"
	codeUnknown          = "unknown"
)

// protoError is the error object ("e") of a failed response.
type protoError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Path    string `json:"path,omitempty"`
}

func (e *protoError) Error() string { return e.Message }

// newError returns a protocol error with a formatted message.
func newError(code, format string, args ...any) *protoError {
	return &protoError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// badRequest reports malformed request parameters.
func badRequest(format string, args ...any) *protoError {
	return newError(codeBadRequest, format, args...)
}

// toProtoError converts any handler error into the wire error object.
func toProtoError(err error) *protoError {
	var pe *protoError
	if errors.As(err, &pe) {
		return pe
	}
	return &protoError{Code: codeUnknown, Message: err.Error()}
}

// errnoCodes maps errno values to protocol codes; anything else is "unknown".
var errnoCodes = map[syscall.Errno]string{
	syscall.ENOENT:  codeNotFound,
	syscall.EACCES:  codePermissionDenied,
	syscall.EPERM:   codePermissionDenied,
	syscall.ENOTDIR: codeNotDirectory,
	syscall.EISDIR:  codeIsDirectory,
	syscall.EEXIST:  codeExists,
	syscall.EINVAL:  codeInvalid,
}

// errnoDescriptions are libuv's error strings, which Node.js uses in its messages.
var errnoDescriptions = map[syscall.Errno]string{
	syscall.E2BIG:        "argument list too long",
	syscall.EACCES:       "permission denied",
	syscall.EAGAIN:       "resource temporarily unavailable",
	syscall.EBADF:        "bad file descriptor",
	syscall.EBUSY:        "resource busy or locked",
	syscall.EEXIST:       "file already exists",
	syscall.EFBIG:        "file too large",
	syscall.EINVAL:       "invalid argument",
	syscall.EIO:          "i/o error",
	syscall.EISDIR:       "illegal operation on a directory",
	syscall.ELOOP:        "too many symbolic links encountered",
	syscall.EMFILE:       "too many open files",
	syscall.EMLINK:       "too many links",
	syscall.ENAMETOOLONG: "name too long",
	syscall.ENFILE:       "file table overflow",
	syscall.ENOENT:       "no such file or directory",
	syscall.ENOMEM:       "not enough memory",
	syscall.ENOSPC:       "no space left on device",
	syscall.ENOTDIR:      "not a directory",
	syscall.ENOTEMPTY:    "directory not empty",
	syscall.EPERM:        "operation not permitted",
	syscall.EROFS:        "read-only file system",
	syscall.ESPIPE:       "invalid seek",
	syscall.ETXTBSY:      "text file is busy",
	syscall.EXDEV:        "cross-device link not permitted",
}

// errnoCode returns the protocol code for errno.
func errnoCode(errno syscall.Errno) string {
	if code, ok := errnoCodes[errno]; ok {
		return code
	}
	return codeUnknown
}

// nodeMessage renders errno the way Node.js does: "<ERRNO>: <description>, <syscall>", followed by
// " '<path>'" when path is non-empty and " -> '<dest>'" when dest is non-empty.
func nodeMessage(errno syscall.Errno, op, path, dest string) string {
	name := unix.ErrnoName(errno)
	if name == "" {
		name = "UNKNOWN"
	}
	desc, ok := errnoDescriptions[errno]
	if !ok {
		desc = errno.Error()
	}
	msg := name + ": " + desc + ", " + op
	if path != "" {
		msg += " '" + path + "'"
	}
	if dest != "" {
		msg += " -> '" + dest + "'"
	}
	return msg
}

// errnoError builds the protocol error for errno raised by syscall op on path. Like Node.js, the
// message of fd-based "read" and "write" failures carries no path; the path field is always set.
func errnoError(errno syscall.Errno, op, path string) *protoError {
	msgPath := path
	if op == "read" || op == "write" {
		msgPath = ""
	}
	return &protoError{Code: errnoCode(errno), Message: nodeMessage(errno, op, msgPath, ""), Path: path}
}

// fsError converts the error of a filesystem call into a protocol error. Errors that carry no errno
// keep their Go message and map to "unknown".
func fsError(err error, op, path string) *protoError {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return &protoError{Code: codeUnknown, Message: err.Error(), Path: path}
	}
	return errnoError(errno, op, path)
}

// renameError converts a rename failure, using Node's two-path form "rename '<from>' -> '<to>'".
func renameError(err error, from, to string) *protoError {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return &protoError{Code: codeUnknown, Message: err.Error(), Path: from}
	}
	return &protoError{Code: errnoCode(errno), Message: nodeMessage(errno, "rename", from, to), Path: from}
}
