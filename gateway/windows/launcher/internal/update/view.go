package update

import "time"

// View states (§8.3).
const (
	StateNever     = "never"
	StateChecking  = "checking"
	StateUpToDate  = "up_to_date"
	StateAvailable = "available"
	StateError     = "error"
)

// Install phases (§8.3).
const (
	PhaseDownloading = "downloading"
	PhaseVerifying   = "verifying"
	PhaseWaiting     = "waiting"
	PhaseCancelled   = "cancelled"
	PhaseFailed      = "failed"
)

// Reasons automatic checks are off.
const (
	AutoOffSetting  = "setting"
	AutoOffDevBuild = "dev_build"
)

// View is the update view the launcher pushes to the bridge (POST /local/v1/update) and the tray renders (§8.3).
type View struct {
	V              int        `json:"v"`
	Source         string     `json:"source"`
	Kind           string     `json:"kind"`
	Current        string     `json:"current"`
	Auto           bool       `json:"auto"`
	AutoOff        *string    `json:"auto_off"`
	State          string     `json:"state"`
	CheckedAt      *string    `json:"checked_at"`
	NextCheckAt    *string    `json:"next_check_at"`
	Latest         *Latest    `json:"latest"`
	Error          *ViewError `json:"error"`
	Install        *Install   `json:"install"`
	HandledRequest string     `json:"handled_request,omitempty"`
}

// Latest is a verified newer release.
type Latest struct {
	Version     string  `json:"version"`
	PublishedAt *string `json:"published_at"`
	NotesURL    string  `json:"notes_url"`
	Asset       string  `json:"asset"`
	Size        int64   `json:"size"`
	SHA256      string  `json:"sha256"`
}

// ViewError is a check error.
type ViewError struct {
	Code       string  `json:"code"`
	Version    *string `json:"version"`
	RetryAt    *string `json:"retry_at"`
	HTTPStatus *int    `json:"http_status"`
}

// Install is a running or ended Update now.
type Install struct {
	Version  string  `json:"version"`
	Phase    string  `json:"phase"`
	Done     int64   `json:"done"`
	Total    int64   `json:"total"`
	Error    *string `json:"error"`
	ExitCode *uint32 `json:"exit_code"`
}

// Running: the update is still under way (the tray shows its phase).
func (i *Install) Running() bool {
	return i != nil && (i.Phase == PhaseDownloading || i.Phase == PhaseVerifying || i.Phase == PhaseWaiting)
}

func ts(t *time.Time) *string {
	if t == nil || t.IsZero() {
		return nil
	}
	s := t.UTC().Format(time.RFC3339)
	return &s
}

func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Available returns the verified newer release this kind can use, if one is known.
func (s *State) Available(current, kind string) (ver string, asset Asset, sha string, ok bool) {
	cur, okC := ParseCurrent(current)
	r, v := s.Result, s.Verified
	if !okC || r == nil || r.State != ResultAvailable || v == nil || v.Version != r.Version {
		return "", Asset{}, "", false
	}
	lv, okL := ParseRelease(r.Version)
	if !okL || !Newer(lv, cur) {
		return "", Asset{}, "", false
	}
	name := KindAsset(kind, r.Version)
	a, okA := r.Assets[name]
	h := v.SHA256[name]
	if !okA || h == "" {
		return "", Asset{}, "", false
	}
	return r.Version, a, h, true
}

// MakeView builds the view. autoSetting: UPDATE_CHECK isn't 0. A verified newer release is "available" only while the
// last check got an answer: after a check that failed, Update now wouldn't install a release an earlier check stored
// (PlanUpdateNow), so the tray and the admin page don't offer it either; they show the error.
func MakeView(s *State, kind, current string, autoSetting, checking bool, inst *Install) View {
	v := View{V: 1, Source: "launcher", Kind: kind, Current: current, State: StateNever, Install: inst}
	_, dev := ParseCurrent(current)
	dev = !dev
	switch {
	case dev:
		v.AutoOff = strp(AutoOffDevBuild)
	case !autoSetting:
		v.AutoOff = strp(AutoOffSetting)
	default:
		v.Auto = true
	}
	v.CheckedAt = ts(s.CheckedAt)
	if v.Auto {
		v.NextCheckAt = ts(s.NextCheck)
	}
	if s.Error != nil && !stale(s.Error.Version, current) {
		e := &ViewError{Code: s.Error.Code, Version: strp(s.Error.Version), RetryAt: ts(s.Error.RetryAt)}
		if s.Error.HTTPStatus != 0 {
			n := s.Error.HTTPStatus
			e.HTTPStatus = &n
		}
		v.Error = e
	}
	if ver, a, h, ok := s.Available(current, kind); ok && s.Error == nil {
		v.State = StateAvailable
		v.Latest = &Latest{Version: ver, PublishedAt: strp(s.Result.PublishedAt), NotesURL: NotesURL(ver),
			Asset: KindAsset(kind, ver), Size: a.Size, SHA256: h}
	} else if v.Error != nil {
		v.State = StateError
	} else if r := s.Result; r != nil && !dev {
		switch r.State {
		case ResultUpToDate, ResultAvailable: // available but not newer any more: this copy was updated
			v.State = StateUpToDate
		case ResultNoRelease:
			v.State = StateError
			v.Error = &ViewError{Code: CodeNoRelease}
		default: // incomplete_release, bad_signature, sums_entry_missing
			if stale(r.Version, current) { // about a version this copy already has
				v.State = StateUpToDate
			} else {
				v.State = StateError
				v.Error = &ViewError{Code: r.State, Version: strp(r.Version)}
			}
		}
	}
	if checking {
		v.State = StateChecking
	}
	return v
}

// stale: an error about a version that isn't newer than the running one (this copy was updated) isn't shown.
func stale(ver, current string) bool {
	if ver == "" {
		return false
	}
	v, ok1 := ParseRelease(ver)
	c, ok2 := ParseCurrent(current)
	return ok1 && ok2 && !Newer(v, c)
}
