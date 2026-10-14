#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Smoke test of Encore's two prebuilt images (DESIGN-DOCKER-IMAGES.md 4.5), before anything is pushed:
#
#   sh smoke-images.sh "<docker command>" <tag> <version> <compose.yaml> <compose.smoke.yaml> <default config.yml>
#
# The images must exist locally as ghcr.io/mbucc9000/encore-bridge:<tag> and ghcr.io/mbucc9000/encore-engine:<tag>.
# <docker command> is used unquoted on purpose ("docker", or "sudo -n docker"). Used by .github/workflows/
# docker-images.yml (each platform) and tools/release/docker_smoke.py (a Linux machine with Docker).
# Everything runs cut off from the host's network (compose.smoke.yaml: other container names, no host networking),
# so it can run next to a real Encore Bridge. It prints fixed texts, versions and status codes only: never the setup
# code or anything from the bridge's log. Its scratch folder ($SMOKE_DIR or the current folder) is removed on exit.
# SMOKE_LABELS=1: also check the images' version and source labels (set by build-images.sh).
# shellcheck disable=SC2086,SC2016  # $D unquoted on purpose; the single-quoted scripts run inside the containers
set -eu

BRIDGE_IMAGE=ghcr.io/mbucc9000/encore-bridge
ENGINE_IMAGE=ghcr.io/mbucc9000/encore-engine
SOURCE=https://github.com/mbucc9000/encore

if [ "$#" -ne 6 ]; then
  echo 'usage: sh smoke-images.sh "<docker command>" <tag> <version> <compose.yaml> <compose.smoke.yaml> <default config.yml>' >&2
  exit 2
fi
D=$1; TAG=$2; VER=$3; COMPOSE=$4; SMOKE=$5; DEFAULT=$6
BR="$BRIDGE_IMAGE:$TAG"
EN="$ENGINE_IMAGE:$TAG"
for f in "$COMPOSE" "$SMOKE" "$DEFAULT"; do
  [ -f "$f" ] || { echo "smoke: FAIL $f is missing"; exit 1; }
done

W=$(mktemp -d "${SMOKE_DIR:-$PWD}/encore-smoke.XXXXXX")
P=encore-smoke-$(basename "$W" | sed 's/^encore-smoke\.//' | tr '[:upper:]' '[:lower:]')
STACK="$W/stack"

cleanup() {
  rc=$?
  set +e
  if [ -f "$STACK/compose.smoke.yaml" ]; then
    (cd "$STACK" && $D compose -p "$P" -f compose.yaml -f compose.smoke.yaml down --remove-orphans) >/dev/null 2>&1
  fi
  # the containers wrote root-owned files: remove them through the engine image, then the folder itself
  $D run --rm --network none -v "$W:/w" --entrypoint /bin/sh "$EN" -c 'rm -rf /w/* /w/.[!.]*' >/dev/null 2>&1
  rm -rf "$W" 2>/dev/null || rmdir "$W" 2>/dev/null
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ok() { echo "smoke: ok $*"; }
fail() { echo "smoke: FAIL $*"; states; exit 1; }
# on a failure: how the two compose containers are doing (never their logs: the gateway's holds the setup code)
states() {
  for c in encore-smoke-gateway encore-smoke-engine; do
    s=$($D inspect --format '{{.State.Status}} (exit code {{.State.ExitCode}})' "$c" 2>/dev/null) || continue
    echo "smoke: $c: $s"
  done
  if resolver_down; then echo "$RESOLVER_MSG"; fi
}
# the engine looks up Spotify's servers (apresolve.spotify.com) at its start and stops when that fails: true when the
# compose engine stopped for that reason (only a count of one fixed engine log line is read, never the log itself)
RESOLVER_MSG="smoke: engine: Spotify's resolver wasn't reachable from this machine"
resolver_down() {
  [ "$($D inspect --format '{{.State.Status}}' encore-smoke-engine 2>/dev/null)" = exited ] || return 1
  [ "$($D logs encore-smoke-engine 2>&1 | grep -c 'failed getting endpoints from resolver')" -ge 1 ]
}
quiet() { "$@" >/dev/null 2>&1; }
# run a throw-away container with no network
nonet() { $D run --rm --network none "$@"; }

# ---- 1. static checks ----
quiet $D image inspect "$BR" || fail "no local image $BR"
quiet $D image inspect "$EN" || fail "no local image $EN"

quiet nonet --entrypoint /bin/sh "$BR" -c 'for f in /app/src/*.js; do node --check "$f" || exit 1; done' \
  || fail "bridge: a file in /app/src doesn't parse"
ok "bridge: every /app/src/*.js parses"
v=$(nonet --entrypoint node "$BR" -e 'process.stdout.write("\nVERSION=" + require("/app/src/config.js").version + "\n")' 2>/dev/null \
  | sed -n 's/^VERSION=//p') || true
[ "$v" = "$VER" ] || fail "bridge: config.js says version '$v', expected $VER"
ok "bridge: version $v"
$D image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$BR" | grep -qx 'ENCORE_PREBUILT=1' \
  || fail "bridge: ENCORE_PREBUILT=1 isn't set in the image"
ok "bridge: ENCORE_PREBUILT=1"
quiet nonet --entrypoint /bin/sh "$BR" -c 'test ! -e /app/repo && test -z "$(find /app -name "*.deb" | head -n 1)" && test "$(ls -A /app)" = src' \
  || fail "bridge: /app holds more than src/ (a Cydia source, a .deb or other files)"
ok "bridge: /app holds src/ only, no Cydia source, no .deb"
n=$(nonet --entrypoint /bin/sh "$BR" -c 'test -s /usr/share/encore/packages.txt && wc -l < /usr/share/encore/packages.txt' 2>/dev/null) \
  || fail "bridge: /usr/share/encore/packages.txt is missing or empty"
ok "bridge: packages.txt lists $(echo "$n" | tr -d ' ') packages"

line=$(nonet --entrypoint /usr/bin/go-librespot "$EN" --version 2>&1) || fail "engine: --version failed"
ver_re=$(printf '%s' "$VER" | sed 's/[][\.*^$+?(){}|/]/\\&/g')
printf '%s\n' "$line" | grep -Eqx "encore-engine $ver_re \(go-librespot .+, Encore patches 1-[0-9]+\)" \
  || fail "engine: --version says '$line'"
ok "engine: $line"
nonet --entrypoint cat "$EN" /usr/share/encore/config.yml > "$W/default-in-image.yml" 2>/dev/null \
  || fail "engine: /usr/share/encore/config.yml is missing"
cmp -s "$W/default-in-image.yml" "$DEFAULT" || fail "engine: the image's default config.yml differs from $DEFAULT"
ok "engine: default config.yml identical to $DEFAULT"
n=$(nonet --entrypoint /bin/sh "$EN" -c 'test -s /usr/share/encore/packages.txt && wc -l < /usr/share/encore/packages.txt' 2>/dev/null) \
  || fail "engine: /usr/share/encore/packages.txt is missing or empty"
ok "engine: packages.txt lists $(echo "$n" | tr -d ' ') packages"

if [ "${SMOKE_LABELS:-}" = 1 ]; then
  for img in "$BR" "$EN"; do
    lver=$($D image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$img")
    lsrc=$($D image inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}' "$img")
    [ "$lver" = "$VER" ] && [ "$lsrc" = "$SOURCE" ] || fail "$img: labels version '$lver', source '$lsrc'"
  done
  ok "labels: version $VER, source $SOURCE (both images)"
fi

# ---- 2. the engine's entrypoint ----
mkdir "$W/e1" "$W/e2" "$W/e3"
quiet nonet -v "$W/e1:/config" "$EN" true || fail "entrypoint: the first start failed"
cmp -s "$W/e1/config.yml" "$DEFAULT" || fail "entrypoint: the first start didn't write the default config.yml"
ok "entrypoint: first start wrote the default config.yml"
quiet nonet -v "$W/e1:/config" --entrypoint /bin/sh "$EN" -c 'echo "# smoke: a change of mine" >> /config/config.yml' \
  || fail "entrypoint: couldn't change config.yml"
{ cat "$DEFAULT"; echo "# smoke: a change of mine"; } > "$W/changed.yml"
quiet nonet -v "$W/e1:/config" "$EN" true || fail "entrypoint: the second start failed"
cmp -s "$W/e1/config.yml" "$W/changed.yml" || fail "entrypoint: a second start changed an existing config.yml"
ok "entrypoint: an existing config.yml is kept as it is"
echo "log_level: info" > "$W/e2/config.yaml"
quiet nonet -v "$W/e2:/config" "$EN" true || fail "entrypoint: the start with config.yaml failed"
[ ! -e "$W/e2/config.yml" ] && [ "$(cat "$W/e2/config.yaml")" = "log_level: info" ] \
  || fail "entrypoint: wrote config.yml next to an existing config.yaml"
ok "entrypoint: config.yaml present: no config.yml written"
ln -s elsewhere.yml "$W/e3/config.yml"
quiet nonet -v "$W/e3:/config" "$EN" true || fail "entrypoint: the start with a config.yml link failed"
[ -L "$W/e3/config.yml" ] && [ ! -e "$W/e3/elsewhere.yml" ] || fail "entrypoint: replaced a config.yml link"
ok "entrypoint: a config.yml link is left alone"

out=$(nonet -e ZEROCONF_BACKEND=avahi "$EN" /usr/bin/go-librespot --version 2>&1) \
  || fail "entrypoint: ZEROCONF_BACKEND=avahi with --version failed"
printf '%s\n' "$out" | grep -q 'zeroconf_backend avahi' || fail "entrypoint: ZEROCONF_BACKEND=avahi wasn't taken"
if quiet nonet -e ZEROCONF_BACKEND=bogus "$EN" /usr/bin/go-librespot --version; then
  fail "entrypoint: ZEROCONF_BACKEND=bogus was accepted"
fi
# the arguments the engine gets: the image's entrypoint and command, run with a stand-in for /usr/bin/go-librespot
# that prints them (written inside the container: the scratch folder may be on a noexec mount)
ec=$($D image inspect --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}' "$EN")
[ "$ec" = '["/bin/sh","/usr/share/encore/entrypoint.sh"] ["/usr/bin/go-librespot","--config_dir","/config"]' ] \
  || fail "engine: entrypoint and command are $ec"
argsof() {
  nonet "$@" --entrypoint /bin/sh "$EN" -c 'printf "%s\n" "#!/bin/sh" "echo \"args: \$*\"" > /usr/bin/go-librespot &&
    exec /bin/sh /usr/share/encore/entrypoint.sh /usr/bin/go-librespot --config_dir /config' 2>/dev/null | grep '^args:' || true
}
a0=$(argsof)
a1=$(argsof -e ZEROCONF_BACKEND=avahi)
[ "$a0" = "args: --config_dir /config" ] || fail "entrypoint: the engine got '$a0' without ZEROCONF_BACKEND"
[ "$a1" = "args: --config_dir /config -c zeroconf_backend=avahi" ] \
  || fail "entrypoint: the engine got '$a1' with ZEROCONF_BACKEND=avahi"
ok "entrypoint: ZEROCONF_BACKEND=avahi adds -c zeroconf_backend=avahi, bogus is refused, unset adds nothing"

# ---- 3. the shipped compose file, isolated ----
mkdir "$STACK"
cp "$COMPOSE" "$STACK/compose.yaml"
cp "$SMOKE" "$STACK/compose.smoke.yaml"
printf 'ENCORE_TAG=%s\n' "$TAG" > "$STACK/.env"
dc() { (cd "$STACK" && $D compose -p "$P" -f compose.yaml -f compose.smoke.yaml "$@"); }

imgs=$(dc config --images 2>/dev/null | sort | tr '\n' ' ')
[ "$imgs" = "$BR $EN " ] || fail "compose: config --images lists '$imgs'"
ok "compose: the file asks for $BR and $EN"
dc up -d --pull never > "$W/up.txt" 2>&1 || { tail -n 20 "$W/up.txt"; fail "compose: up failed"; }

# from inside the gateway container: the status code (and, with 1, the first 40 characters of the body)
probe() {
  $D exec encore-smoke-gateway node -e '
const [url, body] = process.argv.slice(1);
fetch(url, { signal: AbortSignal.timeout(3000) })
  .then(async (r) => { const t = await r.text(); process.stdout.write(r.status + (body === "1" ? " " + t.slice(0, 40).replace(/\s+/g, " ") : "")); })
  .catch(() => process.stdout.write("000"));' "$1" "${2:-0}" 2>/dev/null || echo 000
}
root=000; admin=000; engine=000
# wait_up: up to 60 s for the three answers
wait_up() {
  end=$(($(date +%s) + 60))
  while :; do
    root=$(probe http://127.0.0.1:8095/ 1)
    admin=$(probe http://127.0.0.1:8095/admin)
    engine=$(probe http://127.0.0.1:3678/status)
    case "$root" in "200 Encore gateway"*) [ "$admin" = 200 ] && [ "$engine" != 000 ] && return 0 ;; esac
    [ "$(date +%s)" -lt "$end" ] || return 0
    if [ "$engine" = 000 ] && resolver_down; then return 0; fi
    sleep 2
  done
}
wait_up
if [ "$engine" = 000 ] && resolver_down; then
  echo "$RESOLVER_MSG: trying once more in 30 s"
  sleep 30
  dc up -d --pull never > "$W/up.txt" 2>&1 || { tail -n 20 "$W/up.txt"; fail "compose: up failed"; }
  wait_up
fi
case "$root" in "200 Encore gateway"*) ok "compose: GET / -> $root" ;; *) fail "compose: GET / -> '$root'" ;; esac
[ "$admin" = 200 ] || fail "compose: GET /admin -> $admin"
ok "compose: GET /admin -> 200 (first start, empty data folder)"
[ "$engine" != 000 ] || fail "compose: the engine doesn't answer on 127.0.0.1:3678"
ok "compose: engine GET /status -> $engine"

[ -p "$STACK/pipe/encore.pcm" ] || fail "compose: pipe/encore.pcm isn't a FIFO"
ok "compose: pipe/encore.pcm is a FIFO"
cmp -s "$STACK/engine/config.yml" "$DEFAULT" || fail "compose: engine/config.yml isn't the default one"
ok "compose: engine/config.yml written at the first start"
n=$(dc logs gateway 2>/dev/null | grep -c 'setup code' || true)
[ "${n:-0}" -ge 1 ] || fail "compose: the gateway's log has no setup code line"
ok "compose: the gateway's log has $n setup code line(s)"

quiet dc restart engine || fail "compose: restart engine failed"
sleep 10
cmp -s "$STACK/engine/config.yml" "$DEFAULT" || fail "compose: a restart changed engine/config.yml"
for c in encore-smoke-gateway encore-smoke-engine; do
  s=$($D inspect --format '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
  [ "$s" = running ] || fail "compose: $c is $s"
done
ok "compose: engine restarted, config.yml unchanged, both containers running"

echo "smoke: OK"
