# Building the Windows engine (`encore-engine.exe`)

This folder builds `gateway/engine-src` (go-librespot with Encore's patches) for `windows/amd64`, on a Linux x86-64
machine with Docker. It follows upstream's cross-build (`engine-src/CROSS_COMPILE.md`) plus `-trimpath`, an Encore
version stamp and checks on the result. `Dockerfile` is the build image `encore-engine-winbuild` (Debian, Go,
MinGW-w64, vcpkg, the static decode libraries); `build.sh` runs `inside.sh` in it with `--network none`.

## Build

```sh
sh gateway/windows/build-engine/build.sh <version> [<out folder>]
DOCKER="sudo -n docker" TESTS=1 sh gateway/windows/build-engine/build.sh <version> /tmp/engine-out
```

- `<version>` is the Encore release (`version` in `gateway/src/config.js`).
- The first run builds the image (needs the network, 5 to 20 minutes). Later runs are offline. `REBUILD_IMAGE=1`
  rebuilds the image. Two builds of the same tree give the same file.
- Output (`out/` next to the script by default): `encore-engine.exe`, `SHA256SUMS` (the build's file list),
  `BUILDINFO.txt`, `licenses/`, `sources/` (C library sources, vcpkg recipes) and, with `TESTS=1`, `tests/`.
- The build fails unless the exe imports only Windows system DLLs, has the version stamp and holds no home-folder paths.
- `--version` prints `encore-engine <version> (go-librespot dev, Encore patches 1-8)`; the bridge checks it.

Pins: the Debian image, Go (`GO_VERSION`, `GO_SHA256`) and vcpkg (`VCPKG_TAG`, `VCPKG_COMMIT`) in `Dockerfile`; the
libraries in upstream's `engine-src/vcpkg-configuration.json` and `vcpkg-triplets/`; the Go modules in `go.mod` and
`go.sum`. For a newer Go, change `GO_VERSION` and `GO_SHA256` (from https://go.dev/dl/), rebuild with
`REBUILD_IMAGE=1`, and run the Windows tests again.

## Tests on Windows

Build with `TESTS=1`, copy `tests/` and `engine-src` to a Windows PC, and run each test from its package folder:

```bat
cd engine-src\output
<tests>\output.test.exe -test.v
```

The tests are `output`, `session`, `cmd-daemon`, `daemon`, `spclient`, `dealer`, `tracks` and `player`. They need no
network and no Spotify account. Then check that `encore-engine.exe --version` and `--help` work.

## GPL

`encore-engine.exe` is GPL-3.0, like go-librespot. A release ships its source with it: `gateway/engine-src`, this
folder, and `sources/` from the build (mpg123 is LGPL-2.1). `go mod vendor` in `engine-src` adds the Go modules.
