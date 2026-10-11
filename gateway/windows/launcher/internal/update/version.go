// Package update is the Windows launcher's update check (DESIGN-UPDATES.md): it asks GitHub for the newest final
// release of Encore at most once a day (and when the user asks), announces a release only after its Ed25519-signed
// checksum list verifies against a key built into the launcher, and downloads and verifies the installer when the user
// chooses Update now. It never starts anything itself: the launcher (update_windows.go) runs Setup after the user
// agreed, and Windows asks for permission.
//
// Nothing here touches the Windows API, so it is tested on any platform against a fake GitHub (fakegh). Nothing in
// this package ever contacts the real GitHub during tests: every test passes a loopback test server.
//
// Copyright (C) Encore contributors. GPL-3.0-or-later.
package update

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Version is major.minor.patch, with an optional semver prerelease part for a running version (1.1.0-rc5). Release
// tags never have one.
type Version struct {
	Major, Minor, Patch int
	Pre                 string
}

const num = `(0|[1-9][0-9]{0,3})`

var (
	// tagRe is the only accepted release tag (§2.5): v1.2.0, numbers without leading zeros, at most 4 digits each.
	tagRe = regexp.MustCompile(`^v` + num + `\.` + num + `\.` + num + `$`)
	// releaseRe is a release version without the v (folder names, pushed views).
	releaseRe = regexp.MustCompile(`^` + num + `\.` + num + `\.` + num + `$`)
	// currentRe is a running version (§3.1): X.Y.Z or X.Y.Z-<semver prerelease>.
	currentRe = regexp.MustCompile(`^` + num + `\.` + num + `\.` + num + `(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$`)
)

func fromMatch(m []string) Version {
	a, _ := strconv.Atoi(m[1])
	b, _ := strconv.Atoi(m[2])
	c, _ := strconv.Atoi(m[3])
	v := Version{Major: a, Minor: b, Patch: c}
	if len(m) > 4 {
		v.Pre = m[4]
	}
	return v
}

// ParseTag accepts only a final release tag: v<major>.<minor>.<patch>. Release candidates (v1.2.0-rc1), tags
// without the v, with leading zeros or with build metadata are not final releases.
func ParseTag(tag string) (Version, bool) {
	m := tagRe.FindStringSubmatch(tag)
	if m == nil {
		return Version{}, false
	}
	return fromMatch(m), true
}

// ParseRelease accepts a final release version without the v (1.2.0).
func ParseRelease(s string) (Version, bool) {
	m := releaseRe.FindStringSubmatch(s)
	if m == nil {
		return Version{}, false
	}
	return fromMatch(m), true
}

// ParseCurrent accepts the running version: X.Y.Z or X.Y.Z-<prerelease>. Anything else ("dev", "1.2", "v1.2.0") is a
// development build, which never checks automatically and is never offered anything.
func ParseCurrent(s string) (Version, bool) {
	m := currentRe.FindStringSubmatch(s)
	if m == nil {
		return Version{}, false
	}
	return fromMatch(m), true
}

func (v Version) String() string {
	s := fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch)
	if v.Pre != "" {
		s += "-" + v.Pre
	}
	return s
}

// Compare is semver precedence restricted to these forms: -1, 0 or 1. A version with a prerelease part is older than
// the same version without one.
func Compare(a, b Version) int {
	for _, d := range [][2]int{{a.Major, b.Major}, {a.Minor, b.Minor}, {a.Patch, b.Patch}} {
		if d[0] != d[1] {
			if d[0] < d[1] {
				return -1
			}
			return 1
		}
	}
	switch {
	case a.Pre == b.Pre:
		return 0
	case a.Pre == "":
		return 1
	case b.Pre == "":
		return -1
	}
	return comparePre(a.Pre, b.Pre)
}

// comparePre compares two semver prerelease parts identifier by identifier.
func comparePre(a, b string) int {
	x, y := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] == y[i] {
			continue
		}
		nx, ex := strconv.Atoi(x[i])
		ny, ey := strconv.Atoi(y[i])
		switch {
		case ex == nil && ey == nil:
			if nx < ny {
				return -1
			}
			return 1
		case ex == nil:
			return -1 // numeric identifiers sort before alphanumeric ones
		case ey == nil:
			return 1
		case x[i] < y[i]:
			return -1
		default:
			return 1
		}
	}
	switch {
	case len(x) < len(y):
		return -1
	case len(x) > len(y):
		return 1
	}
	return 0
}

// Newer: latest is strictly newer than current (never a downgrade, never the same version again).
func Newer(latest, current Version) bool { return Compare(latest, current) > 0 }
