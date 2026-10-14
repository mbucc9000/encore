#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""One command for the whole Encore release, into a fresh folder. Nothing is published or uploaded.

    python tools/release/release.py --out <new folder outside the repo> [--final] [--skip deb,windows,gpl,docker]

Steps, each scanned by scan.py (any finding fails the release):
  1. export   the public source tree by allowlist           -> source/Encore-<ver>/, reports/MANIFEST.txt
  2. scan     the source tree (also fails on build outputs)  -> reports/scan-source.txt
  3. deb      Theos final package from the exported tree     -> assets/Encore_<ver>_iphoneos-arm.deb (build_deb.py)
              A release asset (Filza/SSH installs). Phones install the app from the owner's Encore repo in Cydia,
              which the owner publishes separately: no bridge package carries the deb (DESIGN-WIZARD 5.6).
  4. source   reproducible archive of the exported tree (to build the bridge yourself)
                                                             -> assets/Encore-<ver>-source.tar.gz
  4b. compose the prebuilt images' compose file, the tree's docker/compose.yaml byte for byte
              (DESIGN-DOCKER-IMAGES 3, 7.2)                  -> assets/encore-docker-compose.yaml
  5. windows  the Windows bridge zip + installer from the exported tree (build_windows.py runs
              gateway/windows/build.sh on a Docker machine, then checks the result statically)
                                                             -> assets/EncoreBridge-<ver>-win64.zip, -setup.exe
                                                                (+ the payload folder, scanned, never published)
  6. gpl      GPL Corresponding Source bundle                -> assets/Encore-<ver>-gpl-source.tar.gz (gpl_bundle.py)
  7. docker   smoke test on a scratch Docker machine (docker_smoke.py), optional: both images built from source the
              way gateway/compose.yaml does, then built as the prebuilt images and started from docker/compose.yaml
              cut off from the network (.github/scripts/smoke-images.sh)
  8. sums     SHA-256 of every asset                         -> assets/SHA256SUMS.txt
  9. sign     Ed25519 signature over the exact bytes of SHA256SUMS.txt with the private release key (sign.py,
              DESIGN-UPDATES 4)                              -> assets/SHA256SUMS.txt.sig (64 raw bytes)
              The installed bridges and the tray launcher offer an update only when this signature verifies under a
              key they carry (gateway/src/updatekeys.js, the launcher's internal/update/keys.go).
A release has 8 assets: EncoreBridge-<ver>-setup.exe, EncoreBridge-<ver>-win64.zip, Encore_<ver>_iphoneos-arm.deb,
Encore-<ver>-source.tar.gz, encore-docker-compose.yaml, Encore-<ver>-gpl-source.tar.gz, SHA256SUMS.txt and
SHA256SUMS.txt.sig. encore-docker-compose.yaml never carries a version in its name: the docs download it from
releases/latest/download/, and the Docker images' update check looks for that name in the signed list. Publishing a
release as final starts .github/workflows/docker-images.yml, which builds and pushes the images (README.md
"Publishing"); nothing here builds or pushes them.
Reports: reports/scan-*.txt (masked; denylist values are never printed), reports/scan-report.txt (all scans) and
reports/release-summary.txt. Local folder names never reach a report: every path given on the command line becomes a
placeholder (<out>, <repo>, <windows-engine>, <windows-ffmpeg>, <engine-build>, <go-vendor>, <launcher-vendor>,
<sign-key>), any other absolute or home-relative path becomes <path>, and the finished reports/ folder is scanned too
(reports/scan-reports.txt): a finding there fails the run like any other.

The release key: --sign-key <file>, or ENCORE_SIGN_KEY in tools/release/release.local.env / the environment (made once
with signkey.py; it stays on the owner's PC, outside the working copy, and is never exported, copied or printed).
Every scan of the run also searches for that key's own material (scan.py --sign-key). With --final the key is
required (a usage error before any work when it is missing) and its public half must be in both embedded trust lists
of the exported tree. A trial run (no --final) never picks up ENCORE_SIGN_KEY by itself: it signs only with a key
passed as --sign-key (a throwaway one to rehearse; a key outside the trust lists is then a warning), and without one
the sign step is a warning and no .sig is made.

--final: a release candidate. Every step must run and pass: required allowlist entries present, one shared
version (D8), the deb built fresh from the exported tree, the patch diff matching the engine source, a clean scan
everywhere (the release key's material checked in every scan), SHA256SUMS.txt signed with a key the trust lists hold,
the Windows bundle present, and the GPL bundle complete for the Windows programs: --engine-build
(BUILDINFO.txt and sources/, the C libraries linked into encore-engine.exe), --go-vendor (the Go modules compiled
into it) and --windows-ffmpeg (Encore's FFmpeg build, whose sources/ holds the FFmpeg release tarball ffmpeg.exe is
built from) are required.
Without --final, missing pieces from unfinished lanes are reported as warnings and the run goes on, and --deb-file
can stand in for the deb build (a trial run only: --final always builds the deb from the exported tree).
Exit code: 0 = every step that ran passed and every scan is clean, 1 = something failed, 2 = usage error.
"""
import argparse
import glob
import os
import re
import shlex
import shutil
import subprocess
import sys
import time

sys.dont_write_bytecode = True   # keep __pycache__ out of the working copy
import relcommon as rc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
SCAN_EXTRA = []   # scan.py options for every scan of this run (--denylist)
DEB_NAME = 'Encore_%s_iphoneos-arm.deb'


SANITIZE = []   # (local path, placeholder): the log never holds this machine's folder names
# whatever SANITIZE didn't name: a drive-letter path, a home-relative one, an MSYS/Cygwin user folder, a home folder
LEFTOVER_PATHS = [
    re.compile(r'(?i)(?<![A-Za-z0-9])[A-Z]:[\\/][^\s"\'<>|]*'),
    re.compile(r'(?<![\w.~-])~[\\/][^\s"\'<>|]*'),
    re.compile(r'(?<![\w.])/(?:[A-Za-z]/)?(?:Users|home|mnt)/[^\s"\'<>|]+'),
]


def add_sanitize(path, tag):
    """Every spelling of a local path: as given, absolute, resolved, and '~/'-relative."""
    if not path:
        return
    home = os.path.expanduser('~')
    for p in {path, os.path.abspath(path), os.path.realpath(path)}:
        SANITIZE.append((p, tag))
        if home and len(p) > len(home) and os.path.normcase(p[:len(home)]) == os.path.normcase(home):
            SANITIZE.append(('~' + p[len(home):], tag))
    SANITIZE.sort(key=lambda x: -len(x[0]))


def clean(text):
    flags = re.IGNORECASE if os.name == 'nt' else 0
    for path, tag in SANITIZE:
        for v in {path, path.replace('\\', '/'), path.replace('/', '\\')}:
            text = re.sub(re.escape(v), lambda m, t=tag: t, text, flags=flags)
    for rx in LEFTOVER_PATHS:
        text = rx.sub('<path>', text)
    return text


def run(cmd, log, env=None, cwd=None):
    log.write(clean('$ %s\n' % ' '.join(os.path.basename(c) if i == 0 else c for i, c in enumerate(cmd))))
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=cwd)
    out = r.stdout.decode('utf-8', 'replace')
    log.write(clean(out))
    log.flush()
    return r.returncode, out


def compose_step(tree, assets, final):
    """Copy the exported tree's docker/compose.yaml byte for byte to assets/encore-docker-compose.yaml.
    (result, note, the asset's path or None). Without the file: 'FAIL' in a --final run, else 'warning'."""
    src = os.path.join(tree, *rc.COMPOSE_SRC.split('/'))
    if not os.path.isfile(src):
        return ('FAIL' if final else 'warning'), 'no %s in the exported tree, so no %s' % (rc.COMPOSE_SRC,
                                                                                          rc.COMPOSE_ASSET), None
    dst = os.path.join(assets, rc.COMPOSE_ASSET)
    shutil.copyfile(src, dst)
    return 'ok', rc.COMPOSE_ASSET, dst


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', required=True, help='new folder for everything this run makes (outside the repo)')
    ap.add_argument('--repo', default=rc.REPO_ROOT)
    ap.add_argument('--final', action='store_true', help='release candidate: everything must run and pass')
    ap.add_argument('--skip', default='', help='comma list of steps to skip: deb,windows,gpl,docker,source,compose '
                    '(trial runs only; --final may skip docker only)')
    ap.add_argument('--deb-local', action='store_true', help='build the deb here with Theos instead of over SSH')
    ap.add_argument('--deb-file', help='trial runs only: use this already built Encore deb instead of building one '
                    '(--final always builds it from the exported tree)')
    ap.add_argument('--denylist', help='the denylist for every scan of the run (default: tools/release/denylist.local.txt)')
    ap.add_argument('--docker', action='store_true', help='run the Docker smoke build (needs ENCORE_DOCKER_SSH)')
    ap.add_argument('--windows-cmd', help='your own command that builds the Windows bundle instead of build_windows.py '
                    '(see README.md "The Windows step")')
    ap.add_argument('--windows-engine', help='output folder of gateway/windows/build-engine/build.sh: encore-engine.exe '
                    'for the Windows bundle (required with --final)')
    ap.add_argument('--windows-ffmpeg', help='output folder of gateway/windows/build-ffmpeg/build.sh: ffmpeg.exe for the '
                    'Windows bundle, and its sources/ for the GPL bundle (required with --final)')
    ap.add_argument('--engine-build', help='Windows engine build output folder: its BUILDINFO.txt, licenses/ and '
                    'sources/ (GPL bundle; also the engine licenses for the Windows bundle)')
    ap.add_argument('--go-vendor', help='"go mod vendor" folder of gateway/engine-src (GPL bundle; its module licenses '
                    'also go into the Windows bundle)')
    ap.add_argument('--launcher-vendor', help='"go mod vendor" folder of gateway/windows/launcher (GPL bundle)')
    ap.add_argument('--sign-key', help='the private Ed25519 release key that signs SHA256SUMS.txt (with --final the '
                    'default is ENCORE_SIGN_KEY from release.local.env or the environment; a trial run signs only '
                    'with a key given here)')
    a = ap.parse_args(argv)

    repo, out = os.path.abspath(a.repo), os.path.abspath(a.out)
    if rc.is_inside(out, repo):
        print('release: --out must be outside the working copy', file=sys.stderr)
        return 2
    if os.path.exists(out) and os.listdir(out):
        print('release: --out must be a new or empty folder', file=sys.stderr)
        return 2
    if a.deb_file and a.final:
        print('release: --final builds the deb from the exported tree; --deb-file is for trial runs', file=sys.stderr)
        return 2
    if a.deb_file and not os.path.isfile(a.deb_file):
        print('release: no such deb: %s' % a.deb_file, file=sys.stderr)
        return 2
    if a.denylist and not os.path.isfile(a.denylist):
        print('release: no such denylist: %s' % a.denylist, file=sys.stderr)
        return 2
    SCAN_EXTRA[:] = ['--denylist', os.path.abspath(a.denylist)] if a.denylist else []
    # the release key (DESIGN-UPDATES 4.4, 13): --final takes ENCORE_SIGN_KEY by default, a trial run only --sign-key
    conf_key = rc.read_local_conf().get('ENCORE_SIGN_KEY') or None
    sign_key = a.sign_key or (conf_key if a.final else None)
    if a.final and not sign_key:
        print('release: --final signs SHA256SUMS.txt: pass --sign-key or set ENCORE_SIGN_KEY in '
              'tools/release/release.local.env (make the key once with signkey.py generate)', file=sys.stderr)
        return 2
    if sign_key:
        sign_key = os.path.abspath(sign_key)
        if not os.path.isfile(sign_key):
            print('release: the release key file doesn\'t exist (%s)' % ('--sign-key' if a.sign_key else 'ENCORE_SIGN_KEY'),
                  file=sys.stderr)
            return 2
        if rc.is_inside(sign_key, repo):
            print('release: the release key must live outside the working copy', file=sys.stderr)
            return 2
        sys.path.insert(0, HERE)
        import sign as signmod
        if not signmod.have_crypto():
            print('release: %s' % signmod.NEED_CRYPTO, file=sys.stderr)
            return 2
        SCAN_EXTRA.extend(['--sign-key', sign_key] + (['--final'] if a.final else []))
    else:
        SCAN_EXTRA.append('--no-sign-key')
    del SANITIZE[:]
    for path, tag in ((out, '<out>'), (repo, '<repo>'), (a.windows_engine, '<windows-engine>'),
                      (a.windows_ffmpeg, '<windows-ffmpeg>'), (a.engine_build, '<engine-build>'),
                      (a.go_vendor, '<go-vendor>'),
                      (a.launcher_vendor, '<launcher-vendor>'), (a.deb_file, '<deb-file>'),
                      (a.denylist, '<denylist>'), (sign_key, '<sign-key>'), (conf_key, '<sign-key>'),
                      (os.path.expanduser('~'), '~')):
        add_sanitize(path, tag)
    skip = {s.strip() for s in a.skip.split(',') if s.strip()}
    if a.final and skip - {'docker'}:
        print('release: --final runs every step (only docker may be skipped)', file=sys.stderr)
        return 2
    if a.final:
        # encore-engine.exe links C libraries (mpg123, ...) and Go modules statically: the GPL bundle must carry their
        # source, as licenses/go-librespot/SOURCE.txt and THIRD-PARTY-NOTICES.md promise (RELEASE-PLAN D10)
        bad = []
        if not a.engine_build:
            bad.append('--engine-build (the Windows engine build: BUILDINFO.txt, licenses/, sources/)')
        elif not (os.path.isfile(os.path.join(a.engine_build, 'BUILDINFO.txt'))
                  and os.path.isdir(os.path.join(a.engine_build, 'sources'))):
            bad.append('--engine-build with BUILDINFO.txt and sources/')
        if not a.go_vendor:
            bad.append('--go-vendor (a "go mod vendor" folder of gateway/engine-src)')
        elif not os.path.isfile(os.path.join(a.go_vendor, 'modules.txt')):
            bad.append('--go-vendor with modules.txt')
        if not a.windows_ffmpeg:
            bad.append('--windows-ffmpeg (gateway/windows/build-ffmpeg: ffmpeg.exe and the FFmpeg source it is built from)')
        elif not (os.path.isfile(os.path.join(a.windows_ffmpeg, 'ffmpeg.exe'))
                  and glob.glob(os.path.join(a.windows_ffmpeg, 'sources', 'ffmpeg-*.tar.xz'))):
            bad.append('--windows-ffmpeg with ffmpeg.exe and sources/ffmpeg-<version>.tar.xz')
        if bad:
            print('release: --final needs %s, so the GPL source bundle holds the source of everything in the Windows '
                  'programs' % ' and '.join(bad), file=sys.stderr)
            return 2
    ver = rc.read_versions(repo)[0] or '0.0.0'
    src_dir = os.path.join(out, 'source')
    tree = os.path.join(src_dir, 'Encore-%s' % ver)
    assets = os.path.join(out, 'assets')
    reports = os.path.join(out, 'reports')
    for d in (src_dir, assets, reports):
        os.makedirs(d, exist_ok=True)
    log = open(os.path.join(reports, 'release-log.txt'), 'w', encoding='utf-8', newline='\n')
    status = []          # (step, 'ok'|'FAIL'|'skipped'|'warning', note)
    scans = []           # (label, report path, exit code)
    final = ['--final'] if a.final else []

    def step(name, ok, note=''):
        note = clean(note)
        status.append((name, ok, note))
        print('release: %-8s %-8s %s' % (name, ok, note))

    def scan(label, targets, source_tree=False):
        rep = os.path.join(reports, 'scan-%s.txt' % label)
        cmd = [PY, os.path.join(HERE, 'scan.py'), '--quiet', '--report', rep,
               '--json', os.path.join(reports, 'scan-%s.json' % label)] + SCAN_EXTRA
        if source_tree:
            cmd.append('--source-tree')
        code, o = run(cmd + targets, log)
        scans.append((label, rep, code))
        line = [l for l in o.splitlines() if l.startswith('result')]
        step('scan', 'ok' if code == 0 else 'FAIL', '%s: %s' % (label, line[0][10:] if line else 'error %d' % code))
        return code

    # 1. export
    code, o = run([PY, os.path.join(HERE, 'export.py'), '--repo', repo, '--out', tree,
                   '--manifest', os.path.join(reports, 'MANIFEST.txt'),
                   '--log', os.path.join(reports, 'export-log.txt')] + final, log)
    warns = [l for l in o.splitlines() if 'warning' in l or 'FAIL' in l]
    step('export', 'ok' if code == 0 else 'FAIL', '%s%s' % (clean(o.splitlines()[0]) if o else '',
                                                            ('; %d warnings' % len(warns)) if warns else ''))
    for w in warns:
        log.write('export warning: %s\n' % w)
    if code != 0 and a.final:
        return finish(out, reports, status, scans, log)
    tree_ver, bridge_ver = rc.read_versions(tree)

    # 2. scan the source tree
    scan('source', [tree], source_tree=True)

    # 3. deb (a release asset only: no bridge package carries it, phones install from the Encore repo)
    if 'deb' in skip:
        step('deb', 'skipped')
    elif a.deb_file:
        deb_asset = os.path.join(assets, DEB_NAME % ver)
        shutil.copyfile(a.deb_file, deb_asset)
        step('deb', 'warning', '%s copied from --deb-file, not built from this tree (a trial run, never a release)'
             % os.path.basename(deb_asset))
        scan('deb', [deb_asset])
    else:
        cmd = [PY, os.path.join(HERE, 'build_deb.py'), '--tree', tree, '--out', assets]
        if a.deb_local:
            cmd.append('--local')
        code, o = run(cmd, log)
        debs = sorted(glob.glob(os.path.join(assets, '*.deb')))
        step('deb', 'ok' if code == 0 and debs else 'FAIL', os.path.basename(debs[-1]) if debs else clean(o.strip()[-200:]))
        if debs:
            scan('deb', debs)

    # 4. source archive of the exported tree (to build the bridge yourself; it holds no deb)
    if 'source' in skip:
        step('source', 'skipped')
    else:
        name = os.path.join(assets, 'Encore-%s-source.tar.gz' % ver)
        rc.write_tar_gz(name, [('Encore-%s/%s' % (ver, rel), os.path.join(tree, *rel.split('/')))
                               for rel in rc.tree_files(tree)])
        step('source', 'ok', os.path.basename(name))
        scan('source-archive', [name])

    # 4b. the prebuilt images' compose file (DESIGN-DOCKER-IMAGES 7.2)
    if 'compose' in skip:
        step('compose', 'skipped')
    else:
        result, note, asset = compose_step(tree, assets, a.final)
        step('compose', result, note)
        if asset:
            scan('compose', [asset])

    # 5. Windows bundle (gateway/windows/build.sh from the exported tree, through build_windows.py)
    if 'windows' in skip:
        step('windows', 'skipped')
    else:
        wcmd = None
        if a.windows_cmd:
            wcmd = [t[1:-1] if len(t) > 1 and t[0] == t[-1] and t[0] in '"\'' else t
                    for t in shlex.split(a.windows_cmd, posix=(os.name != 'nt'))]
        elif os.path.isfile(os.path.join(tree, 'gateway', 'windows', 'build.sh')):
            wcmd = [PY, os.path.join(HERE, 'build_windows.py'), '--tree', tree, '--out', assets, '--reports', reports]
            if a.windows_ffmpeg:
                wcmd += ['--ffmpeg', a.windows_ffmpeg]
            if a.windows_engine:
                wcmd += ['--engine', a.windows_engine]
                if a.engine_build:
                    wcmd += ['--engine-build', a.engine_build]
                if a.go_vendor:
                    wcmd += ['--go-vendor', a.go_vendor]
            elif not a.final:
                wcmd.append('--dev')
                step('windows', 'warning', 'no --windows-engine: building a DEV bundle (never a release)')
        if not wcmd or (a.final and not a.windows_engine and not a.windows_cmd):
            step('windows', 'FAIL' if a.final else 'warning',
                 'no --windows-engine (the encore-engine.exe build)' if wcmd else 'no gateway/windows/build.sh in the exported tree')
        else:
            env = dict(os.environ, ENCORE_EXPORT_TREE=tree, ENCORE_ASSETS_DIR=assets, ENCORE_VERSION=ver,
                       ENCORE_SCAN='%s %s' % (PY, os.path.join(HERE, 'scan.py')))
            env.pop('ENCORE_DEB', None)   # the Windows bundle carries no app package (DESIGN-WIZARD 5.6)
            code, o = run(wcmd, log, env=env, cwd=tree)
            outs = sorted(glob.glob(os.path.join(assets, 'EncoreBridge-*')))
            step('windows', 'ok' if code == 0 and outs else 'FAIL', ', '.join(os.path.basename(x) for x in outs))
            payloads = [x for x in outs if os.path.isdir(x)]
            files = [x for x in outs if os.path.isfile(x)]
            if files or payloads:
                scan('windows', files + payloads)
            for p in payloads:   # a staging folder is scanned, never published
                log.write('windows payload folder scanned (not an asset): %s\n' % os.path.basename(p))

    # 6. GPL bundle
    if 'gpl' in skip:
        step('gpl', 'skipped')
    else:
        name = os.path.join(assets, 'Encore-%s-gpl-source.tar.gz' % ver)
        cmd = [PY, os.path.join(HERE, 'gpl_bundle.py'), '--tree', tree, '--out', name] + final
        if a.engine_build:
            cmd += ['--engine-build', a.engine_build]
        if a.go_vendor:
            cmd += ['--go-vendor', a.go_vendor]
        if a.launcher_vendor:
            cmd += ['--launcher-vendor', a.launcher_vendor]
        if a.windows_ffmpeg:
            cmd += ['--ffmpeg-build', a.windows_ffmpeg]
        code, o = run(cmd, log)
        diff_line = [l for l in o.splitlines() if 'ENCORE_PATCH.diff' in l or 'diff check' in l]
        step('gpl', 'ok' if code == 0 else 'FAIL', '%s%s' % (os.path.basename(name),
                                                          ('; ' + diff_line[0][12:]) if diff_line else ''))
        if os.path.exists(name):
            scan('gpl', [name])

    # 7. Docker smoke build
    if a.docker and 'docker' not in skip:
        code, o = run([PY, os.path.join(HERE, 'docker_smoke.py'), '--tree', tree], log)
        step('docker', 'ok' if code == 0 else ('skipped' if code == 3 else 'FAIL'), clean(o.strip().splitlines()[-1]) if o.strip() else '')
    else:
        step('docker', 'skipped', 'pass --docker to run it')

    # 8. checksums (payload folders are not assets)
    for p in glob.glob(os.path.join(assets, '*')):
        if os.path.isdir(p):
            log.write('note: folder %s is in assets/; it is not checksummed or published\n' % os.path.basename(p))
    code, o = run([PY, os.path.join(HERE, 'checksums.py'), assets], log)
    step('sums', 'ok' if code == 0 else 'FAIL', clean(o.strip()))
    sums_ok = code == 0

    # 9. the signature over SHA256SUMS.txt (DESIGN-UPDATES 4; the bridges and the launcher verify it before an update)
    if not sign_key:
        step('sign', 'warning', 'no --sign-key: %s is not signed (a trial run; --final signs with ENCORE_SIGN_KEY)'
             % rc.SUMS_NAME)
    elif not sums_ok:
        step('sign', 'FAIL', 'not signed: the sums step failed')
    else:
        code, o = run([PY, os.path.join(HERE, 'sign.py'), assets, '--key', sign_key, '--tree', tree]
                      + ([] if a.final else ['--trial']), log)
        made = [l[6:] for l in o.splitlines() if l.startswith('sign: %s (key ' % rc.SIG_NAME)]
        why = [l[6:] for l in o.splitlines() if l.startswith('sign: ') and not l.startswith('sign: %s (key ' % rc.SIG_NAME)]
        if code == 0 and made:
            step('sign', 'ok', made[0])
        elif code == 3 and made and not a.final:
            step('sign', 'warning', '%s; %s' % (made[0], why[0][9:] if why and why[0].startswith('warning: ') else
                                               'a key outside the trust lists: a trial signature, never a release'))
        else:
            step('sign', 'FAIL', why[-1] if why else 'sign.py exit %d' % code)

    if tree_ver != bridge_ver:
        step('version', 'FAIL' if a.final else 'warning', 'app %s, bridge %s (D8 wants one shared version)' % (tree_ver, bridge_ver))
    return finish(out, reports, status, scans, log)


def finish(out, reports, status, scans, log):
    with open(os.path.join(reports, 'scan-report.txt'), 'w', encoding='utf-8', newline='\n') as f:
        for label, rep, code in scans:
            f.write('#' * 100 + '\n# scan: %s (exit %d)\n' % (label, code))
            try:
                with open(rep, encoding='utf-8') as r:
                    f.write(r.read())
            except OSError:
                f.write('(no report)\n')
            f.write('\n')
    log.close()
    # the reports themselves (MANIFEST, logs, scan reports) go out with the release: scan them like an asset
    rep = os.path.join(reports, 'scan-reports.txt')
    r = subprocess.run([PY, os.path.join(HERE, 'scan.py'), '--quiet', '--report', rep] + SCAN_EXTRA + [reports],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    line = [l for l in r.stdout.decode('utf-8', 'replace').splitlines() if l.startswith('result')]
    note = 'reports: %s' % (line[0][10:] if line else 'error %d' % r.returncode)
    status.append(('scan', 'ok' if r.returncode == 0 else 'FAIL', note))
    print('release: %-8s %-8s %s' % ('scan', status[-1][1], note))
    failed = [s for s in status if s[1] == 'FAIL']
    with open(os.path.join(reports, 'release-summary.txt'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('Encore release run, %s\n' % time.strftime('%Y-%m-%d %H:%M'))
        f.write('result: %s\n\n' % ('PASS' if not failed else 'FAIL (%d)' % len(failed)))
        for name, ok, note in status:
            f.write('%-8s %-8s %s\n' % (name, ok, clean(note)))
    print('release: %s; reports in %s' % ('PASS' if not failed else 'FAIL', clean(reports)))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
