# Release tools

These scripts turn the Encore working copy into release files in a fresh folder: the public source tree, the iOS
deb, the Windows bridge (through its own bundle script), the GPL source bundle, the checksums and their Ed25519
signature. Every file they make goes through a privacy scan, and any finding fails the release. Nothing here publishes
or uploads anything.

The bridge doesn't host the app: phones add **the Encore repo** in Cydia and install Encore from it (the setup guide's
step 6). The deb is a release asset (for Filza/SSH installs, and for the owner to put into the Encore repo, a separate
publish step of the owner's). No bridge package carries it: not the Windows installer or zip, not the Docker image,
not the source archive.

Python 3.8 or newer, standard library only, except for signing: `signkey.py`, `sign.py` and `checksums.py --pubkey`
need Python's [`cryptography`](https://pypi.org/project/cryptography/) package (the tools never install anything).
Windows, Linux and macOS.

## One command

```sh
python tools/release/release.py --out ../encore-release-1.1.0            # a trial run: unfinished parts are warnings
python tools/release/release.py --out ../encore-release-1.1.0 --final \
    --windows-engine <engine build> --engine-build <engine build> --windows-ffmpeg <ffmpeg build> \
    --go-vendor <engine vendor>/vendor --launcher-vendor <launcher vendor>/vendor --docker
                                                                         # a release candidate: everything must pass,
                                                                         # signed with ENCORE_SIGN_KEY (see "Signing")
```

`<engine build>` is the output folder of `gateway/windows/build-engine/build.sh <version>` and `<ffmpeg build>` that of
`gateway/windows/build-ffmpeg/build.sh` (see "The Windows step"). With `--final`, `--engine-build` (with its
`BUILDINFO.txt` and `sources/`), `--go-vendor` and `--windows-ffmpeg` (with its `sources/`) are required: the GPL
bundle must hold the source of every C library and Go module linked into `encore-engine.exe`, and of `ffmpeg.exe`. The vendor folders come
from `go mod vendor -o <dir>/vendor` in `gateway/engine-src` and in
`gateway/windows/launcher`; put the Go toolchain's `LICENSE` next to the engine's `vendor/` as `go-LICENSE.txt` (the
Windows bundle ships it with the engine's other licenses).

`--out` must be a new folder outside the working copy. The run leaves:

| Path | What it is |
|---|---|
| `source/Encore-<ver>/` | The public source tree, copied by allowlist, exactly as exported |
| `assets/Encore-<ver>-source.tar.gz` | The same tree as one reproducible archive (Docker users build the bridge from it) |
| `assets/Encore_<ver>_iphoneos-arm.deb` | The app, built fresh from the exported tree with Theos |
| `assets/EncoreBridge-<ver>-win64.zip` | The Windows bridge, portable zip (`gateway/windows/build.sh` through `build_windows.py`) |
| `assets/EncoreBridge-<ver>-setup.exe` | The Windows bridge installer, made from the same files |
| `assets/EncoreBridge-<ver>-windows-payload/` | The staging folder both are made from. It is scanned, but it is not an asset: not checksummed, never published |
| `assets/Encore-<ver>-gpl-source.tar.gz` | The GPL Corresponding Source of the engine and the Windows build |
| `assets/SHA256SUMS.txt` | SHA-256 of every file in `assets/` |
| `assets/SHA256SUMS.txt.sig` | The Ed25519 signature over the exact bytes of `SHA256SUMS.txt`: 64 raw bytes. The bridge and the Windows tray program offer an update only when it verifies (see "Signing") |
| `reports/MANIFEST.txt` | sha256, size and path of every file in the source tree |
| `reports/export-log.txt` | Every file the export left behind, and why |
| `reports/scan-*.txt`, `scan-report.txt` | The scan results. Values are masked and denylist values are never printed |
| `reports/release-summary.txt`, `release-log.txt` | Step results and the full log. Every path given on the command line is replaced by a placeholder (`<out>`, `<repo>`, `<windows-engine>`, `<engine-build>`, `<go-vendor>`, `<launcher-vendor>`, `<sign-key>`) and any other local path by `<path>` |
| `reports/scan-reports.txt` | The last scan: the whole `reports/` folder itself, so nothing shared from it carries a local folder name. A finding fails the run |
| `reports/windows-static-checks.txt`, `windows-build-log.txt`, `EncoreBridge-<ver>-bundle-report.txt`, `-iscc-log.txt` | The Windows build: static checks of the result (file list, sizes, versions, SHA-256), the build log, the bundle script's report, the Inno Setup log |

Options: `--skip deb,windows,gpl,source,docker`, `--deb-local` (build the deb on this machine with Theos),
`--deb-file <deb>` (a trial run only: use a deb built earlier instead of building one; `--final` refuses it),
`--denylist <file>` (another denylist for every scan of the run), `--docker` (Docker smoke build), `--windows-engine <folder>` (the engine for the Windows bundle), `--windows-ffmpeg
<folder>` (the FFmpeg build for the Windows bundle; its source tarball goes into the GPL bundle),
`--windows-cmd "<command>"` (your own Windows build instead of `build_windows.py`), `--engine-build <folder>`,
`--go-vendor <folder>` and `--launcher-vendor <folder>` (extra GPL bundle content, see below), `--sign-key <file>`
(the private release key; with `--final` the default is `ENCORE_SIGN_KEY`, see "Signing").

## The steps one by one

`release.py` runs them in this order: **export**, **scan** of the source tree, **deb**, **source** (the archive),
**windows**, **gpl**, **docker**, **sums**, **sign**, and a last **scan** of `reports/`. Each step's files are scanned
right after it. There is no step that puts the deb into the tree: the source archive, the Windows bundle and the Docker
image hold no app package. A release has 7 assets: `EncoreBridge-<ver>-setup.exe`, `EncoreBridge-<ver>-win64.zip`,
`Encore_<ver>_iphoneos-arm.deb`, `Encore-<ver>-source.tar.gz`, `Encore-<ver>-gpl-source.tar.gz`, `SHA256SUMS.txt` and
`SHA256SUMS.txt.sig`.

| Script | Does |
|---|---|
| `export.py --out <folder>` | Copies the files matched by `export-allowlist.txt`, nothing else. The never-ship rules in `relcommon.py` win over the allowlist. Writes the manifest and the export log |
| `scan.py <folder or file> ...` | The privacy scan (next section) |
| `build_deb.py --tree <export> --out <folder>` | Runs `build-deb.sh` here (`--local`) or on a Theos machine over SSH |
| `build-deb.sh <export> <folder>` | On the Theos machine: builds `make package FINALPACKAGE=1` in a temporary folder outside the home folder |
| `build_windows.py --tree <export> --out <folder> --engine <engine build> --ffmpeg <ffmpeg build>` | Runs `gateway/windows/build.sh` here (`--local`) or on a Docker machine over SSH, then checks the zip, the installer and the payload statically (no `gateway/repo/` and no `.deb` in the payload) |
| `gpl_bundle.py --tree <export> --out <file>` | The GPL source bundle, and a check that `ENCORE_PATCH.diff` matches the engine source |
| `docker_smoke.py --tree <export>` | Builds both Docker images on a scratch Linux machine under throw-away tags, checks them (the bridge's sources parse, the image has no `/app/repo` and no `.deb` under `/app`, the engine binary exists), deletes them |
| `checksums.py <folder>` | Writes `SHA256SUMS.txt` (every asset except itself and `SHA256SUMS.txt.sig`); `--check` verifies it, and `--check --pubkey <.pub>` also verifies the signature |
| `sign.py <assets> --key <key> --tree <export>` | Signs `SHA256SUMS.txt` into `SHA256SUMS.txt.sig` (see "Signing") |
| `signkey.py generate` / `public` | Makes the release key pair once; prints its public half (see "Signing") |
| `selftest.py` | Tests the scanner, the export and the release flow on generated fixtures (the step order, the deb as an asset only, a leftover `gateway/repo/` never exported, `ENCORE_DEB` never handed to the Windows build, `--skip deb`, the Windows and Docker "no app package" checks). Signing, with throwaway keys made in a temporary folder (never the real key): `signkey.py` (owner-only, nothing private printed, never overwrites), `sign.py` (the RFC 8032 TEST 1 vector, refusals: a key outside the trust lists, an RFC test key, an existing `.sig`, a checksum list the clients would reject), `checksums.py` with the `.sig`, the trust-list parser, the scanner on a planted key (PEM, PKCS#8 base64, DER in a zip and a tar; with `--sign-key` the seed as hex, base64 and raw bytes; never printed), `_keys/` never exported, the sign step of the release flow, the Windows static update checks. On the working copy: `gateway/Dockerfile` and the allowlist name no Cydia source, the shared phone block of `docs/TUTORIAL-WINDOWS.md` and `docs/TUTORIAL-DOCKER.md` is byte-identical, the Encore repo address check (below), the two trust lists are valid and equal (and hold the release key's public half), the two `update-vectors.json` copies are byte-identical, and `UPDATE_REPO` / `Repo` and every GitHub release link in the docs name the same repo |

## The privacy scan

`scan.py` reads folders and files, and opens archives in memory (`.deb`, `.zip`, `.tar`, `.tar.gz`, `.tar.xz`,
`.lzma`, nested ones too). Binary files get a strings pass: printable ASCII and UTF-8 runs, plus UTF-16 little- and
big-endian runs, because Objective-C stores string literals that contain non-ASCII characters as UTF-16.

A `.deb` is opened like any other archive wherever it is met: as a target (the deb asset), in a folder or inside
another archive. A copy that is byte-identical (SHA-256) to a deb already scanned in the same run has its name checked
but is not opened again; the report's `same` line counts those copies. The denylist's `allow` lines for the package
id match any path, so they cover such copies as they cover the deb asset.

| Category | Finds |
|---|---|
| `FILENAME` | Files that never ship: `.env` (only `.env.example` ships), `tokens.json`, `devices.json`, `jam.json`, `last.json`, `state.json`, the bridge's `admin.json` and `showcase.json`, credentials files, `*.har`, logs, key and certificate files, backup archives, `*.local.*` files, dev folders. With `--source-tree` also build outputs and archives. Secret and state files are reported by name and never opened |
| `DENY` | The local denylist: the maintainer's real names, server name, addresses, domain, key file names, personal paths and real library data |
| `SECRET` | Spotify token shapes, `sp_dc`/`sp_key` cookies, `refresh_token`/`access_token` values, private keys, Ed25519 private keys in PKCS#8 (as base64 text, and as DER bytes in any file or archive member), bearer tokens, JWTs, client ids and secrets, passwords in URLs, common API key shapes, and non-empty secret variables in `.env`-style files. With the release key (below) also that key's own material (`release-signing-key`) |
| `IP` | IPv4 addresses, except loopback, unspecified, multicast, link-local, the documentation ranges, CIDR network notation and well-known public resolvers |
| `EMAIL` | E-mail addresses, except example and test domains |
| `HOMEPATH` | `/home/<name>`, `/Users/<name>`, `C:\Users\<name>`: build paths and personal folders. Placeholders like `<user>` or `%USERPROFILE%` pass |
| `METADATA` | Image metadata the text checks can't read: PNG `tEXt`/`iTXt`/`zTXt`/`eXIf`/`tIME` chunks, JPEG APP1 (Exif, XMP) and APP13 (IPTC) segments, WebP EXIF/XMP chunks. A camera photo or an unstripped screenshot can carry a GPS position, the device, dates and names. Strip the image (for example `exiftool -all= <file>`, or re-save it without metadata) and scan again |
| `ERROR` | Anything the scan could not read. It fails like a finding |

Exit code 0 means clean, 1 means findings, 2 means a usage error.

### The release key check

`--sign-key <file>` (default: `ENCORE_SIGN_KEY` from `release.local.env` or the environment) reads the private release
key in memory and looks for its own material in every file, archive member and binary: the 32-byte seed as raw bytes,
as lower- and upper-case hex and as base64 (standard and URL-safe, with or without padding), and the key's PKCS#8 form
as DER and base64. A hit is `SECRET release-signing-key`. Like a denylist value, key material is never printed: not in
the report, not in the JSON, not even with `--show-matches`. The report header says `release key: checked (key <id>)`
or `release key: not checked`; `--no-sign-key` skips the check, and `--final` makes it required. `release.py` passes
the run's signing key to every scan (and `--final` in a `--final` run); a trial run without `--sign-key` scans with
`--no-sign-key`.

### The denylist (local only)

The real values live in `tools/release/denylist.local.txt`. That file is never exported: the export refuses
`*.local.*` files, and the scanner reports one if it ever appears in a release. `denylist.example.txt` shows the
format. Reports show a denylist hit as its line number and label (`deny:19 [lan-address]`) with the text masked, so a
report can be shared without repeating what it protects. `--show-matches` prints raw matches for local debugging only.

People who build Encore without the maintainer's denylist run `scan.py --no-denylist` for the generic checks.

### Exceptions

`scan-allow.txt` holds the reviewed exceptions for the generic checks (`IP`, `EMAIL`, `HOMEPATH`, `SECRET`), each with
a reason. Denylist exceptions can only be written in the local denylist itself (`allow <glob> <regex>` lines), for
example the package id the project keeps, the Encore repo address, or the public GitHub repo `<handle>/encore` (its
release links, the update API path and the repo constant of the update check) when the denylist holds the developer
handle (`denylist.example.txt` shows them with placeholders).

## The deb

`build_deb.py` packs the exported `app/` with `build-deb.sh` and builds it on the Theos machine named in
`tools/release/release.local.env` (copy `release.example.env`; the local file is never exported). The remote build
runs detached in a `mktemp` folder under `/tmp`, waits while another `make package` runs there, and removes its folder
when done. Without a configured machine it builds locally and needs `$THEOS` with the iOS 6.1 SDK.

`--skip deb` (trial runs only) skips the step. `--deb-file <deb>` (trial runs only) takes a deb built earlier as the
deb asset, for example to rehearse the later steps while the Theos machine is busy; `--final` always builds the deb
from the exported tree.

## The Encore repo address

The app is installed from the owner's Cydia repo, **the Encore repo**. Its address is one constant, on a line of its
own in `gateway/src/config.js`:

```js
const DEFAULT_APP_REPO = 'https://<owner>.github.io/<repo>/';
```

The setup guide (step 6), the admin page's Phone setup card and the docs show it. To change it, edit that one line
(and the docs: the check below names every file that still has the old one). `ENCORE_APP_REPO` overrides it at run
time (for forks; see the guide's settings reference). `selftest.py` reads the constant with
`DEFAULT_APP_REPO\s*=\s*'([^']+)'` and fails when:

- the shared phone block of the two tutorials, `docs/GUIDE.md` or `README.md` doesn't contain it;
- any `http(s)://<name>.github.io/...` address in `README.md` or `docs/` isn't exactly it (same scheme, same final
  `/`), naming the file and line;
- `gateway/src/admin.html` has a `/repo/` address (the bridge hosts no Cydia source) or a URL of a public-IP service
  (`api.ipify.org`, `icanhazip.com`, `ifconfig.me`): the bridge looks the public IP up when the setup guide asks, the
  page never contacts them (the page may name `api.ipify.org` in its text).

Getting a new deb into the Encore repo is the owner's own publish step; nothing here does it.

## The Windows step

`release.py` runs `build_windows.py`, which builds the Windows bridge from the **exported** tree with
`gateway/windows/build.sh`: the tray launcher (`Encore Bridge.exe`) in the `encore-winbuild-launcher` image, then
`gateway/windows/bundle/bundle.sh` in the `encore-winbuild-package` image (Wine + Inno Setup) for the staging folder,
the portable zip and the installer. The images hold toolchains only and are built the first time from
`gateway/windows/docker/`. Node.js is downloaded at the version and SHA-256 pinned in
`gateway/windows/bundle/pins.conf`; FFmpeg is Encore's own minimal LGPL build (`--windows-ffmpeg`, below), and
`pins.conf` pins the release tarball it must be built from.

Docker runs on the machine named in `tools/release/release.local.env` (`ENCORE_WIN_SSH`, see `release.example.env`):
the tree, the engine and the scanner are copied to a fresh temporary folder there, the build runs detached and is
polled, the results are copied back and the folder is removed. Without `ENCORE_WIN_SSH` (or with `--local`) it runs
here and needs bash and Docker.

FFmpeg is not built here either: pass `--windows-ffmpeg` with the output folder of
`gateway/windows/build-ffmpeg/build.sh` (`ffmpeg.exe` with its `SHA256SUMS`, `BUILDINFO.txt`, `licenses/` and
`sources/`). It is FFmpeg's own AAC encoder and picture conversion, nothing else, linked only with zlib, so its complete
source is the FFmpeg release tarball in `sources/`, which `gpl_bundle.py --ffmpeg-build` puts into the GPL bundle.

The engine is not built here: pass `--windows-engine` with the output folder of
`gateway/windows/build-engine/build.sh <version>` (`encore-engine.exe` with its `SHA256SUMS`, `BUILDINFO.txt` and
`licenses/`). The exe must match that `SHA256SUMS`. The engine build is reproducible, so rebuilding it from the
exported tree must give the same file. With `--go-vendor`, the license files of every Go module that `BUILDINFO.txt`
lists as compiled into the exe (and the Go toolchain's license, `go-LICENSE.txt` next to `vendor/`) are added to the
engine's licenses.

The bundle script runs the generic checks of the scan (`--no-denylist`) over the staging folder before the installer
is compiled, so the local denylist never leaves this machine. `release.py` then scans the zip, the installer and the
payload folder with the full denylist. The installer's payload is compressed inside `setup.exe`; the payload folder
holds exactly the same files, so scanning it covers the installer. `build_windows.py` also checks the result
statically (nothing is run): the file list and sizes, the launcher's, engine's, Node.js's and FFmpeg's versions, the
pinned Node.js hash, FFmpeg's LGPL configuration, the engine's DLL imports, the setup guide's bridge files
(`clientid.js`, `netcheck.js`, `wizard.js`), that the payload carries no app package (no `gateway/repo/` folder and no
`.deb` anywhere), the zip matching the payload byte for byte, and the installer's version. For the update system it
also checks that the payload has `gateway/src/update.js` and `updatekeys.js`; that the bridge's and the launcher's
trust lists are valid, equal and free of the RFC 8032 test keys; that `Encore Bridge.exe` contains every trusted key
and none of the test hooks (`ENCORE_UPDATE_TEST_KEY`, `ENCORE_UPDATE_API`, `ENCORE_UPDATE_DOWNLOAD`, `--update-test`:
only launcher builds with the Go build tag `encoreupdatetest` have them); and that `installer/EncoreBridge.iss` has
its update mode (`ENCOREUPDATE`, `--updated`, `--update-failed`).

`--windows-cmd "<command>"` replaces `build_windows.py` with your own command. It runs with the exported tree as the
working folder and these variables:

| Variable | Meaning |
|---|---|
| `ENCORE_EXPORT_TREE` | The exported source tree. Build only from this, never from a working copy |
| `ENCORE_ASSETS_DIR` | Where to write `EncoreBridge-<ver>-win64.zip` and `EncoreBridge-<ver>-setup.exe`. An optional staging folder `EncoreBridge-<ver>-windows-payload/` there is scanned but not checksummed or published |
| `ENCORE_VERSION` | The release version |
| `ENCORE_SCAN` | The scanner command, for scanning the staging folder before the installer is compiled |

`ENCORE_DEB` is not set (it is removed from the environment when present): the Windows bundle carries no app package.

Exit code 0 means success. `release.py` scans every `EncoreBridge-*` file and folder it finds afterwards.

## The GPL source bundle

go-librespot is GPL-3.0, so every release with an engine binary ships its Corresponding Source. The bundle holds the
patched engine tree exactly as built (`LICENSE`, `ENCORE_PATCH.md`, `ENCORE_PATCH.diff`, `go.mod`/`go.sum`, the vcpkg
baseline and triplets) and `gateway/windows/` when present. `--engine-build <folder>` adds `BUILDINFO.txt`,
`licenses/` and `sources/` from the Windows engine build. `--go-vendor <folder>` adds a `go mod vendor` folder, so
every Go module compiled into the engine is included, and `--launcher-vendor <folder>` does the same for the tray
launcher (`windows/launcher/vendor/`). `--ffmpeg-build <folder>` adds `windows-ffmpeg-build/`: the FFmpeg release
tarball the Windows `ffmpeg.exe` is built from, with that build's `BUILDINFO.txt` and `licenses/`. With `--final`, `ENCORE_PATCH.diff` must reverse-apply cleanly
to the shipped engine source (`git apply -R --check`).

## Signing

Every release's `SHA256SUMS.txt` is signed with Encore's **release key**, an Ed25519 key pair. The Encore Bridge
update check (the Windows tray program and the Docker bridge) offers a new version only when `SHA256SUMS.txt.sig`
verifies under a public key built into it, and the Windows one-click update runs an installer only when its SHA-256
matches that signed list. The private key never leaves the owner's PC.

**Make the key once** (only when it doesn't exist; `generate` never overwrites):

```sh
python tools/release/signkey.py generate --key <folder outside the repo>/_keys/encore-release-ed25519.key
```

- `encore-release-ed25519.key`: the private key, PKCS#8 PEM, unencrypted so that `release.py --final` runs unattended.
  It is created exclusively and made **owner-only**: on Windows `icacls <key> /inheritance:r /grant:r
  "%USERDOMAIN%\%USERNAME%:F"` (the `_keys` folder the same, with `(OI)(CI)F`, before the key is written), checked
  afterwards; elsewhere mode 0600 (folder 0700). The key must be outside the working copy and named
  `encore-release-<...>.key`. On Windows a folder not named `_keys` must be owner-only already, else it is refused: a
  new file first gets its folder's access rules.
- `encore-release-ed25519.pub`: the public key, PEM. It isn't secret.
- The command prints only public information: the key id (the first 16 hex digits of SHA-256 over the raw 32-byte
  public key), the public key as base64 and PEM, and the ready-made entries for `gateway/src/updatekeys.js` and the
  launcher's `internal/update/keys.go`. `signkey.py public --pub <.pub> [--format text|pem|base64|id|js|go|json]`
  prints them again.
- Put the path into `tools/release/release.local.env` as `ENCORE_SIGN_KEY=<path>` (`release.example.env` shows the
  line). `--sign-key` on the command line wins.

**Signing a release:** `release.py --final` signs after the sums step (`sign.py`). It refuses a key that isn't in
**both** embedded trust lists of the exported tree (`gateway/src/updatekeys.js` and
`gateway/windows/launcher/internal/update/keys.go`; they must be equal, hold at most 3 keys and never an RFC 8032 test
key), an RFC 8032 test key, a checksum list in a format the clients would reject, and an existing `.sig`; it verifies
the signature it wrote. A trial
run signs only with a key passed as `--sign-key` (use a throwaway one made with `signkey.py generate` in a scratch
folder; a key outside the trust lists is then a warning, never a release; a real release key, one the working copy's
own trust lists hold, is refused) and never picks up `ENCORE_SIGN_KEY` by itself. Every scan of a run that has a key also searches for that key's material (see "The release key check").

**Checking a signature by hand** (OpenSSL 3):

```sh
openssl pkeyutl -verify -pubin -inkey encore-release-ed25519.pub -rawin -in SHA256SUMS.txt -sigfile SHA256SUMS.txt.sig
sha256sum -c --ignore-missing SHA256SUMS.txt
```

or `python tools/release/checksums.py <assets> --check --pubkey encore-release-ed25519.pub`.

**Never ships, never leaves:** the export refuses any `_keys/` folder and any `encore-release-*.key` file, and the
scanner fails on them by name (without opening them); generic scanner rules find any Ed25519 private key in PKCS#8,
and the release key check finds this key's own material anywhere. Never copy the key into the working copy, a
scratch folder, a build machine or a backup share. Keep **one offline backup**, encrypted: inside an encrypted
container or a password manager, never as a bare `.key` file (the key itself is unencrypted PEM, so whoever finds a
plain copy can sign releases). Without the key, installed bridges can't verify new releases (below).

**Restoring the key** from that backup: put it back outside the working copy as
`<folder>/_keys/encore-release-ed25519.key`, make the file and the folder owner-only again (Windows:
`icacls <folder>\_keys /inheritance:r /grant:r "%USERDOMAIN%\%USERNAME%:(OI)(CI)F"` and
`icacls <key> /inheritance:r /grant:r "%USERDOMAIN%\%USERNAME%:F"`; elsewhere `chmod 700` the folder and `chmod 600`
the key), point `ENCORE_SIGN_KEY` at it, and check with `signkey.py public --key <key> --format id` that it prints the
key id the embedded lists hold (`7eec300915b1339f` for `encore-release-1`) before a `--final` run.

**Rotation, loss, compromise** (DESIGN-UPDATES 4.5):

- Planned rotation: `signkey.py generate --key <folder>/_keys/encore-release-ed25519-2.key` (list entry
  `encore-release-2`); release N embeds both keys (old first) and is still signed with the old one; a later release
  (once most users have N) is signed with the new one (`--sign-key` or a new `ENCORE_SIGN_KEY`); the old key leaves
  both lists one release after that. From the first release signed with the new key, replace the PEM block and key id
  in README.md "Checking a download", docs/GUIDE.md "Checking a download" and docs/BUILDING.md "Release signing" (or
  show both keys while older releases are still downloaded); the selftest fails on a block that isn't in the list.
- Lost key (no backup): installed bridges show "isn't signed with Encore's release key" and offer nothing. Make a new
  key as `<folder>/_keys/encore-release-ed25519-2.key` (never the old name again: its list entry would be
  `encore-release-1` again), embed it in the next release and sign with it. Replace the PEM block and key id in the same
  three places as for a rotation, so the documented `openssl` check works with the new key, and add a dated
  "Release key replaced" note to README.md and the release notes: the new key id, and which installed versions need the
  one-time install by hand (all versions that embed only the lost key). Users install that release by hand once.
- Compromised key: ship a re-key release signed with the old key that embeds only the new one, say so in the release
  notes and the README, and rotate the GitHub credentials. There is no remote revocation.

## Publishing (R7, the owner's step)

Nothing here publishes. When the owner publishes a release on GitHub (`github.com/<handle>/encore`):

1. Tag exactly `v<version>` (for example `v1.1.0`): the update check accepts only `vX.Y.Z` tags.
2. Upload all 7 assets from `assets/` with their names unchanged: `EncoreBridge-<ver>-setup.exe`,
   `EncoreBridge-<ver>-win64.zip`, `Encore_<ver>_iphoneos-arm.deb`, `Encore-<ver>-source.tar.gz`,
   `Encore-<ver>-gpl-source.tar.gz`, `SHA256SUMS.txt`, `SHA256SUMS.txt.sig` (never the payload folder, never
   `reports/`). Check first: `checksums.py assets --check --pubkey <.pub>` prints OK for every file and the signature.
3. Mark the release **Latest** (the update check asks GitHub for the latest release); never a draft.
4. Release candidates: tag `v<version>-rc<n>` and publish them only as **pre-releases**. The update check never offers
   them either way.
5. Put the phone app into the Encore repo in Cydia as usual (a separate step; the update check never touches the app).

## What never ships

Secrets and state (`.env` files other than `.env.example`, `tokens.json`, `devices.json`, `jam.json`, `last.json`,
the engine's `state.json`, credentials and lockfile, logs and Jam traces, bridge `data/` folders, the CLI's pairing
file, HAR captures and saved pages, SSH, signing and backup keys, the release key's `_keys/` folder and any
`encore-release-*.key`), the development folders and notes (`probes/`,
`mockup/`, `tools/pipeline/`, `.workflows/`, `PLAN.md`, `DESIGN-*.md`, `ARCH-*.md`, `RELEASE-PLAN.md`,
`gateway/tools/LIVE_TEST.md`, `gateway/tools/live_catalog.py`), every earlier build and backup archive, real library
data, and the local denylist and settings files.
