//go:build !linux

package main

import "errors"

var errLinuxOnly = errors.New("only supported on linux")

// vmSetup is only meaningful when envd is a Linux VM's init.
func vmSetup() error { return errors.New("--vm is only supported on linux") }

func mountReadOnly(string, string) error { return errLinuxOnly }

func bindReadOnly(string) error { return errLinuxOnly }

func limitPids(int) error { return errLinuxOnly }

// joinPidsCgroup is a no-op: cgroups are linux-only.
func joinPidsCgroup() {}

// serveVsockLoop is unavailable: AF_VSOCK is only supported on linux.
func serveVsockLoop(uint32, Config) error {
	return errors.New("--vsock-port is only supported on linux")
}
