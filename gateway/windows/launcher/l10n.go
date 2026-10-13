//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"encore-bridge/launcher/internal/core"
	"encore-bridge/launcher/internal/l10n"
)

// The tray's texts are translated with the bridge's dictionaries (gateway\src\i18n\<code>.json, the admin page's), in
// the Windows display language; English is the key and the fallback (internal/l10n). Every translated text is a
// string literal in a tr or trf call in this folder, so the localization helper (bridge_l10n.py) can collect them;
// the texts internal/core builds are listed in l10n_core.go for the same reason.

// tr translates an English text.
func tr(s string) string { return l10n.Tr(s) }

// trf translates an English text and fills its {name} placeholders.
func trf(s string, vars l10n.Vars) string { return l10n.Trf(s, vars) }

var procGetUserDefaultUILanguage = kernel32.NewProc("GetUserDefaultUILanguage")

// uiLanguage is the Windows display language of this user (a LANGID; 0 when Windows can't say).
func uiLanguage() uint16 {
	if procGetUserDefaultUILanguage.Find() != nil {
		return 0
	}
	r, _, _ := procGetUserDefaultUILanguage.Call()
	return uint16(r)
}

// i18nDir is where the bundle puts the bridge's dictionaries: <program folder>\gateway\src\i18n.
func i18nDir(appDir string) string { return filepath.Join(appDir, "gateway", "src", "i18n") }

// languageNote describes the language choice for the log (codes and counts only).
var languageNote = "language: en"

// useLanguage picks the Windows display language and loads its dictionary from the program folder. Any problem leaves
// the texts in English.
func useLanguage(appDir string) {
	code := l10n.FromLANGID(uiLanguage())
	if code == l10n.English {
		return
	}
	d, err := l10n.Load(i18nDir(appDir), code)
	switch {
	case errors.Is(err, os.ErrNotExist):
		languageNote = "language: " + code + " (no dictionary in this build: English)"
	case err != nil:
		languageNote = "language: " + code + " (the dictionary couldn't be read: English)"
	default:
		l10n.Use(d)
		languageNote = fmt.Sprintf("language: %s (%d texts)", code, d.Len())
	}
}

// logLanguage writes the language choice to the log once it is open.
func logLanguage(lg *core.RotatingLog) { lg.Launcher("I", "%s", languageNote) }
