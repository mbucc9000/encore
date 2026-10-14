package core

import (
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Status is GET /local/v1/status (CONTRACT.md §5). It never carries names, the Spotify username or paths.
type Status struct {
	Contract int `json:"contract"`
	Bridge   struct {
		Version string `json:"version"`
		UptimeS int64  `json:"uptime_s"`
		Port    int    `json:"port"`
	} `json:"bridge"`
	Engine struct {
		State     string  `json:"state"` // starting|running|restarting|stopped|missing|version_mismatch|unmanaged
		Version   *string `json:"version"`
		Expected  string  `json:"expected"`
		Connected bool    `json:"connected"`
		SignedIn  *bool   `json:"signed_in"`
		Restarts  int     `json:"restarts"`
	} `json:"engine"`
	SignIn *SignIn `json:"sign_in"`
	Admin  struct {
		SetupNeeded bool `json:"setup_needed"`
	} `json:"admin"`
	Spotify struct {
		Connected *bool `json:"connected"`
	} `json:"spotify"`
	Phones struct {
		Paired    int `json:"paired"`
		Listening int `json:"listening"`
	} `json:"phones"`
	Playing  bool    `json:"playing"`
	Showcase *bool   `json:"showcase"`
	PhoneURL *string `json:"phone_url"`
	// Setup is the setup guide's state (added in contract 1 without a new number): nil when this bridge doesn't
	// report it, and Complete nil when it doesn't know. Missing means "unknown", never "incomplete".
	Setup *struct {
		Complete *bool `json:"complete"`
	} `json:"setup"`
	// UpdateRequest is the admin page's oldest pending update request (CONTRACT.md §9; nil when none, or from a
	// bridge without the update relay). The launcher acts once per id.
	UpdateRequest *UpdateRequest `json:"update_request"`
}

// SignIn is the engine's device-code sign-in in progress.
type SignIn struct {
	URL       string          `json:"url"`
	Code      string          `json:"code"`
	ExpiresAt json.RawMessage `json:"expires_at"` // RFC 3339 string (the engine's) or Unix seconds
}

// Expires returns when the code stops working (zero if unknown).
func (s *SignIn) Expires() time.Time {
	if s == nil || len(s.ExpiresAt) == 0 {
		return time.Time{}
	}
	var str string
	if json.Unmarshal(s.ExpiresAt, &str) == nil {
		if t, err := time.Parse(time.RFC3339Nano, str); err == nil {
			return t
		}
		return time.Time{}
	}
	if n, err := strconv.ParseFloat(string(s.ExpiresAt), 64); err == nil && n > 0 {
		return time.Unix(int64(n), 0)
	}
	return time.Time{}
}

// SafeURL returns the sign-in page only when it is an https page on spotify.com, so the tray never opens anything
// else.
func (s *SignIn) SafeURL() string {
	if s == nil {
		return ""
	}
	u, err := url.Parse(s.URL)
	if err != nil || u.Scheme != "https" {
		return ""
	}
	h := strings.ToLower(u.Hostname())
	if h != "spotify.com" && !strings.HasSuffix(h, ".spotify.com") {
		return ""
	}
	return u.String()
}

// ParseStatus decodes the status JSON.
func ParseStatus(b []byte) (*Status, error) {
	var s Status
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// Process states of the bridge (node.exe) as the launcher sees them.
const (
	StateStarting = "starting"
	StateRunning  = "running"
	StateStopping = "stopping"
	StateStopped  = "stopped"
	StateFailed   = "failed"
)

// Gateway exit codes (CONTRACT.md §3).
const (
	ExitPortInUse  = 10
	ExitPortDenied = 11
	ExitSettings   = 12
)

// Failure reasons the launcher itself detects.
const (
	FailExit      = "exit"       // a gateway exit code from §3 (see ExitCode)
	FailCrashLoop = "crash_loop" // stopped several times right after starting
	FailStart     = "start"      // node.exe couldn't be started
)

// Input is everything the tray shows, gathered by the launcher.
type Input struct {
	State           string
	FailReason      string
	ExitCode        int
	Port            int
	Status          *Status // nil: not reachable (yet) or not supported
	Unsupported     bool    // the bridge answered 404: it predates the launcher contract
	LauncherVersion string
	Now             time.Time
	Update          UpdateTray // what the launcher knows about updates
}

// Icons.
const (
	IconOK        = "ok"
	IconAttention = "attention"
	IconOff       = "off"
)

// View is what the tray renders.
type View struct {
	Icon            string
	Tooltip         string // ≤ 127 characters (the notification area's limit)
	Headline        string // the status line at the top of the menu
	Problem         string // a longer explanation for a dialog, when there is a problem the user must fix
	SignIn          *SignIn
	SignInNeeded    bool   // show "Sign in to Spotify…"
	PhoneURL        string // shown as "Phone address: …"; empty hides the line
	PhoneHidden     bool   // Showcase is on: the line says the address is hidden
	Showcase        *bool  // nil: the bridge doesn't support Showcase (yet)
	Listening       int
	FirstRunNeeds   bool // first-run setup or sign-in is needed: worth opening the admin page once
	SetupIncomplete bool // the bridge says its setup guide isn't complete (false when it doesn't say)
	VersionMismatch bool
	Update          UpdateTray // the update item, the tooltip's " · 1.2.0 available" and the About line
}

// OpenAdminAtStart is the first-run rule: the launcher opens the admin page (which then shows the setup guide) once
// per launcher start, unless Windows started it (--autostart), as soon as the bridge answers its status, when setup
// is needed, settings.env was just created, or the bridge says its setup guide isn't complete. (settings.env can
// already exist on a fresh install, left by an earlier install or a portable copy, so settingsCreated alone isn't
// enough: setup.complete == false is what opens it then.) StartPage applies it, with "Open admin page on start", so
// that one start opens one tab.
func OpenAdminAtStart(autostart, settingsCreated bool, in Input, v View) bool {
	return !autostart && in.Status != nil && (v.FirstRunNeeds || settingsCreated || v.SetupIncomplete)
}

// Compute turns the launcher's knowledge into the tray's view.
func Compute(in Input) View {
	v := View{Icon: IconOff}
	switch in.State {
	case StateStarting, "":
		v.Headline = tr("Starting…")
	case StateStopping:
		v.Headline = tr("Stopping…")
	case StateStopped:
		v.Headline = tr("Stopped")
	case StateFailed:
		v.Icon = IconAttention
		v.Headline, v.Problem = failure(in)
	case StateRunning:
		running(&v, in)
	}
	v.Update = in.Update
	v.Tooltip = clip(trf("Encore Bridge: {status}", vars{"status": v.Headline})+in.Update.TooltipSuffix(), 127)
	return v
}

// failure is the headline and the explanation of a stopped bridge. Each explanation is one text, ending with what to do
// next (Restart bridge), so a translation can order it as its language needs.
func failure(in Input) (string, string) {
	port := vars{"port": in.Port}
	switch in.FailReason {
	case FailExit:
		switch in.ExitCode {
		case ExitPortInUse:
			return trf("Port {port} is in use", port), trf("Another program is already using port {port}, so Encore Bridge can't start. Close that program, or pick another port: set PORT in settings.env (Troubleshooting → Edit settings) and change the Home address in the app to match. Then choose Restart bridge in the Encore Bridge menu (Troubleshooting).", port)
		case ExitPortDenied:
			return trf("Port {port} is blocked by Windows", port), trf("Windows doesn't let programs use port {port} on this PC. Hyper-V, WSL or Docker reserve some ports. Pick another port: set PORT in settings.env (Troubleshooting → Edit settings) and change the Home address in the app to match. Then choose Restart bridge in the Encore Bridge menu (Troubleshooting).", port)
		case ExitSettings:
			return tr("Settings problem"), tr("Encore Bridge couldn't use its settings. The log says which one (Troubleshooting → Open log). Fix settings.env (Troubleshooting → Edit settings). Then choose Restart bridge in the Encore Bridge menu (Troubleshooting).")
		}
		return tr("Stopped"), tr("Encore Bridge stopped. The log may say why (Troubleshooting → Open log). Then choose Restart bridge in the Encore Bridge menu (Troubleshooting).")
	case FailCrashLoop:
		return tr("Keeps stopping"), tr("Encore Bridge stopped several times right after starting. The log says why (Troubleshooting → Open log). Then choose Restart bridge in the Encore Bridge menu (Troubleshooting).")
	case FailStart:
		return tr("Couldn't start"), tr("Windows couldn't start Encore Bridge's runtime (runtime\\node.exe). Antivirus software may have blocked or removed it. Reinstall Encore Bridge, or check your antivirus quarantine.")
	}
	return tr("Stopped"), tr("Encore Bridge stopped. Then choose Restart bridge in the Encore Bridge menu (Troubleshooting).")
}

func running(v *View, in Input) {
	s := in.Status
	if s == nil {
		if in.Unsupported {
			v.Icon, v.Headline = IconOK, tr("Running")
		} else {
			v.Headline = tr("Starting…")
		}
		return
	}
	v.Icon = IconOK
	v.Showcase = s.Showcase
	v.SetupIncomplete = s.Setup != nil && s.Setup.Complete != nil && !*s.Setup.Complete
	v.Listening = s.Phones.Listening
	if s.PhoneURL != nil && *s.PhoneURL != "" {
		if s.Showcase != nil && *s.Showcase {
			v.PhoneHidden = true
		} else {
			v.PhoneURL = *s.PhoneURL
		}
	} else if s.Showcase != nil && *s.Showcase {
		v.PhoneHidden = true
	}
	if s.SignIn != nil && (s.SignIn.Code != "" || s.SignIn.SafeURL() != "") {
		v.SignIn = s.SignIn
	}
	notSignedIn := s.Engine.SignedIn != nil && !*s.Engine.SignedIn
	v.SignInNeeded = v.SignIn != nil || notSignedIn
	v.VersionMismatch = in.LauncherVersion != "" && in.LauncherVersion != "dev" && s.Bridge.Version != "" &&
		strings.TrimPrefix(s.Bridge.Version, "v") != strings.TrimPrefix(in.LauncherVersion, "v")

	attention := func(h, p string) { v.Icon, v.Headline, v.Problem = IconAttention, h, p }
	switch {
	case s.Engine.State == "version_mismatch":
		attention(tr("Engine version mismatch"), tr("The Spotify engine in this folder doesn't match this Encore Bridge, so it isn't started. Reinstall Encore Bridge (or unzip the whole package again)."))
	case s.Engine.State == "missing":
		attention(tr("Engine missing"), tr("The Spotify engine (engine\\encore-engine.exe) is missing. Antivirus software may have removed it. Reinstall Encore Bridge, or check your antivirus quarantine."))
	case v.VersionMismatch:
		attention(tr("Version mismatch"), trf("This launcher is version {launcher} but the bridge is version {bridge}. Reinstall Encore Bridge (or unzip the whole package again).",
			vars{"launcher": in.LauncherVersion, "bridge": s.Bridge.Version}))
	case s.Admin.SetupNeeded:
		attention(tr("Set your admin password"), tr("Open Encore Bridge and choose an admin password to finish setting up."))
		v.FirstRunNeeds = true
	case v.SignInNeeded:
		attention(tr("Sign in to Spotify"), tr("The Spotify engine isn't signed in yet. Choose Sign in to Spotify in the Encore Bridge menu."))
		v.FirstRunNeeds = true
	case s.Engine.State == "stopped":
		attention(tr("Engine stopped"), tr("The Spotify engine stopped. The log may say why (Troubleshooting → Open log)."))
	case s.Spotify.Connected != nil && !*s.Spotify.Connected:
		attention(tr("Connect your Spotify account"), tr("Open Encore Bridge and connect your Spotify account to finish setting up."))
		v.FirstRunNeeds = true
	case s.Engine.State == "starting" || s.Engine.State == "restarting":
		v.Headline = tr("Engine starting…")
	case s.Phones.Listening == 1:
		v.Headline = tr("Streaming to 1 phone")
	case s.Phones.Listening > 1:
		v.Headline = trf("Streaming to {n} phones", vars{"n": s.Phones.Listening})
	case s.Phones.Paired == 0:
		v.Headline = tr("Ready: pair your phone")
	default:
		v.Headline = tr("Ready")
	}
}

// SignInText is the dialog text for the engine's device-code sign-in.
func SignInText(s *SignIn, now time.Time) string {
	var b strings.Builder
	b.WriteString(tr("Sign the Encore engine in to your Spotify account (Premium):") + "\n\n")
	if u := s.SafeURL(); u != "" {
		b.WriteString(trf("1. Open {url} on this PC or your phone.", vars{"url": displayURL(u)}) + "\n")
	} else {
		b.WriteString(tr("1. Open spotify.com/pair on this PC or your phone.") + "\n")
	}
	if s.Code != "" {
		b.WriteString(trf("2. If it asks for a code, enter:  {code}", vars{"code": s.Code}) + "\n")
	}
	b.WriteString(tr("3. Approve the request.") + "\n")
	if exp := s.Expires(); !exp.IsZero() {
		if m := int(exp.Sub(now).Minutes()); m == 1 {
			b.WriteString("\n" + tr("The code works for about 1 more minute."))
		} else if m > 1 {
			b.WriteString("\n" + trf("The code works for about {n} more minutes.", vars{"n": m}))
		} else if exp.Before(now) {
			b.WriteString("\n" + tr("This code has expired; a new one appears in a moment."))
		}
	}
	return b.String()
}

// SignInTextShowcase is the dialog text while Showcase mode is on (D4: no codes on this PC's screens): the steps
// without the code. The admin page still shows it behind press-and-hold.
func SignInTextShowcase(s *SignIn, now time.Time) string {
	hidden := SignIn{URL: s.URL, ExpiresAt: s.ExpiresAt}
	return SignInText(&hidden, now) + "\n\n" +
		tr("Showcase mode is on, so the code is hidden here. To see it, turn Showcase mode off, or open Encore Bridge and press and hold the code on its Engine sign-in card.")
}

func displayURL(u string) string {
	p, err := url.Parse(u)
	if err != nil {
		return u
	}
	return p.Host + p.EscapedPath()
}
