package core

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

// Restarter decides what happens after the bridge stopped on its own: restart after a growing delay, or give up
// after several quick failures in a row (the user then picks Restart bridge after fixing the cause).
type Restarter struct {
	Delays    []time.Duration // delay before restart n (the last one repeats)
	Healthy   time.Duration   // a run at least this long resets the count
	MaxQuick  int             // this many short runs in a row: give up
	quickRuns int
	attempt   int
}

// NewRestarter returns the launcher's policy: 1, 2, 5, 10, 30 s; a minute of uptime resets it; five quick failures
// in a row stop it.
func NewRestarter() *Restarter {
	return &Restarter{
		Delays:   []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second, 30 * time.Second},
		Healthy:  time.Minute,
		MaxQuick: 5,
	}
}

// After reports how long to wait before restarting a bridge that ran for uptime, or giveUp.
func (r *Restarter) After(uptime time.Duration) (delay time.Duration, giveUp bool) {
	if uptime >= r.Healthy {
		r.quickRuns, r.attempt = 0, 0
	} else {
		r.quickRuns++
	}
	if r.MaxQuick > 0 && r.quickRuns >= r.MaxQuick {
		return 0, true
	}
	i := r.attempt
	if i >= len(r.Delays) {
		i = len(r.Delays) - 1
	}
	r.attempt++
	return r.Delays[i], false
}

// Reset forgets earlier failures (a manual restart).
func (r *Restarter) Reset() { r.quickRuns, r.attempt = 0, 0 }

// Prefs are the launcher's own choices, kept in <data root>\launcher.json. (Start with Windows lives in the
// registry, and the Showcase switch on the bridge.)
type Prefs struct {
	KeepAwake   bool `json:"keep_awake"`
	OpenOnStart bool `json:"open_admin_on_start"` // "Open admin page on start" (StartPage)
}

// DefaultPrefs: keep the PC awake while a phone is listening, and open the admin page at every start.
func DefaultPrefs() Prefs { return Prefs{KeepAwake: true, OpenOnStart: true} }

// LoadPrefs reads path; a missing or unreadable file gives the defaults, and so does a choice the file doesn't name
// (a launcher.json from an older launcher).
func LoadPrefs(path string) Prefs {
	p := DefaultPrefs()
	b, err := os.ReadFile(path)
	if err != nil {
		return p
	}
	if json.Unmarshal(b, &p) != nil {
		return DefaultPrefs()
	}
	return p
}

// SavePrefs writes path through a temporary file.
func SavePrefs(path string, p Prefs) error {
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\r', '\n'), 0o600); err != nil {
		return err
	}
	var last error
	for i := 0; i < 10; i++ { // Windows: an antivirus scan can hold the target for a moment
		if last = os.Rename(tmp, path); last == nil {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	os.Remove(tmp)
	return errors.Join(errors.New("saving launcher.json"), last)
}
