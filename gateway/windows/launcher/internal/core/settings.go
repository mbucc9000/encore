// Package core holds the parts of the Encore Bridge launcher that don't touch the Windows API, so they can be tested
// on any platform: settings.env parsing, the rotating log, the status model behind the tray, restart backoff and the
// launcher's own preferences.
package core

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Settings is a parsed settings.env (CONTRACT.md §4). Empty values count as unset.
type Settings struct {
	Values   map[string]string
	Order    []string // keys in file order (first occurrence)
	Warnings []string // "line 7: ..." for lines that were ignored
}

var keyRe = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)

// ParseSettings parses settings.env content: UTF-8 (a BOM is skipped), LF or CRLF, one KEY=VALUE per line, '#' notes
// and blank lines ignored, KEY and VALUE trimmed, one pair of matching surrounding quotes removed from VALUE, no
// escapes, no expansion and no inline notes. A later line for the same key wins.
func ParseSettings(data []byte) Settings {
	s := Settings{Values: map[string]string{}}
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	for i, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			s.Warnings = append(s.Warnings, fmt.Sprintf("line %d: no '=' (ignored)", i+1))
			continue
		}
		key := strings.TrimSpace(line[:eq])
		if !keyRe.MatchString(key) {
			s.Warnings = append(s.Warnings, fmt.Sprintf("line %d: %q is not a setting name (ignored)", i+1, clip(key, 40)))
			continue
		}
		val := strings.TrimSpace(line[eq+1:])
		if len(val) >= 2 && (val[0] == '"' || val[0] == '\'') && val[len(val)-1] == val[0] {
			val = val[1 : len(val)-1]
		}
		if _, seen := s.Values[key]; !seen {
			s.Order = append(s.Order, key)
		}
		s.Values[key] = val
	}
	return s
}

// LoadSettings reads and parses a settings.env file. A missing file is an empty Settings and no error.
func LoadSettings(path string) (Settings, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Settings{Values: map[string]string{}}, nil
	}
	if err != nil {
		return Settings{Values: map[string]string{}}, err
	}
	return ParseSettings(data), nil
}

// Get returns a non-empty value from the file.
func (s Settings) Get(key string) (string, bool) {
	v, ok := s.Values[key]
	if !ok || v == "" {
		return "", false
	}
	return v, true
}

// Lookup applies the precedence rule: process environment, then settings.env (empty values are unset in both).
func Lookup(key string, env func(string) (string, bool), s Settings) (string, bool) {
	if env != nil {
		if v, ok := env(key); ok && v != "" {
			return v, true
		}
	}
	return s.Get(key)
}

// Port returns the bridge's HTTP port (PORT from the environment or settings.env, else 8095) and whether the
// configured value had to be ignored because it isn't a valid port.
func Port(env func(string) (string, bool), s Settings) (port int, invalid bool) {
	v, ok := Lookup("PORT", env, s)
	if !ok {
		return 8095, false
	}
	n := 0
	for _, c := range v {
		if c < '0' || c > '9' || n > 65535 {
			return 8095, true
		}
		n = n*10 + int(c-'0')
	}
	if n < 1 || n > 65535 {
		return 8095, true
	}
	return n, false
}

// EnsureFile copies template to path when path doesn't exist yet. It never overwrites, and reports whether it created
// the file.
func EnsureFile(path, template string) (bool, error) {
	if _, err := os.Stat(path); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	src, err := os.Open(template)
	if err != nil {
		return false, err
	}
	defer src.Close()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return false, err
	}
	dst, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		os.Remove(path)
		return false, err
	}
	return true, dst.Close()
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
