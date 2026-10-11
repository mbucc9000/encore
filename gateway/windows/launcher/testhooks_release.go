//go:build windows && !encoreupdatetest

package main

import (
	"flag"

	"encore-bridge/launcher/internal/core"
	"encore-bridge/launcher/internal/update"
)

// A release build has no test hooks (DESIGN-UPDATES.md §9): the update check always uses the real GitHub with the
// embedded keys, dialogs are real, and there are no test options. testhooks_updatetest.go is the test build's
// counterpart (go build -tags encoreupdatetest); build_windows.py checks that the release exe contains none of its
// strings.

func registerTestFlags(*flag.FlagSet) {}

// applyUpdateTestConfig leaves the release configuration alone.
func applyUpdateTestConfig(*update.Config) (enabled bool, warning string) { return true, "" }

// startUpdateTest is the test build's headless --update-test run; nothing in a release build.
func startUpdateTest(*updater) {}

func setTestLog(*core.RotatingLog) {}

// testDialog never answers for the user in a release build.
func testDialog(string, uint32) (int32, bool) { return 0, false }
