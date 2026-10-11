package update

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"encore-bridge/launcher/internal/update/fakegh"
)

// ---- helpers

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) Add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type logbuf struct {
	mu    sync.Mutex
	lines []string
}

func (l *logbuf) Logf(level, format string, a ...any) {
	l.mu.Lock()
	l.lines = append(l.lines, level+" "+fmt.Sprintf(format, a...))
	l.mu.Unlock()
}

func (l *logbuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.lines, "\n")
}

func (l *logbuf) has(t *testing.T, s string) {
	t.Helper()
	if !strings.Contains(l.String(), s) {
		t.Errorf("log lacks %q:\n%s", s, l.String())
	}
}

var test1 = Key{ID: "21fe31dfa154a261", Key: fakegh.PublicB64(fakegh.Test1Seed), Name: "rfc8032-test-1"}

type env struct {
	fake *fakegh.Server
	c    *Client
	clk  *clock
	log  *logbuf
}

func setup(t *testing.T, rel *fakegh.Release, opt fakegh.Options, current, kind string, mod ...func(*Config)) *env {
	t.Helper()
	fake := fakegh.Start(rel, opt)
	t.Cleanup(fake.Close)
	e := &env{fake: fake, clk: &clock{t: time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)}, log: &logbuf{}}
	cfg := Config{
		Current: current, Kind: kind, Keys: nil, TestKeys: []Key{test1}, Logf: e.log.Logf,
		APIBase: fake.URL, DownloadBase: fake.URL, Now: e.clk.Now, Jitter: func() time.Duration { return 0 },
		Sleep:      func(context.Context, time.Duration) error { return nil },
		APITimeout: 2 * time.Second, StallTimeout: 300 * time.Millisecond, ConnTimeout: time.Second,
	}
	for _, m := range mod {
		m(&cfg)
	}
	c, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	e.c = c
	return e
}

func installer(ver string) []byte {
	return bytes.Repeat([]byte("Encore Bridge "+ver+" setup "), 20000) // ~400 KB
}

func makeRel(ver string, seed []byte) *fakegh.Release {
	return fakegh.MakeRelease(ver, map[string][]byte{
		InstallerName(ver): installer(ver),
		ZipName(ver):       []byte("zip " + ver),
		SourceName(ver):    []byte("source " + ver),
	}, seed)
}

func check(t *testing.T, e *env, st *State, manual bool) Report {
	t.Helper()
	return e.c.Check(context.Background(), st, manual)
}

func view(e *env, st *State) View { return MakeView(st, e.c.Kind(), e.c.Current(), true, false, nil) }

// ---- vectors (shared with the bridge, §14.1)

type vectors struct {
	Keys map[string]struct {
		SeedHex   string `json:"seed_hex"`
		PublicHex string `json:"public_hex"`
		PublicB64 string `json:"public_b64"`
		ID        string `json:"id"`
	} `json:"keys"`
	Versions struct {
		Compare []struct {
			Current string `json:"current"`
			Tag     string `json:"tag"`
			Offer   bool   `json:"offer"`
			Why     string `json:"why"`
		} `json:"compare"`
		TagsAccepted []struct {
			Tag     string `json:"tag"`
			Version string `json:"version"`
		} `json:"tags_accepted"`
		TagsRejected   []string `json:"tags_rejected"`
		CurrentRelease []string `json:"current_release"`
		CurrentDev     []string `json:"current_dev"`
	} `json:"versions"`
	Sums struct {
		Cases []struct {
			Name    string            `json:"name"`
			B64     string            `json:"b64"`
			OK      bool              `json:"ok"`
			Entries map[string]string `json:"entries"`
		} `json:"cases"`
	} `json:"sums"`
	Signatures struct {
		Cases []struct {
			Name    string   `json:"name"`
			Message string   `json:"message_b64"`
			Sig     string   `json:"sig_b64"`
			Trusted []string `json:"trusted"`
			OK      bool     `json:"ok"`
		} `json:"cases"`
	} `json:"signatures"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "update-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Versions.Compare) == 0 || len(v.Sums.Cases) == 0 || len(v.Signatures.Cases) == 0 {
		t.Fatal("vectors file is missing parts")
	}
	return v
}

func TestVectorsKeys(t *testing.T) {
	v := loadVectors(t)
	for name, k := range v.Keys {
		seed, _ := hex.DecodeString(k.SeedHex)
		pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
		if hex.EncodeToString(pub) != k.PublicHex || base64.StdEncoding.EncodeToString(pub) != k.PublicB64 || KeyID(pub) != k.ID {
			t.Errorf("%s: seed, public key and id don't agree", name)
		}
	}
	if v.Keys["rfc8032_test1"].PublicB64 != test1.Key || v.Keys["rfc8032_test1"].ID != test1.ID {
		t.Error("fakegh's TEST 1 key isn't the vectors' one")
	}
}

func TestVectorsVersions(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.Versions.Compare {
		cur, okC := ParseCurrent(c.Current)
		tag, okT := ParseTag(c.Tag)
		got := okC && okT && Newer(tag, cur)
		if got != c.Offer {
			t.Errorf("current %q, tag %q: offered %v, want %v (%s)", c.Current, c.Tag, got, c.Offer, c.Why)
		}
	}
	for _, c := range v.Versions.TagsAccepted {
		x, ok := ParseTag(c.Tag)
		if !ok || x.String() != c.Version {
			t.Errorf("tag %q rejected or read as %v", c.Tag, x)
		}
	}
	for _, s := range v.Versions.TagsRejected {
		if _, ok := ParseTag(s); ok {
			t.Errorf("tag %q accepted", s)
		}
	}
	for _, s := range v.Versions.CurrentRelease {
		if x, ok := ParseCurrent(s); !ok || x.String() != s {
			t.Errorf("current %q not accepted", s)
		}
	}
	for _, s := range v.Versions.CurrentDev {
		if _, ok := ParseCurrent(s); ok {
			t.Errorf("current %q should be a development build", s)
		}
	}
}

func TestVectorsSums(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.Sums.Cases {
		b, err := base64.StdEncoding.DecodeString(c.B64)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		got, err := ParseSums(b)
		if (err == nil) != c.OK {
			t.Errorf("%s: ok %v, want %v (%v)", c.Name, err == nil, c.OK, err)
			continue
		}
		if c.OK && fmt.Sprint(got) != fmt.Sprint(c.Entries) {
			t.Errorf("%s: entries %v, want %v", c.Name, got, c.Entries)
		}
	}
}

func TestVectorsSignatures(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.Signatures.Cases {
		msg, _ := base64.StdEncoding.DecodeString(c.Message)
		sig, _ := base64.StdEncoding.DecodeString(c.Sig)
		var keys []Key
		for _, n := range c.Trusted {
			keys = append(keys, Key{ID: v.Keys[n].ID, Key: v.Keys[n].PublicB64, Name: n})
		}
		id, tried, ok := VerifySums(msg, sig, keys)
		if ok != c.OK {
			t.Errorf("%s: ok %v, want %v", c.Name, ok, c.OK)
		}
		if ok && id == "" || !ok && len(tried) != len(keys) {
			t.Errorf("%s: matched %q, tried %v", c.Name, id, tried)
		}
	}
}

// Both sides sign at test time with the RFC TEST 1 key too.
func TestSignAtTestTime(t *testing.T) {
	sums := fakegh.Sums(map[string][]byte{"EncoreBridge-1.2.0-setup.exe": []byte("x")})
	if _, _, ok := VerifySums(sums, fakegh.Sign(fakegh.Test1Seed, sums), []Key{test1}); !ok {
		t.Error("a fresh TEST 1 signature doesn't verify")
	}
	if _, _, ok := VerifySums(sums, fakegh.Sign(fakegh.Test2Seed, sums), []Key{test1}); ok {
		t.Error("a TEST 2 signature verified under TEST 1")
	}
}

// ---- the embedded trust list (§4.5)

func TestTrustedKeys(t *testing.T) {
	if len(TrustedKeys) < 1 || len(TrustedKeys) > 3 {
		t.Fatalf("%d trusted keys", len(TrustedKeys))
	}
	rfc := map[string]bool{fakegh.PublicB64(fakegh.Test1Seed): true, fakegh.PublicB64(fakegh.Test2Seed): true}
	for _, k := range TrustedKeys {
		pub, err := k.Public()
		if err != nil {
			t.Fatalf("%s: %v", k.Name, err)
		}
		if KeyID(pub) != k.ID {
			t.Errorf("%s: id %s, computed %s", k.Name, k.ID, KeyID(pub))
		}
		if rfc[k.Key] {
			t.Errorf("%s is an RFC 8032 test key", k.Name)
		}
	}
}

// The production constants are exactly these, and a release client uses them (without requesting anything).
func TestProductionConstants(t *testing.T) {
	if APIBase != "https://api.github.com" || DownloadBase != "https://github.com" || Repo != "mbucc9000/encore" {
		t.Fatal("production constants changed")
	}
	c, err := New(Config{Current: "1.1.0", Kind: KindInstaller, Keys: TrustedKeys, TestKeys: []Key{test1}})
	if err != nil {
		t.Fatal(err)
	}
	if c.latestURL() != "https://api.github.com/repos/mbucc9000/encore/releases/latest" ||
		c.AssetURL("1.2.0", SumsName) != "https://github.com/mbucc9000/encore/releases/download/v1.2.0/SHA256SUMS.txt" ||
		NotesURL("1.2.0") != "https://github.com/mbucc9000/encore/releases/tag/v1.2.0" {
		t.Error("production URLs changed")
	}
	if len(c.keys) != len(TrustedKeys) {
		t.Error("test keys must only count with loopback test bases")
	}
	if c.Requests() != 0 {
		t.Error("New made a request")
	}
}

func TestTestBasesMustBeLoopback(t *testing.T) {
	for _, pair := range [][2]string{
		{"http://example.com:8080", "http://127.0.0.1:1"},
		{"http://127.0.0.1:1", "https://github.com"},
		{"https://127.0.0.1:1", "http://127.0.0.1:1"},
		{"http://127.0.0.1", "http://127.0.0.1:1"},
		{"http://127.0.0.1:1/x", "http://127.0.0.1:1"},
		{"http://10.0.0.1:1", "http://10.0.0.1:1"},
		{"", "http://127.0.0.1:1"},
	} {
		_, err := New(Config{Current: "1.1.0", Kind: KindInstaller, APIBase: pair[0], DownloadBase: pair[1]})
		if !errors.Is(err, ErrTestBases) {
			t.Errorf("%v accepted", pair)
			continue
		}
		if strings.Contains(err.Error(), "example.com") || strings.Contains(err.Error(), "10.0.0.1") {
			t.Error("the warning repeats the value")
		}
	}
	for _, b := range []string{"http://127.0.0.1:9", "http://[::1]:9", "http://localhost:9"} {
		if _, err := New(Config{Current: "1.1.0", Kind: KindInstaller, APIBase: b, DownloadBase: b}); err != nil {
			t.Errorf("%s refused", b)
		}
	}
}

func TestRedirectRules(t *testing.T) {
	ok := func(s string) bool { u, _ := url.Parse(s); return AllowedDownloadRedirect(u) }
	for s, want := range map[string]bool{
		"https://github.com/mbucc9000/encore/releases/download/v1.2.0/x":   true,
		"https://release-assets.githubusercontent.com/github-production/x": true,
		"https://objects.githubusercontent.com/x?sig=1":                    true,
		"http://objects.githubusercontent.com/x":                           false,
		"https://githubusercontent.com/x":                                  false,
		"https://evilgithubusercontent.com/x":                              false,
		"https://github.com.evil.example/x":                                false,
		"https://evil.example/x":                                           false,
		"https://github.com:8443/x":                                        false,
		"https://user@github.com/x":                                        false,
	} {
		if ok(s) != want {
			t.Errorf("download hop %s: %v", s, !want)
		}
	}
	api := func(s string) bool { u, _ := url.Parse(s); return AllowedAPIRedirect(u) }
	if !api("https://api.github.com/repositories/1/releases/latest") || api("http://api.github.com/x") || api("https://github.com/x") ||
		api("https://api.github.com.evil.example/x") {
		t.Error("API redirect rule")
	}
}

// ---- checks against the fake GitHub

func TestAvailableAfterGoodSignature(t *testing.T) {
	e := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{}, "1.1.0", KindInstaller)
	var st State
	rep := check(t, e, &st, false)
	if !rep.Contacted || rep.Reused {
		t.Fatalf("report %+v", rep)
	}
	v := view(e, &st)
	if v.State != StateAvailable || v.Latest == nil || v.Latest.Version != "1.2.0" || v.Latest.Asset != "EncoreBridge-1.2.0-setup.exe" ||
		v.Latest.NotesURL != "https://github.com/mbucc9000/encore/releases/tag/v1.2.0" || v.Latest.Size != int64(len(installer("1.2.0"))) {
		t.Fatalf("view %+v", v)
	}
	sum := fakegh.Sums(map[string][]byte{"x": installer("1.2.0")})
	if v.Latest.SHA256 != string(sum[:64]) {
		t.Error("the view's hash isn't the signed one")
	}
	e.log.has(t, "I update check: 1.2.0 available (signature ok, key 21fe31dfa154a261)")
	if e.fake.Count("/dl/") != 2 || e.fake.Count(fakegh.DownloadPrefix()+"v1.2.0/EncoreBridge") != 0 {
		t.Errorf("a check fetches only the two small files: %d", e.fake.Count("/dl/"))
	}
	// the zip kind wants the zip's entry; Docker/other the source archive
	for kind, asset := range map[string]string{KindZip: "EncoreBridge-1.2.0-win64.zip", KindOther: "Encore-1.2.0-source.tar.gz"} {
		e2 := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{}, "1.1.0", kind)
		var st2 State
		check(t, e2, &st2, false)
		if v := view(e2, &st2); v.State != StateAvailable || v.Latest.Asset != asset {
			t.Errorf("%s: %+v", kind, v)
		}
	}
}

func TestNothingOffered(t *testing.T) {
	cases := []struct {
		name    string
		current string
		mod     func(*fakegh.Release)
	}{
		{"equal", "1.2.0", nil},
		{"older", "1.3.0", nil},
		{"rc tag", "1.1.0", func(r *fakegh.Release) { r.Tag = "v1.2.0-rc1" }},
		{"no v", "1.1.0", func(r *fakegh.Release) { r.Tag = "1.2.0" }},
		{"build metadata", "1.1.0", func(r *fakegh.Release) { r.Tag = "v1.2.0+b1" }},
		{"prerelease", "1.1.0", func(r *fakegh.Release) { r.Prerelease = true }},
		{"draft", "1.1.0", func(r *fakegh.Release) { r.Draft = true }},
	}
	for _, c := range cases {
		rel := makeRel("1.2.0", fakegh.Test1Seed)
		if c.mod != nil {
			c.mod(rel)
		}
		e := setup(t, rel, fakegh.Options{}, c.current, KindInstaller)
		var st State
		check(t, e, &st, false)
		if v := view(e, &st); v.State != StateUpToDate || v.Latest != nil || v.Error != nil {
			t.Errorf("%s: %+v", c.name, v)
		}
		if n := e.fake.Count("/dl/"); n != 0 {
			t.Errorf("%s: %d downloads", c.name, n)
		}
	}
}

func TestReleaseCandidateCurrentGetsFinal(t *testing.T) {
	e := setup(t, makeRel("1.1.0", fakegh.Test1Seed), fakegh.Options{}, "1.1.0-rc5", KindInstaller)
	var st State
	check(t, e, &st, false)
	if v := view(e, &st); v.State != StateAvailable || v.Latest.Version != "1.1.0" {
		t.Errorf("%+v", v)
	}
}

func TestDevBuildNeverRequests(t *testing.T) {
	e := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{}, "dev", KindInstaller)
	var st State
	if rep := check(t, e, &st, true); !rep.Dev {
		t.Errorf("%+v", rep)
	}
	if n := len(e.fake.Requests()); n != 0 {
		t.Errorf("%d requests from a development build", n)
	}
	if v := view(e, &st); v.Auto || v.AutoOff == nil || *v.AutoOff != AutoOffDevBuild || v.State != StateNever {
		t.Errorf("%+v", v)
	}
}

func TestBadSignatures(t *testing.T) {
	cases := map[string]func(*fakegh.Release){
		"other key": func(r *fakegh.Release) {
			r.Files[SigName] = fakegh.Sign(fakegh.Test2Seed, r.Files[SumsName])
		},
		"list changed after signing": func(r *fakegh.Release) {
			b := append([]byte(nil), r.Files[SumsName]...)
			b[0] ^= 1
			r.Files[SumsName] = b
		},
		"CRLF": func(r *fakegh.Release) {
			r.Files[SumsName] = bytes.ReplaceAll(r.Files[SumsName], []byte("\n"), []byte("\r\n"))
		},
		"signature cut to 63 bytes": func(r *fakegh.Release) {
			r.Files[SigName] = r.Files[SigName][:63]
			r.Sizes = map[string]int64{SigName: 64} // the API still says 64
		},
		"zero signature": func(r *fakegh.Release) { r.Files[SigName] = make([]byte, 64) },
	}
	for name, mod := range cases {
		rel := makeRel("1.2.0", fakegh.Test1Seed)
		mod(rel)
		e := setup(t, rel, fakegh.Options{}, "1.1.0", KindInstaller)
		var st State
		check(t, e, &st, false)
		v := view(e, &st)
		if v.State != StateError || v.Error == nil || v.Error.Code != CodeBadSignature || v.Latest != nil {
			t.Errorf("%s: %+v", name, v)
		}
		e.log.has(t, "W update check: 1.2.0 not offered: bad_signature (keys tried: 21fe31dfa154a261)")
	}
}

// §4.5: a verification stored while a key was trusted is never reused once a later version dropped that key: not by
// DropUntrusted at start, and not by the check's reuse of an unchanged release.
func TestRemovedKeyNotReused(t *testing.T) {
	e := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{}, "1.1.0", KindInstaller)
	var st State
	check(t, e, &st, false)
	if _, _, _, ok := st.Available("1.1.0", KindInstaller); !ok || st.Verified == nil || st.Verified.KeyID != test1.ID {
		t.Fatalf("not available with the key trusted: %+v", st.Verified)
	}
	if e.c.DropUntrusted(&st) || st.Verified == nil {
		t.Error("a verification by a trusted key was dropped")
	}
	// 1.1.1 trusts only the TEST 2 key; the same release (same asset ids and sizes) is still the latest
	k2 := Key{Key: fakegh.PublicB64(fakegh.Test2Seed), Name: "rfc8032-test-2"}
	if pub, err := k2.Public(); err == nil {
		k2.ID = KeyID(pub)
	}
	e2 := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{}, "1.1.1", KindInstaller,
		func(c *Config) { c.TestKeys = []Key{k2} })
	dropped := st.Clone()
	if !e2.c.DropUntrusted(&dropped) || dropped.Verified != nil || dropped.ETag != "" {
		t.Errorf("not dropped: %+v", dropped.Verified)
	}
	if _, _, _, ok := dropped.Available("1.1.1", KindInstaller); ok {
		t.Error("still offered after the drop")
	}
	// without the drop, the check verifies the release again (under the new list) instead of reusing the old result
	e2.clk.Add(25 * time.Hour)
	check(t, e2, &st, false)
	if _, _, _, ok := st.Available("1.1.1", KindInstaller); ok || st.Result == nil || st.Result.State != ResultBadSignature {
		t.Errorf("a release verified by a removed key is still offered: %+v", st.Result)
	}
	if n := e2.fake.Count("/dl/"); n != 2 {
		t.Errorf("the two small files weren't fetched again (%d)", n)
	}
}

func TestSumsEntryMissingAndIncomplete(t *testing.T) {
	// the signed list doesn't name the installer
	rel := makeRel("1.2.0", nil)
	files := map[string][]byte{}
	for n, b := range rel.Files {
		if n != InstallerName("1.2.0") && n != SumsName {
			files[n] = b
		}
	}
	sums := fakegh.Sums(files)
	rel.Files[SumsName] = sums
	rel.Files[SigName] = fakegh.Sign(fakegh.Test1Seed, sums)
	e := setup(t, rel, fakegh.Options{}, "1.1.0", KindInstaller)
	var st State
	check(t, e, &st, false)
	if v := view(e, &st); v.Error == nil || v.Error.Code != CodeSumsEntryMissing || v.Latest != nil {
		t.Errorf("sums entry missing: %+v", v)
	}
	e.log.has(t, "W update check: 1.2.0 not offered: sums_entry_missing")

	for name, mod := range map[string]func(*fakegh.Release){
		"no installer":      func(r *fakegh.Release) { r.Omit = map[string]bool{InstallerName("1.2.0"): true} },
		"no signature":      func(r *fakegh.Release) { delete(r.Files, SigName) },
		"still uploading":   func(r *fakegh.Release) { r.States = map[string]string{InstallerName("1.2.0"): "starter"} },
		"signature size":    func(r *fakegh.Release) { r.Sizes = map[string]int64{SigName: 65} },
		"installer too big": func(r *fakegh.Release) { r.Sizes = map[string]int64{InstallerName("1.2.0"): 600 << 20} },
	} {
		rel := makeRel("1.2.0", fakegh.Test1Seed)
		mod(rel)
		e := setup(t, rel, fakegh.Options{}, "1.1.0", KindInstaller)
		var st State
		check(t, e, &st, false)
		if v := view(e, &st); v.Error == nil || v.Error.Code != CodeIncomplete || v.Error.Version == nil || *v.Error.Version != "1.2.0" {
			t.Errorf("%s: %+v", name, v)
		}
		if e.fake.Count("/dl/") != 0 {
			t.Errorf("%s: downloaded something", name)
		}
		e.log.has(t, "W update check failed: incomplete_release 1.2.0")
	}
}

func TestSmallFilesFetchedOncePerRelease(t *testing.T) {
	e := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{}, "1.1.0", KindInstaller)
	var st State
	for i := 0; i < 3; i++ {
		check(t, e, &st, false)
		e.clk.Add(25 * time.Hour)
	}
	if n := e.fake.Count("/dl/"); n != 2 {
		t.Errorf("the two small files were fetched %d times for one release", n)
	}
	if view(e, &st).State != StateAvailable {
		t.Error("not available any more")
	}
	// a new release (new assets) is verified again
	e.fake.Set(makeRel("1.3.0", fakegh.Test1Seed), fakegh.Options{})
	check(t, e, &st, false)
	if n := e.fake.Count("/dl/"); n != 4 || view(e, &st).Latest.Version != "1.3.0" {
		t.Errorf("new release: %d downloads", n)
	}
}

func TestETag(t *testing.T) {
	etag := `W/"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"`
	e := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{ETag: etag, Honor304: true}, "1.1.0", KindInstaller)
	var st State
	check(t, e, &st, false)
	if st.ETag != etag {
		t.Fatalf("a content-hash ETag wasn't stored: %q", st.ETag)
	}
	e.fake.ResetRequests()
	e.clk.Add(25 * time.Hour)
	check(t, e, &st, false)
	reqs := e.fake.Requests()
	if len(reqs) != 1 || reqs[0].Header.Get("If-None-Match") != etag {
		t.Fatalf("second check: %d requests, If-None-Match %q", len(reqs), reqs[0].Header.Get("If-None-Match"))
	}
	if v := view(e, &st); v.State != StateAvailable {
		t.Errorf("304 lost the result: %+v", v)
	}
	e.log.has(t, "I update check: not changed since the last check")
	if strings.Contains(e.log.String(), "0123456789abcdef") {
		t.Error("the ETag was logged")
	}

	// an ETag that isn't a content hash is never stored or sent
	for _, bad := range []string{`"abc-123"`, `W/"user-42-0123456789abcdef0123456789abcdef"`, `"0123456789ABCDEF0123456789ABCDEF"`} {
		e2 := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{ETag: bad, Honor304: true}, "1.1.0", KindInstaller)
		var st2 State
		check(t, e2, &st2, false)
		e2.clk.Add(25 * time.Hour)
		check(t, e2, &st2, false)
		if st2.ETag != "" {
			t.Errorf("%s stored", bad)
		}
		for _, r := range e2.fake.Requests() {
			if r.Header.Get("If-None-Match") != "" {
				t.Errorf("%s sent back", bad)
			}
		}
	}
}

func TestRateLimits(t *testing.T) {
	e := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{}, "1.1.0", KindInstaller)
	reset := e.clk.Now().Add(40 * time.Minute)
	e.fake.Set(makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{RateLimitReset: reset.Unix()})
	var st State
	check(t, e, &st, false)
	if st.Error == nil || st.Error.Code != CodeRateLimited || !st.Error.RetryAt.Equal(reset) {
		t.Fatalf("primary limit: %+v", st.Error)
	}
	if st.NextCheck.Sub(e.clk.Now()) < CheckInterval {
		t.Error("the next automatic check is less than a day away")
	}
	e.log.has(t, "W update check failed: rate_limited until "+reset.Format("15:04")+"Z")
	// a manual check while the limit is in force makes no request
	e.clk.Add(10 * time.Minute)
	n := len(e.fake.Requests())
	if rep := check(t, e, &st, true); !rep.Reused || len(e.fake.Requests()) != n {
		t.Error("a manual check during the rate limit made a request")
	}
	if v := view(e, &st); v.Error == nil || v.Error.Code != CodeRateLimited || v.Error.RetryAt == nil {
		t.Errorf("%+v", v)
	}

	e2 := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{RetryAfter: "120"}, "1.1.0", KindInstaller)
	var st2 State
	check(t, e2, &st2, false)
	if st2.Error == nil || st2.Error.Code != CodeRateLimited || !st2.Error.RetryAt.Equal(e2.clk.Now().Add(2*time.Minute)) {
		t.Errorf("secondary limit: %+v", st2.Error)
	}
	e3 := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{RetryAfter: "999999"}, "1.1.0", KindInstaller)
	var st3 State
	check(t, e3, &st3, false)
	if st3.Error.RetryAt.Sub(e3.clk.Now()) != 24*time.Hour {
		t.Error("retry-after isn't capped at 24 h")
	}
}

func TestManualThrottle(t *testing.T) {
	e := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{}, "1.1.0", KindInstaller)
	var st State
	check(t, e, &st, true)
	n := len(e.fake.Requests())
	e.clk.Add(30 * time.Second)
	if rep := check(t, e, &st, true); !rep.Reused || len(e.fake.Requests()) != n {
		t.Error("a manual check within 60 s of the last contact made a request")
	}
	e.clk.Add(31 * time.Second)
	if rep := check(t, e, &st, true); rep.Reused || !rep.Contacted {
		t.Error("a manual check after 60 s was throttled")
	}
}

func TestOfflineAndTimeout(t *testing.T) {
	// a closed port: offline, again in an hour
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	base := "http://" + l.Addr().String()
	l.Close()
	log := &logbuf{}
	clk := &clock{t: time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)}
	c, err := New(Config{Current: "1.1.0", Kind: KindInstaller, APIBase: base, DownloadBase: base, Logf: log.Logf, Now: clk.Now,
		Jitter: func() time.Duration { return 0 }, APITimeout: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	var st State
	rep := c.Check(context.Background(), &st, false)
	if rep.Contacted || st.Error == nil || st.Error.Code != CodeOffline || st.LastContact != nil {
		t.Fatalf("offline: %+v %+v", rep, st.Error)
	}
	if got := st.NextCheck.Sub(clk.Now()); got != OfflineRetry {
		t.Errorf("offline: next check in %s", got)
	}
	log.has(t, "W update check failed: offline")
	if regexp.MustCompile(`127\.0\.0\.1|http|:[0-9]{2,5}\b`).MatchString(log.String()) {
		t.Errorf("the log has an address: %s", log.String())
	}

	// no answer: timeout, again tomorrow
	e := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{StallAPI: true}, "1.1.0", KindInstaller,
		func(c *Config) { c.APITimeout = 300 * time.Millisecond })
	var st2 State
	check(t, e, &st2, false)
	if st2.Error == nil || st2.Error.Code != CodeTimeout {
		t.Fatalf("timeout: %+v", st2.Error)
	}
	if got := st2.NextCheck.Sub(e.clk.Now()); got != CheckInterval {
		t.Errorf("timeout: next check in %s", got)
	}
}

func TestBadAnswers(t *testing.T) {
	for name, c := range map[string]struct {
		opt  fakegh.Options
		code string
	}{
		"oversized":            {fakegh.Options{Oversize: true}, CodeBadAnswer},
		"not JSON":             {fakegh.Options{Malformed: true}, CodeBadAnswer},
		"redirect elsewhere":   {fakegh.Options{RedirectAPI: "https://evil.example/repos/x"}, CodeBadAnswer},
		"redirect to http":     {fakegh.Options{RedirectAPI: "http://127.0.0.1:1/repos/x"}, CodeBadAnswer},
		"server error":         {fakegh.Options{LatestStatus: 502}, CodeHTTPError},
		"forbidden, no limits": {fakegh.Options{LatestStatus: 403}, CodeHTTPError},
		"no release":           {fakegh.Options{LatestStatus: 404}, CodeNoRelease},
		"download redirect":    {fakegh.Options{RedirectDownload: "https://evil.example/x"}, CodeBadAnswer},
	} {
		e := setup(t, makeRel("1.2.0", fakegh.Test1Seed), c.opt, "1.1.0", KindInstaller)
		var st State
		check(t, e, &st, false)
		v := view(e, &st)
		if v.State != StateError || v.Error == nil || v.Error.Code != c.code || v.Latest != nil {
			t.Errorf("%s: %+v", name, v)
		}
		if c.code == CodeHTTPError && (v.Error.HTTPStatus == nil || *v.Error.HTTPStatus != c.opt.LatestStatus) {
			t.Errorf("%s: no http status", name)
		}
		if strings.Contains(e.log.String(), "evil") {
			t.Errorf("%s: a redirect target was logged", name)
		}
	}
}

// §2.1, §10: every request carries exactly the allowed headers, no query string, no cookie, no identifier.
func TestPrivacyOfRequests(t *testing.T) {
	etag := `"0123456789abcdef0123456789abcdef"`
	e := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{ETag: etag, Honor304: true, CutAt: 0.4}, "1.1.0", KindInstaller)
	var st State
	check(t, e, &st, false)
	e.clk.Add(25 * time.Hour)
	check(t, e, &st, false)
	ver, asset, _, _ := st.Available("1.1.0", KindInstaller)
	if _, err := e.c.DownloadInstaller(context.Background(), t.TempDir(), ver, asset, &st, nil); err != nil {
		t.Fatal(err)
	}
	allowed := map[string]bool{"Accept": true, "X-Github-Api-Version": true, "User-Agent": true, "Accept-Encoding": true}
	for _, r := range e.fake.Requests() {
		for k := range r.Header {
			ok := allowed[k] || (k == "If-None-Match" && r.Path == fakegh.LatestPath()) || (k == "Range" && (strings.HasPrefix(r.Path, "/dl/") || strings.HasPrefix(r.Path, fakegh.DownloadPrefix())))
			if !ok {
				t.Errorf("%s: header %s", r.Path, k)
			}
		}
		if r.Header.Get("User-Agent") != "EncoreBridge/1.1.0" || r.Header.Get("Accept") != "application/vnd.github+json" ||
			r.Header.Get("X-Github-Api-Version") != "2022-11-28" {
			t.Errorf("%s: headers %v", r.Path, r.Header)
		}
		if r.RawQuery != "" && !strings.HasPrefix(r.Path, "/dl/") { // only GitHub's own redirect target has a query
			t.Errorf("%s: query string sent", r.Path)
		}
	}
	if e.fake.Count("/dl/") < 3 {
		t.Error("the download wasn't resumed")
	}
	logs := e.log.String()
	for _, bad := range []string{"127.0.0.1", "http", "0123456789abcdef", "sig=", "evil", string(os.PathSeparator) + "tmp", "Temp"} {
		if strings.Contains(logs, bad) {
			t.Errorf("the log contains %q:\n%s", bad, logs)
		}
	}
}

// ---- downloads (§5.4)

func availableEnv(t *testing.T, opt fakegh.Options, mod ...func(*Config)) (*env, *State, string, Asset, string) {
	t.Helper()
	e := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{}, "1.1.0", KindInstaller, mod...)
	var st State
	check(t, e, &st, false)
	ver, asset, sha, ok := st.Available("1.1.0", KindInstaller)
	if !ok {
		t.Fatal("not available")
	}
	e.fake.Set(makeRel("1.2.0", fakegh.Test1Seed), opt)
	e.fake.ResetRequests()
	return e, &st, ver, asset, sha
}

func TestDownloadResumeAfterCut(t *testing.T) {
	e, st, ver, asset, sha := availableEnv(t, fakegh.Options{CutAt: 0.4})
	dir := t.TempDir()
	var last [2]int64
	path, err := e.c.DownloadInstaller(context.Background(), dir, ver, asset, st, func(d, tot int64) { last = [2]int64{d, tot} })
	if err != nil {
		t.Fatal(err)
	}
	ranged := false
	for _, r := range e.fake.Requests() {
		if strings.HasPrefix(r.Header.Get("Range"), "bytes=") && r.Header.Get("Range") != "bytes=0-" {
			ranged = true
		}
	}
	if !ranged {
		t.Error("no Range request after the cut")
	}
	f, err := OpenVerified(path, os.Open, sha, asset.Size)
	if err != nil {
		t.Fatalf("resumed file: %v", err)
	}
	f.Close()
	if last != [2]int64{asset.Size, asset.Size} {
		t.Errorf("final progress %v", last)
	}
	e.log.has(t, "I update: download_failed (try 1 of 3)")
	if st.Download == nil || st.Download.Version != "1.2.0" || st.Download.Size != asset.Size {
		t.Errorf("download record %+v", st.Download)
	}
}

func TestDownload200ToRangeRestarts(t *testing.T) {
	e, st, ver, asset, sha := availableEnv(t, fakegh.Options{CutAt: 0.4, IgnoreRange: true})
	path, err := e.c.DownloadInstaller(context.Background(), t.TempDir(), ver, asset, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	f, err := OpenVerified(path, os.Open, sha, asset.Size)
	if err != nil {
		t.Fatalf("restarted file: %v", err)
	}
	f.Close()
}

func TestDownloadResumesPartFromEarlierClick(t *testing.T) {
	e, st, ver, asset, sha := availableEnv(t, fakegh.Options{})
	dir := t.TempDir()
	st.Download = &DownloadRec{Version: ver, AssetID: asset.ID, Size: asset.Size}
	full := installer("1.2.0")
	os.WriteFile(filepath.Join(dir, InstallerName(ver)+".part"), full[:1000], 0o600)
	path, err := e.c.DownloadInstaller(context.Background(), dir, ver, asset, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	if r := e.fake.Requests(); len(r) < 2 || r[len(r)-1].Header.Get("Range") != "bytes=1000-" {
		t.Error("the .part wasn't resumed")
	}
	e.log.has(t, "I update: resumed at 0.0 MB")
	if _, err := OpenVerified(path, os.Open, sha, asset.Size); err != nil {
		t.Fatal(err)
	}
	// a .part longer than the installer is thrown away (and doesn't make the space check fail)
	os.Remove(path)
	os.WriteFile(filepath.Join(dir, InstallerName(ver)+".part"), append(full, 'x', 'y'), 0o600)
	e.fake.ResetRequests()
	e.c.cfg.FreeSpace = func(string) (uint64, error) { return uint64(asset.Size) + 65<<20, nil }
	defer func() { e.c.cfg.FreeSpace = nil }()
	if path, err = e.c.DownloadInstaller(context.Background(), dir, ver, asset, st, nil); err != nil {
		t.Fatalf("a too long .part: %v", err)
	}
	if _, err := OpenVerified(path, os.Open, sha, asset.Size); err != nil {
		t.Fatal(err)
	}
	// a .part of another version is thrown away
	st.Download = &DownloadRec{Version: "1.1.9", AssetID: 1, Size: 5}
	os.WriteFile(filepath.Join(dir, InstallerName(ver)+".part"), []byte("garbage"), 0o600)
	os.Remove(path)
	e.fake.ResetRequests()
	if _, err := e.c.DownloadInstaller(context.Background(), dir, ver, asset, st, nil); err != nil {
		t.Fatal(err)
	}
	for _, r := range e.fake.Requests() {
		if r.Header.Get("Range") != "" {
			t.Error("a .part of another download was resumed")
		}
	}
}

func TestDownloadFailures(t *testing.T) {
	// the API's size doesn't match the file
	e, st, ver, asset, _ := availableEnv(t, fakegh.Options{})
	asset.Size += 10
	_, err := e.c.DownloadInstaller(context.Background(), t.TempDir(), ver, asset, st, nil)
	var f *Failure
	if !errors.As(err, &f) || f.Code != CodeDownloadFailed {
		t.Errorf("size mismatch: %v", err)
	}
	e.log.has(t, "I update: download_failed (try 3 of 3)")

	// stalled
	e2, st2, ver2, asset2, _ := availableEnv(t, fakegh.Options{StallDownload: true})
	start := time.Now()
	_, err = e2.c.DownloadInstaller(context.Background(), t.TempDir(), ver2, asset2, st2, nil)
	if !errors.As(err, &f) || f.Code != CodeDownloadFailed {
		t.Errorf("stall: %v", err)
	}
	if time.Since(start) > 10*time.Second {
		t.Error("the stall wasn't detected")
	}

	// redirected to a host that isn't GitHub's
	e3, st3, ver3, asset3, _ := availableEnv(t, fakegh.Options{RedirectDownload: "https://evil.example/x"})
	_, err = e3.c.DownloadInstaller(context.Background(), t.TempDir(), ver3, asset3, st3, nil)
	if !errors.As(err, &f) || f.Code != CodeDownloadFailed {
		t.Errorf("bad redirect: %v", err)
	}

	// no space
	e4, st4, ver4, asset4, _ := availableEnv(t, fakegh.Options{}, func(c *Config) {
		c.FreeSpace = func(string) (uint64, error) { return 10 << 20, nil }
	})
	_, err = e4.c.DownloadInstaller(context.Background(), t.TempDir(), ver4, asset4, st4, nil)
	if !errors.As(err, &f) || f.Code != CodeNoSpace {
		t.Errorf("no space: %v", err)
	}
	if e4.fake.Count("/") != 0 {
		t.Error("downloaded without the space for it")
	}
}

func TestDownloadCancelKeepsPart(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	e, st, ver, asset, _ := availableEnv(t, fakegh.Options{CutAt: 0.4}, func(c *Config) {
		c.Sleep = func(context.Context, time.Duration) error { cancel(); return context.Canceled } // Cancel during the wait
	})
	dir := t.TempDir()
	_, err := e.c.DownloadInstaller(ctx, dir, ver, asset, st, nil)
	if !errors.Is(err, ErrCancelled) {
		t.Fatalf("cancel: %v", err)
	}
	fi, err := os.Stat(filepath.Join(dir, InstallerName(ver)+".part"))
	if err != nil || fi.Size() == 0 || fi.Size() >= asset.Size {
		t.Errorf("the .part wasn't kept: %v", err)
	}
	e.log.has(t, "I update: cancelled")
}

func TestHashMismatchDeletes(t *testing.T) {
	rel := makeRel("1.2.0", fakegh.Test1Seed)
	e := setup(t, rel, fakegh.Options{}, "1.1.0", KindInstaller)
	var st State
	check(t, e, &st, false)
	ver, asset, sha, _ := st.Available("1.1.0", KindInstaller)
	// the installer changes after signing (same size)
	tampered := makeRel("1.2.0", fakegh.Test1Seed)
	b := append([]byte(nil), tampered.Files[InstallerName(ver)]...)
	b[len(b)/2] ^= 0xff
	tampered.Files[InstallerName(ver)] = b
	e.fake.Set(tampered, fakegh.Options{})
	dir := t.TempDir()
	path, err := e.c.DownloadInstaller(context.Background(), dir, ver, asset, &st, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenVerified(path, os.Open, sha, asset.Size); !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("mismatch not found: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Error("the mismatching installer wasn't deleted")
	}
}

// At Update now the small files are fetched again and checked (§4.3).
func TestVerifyReleaseAgain(t *testing.T) {
	e := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{}, "1.1.0", KindInstaller)
	vr := e.c.VerifyRelease(context.Background(), "1.2.0", InstallerName("1.2.0"))
	if vr.Code != "" || vr.Err != nil || vr.KeyID != test1.ID || len(vr.SHA256) != 64 {
		t.Fatalf("%+v", vr)
	}
	bad := makeRel("1.2.0", fakegh.Test1Seed)
	bad.Files[SigName] = fakegh.Sign(fakegh.Test2Seed, bad.Files[SumsName])
	e.fake.Set(bad, fakegh.Options{})
	if vr := e.c.VerifyRelease(context.Background(), "1.2.0", InstallerName("1.2.0")); vr.Code != CodeBadSignature {
		t.Errorf("%+v", vr)
	}
}

// ---- state and schedule

func TestStateRoundTrip(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "update.json")
	e := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{ETag: `"0123456789abcdef0123456789abcdef"`}, "1.1.0", KindInstaller)
	var st State
	check(t, e, &st, false)
	st.Download = &DownloadRec{Version: "1.2.0", AssetID: 7, Size: 9}
	st.Pending = &Pending{From: "1.1.0", To: "1.2.0", StartedAt: e.clk.Now()}
	st.V = StateVersion
	if err := SaveState(p, st); err != nil {
		t.Fatal(err)
	}
	got := LoadState(p)
	a, _ := json.Marshal(st.Clone())
	b, _ := json.Marshal(got)
	if !bytes.Equal(a, b) {
		t.Errorf("round trip:\n%s\n%s", a, b)
	}
	raw, _ := os.ReadFile(p)
	if bytes.Contains(raw, []byte(dir)) || bytes.Contains(raw, []byte("127.0.0.1")) {
		t.Error("update.json holds a path or an address")
	}
	for name, content := range map[string]string{
		"garbage": "{nope", "newer": `{"v": 2}`, "older": `{"v": 0}`,
		"bad etag":    `{"v": 1, "etag": "\"tracking-id-42\""}`,
		"bad version": `{"v": 1, "result": {"state": "available", "version": "1.2.0; rm -rf"}}`,
	} {
		os.WriteFile(p, []byte(content), 0o600)
		if s := LoadState(p); s.V != StateVersion || s.Result != nil || s.ETag != "" || !s.Due(e.clk.Now()) {
			t.Errorf("%s: not fresh: %+v", name, s)
		}
	}
	if s := LoadState(filepath.Join(dir, "missing.json")); !s.Due(time.Now()) {
		t.Error("missing state isn't due")
	}
}

// Over a simulated week, with evaluations every 30 minutes and the clock going back two days on day 3, GitHub is
// contacted at most once a day and never twice within 23 hours.
func TestScheduleOverAWeek(t *testing.T) {
	e := setup(t, makeRel("1.1.0", fakegh.Test1Seed), fakegh.Options{}, "1.1.0", KindInstaller,
		func(c *Config) { c.Jitter = func() time.Duration { return 17 * time.Minute } })
	var st State
	var sc Scheduler
	real0 := e.clk.Now()
	var contacts []time.Time
	for step := time.Duration(0); step <= 7*24*time.Hour; step += EvalEvery {
		mono := real0.Add(step)
		wall := mono
		if step >= 3*24*time.Hour {
			wall = mono.Add(-48 * time.Hour)
		}
		e.clk.t = wall
		if due, _ := AutoCheckDue(&st, &sc, wall, mono, true); due {
			if rep := e.c.Check(context.Background(), &st, false); rep.Contacted {
				sc.Contacted(mono)
				contacts = append(contacts, mono)
			}
		}
	}
	if len(contacts) < 5 || len(contacts) > 8 {
		t.Errorf("%d contacts in a week", len(contacts))
	}
	for i := 1; i < len(contacts); i++ {
		if contacts[i].Sub(contacts[i-1]) < MinAutoGap {
			t.Errorf("contacts %s apart", contacts[i].Sub(contacts[i-1]))
		}
	}
	if int(e.c.Requests()) != len(contacts) {
		t.Errorf("%d requests, %d contacts", e.c.Requests(), len(contacts))
	}
}

// UPDATE_CHECK=0: no automatic request over a week; a manual check still works.
func TestAutoOffMakesNoRequests(t *testing.T) {
	e := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{}, "1.1.0", KindInstaller)
	var st State
	var sc Scheduler
	start := e.clk.Now()
	for step := time.Duration(0); step <= 7*24*time.Hour; step += EvalEvery {
		e.clk.t = start.Add(step)
		if due, _ := AutoCheckDue(&st, &sc, e.clk.t, e.clk.t, false); due {
			e.c.Check(context.Background(), &st, false)
		}
	}
	if n := len(e.fake.Requests()); n != 0 {
		t.Fatalf("%d requests with automatic checks off", n)
	}
	if rep := check(t, e, &st, true); !rep.Contacted || view(e, &st).State != StateAvailable {
		t.Error("a manual check didn't work with automatic checks off")
	}
}

func TestFixClock(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	future := now.Add(72 * time.Hour)
	nc := now.Add(96 * time.Hour)
	st := State{LastContact: &future, NextCheck: &nc}
	if !st.FixClock(now) || !st.LastContact.Equal(now) || !st.NextCheck.Equal(now.Add(CheckInterval)) {
		t.Errorf("%+v", st)
	}
	if st.FixClock(now) {
		t.Error("FixClock changed a sane state")
	}
}

func TestViewModes(t *testing.T) {
	st := State{}
	if v := MakeView(&st, KindInstaller, "1.1.0", false, false, nil); v.Auto || v.AutoOff == nil || *v.AutoOff != AutoOffSetting || v.NextCheckAt != nil {
		t.Errorf("setting off: %+v", v)
	}
	if v := MakeView(&st, KindZip, "1.1.0", true, true, nil); v.State != StateChecking || !v.Auto || v.AutoOff != nil || v.Source != "launcher" {
		t.Errorf("checking: %+v", v)
	}
	// an error about a version this copy already has isn't shown
	st = State{Result: &Result{State: ResultBadSignature, Version: "1.1.0"}}
	if v := MakeView(&st, KindInstaller, "1.1.0", true, false, nil); v.State != StateUpToDate || v.Error != nil {
		t.Errorf("stale error: %+v", v)
	}
	// a known release stays available when a later check couldn't reach GitHub
	e := setup(t, makeRel("1.2.0", fakegh.Test1Seed), fakegh.Options{}, "1.1.0", KindInstaller)
	var st2 State
	check(t, e, &st2, false)
	st2.Error = &CheckError{Code: CodeOffline}
	if v := view(e, &st2); v.State != StateAvailable || v.Error == nil || v.Error.Code != CodeOffline {
		t.Errorf("available + offline: %+v", v)
	}
	// after updating to it, the same result is up to date
	if v := MakeView(&st2, KindInstaller, "1.2.0", true, false, nil); v.State != StateError && v.State != StateUpToDate {
		t.Errorf("after the update: %+v", v)
	}
	b, _ := json.Marshal(view(e, &st2))
	for _, f := range []string{`"v":1`, `"source":"launcher"`, `"kind":"windows-installer"`, `"current":"1.1.0"`, `"auto":true`, `"auto_off":null`,
		`"state":"available"`, `"checked_at":"2026-10-10T12:00:00Z"`, `"next_check_at":`, `"latest":{`, `"notes_url":`, `"install":null`} {
		if !strings.Contains(string(b), f) {
			t.Errorf("view JSON lacks %s: %s", f, b)
		}
	}
}
