#!/bin/sh
# Smoke test of the installer under Wine: a silent install with Start with Windows, the files and the Run entry (and
# no app package: phones get Encore from the Encore repo in Cydia, not from this PC), an upgrade over a running Encore
# Bridge (Setup must make it quit first), and a silent uninstall (program and Run entry gone, the user's data kept).
# Setup hands no Client ID to the launcher (the setup guide asks for it); with the installer script mounted at /win,
# it also checks that the script has no Client ID page and no Spotify text. Runs in the packaging image:
#   docker run --rm -v "<out>:/out:ro" -v "<this folder>:/td:ro" [-v "<tree>/gateway/windows:/win:ro"] \
#     encore-winbuild-package:1 sh /td/installer-smoke.sh
# Wine has no Windows Firewall, so the netsh steps only run; the firewall rules are checked in the Windows smoke test.
set -u
SETUP="$(ls /out/EncoreBridge-*-setup.exe | head -n 1)"
C=/opt/wine/drive_c
APP="$C/Program Files/Encore Bridge"
FAIL=0
ok()  { echo "ok    $*"; }
bad() { echo "FAIL  $*"; FAIL=1; }
Xvfb :99 >/dev/null 2>&1 &
export DISPLAY=:99
sleep 1
wineboot --init >/dev/null 2>&1
runkey() { wine reg query 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run' /v 'Encore Bridge' 2>/dev/null | tr -d '\r' | grep -i 'Encore Bridge.exe'; }

echo "== install ($(basename "$SETUP"))"
wine "$SETUP" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS=autostart '/LOG=C:\setup1.log' >/dev/null 2>&1
echo "setup exit $?"
for f in "Encore Bridge.exe" runtime/node.exe ffmpeg/ffmpeg.exe gateway/src/main.js gateway/src/admin.html \
         engine/config.template.yml settings.env.template README-Windows.txt VERSIONS.txt licenses/node/LICENSE.txt unins000.exe; do
  [ -f "$APP/$f" ] && ok "installed $f" || bad "missing $f"
done
[ ! -e "$APP/gateway/repo" ] && ok "no gateway/repo (no Cydia source on this PC)" || bad "gateway/repo was installed"
debs="$(find "$APP" -iname '*.deb' | head -3)"
[ -z "$debs" ] && ok "no .deb installed" || bad "a .deb was installed: $debs"
r="$(runkey)"; [ -n "$r" ] && ok "Run entry: $(echo "$r" | sed 's/.*REG_SZ *//')" || bad "no Run entry"
# Setup's log lists each [Run] entry's parameters (the Start with Windows one proves it can be read here)
grep -a -q -F -- "--autostart-enable" "$C/setup1.log" && ok "Setup's log lists the launcher's parameters" || bad "no --autostart-enable in Setup's log"
grep -a -q -i -F -- "--set-client-id" "$C/setup1.log" && bad "Setup ran --set-client-id" || ok "Setup handed no Client ID to the launcher"
grep -a -i -E "error|exception" "$C/setup1.log" | grep -v -i "netsh" | head -5

echo "== upgrade while Encore Bridge runs"
D="$C/enc-data"
rm -rf "$D"
wine "$APP/Encore Bridge.exe" --data-dir 'C:\enc-data' >/dev/null 2>&1 &
sleep 8
wine "$SETUP" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS=autostart '/LOG=C:\setup2.log' >/dev/null 2>&1
echo "setup exit $?"
grep -a -q "quit requested" "$D/logs/bridge.log" && ok "Setup made the running launcher quit" || bad "the launcher wasn't asked to quit"
grep -a -q "launcher stopped" "$D/logs/bridge.log" && ok "launcher stopped before files were replaced" || bad "launcher didn't stop"
grep -a -q -i "Installation process succeeded" "$C/setup2.log" && ok "upgrade succeeded" || bad "upgrade didn't succeed (see setup2.log)"

echo "== uninstall"
mkdir -p "$C/users/$(whoami)/AppData/Local/Encore" && echo "PORT=8095" > "$C/users/$(whoami)/AppData/Local/Encore/settings.env"
wine "$APP/unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART '/LOG=C:\uninst.log' >/dev/null 2>&1
sleep 3
[ ! -e "$APP/Encore Bridge.exe" ] && ok "program removed" || bad "program still there"
[ -z "$(runkey)" ] && ok "Run entry removed" || bad "Run entry still there"
[ -f "$C/users/$(whoami)/AppData/Local/Encore/settings.env" ] && ok "silent uninstall kept the user's data" || bad "user data deleted"
if [ -f /win/installer/EncoreBridge.iss ]; then
  echo "== installer script: nothing about Spotify (the setup guide asks for it)"
  hits="$(grep -n -i -E 'ClientId|client id|set-client-id|developer\.spotify\.com|spotify' /win/installer/EncoreBridge.iss || true)"
  [ -z "$hits" ] && ok "EncoreBridge.iss has no Client ID page, handoff or Spotify text" || bad "EncoreBridge.iss still has: $hits"
fi

wineserver -k 2>/dev/null
echo
if [ "$FAIL" = 0 ]; then echo "installer smoke test: all passed"; else echo "installer smoke test: FAILED"; fi
exit "$FAIL"
