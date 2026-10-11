#!/bin/sh
# Encore Bridge for Windows: the FFmpeg build itself. Runs inside the encore-ffmpeg-winbuild image (Dockerfile),
# started by build.sh with --network none:
#   /recipe  this directory, read-only (configure.txt: the component list)
#   /out     the output directory
# Environment: LINUX=1 also builds the same configuration for Linux x86-64 (out/linux/ffmpeg, static), so the bridge's
# tests can run against exactly these components (gateway/test with FFMPEG=...); OUT_UID/OUT_GID hand /out back to the
# calling user.
#
# Output in /out:
#   ffmpeg.exe       windows/amd64, statically linked (system DLLs only), stripped
#   SHA256SUMS       checksums of ffmpeg.exe and the source tarball
#   BUILDINFO.txt    FFmpeg's version, the source tarball's SHA-256 and signature, the configure line, the components
#                    built in, the toolchain and the DLL imports
#   licenses/        LICENSE.txt (FFmpeg's COPYING.LGPLv2.1), FFmpeg-LICENSE.md, and the licences of zlib and of the
#                    MinGW-w64 and GCC runtimes that -static links in (Debian's copyright files)
#   sources/         the FFmpeg release tarball ffmpeg.exe is built from (its signature was checked when the image was
#                    built; BUILDINFO.txt records the result)
#   linux/ffmpeg     with LINUX=1: the same configuration for Linux (for the bridge tests; never shipped)
set -eu
# strip (FFmpeg's own and ours) writes a time into the PE header; binutils takes it from SOURCE_DATE_EPOCH, so two
# builds give the same file (2026-01-01 unless the caller sets one, the same default as tools/release)
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1767225600}"

V="$(cat /deps/FFMPEG_VERSION)"
TARBALL="/deps/sources/ffmpeg-$V.tar.xz"
FLAGS="$(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' /recipe/configure.txt | tr '\n' ' ')"

build() { # build <dir> <the target's own configure options...>
  dir="$1"
  shift
  rm -rf "$dir"
  mkdir -p "$dir"
  tar -C "$dir" --strip-components=1 -xf "$TARBALL"
  cd "$dir"
  # shellcheck disable=SC2086
  if ! ./configure $FLAGS "$@" > configure.out 2>&1; then
    tail -40 configure.out
    tail -40 ffbuild/config.log
    exit 1
  fi
  make -j"$(nproc)" > make.out 2>&1 || { tail -60 make.out; exit 1; }
}

echo "== FFmpeg $V for windows/amd64"
build /build/win --enable-cross-compile --target-os=mingw32 --arch=x86_64 --cross-prefix=x86_64-w64-mingw32- \
  --enable-w32threads --pkg-config=pkg-config --extra-ldflags="-static -Wl,--no-insert-timestamp"
mkdir -p /out
rm -rf /out/ffmpeg.exe /out/SHA256SUMS /out/BUILDINFO.txt /out/licenses /out/sources /out/linux
x86_64-w64-mingw32-strip -o /out/ffmpeg.exe /build/win/ffmpeg.exe
file /out/ffmpeg.exe

echo "== LGPL only"
for opt in gpl version3 nonfree; do
  OPT=$(echo "$opt" | tr a-z A-Z)
  grep -q "^#define CONFIG_$OPT 0" /build/win/config.h || { echo "inside.sh: built with --enable-$opt" >&2; exit 1; }
done
grep -q '^#define CONFIG_ZLIB 1' /build/win/config.h || { echo "inside.sh: zlib (PNG) is missing" >&2; exit 1; }
CONF="$(sed -n 's/^#define FFMPEG_CONFIGURATION "\(.*\)"$/\1/p' /build/win/config.h)"
echo "configure: $CONF"

echo "== the components the bridge needs"
missing=""
for c in AAC_ENCODER MJPEG_ENCODER PCM_S16LE_DECODER MJPEG_DECODER PNG_DECODER WEBP_DECODER PCM_S16LE_DEMUXER \
         IMAGE2_DEMUXER IMAGE_JPEG_PIPE_DEMUXER IMAGE_PNG_PIPE_DEMUXER ADTS_MUXER IMAGE2_MUXER FILE_PROTOCOL \
         PIPE_PROTOCOL SCALE_FILTER CROP_FILTER SPLIT_FILTER FORMAT_FILTER ARESAMPLE_FILTER AFORMAT_FILTER \
         SWSCALE SWRESAMPLE; do
  cat /build/win/config.h /build/win/config_components.h | grep -q "^#define CONFIG_$c 1" || missing="$missing $c"
done
[ -z "$missing" ] || { echo "inside.sh: not built in:$missing" >&2; exit 1; }
echo "all present"

echo "== DLL imports (system DLLs only)"
x86_64-w64-mingw32-objdump -p /out/ffmpeg.exe | sed -n 's/^[[:space:]]*DLL Name:[[:space:]]*//p' | sort -fu > /tmp/imports.txt
cat /tmp/imports.txt
bad=$(grep -viE '^(kernel32|msvcrt|ucrtbase|api-ms-win-[a-z0-9-]+|ntdll|advapi32|ws2_32|winmm|ole32|oleaut32|user32|shell32|bcrypt|crypt32|secur32|iphlpapi|dnsapi|userenv|powrprof|shlwapi|mswsock|wsock32)\.dll$' /tmp/imports.txt || true)
if [ -n "$bad" ]; then
  echo "inside.sh: ffmpeg.exe imports non-system DLLs:" >&2
  echo "$bad" >&2
  exit 1
fi

echo "== build paths left in the binary"
if strings -a /out/ffmpeg.exe | grep -E '/home/|/Users/|[A-Za-z]:\\Users\\|/mnt/' | head -5 | grep .; then
  echo "inside.sh: the binary carries a home or user path" >&2
  exit 1
fi

if [ "${LINUX:-0}" = "1" ]; then
  echo "== the same configuration for Linux x86-64 (tests only)"
  build /build/linux --enable-pthreads --extra-ldflags=-static
  mkdir -p /out/linux
  strip -o /out/linux/ffmpeg /build/linux/ffmpeg
  echo "== smoke test (Linux build): 2 s of PCM -> AAC in ADTS, as encoder.js runs it"
  head -c 352800 /dev/urandom | /build/linux/ffmpeg -hide_banner -loglevel error -f s16le -ar 44100 -ac 2 -i pipe:0 \
    -c:a aac -b:a 160k -f adts -flush_packets 1 pipe:1 > /tmp/smoke.aac
  head -c 2 /tmp/smoke.aac | od -An -tx1 | grep -q 'ff f1' || { echo "inside.sh: no ADTS output" >&2; exit 1; }
  echo "ADTS ok ($(wc -c < /tmp/smoke.aac) bytes)"
fi

echo "== licences and sources"
mkdir -p /out/licenses /out/sources
cp /build/win/LICENSE.md /out/licenses/FFmpeg-LICENSE.md
cp /build/win/COPYING.LGPLv2.1 /out/licenses/LICENSE.txt
cp /usr/share/doc/libz-mingw-w64-dev/copyright /out/licenses/zlib.txt
cp /usr/share/doc/mingw-w64-x86-64-dev/copyright /out/licenses/mingw-w64-runtime.txt
cp /usr/share/doc/gcc-mingw-w64-x86-64-win32-runtime/copyright /out/licenses/gcc-runtime.txt
cp "$TARBALL" /out/sources/
ls -l /out/licenses /out/sources

echo "== BUILDINFO.txt"
{
  echo "ffmpeg.exe: FFmpeg $V (Encore's minimal LGPL build), windows/amd64"
  echo
  echo "Build: gateway/windows/build-ffmpeg (build.sh -> inside.sh) in encore-ffmpeg-winbuild, --network none"
  echo "Source: sources/ffmpeg-$V.tar.xz, FFmpeg's release tarball, unmodified"
  echo "  sha256 $(sha256sum "$TARBALL" | cut -d' ' -f1)"
  echo "  signature: FFmpeg's ffmpeg-$V.tar.xz.asc (https://ffmpeg.org/releases/), checked when the image was built:"
  echo "    $(cat /deps/signature.txt)"
  echo
  echo "Configure line (as built in; the component list is configure.txt):"
  echo "  $CONF"
  echo
  echo "License: LGPL-2.1-or-later (CONFIG_GPL 0, CONFIG_VERSION3 0, CONFIG_NONFREE 0)"
  echo "External libraries: zlib $(dpkg-query -W -f '${Version}' libz-mingw-w64-dev 2>/dev/null || echo unknown) (zlib License), statically linked"
  echo
  echo "Components built in:"
  sed -n 's/^#define CONFIG_\([A-Z0-9_]*_\(ENCODER\|DECODER\|DEMUXER\|MUXER\|PROTOCOL\|FILTER\|PARSER\|BSF\)\) 1$/  \1/p' /build/win/config_components.h | tr 'A-Z' 'a-z'
  echo
  echo "Toolchain:"
  echo "  $(x86_64-w64-mingw32-gcc --version | head -1)"
  echo "  $(x86_64-w64-mingw32-ld --version | head -1)"
  echo "  nasm $(nasm -v | sed 's/^NASM version //')"
  echo "  mingw-w64 runtime: $(dpkg-query -W -f '${Version}' mingw-w64-x86-64-dev 2>/dev/null || echo unknown)"
  echo "  base image: $(. /etc/os-release && echo "$PRETTY_NAME")"
  echo
  echo "DLL imports:"
  sed 's/^/  /' /tmp/imports.txt
} > /out/BUILDINFO.txt
(cd /out && sha256sum ffmpeg.exe "sources/ffmpeg-$V.tar.xz" > SHA256SUMS)
cat /out/SHA256SUMS

if [ -n "${OUT_UID:-}" ]; then
  chown -R "$OUT_UID:${OUT_GID:-$OUT_UID}" /out
fi
echo "== done"
