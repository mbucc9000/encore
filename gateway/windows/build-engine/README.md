# Building the Windows engine (`encore-engine.exe`)

The Windows Encore Bridge runs the same patched go-librespot as the Docker image, built for `windows/amd64`. This
folder is the complete recipe. It cross-compiles `gateway/engine-src` on a Linux x86-64 machine with Docker, so
nothing has to be installed on a Windows PC. It follows upstream's own cross-build (go-librespot CI job
`windows-vcpkg`, `engine-src/CROSS_COMPILE.md`) with three additions: `-trimpath`, an Encore version stamp, and checks
on the result.

| File | What it is |
|---|---|
| `Dockerfile` | The build image, `encore-engine-winbuild`: Debian, Go, MinGW-w64, vcpkg, and the static decode libraries |
| `build.sh` | Builds the image if needed, then runs `inside.sh` in it with `--network none` |
| `inside.sh` | The build itself and its checks |

## Build

On a Linux x86-64 machine with Docker, from the source tree:

```sh
sh gateway/windows/build-engine/build.sh 1.1.0         # the Encore release, the same as the bridge's
DOCKER="sudo -n docker" TESTS=1 sh gateway/windows/build-engine/build.sh 1.1.0 /tmp/engine-out
```

The first run builds the image. That needs the network (Debian packages, Go, vcpkg and the library sources) and takes
5 to 20 minutes. Later runs reuse the image and work offline: a few minutes, most of it the test executables.

Output (`out/` next to the script unless you name a folder):

| File | |
|---|---|
| `encore-engine.exe` | `windows/amd64`, statically linked, stripped, stamped with the version |
| `SHA256SUMS` | The build's file list (the exe and the test executables). The release step checks the exe against it |
| `BUILDINFO.txt` | Toolchain versions, vcpkg ports, library sources, DLL imports, Go modules |
| `licenses/` | The licences of the statically linked C libraries (libogg, libvorbis, libflac: BSD-3-Clause; mpg123: LGPL-2.1) and of the MinGW-w64 runtime and GCC runtime that `-static` links in (Debian's copyright files) |
| `sources/` | The source archives of those libraries, exactly as vcpkg fetched them, and in `sources/vcpkg-ports/` the vcpkg port recipes that built them (`portfile.cmake` and the patches applied to each library) |
| `tests/*.test.exe` | With `TESTS=1`: the engine's unit tests, built for Windows |

## What is pinned

| | Pin | Where |
|---|---|---|
| Base image | `debian:trixie-slim`, exact image | `Dockerfile` |
| Go | 1.26.8, exact download | `Dockerfile` (`GO_VERSION`, `GO_SHA256`) |
| MinGW-w64 | Debian trixie's `gcc-mingw-w64-x86-64` (version in `BUILDINFO.txt`) | `Dockerfile` |
| vcpkg | tag 2025.09.17, commit checked | `Dockerfile` (`VCPKG_TAG`, `VCPKG_COMMIT`) |
| Library versions | vcpkg baseline `c59b04f668d20c7dd83f478835e8266a3cc51270` | `engine-src/vcpkg-configuration.json` (upstream's) |
| Library build | static libraries, dynamic system C runtime, FLAC's C library only | `engine-src/vcpkg-triplets/x64-mingw-static.cmake` (upstream's) |
| Go modules | every module, exactly | `engine-src/go.mod`, `engine-src/go.sum` |

Go 1.26 rather than the 1.25 named in `go.mod`: 1.25 no longer gets security fixes. The `go 1.25` line in `go.mod`
keeps the language version and the runtime's GODEBUG defaults of Go 1.25. To move to a newer Go, change `GO_VERSION`
and `GO_SHA256` (from https://go.dev/dl/), rebuild with `REBUILD_IMAGE=1`, and run the Windows tests again.

## The build command

`inside.sh` runs, with the decode libraries found through pkg-config and the network off:

```sh
CGO_ENABLED=1 GOOS=windows GOARCH=amd64 GOAMD64=v1 CC=x86_64-w64-mingw32-gcc \
CGO_LDFLAGS="-static -Wl,--no-insert-timestamp" \
PKG_CONFIG_LIBDIR=/deps/vcpkg_installed/x64-mingw-static/lib/pkgconfig GOPROXY=off \
go build -trimpath -buildvcs=false -ldflags "-s -w -buildid= -X main.encoreVersion=<version>" \
  -o encore-engine.exe ./cmd/daemon
```

- `-static` links libgcc, winpthreads and the decode libraries into the exe.
- `-trimpath` keeps the build machine's paths out of it.
- `--no-insert-timestamp` and `-buildid=` make two builds of the same tree byte-identical.

## Checks `inside.sh` makes

- `go vet` of the Windows-specific packages (`output`, `session`, `cmd/daemon`) for `windows/amd64`.
- The exe imports only Windows system DLLs (today `KERNEL32`, `msvcrt`, `ADVAPI32` and `SHLWAPI`; Go loads the rest
  at run time). A MinGW runtime or codec DLL fails the build.
- The version stamp is in the binary.
- No home or user directory paths are left in the binary.

## The version stamp

`encore-engine.exe --version` prints one line and exits. It creates and locks nothing:

```
encore-engine 1.1.0 (go-librespot dev, Encore patches 1-6)
```

The bridge is meant to read that line to check that the engine matches it (`ENCORE_PATCH.md`, patch 6, "Note for the
gateway"). A stamped engine also logs it at start, as `running encore-engine ...`. The Docker engine is not stamped,
and prints `go-librespot dev (Encore patches 1-6, unstamped)`.

The stamp is Encore's own variable (`main.encoreVersion`), not go-librespot's `version`. go-librespot sends its
`version` to Spotify (client version, build flags, user agent), so it is left unset, exactly as in the Docker image.

## Tests on Windows

Go can't run Windows tests on Linux. Build them with `TESTS=1`, copy `tests/` and `engine-src` to a Windows PC, and
run each one from its package folder in `engine-src`, as `go test` would (some tests read fixtures by relative path,
for example `player` reads `../mp3/testdata`):

```bat
cd engine-src\output
<tests>\output.test.exe -test.v
cd ..\player
<tests>\player.test.exe
```

The executables are `output`, `session`, `cmd-daemon`, `daemon`, `spclient`, `dealer`, `tracks` and `player`
(`.test.exe`).

They need no network and no Spotify account. They create named pipes, temporary folders and listeners on 127.0.0.1
only. `output.test.exe` holds the Windows pipe tests from Encore patch 6; its WASAPI test plays a moment of silence on
the default audio device, if there is one.

Then check the exe itself: `encore-engine.exe --version` prints the line above, and `encore-engine.exe --help` lists
the options. Neither touches the network.

## GPL

go-librespot is GPL-3.0, and so is `encore-engine.exe`. A release that ships the exe ships its Corresponding Source
with it:

- `gateway/engine-src`: go-librespot at the pinned commit with the Encore patches, `ENCORE_PATCH.md`,
  `ENCORE_PATCH.diff` and upstream's `LICENSE`.
- This folder: the build scripts.
- `sources/` from the build: the C libraries linked into the exe and the vcpkg recipes that built them (mpg123 is
  LGPL-2.1).
- The Go modules are pinned by `go.mod` and `go.sum`. `go mod vendor` in `engine-src` copies them all into the tree
  for a self-contained source bundle.
