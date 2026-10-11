//go:build test_unit

package output

import (
	"runtime"
	"strings"
	"testing"
)

func TestWasapiBackendUnsupportedOffWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("wasapi is supported on Windows")
	}
	_, err := NewOutput(&NewOutputOptions{Backend: "wasapi"})
	if err == nil {
		t.Fatal("expected wasapi to be unsupported off Windows")
	}
	if !strings.Contains(err.Error(), "only supported on Windows") {
		t.Fatalf("wasapi error = %q, want only supported on Windows", err)
	}
}

func TestAlsaBackendUnsupportedOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("alsa is supported on this platform")
	}
	_, err := NewOutput(&NewOutputOptions{Backend: "alsa"})
	if err == nil {
		t.Fatal("expected alsa to be unsupported on Windows")
	}
	if !strings.Contains(err.Error(), "not supported") {
		t.Fatalf("alsa error = %q, want not supported", err)
	}
}

// Encore patch 6: on Windows the pipe backend writes to a named pipe
// (driver-pipe-windows.go, tested in driver-pipe_windows_test.go).
func TestPipeBackendWantsANamedPipeOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the pipe backend takes a FIFO on this platform")
	}
	_, err := NewOutput(&NewOutputOptions{Backend: "pipe", OutputPipe: "pcm.raw", OutputPipeFormat: "s16le"})
	if err == nil {
		t.Fatal("expected a path that is not a named pipe to be refused")
	}
	if strings.Contains(err.Error(), "not supported") || !strings.Contains(err.Error(), "named pipe") {
		t.Fatalf("pipe error = %q, want the named-pipe driver's refusal", err)
	}
}
