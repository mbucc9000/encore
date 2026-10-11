//go:build windows

package main

import (
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"fyne.io/systray"

	"encore-bridge/launcher/internal/core"
)

var (
	//go:embed assets/tray.ico
	iconOK []byte
	//go:embed assets/tray-attention.ico
	iconAttention []byte
	//go:embed assets/tray-off.ico
	iconOff []byte
)

// app ties the bridge process, the status poller and the tray menu together.
type app struct {
	layout          core.Layout
	exe             string
	log             *core.RotatingLog
	autostart       bool
	settingsCreated bool

	job    *job
	bridge *bridge
	awake  *keepAwake
	upd    *updater

	updated, updateFailed bool // started by Setup with --updated / --update-failed

	prefsMu sync.Mutex
	prefs   core.Prefs

	mu          sync.Mutex // guards the fields below and serialises tray updates
	status      *core.Status
	unsupported bool
	view        core.View
	icon        string
	menu        *trayMenu
	adminOpened bool
	shownFail   string

	pollNow  chan struct{}
	done     chan struct{}
	quitOnce sync.Once
	quitting atomic.Bool
	busy     sync.Map // action name → true while its dialog is open
}

func newApp(layout core.Layout, exe string, lg *core.RotatingLog, autostart, settingsCreated bool) (*app, error) {
	j, err := newJob()
	if err != nil {
		return nil, fmt.Errorf("job object: %w", err)
	}
	a := &app{
		layout: layout, exe: exe, log: lg, autostart: autostart, settingsCreated: settingsCreated,
		job: j, awake: newKeepAwake(), prefs: core.LoadPrefs(layout.PrefsFile()),
		pollNow: make(chan struct{}, 1), done: make(chan struct{}),
	}
	a.bridge = newBridge(layout, lg, j, a.kick)
	a.upd = newUpdater(a)
	return a, nil
}

// run shows the tray and blocks until quit.
func (a *app) run() {
	systray.Run(a.onReady, a.onExit)
}

func (a *app) onReady() {
	systray.SetIcon(iconOff)
	systray.SetTooltip("Encore Bridge: starting…")
	a.mu.Lock()
	a.icon = core.IconOff
	a.menu = buildMenu(a)
	a.mu.Unlock()
	a.spawn("menu", func() { a.menu.loop(a) })
	a.spawn("bridge", a.bridge.run)
	a.spawn("status", a.pollLoop)
	a.spawn("throttle", a.throttleLoop)
	a.upd.start(a.updated, a.updateFailed)
}

// onExit runs when the tray goes away: after quit, or when Windows ends the session (then quickly).
func (a *app) onExit() {
	sessionEnd := !a.quitting.Swap(true)
	if sessionEnd {
		a.log.Launcher("I", "Windows is ending the session: stopping the bridge")
		a.bridge.Stop(3 * time.Second)
	}
	a.awake.Set(false)
	a.upd.shutdown()
	select {
	case <-a.done:
	default:
		close(a.done)
	}
	if sessionEnd {
		// the tray icon is gone either way; don't linger without it if the shutdown is cancelled
		a.log.Launcher("I", "launcher stopped (session end)")
		a.log.Close()
		os.Exit(0)
	}
}

// quit stops the bridge gracefully, then removes the tray icon (which ends run()).
func (a *app) quit() {
	a.quitOnce.Do(func() {
		a.quitting.Store(true)
		if v := a.upd.onQuit(); v != "" {
			a.log.Launcher("I", "quit requested (update to %s)", v) // Setup is replacing this launcher
		} else {
			a.log.Launcher("I", "quit requested")
		}
		a.bridge.Stop(12 * time.Second)
		a.awake.Set(false)
		systray.Quit()
	})
}

// kick asks the poller to refresh now.
func (a *app) kick() {
	select {
	case a.pollNow <- struct{}{}:
	default:
	}
}

func (a *app) pollLoop() {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		a.poll()
		select {
		case <-a.done:
			return
		case <-t.C:
		case <-a.pollNow:
		}
	}
}

func (a *app) poll() {
	state, reason, code, port, cl := a.bridge.snapshot()
	var st *core.Status
	unsupported := false
	if state == core.StateRunning && cl != nil {
		s, err := cl.status()
		var se statusError
		switch {
		case err == nil:
			st = s
			a.upd.onStatus(cl, s.UpdateRequest)
		case errors.As(err, &se) && se.code == 404:
			unsupported = true
		}
	}
	in := core.Input{State: state, FailReason: reason, ExitCode: code, Port: port, Status: st, Unsupported: unsupported,
		LauncherVersion: version, Now: time.Now(), Update: a.upd.trayInfo()}
	a.render(in)
}

func (a *app) render(in core.Input) {
	v := core.Compute(in)
	a.mu.Lock()
	a.status, a.unsupported, a.view = in.Status, in.Unsupported, v
	m := a.menu
	iconChanged := v.Icon != a.icon
	a.icon = v.Icon
	openAdmin := false
	if !a.adminOpened && core.OpenAdminAtStart(a.autostart, a.settingsCreated, in, v) {
		a.adminOpened, openAdmin = true, true // the admin page shows the setup guide by itself while it isn't complete
	}
	showFail := ""
	if in.State == core.StateFailed && v.Problem != "" && a.shownFail != v.Headline {
		showFail = v.Problem
	}
	if in.State == core.StateFailed {
		a.shownFail = v.Headline // explain each failure once, not at every poll
	} else {
		a.shownFail = "" // a new start (Restart bridge) that fails again explains again
	}
	if m != nil && !a.quitting.Load() {
		if iconChanged {
			switch v.Icon {
			case core.IconOK:
				systray.SetIcon(iconOK)
			case core.IconAttention:
				systray.SetIcon(iconAttention)
			default:
				systray.SetIcon(iconOff)
			}
		}
		systray.SetTooltip(v.Tooltip)
		m.update(a, v)
	}
	a.mu.Unlock()

	a.prefsMu.Lock()
	keep := a.prefs.KeepAwake
	a.prefsMu.Unlock()
	a.awake.Set(keep && v.Listening > 0 && in.State == core.StateRunning)

	if openAdmin {
		a.log.Launcher("I", "first run: opening the admin page")
		a.openAdmin()
	}
	if showFail != "" {
		a.spawn("failure", func() { a.once("failure", func() { msgBox(showFail, mbWarn) }) })
	}
}

// throttleLoop opts the engine and ffmpeg (started by node.exe) out of power throttling as they appear.
func (a *app) throttleLoop() {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-a.done:
			return
		case <-t.C:
			a.job.unthrottleNew()
		}
	}
}

// spawn runs f on its own goroutine. A panic there would end the launcher without a trace (a windowed program has
// no console), so it is written to the log first; the launcher then exits, and Windows ends the bridge with the job.
func (a *app) spawn(name string, f func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				a.log.Launcher("E", "internal error in %s: %v", name, r)
				for _, line := range strings.Split(strings.TrimSpace(string(debug.Stack())), "\n") {
					a.log.Launcher("E", "  %s", line)
				}
				a.log.Close()
				os.Exit(3)
			}
		}()
		f()
	}()
}

// once runs a dialog-showing action unless the same one is already open.
func (a *app) once(name string, f func()) {
	if _, busy := a.busy.LoadOrStore(name, true); busy {
		return
	}
	defer a.busy.Delete(name)
	f()
}

func (a *app) snapshot() (core.View, *core.Status, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.view, a.status, a.unsupported
}

func (a *app) adminURL() string {
	_, _, _, port, _ := a.bridge.snapshot()
	return fmt.Sprintf("http://127.0.0.1:%d/admin", port)
}

// ---- actions

func (a *app) openAdmin() { a.openPage(a.adminURL()) }

// openSetupGuide is the tray's "Setup guide…": the admin page with the setup guide open, at the first unfinished
// step (or in review mode once setup is complete).
func (a *app) openSetupGuide() { a.openPage(a.adminURL() + "?setup=1") }

func (a *app) openPage(u string) {
	if err := openURL(u); err != nil {
		msgBox("Couldn't open your browser. Open this address yourself:\n\n"+u, mbWarn)
	}
}

func (a *app) showProblem() {
	v, _, _ := a.snapshot()
	if v.Problem != "" {
		a.once("problem", func() { msgBox(v.Problem, mbWarn) })
	}
}

func (a *app) signIn() {
	v, _, _ := a.snapshot()
	if v.SignIn == nil {
		// no code yet (or the bridge shows sign-in another way): the admin page has the engine sign-in card
		a.openAdmin()
		return
	}
	a.once("signin", func() {
		if v.Showcase != nil && *v.Showcase {
			// Showcase (D4): the code stays off this PC's screen, and no page that shows it is offered
			msgBox(core.SignInTextShowcase(v.SignIn, time.Now()), mbInfo)
			return
		}
		text := core.SignInText(v.SignIn, time.Now())
		u := v.SignIn.SafeURL()
		if u == "" {
			msgBox(text, mbInfo)
			return
		}
		if ask(text + "\n\nOpen the sign-in page on this PC now?") {
			if err := openURL(u); err != nil {
				msgBox("Couldn't open your browser. Open spotify.com/pair yourself.", mbWarn)
			}
		}
	})
}

func (a *app) phoneInfo() {
	v, _, _ := a.snapshot()
	a.once("phone", func() {
		if v.PhoneHidden {
			msgBox("Showcase mode is on, so the address is hidden. Turn Showcase mode off to see it.", mbInfo)
			return
		}
		if v.PhoneURL == "" {
			return
		}
		msgBox("To connect your iPhone or iPod touch:\n\n1. Join the same Wi-Fi network as this PC.\n2. Open Encore and enter this Home address:\n\n      "+
			v.PhoneURL+"\n\n3. Enter the pairing code from the admin page (Open Encore Bridge).", mbInfo)
	})
}

func (a *app) toggleShowcase() {
	v, _, _ := a.snapshot()
	_, _, _, _, cl := a.bridge.snapshot()
	if v.Showcase == nil || cl == nil {
		a.once("showcase", func() {
			msgBox("This Encore Bridge can't switch Showcase mode from here right now. Use the switch on the admin page.", mbInfo)
		})
		return
	}
	on, err := cl.setShowcase(!*v.Showcase)
	if err != nil {
		a.log.Launcher("W", "showcase switch: %v", err)
		a.once("showcase", func() { msgBox("Couldn't change Showcase mode: "+err.Error(), mbWarn) })
		return
	}
	a.log.Launcher("I", "showcase mode %s", onOff(on))
	a.kick()
}

func (a *app) toggleKeepAwake() {
	a.prefsMu.Lock()
	a.prefs.KeepAwake = !a.prefs.KeepAwake
	p := a.prefs
	a.prefsMu.Unlock()
	if err := core.SavePrefs(a.layout.PrefsFile(), p); err != nil {
		a.log.Launcher("W", "%v", err)
	}
	a.log.Launcher("I", "keep awake while streaming %s", onOff(p.KeepAwake))
	a.kick()
}

func (a *app) toggleAutostart() {
	want := !autostartEnabled(a.exe)
	if err := setAutostart(a.exe, want); err != nil {
		a.log.Launcher("W", "start with Windows: %v", err)
		a.once("autostart", func() { msgBox("Couldn't change Start with Windows: "+err.Error(), mbWarn) })
	} else {
		a.log.Launcher("I", "start with Windows %s", onOff(want))
	}
	a.kick()
}

func (a *app) editSettings() {
	if err := openInNotepad(a.layout.Settings()); err != nil {
		msgBox("Couldn't open settings.env: "+err.Error(), mbWarn)
		return
	}
	a.once("settings-hint", func() {
		msgBox("After you save settings.env, choose Troubleshooting → Restart bridge so the changes take effect.", mbInfo)
	})
}

func (a *app) openLog() {
	if err := openInNotepad(a.layout.LogFile()); err != nil {
		msgBox("Couldn't open the log: "+err.Error(), mbWarn)
	}
}

func (a *app) openLogs() { openFolder(a.layout.LogsDir()) }
func (a *app) openData() { openFolder(a.layout.DataRoot) }

func (a *app) restartBridge() {
	a.log.Launcher("I", "restart requested")
	a.bridge.Restart()
}

func (a *app) about() {
	v, st, unsupported := a.snapshot()
	bridgeV, engineV := "not running", "unknown"
	if st != nil {
		if st.Bridge.Version != "" {
			bridgeV = st.Bridge.Version
		}
		if st.Engine.Version != nil && *st.Engine.Version != "" {
			engineV = *st.Engine.Version
		}
	} else if unsupported {
		bridgeV = "running"
	}
	a.once("about", func() {
		msgBox(fmt.Sprintf("Encore Bridge %s\n\nRuns the bridge between Spotify and the Encore app on your iPhone or iPod touch.\n\n"+
			"Launcher: %s\nBridge: %s\nEngine: %s\nData folder: %s\n%s\n\n"+
			"Encore is an unofficial client. It isn't affiliated with or endorsed by Spotify.\n\n"+
			"Encore Bridge is free software under the GNU General Public License, version 3 or later, and comes with "+
			"ABSOLUTELY NO WARRANTY. Its license and the licenses of the programs it includes are in the \"licenses\" folder "+
			"next to Encore Bridge.exe.",
			displayVersion(), displayVersion(), bridgeV, engineV, friendlyPath(a.layout.DataRoot), v.Update.AboutLine()), mbInfo)
	})
}

func displayVersion() string {
	if version == "dev" {
		return "(development build)"
	}
	return version
}

// friendlyPath shows %LOCALAPPDATA%\… instead of a path with the Windows account name in it.
func friendlyPath(p string) string {
	if la := os.Getenv("LOCALAPPDATA"); la != "" {
		if r, err := filepath.Rel(la, p); err == nil && !strings.HasPrefix(r, "..") {
			return filepath.Join("%LOCALAPPDATA%", r)
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		if r, err := filepath.Rel(home, p); err == nil && !strings.HasPrefix(r, "..") {
			return filepath.Join("%USERPROFILE%", r)
		}
	}
	return p
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}
