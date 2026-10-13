#!/bin/sh
# Smoke test of the Windows update path under Wine (DESIGN-UPDATES.md §14.3): installer A (whose launcher is the
# update TEST build, encoreupdatetest, version 1.1.0) is installed with Start with Windows, which is then switched off;
# markers go into the data root; installer B (a normal launcher, a newer version) is published on fakegh with
# SHA256SUMS.txt signed by the RFC 8032 TEST 1 key; the test launcher runs "--update-test install" (every dialog
# answered Yes). Expected: B downloaded and verified, started with the update parameters, the launcher asked to quit,
# the files replaced, settings.env and the data untouched, no Run entry added back, and B's launcher started with
# --updated. Then the negative runs: a bad signature (with an admin-page check request, acted on and acknowledged)
# and a changed installer never start Setup (and the changed installer is deleted); (best effort) a Setup that fails
# after the quit starts the launcher again with --update-failed; and the launcher's side of --update-failed and of a
# pending update that never came back.
#
# Both installers carry fake-gateway.js as gateway\src\main.js, so no Spotify, engine or FFmpeg is involved. Runs in the
# packaging image without a network (nothing can reach the real GitHub; fakegh listens on loopback):
#   docker run --rm --network none -v "<dir with installer A>:/a:ro" -v "<dir with installer B>:/b:ro" \
#     -v "<test launcher build>/test-tools:/tools:ro" -v "<this folder>:/td:ro" [-v "<results dir>:/res"] \
#     encore-winbuild-package:1 sh /td/update-smoke.sh
# With /res mounted, each run's bridge.log, fakegh requests, Setup log and update.json are kept there.
# It does not replace the owner's Windows test (§14.4): Wine has no UAC, no SmartScreen and no Defender.
set -u
A="$(ls /a/EncoreBridge-*-setup.exe | head -n 1)"
B="$(ls /b/EncoreBridge-*-setup.exe | head -n 1)"
BVER="$(basename "$B" | sed -E 's/^EncoreBridge-([0-9]+\.[0-9]+\.[0-9]+).*$/\1/')"
C=/opt/wine/drive_c
APP="$C/Program Files/Encore Bridge"
EXE='C:\Program Files\Encore Bridge\Encore Bridge.exe'
PORT=18765
TEST_KEY='11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo='   # RFC 8032 §7.1 TEST 1: public test data
TEST_KEY_ID=21fe31dfa154a261
FAIL=0
ok()   { echo "ok    $*"; }
bad()  { echo "FAIL  $*"; FAIL=1; }
note() { echo "note  $*"; }

Xvfb :99 >/dev/null 2>&1 &
export DISPLAY=:99
sleep 1
wineboot --init >/dev/null 2>&1
LA="$(wine cmd /c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r' | tail -n 1)"
D="$(winepath -u "$LA" 2>/dev/null | tr -d '\r' | sed 's#/*$##')/Encore"
L="$D/logs/bridge.log"
echo "installer A: $(basename "$A")   installer B: $(basename "$B") ($BVER)   data root: $D"

has()   { if grep -a -q -F -- "$2" "$L" 2>/dev/null; then ok "$1"; else bad "$1 (no \"$2\" in the log)"; fi; }
hasnt() { if grep -a -q -F -- "$2" "$L" 2>/dev/null; then bad "$1 (\"$2\" in the log)"; else ok "$1"; fi; }
waitfor() { # <text> <seconds>
  i=0
  while [ "$i" -lt "$2" ]; do
    grep -a -q -F -- "$1" "$L" 2>/dev/null && return 0
    sleep 1; i=$((i + 1))
  done
  return 1
}
runkey() { wine reg query 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run' /v 'Encore Bridge' 2>/dev/null | tr -d '\r' | grep -i 'Encore Bridge.exe'; }
install_a() {
  wine "$A" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS=autostart '/LOG=C:\updA.log' >/dev/null 2>&1
  echo "setup A exit $?"
}
release_dir() {
  rm -rf /tmp/rel && mkdir -p /tmp/rel
  cp "$B" "/tmp/rel/EncoreBridge-$BVER-setup.exe"
  printf 'zip %s\n' "$BVER" > "/tmp/rel/EncoreBridge-$BVER-win64.zip"
  printf 'source %s\n' "$BVER" > "/tmp/rel/Encore-$BVER-source.tar.gz"
}
FAKEPID=""
# the mounted folder may be noexec: run a copy
cp /tools/fakegh /tmp/fakegh && chmod 755 /tmp/fakegh
start_fake() { # <sign> [<tamper>]
  : > /tmp/fakegh.log
  /tmp/fakegh -dir /tmp/rel -ver "$BVER" -addr "127.0.0.1:$PORT" -sign "$1" ${2:+-tamper "$2"} -log /tmp/fakegh.log 2>>/tmp/fakegh.err &
  FAKEPID=$!
  sleep 1
}
stop_fake() { [ -n "$FAKEPID" ] && kill "$FAKEPID" 2>/dev/null; wait "$FAKEPID" 2>/dev/null; FAKEPID=""; }
run_test_launcher() { # [VAR=value …] extra environment
  env ENCORE_UPDATE_API="http://127.0.0.1:$PORT" ENCORE_UPDATE_DOWNLOAD="http://127.0.0.1:$PORT" ENCORE_UPDATE_TEST_KEY="$TEST_KEY" \
    FAKE_SIGNED_IN=1 "$@" wine "$EXE" --update-test install >/dev/null 2>&1 &
}
quit_launcher() { timeout 60 wine "$EXE" --quit >/dev/null 2>&1; sleep 2; }
fresh_state() { rm -f "$D/update.json"; rm -rf "$D/updates"; mkdir -p "$D/logs"; : > "$L"; }
setup_running() { ps -eo args | grep -i -E "setup\.tmp|EncoreBridge-[0-9.]+-setup\.exe" | grep -v grep >/dev/null; }
wait_setup_gone() { i=0; while [ "$i" -lt "$1" ] && setup_running; do sleep 1; i=$((i + 1)); done; }
# keep the logs of each run when /res is mounted (-v <dir>:/res)
keep() { [ -d /res ] || return 0; cp "$L" "/res/$1-bridge.log" 2>/dev/null; cp /tmp/fakegh.log "/res/$1-fakegh.log" 2>/dev/null
  cp /tmp/setup-copy.log "/res/$1-setup.log" 2>/dev/null; cp "$D/update.json" "/res/$1-update.json" 2>/dev/null; true; }

echo "== install A with Start with Windows, then switch it off in the tray's way"
install_a
[ -n "$(runkey)" ] && ok "A installed with a Run entry" || bad "A has no Run entry"
wine "$EXE" --autostart-disable >/dev/null 2>&1
[ -z "$(runkey)" ] && ok "Start with Windows switched off" || bad "the Run entry is still there"
mkdir -p "$D/data" "$D/logs"
printf 'PORT=8095\r\n# marker-settings-7f3a\r\n' > "$D/settings.env"
echo "marker-data-7f3a" > "$D/data/marker-7f3a.txt"
fresh_state

echo "== update: A finds $BVER, verifies it, starts Setup; Setup replaces A and starts B with --updated"
release_dir
start_fake test1
( while :; do for f in "$D"/updates/*/setup.log; do [ -f "$f" ] && cp "$f" /tmp/setup-copy.log 2>/dev/null; done; sleep 0.3; done ) &
COPIER=$!
run_test_launcher
if waitfor "updated from 1.1.0 to $BVER" 420; then ok "B's launcher says the update is done"; else bad "no \"updated from 1.1.0 to $BVER\" within 420 s"; fi
wait_setup_gone 120
sleep 2
kill "$COPIER" 2>/dev/null
keep update
has "a newer release found and verified with the test key" "update check: $BVER available (signature ok, key $TEST_KEY_ID)"
has "Update now went on after \"Update now?\"" "[test] dialog: Encore Bridge $BVER is available (you have 1.1.0)."
has "the installer was downloaded" "update: downloading $BVER"
has "the installer's signature was checked" "update: verified EncoreBridge-$BVER-setup.exe (signature ok)"
has "Setup was started" "update: starting Setup for $BVER"
has "Setup asked the launcher to quit" "quit requested (update to $BVER)"
has "the launcher stopped before the files were replaced" "launcher stopped"
has "the new launcher started" "Encore Bridge launcher $BVER starting"
has "Setup started it with --updated" "started by Setup after an update (--updated)"
# (pushes are at most one a second, so a quick update may skip the "available" view: any pushed view proves the relay)
has "the admin relay got the launcher's update view" "update view pushed: state="
hasnt "no update error dialog" "[test] dialog: The "
hasnt "no check error" "update check failed"
# Setup's log, as copied while it was written (the --updated launcher deletes the finished update's folder, so its
# last lines may be missing here; the launcher's own lines above prove the end)
SLOG=/tmp/setup-copy.log
[ -f "$D/updates/$BVER/setup.log" ] && SLOG="$D/updates/$BVER/setup.log"
if [ -f "$SLOG" ]; then
  grep -a -q -F "/ENCOREUPDATE=1" "$SLOG" && ok "Setup's log lists /ENCOREUPDATE=1" || bad "Setup's log lacks /ENCOREUPDATE=1"
  grep -a -q -F "/SILENT" "$SLOG" && grep -a -q -F "/SP-" "$SLOG" && grep -a -q -F "/SUPPRESSMSGBOXES" "$SLOG" && grep -a -q -F "/NORESTART" "$SLOG" \
    && grep -a -q -F "/NOCANCEL" "$SLOG" && ok "Setup got /SILENT /SUPPRESSMSGBOXES /NORESTART /SP- /NOCANCEL" || bad "Setup's parameters are incomplete"
  grep -a -q -F -- "--autostart-enable" "$SLOG" && bad "Setup ran --autostart-enable in update mode" || ok "no --autostart-enable in Setup's log"
else
  bad "no setup.log was written"
fi
[ ! -d "$D/updates/$BVER" ] || [ -z "$(find "$D/updates/$BVER" -iname '*.part')" ] && ok "no partial download left" || bad "a .part was left"
grep -a -q -F "$BVER" "$APP/VERSIONS.txt" && ok "the program files are $BVER now" || bad "VERSIONS.txt isn't $BVER"
grep -a -q -F "marker-settings-7f3a" "$D/settings.env" && ok "settings.env untouched" || bad "settings.env changed"
[ -f "$D/data/marker-7f3a.txt" ] && ok "the data folder untouched" || bad "the data folder lost a file"
[ -z "$(runkey)" ] && ok "no Run entry added back (the user's choice kept)" || bad "Setup added the Run entry back"
grep -a -q '"pending": null' "$D/update.json" && ok "the pending update was cleared" || bad "update.json still has a pending update"
# what fakegh saw: the launcher's own requests carry no query string and exactly the allowed headers
# (the API and download paths, not the /dl/ redirects; no owner name here: the release scan denies it)
own="$(grep -E '^GET /(repos/)?[^/ ]+/encore/releases/' /tmp/fakegh.log)"
[ -n "$own" ] && ok "fakegh saw $(echo "$own" | wc -l) requests from the launcher" || bad "fakegh saw no requests"
echo "$own" | grep -v -q 'query=0' && bad "a request had a query string" || ok "no query strings"
echo "$own" | grep -v -q 'ua=EncoreBridge/1.1.0 ' && bad "a request had another User-Agent" || ok "User-Agent EncoreBridge/1.1.0 only"
extra="$(echo "$own" | sed 's/.* headers=//' | tr ',' '\n' | grep -v -x -E 'accept|accept-encoding|user-agent|x-github-api-version|range|if-none-match' | sort -u)"
[ -z "$extra" ] && ok "only the allowed headers" || bad "other headers sent: $extra"
grep -a -E "update|Setup|quit" "$L" | grep -v "^\s*$" | head -40
quit_launcher
stop_fake

echo "== bad signature: nothing is offered, Setup never starts"
install_a
fresh_state
release_dir
start_fake test2
run_test_launcher FAKE_UPDATE_REQUEST=check   # and the admin page asks for a check too
waitfor "not offered: bad_signature" 90 || true
waitfor "update request handled: check" 30 || true
sleep 3
keep badsig
has "the release isn't offered" "update check: $BVER not offered: bad_signature (keys tried: "
has "the test key was among the keys tried" "$TEST_KEY_ID)"
has "the admin page's request was acted on and acknowledged" "update request handled: check"
has "the admin relay shows the error" "update view pushed: state=error kind=windows-installer latest=none"
has "the user is told" "[test] dialog: Encore Bridge $BVER is published, but it isn't signed"
hasnt "Setup never started" "update: starting Setup"
hasnt "nothing was downloaded" "update: downloading"
[ ! -e "$D/updates/$BVER/setup.log" ] && ok "no setup.log" || bad "Setup ran"
quit_launcher
stop_fake

echo "== the installer changed after signing: deleted, never run"
fresh_state
start_fake test1 "EncoreBridge-$BVER-setup.exe"
run_test_launcher
waitfor "doesn't match Encore's signature" 180 || true
sleep 3
keep tampered
has "the mismatch was found" "E [launcher] update: EncoreBridge-$BVER-setup.exe doesn't match Encore's signature: deleted, not run"
has "the user is told" "[test] dialog: The downloaded installer doesn't match Encore's signature"
hasnt "Setup never started" "update: starting Setup"
[ -z "$(find "$D/updates" -iname '*.exe*' 2>/dev/null)" ] && ok "the installer is gone" || bad "the changed installer is still there"
[ ! -e "$D/updates/$BVER/setup.log" ] && ok "no setup.log" || bad "Setup ran"
quit_launcher
stop_fake

echo "== best effort: Setup fails after the launcher quit, and starts it again with --update-failed"
fresh_state
rm -f /tmp/setup-copy.log
start_fake test1
chmod a-w "$APP/README-Windows.txt"   # Wine reports it read-only: Setup can't replace it and aborts (/SUPPRESSMSGBOXES)
( while :; do for f in "$D"/updates/*/setup.log; do [ -f "$f" ] && cp "$f" /tmp/setup-copy.log 2>/dev/null; done; sleep 0.3; done ) &
COPIER=$!
run_test_launcher
waitfor "quit requested (update to $BVER)" 180 && ok "Setup asked the launcher to quit" || note "Setup didn't ask the launcher to quit"
i=0
while [ "$i" -lt 120 ] && ! grep -a -q -F -- "--update-failed" /tmp/setup-copy.log 2>/dev/null; do sleep 1; i=$((i + 1)); done
sleep 5
kill "$COPIER" 2>/dev/null
keep failed
if grep -a -q -F "starting Encore Bridge again with --update-failed" /tmp/setup-copy.log 2>/dev/null; then
  ok "Setup's DeinitializeSetup started the launcher again with --update-failed"
  # Setup aborted mid-copy here, after [InstallDelete]: the restarted launcher (often B's, which Setup had already
  # copied: a release build, so its message is a real window, not a "[test] dialog" line) may find its folder
  # incomplete. Then it must log it and forget the pending update (its message names the installer), never stop at a
  # bare "Reinstall" with nothing logged.
  if grep -a -q -F "didn't finish (Setup restarted the launcher)" "$L"; then
    ok "the restarted launcher says the update didn't finish"
  elif grep -a -q -F "the update to $BVER didn't finish and left the program folder incomplete" "$L"; then
    ok "the restarted launcher finds its folder incomplete and says the update didn't finish"
    grep -a -q '"pending": null' "$D/update.json" && ok "the pending update was cleared" || bad "the pending update wasn't cleared"
    grep -a -q "\"failed_update\": \"$BVER\"" "$D/update.json" && ok "the failed update is remembered" || bad "no failed_update"
    [ -f "$D/updates/$BVER/EncoreBridge-$BVER-setup.exe" ] && ok "the checked installer is kept to run again" || bad "the installer is gone"
  else
    bad "the restarted launcher didn't say the update didn't finish (an incomplete folder must point to the installer)"
  fi
  [ -f "$D/updates/$BVER/setup.log" ] && ok "the failed update's setup.log is kept" || note "no setup.log kept for $BVER"
else
  note "no --update-failed start under Wine (best effort; checked on Windows, §14.4)"
  grep -a -E "update|Setup|quit|starting" "$L" | tail -15
  tail -20 /tmp/setup-copy.log 2>/dev/null
fi
chmod u+w "$APP/README-Windows.txt"
quit_launcher
stop_fake

echo "== after Setup: --update-failed, and an update that never came back"
quit_launcher
wineserver -k 2>/dev/null   # the restarted launcher above may still show its "incomplete" message
sleep 1
install_a
quit_launcher
fresh_state
printf '{"v": 1, "pending": {"from": "1.1.0", "to": "%s", "started_at": "%s"}}\n' "$BVER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$D/update.json"
env FAKE_SIGNED_IN=1 wine "$EXE" --update-failed >/dev/null 2>&1 &
waitfor "didn't finish (Setup restarted the launcher)" 60 || true
sleep 2
keep afterfail
has "--update-failed is logged" "started by Setup after an update that didn't finish (--update-failed)"
has "the launcher says the update didn't finish" "W [launcher] the update to $BVER didn't finish (Setup restarted the launcher)"
has "the user is told" "[test] dialog: The update to Encore Bridge $BVER didn't finish, so Encore Bridge 1.1.0 was started again."
grep -a -q '"pending": null' "$D/update.json" && ok "the pending update was cleared" || bad "the pending update wasn't cleared"
grep -a -q "\"failed_update\": \"$BVER\"" "$D/update.json" && ok "the failed update is remembered (its folder keeps Setup's log)" || bad "no failed_update"
quit_launcher
fresh_state
printf '{"v": 1, "pending": {"from": "1.1.0", "to": "%s", "started_at": "2026-01-01T00:00:00Z"}}\n' "$BVER" > "$D/update.json"
env FAKE_SIGNED_IN=1 wine "$EXE" >/dev/null 2>&1 &
waitfor "didn't finish" 60 || true
sleep 2
keep stale
has "a pending update older than 15 minutes is reported" "W [launcher] the update to $BVER didn't finish"
hasnt "not as Setup's restart" "(Setup restarted the launcher)"
has "the user is told" "[test] dialog: The update to Encore Bridge $BVER didn't finish"
quit_launcher

wineserver -k 2>/dev/null
echo
if [ "$FAIL" = 0 ]; then echo "update smoke test: all passed"; else echo "update smoke test: FAILED"; fi
exit "$FAIL"
