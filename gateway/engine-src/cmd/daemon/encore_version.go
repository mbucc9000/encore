package main

import (
	"fmt"

	librespot "github.com/devgianlu/go-librespot"
)

// Encore patch 6: the engine says which Encore build it is.

// encorePatchLevel is the last Encore patch in this tree (ENCORE_PATCH.md). It
// is part of the source, so every build knows it, stamped or not. Raise it
// with every new patch.
const encorePatchLevel = 7

// encoreVersion is the Encore release this engine was built for. The Windows
// build stamps it (gateway/windows/build-engine):
//
//	-ldflags "-X main.encoreVersion=<version>"
//
// It is empty in builds that do not stamp it, such as the Docker image. It is
// kept apart from go-librespot's own version on purpose: that one goes to
// Spotify (client version, build flags, user agent), and this one never does.
var encoreVersion string

// encoreVersionString is what --version prints, on one line:
//
//	encore-engine <version> (go-librespot <version>, Encore patches 1-<n>)
//
// or, unstamped, "go-librespot <version> (Encore patches 1-<n>, unstamped)".
func encoreVersionString() string {
	if encoreVersion == "" {
		return fmt.Sprintf("%s (Encore patches 1-%d, unstamped)", librespot.VersionString(), encorePatchLevel)
	}
	return fmt.Sprintf("encore-engine %s (%s, Encore patches 1-%d)", encoreVersion, librespot.VersionString(), encorePatchLevel)
}
