package core

import (
	"path/filepath"
	"strings"
)

// Layout is where things are: the install (or unzipped) folder and the per-user data root (CONTRACT.md §1, §7).
type Layout struct {
	AppDir   string // the folder of Encore Bridge.exe
	DataRoot string // %LOCALAPPDATA%\Encore unless overridden
}

func (l Layout) Node() string       { return filepath.Join(l.AppDir, "runtime", "node.exe") }
func (l Layout) MainJS() string     { return filepath.Join(l.AppDir, "gateway", "src", "main.js") }
func (l Layout) GatewayDir() string { return filepath.Join(l.AppDir, "gateway") }
func (l Layout) Engine() string     { return filepath.Join(l.AppDir, "engine", "encore-engine.exe") }
func (l Layout) EngineTemplate() string {
	return filepath.Join(l.AppDir, "engine", "config.template.yml")
}
func (l Layout) FFmpeg() string { return filepath.Join(l.AppDir, "ffmpeg", "ffmpeg.exe") }
func (l Layout) SettingsTemplate() string {
	return filepath.Join(l.AppDir, "settings.env.template")
}
func (l Layout) Licenses() string  { return filepath.Join(l.AppDir, "licenses") }
func (l Layout) Settings() string  { return filepath.Join(l.DataRoot, "settings.env") }
func (l Layout) LogsDir() string   { return filepath.Join(l.DataRoot, "logs") }
func (l Layout) LogFile() string   { return filepath.Join(l.DataRoot, "logs", "bridge.log") }
func (l Layout) PrefsFile() string { return filepath.Join(l.DataRoot, "launcher.json") }

// removedFromChild are never passed on to node.exe: a user's global NODE_OPTIONS (--require, --inspect …) or
// NODE_PATH must not change how the bridge runs, and stale ENCORE_* values must not leak between runs.
var removedFromChild = []string{"NODE_OPTIONS", "NODE_PATH", "ENCORE_HOME", "ENCORE_APP_DIR", "ENCORE_LAUNCHER", "ENCORE_LAUNCHER_TOKEN"}

// ChildEnv builds node.exe's environment (CONTRACT.md §1) from the launcher's own environment (KEY=VALUE entries;
// Windows names are case-insensitive) and settings.env. The path defaults (FFMPEG, ENGINE_EXE,
// ENGINE_CONFIG_TEMPLATE) are added only when neither the environment nor settings.env sets them, so a value in
// settings.env still wins over the launcher's default.
func ChildEnv(base []string, s Settings, l Layout, token string) []string {
	out := make([]string, 0, len(base)+10)
	has := map[string]bool{}
	for _, kv := range base {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || k == "" { // "=C:=C:\..." style entries keep their leading '='
			out = append(out, kv)
			continue
		}
		if containsFold(removedFromChild, k) {
			continue
		}
		if v != "" {
			has[strings.ToUpper(k)] = true
		}
		out = append(out, kv)
	}
	out = append(out,
		"ENCORE_HOME="+l.DataRoot,
		"ENCORE_APP_DIR="+l.AppDir,
		"ENCORE_LAUNCHER=1",
		"ENCORE_LAUNCHER_TOKEN="+token,
	)
	def := func(k, v string) {
		if has[k] {
			return
		}
		if _, ok := s.Get(k); ok {
			return
		}
		out = append(out, k+"="+v)
	}
	def("FFMPEG", l.FFmpeg())
	def("ENGINE_EXE", l.Engine())
	def("ENGINE_CONFIG_TEMPLATE", l.EngineTemplate())
	def("NODE_ENV", "production")
	return out
}

// EnvLookup makes a lookup function over KEY=VALUE entries, matching names case-insensitively like Windows does.
func EnvLookup(entries []string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		for i := len(entries) - 1; i >= 0; i-- {
			k, v, ok := strings.Cut(entries[i], "=")
			if ok && strings.EqualFold(k, key) {
				return v, true
			}
		}
		return "", false
	}
}

func containsFold(list []string, s string) bool {
	for _, x := range list {
		if strings.EqualFold(x, s) {
			return true
		}
	}
	return false
}
