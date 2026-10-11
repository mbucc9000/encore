//go:build windows

package output

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/windows"
)

// Encore patch 6: on Windows the pipe backend is the client end of a named
// pipe that another process serves (the Encore Bridge). It shares pipeOutput,
// the transform and outputLoop with the Unix driver; only the open differs.

// windowsPipePrefix is the namespace of local named pipes. Remote pipes
// (\\server\pipe\...) are refused: the stream would cross the network.
const windowsPipePrefix = `\\.\pipe\`

var (
	// pipeBusyTimeout is how long an open keeps retrying a pipe whose
	// instances are all connected before it gives up. The server normally
	// offers a new instance at once.
	pipeBusyTimeout = 2 * time.Second

	// pipeRetryInterval is the wait between two attempts to open.
	pipeRetryInterval = 10 * time.Millisecond
)

func isNamedPipePath(path string) bool {
	return len(path) > len(windowsPipePrefix) &&
		strings.EqualFold(path[:len(windowsPipePrefix)], windowsPipePrefix)
}

func newPipeOutput(opts *NewOutputOptions) (out *pipeOutput, err error) {
	out = &pipeOutput{
		reader:         opts.Reader,
		volume:         opts.InitialVolume,
		err:            make(chan error, 2),
		externalVolume: opts.ExternalVolume,
		volumeUpdate:   opts.VolumeUpdate,
	}

	out.cond = sync.NewCond(&out.lock)

	out.transform, err = newPipeTransform(opts.OutputPipeFormat)
	if err != nil {
		return nil, err
	}

	out.file, err = openNamedPipe(opts.OutputPipe, opts.OutputPipeWaitForReader)
	if err != nil {
		return nil, fmt.Errorf("failed to open pipe: %w", err)
	}

	go out.outputLoop()

	return out, nil
}

// openNamedPipe opens the client end of a named pipe for writing.
//
// A plain open gives a synchronous handle, so a write blocks while the pipe is
// full: the reader holds the decoder back, as with a FIFO on Unix. Without a
// server the open fails (ERROR_FILE_NOT_FOUND), as the non-blocking open of a
// FIFO without a reader does, unless waitForReader is set: then it waits for
// a server to appear, as the blocking open of a FIFO waits for a reader. When
// every instance of the pipe is connected (ERROR_PIPE_BUSY) it retries for
// pipeBusyTimeout, or for as long as it takes with waitForReader.
func openNamedPipe(path string, waitForReader bool) (*os.File, error) {
	if !isNamedPipePath(path) {
		return nil, fmt.Errorf("on Windows the output pipe must be a local named pipe (%s<name>), not %q", windowsPipePrefix, path)
	}

	var busySince time.Time
	for {
		file, err := os.OpenFile(path, os.O_WRONLY, 0)
		if err == nil {
			return file, nil
		}

		switch {
		case errors.Is(err, windows.ERROR_PIPE_BUSY):
			if busySince.IsZero() {
				busySince = time.Now()
			} else if !waitForReader && time.Since(busySince) >= pipeBusyTimeout {
				return nil, err
			}
		case waitForReader && errors.Is(err, windows.ERROR_FILE_NOT_FOUND):
			busySince = time.Time{}
		default:
			return nil, err
		}

		time.Sleep(pipeRetryInterval)
	}
}
