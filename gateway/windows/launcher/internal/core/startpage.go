package core

import "time"

// The pages the launcher opens in the browser by itself (CONTRACT.md §8).
const (
	PageNone  = ""
	PageSetup = "setup" // the first-run rule (OpenAdminAtStart): the admin page, which shows the setup guide by itself
	PageAdmin = "admin" // the admin page: "Open admin page on start", or a second start
)

// StartPageWait is how long after the launcher started a second start waits for the page this start opens once the
// bridge answers, instead of opening one of its own. A bridge that hasn't answered by then may never answer (the
// tray explains why), and a second start must still bring a page up.
const StartPageWait = time.Minute

// StartPage decides when the launcher brings the admin page up by itself, so that one start is one browser tab:
//
//   - Each launcher start (double-click, Start menu, Start with Windows, Setup after an update), as soon as the
//     bridge first answers: the setup guide when the first-run rule holds, else the admin page while "Open admin page
//     on start" is on. Never both: they are the same page, which shows the setup guide by itself until setup is done.
//     Until a page opened, the first-run rule is checked again at every answer, as before the setting existed: the
//     engine sign-in is only known a few seconds after the bridge first answers.
//   - A second start while this launcher runs (the single-instance "show" event): the admin page. While this start's
//     page is still waiting for the bridge, the second start only makes sure that page opens, even with the setting
//     off, and opens no tab of its own.
//
// The caller serialises Poll and SecondStart.
type StartPage struct {
	Quiet           bool      // started by Windows (--autostart) or by Setup (--updated, --update-failed)
	SettingsCreated bool      // this start created settings.env
	Started         time.Time // when the launcher started

	decided bool // the bridge answered: the setting's page was opened, or found not needed
	opened  bool // the admin page was opened (it shows the setup guide by itself): the first-run rule needs no other
	asked   bool // a second start asked for the page before the bridge answered
}

// Poll is called with every status poll and the current "Open admin page on start" setting. It returns the page to
// open now, at most once per start: the setting's page at the first poll the bridge answers (its status, or a 404
// from a bridge older than the launcher contract), or the setup guide at the first answer the first-run rule holds;
// PageNone at every other poll.
func (s *StartPage) Poll(openOnStart bool, in Input, v View) string {
	if s.opened || (in.Status == nil && !in.Unsupported) {
		return PageNone
	}
	first := !s.decided
	s.decided = true
	switch {
	case OpenAdminAtStart(s.Quiet, s.SettingsCreated, in, v):
		s.opened = true
		return PageSetup
	case first && (openOnStart || s.asked):
		s.opened = true
		return PageAdmin
	}
	return PageNone
}

// SecondStart is called when another start of Encore Bridge.exe signalled this launcher, with the bridge's state. It
// reports whether to open the admin page now; false means the page this start opens once the bridge answers covers
// it. A tab opened while the bridge answers is the admin page, so the first-run rule opens no other. A tab opened
// before the bridge ever answered (it stopped, or didn't answer within StartPageWait) can't load it, so this start's
// page still opens once the bridge answers.
func (s *StartPage) SecondStart(state string, now time.Time) bool {
	waiting := state == StateStarting || state == StateRunning || state == ""
	if !s.decided && waiting && now.Sub(s.Started) < StartPageWait {
		s.asked = true
		return false
	}
	if s.decided && state == StateRunning {
		s.opened = true
	}
	return true
}

// SecondStartSignals reports whether a start that finds a launcher already running signals it to bring the admin page
// up: a start by the user always does; a start by Windows at sign-in or by Setup only while "Open admin page on
// start" is on (prefs is what the second start reads from launcher.json).
func SecondStartSignals(quiet bool, prefs Prefs) bool { return !quiet || prefs.OpenOnStart }
