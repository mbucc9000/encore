package update

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// StateVersion is update.json's format.
const StateVersion = 1

// Results of a check that got an answer (Result.State).
const (
	ResultUpToDate         = "up_to_date"
	ResultAvailable        = "available"
	ResultNoRelease        = CodeNoRelease
	ResultIncomplete       = CodeIncomplete
	ResultBadSignature     = CodeBadSignature
	ResultSumsEntryMissing = CodeSumsEntryMissing
)

// State is <data root>\update.json (§5.12): times, versions, asset ids and sizes, hashes, a content-hash ETag and error
// codes. Never addresses, names or paths.
type State struct {
	V           int          `json:"v"`
	LastContact *time.Time   `json:"last_contact"` // the last request that may have reached GitHub
	NextCheck   *time.Time   `json:"next_check"`   // when the next automatic check is due
	CheckedAt   *time.Time   `json:"checked_at"`   // the last check that got an answer
	ETag        string       `json:"etag,omitempty"`
	ETagFor     string       `json:"etag_for,omitempty"` // "<current version> <kind>": an ETag is only sent back by the same copy
	Result      *Result      `json:"result"`
	Verified    *Verified    `json:"verified"`
	Error       *CheckError  `json:"error"` // the last check's failure (transport, HTTP), nil after an answer
	Download    *DownloadRec `json:"download"`
	Pending     *Pending     `json:"pending"`
	// FailedUpdate is the version of an update that didn't finish: its folder (with Setup's log) is kept until
	// it is 30 days old or a later update succeeds.
	FailedUpdate string `json:"failed_update,omitempty"`
}

// Asset is a release asset's id and size from the API.
type Asset struct {
	ID   int64 `json:"id"`
	Size int64 `json:"size"`
}

// Result is what the last answer said.
type Result struct {
	State       string           `json:"state"`
	Version     string           `json:"version,omitempty"`
	PublishedAt string           `json:"published_at,omitempty"`
	Assets      map[string]Asset `json:"assets,omitempty"`
}

// Verified is the verified checksum of this kind's asset of an available release.
type Verified struct {
	Version string            `json:"version"`
	KeyID   string            `json:"key_id"`
	SHA256  map[string]string `json:"sha256"`
}

// CheckError is a failed check (§2.2 codes).
type CheckError struct {
	Code       string     `json:"code"`
	Version    string     `json:"version,omitempty"`
	RetryAt    *time.Time `json:"retry_at,omitempty"`
	HTTPStatus int        `json:"http_status,omitempty"`
}

// DownloadRec names the installer a .part file belongs to (for resuming).
type DownloadRec struct {
	Version string `json:"version"`
	AssetID int64  `json:"asset_id"`
	Size    int64  `json:"size"`
}

// Pending is an update whose Setup was started.
type Pending struct {
	From      string    `json:"from"`
	To        string    `json:"to"`
	StartedAt time.Time `json:"started_at"`
}

var etagRe = regexp.MustCompile(`^(W/)?"[0-9a-f]{32,64}"$`)

// validETag: only an ETag that looks like a content hash is stored and sent back (§2.4).
func validETag(s string) bool { return etagRe.MatchString(s) }

// LoadState reads update.json. A missing, unreadable or newer file, or one with values this launcher wouldn't write,
// starts fresh (a check is then due).
func LoadState(path string) State {
	b, err := os.ReadFile(path)
	if err != nil {
		return State{V: StateVersion}
	}
	var s State
	if json.Unmarshal(b, &s) != nil || s.V != StateVersion || !s.sane() {
		return State{V: StateVersion}
	}
	return s
}

func (s *State) sane() bool {
	if s.ETag != "" && !validETag(s.ETag) {
		return false
	}
	if r := s.Result; r != nil {
		if r.Version != "" {
			if _, ok := ParseRelease(r.Version); !ok {
				return false
			}
		}
		for name := range r.Assets {
			if !assetNameRe.MatchString(name) {
				return false
			}
		}
	}
	if v := s.Verified; v != nil {
		if _, ok := ParseRelease(v.Version); !ok {
			return false
		}
		for _, h := range v.SHA256 {
			if !hexRe.MatchString(h) {
				return false
			}
		}
	}
	if d := s.Download; d != nil {
		if _, ok := ParseRelease(d.Version); !ok {
			return false
		}
	}
	if p := s.Pending; p != nil {
		if _, ok := ParseRelease(p.To); !ok {
			return false
		}
	}
	if s.FailedUpdate != "" {
		if _, ok := ParseRelease(s.FailedUpdate); !ok {
			return false
		}
	}
	return true
}

var (
	hexRe       = regexp.MustCompile(`^[0-9a-f]{64}$`)
	assetNameRe = regexp.MustCompile(`^[A-Za-z0-9._+-]{1,128}$`)
)

// SaveState writes update.json through a temporary file and a rename.
func SaveState(path string, s State) error {
	s.V = StateVersion
	b, err := json.MarshalIndent(s, "", "  ")
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
	return errors.Join(errors.New("saving update.json"), last)
}

// MergeCheck copies what a check changes from c (a copy the check worked on) into s, leaving the download and
// pending records (owned by Update now) alone.
func (s *State) MergeCheck(c State) {
	s.LastContact, s.NextCheck, s.CheckedAt = c.LastContact, c.NextCheck, c.CheckedAt
	s.ETag, s.ETagFor = c.ETag, c.ETagFor
	s.Result, s.Verified, s.Error = c.Result, c.Verified, c.Error
}

// Clone is a deep copy.
func (s State) Clone() State {
	b, _ := json.Marshal(s)
	var c State
	json.Unmarshal(b, &c)
	return c
}

// ---- schedule (§2.6)

const (
	CheckInterval  = 24 * time.Hour   // between automatic checks
	MaxJitter      = time.Hour        // added to CheckInterval: 0-60 min
	OfflineRetry   = time.Hour        // GitHub wasn't contacted
	ManualThrottle = 60 * time.Second // a manual check this soon after a contact reuses the stored result
	MinAutoGap     = 23 * time.Hour   // two automatic contacts of one process, whatever the clock does
	FirstEval      = 10 * time.Minute // after start
	EvalEvery      = 30 * time.Minute
	maxRetryAfter  = 24 * time.Hour
)

// FixClock handles a clock that went back: a last contact in the future counts as now, and a next check further away
// than a normal interval from now is brought back. It reports whether it changed anything.
func (s *State) FixClock(now time.Time) bool {
	changed := false
	if s.LastContact != nil && s.LastContact.After(now) {
		t := now
		s.LastContact = &t
		changed = true
	}
	// Every outcome schedules at most CheckInterval + MaxJitter ahead (a rate limit's retry_at included, §2.2), so a
	// next check further away than that is a clock that went back, or a bad file.
	if s.NextCheck != nil && s.NextCheck.After(now.Add(CheckInterval+MaxJitter)) {
		t := now.Add(CheckInterval)
		s.NextCheck = &t
		changed = true
	}
	return changed
}

// Due reports whether an automatic check is due: missing state is due.
func (s *State) Due(now time.Time) bool {
	return s.NextCheck == nil || !now.Before(*s.NextCheck)
}

// Scheduler keeps the in-process rule: two automatic contacts are never less than MinAutoGap apart. mono is a
// monotonic time: in production time.Now(), whose monotonic clock reading a change of the wall clock doesn't move.
type Scheduler struct {
	last    time.Time
	hasLast bool
}

// Allowed: an automatic check may contact GitHub now.
func (sc *Scheduler) Allowed(mono time.Time) bool {
	return !sc.hasLast || mono.Sub(sc.last) >= MinAutoGap
}

// Contacted records an automatic check that may have reached GitHub.
func (sc *Scheduler) Contacted(mono time.Time) { sc.last, sc.hasLast = mono, true }

// AutoCheckDue is the whole rule for an automatic check (§2.6), evaluated 10 minutes after start and then every 30
// minutes: automatic checks are on (UPDATE_CHECK isn't 0, not a development build), the stored schedule says it is
// due (after FixClock), and this process's last automatic contact is at least MinAutoGap ago. wall is the clock
// time, mono a monotonic one (in production both are time.Now()). It reports whether st changed (to be saved).
func AutoCheckDue(st *State, sc *Scheduler, wall, mono time.Time, auto bool) (due, changed bool) {
	changed = st.FixClock(wall)
	return auto && st.Due(wall) && sc.Allowed(mono), changed
}

// next is when the next automatic check is due after an outcome.
func next(now time.Time, e *CheckError, jitter time.Duration) time.Time {
	base := now.Add(CheckInterval + jitter)
	if e == nil {
		return base
	}
	switch e.Code {
	case CodeOffline:
		return now.Add(OfflineRetry)
	case CodeRateLimited:
		if e.RetryAt != nil && e.RetryAt.After(base) {
			return *e.RetryAt
		}
	}
	return base
}
