#!/bin/sh
# Builds "Encore Bridge.exe" inside the encore-winbuild-launcher image (see ../docker/launcher.Dockerfile).
#   build-in-docker.sh <version> <out dir> [encoreupdatetest]
# The third argument makes the update TEST build (Go build tag encoreupdatetest: a fake GitHub on loopback, a test key,
# --update-test; DESIGN-UPDATES.md §9) for testdata/update-smoke.sh, plus test-tools/fakegh (a Linux program) next to
# it. A test build is never released: build_windows.py refuses an exe with its strings.
# The source is copied to a scratch folder first, so the mounted tree is never written to. Steps: verify the module
# hashes, check formatting, run the platform-independent tests natively, vet the Windows build, add the icon/manifest/version resources,
# build (trimmed paths, no build id, stamped version), then collect the licenses of everything linked in.
set -eu
VER="${1:?version}"
OUT="${2:?out dir}"
TAGS="${3:-}"
case "$TAGS" in ''|encoreupdatetest) ;; *) echo "unknown build variant: $TAGS" >&2; exit 2 ;; esac
SRC="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
cp -r "$SRC/." "$WORK/"
cd "$WORK"
rm -f rsrc_windows_*.syso

go mod download
go mod verify
unformatted="$(gofmt -l .)"
[ -z "$unformatted" ] || { echo "not gofmt-formatted: $unformatted" >&2; exit 1; }
go test ./internal/...
GOOS=windows GOARCH=amd64 go vet ./...
GOOS=windows GOARCH=amd64 go vet -tags encoreupdatetest ./...

# file versions must be numeric: 1.1.0-beta.2 -> 1.1.0
NUMVER="$(printf '%s' "$VER" | sed -E 's/^v//; s/[^0-9.].*$//')"
[ -n "$NUMVER" ] || NUMVER=0.0.0
go-winres make --in winres/winres.json --arch amd64 --product-version "$NUMVER" --file-version "$NUMVER"

mkdir -p "$OUT/licenses/launcher"
GOOS=windows GOARCH=amd64 go build -trimpath -buildvcs=false ${TAGS:+-tags "$TAGS"} \
  -ldflags "-s -w -H windowsgui -buildid= -X main.version=$VER" \
  -o "$OUT/Encore Bridge.exe" .
if [ -n "$TAGS" ]; then
  mkdir -p "$OUT/test-tools"
  GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false -o "$OUT/test-tools/fakegh" ./internal/update/fakegh/cmd/fakegh
  printf 'update test build (%s): never release this exe\n' "$TAGS" > "$OUT/test-tools/TEST-BUILD.txt"
fi

# Licenses of the code linked into the exe: the Go runtime and standard library, and each module dependency that
# ends up in the Windows build.
MOD="$(go env GOMODCACHE)"
cp "$(go env GOROOT)/LICENSE" "$OUT/licenses/launcher/go-LICENSE.txt"
for m in $(GOOS=windows GOARCH=amd64 go list -deps -f '{{if .Module}}{{if not .Module.Main}}{{.Module.Path}}@{{.Module.Version}}{{end}}{{end}}' . | sort -u); do
  name="$(printf '%s' "${m%@*}" | tr '/' '_')"
  for f in LICENSE LICENSE.txt LICENSE.md COPYING; do
    if [ -f "$MOD/$m/$f" ]; then cp "$MOD/$m/$f" "$OUT/licenses/launcher/$name-LICENSE.txt"; break; fi
  done
  echo "$m" >> "$OUT/licenses/launcher/MODULES.txt"
done
go version > "$OUT/licenses/launcher/TOOLCHAIN.txt"
printf '%s' "$VER" > "$OUT/launcher-version.txt"
# hand the files to the calling user when run as root in a container
if [ -n "${HOST_UID:-}" ]; then chown -R "$HOST_UID:${HOST_GID:-$HOST_UID}" "$OUT"; fi
echo "built $OUT/Encore Bridge.exe ($VER${TAGS:+, $TAGS})"
