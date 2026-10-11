//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/windows"

	"encore-bridge/launcher/internal/core"
	"encore-bridge/launcher/internal/update"
)

// updater is the launcher's part of the update system (DESIGN-UPDATES.md §5): the daily check and Check for updates,
// the tray's "is available" item, Update now (fresh signature check, download, hash check through a locked handle,
// Setup started with "open" so it elevates itself), the view it pushes to the bridge for the admin page and the
// requests it picks up from there, and what happens after Setup (--updated, --update-failed).
//
// It never downloads or runs an installer by itself: only after the user chose Update now (in the tray, or on the
// admin page opened on this PC), and Windows' prompt still follows. Log lines carry codes and versions only.
type updater struct {
	a      *app
	log    *core.RotatingLog
	layout core.Layout
	cl     *update.Client // nil: no update checks in this build (a test build without its fake GitHub)
	kind   string
	sched  update.Scheduler // automatic contacts of this process (schedule goroutine only)
	ctx    context.Context
	stop   context.CancelFunc
	pushCh chan struct{}

	checkMu sync.Mutex // one check at a time

	mu        sync.Mutex // guards the fields below
	st        update.State
	auto      bool // UPDATE_CHECK isn't 0 (re-read before each automatic check)
	checking  bool
	inst      *update.Install // the last Update now (running or ended)
	running   bool            // Update now is under way
	cancel    context.CancelFunc
	locked    *os.File // the verified installer, held so nobody can change it (§5.5)
	quitAsked bool
	handled   map[string]bool // admin-page request ids already acted on
	ack       string          // the id to acknowledge with the next push
	pushedTo  *client         // the gateway that has the current view
	noRoute   *client         // a gateway without POST /local/v1/update (older bridge): the tray alone shows updates
	badPush   *client         // a gateway that refused the view (logged once)
}

func newUpdater(a *app) *updater {
	u := &updater{a: a, log: a.log, layout: a.layout, handled: map[string]bool{}, pushCh: make(chan struct{}, 1)}
	u.ctx, u.stop = context.WithCancel(context.Background())
	u.kind = core.KindZip
	if installedHere(a.layout.AppDir) {
		u.kind = core.KindInstaller
	}
	cfg := update.Config{Current: version, Kind: u.kind, Keys: update.TrustedKeys, Logf: a.log.Launcher, FreeSpace: freeSpace}
	enabled, warning := applyUpdateTestConfig(&cfg)
	if warning != "" {
		a.log.Launcher("W", "%s", warning)
	}
	if enabled {
		if cl, err := update.New(cfg); err != nil {
			a.log.Launcher("W", "%v", err)
		} else {
			u.cl = cl
		}
	}
	u.st = update.LoadState(a.layout.UpdateFile())
	if u.cl != nil && u.cl.DropUntrusted(&u.st) { // verified by a key this version no longer trusts (§4.5)
		a.log.Launcher("I", "update: forgot a stored check whose key isn't trusted any more")
		u.save(u.st.Clone())
	}
	u.auto = u.readAutoSetting()
	return u
}

// readAutoSetting: UPDATE_CHECK from the environment, else settings.env; 0, false, no or off turn the automatic
// check off (§9).
func (u *updater) readAutoSetting() bool {
	s, _ := core.LoadSettings(u.layout.Settings())
	v, ok := core.Lookup("UPDATE_CHECK", os.LookupEnv, s)
	if !ok {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "0", "false", "no", "off":
		return false
	}
	return true
}

// start runs once the tray is up.
func (u *updater) start(updated, failed bool) {
	u.afterSetup(updated, failed)
	u.cleanup()
	u.a.spawn("update schedule", u.scheduleLoop)
	u.a.spawn("update push", u.pushLoop)
	startUpdateTest(u) // the update test build's --update-test; nothing in a release build
}

// shutdown stops the loops and a download (the .part is kept for a resume).
func (u *updater) shutdown() { u.stop() }

func (u *updater) save(s update.State) {
	if err := update.SaveState(u.layout.UpdateFile(), s); err != nil {
		u.log.Launcher("W", "update: couldn't save update.json")
	}
}

// changed re-renders the tray and pushes the view to the bridge.
func (u *updater) changed() {
	select {
	case u.pushCh <- struct{}{}:
	default:
	}
	u.a.kick()
}

// view is the current update view (§8.3).
func (u *updater) view() update.View {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.viewLocked()
}

func (u *updater) viewLocked() update.View {
	var inst *update.Install
	if u.inst != nil {
		c := *u.inst
		inst = &c
	}
	return update.MakeView(&u.st, u.kind, version, u.auto, u.checking, inst)
}

// trayInfo is what the tray renders.
func (u *updater) trayInfo() core.UpdateTray {
	u.mu.Lock()
	defer u.mu.Unlock()
	v := u.viewLocked()
	t := core.UpdateTray{Kind: u.kind, Current: version, State: v.State}
	if v.AutoOff != nil {
		t.AutoOff = *v.AutoOff
	}
	if v.Latest != nil {
		t.Available = v.Latest.Version
	}
	if i := v.Install; i.Running() {
		t.Running, t.Phase, t.Done, t.Total = i.Version, i.Phase, i.Done, i.Total
	}
	if u.st.CheckedAt != nil {
		t.CheckedAt = *u.st.CheckedAt
	}
	return t
}

// ---- after Setup (§5.8) and clean-up (§5.4)

func (u *updater) afterSetup(updated, failed bool) {
	u.mu.Lock()
	p := u.st.Pending
	u.mu.Unlock()
	forget := func(failedTo string) {
		u.mu.Lock()
		u.st.Pending = nil
		u.st.FailedUpdate = failedTo // its folder keeps Setup's log
		s := u.st.Clone()
		u.mu.Unlock()
		u.save(s)
	}
	switch {
	case p != nil && p.To == version && !failed:
		// --updated, or any start of the version the update installed (Setup's own restart may have found this
		// launcher already started by the user)
		u.log.Launcher("I", "updated from %s to %s", p.From, p.To)
		forget("")
		u.a.spawn("updated", func() { msgBox(core.UpdatedText(version), mbInfo) })
	case updated:
		u.log.Launcher("W", "started after an update, but no update to %s was recorded", version)
	case failed:
		if p == nil {
			u.log.Launcher("W", "the update didn't finish (Setup restarted the launcher)")
			return
		}
		u.log.Launcher("W", "the update to %s didn't finish (Setup restarted the launcher)", p.To)
		forget(p.To)
		u.a.spawn("update failed", func() { msgBox(core.UpdateFailedText(p.To, version), mbWarn) })
	case p != nil && time.Since(p.StartedAt) > 15*time.Minute:
		u.log.Launcher("W", "the update to %s didn't finish", p.To)
		forget(p.To)
		u.a.spawn("update failed", func() { msgBox(core.UpdateFailedText(p.To, version), mbWarn) })
	}
}

// incompleteAfterUpdate is for a launcher that finds its program folder incomplete (missing: the file, relative to
// it) while an update is involved: started by Setup with --update-failed, or update.json still records an update as
// pending. Setup had already removed the old files before it stopped (§5.7), so the old version can't run either. It
// logs this (versions and the file name only), forgets the pending update, and returns the text to show: it points to
// the downloaded installer when that still matches the signed checksum list, else to the release page. ok=false: no
// update is involved (the plain "incomplete" message applies).
func incompleteAfterUpdate(layout core.Layout, updateFailed bool, missing string) (text string, ok bool) {
	st := update.LoadState(layout.UpdateFile())
	p := st.Pending
	if p == nil && !updateFailed {
		return "", false
	}
	to := st.FailedUpdate
	if p != nil {
		to = p.To
	}
	if os.MkdirAll(layout.LogsDir(), 0o700) == nil {
		home, _ := os.UserHomeDir()
		if lg, err := core.OpenLog(layout.LogFile(), 5<<20, 3, core.NewRedactor(home)); err == nil {
			setTestLog(lg) // (left open: the launcher exits after the message)
			lg.Launcher("I", "Encore Bridge launcher %s starting (Windows %s)", version, windowsVersion())
			if updateFailed {
				lg.Launcher("I", "started by Setup after an update that didn't finish (--update-failed)")
			}
			v := to
			if v == "" {
				v = "a new version"
			}
			lg.Launcher("E", "the update to %s didn't finish and left the program folder incomplete (%s is missing)", v, missing)
		}
	}
	if p != nil {
		st.Pending, st.FailedUpdate = nil, p.To // its folder keeps the installer and Setup's log
		update.SaveState(layout.UpdateFile(), st)
	}
	page := update.DownloadBase + "/" + update.Repo + "/releases"
	installer := ""
	if to != "" {
		page = update.NotesURL(to)
		installer = checkedInstaller(layout, to)
	}
	return core.UpdateIncompleteText(to, missing, installer, page), true
}

// checkedInstaller is the downloaded installer of version v when it still matches the signed checksum list saved next
// to it by Update now (the signature and the SHA-256 are checked again here), else "".
func checkedInstaller(layout core.Layout, v string) string {
	dir := filepath.Join(layout.UpdatesDir(), v)
	sums, err1 := os.ReadFile(filepath.Join(dir, update.SumsName))
	sig, err2 := os.ReadFile(filepath.Join(dir, update.SigName))
	if err1 != nil || err2 != nil {
		return ""
	}
	cfg := update.Config{Keys: update.TrustedKeys}
	applyUpdateTestConfig(&cfg) // the update test build's test key; nothing in a release build
	keys := append(append([]update.Key(nil), cfg.Keys...), cfg.TestKeys...)
	if _, _, ok := update.VerifySums(sums, sig, keys); !ok {
		return ""
	}
	list, err := update.ParseSums(sums)
	name := update.InstallerName(v)
	h, found := list[name]
	if err != nil || !found {
		return ""
	}
	f, err := openLocked(filepath.Join(dir, name))
	if err != nil {
		return ""
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || update.VerifyFile(f, h, fi.Size()) != nil {
		return ""
	}
	p, err := finalPath(f)
	if err != nil {
		return ""
	}
	return p
}

// cleanup deletes update folders of versions up to the running one (the update is done) and any older than 30 days.
// A failed update's folder (with Setup's log) stays until it is 30 days old.
func (u *updater) cleanup() {
	dir := u.layout.UpdatesDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cur, okCur := update.ParseCurrent(version)
	u.mu.Lock()
	busy, failed := "", u.st.FailedUpdate
	if u.running && u.inst != nil {
		busy = u.inst.Version
	}
	u.mu.Unlock()
	for _, e := range entries {
		if !e.IsDir() || e.Name() == busy {
			continue
		}
		old := false
		if v, ok := update.ParseRelease(e.Name()); ok && okCur && update.Compare(v, cur) <= 0 && e.Name() != failed {
			old = true
		}
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > 30*24*time.Hour {
			old = true
		}
		if old {
			os.RemoveAll(filepath.Join(dir, e.Name()))
		}
	}
}

// ---- checks (§2)

func (u *updater) scheduleLoop() {
	t := time.NewTimer(update.FirstEval)
	defer t.Stop()
	for {
		select {
		case <-u.ctx.Done():
			return
		case <-t.C:
		}
		u.maybeAuto()
		t.Reset(update.EvalEvery)
	}
}

// maybeAuto is the quiet automatic check: only when UPDATE_CHECK allows it, the stored schedule says it's due, and
// this process hasn't contacted GitHub automatically in the last 23 hours.
func (u *updater) maybeAuto() {
	if u.cl == nil || u.cl.Dev() {
		return
	}
	auto := u.readAutoSetting()
	now := time.Now() // carries the monotonic clock the Scheduler relies on
	u.mu.Lock()
	changedSetting := auto != u.auto
	u.auto = auto
	due, fixed := update.AutoCheckDue(&u.st, &u.sched, now, now, auto)
	busy := u.running
	s := u.st.Clone()
	u.mu.Unlock()
	if fixed {
		u.save(s)
	}
	if changedSetting {
		u.changed()
	}
	if !due || busy {
		return
	}
	if rep := u.runCheck(false); rep.Contacted {
		u.sched.Contacted(now)
	}
}

// runCheck runs one check on a copy of the state and merges the result.
func (u *updater) runCheck(manual bool) update.Report {
	u.checkMu.Lock()
	defer u.checkMu.Unlock()
	u.mu.Lock()
	st := u.st.Clone()
	u.checking = true
	u.mu.Unlock()
	u.changed()
	rep := u.cl.Check(u.ctx, &st, manual)
	u.mu.Lock()
	u.st.MergeCheck(st)
	u.checking = false
	s := u.st.Clone()
	u.mu.Unlock()
	u.save(s)
	u.changed()
	return rep
}

// manualCheck is Check for updates (dialog: the tray answers with a dialog) or the admin page's Check now (no dialog:
// the page shows the result).
func (u *updater) manualCheck(dialog bool) {
	if u.cl == nil {
		if dialog {
			msgBox("Update checks are off in this build.", mbInfo)
		}
		return
	}
	if u.cl.Dev() {
		if dialog {
			msgBox(core.DevBuildText, mbInfo)
		}
		return
	}
	u.runCheck(true)
	if !dialog {
		return
	}
	v := u.view()
	switch {
	case v.Latest != nil && v.Install.Running():
		msgBox(u.trayInfo().Menu().Title+".", mbInfo)
	case v.Latest != nil:
		if !ask(core.AvailableText(v.Latest.Version, version, u.kind)) {
			return
		}
		if u.kind == core.KindZip {
			u.a.openPage(update.NotesURL(v.Latest.Version))
			return
		}
		u.installNow(false, true)
	case v.Error != nil:
		icon := uint32(mbWarn)
		if v.Error.Code == update.CodeNoRelease {
			icon = mbInfo
		}
		msgBox(core.UpdateErrorText(v.Error.Code, u.errArgs(v.Error)), icon)
	default:
		msgBox(core.UpToDateText(version), mbInfo)
	}
}

func (u *updater) errArgs(e *update.ViewError) core.UpdateErrorArgs {
	a := core.UpdateErrorArgs{Current: version, Now: time.Now()}
	if e != nil {
		if e.Version != nil {
			a.Version = *e.Version
		}
		if e.HTTPStatus != nil {
			a.HTTPStatus = *e.HTTPStatus
		}
		if e.RetryAt != nil {
			if t, err := time.Parse(time.RFC3339, *e.RetryAt); err == nil {
				a.RetryAt = t
			}
		}
	}
	return a
}

// ---- tray actions

// actionClicked is "Update now…" (installer) or "Download…" (zip).
func (u *updater) actionClicked() {
	if u.kind == core.KindZip {
		if t := u.trayInfo(); t.Available != "" {
			u.a.openPage(update.NotesURL(t.Available))
		}
		return
	}
	u.installNow(false, false)
}

func (u *updater) notesClicked() {
	if t := u.trayInfo(); t.Available != "" {
		u.a.openPage(update.NotesURL(t.Available))
	}
}

// cancelInstall stops a download (Cancel update, the admin page's Cancel); the .part stays for a resume.
func (u *updater) cancelInstall() {
	u.mu.Lock()
	c := u.cancel
	downloading := u.inst != nil && u.inst.Phase == update.PhaseDownloading
	u.mu.Unlock()
	if c != nil && downloading {
		c()
	}
}

// onQuit is called when the launcher quits: a download stops (kept for a resume), and if Setup is running (it asked
// the launcher to quit) the version it installs is returned for the log.
func (u *updater) onQuit() string {
	u.mu.Lock()
	u.quitAsked = true
	waiting := ""
	if u.inst != nil && u.inst.Phase == update.PhaseWaiting {
		waiting = u.inst.Version
	}
	u.mu.Unlock()
	u.stop()
	return waiting
}

// ---- Update now (§5.3 - §5.6)

// installNow downloads, verifies and starts Setup. fromAdmin: the admin page asked (the page was the user's click);
// confirmed: the user already said Yes (to "Update now?" after Check for updates).
func (u *updater) installNow(fromAdmin, confirmed bool) {
	if u.cl == nil {
		return
	}
	u.mu.Lock()
	if u.running || u.quitAsked {
		u.mu.Unlock()
		return // one update at a time; the tray shows the running one
	}
	ver, asset, _, ok := u.st.Available(version, u.kind)
	if !ok {
		u.mu.Unlock()
		if !fromAdmin {
			msgBox(core.UpToDateText(version), mbInfo)
		}
		return
	}
	if u.kind != core.KindInstaller {
		u.mu.Unlock()
		if !fromAdmin {
			u.a.openPage(update.NotesURL(ver))
		}
		return
	}
	u.running = true
	u.mu.Unlock()

	if !fromAdmin && !confirmed && !ask(core.UpdateConfirmText(ver, version, asset.Size)) {
		u.mu.Lock()
		u.running = false
		u.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(u.ctx)
	defer cancel()
	u.mu.Lock()
	u.cancel = cancel
	u.inst = &update.Install{Version: ver, Phase: update.PhaseDownloading, Total: asset.Size}
	u.mu.Unlock()
	u.changed()
	u.install(ctx, ver, asset, fromAdmin)
}

func (u *updater) setPhase(phase string) {
	u.mu.Lock()
	if u.inst != nil {
		u.inst.Phase = phase
	}
	u.mu.Unlock()
	u.changed()
}

// end finishes Update now: phase cancelled or failed with a code (and Setup's exit code), and the dialog for an error.
func (u *updater) end(phase, code string, exit *uint32) {
	u.mu.Lock()
	ver := ""
	if u.inst != nil {
		ver = u.inst.Version
		u.inst.Phase = phase
		if code != "" {
			c := code
			u.inst.Error = &c
		}
		u.inst.ExitCode = exit
	}
	u.running, u.cancel = false, nil
	quitting := u.quitAsked
	u.mu.Unlock()
	u.changed()
	if code == "" || quitting {
		return
	}
	a := core.UpdateErrorArgs{Version: ver, Current: version, Now: time.Now()}
	if exit != nil {
		a.ExitCode = *exit
	}
	if code == update.CodeNoSpace {
		if _, asset, _, ok := u.availableNow(); ok {
			a.Size = int64(update.FreeSpaceNeeded(asset.Size))
		}
	}
	icon := uint32(mbWarn)
	if code == update.CodeSetupCancelled {
		icon = mbInfo
	}
	u.a.once("update-error", func() { msgBox(core.UpdateErrorText(code, a), icon) })
}

func (u *updater) availableNow() (string, update.Asset, string, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.st.Available(version, u.kind)
}

func (u *updater) install(ctx context.Context, ver string, asset update.Asset, fromAdmin bool) {
	name := update.InstallerName(ver)
	dir := filepath.Join(u.layout.UpdatesDir(), ver)

	// §4.3 steps 1-4 again, with fresh files: the hash compared below is the one signed now
	vr := u.cl.VerifyRelease(ctx, ver, name)
	switch {
	case ctx.Err() != nil:
		u.log.Launcher("I", "update: cancelled")
		u.end(update.PhaseCancelled, "", nil)
		return
	case vr.Err != nil:
		u.log.Launcher("W", "update check failed: %s", vr.Err.Code)
		u.end(update.PhaseFailed, vr.Err.Code, nil)
		return
	case vr.Code != "":
		u.mu.Lock() // the release isn't offered any more
		u.st.Result = &update.Result{State: vr.Code, Version: ver}
		u.st.Verified = nil
		s := u.st.Clone()
		u.mu.Unlock()
		u.save(s)
		u.end(update.PhaseFailed, vr.Code, nil)
		return
	}
	// §5.5: the download folder must be a real folder: a junction put in place of updates\ or updates\<ver> (Encore
	// Bridge never makes one) is removed before anything is written through it
	for _, d := range []string{u.layout.UpdatesDir(), dir} {
		removed, err := noReparse(d)
		if removed {
			u.log.Launcher("W", "update: removed a link in place of a download folder")
		}
		if err != nil {
			u.log.Launcher("W", "update: a link in place of a download folder couldn't be removed")
			u.end(update.PhaseFailed, update.CodeDownloadFailed, nil)
			return
		}
	}
	if err := os.MkdirAll(dir, 0o700); err == nil {
		os.WriteFile(filepath.Join(dir, update.SumsName), vr.Sums, 0o600)
		os.WriteFile(filepath.Join(dir, update.SigName), vr.Sig, 0o600)
	}

	u.mu.Lock()
	st := u.st.Clone()
	u.mu.Unlock()
	path, err := u.cl.DownloadInstaller(ctx, dir, ver, asset, &st, func(done, total int64) {
		u.mu.Lock()
		if u.inst != nil {
			u.inst.Done, u.inst.Total = done, total
		}
		u.mu.Unlock()
		u.changed()
	})
	u.mu.Lock()
	u.st.Download = st.Download
	s := u.st.Clone()
	u.mu.Unlock()
	u.save(s)
	var f *update.Failure
	switch {
	case errors.Is(err, update.ErrCancelled):
		u.end(update.PhaseCancelled, "", nil)
		return
	case errors.As(err, &f):
		u.end(update.PhaseFailed, f.Code, nil)
		return
	case err != nil:
		u.end(update.PhaseFailed, update.CodeDownloadFailed, nil)
		return
	}

	// §4.3 step 5 / §5.5: size and SHA-256 through a handle nobody else can write, rename or delete through
	u.setPhase(update.PhaseVerifying)
	lf, err := update.OpenVerified(path, openLocked, vr.SHA256, asset.Size)
	if errors.Is(err, update.ErrHashMismatch) {
		u.log.Launcher("E", "update: %s doesn't match the signed checksum: deleted, not run", name)
		u.end(update.PhaseFailed, update.CodeHashMismatch, nil)
		return
	}
	if err != nil {
		u.end(update.PhaseFailed, update.CodeDownloadFailed, nil)
		return
	}
	// Setup is started by the locked file's real path, and logs next to it: a junction changed after the check can't
	// send Windows (or Setup's elevated log) anywhere else (§5.5)
	setupExe, err := finalPath(lf)
	if err != nil {
		lf.Close()
		u.log.Launcher("W", "update: the verified installer's path couldn't be read")
		u.end(update.PhaseFailed, update.CodeDownloadFailed, nil)
		return
	}
	u.log.Launcher("I", "update: verified %s (sha256 ok)", name)

	// From the admin page nobody clicked anything of this program's, so Windows wouldn't let Setup's permission prompt
	// come to the front (it would only flash on the taskbar): the user's click here hands it on (§5.6).
	if fromAdmin && !ask(core.UpdateReadyText(ver)) {
		lf.Close()
		u.log.Launcher("I", "update: not started (the user chose No)")
		u.end(update.PhaseCancelled, "", nil)
		return
	}

	// §5.6: Setup, with "open" (it elevates itself), in update mode
	u.mu.Lock()
	if u.quitAsked || ctx.Err() != nil {
		u.mu.Unlock()
		lf.Close()
		return
	}
	if old := u.locked; old != nil {
		old.Close()
	}
	u.locked = lf
	u.st.Pending = &update.Pending{From: version, To: ver, StartedAt: time.Now().UTC()}
	u.inst.Phase = update.PhaseWaiting
	s = u.st.Clone()
	u.mu.Unlock()
	u.save(s)
	u.changed()
	u.log.Launcher("I", "update: starting Setup for %s", ver)
	// /NOCANCEL: once Setup has quit the bridge and cleared the old program folders ([InstallDelete]), a cancel would
	// leave neither version complete (Inno Setup doesn't put replaced files back)
	params := `/SILENT /SUPPRESSMSGBOXES /NORESTART /SP- /NOCANCEL /ENCOREUPDATE=1 /LOG="` + filepath.Join(filepath.Dir(setupExe), "setup.log") + `"`
	h, err := shellStart(setupExe, params)
	if err != nil {
		var errno syscall.Errno
		n := uintptr(0)
		if errors.As(err, &errno) {
			n = uintptr(errno)
		}
		u.log.Launcher("W", "update: Windows couldn't start Setup (error %d)", n)
		u.clearPending()
		u.end(update.PhaseFailed, update.CodeSetupStartFailed, nil)
		return
	}
	code, _ := waitProcess(h)
	windows.CloseHandle(h)
	u.mu.Lock()
	quitting := u.quitAsked
	u.mu.Unlock()
	if quitting {
		return // Setup asked this launcher to quit: it is replacing it
	}
	// Setup ended before it asked Encore Bridge to quit: No to Windows' prompt, or Setup stopped early
	u.clearPending()
	cancelled := code == 2 || code == 5 || code == uint32(windows.ERROR_CANCELLED)
	how := "failed"
	if cancelled {
		how = "cancelled"
	}
	u.log.Launcher("I", "update: Setup ended before it asked Encore Bridge to quit (exit code %d): %s", code, how)
	if cancelled {
		u.end(update.PhaseCancelled, update.CodeSetupCancelled, &code)
	} else {
		u.end(update.PhaseFailed, update.CodeSetupFailed, &code)
	}
}

// clearPending forgets a Setup that didn't take over, and lets go of the installer (it is verified again next time).
func (u *updater) clearPending() {
	u.mu.Lock()
	u.st.Pending = nil
	if u.locked != nil {
		u.locked.Close()
		u.locked = nil
	}
	s := u.st.Clone()
	u.mu.Unlock()
	u.save(s)
}

// ---- the admin page (§5.10): the view pushed to the bridge, the requests picked up from its status

func (u *updater) requestPush() {
	select {
	case u.pushCh <- struct{}{}:
	default:
	}
}

// pushLoop pushes the view after each change, at most once a second.
func (u *updater) pushLoop() {
	var last time.Time
	for {
		select {
		case <-u.ctx.Done():
			return
		case <-u.pushCh:
		}
		if d := time.Since(last); d < time.Second {
			select {
			case <-u.ctx.Done():
				return
			case <-time.After(time.Second - d):
			}
		}
		last = time.Now()
		u.push()
	}
}

func (u *updater) push() {
	_, _, _, _, cl := u.a.bridge.snapshot()
	if cl == nil {
		return
	}
	u.mu.Lock()
	if cl == u.noRoute {
		u.mu.Unlock()
		return
	}
	v := u.viewLocked()
	ack := u.ack
	v.HandledRequest = ack
	u.mu.Unlock()
	err := cl.pushUpdate(v)
	var se statusError
	u.mu.Lock()
	defer u.mu.Unlock()
	switch {
	case err == nil:
		u.pushedTo = cl
		if u.ack == ack {
			u.ack = ""
		}
	case errors.As(err, &se) && se.code == 404:
		u.noRoute = cl // an older bridge: the tray alone shows updates
	case errors.As(err, &se) && u.badPush != cl:
		u.badPush = cl
		u.log.Launcher("W", "update: the bridge refused the update view (HTTP %d)", se.code)
	}
}

// onStatus is called with every status the poller reads: a new gateway gets the view, and an admin-page request is
// acted on once.
func (u *updater) onStatus(cl *client, req *core.UpdateRequest) {
	u.mu.Lock()
	fresh := cl != nil && cl != u.pushedTo && cl != u.noRoute
	u.mu.Unlock()
	if fresh {
		u.requestPush()
	}
	if !req.Valid() {
		return
	}
	u.mu.Lock()
	if u.handled[req.ID] {
		u.mu.Unlock()
		return
	}
	if len(u.handled) > 64 {
		u.handled = map[string]bool{}
	}
	u.handled[req.ID] = true
	u.ack = req.ID
	u.mu.Unlock()
	switch req.Action {
	case "check":
		u.a.spawn("update check", func() { u.manualCheck(false) })
	case "install":
		u.a.spawn("update", func() { u.installNow(true, true) })
	case "cancel":
		u.cancelInstall()
	}
	u.requestPush()
}
