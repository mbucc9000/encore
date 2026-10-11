#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Build the GPL Corresponding Source bundle for the engine (and the Windows build) from an EXPORTED tree.

    python tools/release/gpl_bundle.py --tree <exported tree> --out <assets>/Encore-<ver>-gpl-source.tar.gz [--final]

go-librespot is GPL-3.0 (gateway/engine-src/LICENSE). Every release that ships an engine binary must offer the
Corresponding Source of that exact build (RELEASE-PLAN D10). The bundle holds:
  engine/     the patched go-librespot tree exactly as built (LICENSE, ENCORE_PATCH.md, ENCORE_PATCH.diff,
              go.mod/go.sum, vcpkg.json + vcpkg-configuration.json (the vcpkg baseline) and vcpkg-triplets/)
  windows/    gateway/windows/** when present: the Windows engine and FFmpeg build scripts, the tray launcher
              source, the installer script and the bundle script (--launcher-vendor adds windows/launcher/vendor/)
  windows-ffmpeg-build/   with --ffmpeg-build: the FFmpeg release tarball the Windows ffmpeg.exe is built from
              (LGPL-2.1: its corresponding source), with that build's BUILDINFO.txt and licenses/
  README-SOURCE.md   what this is and how to rebuild it
The archive is reproducible: same input, same bytes (see relcommon.write_tar_gz).

--final also requires that ENCORE_PATCH.diff reverse-applies cleanly to engine/ (checked with "git apply -R
--check" on a temporary copy, when git is available), so the published diff really describes the shipped source, and,
when the tree has the Windows bridge (whose encore-engine.exe links C libraries and Go modules statically, and
whose ffmpeg.exe is LGPL), --engine-build with BUILDINFO.txt and sources/, --go-vendor and --ffmpeg-build with its
source tarball, so their source is in the bundle as the shipped notices say.
"""
import argparse
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True   # keep __pycache__ out of the working copy
import relcommon as rc  # noqa: E402

README = """# Encore {ver}: GPL source for the engine and the Windows bridge

This archive is the Corresponding Source, under the GNU General Public License version 3, for the binaries in the
Encore {ver} release that are built from GPL code:

- the Encore engine, a patched build of go-librespot (`go-librespot` in the Docker image, `encore-engine.exe` on
  Windows), and
- the Windows bridge's tray launcher (`Encore Bridge.exe`) and installer, when that release contains them, and
- the Windows bridge's `ffmpeg.exe` (LGPL-2.1-or-later), Encore's own minimal build of an unmodified FFmpeg release.

## Contents

| Folder | What it is |
|---|---|
| `engine/` | go-librespot at upstream commit {commit} (https://github.com/devgianlu/go-librespot) with the Encore patches applied. This is exactly the tree the release binaries are built from. `engine/LICENSE` is the upstream GPL-3.0 licence, unchanged. `engine/ENCORE_PATCH.md` describes every change and `engine/ENCORE_PATCH.diff` is the same change set as one diff against the upstream commit. The vcpkg baseline is in `engine/vcpkg-configuration.json`, the triplets in `engine/vcpkg-triplets/`. |
| `windows/` | {windows} |
| `windows-engine-build/` | When present: `BUILDINFO.txt` (toolchain, library and module versions of the Windows engine build), `licenses/` and `sources/` (the source archives of the C libraries linked into `encore-engine.exe`). |
| `engine/vendor/` | When present: every Go module compiled into the engine (`go mod vendor`); otherwise they are pinned by `engine/go.mod` and `engine/go.sum`. |
| `windows/launcher/vendor/` | When present: every Go module compiled into the tray launcher (`go mod vendor`); otherwise they are pinned by `windows/launcher/go.mod` and `go.sum`. |
| `windows-ffmpeg-build/` | When present: `sources/ffmpeg-<version>.tar.xz` (FFmpeg's unmodified release tarball, the complete source of the Windows `ffmpeg.exe`), that build's `BUILDINFO.txt` (version, configure line, every component built in, toolchain) and `licenses/`. `windows/build-ffmpeg/` rebuilds it. |

## Rebuilding

- Linux (Docker): `docker build -t encore-engine engine/` uses the upstream `engine/Dockerfile` unchanged.
- Windows engine: follow `windows/build-engine/README.md` (MinGW + vcpkg static build of `encore-engine.exe`).
- Windows FFmpeg: follow `windows/build-ffmpeg/README.md` (MinGW static build of `ffmpeg.exe` from the tarball).
- Windows launcher, zip and installer: `windows/build.sh` (see `windows/launcher/` and `windows/installer/`).
- Upstream source: check out the commit above and apply `engine/ENCORE_PATCH.diff` with `git apply`.

The rest of Encore (the iOS app, the Node bridge, the documentation) is GPL-3.0-or-later too and is published as the
full source tree next to this archive.
"""


def verify_diff(engine_dir):
    """(ok, message): does ENCORE_PATCH.diff reverse-apply to the engine tree?"""
    diff = os.path.join(engine_dir, 'ENCORE_PATCH.diff')
    if not os.path.exists(diff):
        return False, 'ENCORE_PATCH.diff is missing'
    git = shutil.which('git')
    if not git:
        return None, 'git not found: diff check skipped'
    tmp = tempfile.mkdtemp(prefix='encore-gpl-check-')
    try:
        work = os.path.join(tmp, 'engine')
        shutil.copytree(engine_dir, work)
        r = subprocess.run([git, 'apply', '-R', '--check', '--whitespace=nowarn', 'ENCORE_PATCH.diff'], cwd=work,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        out = r.stdout.decode('utf-8', 'replace').strip().splitlines()
        if r.returncode == 0:
            return True, 'ENCORE_PATCH.diff reverse-applies cleanly to the shipped engine source'
        return False, 'ENCORE_PATCH.diff does not match the engine source (%d problem lines, first: %s)' % (
            len(out), (out[0][:160] if out else '?'))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--tree', required=True, help='the exported source tree')
    ap.add_argument('--out', required=True, help='output .tar.gz')
    ap.add_argument('--final', action='store_true', help='fail when the patch diff does not match the source')
    ap.add_argument('--engine-build', help='output folder of gateway/windows/build-engine/build.sh: adds its '
                    'BUILDINFO.txt, licenses/ and sources/ (the C libraries linked into the exe)')
    ap.add_argument('--go-vendor', help='a vendor/ folder made by "go mod vendor" in engine-src: adds every Go module '
                    'compiled into the engine, as engine/vendor/')
    ap.add_argument('--ffmpeg-build', help='output folder of gateway/windows/build-ffmpeg/build.sh: adds its '
                    'sources/ (the FFmpeg release tarball), BUILDINFO.txt and licenses/')
    ap.add_argument('--launcher-vendor', help='a vendor/ folder made by "go mod vendor" in gateway/windows/launcher: '
                    'adds the Go modules compiled into the tray launcher, as windows/launcher/vendor/')
    a = ap.parse_args(argv)

    tree = os.path.abspath(a.tree)
    engine = os.path.join(tree, 'gateway', 'engine-src')
    if not os.path.isfile(os.path.join(engine, 'LICENSE')):
        print('gpl_bundle: %s has no gateway/engine-src/LICENSE' % tree, file=sys.stderr)
        return 2
    ver = rc.read_versions(tree)[0] or '0.0.0'
    commit = '(see engine/ENCORE_PATCH.md)'
    try:
        with open(os.path.join(engine, 'ENCORE_PATCH.md'), encoding='utf-8') as f:
            m = re.search(r'upstream commit \*\*([0-9a-f]{7,40})\*\*', f.read(4000))
            if m:
                commit = '`%s`' % m.group(1)
    except OSError:
        pass
    win = os.path.join(tree, 'gateway', 'windows')
    has_win = os.path.isdir(win)
    if a.final and has_win:
        missing = []
        if not (a.engine_build and os.path.isfile(os.path.join(a.engine_build, 'BUILDINFO.txt'))
                and os.path.isdir(os.path.join(a.engine_build, 'sources'))):
            missing.append('--engine-build (BUILDINFO.txt, sources/)')
        if not a.go_vendor:
            missing.append('--go-vendor')
        if not (a.ffmpeg_build and glob.glob(os.path.join(a.ffmpeg_build, 'sources', 'ffmpeg-*.tar.xz'))):
            missing.append('--ffmpeg-build (sources/ffmpeg-<version>.tar.xz)')
        if missing:
            print('gpl_bundle: FAIL --final with the Windows bridge needs %s: the source of the C libraries and Go '
                  'modules linked into encore-engine.exe, and of ffmpeg.exe' % ' and '.join(missing), file=sys.stderr)
            return 1
    prefix = 'Encore-%s-gpl-source' % ver
    members = []
    for rel in rc.tree_files(engine):
        members.append(('%s/engine/%s' % (prefix, rel), os.path.join(engine, *rel.split('/'))))
    if a.go_vendor:
        if not os.path.isfile(os.path.join(a.go_vendor, 'modules.txt')):
            print('gpl_bundle: --go-vendor has no modules.txt (not a "go mod vendor" folder)', file=sys.stderr)
            return 2
        for rel in rc.tree_files(a.go_vendor):
            members.append(('%s/engine/vendor/%s' % (prefix, rel), os.path.join(a.go_vendor, *rel.split('/'))))
    if has_win:
        for rel in rc.tree_files(win):
            members.append(('%s/windows/%s' % (prefix, rel), os.path.join(win, *rel.split('/'))))
    if a.launcher_vendor:
        if not os.path.isfile(os.path.join(a.launcher_vendor, 'modules.txt')):
            print('gpl_bundle: --launcher-vendor has no modules.txt (not a "go mod vendor" folder)', file=sys.stderr)
            return 2
        for rel in rc.tree_files(a.launcher_vendor):
            members.append(('%s/windows/launcher/vendor/%s' % (prefix, rel),
                            os.path.join(a.launcher_vendor, *rel.split('/'))))
    if a.engine_build:
        for rel in rc.tree_files(a.engine_build):
            if rel == 'BUILDINFO.txt' or rel.startswith(('licenses/', 'sources/')):
                members.append(('%s/windows-engine-build/%s' % (prefix, rel), os.path.join(a.engine_build, *rel.split('/'))))
    if a.ffmpeg_build:
        for rel in rc.tree_files(a.ffmpeg_build):
            if rel == 'BUILDINFO.txt' or rel.startswith(('licenses/', 'sources/')):
                members.append(('%s/windows-ffmpeg-build/%s' % (prefix, rel), os.path.join(a.ffmpeg_build, *rel.split('/'))))
    for name, _ in members:
        inner = name.split('/', 1)[1]
        # the source archives in windows-engine-build/sources/ and windows-ffmpeg-build/sources/ are archives on purpose
        why = rc.forbidden_reason(inner, source_tree=not inner.startswith(('windows-engine-build/', 'windows-ffmpeg-build/')))
        if why:
            print('gpl_bundle: refusing %s (%s)' % (name, why), file=sys.stderr)
            return 1

    ok, msg = verify_diff(engine)
    print('gpl_bundle: %s' % msg)
    tmpdir = tempfile.mkdtemp(prefix='encore-gpl-')
    try:
        readme = os.path.join(tmpdir, 'README-SOURCE.md')
        with open(readme, 'w', encoding='utf-8', newline='\n') as f:
            f.write(README.format(ver=ver, commit=commit, windows=(
                'The Windows bridge sources: the engine build scripts (`build-engine/`), the tray launcher, the installer '
                'script and the bundle script, exactly as used for this release.' if has_win else
                'Not part of this release (no Windows bridge yet).')))
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        rc.write_tar_gz(a.out, [(prefix + '/README-SOURCE.md', readme)] + members)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    print('gpl_bundle: %s (%d files, %.1f MB)' % (a.out, len(members) + 1, os.path.getsize(a.out) / 1e6))
    if a.final and ok is not True:
        print('gpl_bundle: FAIL %s' % msg, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
