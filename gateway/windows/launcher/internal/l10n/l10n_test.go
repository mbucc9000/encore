package l10n

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestFormat(t *testing.T) {
	for _, c := range []struct {
		s    string
		v    Vars
		want string
	}{
		{"Port {port} is in use", Vars{"port": 8095}, "Port 8095 is in use"},
		{"{a} and {b}, {a}", Vars{"a": "x", "b": 2}, "x and 2, x"},
		{"{a}", Vars{"a": "{b}", "b": "no"}, "{b}"},              // one pass: a value is never filled in again
		{"{missing} {a}", Vars{"a": 1}, "{missing} 1"},           // no value: left alone
		{"{not a name} {a} {", Vars{"a": 1}, "{not a name} 1 {"}, // not a placeholder
		{"{{a}}", Vars{"a": 1}, "{1}"},
		{"no placeholders", nil, "no placeholders"},
		{"downloading {percent}%", Vars{"percent": 25}, "downloading 25%"},
	} {
		if got := Format(c.s, c.v); got != c.want {
			t.Errorf("Format(%q) = %q, want %q", c.s, got, c.want)
		}
	}
}

func TestDictionary(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "de.json"), []byte(`{
		"Ready": "Bereit",
		"Port {port} is in use": "Port {port} ist belegt",
		"Streaming to {n} phones": "Streamt an {count} Telefone",
		"Empty": "  ",
		"Number": 3,
		"Starting…": "Startet…"
	}`), 0o600)
	os.WriteFile(filepath.Join(dir, "fr.json"), []byte(`not json`), 0o600)

	d, err := Load(dir, "de")
	if err != nil || d.Lang() != "de" {
		t.Fatalf("load: %v", err)
	}
	if d.Len() != 3 {
		t.Errorf("%d usable entries, want 3 (empty, non-string and mismatched placeholders left out)", d.Len())
	}
	if d.Tr("Ready") != "Bereit" || d.Tr("Starting…") != "Startet…" || d.Tr("Not translated") != "Not translated" {
		t.Error("Tr")
	}
	if got := d.Trf("Port {port} is in use", Vars{"port": 8096}); got != "Port 8096 ist belegt" {
		t.Errorf("Trf: %q", got)
	}
	if got := d.Trf("Streaming to {n} phones", Vars{"n": 2}); got != "Streaming to 2 phones" {
		t.Errorf("a translation that lost a placeholder must fall back to English: %q", got)
	}

	if d, err := Load(dir, "es"); d != nil || !errors.Is(err, os.ErrNotExist) {
		t.Errorf("missing file: %v %v", d, err)
	}
	if d, err := Load(dir, "fr"); d != nil || err == nil {
		t.Errorf("invalid file: %v %v", d, err)
	}
	for _, code := range []string{"en", "sv", "../de", ""} {
		if d, err := Load(dir, code); d != nil || err != nil {
			t.Errorf("%q: %v %v", code, d, err)
		}
	}
	var none *Dict
	if none.Tr("Ready") != "Ready" || none.Lang() != "en" || none.Trf("Port {port} is in use", Vars{"port": 1}) != "Port 1 is in use" {
		t.Error("nil dictionary is English")
	}

	defer Use(nil)
	Use(d)
	if Lang() != "de" || Tr("Ready") != "Bereit" || Trf("Port {port} is in use", Vars{"port": 1}) != "Port 1 ist belegt" {
		t.Error("package dictionary")
	}
	Use(nil)
	if Lang() != "en" || Tr("Ready") != "Ready" {
		t.Error("back to English")
	}
}

func TestFromLANGID(t *testing.T) {
	for id, want := range map[uint16]string{
		0x0409: "en", 0x0809: "en", 0x041d: "en", // English (US, UK), Swedish
		0x0c0a: "es", 0x080a: "es", 0x0416: "pt", 0x0816: "pt",
		0x040c: "fr", 0x0c0c: "fr", 0x0407: "de", 0x0807: "de", 0x0410: "it", 0x0413: "nl", 0x0813: "nl",
		0x0415: "pl", 0x0419: "ru", 0x041f: "tr", 0x0411: "ja", 0x0412: "ko",
		0x0804: "zh_CN", 0x1004: "zh_CN", 0x0004: "zh_CN", 0x7804: "zh_CN",
		0x0404: "en", 0x0c04: "en", 0x1404: "en", 0x7c04: "en", // Traditional Chinese
		0: "en",
	} {
		if got := FromLANGID(id); got != want {
			t.Errorf("%#04x: %s, want %s", id, got, want)
		}
	}
	for _, c := range Codes {
		if !Known(c) {
			t.Error(c)
		}
	}
	if Known("en") || Known("zh") {
		t.Error("only dictionary codes are known")
	}
}
