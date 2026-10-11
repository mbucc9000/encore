# Building Encore from source

Everything Encore releases can be built from this repository: the iOS app, the Docker bridge, the Windows bridge (engine,
tray launcher, zip and installer) and the release files. This page lists what each part needs and the commands that
build it. The [guide](GUIDE.md) covers installing and using the result.

All paths below are relative to the repository root. Placeholders are in `<angle brackets>`.

## What you need

| Part | Build machine | Tools |
|---|---|---|
| App (`app/`) | Linux or macOS | [Theos](https://theos.dev) with the iOS 6.1 SDK (you supply the SDK; it is not part of this repository). Python 3 with NumPy only to redraw the artwork. |
| Bridge for Docker (`gateway/`) | Linux x86-64 (arm64 should work, untested) | Docker Engine with Docker Compose. Everything else happens inside the images. |
| Bridge for Windows (`gateway/windows/`) | Linux x86-64 | Docker. The engine, the launcher, the zip and the installer are all built in Docker images; nothing is installed on a Windows PC. |
| Bridge tests (`gateway/test/`) | Linux, macOS or Windows | Node.js 22 or newer; ffmpeg for some tests |
| Release files (`tools/release/`) | Linux, macOS or Windows | Python 3.8 or newer (standard library only; signing the checksums also needs the `cryptography` package), plus the tools of the parts above |

## The app

The app is a Theos project: `iphone:clang:6.1:6.0`, `armv7`, Objective-C with ARC, no third-party libraries.

```sh
cd app
make package FINALPACKAGE=1
```

The package lands in `app/packages/`. Install it on a phone like the release deb, with Filza or `dpkg -i` over SSH
([guide, 9.3](GUIDE.md#93-other-ways-to-install-the-app)). Use the package rather than Theos' `make install`, which
runs `uicache` on the phone.

Build options (pass them to `make`):

| Option | Effect |
|---|---|
| `FINALPACKAGE=1` | The release build: optimised, no debug version suffix |
| `EN_ENCORE_LINKS=1` | Builds the **Open Spotify Links** setting for the EncoreLinks companion tweak, which isn't released yet. Off by default. |

**Artwork.** The icon, the setup screen's icon and the launch images (4-inch and 3.5-inch) in `app/Resources/` are
generated, not drawn by hand. To redraw them:

```sh
python3 app/tools/make_art.py            # writes into app/Resources/
```

**Package id.** The app's package id and bundle id are `com.mbucc9000.encore` (in `app/control`,
`app/Resources/Info.plist`, `app/entitlements.plist` and the Keychain service). A build with another id installs as a
separate app and doesn't see the original one's pairing, settings or caches.

**The Encore repo's address.** The Cydia repo that the setup guide and the admin page tell users to install the app
from is one constant, `DEFAULT_APP_REPO` in `gateway/src/config.js` (`https://mbucc9000.github.io/slopkit/`). A fork
changes that line, or sets `ENCORE_APP_REPO` on its bridge. The docs quote the address too, and
`tools/release/selftest.py` checks that they match the constant.

## The bridge for Docker

`gateway/compose.yaml` builds two images from source:

| Image | Built from | Contents |
|---|---|---|
| `encore-gateway:local` | `gateway/Dockerfile` | `node:22-bookworm-slim`, ffmpeg, tini, qrencode and `gateway/src/` (the bridge has no npm dependencies) |
| `encore-engine:local` | `gateway/engine-src/Dockerfile` (upstream go-librespot's own) | go-librespot with Encore's patches, built with Go on Alpine |

```sh
cd gateway
docker compose build                 # or: docker compose up -d --build
```

Setting the bridge up is [chapter 4 of the guide](GUIDE.md#4-install-the-encore-bridge-with-docker-linux).

## The engine

`gateway/engine-src/` is go-librespot at upstream commit `4dbc099` with Encore's patches 1–6. `ENCORE_PATCH.md` explains
each patch, and `ENCORE_PATCH.diff` is the whole change as one diff against that commit:

```sh
git clone https://github.com/devgianlu/go-librespot && cd go-librespot
git checkout 4dbc099
git apply <path to>/gateway/engine-src/ENCORE_PATCH.diff
```

The Docker image builds the Linux engine. Its tests run with `go test ./...` in `gateway/engine-src` on a Linux machine
that has the C libraries the engine's Dockerfile installs (ALSA, libogg, libvorbis, FLAC, mpg123).

### The Windows engine (`encore-engine.exe`)

`gateway/windows/build-engine/` cross-compiles the same source for `windows/amd64` with MinGW-w64 and vcpkg, following
upstream's own recipe, with `-trimpath` and an Encore version stamp:

```sh
sh gateway/windows/build-engine/build.sh <version> [<out folder>]
TESTS=1 sh gateway/windows/build-engine/build.sh <version> <out folder>     # also builds the Windows test executables
```

`<version>` is the Encore release, the same as the bridge's (`version` in `gateway/src/config.js`, for example
`1.1.0`). Set `DOCKER="sudo -n docker"` where Docker needs sudo. The first run builds the `encore-engine-winbuild` image
(it needs the network and takes 5 to 20 minutes); later runs reuse it and work offline. The output folder holds
`encore-engine.exe`, `SHA256SUMS`, `BUILDINFO.txt` (toolchain, library and module versions, the exe's DLL imports),
`licenses/` and `sources/` (the source archives of the statically linked C libraries and the vcpkg recipes that built
them). The build checks that the exe imports only Windows system DLLs and contains no home-folder paths, and two
builds of the same tree give the same file.

`encore-engine.exe --version` prints one line, for example `encore-engine 1.1.0 (go-librespot dev, Encore patches 1-6)`,
and creates nothing. The bridge reads it and refuses to start an engine of another version.

[`gateway/windows/build-engine/README.md`](../gateway/windows/build-engine/README.md) has the details: what is pinned,
the exact build command, and how to run the Windows tests on a Windows PC.

## FFmpeg for Windows (`ffmpeg.exe`)

The Windows bridge ships its own minimal FFmpeg: FFmpeg's AAC encoder and the picture conversion for covers, nothing
else, linked only with zlib. Its complete source is therefore FFmpeg's release tarball, which every release carries in
its GPL source bundle. It is built on a Linux x86-64 machine with Docker:

```sh
sh gateway/windows/build-ffmpeg/build.sh [<out folder>]
LINUX=1 sh gateway/windows/build-ffmpeg/build.sh <out folder>   # also the same configuration for Linux, for the tests
```

The first run builds the `encore-ffmpeg-winbuild` image (network needed: Debian packages, and the FFmpeg tarball, which
is checked against its pinned SHA-256 and FFmpeg's release signature); the build itself runs offline. The out folder
holds `ffmpeg.exe`, `SHA256SUMS`, `BUILDINFO.txt` (version, configure line, every component built in, toolchain, DLL
imports), `licenses/` and `sources/` (the tarball). `configure.txt` in that folder is the component list, and
[`gateway/windows/build-ffmpeg/README.md`](../gateway/windows/build-ffmpeg/README.md) has the details.

## The bridge for Windows

The Windows package is assembled from an **exported** source tree (next section), never from a working copy: the
bundle script refuses a tree that still holds development files, and copies only the files listed in
`gateway/windows/bundle/allowlist.txt`.

```sh
python3 tools/release/export.py --out <new folder outside the repository>
sh gateway/windows/build.sh --tree <exported tree> --engine <engine out folder> --ffmpeg <ffmpeg out folder> \
   --out <out folder> [--scan <scan command>] [--dev]
```

`build.sh` uses two build images, made the first time from `gateway/windows/docker/`:

| Image | Holds | Builds |
|---|---|---|
| `encore-winbuild-launcher:1` | Go 1.25 cross-compiler, go-winres | `Encore Bridge.exe`, the tray launcher (`gateway/windows/launcher/`), with its icon, version resource and the licenses of what is linked into it |
| `encore-winbuild-package:1` | Debian, Wine, Inno Setup 6.7, zip tools, Python | The staging folder, the portable zip and the installer (`gateway/windows/installer/EncoreBridge.iss`) |

It downloads the official Node.js 22 `node.exe`, pinned by version, URL and SHA-256 in
`gateway/windows/bundle/pins.conf`, and takes `ffmpeg.exe` from the FFmpeg build above (`--ffmpeg`). `pins.conf` also
pins the FFmpeg release tarball that build must come from, and the script refuses anything else (including a GPL,
version-3 or non-free FFmpeg). The out folder then holds:

| Output | What it is |
|---|---|
| `staging/Encore Bridge/` | The program folder: `Encore Bridge.exe`, `runtime\node.exe`, `gateway\src\`, `engine\encore-engine.exe` and its config template, `ffmpeg\ffmpeg.exe`, `settings.env.template`, `README-Windows.txt`, `licenses\` |
| `EncoreBridge-<version>-win64.zip` | The portable zip of that folder (reproducible: the same inputs give the same file) |
| `EncoreBridge-<version>-setup.exe` | The installer |
| `EncoreBridge-<version>-bundle-report.txt` | What went in, with versions and checksums |

`--dev` makes a development bundle: missing pieces become warnings, and every output is marked DEV. A DEV bundle is
never released. `--no-installer` makes the zip only.

The interface between the launcher and the bridge (how node is started, the stdin `quit` line, exit codes, the
`settings.env` format, the loopback status routes) is fixed in
[`gateway/windows/CONTRACT.md`](../gateway/windows/CONTRACT.md).

## Tests

**The bridge.** Node's built-in test runner, no npm packages, no network, made-up data only:

```sh
cd gateway/test && node --test                  # or, from the repository root:
node --test "gateway/test/*.test.js"
ENCORE_SLOW_TESTS=1 node --test                 # also the ten-minute end-to-end Jam test
```

Some tests need ffmpeg (set `FFMPEG` if it isn't on `PATH`), and the two end-to-end tests need Linux or macOS; without
them those tests are reported as skipped. [`gateway/test/README.md`](../gateway/test/README.md) lists every file and how
to run the suite inside the bridge's Docker image.

**The tray launcher.** Its platform-independent parts have Go tests that run anywhere:

```sh
cd gateway/windows/launcher && go test ./internal/...
```

`gateway/windows/launcher/testdata/` also has smoke tests that run the launcher and the installer under Wine in the
packaging image, among them `update-smoke.sh`, which updates an installed copy to a newer installer served by a local
fake GitHub. They don't replace a test on real Windows (firewall, power management, SmartScreen, the UAC prompt and the
tray menu can't be checked under Wine).

**The update check.** Nothing in the tests contacts GitHub. The bridge's update tests (`gateway/test/update*.test.js`)
and the launcher's (`gateway/windows/launcher/internal/update`) run against a local fake GitHub that serves made-up
releases, signed with the public RFC 8032 test key; both sides read the same test vectors
(`gateway/test/fixtures/update-vectors.json`). The bridge honours its test-only settings (`UPDATE_API_BASE`,
`UPDATE_DOWNLOAD_BASE`, `UPDATE_TEST_KEYS`) only with loopback addresses, and the launcher has its test hooks only when
it is built with the Go build tag `encoreupdatetest`; release builds contain none of them (`build_windows.py` checks).

**The engine.** See [The engine](#the-engine) above.

## Release files

`tools/release/` turns the repository into release files in a fresh folder: the exported source tree, the source
archive, the deb, the Windows package, the GPL source bundle, `SHA256SUMS.txt` and its signature. Every file goes
through a privacy scan, and any finding fails the release. Nothing is uploaded.

```sh
python3 tools/release/release.py --out <new folder> [--final]
```

| Asset | Made by |
|---|---|
| `Encore-<version>-source.tar.gz` | `export.py` (an explicit allowlist, `tools/release/export-allowlist.txt`) |
| `Encore_<version>_iphoneos-arm.deb` | `build_deb.py`: `make package FINALPACKAGE=1` from the exported `app/`, on a Theos machine. It ships as a release asset (for Filza or SSH installs); putting it into the Encore repo is a separate publishing step, outside these scripts |
| `EncoreBridge-<version>-win64.zip`, `EncoreBridge-<version>-setup.exe` | `build_windows.py`: runs `gateway/windows/build.sh` (above) from the exported tree, then checks the zip, the installer and the payload |
| `Encore-<version>-gpl-source.tar.gz` | `gpl_bundle.py`: the engine's complete corresponding source (the patched tree, the Windows build scripts and, with `--engine-build`, the C library sources from the Windows engine build) |
| `SHA256SUMS.txt` | `checksums.py` |
| `SHA256SUMS.txt.sig` | `sign.py` (the step **sign** of `release.py`): the Ed25519 signature over `SHA256SUMS.txt` ([Release signing](#release-signing)) |

The privacy scan (`scan.py`) reads folders, archives and binaries (with a strings pass in ASCII and UTF-16) and looks
for secrets, state files, home paths, IP and e-mail addresses, and a local denylist. The maintainers' denylist is never
part of the repository; without it, run `python3 tools/release/scan.py --no-denylist <folder or file>` for the generic
checks. [`tools/release/README.md`](../tools/release/README.md) describes every step and option.

## Release signing

Every release's `SHA256SUMS.txt` is signed with Encore's release key, an Ed25519 key pair. `SHA256SUMS.txt.sig` is the
raw 64-byte Ed25519 signature (RFC 8032, no prehash, no context) over the exact bytes of `SHA256SUMS.txt`. The bridge
(`gateway/src/updatekeys.js`) and the Windows tray launcher (`gateway/windows/launcher/internal/update/keys.go`) carry
the public key and check every update against it before they offer it ([guide, chapter 18](GUIDE.md#18-updating)).

Encore's public release key, `encore-release-1` (key id `7eec300915b1339f`, added 2026-10-10):

```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAHXw5r89+nZZF8BVpaXtDWmHjVGXuNjRndPGnJsnyzRg=
-----END PUBLIC KEY-----
```

As base64 of the raw 32 bytes, the form `updatekeys.js` and `keys.go` hold it in:
`HXw5r89+nZZF8BVpaXtDWmHjVGXuNjRndPGnJsnyzRg=`.

The key id is the first 16 hex digits of the SHA-256 of the raw 32-byte public key. Anyone can check a release with
the `openssl` command in the [README](../README.md#checking-a-download).

For maintainers:

- **Make the key once,** on your own computer and outside the repository:

  ```sh
  python3 tools/release/signkey.py generate --key <folder outside the repository>/_keys/encore-release-ed25519.key
  ```

  It writes the private key (PKCS#8 PEM; it never overwrites a file, and makes the file readable by its owner only) and
  `encore-release-ed25519.pub` next to it, and prints only the public key and its key id. It refuses a path inside the
  working copy. It makes the `_keys` folder owner-only before it writes the key; on Windows it refuses any other folder
  that isn't owner-only already (a new file there would first get the folder's access rules). `python3 tools/release/signkey.py public --pub <path to the .pub>` prints the public information again.
- **Signing:** `release.py --final` needs the key, from `--sign-key <path>` or `ENCORE_SIGN_KEY` in
  `tools/release/release.local.env` (a local file that is never exported; `release.example.env` shows the line). A
  trial run (without `--final`) never picks up `ENCORE_SIGN_KEY` by itself: it signs only with a key passed as
  `--sign-key` (a throwaway one, to rehearse; a key the embedded lists hold is refused there), and without one it warns
  and makes no `.sig`. `sign.py` refuses the RFC 8032 test keys, and for a release a key whose public half isn't in
  both embedded lists.
- **The private key never ships:** it never goes into the repository, a release, a backup share or a message. The export
  never copies a `_keys` folder, and the privacy scan fails on private-key material (PEM, PKCS#8 in base64 or DER, also
  inside archives and binaries) and, with `--sign-key`, on the key's own seed in any common encoding.
- **Keep an offline backup** of the key, encrypted ([tools/release/README.md](../tools/release/README.md) says how,
  and how to restore it). If it is lost, installed bridges can't verify new releases: users then have to install the
  next release (signed with a new key) by hand once.
- **Rotation:** make a second key (`encore-release-ed25519-2.key`, so its list entry is `encore-release-2`), embed both
  public keys (at most three) in `updatekeys.js` and `keys.go` in a release that is still signed with the old key, sign
  a later release with the new key, and drop the old key one release after that. From the first release signed with
  the new key, the key block and key id here, in the README's and in the guide's "Checking a download" show the new
  key (the selftest checks that every key block there is in the embedded list).
- **If the key is lost:** make `encore-release-ed25519-2.key` and embed it, replace the key block and key id here, in
  the README and in the guide, and add a dated "Release key replaced" note to the README and the release notes that
  names the new key id and the versions that need the one-time install by hand.
- **If the private key leaks:** there is no remote revocation. Ship a release signed with the old key that embeds only
  a new key, say so in its release notes and in the README, and change the GitHub account's credentials.
- **Forks** change the repository constant (`UPDATE_REPO` in `gateway/src/update.js`, `Repo` in
  `gateway/windows/launcher/internal/update/github.go`) and the embedded keys together, and sign with their own key.

## Licenses

Encore's own code is GPL-3.0-or-later ([`LICENSE`](../LICENSE)). go-librespot is GPL-3.0, so every release that contains
an engine binary ships its corresponding source (`Encore-<version>-gpl-source.tar.gz`). The licenses of everything Encore
bundles or builds are listed in [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md).
