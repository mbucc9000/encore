# Building Encore from source

This repository builds everything Encore releases: the iOS app, the Docker bridge (and its ready-made images), the
Windows bridge (engine, tray launcher, zip and installer) and the release files. For installing and using the result,
see the [guide](GUIDE.md).

All paths below are relative to the repository root. Placeholders are in `<angle brackets>`.

## What you need

| Part | Build machine | Tools |
|---|---|---|
| App (`app/`) | Linux or macOS | [Theos](https://theos.dev) with the iOS 6.1 SDK (you supply the SDK; it is not part of this repository). Python 3 with NumPy only to redraw the artwork. |
| Bridge for Docker (`gateway/`) | Linux x86-64 or arm64 (arm64 is built and smoke-tested on GitHub, not yet on a real machine) | Docker Engine with Docker Compose 2.24 or newer; Docker's `buildx` for the prebuilt images' script. Everything else happens inside the images. |
| Bridge for Windows (`gateway/windows/`) | Linux x86-64 | Docker. The engine, the launcher, the zip and the installer are all built in Docker images; nothing is installed on a Windows PC. |
| Bridge tests (`gateway/test/`) | Linux, macOS or Windows | Node.js 22 or newer; ffmpeg for some tests |
| Release files (`tools/release/`) | Linux, macOS or Windows | Python 3.8 or newer (standard library only; signing a release also needs the `cryptography` package), plus the tools of the parts above |

## The app

The app is a Theos project: `iphone:clang:6.1:6.0`, `armv7`, Objective-C with ARC, no third-party libraries.

```sh
cd app
make package FINALPACKAGE=1
```

The package lands in `app/packages/`. Install it like the release deb, with Filza or `dpkg -i` over SSH
([guide: other ways to install the app](GUIDE.md#other-ways-to-install-the-app)). Don't use Theos' `make install`: it runs `uicache` on the
phone.

Build options (pass them to `make`):

| Option | Effect |
|---|---|
| `FINALPACKAGE=1` | The release build: optimised, no debug version suffix |
| `EN_ENCORE_LINKS=1` | Builds the **Open Spotify Links** setting for the EncoreLinks companion tweak, which isn't released yet. Off by default. |

**Artwork.** The icon, the setup screen's icon and the launch images (4-inch and 3.5-inch) in `app/Resources/` are
generated. To redraw them:

```sh
python3 app/tools/make_art.py            # writes into app/Resources/
```

**Package id.** The app's package id and bundle id are `com.mbucc9000.encore` (in `app/control`,
`app/Resources/Info.plist`, `app/entitlements.plist` and the Keychain service). A build with another id installs as a
separate app and doesn't see the original's pairing, settings or caches.

**The Encore repo's address.** The setup guide and the admin page tell users to install the app from one Cydia repo.
Its address is one constant, `DEFAULT_APP_REPO` in `gateway/src/config.js` (`https://mbucc9000.github.io/slopkit/`). A
fork changes that line, or sets `ENCORE_APP_REPO` on its bridge. The docs quote the address too, and
`tools/release/selftest.py` checks that they match the constant.

## The bridge for Docker

`gateway/compose.yaml` builds two images from source:

| Image | Built from | Contents |
|---|---|---|
| `encore-gateway:local` | `gateway/Dockerfile` | `node:22-bookworm-slim`, ffmpeg, tini, qrencode and `gateway/src/` (the bridge has no npm dependencies) |
| `encore-engine:local` | `gateway/engine-src/Dockerfile` (upstream go-librespot's, with Encore patch 8: the version stamp, and the default `config.yml` and first-start script in `encore-docker/`) | go-librespot with Encore's patches, built with Go on Alpine |

```sh
cd gateway
docker compose build                 # or: docker compose up -d --build
```

Setting the bridge up this way is the guide's [Build it yourself](GUIDE.md#build-it-yourself).
`gateway/.dockerignore` keeps everything except `src/` (your `data/`, `.env` and `engine/` too) out of the bridge's
build.

### Prebuilt images

`.github/workflows/docker-images.yml` builds the same two folders into the images users pull,
`ghcr.io/mbucc9000/encore-bridge` and `ghcr.io/mbucc9000/encore-engine`, for `linux/amd64` and `linux/arm64`. It runs
when a release is published as final, and by hand (**Actions → Docker images → Run workflow**, with a tag, and **push**
on or off):

1. **plan** (`.github/scripts/image_plan.py`) checks the tag (`vX.Y.Z`, 1.3.0 or later, equal to `version` in
   `gateway/src/config.js`), that the release is final and has its source archive, GPL bundle and compose file, and
   works out the tags: `v<X.Y.Z>` always, `<X.Y>` when it is the newest release of that minor version, and `latest`
   when it is the newest release. A rebuild of an older tag never moves `<X.Y>` or `latest` back. It also checks that
   the GPL bundle's `engine/` folder is exactly the tag's `gateway/engine-src` (`.github/scripts/check_gpl_bundle.py`).
2. **build** runs on GitHub's own amd64 and arm64 machines (`ubuntu-24.04`, `ubuntu-24.04-arm`).
   `.github/scripts/build-images.sh` builds both images: the bridge with `--build-arg ENCORE_PREBUILT=1` (its admin
   page then offers `docker compose pull` updates), the engine with `--build-arg ENCORE_VERSION=<version>`, both with
   labels that name the version, the commit, and the release's source archive and GPL bundle. Then
   `.github/scripts/smoke-images.sh` checks them and starts them from `docker/compose.yaml`, cut off from the host's
   network (`.github/scripts/compose.smoke.yaml`; the engine still needs to reach Spotify): the bridge must answer `/`
   and `/admin`, the engine `/status`. Only then are they pushed, still without a tag, and only when the build for the
   push came out exactly as the tested one (a base image updated in between stops the run).
3. **merge** works the tags out again (a release published in the meantime keeps its `<X.Y>` and `latest`), tags one
   two-platform image per tag and checks every tag.

The workflow uses only `GITHUB_TOKEN` (`packages: write` only in the jobs that push) and GitHub's own actions, pinned
to commits; the BuildKit image it builds with (`moby/buildkit`) is pinned by digest. Every job builds the commit plan
found for the tag, never a branch of the same name. Provenance attestations are off, so GHCR lists exactly the two
platforms. The maintainer's side (upload every release file before publishing, make the two packages public once,
re-run or rebuild a release's images) is in [`tools/release/README.md`](../tools/release/README.md) "Publishing".

**One platform locally** (Docker with `buildx`, from the repository root; nothing is pushed):

```sh
export ARCH=amd64 VERSION=<version> SMOKE_TAG=local-test
export BRIDGE_IMAGE=ghcr.io/mbucc9000/encore-bridge ENGINE_IMAGE=ghcr.io/mbucc9000/encore-engine
bash .github/scripts/build-images.sh load
sh .github/scripts/smoke-images.sh docker local-test <version> docker/compose.yaml \
  .github/scripts/compose.smoke.yaml gateway/engine/config.yml
```

`<version>` is `version` in `gateway/src/config.js`. Where Docker needs sudo, also export `DOCKER="sudo -n docker"`
and pass `"sudo -n docker"` instead of `docker` to `smoke-images.sh`. The smoke test can run next to a live
Encore Bridge (other container names, no host networking). Remove the two `local-test` images afterwards with
`docker image rm`. `tools/release/docker_smoke.py` runs the same smoke test on an exported tree
([Release files](#release-files)).

## The engine

`gateway/engine-src/` is go-librespot at upstream commit `4dbc099` with Encore's patches 1–8. `ENCORE_PATCH.md` explains
each patch. `ENCORE_PATCH.diff` is the whole change as one diff against that commit:

```sh
git clone https://github.com/devgianlu/go-librespot && cd go-librespot
git checkout 4dbc099
git apply <path to>/gateway/engine-src/ENCORE_PATCH.diff
```

The Docker image builds the Linux engine. To run its tests, run `go test ./...` in `gateway/engine-src` on a Linux
machine with the C libraries the engine's Dockerfile installs (ALSA, libogg, libvorbis, FLAC, mpg123).

### The Windows engine (`encore-engine.exe`)

`gateway/windows/build-engine/` cross-compiles the same source for `windows/amd64` with MinGW-w64 and vcpkg. It follows
upstream's own recipe, with `-trimpath` and an Encore version stamp:

```sh
sh gateway/windows/build-engine/build.sh <version> [<out folder>]
TESTS=1 sh gateway/windows/build-engine/build.sh <version> <out folder>     # also builds the Windows test executables
```

`<version>` is the Encore release, the same as the bridge's (`version` in `gateway/src/config.js`, for example `1.1.0`).
Set `DOCKER="sudo -n docker"` where Docker needs sudo. The first run builds the `encore-engine-winbuild` image (it needs
the network and takes 5 to 20 minutes). Later runs reuse it and work offline. The output folder holds
`encore-engine.exe`, `BUILDINFO.txt` (toolchain, library and module versions, the exe's DLL imports), `licenses/` and
`sources/` (the source archives of the statically linked C libraries and the vcpkg recipes that built them). The build
checks that the exe imports only Windows system DLLs and contains no home-folder paths. Two builds of the same tree give
the same file.

`encore-engine.exe --version` prints one line, for example `encore-engine 1.3.0 (go-librespot dev, Encore patches 1-8)`,
and creates nothing. The bridge reads it and refuses to start an engine of another version.

[`gateway/windows/build-engine/README.md`](../gateway/windows/build-engine/README.md) has the details: what is pinned,
the exact build command, and how to run the Windows tests on a Windows PC.

## FFmpeg for Windows (`ffmpeg.exe`)

The Windows bridge ships its own minimal FFmpeg: FFmpeg's AAC encoder and the picture conversion for covers, nothing
else, linked only with zlib. Its complete source is therefore FFmpeg's release tarball, which every release carries in
its GPL source bundle. Build it on a Linux x86-64 machine with Docker:

```sh
sh gateway/windows/build-ffmpeg/build.sh [<out folder>]
LINUX=1 sh gateway/windows/build-ffmpeg/build.sh <out folder>   # also the same configuration for Linux, for the tests
```

The first run builds the `encore-ffmpeg-winbuild` image. It needs the network for Debian packages and the FFmpeg
tarball, which is checked against its pin and FFmpeg's release signature. The build itself runs offline. The out folder
holds `ffmpeg.exe`, `BUILDINFO.txt` (version, configure line, every component built in, toolchain, DLL imports),
`licenses/` and `sources/` (the tarball). `configure.txt` in that folder is the component list.
[`gateway/windows/build-ffmpeg/README.md`](../gateway/windows/build-ffmpeg/README.md) has the details.

## The bridge for Windows

The Windows package is built from an **exported** source tree (next section), never from a working copy. The bundle
script refuses a tree that still holds development files, and copies only the files listed in
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

It downloads the official Node.js 22 `node.exe`, pinned exactly (version, URL and file) in
`gateway/windows/bundle/pins.conf`. It takes `ffmpeg.exe` from the FFmpeg build above (`--ffmpeg`). `pins.conf` also
pins the FFmpeg release tarball that build must come from, and the script refuses anything else (including a GPL,
version-3 or non-free FFmpeg). The out folder then holds:

| Output | What it is |
|---|---|
| `staging/Encore Bridge/` | The program folder: `Encore Bridge.exe`, `runtime\node.exe`, `gateway\src\`, `engine\encore-engine.exe` and its config template, `ffmpeg\ffmpeg.exe`, `settings.env.template`, `README-Windows.txt`, `licenses\` |
| `EncoreBridge-<version>-win64.zip` | The portable zip of that folder (reproducible: the same inputs give the same file) |
| `EncoreBridge-<version>-setup.exe` | The installer |
| `EncoreBridge-<version>-bundle-report.txt` | What went in, with versions |

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

Some tests need ffmpeg (set `FFMPEG` if it isn't on `PATH`). The two end-to-end tests need Linux or macOS. Without
those, the tests are reported as skipped. [`gateway/test/README.md`](../gateway/test/README.md) lists every file and
how to run the suite inside the bridge's Docker image.

**The tray launcher.** Its platform-independent parts have Go tests that run anywhere:

```sh
cd gateway/windows/launcher && go test ./internal/...
```

`gateway/windows/launcher/testdata/` also has smoke tests that run the launcher and the installer under Wine in the
packaging image. Among them is `update-smoke.sh`, which updates an installed copy to a newer installer served by a
local fake GitHub. They don't replace a test on real Windows: firewall, power management, SmartScreen, the UAC prompt
and the tray menu can't be checked under Wine.

**The update check.** Nothing in the tests contacts GitHub. The bridge's update tests (`gateway/test/update*.test.js`)
and the launcher's (`gateway/windows/launcher/internal/update`) run against a local fake GitHub that serves made-up
releases, signed with the public RFC 8032 test key. Both sides read the same test vectors
(`gateway/test/fixtures/update-vectors.json`). The bridge honours its test-only settings (`UPDATE_API_BASE`,
`UPDATE_DOWNLOAD_BASE`, `UPDATE_TEST_KEYS`) only with loopback addresses. The launcher has its test hooks only when it
is built with the Go build tag `encoreupdatetest`. Release builds contain none of them (`build_windows.py` checks).

**The engine.** See [The engine](#the-engine) above.

## Release files

`tools/release/` turns the repository into release files in a fresh folder: the exported source tree, the source
archive, the Docker compose file, the deb, the Windows package, the GPL source bundle, and the release's signed file
list. Every file goes through a privacy scan, and any finding fails the release. Nothing is uploaded. The Docker images
aren't made here: publishing the release on GitHub starts the workflow above ([Prebuilt images](#prebuilt-images)).

```sh
python3 tools/release/release.py --out <new folder> [--final]
```

| Asset | Made by |
|---|---|
| `Encore-<version>-source.tar.gz` | `export.py` (an explicit allowlist, `tools/release/export-allowlist.txt`) |
| `encore-docker-compose.yaml` | The step **compose** of `release.py`: `docker/compose.yaml` byte for byte. Its name carries no version, so `releases/latest/download/encore-docker-compose.yaml` is always the newest one |
| `Encore_<version>_iphoneos-arm.deb` | `build_deb.py`: `make package FINALPACKAGE=1` from the exported `app/`, on a Theos machine. It ships as a release asset (for Filza or SSH installs); putting it into the Encore repo is a separate publishing step, outside these scripts |
| `EncoreBridge-<version>-win64.zip`, `EncoreBridge-<version>-setup.exe` | `build_windows.py`: runs `gateway/windows/build.sh` (above) from the exported tree, then checks the zip, the installer and the payload |
| `Encore-<version>-gpl-source.tar.gz` | `gpl_bundle.py`: the engine's complete corresponding source (the patched tree, the Windows build scripts and, with `--engine-build`, the C library sources from the Windows engine build) |
| `SHA256SUMS.txt`, `SHA256SUMS.txt.sig` | The release's signed file list (`checksums.py`) and its signature (`sign.py`, the step **sign** of `release.py`; [Release signing](#release-signing)) |

The privacy scan (`scan.py`) reads folders, archives and binaries (with a strings pass in ASCII and UTF-16). It looks
for secrets, state files, home paths, IP and e-mail addresses, and a local denylist. The maintainers' denylist is never
part of the repository. Without it, run `python3 tools/release/scan.py --no-denylist <folder or file>` for the generic
checks. [`tools/release/README.md`](../tools/release/README.md) describes every step and option.

## Release signing

Every release is signed with Encore's release key, an Ed25519 key pair (RFC 8032). The bridge
(`gateway/src/updatekeys.js`) and the Windows tray launcher (`gateway/windows/launcher/internal/update/keys.go`) carry
the public key and check every update against it before they offer it ([guide: Updating](GUIDE.md#12-updating)).

Encore's public release key, `encore-release-1` (key id `7eec300915b1339f`, added 2026-10-10):

```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAHXw5r89+nZZF8BVpaXtDWmHjVGXuNjRndPGnJsnyzRg=
-----END PUBLIC KEY-----
```

As base64 of the raw 32 bytes, the form `updatekeys.js` and `keys.go` hold it in:
`HXw5r89+nZZF8BVpaXtDWmHjVGXuNjRndPGnJsnyzRg=`.

For maintainers:

- **Make the key once,** on your own computer and outside the repository:

  ```sh
  python3 tools/release/signkey.py generate --key <folder outside the repository>/_keys/encore-release-ed25519.key
  ```

  It writes the private key (PKCS#8 PEM, readable by its owner only; it never overwrites a file) and
  `encore-release-ed25519.pub` next to it. It prints only the public key and its key id. It refuses a path inside the
  working copy. It makes the `_keys` folder owner-only before it writes the key. On Windows it refuses any other folder
  that isn't owner-only already (a new file there would first get the folder's access rules).
  `python3 tools/release/signkey.py public --pub <path to the .pub>` prints the public information again.
- **Signing:** `release.py --final` needs the key, from `--sign-key <path>` or `ENCORE_SIGN_KEY` in
  `tools/release/release.local.env` (a local file that is never exported; `release.example.env` shows the line). A
  trial run (without `--final`) never picks up `ENCORE_SIGN_KEY` by itself. It signs only with a key passed as
  `--sign-key` (a throwaway one, to rehearse; a key the embedded lists hold is refused there). Without one it warns and
  makes no `.sig`. `sign.py` refuses the RFC 8032 test keys, and for a release a key whose public half isn't in both
  embedded lists.
- **The private key never ships:** not in the repository, a release, a backup share or a message. The export never
  copies a `_keys` folder. The privacy scan fails on private-key material (PEM, PKCS#8 in base64 or DER, also inside
  archives and binaries) and, with `--sign-key`, on the key's own seed in any common encoding.
- **Keep an encrypted offline backup** of the key ([tools/release/README.md](../tools/release/README.md) says how, and
  how to restore it). If the key is lost, installed bridges can't verify new releases. Users then have to install the
  next release (signed with a new key) by hand once.
- **Rotation:** make a second key (`encore-release-ed25519-2.key`, so its list entry is `encore-release-2`). Embed both
  public keys (at most three) in `updatekeys.js` and `keys.go` in a release that is still signed with the old key. Sign
  a later release with the new key, and drop the old key one release after that. From the first release signed with
  the new key, the key block and key id here show the new key (the selftest checks the key blocks in the docs against
  the embedded list).
- **If the key is lost:** make `encore-release-ed25519-2.key` and embed it. Replace the key block and key id here. Add
  a dated "Release key replaced" note to the README and the release notes that names the new key id and the versions
  that need the one-time install by hand.
- **If the private key leaks:** there is no remote revocation. Ship a release signed with the old key that embeds only
  a new key. Say so in its release notes and in the README, and change the GitHub account's credentials.
- **Forks** change the repository constant (`UPDATE_REPO` in `gateway/src/update.js`, `Repo` in
  `gateway/windows/launcher/internal/update/github.go`) and the embedded keys together, and sign with their own key.

## Licenses

Encore's own code is GPL-3.0-or-later ([`LICENSE`](../LICENSE)). go-librespot is GPL-3.0, so every release that contains
an engine binary ships its corresponding source (`Encore-<version>-gpl-source.tar.gz`). The licenses of everything Encore
bundles or builds are listed in [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md).
