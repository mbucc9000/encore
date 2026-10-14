# Building the Windows `ffmpeg.exe`

The Windows bridge uses FFmpeg to encode audio to AAC (`gateway/src/encoder.js`) and to shrink cover pictures
(`gateway/src/image.js`). This folder builds an FFmpeg with only those parts from FFmpeg's release tarball, on a Linux
x86-64 machine with Docker. It links only zlib, so the tarball is its complete source (shipped in
`Encore-<version>-gpl-source.tar.gz`).

- `configure.txt`: the component list. No `--enable-gpl`, `--enable-version3` or `--enable-nonfree`.
- `Dockerfile`: the build image `encore-ffmpeg-winbuild`, with the tarball checked against its pin and FFmpeg's
  release signature.
- `build.sh`: builds the image if needed, then runs `inside.sh` in it with `--network none`.

## Build

```sh
sh gateway/windows/build-ffmpeg/build.sh                         # into gateway/windows/build-ffmpeg/out
DOCKER="sudo -n docker" LINUX=1 sh gateway/windows/build-ffmpeg/build.sh /tmp/ffmpeg-out
```

- The first run builds the image (needs the network). The build itself is offline and reproducible.
- Output: `ffmpeg.exe`, `SHA256SUMS` (the build's file list), `BUILDINFO.txt`, `licenses/`, `sources/` (the tarball),
  and with `LINUX=1` a Linux build in `linux/ffmpeg` for the bridge's tests (never shipped).
- Pass the out folder to `gateway/windows/build.sh --ffmpeg` and `tools/release/release.py --windows-ffmpeg`.

## Updating FFmpeg

1. Change `FFMPEG_VERSION` and `FFMPEG_SHA256` in `Dockerfile`, and `FFMPEG_VERSION` and `FFMPEG_SOURCE_SHA256` in
   `../bundle/pins.conf` (from a tarball whose signature verifies, <https://ffmpeg.org/download.html>).
2. Build with `REBUILD_IMAGE=1 LINUX=1` and run the bridge's tests with `FFMPEG=<out>/linux/ffmpeg`.
3. If the bridge needs another FFmpeg part, add it to `configure.txt` and to the check list in `inside.sh`.
