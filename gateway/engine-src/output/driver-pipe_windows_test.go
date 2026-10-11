//go:build test_unit && windows

package output

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// eofReader is a Float32Reader that reports end of stream, so the pipe output
// loop goes idle and blocks on the cond var instead of writing.
type eofReader struct{}

func (eofReader) Read([]float32) (int, error) {
	return 0, io.EOF
}

// toneReader never runs out, so the output loop writes for as long as the pipe
// takes it.
type toneReader struct{}

func (toneReader) Read(p []float32) (int, error) {
	for i := range p {
		p[i] = 0.25
	}
	return len(p), nil
}

func pipeOutputOptions(path string, waitForReader bool) *NewOutputOptions {
	return &NewOutputOptions{
		Reader:                  eofReader{},
		OutputPipe:              path,
		OutputPipeFormat:        "s16le",
		OutputPipeWaitForReader: waitForReader,
	}
}

var pipeSeq atomic.Int64

// pipeName returns a pipe name that no other test or process uses.
func pipeName() string {
	return fmt.Sprintf(`\\.\pipe\encore-output-test-%d-%d`, os.Getpid(), pipeSeq.Add(1))
}

// servePipe creates one instance of the server end of a named pipe, as the
// bridge serves it: inbound, byte mode, blocking writes. inSize is the
// pipe's buffer quota.
func servePipe(t *testing.T, name string, maxInstances, inSize uint32) *os.File {
	t.Helper()

	name16, err := windows.UTF16PtrFromString(name)
	if err != nil {
		t.Fatalf("pipe name: %v", err)
	}

	h, err := windows.CreateNamedPipe(name16, windows.PIPE_ACCESS_INBOUND,
		windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT,
		maxInstances, 0, inSize, 0, nil)
	if err != nil {
		t.Fatalf("CreateNamedPipe: %v", err)
	}

	server := os.NewFile(uintptr(h), name)
	t.Cleanup(func() { _ = server.Close() })
	return server
}

// drain reads the server end until the client closes it. The channel closes
// then.
func drain(server *os.File) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, server)
		close(done)
	}()
	return done
}

func waitClosed(t *testing.T, done <-chan struct{}, what string) {
	t.Helper()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func TestPipeOutputFailsWithoutReader(t *testing.T) {
	start := time.Now()
	out, err := newPipeOutput(pipeOutputOptions(pipeName(), false))
	if err == nil {
		out.Close()
		t.Fatal("expected an error opening a pipe that nobody serves")
	}
	if !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
		t.Errorf("error = %v, want ERROR_FILE_NOT_FOUND", err)
	}
	if took := time.Since(start); took > time.Second {
		t.Errorf("failing took %v, want at once", took)
	}
}

func TestPipeOutputRefusesPathsThatAreNotLocalPipes(t *testing.T) {
	file := filepath.Join(t.TempDir(), "out.pcm")

	for _, path := range []string{"", file, `\\.\pipe\`, `\\example.invalid\pipe\encore`, `C:\pipe\encore`} {
		out, err := newPipeOutput(pipeOutputOptions(path, false))
		if err == nil {
			out.Close()
			t.Errorf("%q: expected an error", path)
		}
	}

	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Errorf("a file was created at %s (stat: %v)", file, err)
	}
}

func TestPipeOutputAcceptsAnyCaseOfThePrefix(t *testing.T) {
	name := pipeName()
	server := servePipe(t, name, 1, 4096)

	out, err := newPipeOutput(pipeOutputOptions(`\\.\PIPE\`+name[len(`\\.\pipe\`):], false))
	if err != nil {
		t.Fatalf("newPipeOutput returned error: %v", err)
	}

	done := drain(server)
	_ = out.Close()
	waitClosed(t, done, "the client end to close")
}

func TestPipeOutputWaitsForReader(t *testing.T) {
	name := pipeName()

	result := make(chan *pipeOutput, 1)
	errCh := make(chan error, 1)
	go func() {
		out, err := newPipeOutput(pipeOutputOptions(name, true))
		if err != nil {
			errCh <- err
			return
		}
		result <- out
	}()

	// The open must wait for a server instead of failing.
	select {
	case out := <-result:
		out.Close()
		t.Fatal("expected newPipeOutput to wait for a server")
	case err := <-errCh:
		t.Fatalf("newPipeOutput returned error: %v", err)
	case <-time.After(100 * time.Millisecond):
	}

	// Serve the pipe: the pending open should now complete.
	server := servePipe(t, name, 1, 4096)

	var out *pipeOutput
	select {
	case out = <-result:
	case err := <-errCh:
		t.Fatalf("newPipeOutput returned error: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for newPipeOutput to open the pipe")
	}

	done := drain(server)
	_ = out.Close()
	waitClosed(t, done, "the client end to close")
}

// With every instance connected the open retries until the server offers
// another one.
func TestPipeOutputWaitsForABusyPipe(t *testing.T) {
	name := pipeName()
	first := servePipe(t, name, 2, 4096)

	other, err := os.OpenFile(name, os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("connecting the first client: %v", err)
	}
	defer other.Close()

	result := make(chan *pipeOutput, 1)
	errCh := make(chan error, 1)
	go func() {
		out, err := newPipeOutput(pipeOutputOptions(name, false))
		if err != nil {
			errCh <- err
			return
		}
		result <- out
	}()

	select {
	case out := <-result:
		out.Close()
		t.Fatal("expected newPipeOutput to wait while the only instance is connected")
	case err := <-errCh:
		t.Fatalf("newPipeOutput returned error: %v", err)
	case <-time.After(100 * time.Millisecond):
	}

	second := servePipe(t, name, 2, 4096)

	var out *pipeOutput
	select {
	case out = <-result:
	case err := <-errCh:
		t.Fatalf("newPipeOutput returned error: %v", err)
	case <-time.After(pipeBusyTimeout):
		t.Fatal("timed out waiting for newPipeOutput to take the new instance")
	}

	done := drain(second)
	_ = out.Close()
	waitClosed(t, done, "the client end to close")

	firstDone := drain(first)
	_ = other.Close()
	waitClosed(t, firstDone, "the first client to close")
}

func TestPipeOutputGivesUpOnABusyPipe(t *testing.T) {
	old := pipeBusyTimeout
	pipeBusyTimeout = 200 * time.Millisecond
	t.Cleanup(func() { pipeBusyTimeout = old })

	name := pipeName()
	server := servePipe(t, name, 1, 4096)

	other, err := os.OpenFile(name, os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("connecting the first client: %v", err)
	}

	start := time.Now()
	out, err := newPipeOutput(pipeOutputOptions(name, false))
	took := time.Since(start)
	if err == nil {
		out.Close()
		t.Fatal("expected an error while the only instance stays connected")
	}
	if !errors.Is(err, windows.ERROR_PIPE_BUSY) {
		t.Errorf("error = %v, want ERROR_PIPE_BUSY", err)
	}
	if took < pipeBusyTimeout || took > 5*pipeBusyTimeout {
		t.Errorf("gave up after %v, want about %v", took, pipeBusyTimeout)
	}

	done := drain(server)
	_ = other.Close()
	waitClosed(t, done, "the first client to close")
}

// The samples reach the reader as the transform wrote them, from the first
// byte on.
func TestPipeOutputWritesTheStream(t *testing.T) {
	name := pipeName()
	server := servePipe(t, name, 1, 64*1024)

	opts := pipeOutputOptions(name, false)
	opts.Reader = toneReader{}
	opts.InitialVolume = 1
	out, err := newPipeOutput(opts)
	if err != nil {
		t.Fatalf("newPipeOutput returned error: %v", err)
	}

	buf := make([]byte, 64*1024)
	if _, err := io.ReadFull(server, buf); err != nil {
		t.Fatalf("reading the pipe: %v", err)
	}

	want := int16(0.25 * 32768)
	for i := 0; i < len(buf); i += 2 {
		if got := int16(binary.LittleEndian.Uint16(buf[i:])); got != want {
			t.Fatalf("sample at byte %d = %d, want %d", i, got, want)
		}
	}

	_ = out.Close()
	waitClosed(t, drain(server), "the output loop to close the client end")
}

// A reader that stops reading leaves the pipe full and the output loop blocked
// in its write. Pause, Resume and Close must not wait for that write: the
// player calls them from its command loop. (The Windows twin of the Unix test.)
func TestPipeOutputControlsDoNotWaitForAFullPipe(t *testing.T) {
	name := pipeName()
	server := servePipe(t, name, 1, 4096)

	opts := pipeOutputOptions(name, false)
	opts.Reader = toneReader{}
	out, err := newPipeOutput(opts)
	if err != nil {
		t.Fatalf("newPipeOutput returned error: %v", err)
	}

	// Nothing reads, so the pipe fills up at once and the write blocks.
	time.Sleep(100 * time.Millisecond)
	out.lock.Lock()
	writing := out.writing
	out.lock.Unlock()
	if !writing {
		t.Fatal("the output loop is not blocked in a write: the test proves nothing")
	}

	done := make(chan struct{})
	go func() {
		_ = out.Pause()
		_ = out.Resume()
		_ = out.Close()
		close(done)
	}()

	waited := false
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		waited = true
	}

	// Draining the pipe completes the write, and the loop stops and closes
	// the client end.
	drained := drain(server)
	if waited {
		t.Fatal("Pause, Resume and Close waited for the blocked write")
	}

	select {
	case err := <-out.Error():
		t.Fatalf("closing during a write was reported as an error: %v", err)
	case <-time.After(200 * time.Millisecond):
	}

	waitClosed(t, drained, "the output loop to close the client end")
}

// A reader that goes away fails the blocked write, and the output reports it,
// as a FIFO's EPIPE does on Unix.
func TestPipeOutputReportsAReaderThatGoesAway(t *testing.T) {
	name := pipeName()
	server := servePipe(t, name, 1, 4096)

	opts := pipeOutputOptions(name, false)
	opts.Reader = toneReader{}
	out, err := newPipeOutput(opts)
	if err != nil {
		t.Fatalf("newPipeOutput returned error: %v", err)
	}
	defer out.Close()

	time.Sleep(100 * time.Millisecond)
	_ = server.Close()

	select {
	case err := <-out.Error():
		if err == nil {
			t.Fatal("got a nil error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the output did not report the reader going away")
	}
}
