package core

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestUpdateMenu(t *testing.T) {
	cases := []struct {
		u    UpdateTray
		want UpdateMenu
	}{
		{UpdateTray{Kind: KindInstaller}, UpdateMenu{Action: "Update now…"}},
		{UpdateTray{Kind: KindInstaller, Available: "1.2.0"},
			UpdateMenu{Title: "Encore Bridge 1.2.0 is available", ShowAction: true, Action: "Update now…", ShowNotes: true}},
		{UpdateTray{Kind: KindZip, Available: "1.2.0"},
			UpdateMenu{Title: "Encore Bridge 1.2.0 is available", ShowAction: true, Action: "Download…", ShowNotes: true}},
		{UpdateTray{Kind: KindInstaller, Available: "1.2.0", Running: "1.2.0", Phase: "downloading", Done: 1 << 20, Total: 4 << 20},
			UpdateMenu{Title: "Updating to 1.2.0: downloading 25%", Action: "Update now…", ShowCancel: true}},
		{UpdateTray{Kind: KindInstaller, Available: "1.2.0", Running: "1.2.0", Phase: "verifying"},
			UpdateMenu{Title: "Updating to 1.2.0: checking the download…", Action: "Update now…"}},
		{UpdateTray{Kind: KindInstaller, Available: "1.2.0", Running: "1.2.0", Phase: "waiting"},
			UpdateMenu{Title: "Updating to 1.2.0: waiting for Windows…", Action: "Update now…"}},
	}
	for i, c := range cases {
		if got := c.u.Menu(); got != c.want {
			t.Errorf("%d: %+v, want %+v", i, got, c.want)
		}
	}
	if p := (UpdateTray{Done: 5, Total: 0}).Percent(); p != 0 {
		t.Error(p)
	}
	if p := (UpdateTray{Done: 7, Total: 5}).Percent(); p != 100 {
		t.Error(p)
	}
}

func TestUpdateTooltipAndAbout(t *testing.T) {
	in := Input{State: StateRunning, Status: readyStatus(), LauncherVersion: "1.1.0", Update: UpdateTray{Kind: KindInstaller, Available: "1.2.0"}}
	v := Compute(in)
	if v.Tooltip != "Encore Bridge: Ready · 1.2.0 available" || v.Icon != IconOK {
		t.Errorf("tooltip %q icon %s", v.Tooltip, v.Icon)
	}
	in.Update = UpdateTray{}
	if v := Compute(in); v.Tooltip != "Encore Bridge: Ready" {
		t.Errorf("tooltip %q", v.Tooltip)
	}
	long := Compute(Input{State: StateFailed, FailReason: FailExit, ExitCode: ExitPortInUse, Port: 8095,
		Update: UpdateTray{Available: "9999.9999.9999"}})
	if n := len([]rune(long.Tooltip)); n > 128 {
		t.Errorf("tooltip has %d characters", n)
	}

	checked := time.Date(2026, 10, 10, 12, 0, 0, 0, time.Local)
	for _, c := range []struct {
		u    UpdateTray
		want string
	}{
		{UpdateTray{State: "up_to_date", CheckedAt: checked}, "Updates: up to date (checked 10 Oct 2026)"},
		{UpdateTray{Available: "1.2.0", State: "available"}, "Updates: 1.2.0 available"},
		{UpdateTray{AutoOff: "setting", State: "never"}, "Updates: automatic checks off"},
		{UpdateTray{AutoOff: "setting", Available: "1.2.0"}, "Updates: 1.2.0 available"},
		{UpdateTray{AutoOff: "dev_build"}, "Updates: development build (it doesn't look for updates)"},
		{UpdateTray{State: "never"}, "Updates: not checked yet"},
		{UpdateTray{State: "error"}, "Updates: the last check didn't work"},
	} {
		if got := c.u.AboutLine(); got != c.want {
			t.Errorf("%+v: %q, want %q", c.u, got, c.want)
		}
	}
}

func readyStatus() *Status {
	var s Status
	json.Unmarshal([]byte(`{"contract":1,"bridge":{"version":"1.1.0"},"engine":{"state":"running","signed_in":true},`+
		`"admin":{"setup_needed":false},"spotify":{"connected":true},"phones":{"paired":1,"listening":0},"showcase":false}`), &s)
	return &s
}

// The §5.9 texts, exactly (the admin page and the docs quote them).
func TestUpdateTexts(t *testing.T) {
	if got := UpdateConfirmText("1.2.0", "1.1.0", 32443228); got != "Update Encore Bridge to 1.2.0?\n\nYou have 1.1.0. Encore Bridge downloads the installer "+
		"from GitHub (30.9 MB), checks it against Encore's signed checksum list, and then Windows asks for permission to install it.\n\n"+
		"Phones stop playing for about a minute while the bridge restarts. Your settings, Spotify sign-ins and paired phones stay.\n\n"+
		"Afterwards, update the Encore app on your phone too: Cydia → Changes → Refresh." {
		t.Errorf("confirm: %q", got)
	}
	if UpToDateText("1.1.0") != "Encore Bridge 1.1.0 is up to date." {
		t.Error("up to date")
	}
	if AvailableText("1.2.0", "1.1.0", KindInstaller) != "Encore Bridge 1.2.0 is available (you have 1.1.0).\n\nUpdate now?" ||
		AvailableText("1.2.0", "1.1.0", KindZip) != "Encore Bridge 1.2.0 is available (you have 1.1.0).\n\nOpen the download page?" {
		t.Error("available")
	}
	if UpdatedText("1.2.0") != "Encore Bridge is now version 1.2.0.\n\nUpdate the Encore app on your phone too: Cydia → Changes → Refresh." {
		t.Error("updated")
	}
	if got := UpdateFailedText("1.2.0", "1.1.0"); got != "The update to Encore Bridge 1.2.0 didn't finish, so Encore Bridge 1.1.0 was started again.\n\n"+
		"Try Update now again later, or download the installer from the release page. Setup's log: %LOCALAPPDATA%\\Encore\\updates\\1.2.0\\setup.log" {
		t.Errorf("failed: %q", got)
	}
	if UpdateReadyText("1.2.0") != "Encore Bridge 1.2.0 is downloaded and checked against Encore's signed checksum list.\n\n"+
		"Install it now? Windows asks for permission next." {
		t.Error("ready")
	}
	page := "https://github.com/mbucc9000/encore/releases/tag/v1.2.0"
	if got := UpdateIncompleteText("1.2.0", `runtime\node.exe`, `C:\U\AppData\Local\Encore\updates\1.2.0\EncoreBridge-1.2.0-setup.exe`, page); got !=
		"The update to Encore Bridge 1.2.0 didn't finish, and Encore Bridge can't start: runtime\\node.exe is missing.\n\n"+
			"Run the installer again to finish the update. It is downloaded and still matches Encore's signed checksum list:\n"+
			"C:\\U\\AppData\\Local\\Encore\\updates\\1.2.0\\EncoreBridge-1.2.0-setup.exe\n\nOr download it again from the release page:\n"+page+
			"\n\nYour settings, Spotify sign-ins and paired phones are kept." {
		t.Errorf("incomplete: %q", got)
	}
	if got := UpdateIncompleteText("", `runtime\node.exe`, "", page); !strings.HasPrefix(got, "An update of Encore Bridge didn't finish") ||
		!strings.Contains(got, "Download the installer again from the release page and run it:\n"+page) {
		t.Errorf("incomplete, no installer: %q", got)
	}
	now := time.Date(2026, 10, 10, 13, 0, 0, 0, time.Local)
	a := UpdateErrorArgs{Version: "1.2.0", Current: "1.1.0", HTTPStatus: 502, ExitCode: 7, RetryAt: now.Add(65 * time.Minute), Size: 32443228, Now: now}
	want := map[string]string{
		"offline":            "Couldn't reach GitHub. Check that this computer is online; Encore Bridge tries again later.",
		"timeout":            "GitHub didn't answer in time. Try again in a minute.",
		"rate_limited":       "GitHub asked Encore Bridge to wait (too many requests from your network). It tries again after 14:05.",
		"http_error":         "GitHub answered with an error (HTTP 502). Encore Bridge tries again tomorrow.",
		"bad_answer":         "GitHub's answer couldn't be read. Encore Bridge tries again tomorrow.",
		"no_release":         "No Encore release is published yet.",
		"incomplete_release": "Encore Bridge 1.2.0 is published, but not all of its files are there yet. Encore Bridge looks again later.",
		"bad_signature":      "Encore Bridge 1.2.0 is published, but its checksum list isn't signed with Encore's release key, so it isn't offered. Don't install it from anywhere else; see the project page on GitHub.",
		"sums_entry_missing": "Encore Bridge 1.2.0's signed checksum list doesn't include the file this computer needs, so it isn't offered.",
		"download_failed":    "The download stopped. Choose Update now again to continue where it stopped.",
		"no_space":           "There isn't enough free space for the update: 30.9 MB is needed on the drive that holds %LOCALAPPDATA%.",
		"hash_mismatch":      "The downloaded installer doesn't match Encore's signed checksum list, so it was deleted and not run. Try again later.",
		"setup_cancelled":    "The update was cancelled. Encore Bridge 1.1.0 is still installed.",
		"setup_failed":       "The installer stopped before it finished (code 7). Encore Bridge 1.1.0 is still installed.",
		"setup_start_failed": "Windows couldn't start the installer. Try again, or download it from the release page.",
	}
	for code, w := range want {
		if got := UpdateErrorText(code, a); got != w {
			t.Errorf("%s: %q", code, got)
		}
	}
	if UpdateErrorText("nope", a) != "" {
		t.Error("unknown code")
	}
	if got := UpdateErrorText("rate_limited", UpdateErrorArgs{RetryAt: now.Add(30 * time.Hour), Now: now}); !strings.Contains(got, "11 Oct 19:00") {
		t.Errorf("another day: %q", got)
	}
}

func TestUpdateRequestValid(t *testing.T) {
	for _, c := range []struct {
		r  *UpdateRequest
		ok bool
	}{
		{&UpdateRequest{ID: "0123456789abcdef", Action: "check"}, true},
		{&UpdateRequest{ID: "0123456789abcdef", Action: "install"}, true},
		{&UpdateRequest{ID: "0123456789abcdef", Action: "cancel"}, true},
		{&UpdateRequest{ID: "0123456789abcdef", Action: "run"}, false},
		{&UpdateRequest{ID: "0123456789ABCDEF", Action: "check"}, false},
		{&UpdateRequest{ID: "0123", Action: "check"}, false},
		{nil, false},
	} {
		if c.r.Valid() != c.ok {
			t.Errorf("%+v", c.r)
		}
	}
	s, err := ParseStatus([]byte(`{"contract":1,"update_request":{"id":"0123456789abcdef","action":"install"}}`))
	if err != nil || s.UpdateRequest == nil || s.UpdateRequest.Action != "install" {
		t.Errorf("status: %+v %v", s, err)
	}
	if s, _ := ParseStatus([]byte(`{"contract":1}`)); s.UpdateRequest != nil {
		t.Error("an older bridge has no update request")
	}
	l := Layout{AppDir: `C:\A`, DataRoot: `C:\D`}
	if !strings.HasSuffix(l.UpdateFile(), "update.json") || !strings.HasSuffix(l.UpdatesDir(), "updates") {
		t.Error("layout")
	}
}
