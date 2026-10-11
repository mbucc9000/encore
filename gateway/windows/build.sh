#!/usr/bin/env bash
# Builds Encore Bridge for Windows on a Linux machine with Docker: the launcher ("Encore Bridge.exe"), then the
# staging folder, the portable zip and the installer (bundle/bundle.sh), all inside the two build images.
#
#   build.sh --tree <exported tree> --engine <dir> --ffmpeg <dir> --out <dir> [--scan <script>] [--denylist <file>]
#            [--cache <dir>] [--no-installer] [--dev]
#
#   --tree      R4's exported release tree (bundle.sh refuses the working copy)
#   --engine    the Windows engine build (build-engine/build.sh): encore-engine.exe + licenses/ (optional with --dev)
#   --ffmpeg    Encore's FFmpeg build (build-ffmpeg/build.sh): ffmpeg.exe, SHA256SUMS, BUILDINFO.txt, licenses/
#               (optional with --dev)
#   --out       output folder (launcher/, staging/, the zip, the installer, the report, downloads/)
#   --scan      R4's release scan: an executable that takes the staging folder as its only argument. Its folder is
#               mounted read-only into the packaging container, so it may read files next to it.
#   --denylist  extra literal strings that must not appear in the bundle (see bundle.sh)
#   --cache     keep the Node.js download here between runs (default: <out>/downloads); it is checked against
#               bundle/pins.conf before use
#   --dev / --no-installer   passed to bundle.sh
#
# Docker: set DOCKER="sudo -n docker" where Docker needs sudo. The images are built from docker/ the first time:
#   encore-winbuild-launcher:1   Go 1.25 cross-compiler + go-winres
#   encore-winbuild-package:1    zip tools + Inno Setup 6 under Wine
# They hold toolchains only; nothing else on the machine is touched.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER="${DOCKER:-docker}"
TREE="" ENGINE="" FFMPEG="" OUT="" SCAN="" DENYLIST="" CACHE="" PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --tree) TREE="$2"; shift 2 ;;
    --engine) ENGINE="$2"; shift 2 ;;
    --ffmpeg) FFMPEG="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --scan) SCAN="$2"; shift 2 ;;
    --denylist) DENYLIST="$2"; shift 2 ;;
    --cache) CACHE="$2"; shift 2 ;;
    --dev|--no-installer) PASS+=("$1"); shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) echo "build: unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$TREE" ] && [ -n "$OUT" ] || { echo "build: --tree and --out are required (see --help)" >&2; exit 2; }
TREE="$(cd "$TREE" && pwd)"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
VERSION="$(sed -nE "s/^[[:space:]]*version:[[:space:]]*'([^']+)'.*/\1/p" "$TREE/gateway/src/config.js" | head -n 1)"
[ -n "$VERSION" ] || { echo "build: no version in gateway/src/config.js" >&2; exit 1; }
echo "build: Encore Bridge $VERSION for Windows"

# 1. build images (only when missing)
for img in launcher package; do
  if ! $DOCKER image inspect "encore-winbuild-$img:1" >/dev/null 2>&1; then
    echo "build: making the encore-winbuild-$img:1 image"
    $DOCKER build -t "encore-winbuild-$img:1" -f "$HERE/docker/$img.Dockerfile" "$HERE/docker"
  fi
done

# 2. the launcher, from the tree's copy of its source
rm -rf "$OUT/launcher"
mkdir -p "$OUT/launcher"
$DOCKER run --rm \
  -v "$TREE/gateway/windows/launcher:/src:ro" -v "$OUT/launcher:/out" -v encore-winbuild-gomod:/go/pkg/mod \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  encore-winbuild-launcher:1 sh /src/build-in-docker.sh "$VERSION" /out

# 3. staging folder, zip, installer
MOUNTS=(-v "$TREE:/tree:ro" -v "$OUT:/out")
ARGS=(--tree /tree --launcher /out/launcher --out /out)
if [ -n "$CACHE" ]; then
  mkdir -p "$CACHE"
  CACHE="$(cd "$CACHE" && pwd)"
  MOUNTS+=(-v "$CACHE:/cache")
  ARGS+=(--cache /cache)
else
  ARGS+=(--cache /out/downloads)
fi
if [ -n "$ENGINE" ]; then
  MOUNTS+=(-v "$(cd "$ENGINE" && pwd):/engine:ro")
  ARGS+=(--engine /engine)
fi
if [ -n "$FFMPEG" ]; then
  MOUNTS+=(-v "$(cd "$FFMPEG" && pwd):/ffmpeg:ro")
  ARGS+=(--ffmpeg /ffmpeg)
fi
if [ -n "$SCAN" ]; then
  MOUNTS+=(-v "$(cd "$(dirname "$SCAN")" && pwd):/scan:ro")
  ARGS+=(--scan "/scan/$(basename "$SCAN")")
fi
if [ -n "$DENYLIST" ]; then
  MOUNTS+=(-v "$(cd "$(dirname "$DENYLIST")" && pwd)/$(basename "$DENYLIST"):/denylist.txt:ro")
  ARGS+=(--denylist /denylist.txt)
fi
status=0
$DOCKER run --rm "${MOUNTS[@]}" ${SOURCE_DATE_EPOCH:+-e SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH"} encore-winbuild-package:1 \
  bash /tree/gateway/windows/bundle/bundle.sh "${ARGS[@]}" ${PASS[@]+"${PASS[@]}"} || status=$?
# hand the outputs to the calling user (the container runs as root)
$DOCKER run --rm -v "$OUT:/out" ${CACHE:+-v "$CACHE:/cache"} encore-winbuild-package:1   chown -R "$(id -u):$(id -g)" /out ${CACHE:+/cache}
exit "$status"
