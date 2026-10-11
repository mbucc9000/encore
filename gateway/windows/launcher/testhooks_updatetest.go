//go:build windows && encoreupdatetest

package main

import (
	"flag"
	"os"
	"strings"
	"time"

	"encore-bridge/launcher/internal/core"
	"encore-bridge/launcher/internal/update"
)

// The update test build (go build -tags encoreupdatetest), for testdata/update-smoke.sh only (DESIGN-UPDATES.md §9,
// §14.3). It is never released: build_windows.py checks that a release exe holds none of these strings.
//
//	ENCORE_UPDATE_API, ENCORE_UPDATE_DOWNLOAD   the fake GitHub's loopback bases (both required: without them this
//	                                            build makes no update request at all, so it can't reach the real GitHub)
//	ENCORE_UPDATE_TEST_KEY                      a base64 public key trusted together with them (the RFC 8032 TEST 1 key)
//	--update-test check|install                 after start, check for updates (and install) with every dialog
//	                                            answered Yes and written to the log instead of shown

var updateTest *string

func registerTestFlags(fs *flag.FlagSet) {
	updateTest = fs.String("update-test", "", "test build: check or install, answering dialogs Yes")
}

func applyUpdateTestConfig(cfg *update.Config) (bool, string) {
	api, dl := os.Getenv("ENCORE_UPDATE_API"), os.Getenv("ENCORE_UPDATE_DOWNLOAD")
	if api == "" || dl == "" {
		return false, "update test build without ENCORE_UPDATE_API and ENCORE_UPDATE_DOWNLOAD: no update checks"
	}
	cfg.APIBase, cfg.DownloadBase = api, dl
	if k := strings.TrimSpace(os.Getenv("ENCORE_UPDATE_TEST_KEY")); k != "" {
		key := update.Key{Key: k, Name: "update-test"}
		if pub, err := key.Public(); err == nil {
			key.ID = update.KeyID(pub)
			cfg.TestKeys = append(cfg.TestKeys, key)
		}
	}
	return true, ""
}

// startUpdateTest runs --update-test after start: "check" checks and logs the view; "install" is Check for updates
// with every dialog answered Yes, so it goes on from "Update now?" to Setup.
func startUpdateTest(u *updater) {
	if updateTest == nil || *updateTest == "" {
		return
	}
	action := *updateTest
	u.a.spawn("update test", func() {
		// let the bridge answer first, so its admin page relay sees the whole update (at most 30 s)
		for i := 0; i < 150; i++ {
			u.mu.Lock()
			ready := u.pushedTo != nil || u.noRoute != nil
			u.mu.Unlock()
			if ready {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
		switch action {
		case "check":
			if u.cl != nil {
				u.runCheck(true)
			}
			v := u.view()
			latest := "none"
			if v.Latest != nil {
				latest = v.Latest.Version
			}
			u.log.Launcher("I", "[test] update view: state %s, kind %s, latest %s", v.State, v.Kind, latest)
		case "install":
			u.manualCheck(true)
			u.log.Launcher("I", "[test] update view: state %s", u.view().State)
		default:
			u.log.Launcher("W", "[test] unknown update test action")
		}
	})
}

var testLog *core.RotatingLog

func setTestLog(l *core.RotatingLog) { testLog = l }

// testDialog answers every dialog Yes and logs its first line.
func testDialog(text string, _ uint32) (int32, bool) {
	if testLog != nil {
		first, _, _ := strings.Cut(text, "\n")
		testLog.Launcher("I", "[test] dialog: %s", first)
	}
	return idYes, true
}
