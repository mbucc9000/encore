# Release tools

These scripts turn the working copy into release files in a new folder and scan every file for private data. They
never upload anything; GitHub builds the Docker images when the release is published. Needs Python 3.8 or newer
(signing also needs the `cryptography` package) on Windows, Linux or macOS.

## One command

```sh
python tools/release/release.py --out ../encore-release-<ver>             # trial run: unfinished parts are warnings
python tools/release/release.py --out ../encore-release-<ver> --final \
    --windows-engine <engine build> --engine-build <engine build> --windows-ffmpeg <ffmpeg build> \
    --go-vendor <engine vendor>/vendor --launcher-vendor <launcher vendor>/vendor --docker
```

- The builds are the out folders of `gateway/windows/build-engine/build.sh <version>` and `build-ffmpeg/build.sh`.
- The vendor folders: `go mod vendor -o <dir>/vendor` in `gateway/engine-src` and `gateway/windows/launcher`. Put
  the Go toolchain's `LICENSE` next to the engine's `vendor/` as `go-LICENSE.txt`.
- `--final` requires both builds and `--go-vendor`, and signs with `ENCORE_SIGN_KEY`.
- `--out` must be a new folder outside the working copy.

Other options: `--skip deb,windows,gpl,source,compose,docker` (`--final` may skip only `docker`), `--deb-local`
(build the deb here), `--deb-file <deb>` (trial runs only), `--denylist <file>`, `--windows-cmd "<command>"`,
`--sign-key <file>`.

A run leaves `source/` (the exported tree), `assets/` (the 8 release files and a Windows payload folder that is never
published) and `reports/` (scan reports, `release-summary.txt`, `release-log.txt`; local paths are masked).

## The steps

`release.py` runs **export**, **scan**, **deb**, **source**, **compose**, **windows**, **gpl**, **docker**, **sums**,
**sign**, and a last **scan** of `reports/`. Each step's files are scanned right after it. The scripts:

- `export.py --out <folder>`: copies only the files `export-allowlist.txt` lists.
- `scan.py <folder or file> ...`: the privacy scan (below).
- `build_deb.py --tree <export> --out <folder>`: builds the deb here (`--local`) or on a Theos machine over SSH.
- `build_windows.py --tree <export> --out <folder> --engine <dir> --ffmpeg <dir>`: the Windows bridge (below).
- `gpl_bundle.py --tree <export> --out <file>`: the GPL source bundle.
- `docker_smoke.py --tree <export>`: builds and smoke-tests both Docker images (below).
- `checksums.py <folder>`: writes the file list `SHA256SUMS.txt`; `--check --pubkey <.pub>` verifies it.
- `sign.py <assets> --key <key> --tree <export>`: signs the file list.
- `signkey.py generate` / `public`: makes the release key once / prints its public half.
- `selftest.py`: tests all of this on fixtures and checks the docs and trust lists. Run it after changing either.

## The privacy scan

`scan.py` reads folders, files, archives (nested too) and the strings in binaries. It reports `FILENAME` (files that
never ship), `DENY` (local denylist values), `SECRET` (tokens, keys, passwords), `IP`, `EMAIL`, `HOMEPATH`, `METADATA`
(image metadata: strip it with `exiftool -all= <file>`) and `ERROR` (unreadable). Exit code 0 = clean, 1 = findings,
2 = usage error. Reports mask every match (`--show-matches` is for local debugging only).

- **Denylist:** `tools/release/denylist.local.txt`, never exported (`denylist.example.txt` shows the format). Without
  it, run `scan.py --no-denylist` for the generic checks.
- **Exceptions:** `scan-allow.txt` for the generic checks, each with a reason. Denylist exceptions are
  `allow <glob> <regex>` lines in the local denylist (package id, repo address, GitHub repo, image names).
- **Release key check:** with `--sign-key` (default `ENCORE_SIGN_KEY`) every file is searched for that key's
  material. `--final` requires it, `--no-sign-key` skips it.
- **Never shipped:** secrets and state files (`.env`, `tokens.json`, `devices.json`, `data/`), logs, keys, `_keys/`,
  development notes (`PLAN.md`, `DESIGN-*.md`, `probes/`, `.workflows/`), and the local denylist and settings.

## The deb and the Encore repo

`build_deb.py` builds the exported `app/` on the Theos machine set in `tools/release/release.local.env` (copy
`release.example.env`), or locally with `$THEOS` and the iOS 6.1 SDK. The deb is a release asset only. Putting it into
the Encore repo is the owner's own step. It also carries the App Icon add-on (`app/EncoreIcons/`, a Theos subproject).

The repo address is the line `const DEFAULT_APP_REPO = '...';` in `gateway/src/config.js`. To change it, edit that
line and the docs: `selftest.py` names every file and line in `README.md` and `docs/` that doesn't match.

## The Windows step

`build_windows.py` runs `gateway/windows/build.sh` on the exported tree, on the Docker machine `ENCORE_WIN_SSH`
(`release.local.env`) or here with `--local`. Then it checks the zip, the installer and the payload without running
them: files, versions, pins, trust lists, no test hooks, no app package.

`--windows-cmd "<command>"` runs your own build instead, in the exported tree, with `ENCORE_EXPORT_TREE`,
`ENCORE_ASSETS_DIR` (where the zip and `setup.exe` go), `ENCORE_VERSION` and `ENCORE_SCAN` set. Exit code 0 = success.

## The Docker smoke test

Only `.github/workflows/docker-images.yml` builds and pushes the images `ghcr.io/mbucc9000/encore-bridge` and
`ghcr.io/mbucc9000/encore-engine`. `release.py --docker` (or `docker_smoke.py --tree <export>`) builds them the same
way under local tags and runs `.github/scripts/smoke-images.sh`; the last line is `smoke: OK`. It can run next to a
live Encore (nothing listens on port 8095), but never in a live stack's folder. Settings (`release.local.env`):
`ENCORE_DOCKER_SSH` (`user@host`), `ENCORE_DOCKER_SSH_KEY`, `ENCORE_DOCKER_DIR`, `ENCORE_DOCKER_SUDO=1`.

## The GPL source bundle

`gpl_bundle.py` packs the patched engine source and `gateway/windows/`. `--engine-build`, `--go-vendor`,
`--launcher-vendor` and `--ffmpeg-build` add the C library sources, the Go modules and the FFmpeg tarball. With
`--final`, `ENCORE_PATCH.diff` must match the engine source.

## Signing

Every release's file list is signed with the **release key** (Ed25519). Bridges offer an update only when the
signature verifies under a key built into them. Make the key once (`generate` never overwrites):

```sh
python tools/release/signkey.py generate --key <folder outside the repo>/_keys/encore-release-ed25519.key
```

- It writes the private key (owner-only) and `encore-release-ed25519.pub`, and prints the key id and the entries for
  `gateway/src/updatekeys.js` and `launcher/internal/update/keys.go` (again: `signkey.py public --pub <.pub>`).
- Put `ENCORE_SIGN_KEY=<path>` in `tools/release/release.local.env`. `--sign-key` wins.
- `release.py --final` signs after the sums step. It refuses a key that isn't in both trust lists, an RFC 8032 test
  key and an existing `.sig`. A trial run signs only with a throwaway key passed as `--sign-key`.
- The key never ships: the export refuses `_keys/` and `encore-release-*.key`, and the scan finds key material.
- Keep **one encrypted offline backup** (an encrypted container or a password manager, never a bare `.key` file).

**Restoring the key:** put it back as `<folder>/_keys/encore-release-ed25519.key` and make the folder and the file
owner-only. Windows: `icacls <folder>\_keys /inheritance:r /grant:r "%USERDOMAIN%\%USERNAME%:(OI)(CI)F"`, then
`icacls <key> /inheritance:r /grant:r "%USERDOMAIN%\%USERNAME%:F"`; elsewhere `chmod 700` and `chmod 600`. Set
`ENCORE_SIGN_KEY` and check that `signkey.py public --key <key> --format id` prints `7eec300915b1339f`.

- **Rotation:** make `encore-release-ed25519-2.key`. Release N embeds both keys and is signed with the old one, a
  later release with the new one; the old key leaves one release after that. Update the key block and key id in
  `docs/BUILDING.md` "Release signing" (the selftest checks them).
- **Lost key:** make `encore-release-ed25519-2.key`, embed it, sign with it, update `docs/BUILDING.md`, and add a
  dated "Release key replaced" note to `README.md` and the release notes. Users install that release by hand once.
- **Leaked key:** ship a release signed with the old key that embeds only the new one, say so in the release notes
  and the README, and change the GitHub credentials. There is no remote revocation.

## Publishing (the owner's step)

1. Run `release.py --final`: `assets/` holds 8 files.
2. Update the public repository from the exported tree (workflow files need `gh auth refresh -s workflow`).
3. Tag exactly `v<version>` (for example `v1.3.0`).
4. Create a **draft** release and upload all 8 files from `assets/` with their names unchanged:
   `EncoreBridge-<ver>-setup.exe`, `EncoreBridge-<ver>-win64.zip`, `Encore_<ver>_iphoneos-arm.deb`,
   `Encore-<ver>-source.tar.gz`, `encore-docker-compose.yaml`, `Encore-<ver>-gpl-source.tar.gz`, `SHA256SUMS.txt`,
   `SHA256SUMS.txt.sig`. Check them first: `checksums.py assets --check --pubkey <.pub>`.
5. Put the app (`Encore_<ver>_iphoneos-arm.deb`) into the Encore repo in Cydia (a separate step) **before** you
   publish, or together with it: once a bridge has checked the published release, the app tells its phone to update
   in Cydia, once per version.
6. **Publish** it as the **Latest** release. That starts **Actions > Docker images** (about 15 minutes).
7. Release candidates: tag `v<version>-rc<n>` and publish them only as **pre-releases**.

Once, after the first image run: on github.com, your profile > **Packages** > `encore-bridge` > **Package settings** >
**Change visibility** > **Public**, the same for `encore-engine`. Then check, logged out:
`docker pull ghcr.io/<handle>/encore-bridge:latest`.

If a run fails, fix it and use **Re-run all jobs** (a smoke test that couldn't reach Spotify only needs a re-run).
`check_gpl_bundle: ...` means the GPL bundle wasn't made from the tagged source: make it again and replace it. To
rebuild a release's images: **Run workflow** with the tag and **push** on. Never move image tags by hand.
