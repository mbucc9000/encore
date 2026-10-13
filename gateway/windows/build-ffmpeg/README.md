# Building the Windows `ffmpeg.exe`

The Windows Encore Bridge runs FFmpeg for two jobs: encoding the engine's audio to AAC for the phone
(`gateway/src/encoder.js`) and turning cover pictures into small JPEGs (`gateway/src/image.js`). This folder builds an
FFmpeg with exactly those parts and nothing else (RELEASE-PLAN D21's minimal LGPL build), from FFmpeg's official
release tarball, on a Linux x86-64 machine with Docker. Nothing has to be installed on a Windows PC.

Why our own build: a ready-made static FFmpeg for Windows links dozens of other libraries, and LGPL redistribution
means shipping the source of every one of them. This build links only zlib, so its complete source is FFmpeg's own
tarball, which every release carries in `Encore-<version>-gpl-source.tar.gz`. It is also about 5 MB instead of about
100 MB.

| File | What it is |
|---|---|
| `configure.txt` | The component list: FFmpeg's own AAC encoder, the PCM, JPEG, PNG, WebP, GIF and BMP readers, the JPEG writer, scaling and cropping. No `--enable-gpl`, `--enable-version3` or `--enable-nonfree` |
| `Dockerfile` | The build image, `encore-ffmpeg-winbuild`: Debian, MinGW-w64, nasm, zlib for MinGW, and the FFmpeg release tarball, checked against its pin and FFmpeg's release signing key |
| `build.sh` | Builds the image if needed, then runs `inside.sh` in it with `--network none` |
| `inside.sh` | The build itself and its checks |

## Build

On a Linux x86-64 machine with Docker, from the source tree:

```sh
sh gateway/windows/build-ffmpeg/build.sh                         # into gateway/windows/build-ffmpeg/out
DOCKER="sudo -n docker" LINUX=1 sh gateway/windows/build-ffmpeg/build.sh /tmp/ffmpeg-out
```

The first run builds the image. That needs the network (Debian packages, the tarball, its signature and FFmpeg's
public key) and takes a few minutes. The build itself runs offline and takes a few minutes more. It is reproducible:
two builds with the same image give the same `ffmpeg.exe` (the PE header's time comes from `SOURCE_DATE_EPOCH`, by
default 2026-01-01).

Output:

| File | |
|---|---|
| `ffmpeg.exe` | `windows/amd64`, statically linked (it imports only Windows system DLLs), stripped |
| `SHA256SUMS` | The build's file list (`ffmpeg.exe` and the source tarball). The release step checks `ffmpeg.exe` against it |
| `BUILDINFO.txt` | FFmpeg's version, the tarball's signature check, the configure line, every component built in, the toolchain, the DLL imports |
| `licenses/` | `LICENSE.txt` (the LGPL 2.1 text, FFmpeg's `COPYING.LGPLv2.1`), `FFmpeg-LICENSE.md`, and the licences of zlib and of the MinGW-w64 and GCC runtimes that `-static` links in |
| `sources/` | `ffmpeg-<version>.tar.xz`, the unmodified release tarball it is built from |
| `linux/ffmpeg` | With `LINUX=1`: the same configuration built for Linux, to run the bridge's tests against exactly these components (`FFMPEG=…`, see `gateway/test/README.md`). Never shipped |

`gateway/windows/build.sh --ffmpeg <out>` puts `ffmpeg.exe` and its licences into the Windows bundle, and
`tools/release/release.py --windows-ffmpeg <out>` also adds the build's `BUILDINFO.txt`, `licenses/` and `sources/` to
the GPL source bundle as `windows-ffmpeg-build/`.

## What is pinned

| | Pin | Where |
|---|---|---|
| FFmpeg | 8.1.3, exactly `ffmpeg-8.1.3.tar.xz`, FFmpeg's release key `FCF986EA15E6E293A5644F10B4322F04D67658D8` | `Dockerfile`; `../bundle/pins.conf` repeats the version and the tarball pin |
| Base image | `debian:trixie-slim`, exact image (the same as the engine's build image) | `Dockerfile` |
| Toolchain | Debian's MinGW-w64 GCC 14 (`win32` threads), binutils, nasm, zlib for MinGW | Debian trixie packages |

## Updating FFmpeg

1. Pick the new release from <https://ffmpeg.org/download.html>. Change `FFMPEG_VERSION` and `FFMPEG_SHA256` in the
   `Dockerfile` (from the tarball whose signature verifies), and `FFMPEG_VERSION` and `FFMPEG_SOURCE_SHA256` in
   `../bundle/pins.conf`.
2. Build with `REBUILD_IMAGE=1 LINUX=1`, then run the bridge's tests with the Linux build (`FFMPEG=<out>/linux/ffmpeg`;
   tests that make their own test pictures need a full FFmpeg for that step) and the Windows smoke test: encode PCM to
   AAC and convert a JPEG with the arguments `encoder.js` and `image.js` use.
3. If the bridge ever needs another FFmpeg part, add it to `configure.txt` and to the check list in `inside.sh`.
