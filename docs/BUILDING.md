# Building Encore from source

How to build every part of an Encore release. Installing and using it: see the [guide](GUIDE.md). Paths are from the
repository root. Placeholders are in `<angle brackets>`.

## The app

Needs Linux or macOS with [Theos](https://theos.dev) and the iOS 6.1 SDK (not included).

```sh
cd app
make package FINALPACKAGE=1        # the package lands in app/packages/
```

- Install it like the release deb (Filza, or `dpkg -i` over SSH). Don't use `make install`: it runs `uicache`.
- The package also holds the App Icon add-on, `EncoreIcons.dylib`, from the Theos subproject `app/EncoreIcons/`.
- `EN_ENCORE_LINKS=1` adds the **Open Spotify Links** setting for the unreleased EncoreLinks tweak (off by default).
- `python3 app/tools/make_art.py` (needs NumPy) redraws the icon and launch images in `app/Resources/`.
- The package and bundle id is `com.mbucc9000.encore`. A build with another id installs as a separate app.
- The Encore repo address is `DEFAULT_APP_REPO` in `gateway/src/config.js` (`https://mbucc9000.github.io/slopkit/`).
  Forks change that line or set `ENCORE_APP_REPO`. `tools/release/selftest.py` checks that the docs match it.

## The bridge for Docker

Needs Linux (x86-64 or arm64) with Docker Engine and Docker Compose 2.24 or newer.

```sh
cd gateway
docker compose build                 # encore-gateway:local and encore-engine:local; or: docker compose up -d --build
```

### Prebuilt images

`.github/workflows/docker-images.yml` builds `ghcr.io/mbucc9000/encore-bridge` and `ghcr.io/mbucc9000/encore-engine`
for `linux/amd64` and `linux/arm64` when a release is published as final, or by hand (**Actions > Docker images >
Run workflow**). Jobs: **plan** (`image_plan.py` picks the tags `v<X.Y.Z>`, `<X.Y>`, `latest`), **build** with a
smoke test on each platform, **merge**. `tools/release/docker_smoke.py` runs the same build and smoke test on your
own Docker machine. Publishing: [`tools/release/README.md`](../tools/release/README.md).

## The engine

`gateway/engine-src/` is [go-librespot](https://github.com/devgianlu/go-librespot) at upstream commit `4dbc099` with
Encore's patches 1-8 (`ENCORE_PATCH.md`; `ENCORE_PATCH.diff` is the whole change, for `git apply`). The Docker image
builds the Linux engine. Its tests: `go test ./...` in `gateway/engine-src` on Linux, with the C libraries its
Dockerfile installs.

### Windows engine and FFmpeg

Both build on Linux x86-64 with Docker. The first run builds a build image (needs the network); later runs are offline.

```sh
sh gateway/windows/build-engine/build.sh <version> [<out folder>]    # encore-engine.exe (TESTS=1: also tests)
sh gateway/windows/build-ffmpeg/build.sh [<out folder>]              # ffmpeg.exe (LINUX=1: also a Linux build)
```

`<version>` is `version` in `gateway/src/config.js`. Details: [build-engine](../gateway/windows/build-engine/README.md),
[build-ffmpeg](../gateway/windows/build-ffmpeg/README.md).

## The bridge for Windows

Needs Linux x86-64 with Docker; nothing is built on a Windows PC. It is built only from an **exported** tree:

```sh
python3 tools/release/export.py --out <new folder outside the repository>
sh gateway/windows/build.sh --tree <exported tree> --engine <engine out folder> --ffmpeg <ffmpeg out folder> \
   --out <out folder> [--scan <scan command>] [--dev]
```

The out folder gets `staging/Encore Bridge/` (the program folder), `EncoreBridge-<version>-win64.zip`,
`EncoreBridge-<version>-setup.exe` and a bundle report. `--dev` makes a bundle marked DEV (never released),
`--no-installer` only the zip. Pins: `gateway/windows/bundle/pins.conf`. The launcher's interface to the bridge:
[`gateway/windows/CONTRACT.md`](../gateway/windows/CONTRACT.md).

## Tests

```sh
cd gateway/test && node --test                 # or from the repository root: node --test "gateway/test/*.test.js"
ENCORE_SLOW_TESTS=1 node --test                # also the ten-minute Jam test
cd gateway/windows/launcher && go test ./internal/...      # the tray launcher
```

- Needs Node.js 22 or newer. Some tests need ffmpeg (set `FFMPEG` if it isn't on `PATH`), the end-to-end tests
  Linux or macOS; without them they are skipped. More: [`gateway/test/README.md`](../gateway/test/README.md).
- No test contacts GitHub (the update tests use a local fake). `gateway/windows/launcher/testdata/` has Wine smoke
  tests; they don't replace a test on real Windows.

## Release files

Needs Python 3.8 or newer (and the `cryptography` package to sign), plus the tools above.

```sh
python3 tools/release/release.py --out <new folder> [--final]
```

It exports the tree, builds the assets, scans every file for private data and signs the file list. Nothing is
uploaded. Assets: `Encore-<version>-source.tar.gz`, `Encore-<version>-gpl-source.tar.gz`, `encore-docker-compose.yaml`,
`Encore_<version>_iphoneos-arm.deb`, `EncoreBridge-<version>-win64.zip`, `EncoreBridge-<version>-setup.exe`, and the
signed file list `SHA256SUMS.txt` with `SHA256SUMS.txt.sig`.

Every step and option (and the scan without the maintainer's denylist):
[`tools/release/README.md`](../tools/release/README.md).

## Release signing

Every release is signed with Encore's release key (Ed25519, RFC 8032). The bridge (`gateway/src/updatekeys.js`) and
the tray launcher (`launcher/internal/update/keys.go`) offer an update only when its signature verifies.

Encore's public release key, `encore-release-1` (key id `7eec300915b1339f`, added 2026-10-10):

```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAHXw5r89+nZZF8BVpaXtDWmHjVGXuNjRndPGnJsnyzRg=
-----END PUBLIC KEY-----
```

The raw 32-byte key in base64 (as in `updatekeys.js` and `keys.go`): `HXw5r89+nZZF8BVpaXtDWmHjVGXuNjRndPGnJsnyzRg=`.

For maintainers (details: [`tools/release/README.md`](../tools/release/README.md), "Signing"):

- Make the key once, outside the repository:
  ```sh
  python3 tools/release/signkey.py generate --key <folder outside the repository>/_keys/encore-release-ed25519.key
  ```
- `release.py --final` signs with `--sign-key <path>` or `ENCORE_SIGN_KEY` in `tools/release/release.local.env`.
- The private key never ships and never leaves your PC. Keep one encrypted offline backup: without the key, installed
  bridges can't verify new releases.
- After a rotation or a lost or leaked key, replace the key block and key id here.

## Licenses

Encore is GPL-3.0-or-later ([`LICENSE`](../LICENSE)). go-librespot is GPL-3.0: each release ships its source
(`Encore-<version>-gpl-source.tar.gz`). Everything bundled: [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md).
