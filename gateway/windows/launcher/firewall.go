//go:build windows

package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"

	"golang.org/x/sys/windows"

	"encore-bridge/launcher/internal/l10n"
)

// The firewall rule the installer creates (for TCP 8095) and "Fix firewall" re-creates for the bridge's current port
// (replacing only a rule of this name for that same port, so rules for other ports survive). The uninstaller deletes
// every rule of this name, and every rule for its runtime\node.exe.
const fwRuleName = "Encore Bridge (phone)"

// fwReport is what the read-only check finds for runtime\node.exe and the bridge's port.
type fwReport struct {
	Block  int    `json:"block"`  // enabled inbound Block rules for node.exe (left by a cancelled Windows Security prompt)
	Allow  bool   `json:"allow"`  // an enabled inbound Allow rule for node.exe covers TCP <port> on Private networks
	Public bool   `json:"public"` // a network this PC is connected to is set to Public
	Error  string `json:"error"`
}

// The scripts get node.exe's path as base64 (UTF-16LE), so no path can break out of a PowerShell string. Nothing is
// ever piped into Get-/Remove-NetFirewallRule: with an empty pipeline those cmdlets could act on every rule, so each
// call names its rule explicitly.
const fwHead = `$ErrorActionPreference='Stop';$node=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('%s'));$port='%d';` +
	`function Mine($store){$o=@();foreach($f in @(Get-NetFirewallApplicationFilter -PolicyStore $store|Where-Object{$_.Program -and ([Environment]::ExpandEnvironmentVariables($_.Program) -ieq $node)})){` +
	`foreach($x in @(Get-NetFirewallRule -AssociatedNetFirewallApplicationFilter $f)){if([string]$x.Direction -eq 'Inbound'){$o+=$x}}};$o};`

const fwCheck = `$r=[ordered]@{block=0;allow=$false;public=$false;error=''};` +
	`try{$m=@(Mine 'ActiveStore'|Where-Object{[string]$_.Enabled -eq 'True'});$r.block=@($m|Where-Object{[string]$_.Action -eq 'Block'}).Count;` +
	`foreach($x in @($m|Where-Object{[string]$_.Action -eq 'Allow'})){foreach($p in @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $x)){$lp=@($p.LocalPort);` +
	`if((@('TCP','Any') -contains [string]$p.Protocol) -and ($lp -contains 'Any' -or $lp -contains $port) -and ([string]$x.Profile -match 'Private|Any')){$r.allow=$true}}}` +
	`}catch{$r.error=$_.Exception.Message};` +
	`try{$r.public=@(Get-NetConnectionProfile|Where-Object{[string]$_.NetworkCategory -eq 'Public'}).Count -gt 0}catch{};` +
	`$r|ConvertTo-Json -Compress`

const fwFix = `foreach($x in @(Mine 'PersistentStore'|Where-Object{[string]$_.Action -eq 'Block'})){Remove-NetFirewallRule -InputObject $x};` +
	`foreach($x in @(Get-NetFirewallRule -PolicyStore PersistentStore -DisplayName '` + fwRuleName + `' -ErrorAction SilentlyContinue)){` +
	`if(@(@(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $x).LocalPort) -contains $port){Remove-NetFirewallRule -InputObject $x}};` +
	`New-NetFirewallRule -DisplayName '` + fwRuleName + `' -Description 'Lets your phone reach Encore Bridge on home (Private) networks.' ` +
	`-Direction Inbound -Action Allow -Program $node -Protocol TCP -LocalPort $port -Profile Private,Domain|Out-Null;exit 0`

func powershellExe() string {
	return filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

func encodePS(script string) string {
	u := utf16.Encode([]rune(script))
	b := make([]byte, len(u)*2)
	for i, c := range u {
		b[2*i], b[2*i+1] = byte(c), byte(c>>8)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func fwScript(node string, port int, body string) string {
	return fmt.Sprintf(fwHead, encodePS(node), port) + body
}

func psArgs(script string) string {
	return "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand " + encodePS(script)
}

// checkFirewall runs the read-only check (no elevation needed).
func checkFirewall(node string, port int) (fwReport, error) {
	cmd := exec.Command(powershellExe(), strings.Fields(psArgs(fwScript(node, port, fwCheck)))...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	out, err := runWithTimeout(cmd, 60*time.Second)
	var r fwReport
	if err != nil {
		return r, err
	}
	s := strings.TrimSpace(string(out))
	if i := strings.LastIndex(s, "{"); i > 0 {
		s = s[i:]
	}
	if err := json.Unmarshal([]byte(s), &r); err != nil {
		return r, fmt.Errorf("unexpected answer from PowerShell: %w", err)
	}
	return r, nil
}

func runWithTimeout(cmd *exec.Cmd, d time.Duration) ([]byte, error) {
	var out strings.Builder
	cmd.Stdout = &out
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return []byte(out.String()), err
	case <-time.After(d):
		cmd.Process.Kill()
		return nil, errors.New("PowerShell took too long")
	}
}

// fixFirewall is the tray's "Fix firewall…": check, explain, and (after the user agrees and Windows' UAC prompt)
// remove Block rules for node.exe and add the "Encore Bridge (phone)" Allow rule for the current port.
func (a *app) fixFirewall() {
	_, _, _, port, _ := a.bridge.snapshot()
	node := a.layout.Node()
	r, err := checkFirewall(node, port)
	if err == nil && r.Error != "" {
		err = errors.New(r.Error)
	}
	if err != nil {
		a.log.Launcher("W", "firewall check: %v", err)
		msgBox(trf("Couldn't read the Windows Firewall rules: {error}", l10n.Vars{"error": err}), mbWarn)
		return
	}
	a.log.Launcher("I", "firewall check: %d block rule(s), allow rule for port %d: %v, public network: %v", r.Block, port, r.Allow, r.Public)

	var b strings.Builder
	switch {
	case r.Block == 1:
		b.WriteString(tr("Windows Firewall has 1 rule that blocks Encore Bridge. Windows makes these when its security prompt is cancelled.") + "\n\n")
	case r.Block > 1:
		b.WriteString(trf("Windows Firewall has {n} rules that block Encore Bridge. Windows makes these when its security prompt is cancelled.", l10n.Vars{"n": r.Block}) + "\n\n")
	}
	if !r.Allow {
		b.WriteString(trf("No firewall rule lets your phone reach Encore Bridge on port {port}.", l10n.Vars{"port": port}) + "\n\n")
	}
	public := ""
	if r.Public {
		public = tr("This PC's network is set to Public, and Windows keeps your phone out on Public networks. If this is your home network, set it to Private: Settings → Network & internet → Wi-Fi (or Ethernet) → your network → Network profile type → Private.")
	}
	if r.Block == 0 && r.Allow {
		msg := tr("The Windows Firewall rules for Encore Bridge look right.")
		if public != "" {
			msg += "\n\n" + public
		}
		msgBox(msg, mbInfo)
		return
	}
	if !ask(b.String() + tr("Fix this now? Windows will ask for administrator permission.")) {
		return
	}
	code, err := runElevated(powershellExe(), psArgs(fwScript(node, port, fwFix)), 2*time.Minute)
	switch {
	case errors.Is(err, errCancelled):
		return
	case err != nil:
		a.log.Launcher("W", "firewall fix: %v", err)
		msgBox(trf("Couldn't change the firewall rules: {error}", l10n.Vars{"error": err}), mbWarn)
		return
	case code != 0:
		a.log.Launcher("W", "firewall fix: PowerShell exit code %d", code)
	}
	r2, err := checkFirewall(node, port)
	if err != nil || r2.Block > 0 || !r2.Allow {
		msgBox(trf("The firewall rules couldn't all be fixed. Windows Defender Firewall's \"Inbound Rules\" (wf.msc) lists them: look for \"Node.js JavaScript Runtime\" and \"{rule}\".",
			l10n.Vars{"rule": fwRuleName}), mbWarn)
		return
	}
	a.log.Launcher("I", "firewall fixed for port %d", port)
	msg := trf("Fixed: your phone can now reach Encore Bridge on port {port} on Private networks.", l10n.Vars{"port": port})
	if public != "" {
		msg += "\n\n" + public
	}
	msgBox(msg, mbInfo)
}
