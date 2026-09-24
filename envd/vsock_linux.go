//go:build linux

package main

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// acceptVsock listens on the AF_VSOCK port, accepts the first connection and then closes the
// listener, so that later connection attempts are refused.
func acceptVsock(port uint32) (*os.File, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("vsock socket: %w", err)
	}
	defer unix.Close(fd)
	if err := unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: port}); err != nil {
		return nil, fmt.Errorf("vsock bind port %d: %w", port, err)
	}
	if err := unix.Listen(fd, 1); err != nil {
		return nil, fmt.Errorf("vsock listen: %w", err)
	}
	for {
		conn, _, err := unix.Accept4(fd, unix.SOCK_CLOEXEC)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("vsock accept: %w", err)
		}
		return os.NewFile(uintptr(conn), fmt.Sprintf("vsock:%d", port)), nil
	}
}
