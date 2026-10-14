//go:build windows

// Encore Bridge launcher (Windows): runs the bridge (runtime\node.exe gateway\src\main.js) with no console window,
// keeps it running, and gives it an icon in the notification area: status, the admin page (also opened at every
// start, unless turned off), the engine's Spotify sign-in code, Showcase mode, keep-awake while a phone listens, Start
// with Windows, logs, a firewall fixer, updates (update_windows.go: a daily check of Encore's signed GitHub releases,
// and Update now) and quit. The interface with the bridge is fixed in ../CONTRACT.md.
//
// Copyright (C) Encore contributors. GPL-3.0-or-later: this program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License, version 3 or (at your option) any later version. It
// comes with ABSOLUTELY NO WARRANTY.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows"

	"encore-bridge/launcher/internal/core"
	"encore-bridge/launcher/internal/l10n"
)

// version is the Encore release version, stamped by the build (-X main.version=1.1.0).
var version = "dev"

func main() {
	fs := flag.NewFlagSet("Encore Bridge", flag.ContinueOnError)
	autostart := fs.Bool("autostart", false, "started by Windows at sign-in (from the Run entry): the browser opens only with Open admin page on start")
	quit := fs.Bool("quit", false, "ask a running Encore Bridge to quit, wait for it, then exit (used by the installer)")
	autoOn := fs.Bool("autostart-enable", false, "turn Start with Windows on for this Windows user, then exit (used by the installer)")
	autoOff := fs.Bool("autostart-disable", false, "turn Start with Windows off for this Windows user, then exit")
	dataDir := fs.String("data-dir", "", `data folder (default: ENCORE_HOME, else %LOCALAPPDATA%\Encore)`)
	updated := fs.Bool("updated", false, "started by Setup after an update: like --autostart, then says the update is done")
	updateFailed := fs.Bool("update-failed", false, "started by Setup after an update that didn't finish: like --autostart, then says so")
	registerTestFlags(fs)
	fs.SetOutput(discard{})
	parseErr := fs.Parse(os.Args[1:])

	exe, err := os.Executable()
	if err != nil {
		fatal(trf("Encore Bridge can't find its own folder: {error}", l10n.Vars{"error": err}))
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	useLanguage(filepath.Dir(exe)) // the Windows display language, from the program folder's dictionaries
	if parseErr != nil {
		fatal(trf("Unknown option: {error}", l10n.Vars{"error": parseErr}))
	}

	switch {
	case *autoOn, *autoOff:
		if err := setAutostart(exe, *autoOn); err != nil {
			os.Exit(1)
		}
		return
	case *quit:
		if !signalEvent(quitEventName) {
			return // not running
		}
		if !waitInstanceGone(30 * time.Second) {
			os.Exit(1)
		}
		return
	}

	// --updated and --update-failed start like --autostart: the browser opens only while "Open admin page on start" is
	// on (the first-run rule leaves Windows' and Setup's starts alone)
	quiet := *autostart || *updated || *updateFailed
	layout := core.Layout{AppDir: filepath.Dir(exe), DataRoot: dataRoot(*dataDir)}
	inst, running, err := acquireInstance()
	if running {
		if core.SecondStartSignals(quiet, core.LoadPrefs(layout.PrefsFile())) {
			signalEvent(showEventName) // the running launcher brings the admin page up
		}
		return // (--updated / --update-failed are ignored then)
	}
	if err != nil {
		fatal(trf("Encore Bridge couldn't start: {error}", l10n.Vars{"error": err}))
	}
	defer inst.close()

	for _, f := range []string{layout.Node(), layout.MainJS()} {
		if _, err := os.Stat(f); err != nil {
			// let go of the single-instance mutex first: the reinstall this advises (or Setup restarting this launcher
			// after an update that didn't finish) must not find a launcher still running behind this message
			inst.close()
			// an update that stopped after Setup removed the old files: point to the checked installer (§5.7)
			if text, ok := incompleteAfterUpdate(layout, *updateFailed, rel(layout.AppDir, f)); ok {
				fatal(text)
			}
			fatal(trf("Encore Bridge is incomplete: {file} is missing.\n\nAntivirus software may have removed it. Reinstall Encore Bridge (or unzip the whole package again).",
				l10n.Vars{"file": rel(layout.AppDir, f)}))
		}
	}
	if err := os.MkdirAll(layout.LogsDir(), 0o700); err != nil {
		fatal(trf("Encore Bridge can't create its data folder:\n{folder}\n\n{error}", l10n.Vars{"folder": layout.DataRoot, "error": err}))
	}
	created, err := core.EnsureFile(layout.Settings(), layout.SettingsTemplate())
	if err != nil {
		fatal(trf("Encore Bridge can't create settings.env in its data folder:\n{folder}\n\n{error}", l10n.Vars{"folder": layout.DataRoot, "error": err}))
	}
	home, _ := os.UserHomeDir()
	lg, err := core.OpenLog(layout.LogFile(), 5<<20, 3, core.NewRedactor(home))
	if err != nil {
		fatal(trf("Encore Bridge can't write its log in:\n{folder}\n\n{error}", l10n.Vars{"folder": layout.LogsDir(), "error": err}))
	}
	defer lg.Close()
	setTestLog(lg)
	lg.Launcher("I", "Encore Bridge launcher %s starting (Windows %s)", version, windowsVersion())
	logLanguage(lg)
	switch {
	case *updated:
		lg.Launcher("I", "started by Setup after an update (--updated)")
	case *updateFailed:
		lg.Launcher("I", "started by Setup after an update that didn't finish (--update-failed)")
	}
	if created {
		lg.Launcher("I", "created settings.env from the template")
	}

	app, err := newApp(layout, exe, lg, quiet, created)
	if err != nil {
		lg.Launcher("E", "start: %v", err)
		fatal(trf("Encore Bridge couldn't start: {error}", l10n.Vars{"error": err}))
	}
	app.updated, app.updateFailed = *updated, *updateFailed
	inst.watch(app.quit, app.secondStart)
	app.run() // returns after Quit
	lg.Launcher("I", "launcher stopped")
}

// dataRoot: --data-dir, else ENCORE_HOME, else %LOCALAPPDATA%\Encore (CONTRACT.md §1).
func dataRoot(flagValue string) string {
	if flagValue != "" {
		return absOr(flagValue)
	}
	if v := os.Getenv("ENCORE_HOME"); v != "" {
		return absOr(v)
	}
	if p, err := windows.KnownFolderPath(windows.FOLDERID_LocalAppData, 0); err == nil && p != "" {
		return filepath.Join(p, "Encore")
	}
	if v := os.Getenv("LOCALAPPDATA"); v != "" {
		return filepath.Join(v, "Encore")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "AppData", "Local", "Encore")
}

func absOr(p string) string {
	if a, err := filepath.Abs(p); err == nil {
		return a
	}
	return p
}

func rel(base, p string) string {
	if r, err := filepath.Rel(base, p); err == nil {
		return r
	}
	return p
}

func windowsVersion() string {
	maj, min, build := windows.RtlGetNtVersionNumbers()
	return fmt.Sprintf("%d.%d.%d", maj, min, build)
}

// fatal shows a text (already translated) and exits.
func fatal(text string) {
	msgBox(text, mbError)
	os.Exit(1)
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }
