#!/bin/sh
# Encore Bridge for Windows: build Encore's minimal LGPL ffmpeg.exe on a Linux x86-64 host with Docker.
#
#   sh gateway/windows/build-ffmpeg/build.sh [out-dir]
#
# ffmpeg.exe lands in out-dir (default: ./out next to this script) with SHA256SUMS, BUILDINFO.txt, licenses/ and
# sources/ (the FFmpeg release tarball it is built from; see inside.sh).
#
# Environment:
#   DOCKER          the docker command (default "docker"; e.g. "sudo -n docker")
#   FFBUILD_IMAGE   the build image's tag (default encore-ffmpeg-winbuild:1)
#   REBUILD_IMAGE=1 rebuild the build image even if it exists
#   LINUX=1         also build the same configuration for Linux (out-dir/linux/ffmpeg) to run the bridge tests with
#
# The first run builds the image (network needed: Debian packages and the FFmpeg tarball; a few minutes). The FFmpeg
# build itself runs with --network none and takes a few minutes.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
out="${1:-$here/out}"
mkdir -p "$out"
out=$(cd "$out" && pwd)

docker="${DOCKER:-docker}"
image="${FFBUILD_IMAGE:-encore-ffmpeg-winbuild:1}"

if [ "${REBUILD_IMAGE:-0}" = "1" ] || ! $docker image inspect "$image" >/dev/null 2>&1; then
  $docker build -t "$image" "$here"
fi

$docker run --rm --network none \
  -e LINUX="${LINUX:-0}" -e OUT_UID="$(id -u)" -e OUT_GID="$(id -g)" \
  -v "$here:/recipe:ro" -v "$out:/out" \
  "$image" sh /recipe/inside.sh

echo "built: $out/ffmpeg.exe"
