package core

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 14, 9, 0, 0, 0, time.UTC)

// startStatus is a bridge status: complete is the setup guide's state ("true", "false", or "" for a bridge that
// doesn't report it); setupNeeded is the first-run admin-password state.
func startStatus(complete string, setupNeeded bool) *Status {
	setup := ""
	if complete != "" {
		setup = `,"setup":{"complete":` + complete + `}`
	}
	need := "false"
	if setupNeeded {
		need = "true"
	}
	return st(`{"contract":1,"bridge":{"version":"1.2.0"},"engine":{"state":"running","signed_in":true},` +
		`"admin":{"setup_needed":` + need + `},"spotify":{"connected":true},"phones":{"paired":1,"listening":0},"showcase":false` + setup + `}`)
}

// poll runs one StartPage poll as app.render does.
func poll(s *StartPage, openOnStart bool, in Input) string {
	return s.Poll(openOnStart, in, Compute(in))
}

var (
	notYet   = Input{State: StateStarting}
	noAnswer = Input{State: StateRunning} // node.exe runs, its HTTP port doesn't answer yet
	ready    = Input{State: StateRunning, Status: startStatus("true", false)}
)

// The setting on: every kind of start opens the admin page once, as soon as the bridge answers, and never again.
func TestStartPageOpensAdminOnEveryStart(t *testing.T) {
	for _, quiet := range []bool{false, true} { // double-click / Start menu, and --autostart / --updated / --update-failed
		s := &StartPage{Quiet: quiet, Started: t0}
		for _, in := range []Input{notYet, noAnswer, {State: StateFailed, FailReason: FailExit, ExitCode: ExitPortInUse}} {
			if got := poll(s, true, in); got != PageNone {
				t.Errorf("quiet=%v: %q before the bridge answered (%s)", quiet, got, in.State)
			}
		}
		if got := poll(s, true, ready); got != PageAdmin {
			t.Errorf("quiet=%v: first answer opened %q, want the admin page", quiet, got)
		}
		for i := 0; i < 3; i++ {
			if got := poll(s, true, ready); got != PageNone {
				t.Errorf("quiet=%v: poll %d opened %q again", quiet, i, got)
			}
		}
	}
	// a bridge older than the launcher contract (404) has answered too
	s := &StartPage{Started: t0}
	if got := poll(s, true, Input{State: StateRunning, Unsupported: true}); got != PageAdmin {
		t.Errorf("old bridge: %q", got)
	}
}

// The setting off: no page at start once setup is done, whoever started the launcher.
func TestStartPageSettingOff(t *testing.T) {
	for _, quiet := range []bool{false, true} {
		s := &StartPage{Quiet: quiet, Started: t0}
		for i := 0; i < 3; i++ {
			if got := poll(s, false, ready); got != PageNone {
				t.Errorf("quiet=%v: %q with the setting off", quiet, got)
			}
		}
	}
	if got := poll(&StartPage{Started: t0}, false, Input{State: StateRunning, Unsupported: true}); got != PageNone {
		t.Errorf("old bridge, setting off: %q", got)
	}
	// unknown setup state (an older bridge) never opens a page by itself with the setting off
	if got := poll(&StartPage{Started: t0}, false, Input{State: StateRunning, Status: startStatus("", false)}); got != PageNone {
		t.Errorf("unknown setup, setting off: %q", got)
	}
	// turning the setting off before the bridge answers counts
	s := &StartPage{Started: t0}
	poll(s, true, noAnswer)
	if got := poll(s, false, ready); got != PageNone {
		t.Errorf("setting turned off while starting: %q", got)
	}
}

// One tab: when the first-run rule already opens the setup guide (the installer's finish page, a new settings.env,
// setup not complete, or setup needed), that is the only page, setting on or off.
func TestStartPageOneTab(t *testing.T) {
	cases := []struct {
		name            string
		settingsCreated bool
		status          *Status
	}{
		{"setup guide not complete", false, startStatus("false", false)},
		{"settings.env just created", true, startStatus("true", false)},
		{"admin password not set yet", false, startStatus("false", true)},
	}
	for _, c := range cases {
		for _, on := range []bool{true, false} {
			s := &StartPage{SettingsCreated: c.settingsCreated, Started: t0}
			in := Input{State: StateRunning, Status: c.status}
			if got := poll(s, on, in); got != PageSetup {
				t.Errorf("%s, setting %v: %q, want the setup guide", c.name, on, got)
			}
			for i := 0; i < 3; i++ {
				if got := poll(s, on, in); got != PageNone {
					t.Errorf("%s, setting %v: a second tab (%q)", c.name, on, got)
				}
			}
		}
	}
	// a quiet start (Start with Windows, Setup after an update) with setup not complete: one admin page (which shows
	// the setup guide by itself) with the setting on, none with it off, as before the setting existed
	in := Input{State: StateRunning, Status: startStatus("false", false)}
	s := &StartPage{Quiet: true, Started: t0}
	if got := poll(s, true, in); got != PageAdmin {
		t.Errorf("quiet, incomplete, on: %q", got)
	}
	if got := poll(s, true, in); got != PageNone {
		t.Errorf("quiet, incomplete, on: a second tab (%q)", got)
	}
	if got := poll(&StartPage{Quiet: true, Started: t0}, false, in); got != PageNone {
		t.Errorf("quiet, incomplete, off: %q", got)
	}
}

// A second start (the single-instance path) always brings the page up, never as a second tab for one start.
func TestStartPageSecondStart(t *testing.T) {
	// while the bridge is still starting: no tab now; the start's page opens once it answers, even with the setting
	// off, and only that one
	for _, state := range []string{"", StateStarting, StateRunning} {
		s := &StartPage{Started: t0}
		if s.SecondStart(state, t0.Add(2*time.Second)) {
			t.Errorf("%q: opened a tab while the start's page is pending", state)
		}
		if s.SecondStart(state, t0.Add(3*time.Second)) {
			t.Errorf("%q: a third start opened a tab", state)
		}
		if got := poll(s, false, ready); got != PageAdmin {
			t.Errorf("%q: the start's page after a second start: %q", state, got)
		}
		if got := poll(s, false, ready); got != PageNone {
			t.Errorf("%q: opened again: %q", state, got)
		}
	}
	// pending second start + first run: the setup guide, once
	s := &StartPage{Started: t0}
	s.SecondStart(StateRunning, t0)
	in := Input{State: StateRunning, Status: startStatus("false", false)}
	if got := poll(s, true, in); got != PageSetup {
		t.Errorf("second start during first run: %q", got)
	}
	if got := poll(s, true, in); got != PageNone {
		t.Errorf("second start during first run: a second tab (%q)", got)
	}

	// once the start's page is decided (opened, or not wanted): every second start opens the admin page now
	for _, on := range []bool{true, false} {
		s := &StartPage{Started: t0}
		poll(s, on, ready)
		for i := 0; i < 2; i++ {
			if !s.SecondStart(StateRunning, t0.Add(5*time.Second)) {
				t.Errorf("setting %v: second start %d after the bridge answered did nothing", on, i)
			}
		}
		if got := poll(s, on, ready); got != PageNone {
			t.Errorf("setting %v: the start's page opened again: %q", on, got)
		}
	}

	// a bridge that stopped, or one that hasn't answered for a minute: open now (the tray explains the problem)
	for _, state := range []string{StateFailed, StateStopped, StateStopping} {
		if !(&StartPage{Started: t0}).SecondStart(state, t0.Add(time.Second)) {
			t.Errorf("%s: second start did nothing", state)
		}
	}
	if !(&StartPage{Started: t0}).SecondStart(StateRunning, t0.Add(StartPageWait)) {
		t.Error("a bridge that never answers: second start did nothing")
	}
	// that tab couldn't load the page (nothing answered yet): this start's page still opens once the bridge answers
	// (after Restart bridge, or a slow start), once
	for _, c := range []struct {
		state string
		at    time.Duration
	}{{StateFailed, time.Second}, {StateStopped, 5 * time.Second}, {StateStarting, 2 * time.Minute}} {
		s := &StartPage{Started: t0}
		if !s.SecondStart(c.state, t0.Add(c.at)) {
			t.Errorf("%s: second start did nothing", c.state)
		}
		if got := poll(s, true, ready); got != PageAdmin {
			t.Errorf("%s: once the bridge answers: %q, want the admin page", c.state, got)
		}
		if got := poll(s, true, ready); got != PageNone {
			t.Errorf("%s: opened again: %q", c.state, got)
		}
	}
}

// engineStatus is a bridge whose setup is complete; signedIn is the engine sign-in: "true", "false", or "null" while
// the engine is still starting (the bridge doesn't know yet).
func engineStatus(state, signedIn string) *Status {
	return st(`{"contract":1,"bridge":{"version":"1.2.0"},"engine":{"state":"` + state + `","signed_in":` + signedIn + `},` +
		`"admin":{"setup_needed":false},"spotify":{"connected":true},"phones":{"paired":1,"listening":0},"showcase":false,"setup":{"complete":true}}`)
}

// The first-run rule is checked at every answer until a page opened: the engine sign-in is only known a few seconds
// after the bridge first answers.
func TestStartPageLateSignIn(t *testing.T) {
	starting := Input{State: StateRunning, Status: engineStatus("starting", "null")}
	signedOut := Input{State: StateRunning, Status: engineStatus("running", "false")}

	// setting off, started by the user: the setup guide (it has the sign-in card) once the sign-in is known missing
	s := &StartPage{Started: t0}
	opened := 0
	for _, in := range []Input{starting, starting, signedOut, signedOut, signedOut} {
		switch got := poll(s, false, in); got {
		case PageSetup:
			opened++
		case PageNone:
		default:
			t.Errorf("setting off: %q", got)
		}
	}
	if opened != 1 {
		t.Errorf("setting off: the setup guide opened %d times, want once", opened)
	}

	// setting on: the admin page at the first answer covers the sign-in too (one tab)
	s = &StartPage{Started: t0}
	if got := poll(s, true, starting); got != PageAdmin {
		t.Errorf("setting on, first answer: %q", got)
	}
	for i := 0; i < 2; i++ {
		if got := poll(s, true, signedOut); got != PageNone {
			t.Errorf("setting on: a second tab for the sign-in (%q)", got)
		}
	}

	// Start with Windows / after an update, setting off: no page, as before the setting existed
	s = &StartPage{Quiet: true, Started: t0}
	for _, in := range []Input{starting, signedOut, signedOut} {
		if got := poll(s, false, in); got != PageNone {
			t.Errorf("quiet, setting off: %q", got)
		}
	}

	// a second start after the bridge answered opened the admin page: the sign-in opens no second tab
	s = &StartPage{Started: t0}
	poll(s, false, starting)
	if !s.SecondStart(StateRunning, t0.Add(5*time.Second)) {
		t.Error("second start after the bridge answered did nothing")
	}
	if got := poll(s, false, signedOut); got != PageNone {
		t.Errorf("a second tab after a second start: %q", got)
	}
}

// Which second starts signal the running launcher: the user's always; Windows' and Setup's only with the setting on.
func TestSecondStartSignals(t *testing.T) {
	on, off := Prefs{OpenOnStart: true}, Prefs{OpenOnStart: false}
	if !SecondStartSignals(false, on) || !SecondStartSignals(false, off) {
		t.Error("a second start by the user must bring the page up")
	}
	if !SecondStartSignals(true, on) {
		t.Error("a quiet second start with the setting on must bring the page up")
	}
	if SecondStartSignals(true, off) {
		t.Error("a quiet second start with the setting off must do nothing")
	}
}

// "Open admin page on start" is on by default, also for a launcher.json an older launcher wrote, and it persists.
func TestPrefsOpenOnStart(t *testing.T) {
	p := filepath.Join(t.TempDir(), "launcher.json")
	if !LoadPrefs(p).OpenOnStart {
		t.Error("default must be on")
	}
	os.WriteFile(p, []byte("{\r\n  \"keep_awake\": false\r\n}\r\n"), 0o600)
	if got := LoadPrefs(p); !got.OpenOnStart || got.KeepAwake {
		t.Errorf("older launcher.json: %+v", got)
	}
	if err := SavePrefs(p, Prefs{KeepAwake: true, OpenOnStart: false}); err != nil {
		t.Fatal(err)
	}
	if got := LoadPrefs(p); got.OpenOnStart || !got.KeepAwake {
		t.Errorf("not saved: %+v", got)
	}
	if b, _ := os.ReadFile(p); !strings.Contains(string(b), `"open_admin_on_start": false`) || !strings.Contains(string(b), `"keep_awake": true`) {
		t.Errorf("launcher.json: %s", b)
	}
	os.WriteFile(p, []byte("{broken"), 0o600)
	if !LoadPrefs(p).OpenOnStart {
		t.Error("a broken file must give the defaults")
	}
}
