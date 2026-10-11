package core

import (
	"fmt"
	"path/filepath"
	"time"
)

// Update texts and the tray's view of the update system (DESIGN-UPDATES.md §5.2, §5.9). The admin page uses the same
// texts (gateway/src/admin.html).

// UpdateFile and UpdatesDir are the launcher's update state and download folder in the data root (CONTRACT.md §7).
func (l Layout) UpdateFile() string { return filepath.Join(l.DataRoot, "update.json") }
func (l Layout) UpdatesDir() string { return filepath.Join(l.DataRoot, "updates") }

// UpdateRequest is the admin page's pending request in GET /local/v1/status (CONTRACT.md §9).
type UpdateRequest struct {
	ID     string `json:"id"`
	Action string `json:"action"` // check | install | cancel
}

// Valid: a 16-hex id and a known action.
func (r *UpdateRequest) Valid() bool {
	if r == nil || len(r.ID) != 16 {
		return false
	}
	for _, c := range r.ID {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return r.Action == "check" || r.Action == "install" || r.Action == "cancel"
}

// Kinds the launcher can be (§5.1).
const (
	KindInstaller = "windows-installer"
	KindZip       = "windows-zip"
)

// UpdateTray is what the tray shows about updates.
type UpdateTray struct {
	Kind      string    // windows-installer or windows-zip
	Current   string    // the running version
	Available string    // a verified newer version, "" when none is known
	Running   string    // the version Update now is installing, "" when none runs
	Phase     string    // downloading | verifying | waiting while Update now runs
	Done      int64     // bytes downloaded
	Total     int64     // the installer's size
	State     string    // never | checking | up_to_date | available | error
	AutoOff   string    // "", "setting" or "dev_build"
	CheckedAt time.Time // the last answer (zero: never)
}

// UpdateMenu is the "is available" item: its title ("" hides it) and which children show.
type UpdateMenu struct {
	Title      string
	ShowAction bool   // Update now… / Download…
	Action     string // "Update now…" (installer) or "Download…" (zip)
	ShowNotes  bool   // What's new
	ShowCancel bool   // Cancel update (while downloading)
}

// Menu renders the update item (§5.2, §5.9).
func (u UpdateTray) Menu() UpdateMenu {
	m := UpdateMenu{Action: "Update now…"}
	if u.Kind == KindZip {
		m.Action = "Download…"
	}
	switch {
	case u.Running != "" && u.Phase == "downloading":
		m.Title = fmt.Sprintf("Updating to %s: downloading %d%%", u.Running, u.Percent())
		m.ShowCancel = true
	case u.Running != "" && u.Phase == "verifying":
		m.Title = fmt.Sprintf("Updating to %s: checking the download…", u.Running)
	case u.Running != "" && u.Phase == "waiting":
		m.Title = fmt.Sprintf("Updating to %s: waiting for Windows…", u.Running)
	case u.Available != "":
		m.Title = fmt.Sprintf("Encore Bridge %s is available", u.Available)
		m.ShowAction, m.ShowNotes = true, true
	}
	return m
}

// Percent of the download done (0-100).
func (u UpdateTray) Percent() int {
	if u.Total <= 0 {
		return 0
	}
	p := int(u.Done * 100 / u.Total)
	if p > 100 {
		p = 100
	}
	if p < 0 {
		p = 0
	}
	return p
}

// TooltipSuffix is added to the tray's tooltip: " · 1.2.0 available" (§5.2).
func (u UpdateTray) TooltipSuffix() string {
	if u.Available == "" {
		return ""
	}
	return " · " + u.Available + " available"
}

// AboutLine is the About box's update line (§5.2).
func (u UpdateTray) AboutLine() string {
	switch {
	case u.AutoOff == "dev_build":
		return "Updates: development build (it doesn't look for updates)"
	case u.Available != "":
		return "Updates: " + u.Available + " available"
	case u.AutoOff == "setting":
		return "Updates: automatic checks off"
	case u.State == "up_to_date" && !u.CheckedAt.IsZero():
		return "Updates: up to date (checked " + u.CheckedAt.Local().Format("2 Jan 2006") + ")"
	case u.State == "error":
		return "Updates: the last check didn't work"
	}
	return "Updates: not checked yet"
}

// ---- §5.9 texts

// MB formats a size for the texts: "31.0 MB".
func MB(n int64) string { return fmt.Sprintf("%.1f MB", float64(n)/(1<<20)) }

// UpdateConfirmText is the Update now… question (installer).
func UpdateConfirmText(v, cur string, size int64) string {
	return fmt.Sprintf("Update Encore Bridge to %s?\n\nYou have %s. Encore Bridge downloads the installer from GitHub (%s), "+
		"checks it against Encore's signed checksum list, and then Windows asks for permission to install it.\n\n"+
		"Phones stop playing for about a minute while the bridge restarts. Your settings, Spotify sign-ins and paired "+
		"phones stay.\n\nAfterwards, update the Encore app on your phone too: Cydia → Changes → Refresh.", v, cur, MB(size))
}

// UpToDateText answers a manual check.
func UpToDateText(cur string) string { return fmt.Sprintf("Encore Bridge %s is up to date.", cur) }

// AvailableText answers a manual check that found a newer version.
func AvailableText(v, cur, kind string) string {
	q := "Update now?"
	if kind == KindZip {
		q = "Open the download page?"
	}
	return fmt.Sprintf("Encore Bridge %s is available (you have %s).\n\n%s", v, cur, q)
}

// DevBuildText answers a manual check in a development build.
const DevBuildText = "This is a development build, so it doesn't look for updates."

// UpdatedText is shown once after an update (--updated).
func UpdatedText(v string) string {
	return fmt.Sprintf("Encore Bridge is now version %s.\n\nUpdate the Encore app on your phone too: Cydia → Changes → Refresh.", v)
}

// UpdateFailedText is shown when an update didn't finish (--update-failed, or a stale pending update).
func UpdateFailedText(v, cur string) string {
	return fmt.Sprintf("The update to Encore Bridge %s didn't finish, so Encore Bridge %s was started again.\n\n"+
		"Try Update now again later, or download the installer from the release page. Setup's log: "+
		`%%LOCALAPPDATA%%\Encore\updates\%s\setup.log`, v, cur, v)
}

// UpdateReadyText is asked before Setup starts after Update now on the admin page: the click on Yes lets Windows
// bring its permission prompt to the front.
func UpdateReadyText(v string) string {
	return fmt.Sprintf("Encore Bridge %s is downloaded and checked against Encore's signed checksum list.\n\n"+
		"Install it now? Windows asks for permission next.", v)
}

// UpdateIncompleteText is shown when Setup restarted the launcher after an update that didn't finish and the program
// folder is no longer complete (Setup had already removed the old files). installer is the downloaded installer when
// it still matches Encore's signed checksum list, else "".
func UpdateIncompleteText(v, missing, installer, releasePage string) string {
	head := fmt.Sprintf("The update to Encore Bridge %s didn't finish, and Encore Bridge can't start: %s is missing.", v, missing)
	if v == "" {
		head = fmt.Sprintf("An update of Encore Bridge didn't finish, and Encore Bridge can't start: %s is missing.", missing)
	}
	run := "Download the installer again from the release page and run it:\n" + releasePage
	if installer != "" {
		run = "Run the installer again to finish the update. It is downloaded and still matches Encore's signed checksum " +
			"list:\n" + installer + "\n\nOr download it again from the release page:\n" + releasePage
	}
	return head + "\n\n" + run + "\n\nYour settings, Spotify sign-ins and paired phones are kept."
}

// UpdateErrorArgs fills the placeholders of an error text.
type UpdateErrorArgs struct {
	Version    string    // {v}
	Current    string    // {cur}
	HTTPStatus int       // {n} for http_error
	ExitCode   uint32    // {n} for setup_failed
	RetryAt    time.Time // {time} for rate_limited
	Size       int64     // {size} for no_space
	Now        time.Time
}

// UpdateErrorText is the §5.9 text for an error code ("" for an unknown code).
func UpdateErrorText(code string, a UpdateErrorArgs) string {
	switch code {
	case "offline":
		return "Couldn't reach GitHub. Check that this computer is online; Encore Bridge tries again later."
	case "timeout":
		return "GitHub didn't answer in time. Try again in a minute."
	case "rate_limited":
		return "GitHub asked Encore Bridge to wait (too many requests from your network). It tries again after " + clockTime(a.RetryAt, a.Now) + "."
	case "http_error":
		return fmt.Sprintf("GitHub answered with an error (HTTP %d). Encore Bridge tries again tomorrow.", a.HTTPStatus)
	case "bad_answer":
		return "GitHub's answer couldn't be read. Encore Bridge tries again tomorrow."
	case "no_release":
		return "No Encore release is published yet."
	case "incomplete_release":
		return fmt.Sprintf("Encore Bridge %s is published, but not all of its files are there yet. Encore Bridge looks again later.", a.Version)
	case "bad_signature":
		return fmt.Sprintf("Encore Bridge %s is published, but its checksum list isn't signed with Encore's release key, so it isn't offered. "+
			"Don't install it from anywhere else; see the project page on GitHub.", a.Version)
	case "sums_entry_missing":
		return fmt.Sprintf("Encore Bridge %s's signed checksum list doesn't include the file this computer needs, so it isn't offered.", a.Version)
	case "download_failed":
		return "The download stopped. Choose Update now again to continue where it stopped."
	case "no_space":
		return fmt.Sprintf("There isn't enough free space for the update: %s is needed on the drive that holds %%LOCALAPPDATA%%.", MB(a.Size))
	case "hash_mismatch":
		return "The downloaded installer doesn't match Encore's signed checksum list, so it was deleted and not run. Try again later."
	case "setup_cancelled":
		return fmt.Sprintf("The update was cancelled. Encore Bridge %s is still installed.", a.Current)
	case "setup_failed":
		return fmt.Sprintf("The installer stopped before it finished (code %d). Encore Bridge %s is still installed.", a.ExitCode, a.Current)
	case "setup_start_failed":
		return "Windows couldn't start the installer. Try again, or download it from the release page."
	}
	return ""
}

// clockTime shows a time of day on this PC ("14:05"), with the date when it isn't today.
func clockTime(t, now time.Time) string {
	if t.IsZero() {
		return "a while"
	}
	t = t.Local()
	if now.IsZero() {
		now = time.Now()
	}
	n := now.Local()
	if t.Year() == n.Year() && t.YearDay() == n.YearDay() {
		return t.Format("15:04")
	}
	return t.Format("2 Jan 15:04")
}
