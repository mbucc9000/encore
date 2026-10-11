#!/bin/sh
# Encore engine for Windows: the build itself. Runs inside the encore-engine-winbuild image (Dockerfile), started by
# build.sh with --network none:
#   /src     gateway/engine-src, read-only
#   /recipe  this directory, read-only
#   /out     the output directory
# Environment: VERSION (required: the Encore release, the same as the bridge's), TESTS=1 to also build the Windows
# test executables, OUT_UID/OUT_GID to hand /out back to the calling user.
#
# Output in /out:
#   encore-engine.exe    windows/amd64, static (system DLLs only), stripped, stamped with VERSION
#   SHA256SUMS           checksums of encore-engine.exe (and the test executables)
#   BUILDINFO.txt        toolchain, vcpkg ports, Go modules, DLL imports
#   licenses/            the licences of the statically linked C libraries and runtimes
#   sources/             the source archives of those libraries, as vcpkg fetched them, and the vcpkg port recipes
#   tests/*.test.exe     with TESTS=1: the Windows unit tests (run them on a Windows PC, see README.md)
set -eu

VERSION="${VERSION:-}"
case "$VERSION" in
  "" | *[!0-9A-Za-z.+-]*) echo "inside.sh: set VERSION to the Encore release, e.g. 1.1.0" >&2; exit 2 ;;
esac

export CGO_ENABLED=1 GOOS=windows GOARCH=amd64 GOAMD64=v1
export CC=x86_64-w64-mingw32-gcc CXX=x86_64-w64-mingw32-g++
# -static: libgcc, winpthreads and the decode libraries go into the exe. No timestamp in the PE header, so two builds
# of the same tree give the same file.
export CGO_LDFLAGS="-static -Wl,--no-insert-timestamp"
export PKG_CONFIG_LIBDIR=/deps/vcpkg_installed/x64-mingw-static/lib/pkgconfig
export PKG_CONFIG_PATH="$PKG_CONFIG_LIBDIR"
export GOPROXY=off GOFLAGS=-mod=readonly GOCACHE=/tmp/go-build GOTOOLCHAIN=local

LDFLAGS="-s -w -buildid= -X main.encoreVersion=$VERSION"
cd /src

echo "== vet (windows/amd64)"
go vet ./output/ ./session/ ./cmd/daemon/
go vet -tags "test_unit test_integration" ./output/ ./session/ ./cmd/daemon/

echo "== build"
mkdir -p /out
rm -rf /out/encore-engine.exe /out/tests /out/SHA256SUMS /out/BUILDINFO.txt
go build -trimpath -buildvcs=false -ldflags "$LDFLAGS" -o /out/encore-engine.exe ./cmd/daemon
file /out/encore-engine.exe

echo "== DLL imports (system DLLs only)"
x86_64-w64-mingw32-objdump -p /out/encore-engine.exe | sed -n 's/^[[:space:]]*DLL Name:[[:space:]]*//p' | sort -fu > /tmp/imports.txt
cat /tmp/imports.txt
bad=$(grep -viE '^(kernel32|msvcrt|ucrtbase|api-ms-win-[a-z0-9-]+|ntdll|advapi32|ws2_32|winmm|ole32|oleaut32|user32|shell32|bcrypt|crypt32|secur32|iphlpapi|dnsapi|userenv|powrprof|shlwapi|mswsock|wsock32)\.dll$' /tmp/imports.txt || true)
if [ -n "$bad" ]; then
  echo "inside.sh: encore-engine.exe imports non-system DLLs:" >&2
  echo "$bad" >&2
  exit 1
fi

echo "== stamp"
# -trimpath keeps -ldflags out of the build info, so look for the strings themselves. The real check is
# "encore-engine.exe --version" on Windows (README.md).
strings -a /out/encore-engine.exe | grep -qF "encore-engine %s" || { echo "inside.sh: not an Encore engine (patch 6)" >&2; exit 1; }
strings -a /out/encore-engine.exe | grep -qF "$VERSION" || { echo "inside.sh: version stamp missing" >&2; exit 1; }
echo "encoreVersion=$VERSION found"

echo "== build paths left in the binary"
# Paths of this container (/src, /deps, /opt, /tmp, /usr) are harmless; a home or user directory is not.
if strings -a /out/encore-engine.exe | grep -E '/home/|/Users/|[A-Za-z]:\\Users\\|/mnt/' | head -5 | grep .; then
  echo "inside.sh: the binary carries a home or user path" >&2
  exit 1
fi
strings -a /out/encore-engine.exe | grep -oE '/(src|deps|opt|tmp)/[A-Za-z0-9._/+-]+' | sort | uniq -c | sort -rn | head -10 || true

if [ "${TESTS:-0}" = "1" ]; then
  echo "== Windows test executables"
  mkdir -p /out/tests
  for p in output session cmd/daemon daemon spclient dealer tracks player; do
    name=$(echo "$p" | tr / -)
    go test -c -trimpath -buildvcs=false -tags "test_unit test_integration" -ldflags "-buildid=" \
      -o "/out/tests/$name.test.exe" "./$p"
  done
  ls -l /out/tests
fi

echo "== licences and sources of the static libraries"
rm -rf /out/licenses /out/sources
mkdir -p /out/licenses
for port in libogg libvorbis libflac mpg123; do
  cp "/deps/vcpkg_installed/x64-mingw-static/share/$port/copyright" "/out/licenses/$port.txt"
done
# -static also links MinGW-w64's runtime (CRT, winpthreads) and GCC's libgcc: their Debian copyright files.
cp /usr/share/doc/mingw-w64-x86-64-dev/copyright /out/licenses/mingw-w64-runtime.txt
cp /usr/share/doc/gcc-mingw-w64-x86-64-win32-runtime/copyright /out/licenses/gcc-runtime.txt
cp -r /deps/sources /out/sources
ls -l /out/licenses /out/sources /out/sources/vcpkg-ports

echo "== BUILDINFO.txt"
{
  echo "encore-engine.exe, Encore $VERSION, windows/amd64"
  echo
  echo "Build: gateway/windows/build-engine (build.sh -> inside.sh) in encore-engine-winbuild, --network none"
  echo "go build -trimpath -buildvcs=false -ldflags \"$LDFLAGS\" ./cmd/daemon"
  echo "CGO_ENABLED=$CGO_ENABLED GOOS=$GOOS GOARCH=$GOARCH GOAMD64=$GOAMD64 CC=$CC CGO_LDFLAGS=\"$CGO_LDFLAGS\""
  echo
  echo "Toolchain:"
  echo "  $(go version)"
  echo "  $($CC --version | head -1)"
  echo "  $(x86_64-w64-mingw32-ld --version | head -1)"
  echo "  mingw-w64 runtime: $(dpkg-query -W -f '${Version}' mingw-w64-x86-64-dev 2>/dev/null || echo unknown)"
  echo "  base image: $(. /etc/os-release && echo "$PRETTY_NAME")"
  echo "  vcpkg: $(git -C /opt/vcpkg describe --tags --always 2>/dev/null || echo unknown) ($(git -C /opt/vcpkg rev-parse HEAD 2>/dev/null || echo unknown))"
  echo "  vcpkg baseline: $(sed -n 's/.*"baseline": *"\([0-9a-f]*\)".*/\1/p' /src/vcpkg-configuration.json)"
  echo
  echo "vcpkg ports (x64-mingw-static, overlay triplet engine-src/vcpkg-triplets):"
  sed 's/^/  /' /deps/vcpkg-ports.txt
  echo
  echo "Library sources and vcpkg port recipes (sources/):"
  (cd /out/sources && find . -type f | sort | sed 's|^\./||' | while read -r f; do sha256sum "$f"; done | sed 's/^/  /')
  echo
  echo "DLL imports:"
  sed 's/^/  /' /tmp/imports.txt
  echo
  echo "Go modules (go version -m):"
  go version -m /out/encore-engine.exe | sed 's/^/  /'
} > /out/BUILDINFO.txt

(cd /out && sha256sum encore-engine.exe $( [ -d tests ] && ls tests/*.exe ) > SHA256SUMS)
cat /out/SHA256SUMS

if [ -n "${OUT_UID:-}" ]; then
  chown -R "$OUT_UID:${OUT_GID:-$OUT_UID}" /out
fi
echo "== done"
