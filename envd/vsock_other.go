//go:build !linux

package main

import (
	"errors"
	"os"
)

// acceptVsock is unavailable: AF_VSOCK is only supported on linux.
func acceptVsock(uint32) (*os.File, error) {
	return nil, errors.New("--vsock-port is only supported on linux")
}
