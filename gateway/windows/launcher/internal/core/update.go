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
	m := UpdateMenu{Action: tr("Update now…")}
	if u.Kind == KindZip {
		m.Action = tr("Download…")
	}
	switch {
	case u.Running != "" && u.Phase == "downloading":
		m.Title = trf("Updating to {version}: downloading {percent}%", vars{"version": u.Running, "percent": u.Percent()})
		m.ShowCancel = true
	case u.Running != "" && u.Phase == "verifying":
		m.Title = trf("Updating to {version}: checking the download…", vars{"version": u.Running})
	case u.Running != "" && u.Phase == "waiting":
		m.Title = trf("Updating to {version}: waiting for Windows…", vars{"version": u.Running})
	case u.Available != "":
		m.Title = trf("Encore Bridge {version} is available", vars{"version": u.Available})
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
	return " · " + trf("{version} available", vars{"version": u.Available})
}

// AboutLine is the About box's update line (§5.2).
func (u UpdateTray) AboutLine() string {
	switch {
	case u.AutoOff == "dev_build":
		return tr("Updates: development build (it doesn't look for updates)")
	case u.Available != "":
		return trf("Updates: {version} available", vars{"version": u.Available})
	case u.AutoOff == "setting":
		return tr("Updates: automatic checks off")
	case u.State == "up_to_date" && !u.CheckedAt.IsZero():
		return trf("Updates: up to date (checked {date})", vars{"date": u.CheckedAt.Local().Format("2 Jan 2006")})
	case u.State == "error":
		return tr("Updates: the last check didn't work")
	}
	return tr("Updates: not checked yet")
}

// ---- §5.9 texts

// MB formats a size for the texts: "31.0 MB".
func MB(n int64) string { return fmt.Sprintf("%.1f MB", float64(n)/(1<<20)) }

// UpdateConfirmText is the Update now… question (installer).
func UpdateConfirmText(v, cur string, size int64) string {
	return trf("Update Encore Bridge to {version}?\n\nYou have {current}. Encore Bridge downloads the installer from GitHub ({size}), checks Encore's signature on it, and then Windows asks for permission to install it.\n\nPhones stop playing for about a minute while the bridge restarts. Your settings, Spotify sign-ins and paired phones stay.\n\nAfterwards, update the Encore app on your phone too: Cydia → Changes → Refresh.",
		vars{"version": v, "current": cur, "size": MB(size)})
}

// UpToDateText answers a manual check.
func UpToDateText(cur string) string {
	return trf("Encore Bridge {version} is up to date.", vars{"version": cur})
}

// AvailableText answers a manual check that found a newer version.
func AvailableText(v, cur, kind string) string {
	q := tr("Update now?")
	if kind == KindZip {
		q = tr("Open the download page?")
	}
	return trf("Encore Bridge {version} is available (you have {current}).", vars{"version": v, "current": cur}) + "\n\n" + q
}

// DevBuildText answers a manual check in a development build.
func DevBuildText() string { return tr("This is a development build, so it doesn't look for updates.") }

// UpdatedText is shown once after an update (--updated).
func UpdatedText(v string) string {
	return trf("Encore Bridge is now version {version}.\n\nUpdate the Encore app on your phone too: Cydia → Changes → Refresh.", vars{"version": v})
}

// UpdateFailedText is shown when an update didn't finish (--update-failed, or a stale pending update).
func UpdateFailedText(v, cur string) string {
	return trf("The update to Encore Bridge {version} didn't finish, so Encore Bridge {current} was started again.\n\nTry Update now again later, or download the installer from the release page. Setup's log: {log}",
		vars{"version": v, "current": cur, "log": `%LOCALAPPDATA%\Encore\updates\` + v + `\setup.log`})
}

// UpdateReadyText is asked before Setup starts after Update now on the admin page: the click on Yes lets Windows
// bring its permission prompt to the front.
func UpdateReadyText(v string) string {
	return trf("Encore Bridge {version} is downloaded and matches Encore's signature.\n\nInstall it now? Windows asks for permission next.", vars{"version": v})
}

// UpdateIncompleteText is shown when Setup restarted the launcher after an update that didn't finish and the program
// folder is no longer complete (Setup had already removed the old files). installer is the downloaded installer when
// it still matches Encore's signature, else "".
func UpdateIncompleteText(v, missing, installer, releasePage string) string {
	head := trf("The update to Encore Bridge {version} didn't finish, and Encore Bridge can't start: {file} is missing.", vars{"version": v, "file": missing})
	if v == "" {
		head = trf("An update of Encore Bridge didn't finish, and Encore Bridge can't start: {file} is missing.", vars{"file": missing})
	}
	run := trf("Download the installer again from the release page and run it:\n{page}", vars{"page": releasePage})
	if installer != "" {
		run = trf("Run the installer again to finish the update. It is downloaded and still matches Encore's signature:\n{installer}\n\nOr download it again from the release page:\n{page}",
			vars{"installer": installer, "page": releasePage})
	}
	return head + "\n\n" + run + "\n\n" + tr("Your settings, Spotify sign-ins and paired phones are kept.")
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
		return tr("Couldn't reach GitHub. Check that this computer is online; Encore Bridge tries again later.")
	case "timeout":
		return tr("GitHub didn't answer in time. Try again in a minute.")
	case "rate_limited":
		if a.RetryAt.IsZero() {
			return tr("GitHub asked Encore Bridge to wait (too many requests from your network). It tries again after a while.")
		}
		return trf("GitHub asked Encore Bridge to wait (too many requests from your network). It tries again after {time}.", vars{"time": clockTime(a.RetryAt, a.Now)})
	case "http_error":
		return trf("GitHub answered with an error (HTTP {status}). Encore Bridge tries again tomorrow.", vars{"status": a.HTTPStatus})
	case "bad_answer":
		return tr("GitHub's answer couldn't be read. Encore Bridge tries again tomorrow.")
	case "no_release":
		return tr("No Encore release is published yet.")
	case "incomplete_release":
		return trf("Encore Bridge {version} is published, but not all of its files are there yet. Encore Bridge looks again later.", vars{"version": a.Version})
	case "bad_signature":
		return trf("Encore Bridge {version} is published, but it isn't signed with Encore's release key, so it isn't offered. Don't install it from anywhere else; see the project page on GitHub.", vars{"version": a.Version})
	case "sums_entry_missing":
		return trf("Encore's signature for Encore Bridge {version} doesn't cover the file this computer needs, so it isn't offered.", vars{"version": a.Version})
	case "download_failed":
		return tr("The download stopped. Choose Update now again to continue where it stopped.")
	case "no_space":
		return trf("There isn't enough free space for the update: {size} is needed on the drive that holds {folder}.", vars{"size": MB(a.Size), "folder": "%LOCALAPPDATA%"})
	case "hash_mismatch":
		return tr("The downloaded installer doesn't match Encore's signature, so it was deleted and not run. Try again later.")
	case "setup_cancelled":
		return trf("The update was cancelled. Encore Bridge {version} is still installed.", vars{"version": a.Current})
	case "setup_failed":
		return trf("The installer stopped before it finished (code {code}). Encore Bridge {version} is still installed.", vars{"code": a.ExitCode, "version": a.Current})
	case "setup_start_failed":
		return tr("Windows couldn't start the installer. Try again, or download it from the release page.")
	}
	return ""
}

// clockTime shows a time of day on this PC ("14:05"), with the date when it isn't today.
func clockTime(t, now time.Time) string {
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
