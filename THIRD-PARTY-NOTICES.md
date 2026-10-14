# Third-party notices

Encore's own code (the iOS app, the Encore Bridge, the Windows tray launcher, the build and packaging scripts, and
Encore's changes to go-librespot) is licensed under the **GNU General Public License, version 3 or any later version**
(GPL-3.0-or-later). The full text is in [`LICENSE`](LICENSE).

Encore also uses, bundles or builds the third-party components below. Each stays under its own license.

- **Source tree:** contains only Encore's code, go-librespot's source (with its `LICENSE`) and the optional app icons'
  images. Other dependencies are downloaded when you build.
- **App package (`.deb`):** contains Encore's code and artwork, plus the optional app icons
  ([The iOS app](#the-ios-app)). It links Apple's system frameworks on the device.
- **Docker images (prebuilt, or built by you):** Encore distributes two images for each release,
  `ghcr.io/mbucc9000/encore-bridge` and `ghcr.io/mbucc9000/encore-engine`, built from that release's source; you can
  also build them yourself from the source tree. Besides Encore's code and the engine, they contain unmodified Debian 12
  and Alpine 3.23 packages ([Docker images](#docker-images-prebuilt-or-built-by-you)).
- **Windows package (installer and zip):** redistributes binaries. It ships a `licenses` folder with the complete
  license text of every component listed under [Windows package](#windows-package).

The lists below match the 1.1.0 builds: the Go modules from `go version -m` on the Windows engine and `go.mod` of the
tray launcher, and the C libraries from the Windows engine build's `BUILDINFO.txt`.

<!-- R4: re-check both lists against the final release builds (BUILDINFO.txt of the engine build, MODULES.txt in the
     launcher's licenses folder) and update the versions if they changed. -->

---

## go-librespot (the engine)

| | |
|---|---|
| Project | go-librespot, <https://github.com/devgianlu/go-librespot> |
| Authors | devgianlu and the go-librespot contributors |
| License | **GPL-3.0** (`gateway/engine-src/LICENSE`, unchanged) |
| Version | Upstream commit `4dbc099`, modified by Encore |
| Changes | Encore patches 1–8, described in `gateway/engine-src/ENCORE_PATCH.md`, complete in `gateway/engine-src/ENCORE_PATCH.diff` |

**Corresponding source.** Every Encore release that contains an engine binary (the Windows package and the
`encore-engine` Docker image) comes with the complete corresponding source for that exact build: the engine source at
the pinned commit with Encore's patches, `ENCORE_PATCH.md` and `ENCORE_PATCH.diff`, the Windows build scripts, and the
vcpkg baseline and triplet, and the source archives of the C libraries linked into the Windows engine. It is published as a
separate download next to each release, `Encore-<version>-gpl-source.tar.gz`, and the engine source and build scripts
are also in this repository under `gateway/engine-src/` and `gateway/windows/build-engine/`.

### Go modules linked into the engine

The modules in the 1.1.0 Windows engine (`go version -m encore-engine.exe`); the Docker engine is built from the same
`go.mod`. Modules listed in `go.mod` only for tests or code generation are not part of the binary and are listed after
the table.

| Module | License |
|---|---|
| github.com/apapsch/go-jsonmerge/v2 | MIT |
| github.com/cenkalti/backoff, github.com/cenkalti/backoff/v4 | MIT |
| github.com/coder/websocket | ISC |
| github.com/devgianlu/shannon | MIT |
| github.com/fsnotify/fsnotify | BSD-3-Clause |
| github.com/go-viper/mapstructure/v2 | MIT |
| github.com/godbus/dbus/v5 | BSD-2-Clause |
| github.com/gofrs/flock | BSD-3-Clause |
| github.com/google/uuid | BSD-3-Clause |
| github.com/grandcat/zeroconf | MIT |
| github.com/hashicorp/golang-lru/v2 | MPL-2.0 (used unmodified) |
| github.com/jfreymuth/pulse | MIT |
| github.com/knadh/koanf/v2 and its maps, YAML parser and confmap, file and posflag providers | MIT |
| github.com/miekg/dns | BSD-3-Clause |
| github.com/mitchellh/copystructure, github.com/mitchellh/reflectwalk | MIT |
| github.com/oapi-codegen/runtime | Apache-2.0 |
| github.com/rs/cors | MIT |
| github.com/sirupsen/logrus | MIT |
| github.com/spf13/pflag | BSD-3-Clause |
| github.com/xlab/vorbis-go | No license file published upstream (cgo bindings to libvorbis); see the note below |
| go.yaml.in/yaml/v3 | MIT and Apache-2.0 |
| golang.org/x/crypto, x/exp, x/net, x/oauth2, x/sys | BSD-3-Clause |
| google.golang.org/protobuf | BSD-3-Clause |
| The Go standard library and runtime | BSD-3-Clause |

Not linked into the engine: golang.org/x/mod, x/sync and x/tools, gopkg.in/yaml.v3 (BSD-3-Clause; MIT and Apache-2.0),
and the test-only github.com/stretchr/testify and stretchr/objx (MIT), go.uber.org/goleak (MIT),
github.com/davecgh/go-spew (ISC), github.com/pmezard/go-difflib and github.com/rogpeppe/go-internal (BSD-3-Clause).

**About github.com/xlab/vorbis-go.** Upstream publishes no license file for it. It is a thin cgo binding to libvorbis
that go-librespot has always used, and Encore includes it unmodified, as go-librespot does.

<!-- R6: the GPL check must settle vorbis-go's license (ask upstream or the go-librespot maintainer) before any
     engine binary is published (R7). -->

### C libraries linked into the engine

| Library | License | Where |
|---|---|---|
| libogg 1.3.6 (Xiph.Org) | BSD-3-Clause | Docker image (Alpine package) and Windows (static) |
| libvorbis 1.3.7 (Xiph.Org) | BSD-3-Clause | Docker image (Alpine package) and Windows (static) |
| libFLAC 1.5.0 (Xiph.Org) | BSD-3-Clause | Docker image (Alpine package) and Windows (static) |
| mpg123 1.32.9 (libmpg123) | LGPL-2.1 | Docker image (Alpine package) and Windows (static) |
| alsa-lib | LGPL-2.1 | Docker image only |
| MinGW-w64 runtime 12, GCC 14 runtime (libgcc, winpthreads) | MinGW-w64 runtime licenses; GPL-3.0 with the GCC Runtime Library Exception | Windows only (static) |

The Windows engine (`encore-engine.exe`) is statically linked and imports only Windows system DLLs (KERNEL32, msvcrt,
ADVAPI32, SHLWAPI). The versions on Windows are the ones in the build's `BUILDINFO.txt`. Because mpg123 (LGPL-2.1) is
linked statically, the corresponding-source bundle ships everything needed to relink the engine with a modified
mpg123: the complete engine source, the build scripts, and the source archives and vcpkg recipes of every linked
library.

---

## Docker images (prebuilt, or built by you)

For every release, GitHub Actions builds two images from that release's tagged source
(`.github/workflows/docker-images.yml`) and publishes them: `ghcr.io/mbucc9000/encore-bridge` from `gateway/Dockerfile`,
and `ghcr.io/mbucc9000/encore-engine` from `gateway/engine-src/`, which is exactly the `engine/` folder of that
release's GPL source bundle. Building them yourself from the source tree (`gateway/compose.yaml`) gives the same
contents.

| Component | License | Notes |
|---|---|---|
| `node:22-bookworm-slim` base image: Node.js 22 and Debian 12 packages | Node.js: MIT (plus the licenses of its bundled parts); Debian packages: their own licenses | The bridge image |
| FFmpeg (Debian package `ffmpeg`) | Debian's build is GPL-2.0-or-later (it enables GPL parts) | Runs as a separate program for AAC encoding and cover resizing |
| tini | MIT | Init process in the bridge container |
| qrencode / libqrencode | LGPL-2.1-or-later | Jam QR codes on Docker |
| `alpine:3.23` base image and Alpine packages (musl, libgcc, gcompat, avahi libraries, libpulse, alsa-lib, libogg, libvorbis, flac, mpg123) | musl: MIT; libgcc: GPL-3.0 with the GCC Runtime Library Exception; gcompat: NCSA; avahi and libpulse: LGPL-2.1-or-later; the rest as listed above | The engine image |

**The distribution packages.** The images contain unmodified packages from Debian 12 ("bookworm", the bridge image) and
Alpine Linux 3.23 (the engine image). Each image lists every one of them with its exact version in
`/usr/share/encore/packages.txt`:

```sh
docker run --rm --entrypoint cat ghcr.io/mbucc9000/encore-bridge:<tag> /usr/share/encore/packages.txt
docker run --rm --entrypoint cat ghcr.io/mbucc9000/encore-engine:<tag> /usr/share/encore/packages.txt
```

Their source code, that of the GPL and LGPL packages included (Debian's FFmpeg, qrencode, avahi, libpulse, alsa-lib,
mpg123 and others), is published by the distributions: Debian at <https://sources.debian.org>, and every version it ever
shipped at <https://snapshot.debian.org>; Alpine as its package recipes in <https://gitlab.alpinelinux.org/alpine/aports>
(the `3.23-stable` branch), with the source archives each recipe names.

**The engine's corresponding source** is the release's GPL source bundle, `Encore-<version>-gpl-source.tar.gz`. Each
image names it in its label `io.github.mbucc9000.encore.gpl-source`, and the release's full source archive in
`io.github.mbucc9000.encore.source-archive`.

---

## Windows package

Everything below ships inside the installer and the zip. The `licenses` folder next to `Encore Bridge.exe` holds the
license texts: `Encore\` (Encore's GPL), `go-librespot\` (its GPL, `ENCORE_PATCH.md`, where to get the source, and in
`third_party\` the licenses of the statically linked libraries and runtimes), `node\`, `ffmpeg\` (its LGPL, zlib's
and the MinGW-w64/GCC runtimes' licenses, how it was built and where its source is) and `launcher\` (Go's license and
those of the tray launcher's modules).

| Component | License | Notes |
|---|---|---|
| Encore Bridge (`gateway\src`), the tray launcher (`Encore Bridge.exe`), the installer script | GPL-3.0-or-later | Encore's own code |
| go-librespot (`engine\encore-engine.exe`) | GPL-3.0 | See [go-librespot](#go-librespot-the-engine) above, including its Go modules and static C libraries |
| Node.js 22 LTS (`runtime\node.exe`, the official signed build) | MIT, plus the licenses of the parts it bundles (V8, libuv, OpenSSL, ICU and others), all in Node's own `LICENSE` file | Unmodified |
| FFmpeg 8.1.3 (`ffmpeg\ffmpeg.exe`, Encore's own minimal build: FFmpeg's AAC encoder and picture conversion only, `gateway/windows/build-ffmpeg/`) | LGPL-2.1-or-later (no GPL, version-3 or non-free parts; the build and the bundle script both refuse them) | Built from FFmpeg's unmodified release tarball and run as a separate program. Its complete source, that tarball, is in `Encore-<version>-gpl-source.tar.gz` (`windows-ffmpeg-build/sources/`) with the build recipe (`windows/build-ffmpeg/`); `licenses\ffmpeg\` holds its license, the configure line and every component built in. |
| zlib (inside `ffmpeg\ffmpeg.exe`, for PNG pictures) | zlib License | Statically linked; `licenses\ffmpeg\zlib.txt` |
| MinGW-w64 runtime and GCC's libgcc (inside `ffmpeg\ffmpeg.exe` and `engine\encore-engine.exe`) | MinGW-w64's runtime licenses (ZPL, MIT, public domain); GPL-3.0 with the GCC Runtime Library Exception | Statically linked; their copyright files are next to each program's licenses |
| fyne.io/systray 1.12 (the tray icon and menu) | Apache-2.0 | Linked into `Encore Bridge.exe` |
| golang.org/x/sys, the Go standard library and runtime | BSD-3-Clause | Linked into `Encore Bridge.exe` |
| QR code encoder (`gateway\src\qr.js`, Jam QR codes on Windows) | MIT | Encore's own JavaScript, following Project Nayuki's QR Code generator library; the MIT notice is in the file's header |
| Inno Setup (the installer's runtime) | Inno Setup License | Installer only |



---

## The iOS app

The app contains Encore's code and artwork, plus the optional app icons below. Its own icon and launch images are
original, generated by `app/tools/make_art.py`. It links Apple's system frameworks, which stay on the device and are not
part of the package.

**Optional app icons** (Settings → Appearance → App Icon, shown on the home screen by Encore's SpringBoard add-on,
`app/EncoreIcons/`, which links MobileSubstrate; MobileSubstrate is installed separately and not part of the package):
`app/Resources/AppIcons/`, resized by `app/tools/make_icons.py` from the five images in `app/tools/appicons-src/`.
Spotify and its logos are trademarks of Spotify AB; the optional app icons are included as provided.

Build tools, not shipped: Theos (the build system), Apple's iOS 6.1 SDK (not redistributed), Python and NumPy
(BSD-3-Clause) for `make_art.py` and `make_icons.py`.

---

## Services and data

These are not software Encore ships, but Encore talks to them:

- **Spotify.** Encore uses your own Spotify developer app under Spotify's Developer Terms, and private Spotify interfaces
  as described in the guide's [Legal and disclaimer](docs/GUIDE.md#18-legal-and-disclaimer). "Spotify" is a trademark
  of Spotify AB. Encore is not affiliated with Spotify.
- **LRCLIB** (<https://lrclib.net>): synced lyrics from a community database, used under LRCLIB's terms. Lyrics remain
  the property of their rights holders; Encore only displays them and never stores them as files.

---

## Thanks

Encore would not exist without go-librespot and the librespot community's years of protocol research. Thank you.
