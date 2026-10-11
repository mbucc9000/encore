#!/usr/bin/env bash
# Encore Bridge for Windows: assembles the staging folder, then the portable zip and the installer from it (D17).
#
#   bundle.sh --tree <exported tree> --launcher <dir> --engine <dir> --ffmpeg <dir> --out <dir>
#             [--cache <dir>] [--scan <command>] [--denylist <file>] [--no-installer] [--dev]
#
#   --tree      R4's exported release tree (never the working copy: the script refuses a tree that still holds
#               development files). Only the files in allowlist.txt are copied from it. The app package is not part
#               of the bundle (phones install Encore from the Encore repo in Cydia): a gateway/repo/ folder in the
#               tree is ignored, and the payload is checked to hold no gateway\repo\ and no .deb.
#   --launcher  the launcher build output: "Encore Bridge.exe", launcher-version.txt and licenses/launcher/
#               (launcher/build-in-docker.sh)
#   --engine    the Windows engine build output (R3e, build-engine/build.sh): encore-engine.exe stamped with the
#               version (its --version line is "encore-engine <version> (...)"), and licenses/ with the notices of
#               what is linked into it
#   --ffmpeg    Encore's FFmpeg build output (build-ffmpeg/build.sh): ffmpeg.exe, SHA256SUMS (the exe and the source
#               tarball, which must be the one pins.conf names), BUILDINFO.txt and licenses/
#   --out       output folder: staging/Encore Bridge/ (the payload), EncoreBridge-<ver>-win64.zip,
#               EncoreBridge-<ver>-setup.exe, EncoreBridge-<ver>-bundle-report.txt, EncoreBridge-<ver>-iscc.log
#   --cache     where the Node.js download is kept between runs (default <out>/downloads); it is checked against
#               pins.conf before use
#   --scan      R4's release scan, run as: <command> <staging folder>; a non-zero exit stops the bundle. A script
#               without the x bit (or on a noexec mount) is run with sh
#   --denylist  a file of literal strings (one per line, # notes) that must not appear anywhere in the bundle
#               (case-insensitive, ASCII); R4's scan also covers UTF-16 and secret patterns
#   --no-installer  make the zip only
#   --dev       a development bundle: missing allowlisted files, a missing engine or FFmpeg, a missing scan
#               and a version mismatch are warnings instead of errors, and every output is marked DEV (file names and a
#               DEV-BUILD.txt inside). A DEV bundle is never released.
#
# Needs bash, curl, sha256sum, unzip, zip, strings (binutils); for the installer, Wine with Inno Setup ($ISCC_EXE,
# see ../docker/package.Dockerfile). ../build.sh runs all of this inside the build images.
set -euo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="" LAUNCHER="" ENGINE="" FFMPEG="" OUT="" CACHE="" SCAN="" DENYLIST="" DEV=0 INSTALLER=1
while [ $# -gt 0 ]; do
  case "$1" in
    --tree) TREE="$2"; shift 2 ;;
    --launcher) LAUNCHER="$2"; shift 2 ;;
    --engine) ENGINE="$2"; shift 2 ;;
    --ffmpeg) FFMPEG="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --cache) CACHE="$2"; shift 2 ;;
    --scan) SCAN="$2"; shift 2 ;;
    --denylist) DENYLIST="$2"; shift 2 ;;
    --no-installer) INSTALLER=0; shift ;;
    --dev) DEV=1; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) echo "bundle: unknown option $1" >&2; exit 2 ;;
  esac
done

WARNINGS=0
log()  { echo "bundle: $*"; }
die()  { echo "bundle: ERROR: $*" >&2; exit 1; }
warn() { echo "bundle: warning: $*" >&2; WARNINGS=$((WARNINGS + 1)); }
need() { if [ "$DEV" = 1 ]; then warn "$* (allowed in a --dev bundle)"; else die "$*"; fi; }
# has_string <file> <text>: the binary contains the text (grep -c reads everything, so no SIGPIPE under pipefail)
has_string() { strings -a "$1" | grep -c -F -- "$2" >/dev/null; }

for tool in curl sha256sum unzip zip strings find sort sed; do
  command -v "$tool" >/dev/null || die "missing tool: $tool"
done
[ -n "$TREE" ] && [ -n "$LAUNCHER" ] && [ -n "$OUT" ] || die "--tree, --launcher and --out are required (see --help)"
TREE="$(cd "$TREE" && pwd)"
LAUNCHER="$(cd "$LAUNCHER" && pwd)"
[ -n "$ENGINE" ] && ENGINE="$(cd "$ENGINE" && pwd)"
[ -n "$FFMPEG" ] && FFMPEG="$(cd "$FFMPEG" && pwd)"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
CACHE="${CACHE:-$OUT/downloads}"
mkdir -p "$CACHE"

# ---- 0. the tree must be an export, not the working copy
[ -d "$TREE/gateway/src" ] || die "--tree $TREE has no gateway/src"
for marker in RELEASE-PLAN.md PLAN.md mockup probes .workflows tools/pipeline tools/release/denylist.local.txt gateway/.env gateway/data gateway/tools/LIVE_TEST.md; do
  [ -e "$TREE/$marker" ] && die "--tree $TREE looks like the working copy ($marker is there). Bundle only from R4's exported tree."
done
case "$OUT/" in "$TREE/"*) die "--out must be outside the tree" ;; esac

VERSION="$(sed -nE "s/^[[:space:]]*version:[[:space:]]*'([^']+)'.*/\1/p" "$TREE/gateway/src/config.js" | head -n 1)"
[ -n "$VERSION" ] || die "couldn't read version from gateway/src/config.js"
NUMVER="$(printf '%s' "$VERSION" | sed -E 's/^v//; s/[^0-9.].*$//')"
# shellcheck source=pins.conf
. "$HERE/pins.conf"
SUFFIX=""
[ "$DEV" = 1 ] && SUFFIX="-DEV"
NAME="EncoreBridge-$VERSION$SUFFIX"
log "Encore Bridge $VERSION$SUFFIX from $TREE"

STAGING="$OUT/staging"
STAGE="$STAGING/Encore Bridge"
rm -rf "$STAGING"
mkdir -p "$STAGE"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---- 1. allowlisted files from the tree
declare -A LISTED=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%$'\r'}"
  case "$line" in ''|'#'*) continue ;; esac
  read -r src dst _ <<<"$line"
  if [ "${src#!}" != "$src" ]; then
    LISTED["${src#!}"]=excluded
    continue
  fi
  dst="${dst:-$src}"
  LISTED["$src"]=1
  case "$src$dst" in *..*|/*) die "allowlist: bad path in: $line" ;; esac
  if [ ! -f "$TREE/$src" ]; then
    need "allowlisted file missing from the tree: $src"
    continue
  fi
  mkdir -p "$(dirname "$STAGE/$dst")"
  cp "$TREE/$src" "$STAGE/$dst"
done < "$HERE/allowlist.txt"

# every gateway file must be decided on
while IFS= read -r f; do
  rel="${f#"$TREE"/}"
  [ -n "${LISTED[$rel]:-}" ] || die "$rel isn't in bundle/allowlist.txt: list it (shipped) or add !$rel (not shipped)"
done < <(find "$TREE/gateway/src" -type f | sort)

# ---- 2. downloads, checked against pins.conf
fetch() { # url sha256 -> prints the cached path
  local url="$1" sha="$2" file
  file="$CACHE/$(basename "$url")"
  if [ -f "$file" ] && echo "$sha  $file" | sha256sum -c --status -; then
    echo "$file"
    return
  fi
  log "downloading $(basename "$url")" >&2
  curl -fsSL --retry 3 -o "$file.part" "$url" || die "download failed: $url"
  echo "$sha  $file.part" | sha256sum -c --status - || { rm -f "$file.part"; die "SHA-256 mismatch for $url (pins.conf)"; }
  mv "$file.part" "$file"
  echo "$file"
}

# Node.js: node.exe + LICENSE
NODE_ZIP="$(fetch "$NODE_ZIP_URL" "$NODE_ZIP_SHA256")"
unzip -q -o -j "$NODE_ZIP" "node-v$NODE_VERSION-win-x64/node.exe" "node-v$NODE_VERSION-win-x64/LICENSE" -d "$TMP/node"
echo "$NODE_EXE_SHA256  $TMP/node/node.exe" | sha256sum -c --status - || die "node.exe in the zip doesn't match NODE_EXE_SHA256"
mkdir -p "$STAGE/runtime" "$STAGE/licenses/node"
cp "$TMP/node/node.exe" "$STAGE/runtime/node.exe"
cp "$TMP/node/LICENSE" "$STAGE/licenses/node/LICENSE.txt"

# FFmpeg: Encore's minimal LGPL build (build-ffmpeg/build.sh, D21): ffmpeg.exe, its licences, the source notice
FF_LICENSE="LGPL-2.1-or-later"
if [ -n "$FFMPEG" ] && [ -f "$FFMPEG/ffmpeg.exe" ]; then
  [ "$(head -c 2 "$FFMPEG/ffmpeg.exe")" = "MZ" ] || die "$FFMPEG/ffmpeg.exe isn't a Windows program"
  [ -f "$FFMPEG/SHA256SUMS" ] || die "no SHA256SUMS next to ffmpeg.exe (build-ffmpeg/build.sh writes one)"
  (cd "$FFMPEG" && grep -E '^[0-9a-f]{64}  ffmpeg\.exe$' SHA256SUMS | sha256sum -c --status -) \
    || die "ffmpeg.exe doesn't match the SHA256SUMS of its build"
  grep -q -x -F "$FFMPEG_SOURCE_SHA256  sources/ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG/SHA256SUMS" \
    || die "that FFmpeg build isn't from the pinned source (pins.conf: FFMPEG_VERSION, FFMPEG_SOURCE_SHA256)"
  FF_CONF="$(strings -a -n 20 "$FFMPEG/ffmpeg.exe" | grep -m 1 -E -- '--(disable|enable|prefix|target-os)' || true)"
  [ -n "$FF_CONF" ] || die "couldn't find the configure line in ffmpeg.exe"
  case " $FF_CONF " in
    *" --enable-gpl "*|*" --enable-nonfree "*|*" --enable-version3 "*) die "ffmpeg.exe isn't an LGPL-2.1 build (D21)" ;;
  esac
  has_string "$FFMPEG/ffmpeg.exe" "version $FFMPEG_VERSION" || die "ffmpeg.exe isn't FFmpeg $FFMPEG_VERSION"
  for f in LICENSE.txt FFmpeg-LICENSE.md zlib.txt; do
    [ -f "$FFMPEG/licenses/$f" ] || die "no licenses/$f in the FFmpeg build"
  done
  mkdir -p "$STAGE/ffmpeg" "$STAGE/licenses/ffmpeg"
  cp "$FFMPEG/ffmpeg.exe" "$STAGE/ffmpeg/ffmpeg.exe"
  cp -r "$FFMPEG/licenses/." "$STAGE/licenses/ffmpeg/"
  [ -f "$FFMPEG/BUILDINFO.txt" ] && cp "$FFMPEG/BUILDINFO.txt" "$STAGE/licenses/ffmpeg/BUILDINFO.txt"
  cat > "$STAGE/licenses/ffmpeg/SOURCE.txt" <<EOF
ffmpeg\\ffmpeg.exe is FFmpeg $FFMPEG_VERSION, built by the Encore project with only the parts Encore Bridge uses (AAC
encoding and cover-picture conversion). It is licensed under the GNU Lesser General Public License, version 2.1 or
later (LICENSE.txt; FFmpeg-LICENSE.md explains FFmpeg's licensing) and statically linked with zlib (zlib.txt).
Encore Bridge runs it as a separate program; you may replace it with another FFmpeg build of your choice.

Its complete source code is published with every Encore release, next to this download, in
Encore-$VERSION-gpl-source.tar.gz:
  windows-ffmpeg-build/sources/ffmpeg-$FFMPEG_VERSION.tar.xz   FFmpeg's unmodified release tarball, the same file as
                                         https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz
                                         (SHA-256 $FFMPEG_SOURCE_SHA256)
  windows/build-ffmpeg/                  how this exe was built: configure.txt lists every part, build.sh
                                         rebuilds it
BUILDINFO.txt in this folder records the toolchain and every component built in.

Configuration (from the binary):
$FF_CONF
EOF
else
  need "no FFmpeg: --ffmpeg <dir> with ffmpeg.exe (build-ffmpeg/build.sh)"
fi

# ---- 3. the engine (R3e)
ENGINE_EXE_NAME=encore-engine.exe
if [ -n "$ENGINE" ] && [ -f "$ENGINE/$ENGINE_EXE_NAME" ]; then
  [ "$(head -c 2 "$ENGINE/$ENGINE_EXE_NAME")" = "MZ" ] || die "$ENGINE/$ENGINE_EXE_NAME isn't a Windows program"
  # the same check as build-engine/inside.sh: the Encore version line's format and this version (CONTRACT.md §6)
  if ! has_string "$ENGINE/$ENGINE_EXE_NAME" "encore-engine %s" || ! has_string "$ENGINE/$ENGINE_EXE_NAME" "$VERSION"; then
    need "$ENGINE_EXE_NAME isn't an Encore engine stamped $VERSION (build-engine/build.sh $VERSION)"
  fi
  mkdir -p "$STAGE/engine"
  cp "$ENGINE/$ENGINE_EXE_NAME" "$STAGE/engine/$ENGINE_EXE_NAME"
  if [ -d "$ENGINE/licenses" ] && [ -n "$(ls -A "$ENGINE/licenses")" ]; then
    mkdir -p "$STAGE/licenses/go-librespot/third_party"
    cp -r "$ENGINE/licenses/." "$STAGE/licenses/go-librespot/third_party/"
  else
    need "no licenses/ next to $ENGINE_EXE_NAME (the notices of what is statically linked into it)"
  fi
  # how it was built (toolchain, library versions and checksums): part of the GPL build information
  [ -f "$ENGINE/BUILDINFO.txt" ] && cp "$ENGINE/BUILDINFO.txt" "$STAGE/licenses/go-librespot/BUILDINFO.txt"
else
  need "no engine: --engine <dir> with $ENGINE_EXE_NAME"
fi
mkdir -p "$STAGE/licenses/go-librespot"
cat > "$STAGE/licenses/go-librespot/SOURCE.txt" <<EOF
engine\\encore-engine.exe is go-librespot with Encore's changes, licensed under the GNU General Public License,
version 3 (LICENSE.txt in this folder). ENCORE_PATCH.md, also in this folder, lists the upstream version it is based
on and every change Encore made.

The complete corresponding source code of this exact build (go-librespot at the pinned upstream commit, Encore's
patches, the Go modules and C libraries linked into it, and the scripts and library versions used to build it for
Windows) is published with every Encore release as Encore-$VERSION-gpl-source.tar.gz, next to this download. The
same archive holds the source of the tray launcher and the installer script; the whole Encore source tree is
Encore-$VERSION-source.tar.gz. third_party/ holds the licenses of the libraries that are linked into the engine.
EOF

# ---- 4. the launcher
[ -f "$LAUNCHER/Encore Bridge.exe" ] || die "no \"Encore Bridge.exe\" in --launcher $LAUNCHER"
[ "$(head -c 2 "$LAUNCHER/Encore Bridge.exe")" = "MZ" ] || die "Encore Bridge.exe isn't a Windows program"
if [ "$(cat "$LAUNCHER/launcher-version.txt" 2>/dev/null)" != "$VERSION" ] || ! has_string "$LAUNCHER/Encore Bridge.exe" "$VERSION"; then
  need "Encore Bridge.exe isn't stamped $VERSION (build it with launcher/build-in-docker.sh $VERSION)"
fi
cp "$LAUNCHER/Encore Bridge.exe" "$STAGE/Encore Bridge.exe"
if [ -d "$LAUNCHER/licenses/launcher" ]; then
  mkdir -p "$STAGE/licenses/launcher"
  cp -r "$LAUNCHER/licenses/launcher/." "$STAGE/licenses/launcher/"
else
  need "no licenses/launcher next to Encore Bridge.exe"
fi

# ---- 5. text files for Notepad (CRLF), versions, the DEV mark
for f in "$STAGE/settings.env.template" "$STAGE/engine/config.template.yml" "$STAGE/README-Windows.txt" \
         "$STAGE/licenses/ffmpeg/SOURCE.txt" "$STAGE/licenses/ffmpeg/BUILDINFO.txt" "$STAGE/licenses/go-librespot/SOURCE.txt"; do
  [ -f "$f" ] && sed -i 's/\r$//; s/$/\r/' "$f"
done
{
  echo "Encore Bridge $VERSION$SUFFIX"
  echo "  Encore Bridge.exe (launcher)  $VERSION"
  echo "  gateway                       $VERSION"
  if [ -f "$STAGE/engine/$ENGINE_EXE_NAME" ]; then echo "  engine (encore-engine.exe)    $VERSION"; else echo "  engine (encore-engine.exe)    MISSING"; fi
  echo "  Node.js                       $NODE_VERSION"
  if [ -f "$STAGE/ffmpeg/ffmpeg.exe" ]; then echo "  FFmpeg                        $FFMPEG_VERSION ($FF_LICENSE)"; else echo "  FFmpeg                        MISSING"; fi
} | sed 's/$/\r/' > "$STAGE/VERSIONS.txt"
if [ "$DEV" = 1 ]; then
  printf 'This is a DEVELOPMENT bundle of Encore Bridge %s. It is not a release: do not share it.\r\n' "$VERSION" > "$STAGE/DEV-BUILD.txt"
fi

# ---- 6. checks over the payload
bad="$(find "$STAGE" \( -iname '.env' -o -iname '.env.*' -o -iname 'tokens.json' -o -iname 'devices.json' -o -iname 'jam.json' \
  -o -iname 'last.json' -o -iname 'state.json' -o -iname 'admin.json' -o -iname 'showcase.json' -o -iname 'credentials*' -o -iname 'lockfile' -o -iname '*.har' -o -iname '*.zip' \
  -o -iname '*.pem' -o -iname '*.key' -o -iname '*.p12' -o -iname '*.pfx' -o -iname 'id_rsa*' -o -iname 'id_ed25519*' \
  -o -iname 'denylist*' -o -iname '*.log' -o -iname '*.deb' \) -print)"
if [ -n "$bad" ]; then
  die "forbidden files in the bundle:
$bad"
fi
# no Cydia source on the PC: phones get the app from the Encore repo (the setup guide's step 6)
[ ! -e "$STAGE/gateway/repo" ] || die "the bundle has a gateway/repo folder: the app package isn't shipped with the bridge"
if [ -n "$DENYLIST" ]; then
  [ -f "$DENYLIST" ] || die "--denylist $DENYLIST not found"
  grep -v -E '^[[:space:]]*(#|$)' "$DENYLIST" | sed 's/\r$//' > "$TMP/deny.txt" || true
  if [ -s "$TMP/deny.txt" ]; then
    hits="$(grep -r -l -a -i -F -f "$TMP/deny.txt" "$STAGE" || true)"
    [ -z "$hits" ] || die "denylisted text found in:
$hits"
  fi
  log "denylist: clean"
fi
SCAN_RESULT="not run"
if [ -n "$SCAN" ]; then
  log "running the release scan: $SCAN"
  # a single script that can't be executed (no x bit, or a folder mounted noexec) is run with sh
  case "$SCAN" in
    *' '*) ;;
    *) if [ -f "$SCAN" ] && [ ! -x "$SCAN" ]; then SCAN="sh $SCAN"; fi ;;
  esac
  # shellcheck disable=SC2086
  $SCAN "$STAGE" || die "the release scan failed"
  SCAN_RESULT="clean"
else
  need "no --scan: R4's release scan has to pass over the bundle"
fi

# ---- 7. the portable zip (deterministic: sorted entries, fixed times, no extra attributes)
EPOCH="${SOURCE_DATE_EPOCH:-$(find "$TREE/gateway/src" "$TREE/gateway/windows" -type f -printf '%T@\n' | sort -n | tail -n 1 | cut -d. -f1)}"
chmod -R u=rwX,go=rX "$STAGING"
find "$STAGING" -exec touch -h -d "@$EPOCH" {} +
ZIP="$OUT/$NAME-win64.zip"
rm -f "$ZIP"
(cd "$STAGING" && find "Encore Bridge" -print | sort | TZ=UTC zip -X -9 -q -@ "$ZIP")
log "zip: $ZIP"

# ---- 8. the installer
SETUP=""
if [ "$INSTALLER" = 1 ]; then
  [ -n "${ISCC_EXE:-}" ] && [ -f "$ISCC_EXE" ] || die "no Inno Setup (ISCC_EXE); use --no-installer or the encore-winbuild-package image"
  command -v wine >/dev/null || die "no wine for Inno Setup"
  ISS="$TREE/gateway/windows/installer/EncoreBridge.iss"
  [ -f "$ISS" ] || die "no $ISS in the tree"
  w() { winepath -w "$1" 2>/dev/null; }
  RUNNER=""
  command -v xvfb-run >/dev/null && RUNNER="xvfb-run -a"
  log "compiling the installer"
  $RUNNER wine "$ISCC_EXE" /Qp "/DAppVersion=$VERSION$SUFFIX" "/DNumericVersion=$NUMVER" "/DStagingDir=$(w "$STAGE")" \
    "/DOutputDir=$(w "$OUT")" "/DIconFile=$(w "$TREE/gateway/windows/launcher/assets/encore.ico")" "$(w "$ISS")" \
    > "$OUT/$NAME-iscc.log" 2>&1 || { cat "$OUT/$NAME-iscc.log" >&2; die "Inno Setup failed"; }
  SETUP="$OUT/$NAME-setup.exe"
  [ -f "$SETUP" ] || { cat "$OUT/$NAME-iscc.log" >&2; die "Inno Setup made no $SETUP"; }
  if grep -q -i "warning" "$OUT/$NAME-iscc.log"; then
    warn "Inno Setup warnings (see $NAME-iscc.log):"
    grep -i "warning" "$OUT/$NAME-iscc.log" >&2 || true
  fi
  log "installer: $SETUP"
fi

# ---- 9. report
REPORT="$OUT/$NAME-bundle-report.txt"
{
  echo "Encore Bridge $VERSION$SUFFIX: Windows bundle"
  echo "made: $(date -u +%Y-%m-%dT%H:%M:%SZ)  (file times in the zip: $(date -u -d "@$EPOCH" +%Y-%m-%dT%H:%M:%SZ))"
  echo "warnings: $WARNINGS   release scan: $SCAN_RESULT   denylist: ${DENYLIST:+clean}${DENYLIST:-not given}"
  echo
  echo "pins: Node.js $NODE_VERSION ($NODE_EXE_SHA256), FFmpeg $FFMPEG_VERSION (source $FFMPEG_SOURCE_SHA256)"
  echo
  echo "assets (SHA-256):"
  (cd "$OUT" && sha256sum "$(basename "$ZIP")" ${SETUP:+"$(basename "$SETUP")"})
  echo
  echo "payload (SHA-256, the zip and the installer hold the same files):"
  (cd "$STAGING" && find "Encore Bridge" -type f -print0 | sort -z | xargs -0 sha256sum)
} > "$REPORT"
log "report: $REPORT"
[ "$WARNINGS" = 0 ] || log "$WARNINGS warning(s): see above"
log "done"
