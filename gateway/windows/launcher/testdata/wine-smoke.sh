#!/bin/sh
# Smoke test of "Encore Bridge.exe" under Wine, with fake-gateway.js in place of the gateway: first run, the child
# environment, log redaction, status polling with the token, stdin quit, the shutdown-route fallback, ending the job
# (children included), the job ending everything when the launcher itself is killed, exit code 10, the crash-loop
# stop, a second start, and opening the admin page while the setup guide isn't complete. It runs in the packaging
# image, which has Wine 10 (Go 1.24+ programs need Wine 9+):
#   docker run --rm -v "<out>/staging/Encore Bridge:/stage:ro" -v "<this folder>:/td:ro" encore-winbuild-package:1 \
#     sh /td/wine-smoke.sh
# It does not replace the Windows smoke test (R6, T4/T5): Wine has no Windows Firewall, power management, SmartScreen
# or real notification area, and the real gateway isn't involved.
set -u
APP=/tmp/app
D=/opt/wine/drive_c/enc-test
L="$D/logs/bridge.log"
FAIL=0
rm -rf "$APP"
cp -r /stage "$APP"
cp /td/fake-gateway.js "$APP/gateway/src/main.js"
Xvfb :99 >/dev/null 2>&1 &
export DISPLAY=:99
sleep 1
wineboot --init >/dev/null 2>&1

ok()   { echo "ok    $*"; }
bad()  { echo "FAIL  $*"; FAIL=1; }
has()  { if grep -a -q -F -- "$2" "$L" 2>/dev/null; then ok "$1"; else bad "$1 (no \"$2\" in the log)"; fi; }
hasnt() { if grep -a -q -F -- "$2" "$L" 2>/dev/null; then bad "$1 (\"$2\" in the log)"; else ok "$1"; fi; }
count() { grep -a -c -F -- "$1" "$L" 2>/dev/null || true; }
nodes() { ps -eo args | grep -i "node.exe" | grep -v grep | wc -l; }
start() { rm -rf "$D"; env "$@" wine "$APP/Encore Bridge.exe" --data-dir 'C:\enc-test' >/dev/null 2>&1 & }
# like start, but with a settings.env already there (as an earlier install leaves it)
start_existing() { rm -rf "$D"; mkdir -p "$D"; printf 'PORT=8095\r\n' > "$D/settings.env"; env "$@" wine "$APP/Encore Bridge.exe" --data-dir 'C:\enc-test' >/dev/null 2>&1 & }
quit()  { timeout 60 wine "$APP/Encore Bridge.exe" --quit >/dev/null 2>&1; sleep 2; }

echo "== normal run"
start NODE_OPTIONS=--max-old-space-size=64
sleep 10
has "settings.env created on first run" "created settings.env from the template"
has "child environment complete, NODE_OPTIONS removed" "ENCORE_HOME=set ENCORE_APP_DIR=set ENCORE_LAUNCHER=set ENCORE_LAUNCHER_TOKEN=set FFMPEG=set ENGINE_EXE=set ENGINE_CONFIG_TEMPLATE=set NODE_ENV=set NODE_OPTIONS=removed"
has "profile path redacted" '%USERPROFILE%\AppData\Local\Encore'
has "status polled with the token" "status polled 1 time"
hasnt "no refused loopback requests" "refused a loopback route request"
echo "== second start"
timeout 20 wine "$APP/Encore Bridge.exe" --data-dir 'C:\enc-test' --autostart >/dev/null 2>&1
[ $? -eq 0 ] && ok "second start returned at once" || bad "second start didn't return"
[ "$(count 'launcher 1')" -le 1 ] && ok "one launcher" || bad "two launchers started"
quit
has "stdin quit line" "stopping: quit line"
has "clean exit" "bridge exited with code 0"
has "launcher stopped" "launcher stopped"
[ "$(nodes)" -eq 0 ] && ok "no node.exe left" || bad "node.exe still running"

echo "== exit code 10 (port in use)"
start FAKE_EXIT=10
sleep 8
has "waits for Restart bridge" "exit code 10; waiting for Restart bridge"
[ "$(count 'bridge started')" -eq 1 ] && ok "no restart loop" || bad "restarted after exit code 10"
quit
has "launcher stopped" "launcher stopped"

echo "== quit line ignored: shutdown route"
start FAKE_IGNORE_QUIT=1
sleep 6
quit
has "quit line ignored" "ignoring the quit line"
has "shutdown route used" "stopping: shutdown route"
has "launcher stopped" "launcher stopped"

echo "== quit and shutdown ignored, with a child process: job ended"
start FAKE_STUBBORN=1 FAKE_CHILD=1
sleep 6
[ "$(nodes)" -ge 2 ] && ok "gateway and its child run" || bad "expected two node.exe processes, saw $(nodes)"
quit
has "job ended" "didn't stop in time; ending it"
has "launcher stopped" "launcher stopped"
[ "$(nodes)" -eq 0 ] && ok "no node.exe left (child included)" || bad "node.exe still running"

echo "== the launcher is killed: the job ends the gateway and its child"
start FAKE_CHILD=1
sleep 6
pkill -9 -f "Encore Bridge.exe" 2>/dev/null
sleep 4
[ "$(nodes)" -eq 0 ] && ok "no node.exe left after the launcher died" || bad "node.exe outlived the launcher"

echo "== setup guide: the admin page opens once per start while setup isn't complete"
start_existing FAKE_SIGNED_IN=1 FAKE_SETUP=incomplete
sleep 8
has "status polled" "status polled 1 time"
hasnt "settings.env not recreated" "created settings.env from the template"
has "setup incomplete: admin page opened" "first run: opening the admin page"
[ "$(count 'first run: opening the admin page')" -eq 1 ] && ok "opened once" || bad "opened more than once"
quit
start_existing FAKE_SIGNED_IN=1 FAKE_SETUP=complete
sleep 8
has "status polled" "status polled 1 time"
hasnt "setup complete: admin page not opened" "first run: opening the admin page"
quit
start_existing FAKE_SIGNED_IN=1 FAKE_SETUP=absent
sleep 8
has "status polled" "status polled 1 time"
hasnt "an older bridge without the setup field: admin page not opened" "first run: opening the admin page"
quit
rm -rf "$D"; mkdir -p "$D"; printf 'PORT=8095\r\n' > "$D/settings.env"
env FAKE_SIGNED_IN=1 FAKE_SETUP=incomplete wine "$APP/Encore Bridge.exe" --data-dir 'C:\enc-test' --autostart >/dev/null 2>&1 &
sleep 8
has "status polled" "status polled 1 time"
hasnt "--autostart: admin page not opened" "first run: opening the admin page"
quit

echo "== crash loop"
start FAKE_EXIT=3
sleep 26
has "gives up after quick failures" "keeps stopping right after it starts"
quit

wineserver -k 2>/dev/null
echo
if [ "$FAIL" = 0 ]; then echo "wine smoke test: all passed"; else echo "wine smoke test: FAILED"; fi
exit "$FAIL"
