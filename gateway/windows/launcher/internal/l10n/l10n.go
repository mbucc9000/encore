// Package l10n translates the launcher's texts (the tray menu, its dialogs and the status lines) with the bridge's
// dictionaries: gateway\src\i18n\<code>.json in the program folder, one JSON object {"<English text>": "<translation>"}
// per language, the same files the admin page uses. The English text is the key and the fallback: English needs no
// file, and a missing or unreadable file, a missing entry, an empty translation or one whose {name} placeholders
// don't match the English text all show the English text.
//
// The language is chosen once at start (the Windows display language, see FromLANGID) and loaded with Use; until then
// every text is English.
package l10n

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
)

// Codes are the languages that have a dictionary, as the app and the admin page name them.
var Codes = []string{"es", "pt", "fr", "de", "it", "nl", "pl", "ru", "tr", "ja", "ko", "zh_CN"}

// English is the fallback language: it has no dictionary.
const English = "en"

// Vars fills the {name} placeholders of a text.
type Vars = map[string]any

// Dict is one language's dictionary.
type Dict struct {
	lang string
	m    map[string]string
}

// Lang is the dictionary's language code.
func (d *Dict) Lang() string {
	if d == nil {
		return English
	}
	return d.lang
}

// Len is the number of usable translations.
func (d *Dict) Len() int {
	if d == nil {
		return 0
	}
	return len(d.m)
}

// Tr is the translation of the English text s, or s itself.
func (d *Dict) Tr(s string) string {
	if d != nil {
		if t, ok := d.m[s]; ok {
			return t
		}
	}
	return s
}

// Trf is Tr with the {name} placeholders filled from vars.
func (d *Dict) Trf(s string, vars Vars) string { return Format(d.Tr(s), vars) }

var current atomic.Pointer[Dict]

// Use makes d the dictionary of Tr and Trf (nil: English).
func Use(d *Dict) { current.Store(d) }

// Lang is the language in use.
func Lang() string { return current.Load().Lang() }

// Tr translates s with the dictionary in use.
func Tr(s string) string { return current.Load().Tr(s) }

// Trf translates s with the dictionary in use and fills its {name} placeholders.
func Trf(s string, vars Vars) string { return current.Load().Trf(s, vars) }

// Known reports whether code has a dictionary.
func Known(code string) bool {
	for _, c := range Codes {
		if c == code {
			return true
		}
	}
	return false
}

// maxFile bounds a dictionary file (they are a few hundred kilobytes at most).
const maxFile = 8 << 20

// Load reads dir/<code>.json. English (or an unknown code) gives a nil dictionary and no error. A missing file gives a
// nil dictionary and an error wrapping os.ErrNotExist, an unreadable or invalid one a nil dictionary and another
// error: the texts are English then. Entries whose value isn't a non-empty string, or whose {name} placeholders differ
// from the English text's, are left out (those texts stay English).
func Load(dir, code string) (*Dict, error) {
	if code == English || !Known(code) {
		return nil, nil
	}
	f, err := os.Open(filepath.Join(dir, code+".json"))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxFile+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxFile {
		return nil, errors.New("dictionary too large")
	}
	return Parse(code, b)
}

// Parse decodes a dictionary file's content (see Load).
func Parse(code string, b []byte) (*Dict, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, fmt.Errorf("not a JSON object: %w", err)
	}
	d := &Dict{lang: code, m: make(map[string]string, len(raw))}
	for k, v := range raw {
		var s string
		if json.Unmarshal(v, &s) != nil || strings.TrimSpace(s) == "" || !samePlaceholders(k, s) {
			continue
		}
		d.m[k] = s
	}
	return d, nil
}

// Format fills the {name} placeholders of s from vars in one pass (a value that holds braces is never filled in
// again). Placeholders without a value stay as they are.
func Format(s string, vars Vars) string {
	if len(vars) == 0 || !strings.Contains(s, "{") {
		return s
	}
	var b strings.Builder
	for {
		i := strings.IndexByte(s, '{')
		if i < 0 {
			b.WriteString(s)
			return b.String()
		}
		j := strings.IndexByte(s[i+1:], '}')
		if j < 0 {
			b.WriteString(s)
			return b.String()
		}
		name := s[i+1 : i+1+j]
		v, ok := vars[name]
		if !ok || !isName(name) {
			b.WriteString(s[:i+1])
			s = s[i+1:]
			continue
		}
		b.WriteString(s[:i])
		b.WriteString(fmt.Sprint(v))
		s = s[i+2+j:]
	}
}

// placeholders lists the {name} placeholders of s, sorted.
func placeholders(s string) []string {
	var out []string
	for {
		i := strings.IndexByte(s, '{')
		if i < 0 {
			break
		}
		j := strings.IndexByte(s[i+1:], '}')
		if j < 0 {
			break
		}
		if name := s[i+1 : i+1+j]; isName(name) {
			out = append(out, name)
			s = s[i+2+j:]
		} else {
			s = s[i+1:]
		}
	}
	sort.Strings(out)
	return out
}

func samePlaceholders(a, b string) bool {
	pa, pb := placeholders(a), placeholders(b)
	if len(pa) != len(pb) {
		return false
	}
	for i := range pa {
		if pa[i] != pb[i] {
			return false
		}
	}
	return true
}

// isName: a placeholder name is a letter or _ followed by letters, digits or _ (as the bridge's dictionaries use).
func isName(s string) bool {
	if s == "" {
		return false
	}
	for i, c := range s {
		switch {
		case c == '_', c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z':
		case c >= '0' && c <= '9' && i > 0:
		default:
			return false
		}
	}
	return true
}

// FromLANGID maps a Windows language identifier (GetUserDefaultUILanguage) to a code: the primary language decides
// (Spanish, French … of any country; Portuguese of any country is pt), Chinese only when Simplified (China, Singapore,
// zh-Hans, zh); everything else is English.
func FromLANGID(id uint16) string {
	switch id & 0x3ff {
	case 0x0a:
		return "es"
	case 0x16:
		return "pt"
	case 0x0c:
		return "fr"
	case 0x07:
		return "de"
	case 0x10:
		return "it"
	case 0x13:
		return "nl"
	case 0x15:
		return "pl"
	case 0x19:
		return "ru"
	case 0x1f:
		return "tr"
	case 0x11:
		return "ja"
	case 0x12:
		return "ko"
	case 0x04:
		switch id {
		case 0x0804, 0x1004, 0x0004, 0x7804: // zh-CN, zh-SG, zh-Hans, zh
			return "zh_CN"
		}
	}
	return English
}
