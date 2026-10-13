package core

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"encore-bridge/launcher/internal/l10n"
)

// The tray's texts are found by the localization helper (bridge_l10n.py, which reads only the launcher's own folder)
// with this pattern: the first string literal of a tr or trf call. The tests below keep the Go code within what it can
// read, and keep l10n_core.go, its list of the texts this package builds, complete.
var helperPattern = regexp.MustCompile(`\btrf?\(\s*"((?:[^"\\\n]|\\.)*)"`)

// mainDir is the launcher's own folder (package main), relative to this package.
const mainDir = "../.."

// coreList is the file in mainDir that lists this package's texts for the helper.
const coreList = "l10n_core.go"

// sources lists the Go files (no tests) of dir; only, when given, keeps just that file.
func sources(t *testing.T, dir, only string) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no Go files in %s", dir)
	}
	var out []string
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") || (only != "" && filepath.Base(f) != only) {
			continue
		}
		out = append(out, f)
	}
	return out
}

// trTexts collects the English texts of the tr and trf calls in files, and fails a call whose first argument isn't
// one double-quoted string literal with escapes the helper reads the same way (\n \t \r \\ \" \uXXXX).
func trTexts(t *testing.T, files []string) map[string]bool {
	t.Helper()
	texts := map[string]bool{}
	fset := token.NewFileSet()
	for _, f := range files {
		file, err := parser.ParseFile(fset, f, nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			id, ok := call.Fun.(*ast.Ident)
			if !ok || (id.Name != "tr" && id.Name != "trf") {
				return true
			}
			lit, ok := call.Args[0].(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING || !strings.HasPrefix(lit.Value, `"`) {
				t.Errorf("%s: %s needs one double-quoted string literal (the English text) as its first argument",
					fset.Position(call.Pos()), id.Name)
				return true
			}
			if bad := oddEscape(lit.Value); bad != "" {
				t.Errorf("%s: escape %q: use the character itself", fset.Position(call.Pos()), bad)
			}
			s, err := strconv.Unquote(lit.Value)
			if err != nil {
				t.Errorf("%s: %v", fset.Position(call.Pos()), err)
				return true
			}
			if strings.TrimSpace(s) == "" {
				t.Errorf("%s: empty text", fset.Position(call.Pos()))
			}
			texts[s] = true
			return true
		})
	}
	return texts
}

// oddEscape is the first escape in a quoted literal that the helper wouldn't read as Go does ("" when none).
func oddEscape(lit string) string {
	for i := 0; i < len(lit)-1; i++ {
		if lit[i] != '\\' {
			continue
		}
		switch c := lit[i+1]; {
		case strings.IndexByte("ntr\\\"", c) >= 0:
			i++
		case c == 'u' && i+6 <= len(lit) && isHex(lit[i+2:i+6]):
			i += 5
		default:
			return lit[i : i+2]
		}
	}
	return ""
}

func isHex(s string) bool {
	for _, c := range s {
		if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return false
		}
	}
	return true
}

func sorted(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func diff(a, b map[string]bool) []string {
	var out []string
	for _, k := range sorted(a) {
		if !b[k] {
			out = append(out, k)
		}
	}
	return out
}

// coreListSource is l10n_core.go for these texts.
func coreListSource(texts []string) []byte {
	var b bytes.Buffer
	b.WriteString(`//go:build windows

package main

// coreTexts lists the tray texts that internal/core builds (the status lines and their explanations, the sign-in
// steps, the update texts), each in a tr call, so that the localization helper, which reads only this folder, collects
// them. They are translated where internal/core builds them; this function never runs. internal/core's
// TestTrayTextsListed checks this list; ENCORE_UPDATE_L10N_CORE=1 go test ./internal/core/ rewrites it.
func coreTexts() {
`)
	for _, s := range texts {
		b.WriteString("\t_ = tr(" + strconv.Quote(s) + ")\n")
	}
	b.WriteString("}\n")
	return b.Bytes()
}

// Every text this package translates is listed in l10n_core.go, and nothing else is.
func TestTrayTextsListed(t *testing.T) {
	core := trTexts(t, sources(t, ".", ""))
	if len(core) < 50 {
		t.Fatalf("only %d texts in internal/core", len(core))
	}
	path := filepath.Join(mainDir, coreList)
	want := coreListSource(sorted(core))
	if os.Getenv("ENCORE_UPDATE_L10N_CORE") == "1" {
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s (%d texts)", path, len(core))
	}
	listed := trTexts(t, sources(t, mainDir, coreList))
	if missing, extra := diff(core, listed), diff(listed, core); len(missing)+len(extra) > 0 {
		t.Errorf("%s is out of date (ENCORE_UPDATE_L10N_CORE=1 go test ./internal/core/ rewrites it)\nnot listed: %q\nlisted but unused: %q",
			coreList, missing, extra)
	}
	if got, err := os.ReadFile(path); err != nil || !bytes.Equal(bytes.ReplaceAll(got, []byte("\r\n"), []byte("\n")), want) {
		t.Errorf("%s isn't in its generated form (ENCORE_UPDATE_L10N_CORE=1 go test ./internal/core/ rewrites it)", coreList)
	}
}

// The helper's pattern finds exactly the texts of the launcher's tr and trf calls (none in comments, none cut short).
func TestTrayTextsExtractable(t *testing.T) {
	files := sources(t, mainDir, "")
	calls := trTexts(t, files)
	found := map[string]bool{}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range helperPattern.FindAllSubmatch(b, -1) {
			s, err := strconv.Unquote(`"` + string(m[1]) + `"`)
			if err != nil {
				t.Errorf("%s: the helper would read %q", filepath.Base(f), m[1])
				continue
			}
			found[s] = true
		}
	}
	if len(calls) < 100 {
		t.Errorf("only %d texts in the launcher", len(calls))
	}
	if missing, extra := diff(calls, found), diff(found, calls); len(missing)+len(extra) > 0 {
		t.Errorf("the helper would miss %q and find %q", missing, extra)
	}
}

// With a dictionary in use, the texts this package builds are translated, placeholders filled; without, English.
func TestTranslatedTexts(t *testing.T) {
	d, err := l10n.Parse("de", []byte(`{
		"Ready": "Bereit",
		"Encore Bridge: {status}": "Encore Bridge – {status}",
		"Streaming to {n} phones": "Streamt an {n} Telefone",
		"Port {port} is in use": "Port {port} ist belegt",
		"Encore Bridge {version} is available": "Encore Bridge {version} ist verfügbar",
		"{version} available": "{version} verfügbar",
		"Update now…": "Jetzt aktualisieren…",
		"The code works for about {n} more minutes.": "Der Code gilt noch etwa {n} Minuten."
	}`))
	if err != nil {
		t.Fatal(err)
	}
	l10n.Use(d)
	defer l10n.Use(nil)

	in := Input{State: StateRunning, Status: readyStatus(), LauncherVersion: "1.1.0", Update: UpdateTray{Kind: KindInstaller, Available: "1.2.0"}}
	if v := Compute(in); v.Headline != "Bereit" || v.Tooltip != "Encore Bridge – Bereit · 1.2.0 verfügbar" {
		t.Errorf("headline %q tooltip %q", v.Headline, v.Tooltip)
	}
	if v := Compute(Input{State: StateFailed, FailReason: FailExit, ExitCode: ExitPortInUse, Port: 8096}); v.Headline != "Port 8096 ist belegt" ||
		!strings.HasPrefix(v.Problem, "Another program is already using port 8096") {
		t.Errorf("port in use: %q / %q", v.Headline, v.Problem)
	}
	if m := in.Update.Menu(); m.Title != "Encore Bridge 1.2.0 ist verfügbar" || m.Action != "Jetzt aktualisieren…" {
		t.Errorf("menu: %+v", m)
	}
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	s := &SignIn{Code: "ABCD", ExpiresAt: []byte(`"2026-10-07T12:09:30Z"`)}
	if txt := SignInText(s, now); !strings.HasSuffix(txt, "\nDer Code gilt noch etwa 9 Minuten.") || !strings.Contains(txt, "enter:  ABCD") {
		t.Errorf("sign-in: %q", txt)
	}

	l10n.Use(nil)
	if v := Compute(in); v.Headline != "Ready" || v.Tooltip != "Encore Bridge: Ready · 1.2.0 available" {
		t.Errorf("English again: %q %q", v.Headline, v.Tooltip)
	}
}
