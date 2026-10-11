//go:build test_unit

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestEncoreVersionString(t *testing.T) {
	old := encoreVersion
	t.Cleanup(func() { encoreVersion = old })

	encoreVersion = ""
	require.Regexp(t, fmt.Sprintf(`^go-librespot \S+ \(Encore patches 1-%d, unstamped\)$`, encorePatchLevel), encoreVersionString())

	encoreVersion = "1.1.0"
	require.Regexp(t, fmt.Sprintf(`^encore-engine 1\.1\.0 \(go-librespot \S+, Encore patches 1-%d\)$`, encorePatchLevel), encoreVersionString())
}

// --version prints one line and exits before the config directory is created
// or locked, so a supervisor can ask a running engine's binary.
func TestVersionFlag(t *testing.T) {
	if dir := os.Getenv("ENCORE_TEST_VERSION_FLAG_DIR"); dir != "" {
		os.Args = []string{"go-librespot", "--config_dir", dir, "--version"}
		_ = loadCLIConfig(new(cliConfig))
		t.Fatal("--version returned instead of exiting")
	}

	exe, err := os.Executable()
	require.NoError(t, err)

	dir := filepath.Join(t.TempDir(), "config")
	cmd := exec.Command(exe, "-test.run=^TestVersionFlag$")
	cmd.Env = append(os.Environ(), "ENCORE_TEST_VERSION_FLAG_DIR="+dir)
	out, err := cmd.Output()
	require.NoError(t, err, "the child must exit 0")

	line := strings.TrimRight(string(out), "\r\n")
	require.Regexp(t, "^"+regexp.QuoteMeta(encoreVersionString())+"$", line)

	_, err = os.Stat(dir)
	require.True(t, os.IsNotExist(err), "--version created the config directory")
}
