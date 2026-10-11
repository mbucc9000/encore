#!/bin/sh
# Encore engine for Windows: build encore-engine.exe from gateway/engine-src on a Linux x86-64 host with Docker.
#
#   sh gateway/windows/build-engine/build.sh <version> [out-dir]
#
# <version> is the Encore release, the same as the bridge's (gateway/src/config.js). The exe lands in out-dir (default:
# ./out next to this script) with SHA256SUMS, BUILDINFO.txt, licenses/ and sources/ (see inside.sh).
#
# Environment:
#   DOCKER          the docker command (default "docker"; e.g. "sudo -n docker")
#   WINBUILD_IMAGE  the build image's tag (default encore-engine-winbuild:1)
#   REBUILD_IMAGE=1 rebuild the build image even if it exists
#   TESTS=1         also build the Windows test executables (out-dir/tests)
#
# The first run builds the image (network needed: Debian packages, Go, vcpkg and the library sources; about 10-20
# minutes). The engine build itself runs with --network none.
set -eu

version="${1:-}"
if [ -z "$version" ]; then
  echo "usage: $0 <version> [out-dir]" >&2
  exit 2
fi

here=$(cd "$(dirname "$0")" && pwd)
src=$(cd "$here/../../engine-src" && pwd)
out="${2:-$here/out}"
mkdir -p "$out"
out=$(cd "$out" && pwd)

docker="${DOCKER:-docker}"
image="${WINBUILD_IMAGE:-encore-engine-winbuild:1}"

if [ "${REBUILD_IMAGE:-0}" = "1" ] || ! $docker image inspect "$image" >/dev/null 2>&1; then
  $docker build -t "$image" -f "$here/Dockerfile" "$src"
fi

$docker run --rm --network none \
  -e VERSION="$version" -e TESTS="${TESTS:-0}" -e OUT_UID="$(id -u)" -e OUT_GID="$(id -g)" \
  -v "$src:/src:ro" -v "$here:/recipe:ro" -v "$out:/out" \
  "$image" sh /recipe/inside.sh

echo "built: $out/encore-engine.exe"
