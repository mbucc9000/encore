//go:build windows

package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/windows"

	"encore-bridge/launcher/internal/core"
)

// bridge runs node.exe (the Encore Bridge gateway) and keeps it running: restarts with backoff after a crash, stops
// on a port problem until the user fixes it, and stops it gracefully on quit (stdin "quit", then the loopback route,
// then ending the job). CONTRACT.md §1-§3.
type bridge struct {
	layout   core.Layout
	log      *core.RotatingLog
	job      *job
	onChange func() // state changed: re-render the tray

	mu         sync.Mutex
	state      string
	failReason string
	exitCode   int // shown with a failure
	lastExit   int // the last node.exe exit code
	port       int
	cl         *client
	stdin      *os.File
	exited     chan struct{} // closed when the current node.exe has exited
	startedAt  time.Time
	stopReq    bool
	restartReq bool

	wake     chan struct{}
	stopCh   chan struct{}
	stopOnce sync.Once
	loopDone chan struct{}
	restart  *core.Restarter
}

func newBridge(layout core.Layout, lg *core.RotatingLog, j *job, onChange func()) *bridge {
	return &bridge{
		layout: layout, log: lg, job: j, onChange: onChange,
		state: core.StateStarting, port: 8095,
		wake: make(chan struct{}, 1), stopCh: make(chan struct{}), loopDone: make(chan struct{}),
		restart: core.NewRestarter(),
	}
}

// snapshot returns what the tray needs.
func (b *bridge) snapshot() (state, failReason string, exitCode, port int, cl *client) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.state, b.failReason, b.exitCode, b.port, b.cl
}

func (b *bridge) setState(state, reason string, code int) {
	b.mu.Lock()
	b.state, b.failReason, b.exitCode = state, reason, code
	b.mu.Unlock()
	if b.onChange != nil {
		b.onChange()
	}
}

func (b *bridge) stopping() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.stopReq
}

// run is the supervision loop; it returns after stop.
func (b *bridge) run() {
	defer close(b.loopDone)
	for !b.stopping() {
		b.mu.Lock()
		b.restartReq = false
		b.mu.Unlock()
		select { // a Restart that arrived while the bridge was running has been handled by this new start
		case <-b.wake:
		default:
		}
		b.setState(core.StateStarting, "", 0)
		exited, err := b.start()
		if err != nil {
			b.log.Launcher("E", "couldn't start the bridge: %v", err)
			b.setState(core.StateFailed, core.FailStart, 0)
			if !b.waitWake(0) {
				break
			}
			continue
		}
		b.setState(core.StateRunning, "", 0)
		<-exited
		b.job.killAll() // anything node.exe left behind (an engine that ignored it, a stuck ffmpeg)

		b.mu.Lock()
		uptime := time.Since(b.startedAt)
		code := b.lastExit
		restartReq := b.restartReq
		if b.stdin != nil {
			b.stdin.Close()
			b.stdin = nil
		}
		b.mu.Unlock()

		if b.stopping() {
			b.log.Launcher("I", "bridge stopped")
			break
		}
		if restartReq {
			b.log.Launcher("I", "bridge stopped for a restart")
			b.restart.Reset()
			continue
		}
		if code == core.ExitPortInUse || code == core.ExitPortDenied || code == core.ExitSettings {
			b.log.Launcher("W", "bridge stopped with exit code %d; waiting for Restart bridge", code)
			b.setState(core.StateFailed, core.FailExit, code)
			if !b.waitWake(0) {
				break
			}
			b.restart.Reset()
			continue
		}
		delay, giveUp := b.restart.After(uptime)
		if giveUp {
			b.log.Launcher("E", "bridge keeps stopping right after it starts (exit code %d); waiting for Restart bridge", code)
			b.setState(core.StateFailed, core.FailCrashLoop, code)
			if !b.waitWake(0) {
				break
			}
			b.restart.Reset()
			continue
		}
		b.log.Launcher("W", "bridge stopped unexpectedly (exit code %d after %s); restarting in %s", code, uptime.Round(time.Second), delay)
		b.setState(core.StateStarting, "", 0)
		if !b.waitWake(delay) {
			break
		}
	}
	b.setState(core.StateStopped, "", 0)
}

// waitWake waits for d (0: until woken) or a Restart; false when stopping.
func (b *bridge) waitWake(d time.Duration) bool {
	var timer <-chan time.Time
	if d > 0 {
		t := time.NewTimer(d)
		defer t.Stop()
		timer = t.C
	}
	select {
	case <-b.stopCh:
		return false
	case <-b.wake:
		return !b.stopping()
	case <-timer:
		return !b.stopping()
	}
}

// start launches node.exe suspended, puts it in the job, then lets it run.
func (b *bridge) start() (chan struct{}, error) {
	settings, err := core.LoadSettings(b.layout.Settings())
	if err != nil {
		b.log.Launcher("W", "couldn't read settings.env (%v); using defaults", err)
	}
	for _, w := range settings.Warnings {
		b.log.Launcher("W", "settings.env %s", w)
	}
	port, invalid := core.Port(os.LookupEnv, settings)
	if invalid {
		b.log.Launcher("W", "settings.env: PORT isn't a port number; the bridge will report it (the tray assumes %d)", port)
	}
	token, err := randomToken()
	if err != nil {
		return nil, err
	}

	inR, inW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		inR.Close()
		inW.Close()
		return nil, err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		inR.Close()
		inW.Close()
		outR.Close()
		outW.Close()
		return nil, err
	}

	cmd := exec.Command(b.layout.Node(), b.layout.MainJS())
	cmd.Dir = b.layout.GatewayDir()
	cmd.Env = core.ChildEnv(os.Environ(), settings, b.layout, token)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = inR, outW, errW
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NO_WINDOW | windows.CREATE_SUSPENDED,
	}
	err = cmd.Start()
	inR.Close()
	outW.Close()
	errW.Close()
	if err != nil {
		inW.Close()
		outR.Close()
		errR.Close()
		return nil, err
	}
	pid := uint32(cmd.Process.Pid)
	if err := b.job.adopt(pid); err != nil {
		b.log.Launcher("W", "couldn't put the bridge in the launcher's job (%v); it may outlive the launcher", err)
	}
	if err := resumeProcess(pid); err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		inW.Close()
		outR.Close()
		errR.Close()
		return nil, err
	}

	exited := make(chan struct{})
	b.mu.Lock()
	b.port, b.cl, b.stdin, b.exited, b.startedAt, b.lastExit = port, newClient(port, token), inW, exited, time.Now(), 0
	b.mu.Unlock()
	b.log.Launcher("I", "bridge started (pid %d, port %d)", pid, port)

	var pumps sync.WaitGroup
	for _, r := range []*os.File{outR, errR} {
		pumps.Add(1)
		go func(r *os.File) {
			defer pumps.Done()
			core.PumpLines(r, 16<<10, b.log.Line)
			r.Close()
		}(r)
	}
	go func() {
		err := cmd.Wait()
		code := 0
		if cmd.ProcessState != nil {
			code = cmd.ProcessState.ExitCode()
		} else if err != nil {
			code = -1
		}
		// give the log pumps a moment to drain the last lines (a straggler holding the pipe must not block us)
		done := make(chan struct{})
		go func() { pumps.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
		b.mu.Lock()
		b.lastExit = code
		b.mu.Unlock()
		b.log.Launcher("I", "bridge exited with code %d", code)
		close(exited)
	}()
	return exited, nil
}

// sendQuit writes the stdin quit line (CONTRACT.md §2).
func (b *bridge) sendQuit() {
	b.mu.Lock()
	w := b.stdin
	b.mu.Unlock()
	if w != nil {
		w.Write([]byte("quit\n"))
	}
}

func (b *bridge) current() (exited chan struct{}, cl *client) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.exited, b.cl
}

// stopProcess ends the running node.exe: stdin quit, then the shutdown route, then the job. graceful is the time
// the bridge gets for the first two steps together.
func (b *bridge) stopProcess(graceful time.Duration) {
	exited, cl := b.current()
	if exited == nil || isClosed(exited) {
		return
	}
	b.sendQuit()
	if waitClosed(exited, graceful*2/3) {
		return
	}
	if cl != nil {
		if err := cl.shutdown(); err != nil {
			b.log.Launcher("W", "the bridge didn't stop after the quit line; shutdown route: %v", err)
		}
	}
	if waitClosed(exited, graceful/3) {
		return
	}
	b.log.Launcher("W", "the bridge didn't stop in time; ending it")
	b.job.killAll()
	waitClosed(exited, 3*time.Second)
}

// Restart stops the bridge and starts it again at once (re-reading settings.env), or retries a failed start.
func (b *bridge) Restart() {
	b.mu.Lock()
	b.restartReq = true
	b.mu.Unlock()
	select {
	case b.wake <- struct{}{}:
	default:
	}
	b.stopProcess(12 * time.Second)
}

// Stop stops the bridge for good and waits for the supervision loop to end.
func (b *bridge) Stop(graceful time.Duration) {
	b.mu.Lock()
	b.stopReq = true
	b.mu.Unlock()
	b.stopOnce.Do(func() { close(b.stopCh) })
	b.setState(core.StateStopping, "", 0)
	b.stopProcess(graceful)
	select {
	case <-b.loopDone:
	case <-time.After(2 * time.Second):
	}
}

func randomToken() (string, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", errors.New("no random numbers: " + err.Error())
	}
	return hex.EncodeToString(buf[:]), nil
}

func isClosed(ch chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func waitClosed(ch chan struct{}, d time.Duration) bool {
	if d <= 0 {
		return isClosed(ch)
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ch:
		return true
	case <-t.C:
		return false
	}
}
