//go:build unix

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadEnvFile(t *testing.T) { // not parallel: changes the process environment
	path := filepath.Join(t.TempDir(), "image.env")
	if err := os.WriteFile(path, []byte("# image ENV\nLILY_T_A=1\n\nLILY_T_B=x=y\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Unsetenv("LILY_T_A"); os.Unsetenv("LILY_T_B") })
	if err := loadEnvFile(path); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("LILY_T_A") != "1" || os.Getenv("LILY_T_B") != "x=y" {
		t.Errorf("env = %q %q", os.Getenv("LILY_T_A"), os.Getenv("LILY_T_B"))
	}
	if err := os.WriteFile(path, []byte("novalue\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := loadEnvFile(path); err == nil {
		t.Error("malformed line accepted")
	}
}
