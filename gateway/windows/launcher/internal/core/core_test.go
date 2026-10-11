package core

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseSettings(t *testing.T) {
	in := "\xef\xbb\xbf# note\r\nPORT=8096\r\n\r\n  SPOTIFY_CLIENT_ID = abc123  \r\nADMIN_PASSWORD=\"p#ss word\"\r\nQ='x'\r\n" +
		"bad line\r\nlower=1\r\nEMPTY=\r\nPORT=8097\r\nURL=http://a/b?c=d\r\n"
	s := ParseSettings([]byte(in))
	want := map[string]string{"PORT": "8097", "SPOTIFY_CLIENT_ID": "abc123", "ADMIN_PASSWORD": "p#ss word", "Q": "x", "EMPTY": "", "URL": "http://a/b?c=d"}
	for k, v := range want {
		if got := s.Values[k]; got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	if _, ok := s.Values["lower"]; ok {
		t.Error("lower-case key accepted")
	}
	if len(s.Warnings) != 2 {
		t.Errorf("warnings = %v", s.Warnings)
	}
	if _, ok := s.Get("EMPTY"); ok {
		t.Error("an empty value must count as unset")
	}
	if strings.Join(s.Order, ",") != "PORT,SPOTIFY_CLIENT_ID,ADMIN_PASSWORD,Q,EMPTY,URL" {
		t.Errorf("order = %v", s.Order)
	}
}

func TestPortPrecedence(t *testing.T) {
	s := ParseSettings([]byte("PORT=9000\n"))
	env := EnvLookup([]string{"Port=9100"})
	if p, bad := Port(env, s); p != 9100 || bad {
		t.Errorf("env should win (case-insensitive): %d %v", p, bad)
	}
	if p, _ := Port(EnvLookup(nil), s); p != 9000 {
		t.Errorf("settings: %d", p)
	}
	if p, _ := Port(EnvLookup([]string{"PORT="}), s); p != 9000 {
		t.Errorf("empty env value must not win: %d", p)
	}
	for _, v := range []string{"0", "65536", "80a", "-1", "999999999999"} {
		if p, bad := Port(nil, ParseSettings([]byte("PORT="+v))); p != 8095 || !bad {
			t.Errorf("PORT=%s: %d %v", v, p, bad)
		}
	}
	if p, bad := Port(nil, Settings{Values: map[string]string{}}); p != 8095 || bad {
		t.Errorf("default: %d %v", p, bad)
	}
}

func TestEnsureFile(t *testing.T) {
	dir := t.TempDir()
	tpl := filepath.Join(dir, "t.env")
	os.WriteFile(tpl, []byte("PORT=8095\r\n"), 0o600)
	dst := filepath.Join(dir, "sub", "settings.env")
	created, err := EnsureFile(dst, tpl)
	if err != nil || !created {
		t.Fatalf("first: %v %v", created, err)
	}
	os.WriteFile(dst, []byte("PORT=1\r\n"), 0o600)
	created, err = EnsureFile(dst, tpl)
	if err != nil || created {
		t.Fatalf("second: %v %v", created, err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "PORT=1\r\n" {
		t.Error("an existing settings.env was overwritten")
	}
}

func TestChildEnv(t *testing.T) {
	l := Layout{AppDir: `C:\Program Files\Encore Bridge`, DataRoot: `C:\Users\X\AppData\Local\Encore`}
	base := []string{"=C:=C:\\x", "Path=C:\\Windows", "node_options=--require evil.js", "NODE_PATH=x", "ENCORE_LAUNCHER_TOKEN=old", "FFMPEG=C:\\my\\ffmpeg.exe"}
	s := ParseSettings([]byte("ENGINE_EXE=D:\\engine.exe\nENGINE_CONFIG_TEMPLATE=\n"))
	env := ChildEnv(base, s, l, "tok")
	get := EnvLookup(env)
	if _, ok := get("NODE_OPTIONS"); ok {
		t.Error("NODE_OPTIONS must be removed (any case)")
	}
	if _, ok := get("NODE_PATH"); ok {
		t.Error("NODE_PATH must be removed")
	}
	if v, _ := get("ENCORE_LAUNCHER_TOKEN"); v != "tok" {
		t.Errorf("token = %q", v)
	}
	if v, _ := get("FFMPEG"); v != `C:\my\ffmpeg.exe` {
		t.Errorf("the user's FFMPEG must stay: %q", v)
	}
	if v, ok := get("ENGINE_EXE"); ok {
		t.Errorf("ENGINE_EXE from settings.env must not be overridden by the env: %q", v)
	}
	if v, _ := get("ENGINE_CONFIG_TEMPLATE"); v != filepath.Join(l.AppDir, "engine", "config.template.yml") {
		t.Errorf("an empty settings value counts as unset: %q", v)
	}
	if v, _ := get("ENCORE_HOME"); v != l.DataRoot {
		t.Errorf("ENCORE_HOME = %q", v)
	}
	if env[0] != "=C:=C:\\x" {
		t.Error("drive-cwd entries must be kept")
	}
}

func TestRedactor(t *testing.T) {
	r := NewRedactor(`C:\Users\José Q`)
	cases := map[string]string{
		`lockfile: C:\Users\José Q\AppData\Local\Encore\engine\lockfile`: `lockfile: %USERPROFILE%\AppData\Local\Encore\engine\lockfile`,
		`open c:/users/josé q/x`:                       `open %USERPROFILE%/x`,
		`{"path":"C:\\Users\\José Q\\AppData"}`:        `{"path":"%USERPROFILE%\\AppData"}`,
		`home is C:\Users\José Q`:                      `home is %USERPROFILE%`,
		`other user C:\Users\José Quintana\x`:          `other user C:\Users\José Quintana\x`,
		`C:\Users\José Q. done`:                        `%USERPROFILE%. done`,
		`two: "C:\Users\José Q" and C:\USERS\JOSÉ Q\b`: `two: "%USERPROFILE%" and %USERPROFILE%\b`,
		`nothing here`:                                 `nothing here`,
	}
	for in, want := range cases {
		if got := r.Line(in); got != want {
			t.Errorf("Line(%q) = %q, want %q", in, got, want)
		}
	}
	if NewRedactor("").Line("C:\\Users\\a") != "C:\\Users\\a" {
		t.Error("empty redactor must not change lines")
	}
}

func TestRotatingLog(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "logs", "bridge.log")
	l, err := OpenLog(p, 10000, 2, NewRedactor(`C:\Users\Q`))
	if err != nil {
		t.Fatal(err)
	}
	day := time.Date(2026, 10, 7, 23, 59, 0, 0, time.UTC)
	l.Now = func() time.Time { return day }
	l.Line(`12:00:00.000 I hello C:\Users\Q\x` + "\n")
	l.Launcher("W", "port %d in C:\\Users\\Q", 8095)
	day = day.Add(2 * time.Minute)
	l.Line("after midnight")
	l.Close()
	b, _ := os.ReadFile(p)
	got := string(b)
	for _, want := range []string{"---- 2026-10-07 (UTC+00:00) ----\r\n", "12:00:00.000 I hello %USERPROFILE%\\x\r\n",
		"23:59:00.000 W [launcher] port 8095 in %USERPROFILE%\r\n", "---- 2026-10-08", "after midnight\r\n"} {
		if !strings.Contains(got, want) {
			t.Errorf("log lacks %q:\n%s", want, got)
		}
	}

	r, err := OpenLog(filepath.Join(dir, "r.log"), 200, 2, nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 40; i++ {
		r.Line(strings.Repeat("x", 30))
	}
	r.Close()
	for _, f := range []string{"r.log", "r.log.1", "r.log.2"} {
		st, err := os.Stat(filepath.Join(dir, f))
		if err != nil || st.Size() > 260 {
			t.Errorf("%s: %v", f, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "r.log.3")); err == nil {
		t.Error("keeps more files than asked")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "r.log.1")); !strings.HasPrefix(string(b), "---- ") {
		t.Error("a rotated file must start with a date line")
	}
}

func TestPumpLines(t *testing.T) {
	var got []string
	in := "a\r\nbb\n" + strings.Repeat("z", 25) + "\nlast"
	if err := PumpLines(strings.NewReader(in), 10, func(s string) { got = append(got, s) }); err != nil {
		t.Fatal(err)
	}
	want := []string{"a", "bb", "zzzzzzzzzz", "zzzzzzzzzz", "zzzzz", "last"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("got %q", got)
	}
}

func TestRestarter(t *testing.T) {
	r := NewRestarter()
	var delays []time.Duration
	for i := 0; i < 4; i++ {
		d, give := r.After(2 * time.Second)
		if give {
			t.Fatalf("gave up after %d", i+1)
		}
		delays = append(delays, d)
	}
	if delays[0] != time.Second || delays[3] != 10*time.Second {
		t.Errorf("delays %v", delays)
	}
	if _, give := r.After(time.Second); !give {
		t.Error("should give up after five quick failures")
	}
	r.Reset()
	if d, give := r.After(5 * time.Minute); give || d != time.Second {
		t.Errorf("after a healthy run: %v %v", d, give)
	}
	for i := 0; i < 10; i++ {
		r.After(2 * time.Minute)
	}
	if d, _ := r.After(2 * time.Minute); d != time.Second {
		t.Errorf("healthy runs keep the first delay: %v", d)
	}
}

func TestPrefs(t *testing.T) {
	p := filepath.Join(t.TempDir(), "launcher.json")
	if !LoadPrefs(p).KeepAwake {
		t.Error("default keep-awake must be on")
	}
	if err := SavePrefs(p, Prefs{KeepAwake: false}); err != nil {
		t.Fatal(err)
	}
	if LoadPrefs(p).KeepAwake {
		t.Error("not saved")
	}
	os.WriteFile(p, []byte("{broken"), 0o600)
	if !LoadPrefs(p).KeepAwake {
		t.Error("a broken file must give the defaults")
	}
}

func bp(b bool) *bool     { return &b }
func sp(s string) *string { return &s }
func st(js string) *Status {
	s, err := ParseStatus([]byte(js))
	if err != nil {
		panic(err)
	}
	return s
}

func TestCompute(t *testing.T) {
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	base := `{"contract":1,"bridge":{"version":"1.1.0","uptime_s":5,"port":8095},"engine":{"state":"running","version":"encore-1.1.0","expected":"encore-1.1.0","connected":true,"signed_in":true,"restarts":0},` +
		`"sign_in":null,"admin":{"setup_needed":false},"spotify":{"connected":true},"phones":{"paired":1,"listening":%s},"playing":false,"showcase":%s,"phone_url":"http://192.168.1.20:8095"}`
	mk := func(listening, showcase string) *Status {
		return st(strings.Replace(strings.Replace(base, "%s", listening, 1), "%s", showcase, 1))
	}

	v := Compute(Input{State: StateRunning, Port: 8095, Status: mk("0", "false"), LauncherVersion: "1.1.0", Now: now})
	if v.Icon != IconOK || v.Headline != "Ready" || v.PhoneURL != "http://192.168.1.20:8095" || v.PhoneHidden || v.Showcase == nil || *v.Showcase {
		t.Errorf("ready: %+v", v)
	}
	v = Compute(Input{State: StateRunning, Status: mk("2", "true"), LauncherVersion: "1.1.0"})
	if v.Headline != "Streaming to 2 phones" || v.PhoneURL != "" || !v.PhoneHidden || v.Listening != 2 {
		t.Errorf("showcase streaming: %+v", v)
	}
	if strings.Contains(v.Tooltip, "192.168") {
		t.Error("address in the tooltip")
	}
	v = Compute(Input{State: StateRunning, Status: mk("0", "false"), LauncherVersion: "1.2.0"})
	if !v.VersionMismatch || v.Icon != IconAttention {
		t.Errorf("version mismatch: %+v", v)
	}
	v = Compute(Input{State: StateRunning, Status: mk("0", "false"), LauncherVersion: "dev"})
	if v.VersionMismatch {
		t.Error("dev builds never mismatch")
	}

	signin := st(`{"engine":{"state":"running","signed_in":false},"sign_in":{"url":"https://accounts.spotify.com/pair?code=ABCD","code":"ABCD-EFGH","expires_at":"2026-10-07T12:09:30Z"},"phones":{}}`)
	v = Compute(Input{State: StateRunning, Status: signin, Now: now})
	if v.Icon != IconAttention || !v.SignInNeeded || v.SignIn == nil || !v.FirstRunNeeds || v.Headline != "Sign in to Spotify" {
		t.Errorf("sign in: %+v", v)
	}
	if v.Showcase != nil {
		t.Error("a missing showcase field means unsupported")
	}
	txt := SignInText(v.SignIn, now)
	if !strings.Contains(txt, "ABCD-EFGH") || !strings.Contains(txt, "accounts.spotify.com/pair") || !strings.Contains(txt, "9 more minutes") {
		t.Errorf("sign-in text: %s", txt)
	}
	sc := SignInTextShowcase(v.SignIn, now)
	if strings.Contains(sc, "ABCD") || !strings.Contains(sc, "Showcase mode is on") || !strings.Contains(sc, "accounts.spotify.com/pair") {
		t.Errorf("sign-in text in Showcase: %s", sc)
	}
	evil := &SignIn{URL: "https://spotify.com.evil.example/x", Code: "X"}
	if evil.SafeURL() != "" || (&SignIn{URL: "http://www.spotify.com/pair"}).SafeURL() != "" {
		t.Error("only https spotify.com pages may be opened")
	}
	if (&SignIn{ExpiresAt: []byte("1791374400")}).Expires().Unix() != 1791374400 {
		t.Error("numeric expires_at")
	}

	setup := st(`{"engine":{"state":"running","signed_in":false},"admin":{"setup_needed":true},"phones":{}}`)
	if v := Compute(Input{State: StateRunning, Status: setup}); v.Headline != "Set your admin password" || !v.FirstRunNeeds {
		t.Errorf("setup first: %+v", v)
	}
	mm := st(`{"engine":{"state":"version_mismatch"},"phones":{}}`)
	if v := Compute(Input{State: StateRunning, Status: mm}); v.Headline != "Engine version mismatch" || v.Problem == "" {
		t.Errorf("engine mismatch: %+v", v)
	}
	if v := Compute(Input{State: StateFailed, FailReason: FailExit, ExitCode: ExitPortInUse, Port: 8096}); v.Headline != "Port 8096 is in use" || !strings.Contains(v.Problem, "PORT") {
		t.Errorf("port in use: %+v", v)
	}
	if v := Compute(Input{State: StateRunning, Unsupported: true}); v.Headline != "Running" || v.Icon != IconOK {
		t.Errorf("old bridge: %+v", v)
	}
	if v := Compute(Input{State: StateRunning}); v.Headline != "Starting…" || v.Icon != IconOff {
		t.Errorf("not reachable yet: %+v", v)
	}
	if v := Compute(Input{State: StateFailed, FailReason: FailCrashLoop}); len([]rune(v.Tooltip)) > 127 || v.Problem == "" {
		t.Errorf("crash loop: %+v", v)
	}
	_ = bp
	_ = sp
}
