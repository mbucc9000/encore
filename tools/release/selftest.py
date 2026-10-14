#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Self-test of the release scripts on generated fixtures (no real data, no network).

    python tools/release/selftest.py

Checks that scan.py finds every kind of leak (text, UTF-16 inside a binary, inside zip / tar / deb archives,
forbidden names, secret shapes, image metadata) and stays quiet on placeholders, that secret files (the bridge's
data/admin.json too) are reported by name without being read, that a deb met twice in one scan is scanned once, and
that export.py copies only allowlisted files and never a never-ship one.
The release flow on a synthetic working copy with a synthetic deb (made-up fields): the steps run in the order export,
scan, deb, source, compose, windows, gpl, docker, sums (there is no step "repo": the bridge hosts no Cydia source,
phones install the app from the owner's Encore repo, DESIGN-WIZARD 5.6); the deb is a release asset only, never in the
exported tree, the source archive or the Windows build's environment; a leftover gateway/repo/ in a working copy is
never exported. The compose asset (encore-docker-compose.yaml) is the tree's docker/compose.yaml byte for byte and in
SHA256SUMS.txt; without that file a trial run warns and a --final run fails. The Windows static check fails on a
gateway/repo/ folder or any .deb in the payload, build_windows.py has no --deb any more, and the Docker smoke test
checks that the image has no /app/repo, packs the prebuilt images' files (docker/compose.yaml, smoke-images.sh,
compose.smoke.yaml) and runs the prebuilt build and smoke-images.sh.
On the working copy: gateway/Dockerfile and the export allowlist name no Cydia source; the shared phone block of
docs/TUTORIAL-WINDOWS.md and docs/TUTORIAL-DOCKER.md is byte-identical; the Encore repo address DEFAULT_APP_REPO of
gateway/src/config.js (DESIGN-WIZARD 3.2) is in that block, in docs/GUIDE.md and in README.md, and every github.io
address in README.md and docs/ equals it; gateway/src/admin.html has no /repo/ and no public-IP service URL.
Release signing (DESIGN-UPDATES 4, 13), with throwaway keys made in a temporary folder and deleted (never the real
key: ENCORE_SIGN_KEY is blanked for the whole run, only the real key's PUBLIC .pub is read): signkey.py makes an
owner-only key pair, prints nothing private, never overwrites, refuses the working copy; sign.py signs and verifies
(the RFC 8032 TEST 1 vector too), refuses a key outside the trust lists (a trial signs with a warning), an RFC 8032 test
key, an existing .sig and a checksum list the clients would reject; checksums.py skips the .sig and verifies it with
--pubkey; the trust-list parser catches unequal lists, wrong ids, the RFC test keys and too many keys; the scanner finds
a planted key as PEM, PKCS#8 base64 and DER inside a zip and a tar, and with --sign-key its seed as hex and base64 in
text and raw in a binary, and never prints any of it; the export and the scanner never ship a _keys/ folder; the
release flow signs after the sums step, and --final without a key is a usage error.
On the working copy: the trust lists of gateway/src/updatekeys.js and the launcher's internal/update/keys.go are valid
and equal (and hold the real key's public half when ENCORE_SIGN_KEY names one), the two update-vectors.json files are
byte-identical, and UPDATE_REPO (update.js), Repo (github.go) and every GitHub release link in README.md, docs/ and
admin.html name the same repo.
Docker images (DESIGN-DOCKER-IMAGES 7.5), on fixtures and then on the working copy: every ghcr.io name is one of
relcommon.IMAGES (owned by UPDATE_REPO's owner); docker/compose.yaml has the design's shape (gateway/engine, the
source build's container names, the images with ${ENCORE_TAG:-latest}, host networking, the volumes, restart, no
build/env_file/pull_policy); the engine image's default config.yml is gateway/engine/config.yml byte for byte; the
workflow (release types [released] + workflow_dispatch, permissions {} / contents: read / packages: write, actions
pinned to a commit with a version comment, GITHUB_TOKEN only, no pull_request_target, no ${{ github.event.* }} or
${{ inputs.* }} in run:, the arm64 runner, the two scripts); ENCORE_PREBUILT and ENCORE_VERSION wired through; the
update card's commands (UPD_IMAGE_CMDS) in the guide's "Bridge on Docker", COMPOSE_ASSET equal everywhere, README and
the Docker tutorial download it from releases/latest/download/; no SHA-256/checksum/hash wording in the compose file,
the Docker tutorial and the four new card texts; LF line endings; image_plan.py's tags and refusals.
Test values are assembled at run time so this file passes the scan itself. Exit code 0 = all checks passed.
"""
import base64
import collections
import contextlib
import gzip
import hashlib
import io
import lzma
import os
import re
import shlex
import shutil
import sys
import tarfile
import tempfile
import zipfile
import zlib

sys.dont_write_bytecode = True   # keep __pycache__ out of the working copy
import relcommon as rc  # noqa: E402
import scan
import export
import release
import build_windows
import docker_smoke
import checksums
import sign
import signkey

# The update system's fixed names (DESIGN-UPDATES 2.1, 14.1)
REPO_CONST_JS = re.compile(r"\bUPDATE_REPO\s*=\s*'([^']+)'")
REPO_CONST_GO = re.compile(r'\bRepo\s*=\s*"([^"]+)"')
RELEASE_LINK_RX = re.compile(r'(?i)\bgithub\.com/(?:repos/)?([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/releases\b')
VECTORS = ('gateway/test/fixtures/update-vectors.json',
           'gateway/windows/launcher/internal/update/testdata/update-vectors.json')
UPDATE_JS, UPDATE_GO = 'gateway/src/update.js', 'gateway/windows/launcher/internal/update/github.go'
# RFC 8032 section 7.1 TEST 1: public test data (the seed and the signature of the empty message)
RFC_TEST1_SEED = bytes.fromhex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
RFC_TEST1_SIG_EMPTY = bytes.fromhex('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155'
                                    '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b')
REAL_PUB = []   # the real release key's .pub (public), when ENCORE_SIGN_KEY names a key
KEY_DOCS = ('docs/BUILDING.md',)   # it publishes the release key ("Release signing")
PEM_PUB_RX = re.compile(r'-----BEGIN PUBLIC KEY-----\s*\n([A-Za-z0-9+/=\s]+?)\n-----END PUBLIC KEY-----')
KEY_ID_RX = re.compile(r'key id `([0-9a-f]{16})`')

SHARED_BEGIN = '<!-- BEGIN SHARED: phone -->'
SHARED_END = '<!-- END SHARED: phone -->'
TUTORIALS = ('docs/TUTORIAL-WINDOWS.md', 'docs/TUTORIAL-DOCKER.md')
# The Encore repo address: one constant in gateway/src/config.js (DESIGN-WIZARD 3.2), read with exactly this pattern
APP_REPO_RX = re.compile(r"DEFAULT_APP_REPO\s*=\s*'([^']+)'")
PAGES_RX = re.compile(r'(?i)https?://[a-z0-9.-]+\.github\.io(?:/[^\s<>()\[\]"\'`]*)?')
# the bridge looks the public IP up (DESIGN-WIZARD 5.2), never the page: no URL of these services in admin.html (the
# page may name api.ipify.org in its text)
IPCHECK_URL_RX = re.compile(r'(?i)(?:https?:)?//(?:api\.ipify\.org|(?:ipv4\.)?icanhazip\.com|ifconfig\.me)')

FAILS = []


def check(name, cond, detail=''):
    print('%-4s %s%s' % ('ok' if cond else 'FAIL', name, ('  (%s)' % detail) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data if isinstance(data, bytes) else data.encode('utf-8'))


def tar_bytes(files, compress=None):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as t:
        for name, data in files:
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            t.addfile(ti, io.BytesIO(data))
    raw = buf.getvalue()
    if compress == 'gz':
        return gzip.compress(raw)
    if compress == 'lzma':
        return lzma.compress(raw, format=lzma.FORMAT_ALONE)
    if compress == 'xz':
        return lzma.compress(raw)
    return raw


def ar_bytes(members):
    out = [b'!<arch>\n']
    for name, data in members:
        hdr = '%-16s%-12d%-6d%-6d%-8s%-10d`\n' % (name, 0, 0, 0, '100644', len(data))
        out.append(hdr.encode('ascii') + data + (b'\n' if len(data) % 2 else b''))
    return b''.join(out)


def deb_bytes(version='9.9.9'):
    """A synthetic deb, the way Theos lays one out (debian-binary, control.tar.gz, data): made-up fields only."""
    fields = [('Package', 'org.example.encore'), ('Name', 'Encore'), ('Version', version),
              ('Architecture', 'iphoneos-arm'), ('Maintainer', 'Nobody <nobody@example.com>'),
              ('Description', 'A made-up package for the release self-test')]
    control = ''.join('%s: %s\n' % kv for kv in fields).encode()
    data = tar_bytes([('./Applications/Encore.app/Info.plist', b'<plist><dict/></plist>\n')], 'gz')
    return ar_bytes([('debian-binary', b'2.0\n'), ('control.tar.gz', tar_bytes([('./control', control)], 'gz')),
                     ('data.tar.gz', data)])


def shared_block(text, label):
    """The text between the shared-block markers; raises ValueError when the markers aren't there exactly once."""
    if text.count(SHARED_BEGIN) != 1 or text.count(SHARED_END) != 1:
        raise ValueError('%s: the markers %s / %s must appear exactly once' % (label, SHARED_BEGIN, SHARED_END))
    a, b = text.index(SHARED_BEGIN) + len(SHARED_BEGIN), text.index(SHARED_END)
    if b <= a:
        raise ValueError('%s: the END marker comes before the BEGIN marker' % label)
    return text[a:b]


def shared_problems(files):
    """[problem] for {label: bytes}: every file's shared phone block must be byte-identical to the first one's."""
    blocks, problems = {}, []
    for label, data in files.items():
        try:
            blocks[label] = shared_block(data.decode('utf-8'), label)
        except (UnicodeDecodeError, ValueError) as e:
            problems.append(str(e))
    labels = list(blocks)
    for other in labels[1:]:
        if blocks[other] != blocks[labels[0]]:
            a, b = blocks[labels[0]].splitlines(), blocks[other].splitlines()
            n = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
            problems.append('%s and %s differ in the shared phone block (first at its line %d)' % (labels[0], other, n + 1))
    if not problems and blocks and not any(blocks[l].strip() for l in labels):
        problems.append('the shared phone block is empty')
    return problems


def release_run(argv):
    """release.main() with its console lines captured: (exit code, [(step, result)])."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = release.main(argv)
    steps = [tuple(l.split()[1:3]) for l in buf.getvalue().splitlines() if l.startswith('release: ') and len(l.split()) > 2]
    return code, steps, buf.getvalue()


WINDOWS_PROBE = r"""import os, sys, zipfile
# a stand-in for the Windows build (release.py --windows-cmd): records whether ENCORE_DEB reached it, writes a zip
with open(sys.argv[1], 'w') as f:
    f.write('ENCORE_DEB=%s\n' % ('set' if 'ENCORE_DEB' in os.environ else 'absent'))
    f.write('args=%s\n' % ' '.join(sys.argv[2:]))
with zipfile.ZipFile(os.path.join(os.environ['ENCORE_ASSETS_DIR'],
                                  'EncoreBridge-%s-win64.zip' % os.environ['ENCORE_VERSION']), 'w') as z:
    z.writestr('Encore Bridge/README-Windows.txt', 'made-up\n')
"""


def quote_arg(arg):
    return '"%s"' % arg if os.name == 'nt' else shlex.quote(arg)


def check_release_flow(tmp, keys=None):
    """release.py end to end on a synthetic working copy: no step "repo", the deb an asset only (DESIGN-WIZARD 5.6),
    and the sign step after the sums (DESIGN-UPDATES 13) with a throwaway key the synthetic trust lists hold."""
    ver = '9.9.9'
    wc = os.path.join(tmp, 'wc')
    if keys:
        trust_files(wc, [(keys['pub'], 'encore-release-1')])
    for rel, body in [('app/control', 'Package: org.example.encore\nName: Encore\nVersion: %s\n' % ver),
                      ('app/Makefile', 'include x\n'), ('app/A.m', 'int a;\n'), ('app/Resources/Icon@2x.png', png_bytes()),
                      ('gateway/src/config.js', "  version: '%s',\n" % ver), ('gateway/src/main.js', '// main\n'),
                      ('gateway/Dockerfile', 'FROM x\n'), ('gateway/.env.example', 'SPOTIFY_CLIENT_ID=\n'),
                      # the prebuilt images' files (DESIGN-DOCKER-IMAGES 7.3): exported, the compose file an asset
                      (rc.COMPOSE_SRC, '# made-up compose file\nservices:\n  gateway:\n    image: example/bridge\n'),
                      ('.github/scripts/smoke-images.sh', '#!/bin/sh\necho "smoke: OK"\n'),
                      ('.github/scripts/compose.smoke.yaml', 'services:\n  gateway:\n    restart: "no"\n'),
                      # an old checkout's Cydia source folder: none of it is exported any more
                      ('gateway/repo/README.md', '# the old Cydia source folder\n'),
                      ('gateway/repo/debs/Stray_1.0_iphoneos-arm.deb', deb_bytes('1.0')),
                      ('gateway/repo/CydiaIcon.png', png_bytes())]:
        write(os.path.join(wc, *rel.split('/')), body)
    deb = os.path.join(tmp, 'built', 'anything.deb')
    write(deb, deb_bytes(ver))
    deny = os.path.join(tmp, 'release-deny.txt')
    write(deny, '[server] ' + 'Example' + 'VaultServer\n')
    name = 'Encore_%s_iphoneos-arm.deb' % ver
    probe, probe_out = os.path.join(tmp, 'probe', 'winprobe.py'), os.path.join(tmp, 'probe', 'winprobe.txt')
    write(probe, WINDOWS_PROBE)

    out = os.path.join(tmp, 'rel-ok')
    old = os.environ.get('ENCORE_DEB')
    os.environ['ENCORE_DEB'] = 'stale'      # whatever the caller's environment holds, the Windows build never gets it
    try:
        code, steps, text = release_run(['--out', out, '--repo', wc, '--skip', 'gpl', '--deb-file', deb,
                                         '--denylist', deny, '--windows-cmd',
                                         ' '.join(quote_arg(x) for x in (sys.executable, probe, probe_out))]
                                        + (['--sign-key', keys['key']] if keys else []))
    finally:
        if old is None:
            os.environ.pop('ENCORE_DEB', None)
        else:
            os.environ['ENCORE_DEB'] = old
    order = [st for st, _ in steps]
    res = dict(steps)
    check('release: trial run with a deb passes', code == 0, text)
    check('release: no step "repo"', 'repo' not in order, order)
    main_order = [st for st in order if st in ('export', 'deb', 'source', 'compose', 'windows', 'gpl', 'docker', 'sums')]
    check('release: export, deb, source, compose, windows, gpl, docker, sums in that order',
          main_order == ['export', 'deb', 'source', 'compose', 'windows', 'gpl', 'docker', 'sums'], order)
    check('release: the compose step ran', res.get('compose') == 'ok', steps)
    check('release: the windows step ran (--windows-cmd)', res.get('windows') == 'ok', steps)
    tree = os.path.join(out, 'source', 'Encore-%s' % ver)
    check('export: no gateway/repo/ in the exported tree', not os.path.exists(os.path.join(tree, 'gateway', 'repo')),
          rc.tree_files(os.path.join(tree, 'gateway')))
    check('export: no deb in the exported tree', not any(f.lower().endswith('.deb') for f in rc.tree_files(tree)))
    with open(os.path.join(out, 'reports', 'MANIFEST.txt'), encoding='utf-8') as f:
        man = f.read()
    check('MANIFEST: nothing added after the export', 'added by release.py' not in man and 'gateway/repo' not in man, man)
    with tarfile.open(os.path.join(out, 'assets', 'Encore-%s-source.tar.gz' % ver), 'r:gz') as t:
        members = t.getnames()
    check('source: the archive holds no deb and no gateway/repo/',
          not any(m.endswith('.deb') or '/gateway/repo' in m for m in members), members)
    check('deb: the release deb is an asset, byte for byte',
          rc.sha256_file(os.path.join(out, 'assets', name)) == rc.sha256_file(deb))
    with open(os.path.join(out, 'assets', 'SHA256SUMS.txt'), encoding='utf-8') as f:
        sums = f.read()
    check('sums: the deb asset is listed', ('%s  %s' % (rc.sha256_file(deb), name)) in sums, sums)
    check('sums: the Windows asset is listed', 'EncoreBridge-%s-win64.zip' % ver in sums, sums)
    compose_asset = os.path.join(out, 'assets', rc.COMPOSE_ASSET)
    check('compose: %s is the tree\'s %s byte for byte' % (rc.COMPOSE_ASSET, rc.COMPOSE_SRC),
          os.path.isfile(compose_asset) and rc.sha256_file(compose_asset)
          == rc.sha256_file(os.path.join(wc, *rc.COMPOSE_SRC.split('/'))))
    check('sums: the compose asset is listed (unversioned name)',
          os.path.isfile(compose_asset) and ('%s  %s' % (rc.sha256_file(compose_asset), rc.COMPOSE_ASSET)) in sums, sums)
    check('reports: the compose asset was scanned', os.path.isfile(os.path.join(out, 'reports', 'scan-compose.txt')))
    try:
        with open(probe_out, encoding='utf-8') as f:
            seen = f.read()
    except OSError:
        seen = ''
    check('windows: ENCORE_DEB is not passed to the Windows build', 'ENCORE_DEB=absent' in seen, seen)
    check('windows: no deb on its command line', 'args=' in seen and '.deb' not in seen, seen)
    check('reports: no scan-repo report', not os.path.exists(os.path.join(out, 'reports', 'scan-repo.txt')))
    if keys:
        check_release_signing(tmp, wc, deny, out, order, res, text, keys)

    # --skip deb: just skipped, no warning about bridge packages without the app
    out2 = os.path.join(tmp, 'rel-nodeb')
    code, steps, text = release_run(['--out', out2, '--repo', wc, '--skip', 'deb,windows,gpl', '--denylist', deny])
    res = dict(steps)
    check('release: --skip deb passes, the deb step skipped, no repo step',
          code == 0 and res.get('deb') == 'skipped' and 'repo' not in res, text)
    check('release: a trial without --sign-key never signs (a warning, no .sig, ENCORE_SIGN_KEY unused)',
          res.get('sign') == 'warning' and not os.path.exists(os.path.join(out2, 'assets', rc.SIG_NAME)), steps)
    with open(os.path.join(out2, 'reports', 'scan-source.txt'), encoding='utf-8') as f:
        check('release: its scans say the release key was not checked', 'release key: not checked' in f.read())
    # without docker/compose.yaml: a trial run warns, a --final run fails (DESIGN-DOCKER-IMAGES 7.2)
    wc2 = os.path.join(tmp, 'wc-nocompose')
    shutil.copytree(wc, wc2)
    os.unlink(os.path.join(wc2, *rc.COMPOSE_SRC.split('/')))
    out4 = os.path.join(tmp, 'rel-nocompose')
    code, steps, text = release_run(['--out', out4, '--repo', wc2, '--skip', 'deb,windows,gpl', '--denylist', deny])
    res = dict(steps)
    check('release: a trial run without %s warns and goes on (no compose asset)' % rc.COMPOSE_SRC,
          code == 0 and res.get('compose') == 'warning' and not os.path.exists(os.path.join(out4, 'assets',
                                                                                             rc.COMPOSE_ASSET)), text)
    tree4 = os.path.join(out4, 'source', 'Encore-%s' % ver)
    os.makedirs(os.path.join(tmp, 'compose-final'))
    got = release.compose_step(tree4, os.path.join(tmp, 'compose-final'), True)
    check('release: in a --final run a missing %s fails the compose step' % rc.COMPOSE_SRC,
          got[0] == 'FAIL' and got[2] is None and not os.listdir(os.path.join(tmp, 'compose-final')), got)
    code, steps, text = release_run(['--out', os.path.join(tmp, 'rel-skipcompose'), '--repo', wc, '--skip',
                                     'deb,windows,gpl,compose', '--denylist', deny])
    check('release: --skip compose in a trial run', code == 0 and dict(steps).get('compose') == 'skipped', text)
    if keys:
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = release.main(['--out', os.path.join(tmp, 'rel-final-skip'), '--repo', wc, '--final', '--skip',
                                 'compose', '--sign-key', keys['key']])
        check('release: --final refuses --skip compose', code == 2 and 'only docker may be skipped' in err.getvalue(),
              err.getvalue())
    with contextlib.redirect_stderr(io.StringIO()):
        code = release.main(['--out', os.path.join(tmp, 'rel-final'), '--repo', wc, '--final', '--deb-file', deb])
    check('release: --final refuses --deb-file', code == 2, code)
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        code = release.main(['--out', os.path.join(tmp, 'rel-final-nokey'), '--repo', wc, '--final'])
    check('release: --final without a release key is a usage error before any work',
          code == 2 and 'ENCORE_SIGN_KEY' in err.getvalue() and not os.path.exists(os.path.join(tmp, 'rel-final-nokey')),
          err.getvalue())
    check('release: the repo step\'s helpers are gone',
          not hasattr(release, 'repo_step') and not hasattr(release, 'manifest_add') and not hasattr(rc, 'deb_control'))
    return tree


def check_bundle_checks(tmp, tree):
    """The Windows static check and the Docker smoke test: no Cydia source, no deb (DESIGN-WIZARD 5.6, 6.5, 7)."""
    check('windows: the setup guide\'s gateway files are clientid.js, netcheck.js, wizard.js',
          tuple(build_windows.GATEWAY_WIZARD_FILES) == ('gateway/src/clientid.js', 'gateway/src/netcheck.js',
                                                        'gateway/src/wizard.js'), build_windows.GATEWAY_WIZARD_FILES)
    cases = (('a payload without a Cydia source', [], [], True),
             ('a gateway/repo/ folder', ['gateway/repo/README.md'], [], False),
             ('an empty gateway/repo/ folder', [], ['gateway/repo'], False),
             ('a deb anywhere', ['extras/Encore_9.9.9_iphoneos-arm.deb'], [], False))
    for n, (label, extra, dirs, ok) in enumerate(cases):
        stage = os.path.join(tmp, 'stage%d' % n)
        for rel in ['gateway/src/main.js', 'gateway/src/wizard.js'] + extra:
            write(os.path.join(stage, *rel.split('/')), 'x\n')
        for d in dirs:
            os.makedirs(os.path.join(stage, *d.split('/')), exist_ok=True)
        lines, problems = [], []

        def need(cond, what):
            if not cond:
                problems.append(what)
        build_windows.no_app_package_checks(stage, rc.tree_files(stage), need, lines)
        check('windows static check: %s %s' % (label, 'passes' if ok else 'fails'), (not problems) == ok, problems)
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        try:
            code = build_windows.main(['--tree', tree, '--out', os.path.join(tmp, 'w-out'), '--deb', 'x.deb'])
        except SystemExit as e:
            code = e.code
    check('windows: build_windows.py has no --deb any more',
          code == 2 and 'unrecognized arguments: --deb' in err.getvalue(), err.getvalue())
    check('docker smoke: checks that the image has no /app/repo',
          'test ! -e /app/repo' in docker_smoke.SMOKE_SH and '/app/repo/debs' not in docker_smoke.SMOKE_SH
          and not hasattr(docker_smoke, 'expected_debs'))
    with tarfile.open(fileobj=io.BytesIO(docker_smoke.make_tar(tree)), mode='r:gz') as t:
        names = t.getnames()
    check('docker smoke: the copied sources hold no deb list and no gateway/repo/',
          'expect-debs.txt' not in names and not any('/repo/' in m or m.endswith('.deb') for m in names), names)
    check('docker smoke: the copied sources hold docker/compose.yaml, smoke-images.sh and compose.smoke.yaml',
          all('tree/' + rel in names for rel in docker_smoke.PREBUILT_FILES)
          and set(docker_smoke.PREBUILT_FILES) == {rc.COMPOSE_SRC, '.github/scripts/smoke-images.sh',
                                                   '.github/scripts/compose.smoke.yaml'}, names)
    bare = os.path.join(tmp, 'smoke-bare-tree')
    write(os.path.join(bare, 'gateway', 'Dockerfile'), 'FROM x\n')
    try:
        docker_smoke.make_tar(bare)
        msg = ''
    except SystemExit as e:
        msg = str(e)
    check('docker smoke: a tree without the prebuilt files fails with a clear message',
          'docker/compose.yaml' in msg and 'smoke-images.sh' in msg, msg)
    sh = docker_smoke.SMOKE_SH
    check('docker smoke: builds the prebuilt images (ENCORE_PREBUILT=1, ENCORE_VERSION) and runs smoke-images.sh on '
          'the shipped compose file',
          '$D build --build-arg ENCORE_PREBUILT=1 -t "$PGW" tree/gateway' in sh
          and '$D build --build-arg ENCORE_VERSION="$VER" -t "$PEN" tree/gateway/engine-src' in sh
          and 'sh tree/.github/scripts/smoke-images.sh "$D" "release-smoke-$TAG" "$VER" tree/docker/compose.yaml '
              'tree/.github/scripts/compose.smoke.yaml tree/gateway/engine/config.yml' in sh
          and '%s:release-smoke-$TAG' % rc.IMAGES[0] in sh and '%s:release-smoke-$TAG' % rc.IMAGES[1] in sh, sh)
    check('docker smoke: the source build isn\'t marked as a prebuilt image',
          'test "${ENCORE_PREBUILT:-}" != 1' in sh and '$D build -t "$GW" tree/gateway' in sh)

    # the working copy's own Docker build and allowlist
    try:
        with open(os.path.join(rc.REPO_ROOT, 'gateway', 'Dockerfile'), encoding='utf-8') as f:
            dockerfile = f.read()
    except OSError:
        dockerfile = None
    check('gateway/Dockerfile: no Cydia source (/app/repo)', dockerfile is not None and '/app/repo' not in dockerfile
          and not re.search(r'(?im)^\s*COPY\b.*\brepo', dockerfile or ''))
    with open(rc.EXPORT_ALLOWLIST_DEFAULT, encoding='utf-8') as f:
        allow = [l.strip() for l in f if l.strip() and not l.lstrip().startswith('#')]
    check('export allowlist: no gateway/repo/', not any('gateway/repo' in l for l in allow), allow)
    check('working copy: no gateway/repo/ folder', not os.path.exists(os.path.join(rc.REPO_ROOT, 'gateway', 'repo')))


def app_repo_problems(config_text, docs, admin_html):
    """[problem] for the Encore repo address (DESIGN-WIZARD 3.2, 7, 9): config_text = gateway/src/config.js, docs =
    {'README.md' / 'docs/...md': text}, admin_html = gateway/src/admin.html (None when missing). Problems name the file,
    never the address."""
    m = APP_REPO_RX.search(config_text or '')
    if not m:
        return ["gateway/src/config.js: no DEFAULT_APP_REPO = '<address>' line (DESIGN-WIZARD 3.2)"]
    default, problems = m.group(1), []
    for label in TUTORIALS:
        if label not in docs:
            problems.append('%s is missing' % label)
            continue
        try:
            block = shared_block(docs[label], label)
        except ValueError as e:
            problems.append(str(e))
            continue
        if default not in block:
            problems.append('%s: the shared phone block doesn\'t give the Encore repo address (DEFAULT_APP_REPO)' % label)
    for label in ('docs/GUIDE.md', 'README.md'):
        if label not in docs:
            problems.append('%s is missing' % label)
        elif default not in docs[label]:
            problems.append('%s doesn\'t give the Encore repo address (DEFAULT_APP_REPO)' % label)
    for label in sorted(docs):
        for n, line in enumerate(docs[label].splitlines(), 1):
            for hit in PAGES_RX.finditer(line):
                if hit.group(0).rstrip('.,;:!?') != default:
                    problems.append('%s line %d: a github.io address that isn\'t DEFAULT_APP_REPO' % (label, n))
    if admin_html is None:
        problems.append('gateway/src/admin.html is missing')
    else:
        if '/repo/' in admin_html:
            problems.append('gateway/src/admin.html still has a /repo/ address (the bridge hosts no Cydia source)')
        if IPCHECK_URL_RX.search(admin_html):
            problems.append('gateway/src/admin.html has a public-IP service URL (only the bridge contacts them)')
    return problems


def check_app_repo():
    """The repo-address check on fixtures, then on the working copy."""
    addr = 'https://' + 'example' + 'owner.github.io/slopkit/'
    conf = "'use strict';\nconst DEFAULT_APP_REPO = '%s';\nmodule.exports = { DEFAULT_APP_REPO };\n" % addr
    block = '%s\nIn Cydia add %s, then install Encore.\n%s\n' % (SHARED_BEGIN, addr, SHARED_END)
    good = {'README.md': 'Add the Encore repo (%s) in Cydia.\n' % addr,
            'docs/GUIDE.md': 'The repo: `%s`. Type it exactly: %s.\n' % (addr, addr),
            TUTORIALS[0]: 'Windows\n' + block, TUTORIALS[1]: 'Docker\n' + block}
    page = '<p>Encore Bridge asks a public IP-check service (api.ipify.org, or a backup) only when you press it.</p>'
    check('repo address: matching config, docs and page pass', not app_repo_problems(conf, good, page),
          app_repo_problems(conf, good, page))

    def bad(label, docs=None, config=conf, html=page, want=''):
        got = app_repo_problems(config, dict(good, **(docs or {})), html)
        check('repo address: %s fails' % label, any(want in p for p in got), got)
    bad('no DEFAULT_APP_REPO line', config="const REPO = '%s';\n" % addr, want='gateway/src/config.js')
    bad('a guide without it', {'docs/GUIDE.md': 'Add the repo in Cydia.\n'}, want='docs/GUIDE.md')
    bad('a README without it', {'README.md': 'Install Encore.\n'}, want='README.md')
    bad('a shared block without it', {TUTORIALS[1]: '%s\nAdd the repo.\n%s\n' % (SHARED_BEGIN, SHARED_END)},
        want=TUTORIALS[1])
    bad('the address without its final /', {'docs/FAQ.md': 'See %s\n' % addr.rstrip('/')}, want='docs/FAQ.md line 1')
    bad('another github.io address', {'README.md': good['README.md'] + 'Or https://someone.github.io/repo/\n'},
        want='README.md line 2')
    bad('a /repo/ address in the page', html=page + '<p>http://<address>:8095/repo/</p>', want='/repo/')
    bad('a public-IP service URL in the page', html=page + "<script>fetch('https://api.ipify.org/')</script>",
        want='public-IP service')

    root = rc.REPO_ROOT

    def read(rel):
        try:
            with open(os.path.join(root, *rel.split('/')), encoding='utf-8') as f:
                return f.read()
        except OSError:
            return None
    docs = {}
    for rel in ['README.md'] + ['docs/' + p for p in md_files(os.path.join(root, 'docs'))]:
        text = read(rel)
        if text is not None:
            docs[rel] = text
    problems = app_repo_problems(read('gateway/src/config.js'), docs, read('gateway/src/admin.html'))
    check('repo address: config.js, README.md, docs/ and admin.html agree', not problems, '; '.join(problems))


def md_files(folder):
    out = []
    for dirpath, dirnames, filenames in os.walk(folder):
        dirnames.sort()
        for fn in sorted(filenames):
            if fn.lower().endswith('.md'):
                out.append(os.path.relpath(os.path.join(dirpath, fn), folder).replace(os.sep, '/'))
    return out


def check_shared_tutorials():
    """The phone block shared by the two tutorials is byte-identical (DESIGN-WIZARD 9), on fixtures and on docs/."""
    same = 'intro\n%s\nPhone steps\n%s\nend\n' % (SHARED_BEGIN, SHARED_END)
    check('shared block: identical blocks pass', not shared_problems({'a': same.encode(), 'b': ('other ' + same).encode()}))
    check('shared block: a changed block fails',
          bool(shared_problems({'a': same.encode(), 'b': same.replace('Phone', 'phone').encode()})))
    check('shared block: a missing marker fails', bool(shared_problems({'a': same.encode(), 'b': b'no markers\n'})))
    files, missing = {}, []
    for rel in TUTORIALS:
        try:
            with open(os.path.join(rc.REPO_ROOT, *rel.split('/')), 'rb') as f:
                files[rel] = f.read()
        except OSError:
            missing.append(rel)
    problems = shared_problems(files) if not missing else ['missing: %s' % ', '.join(missing)]
    check('shared block: %s and %s' % TUTORIALS, not problems, '; '.join(problems))


# --------------------------------------------------------------------------------------------------------------------
# Release signing (DESIGN-UPDATES 4, 13). Throwaway keys only, made in the temporary folder.

def capture(fn, argv):
    """fn(argv) with stdout and stderr captured: (exit code, output)."""
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        try:
            code = fn(argv)
        except SystemExit as e:
            code = e.code
    return code, out.getvalue()


def secret_forms(key_path):
    """Every text form of a throwaway key's private material (to prove no output repeats it), its seed and DER."""
    with open(key_path, 'rb') as f:
        data = f.read()
    seed, der = rc.ed25519_private_der(data)
    forms = [seed.hex(), seed.hex().upper(), base64.b64encode(seed).decode()[:40],
             base64.urlsafe_b64encode(seed).decode()[:40], base64.b64encode(der).decode()[24:60]]
    forms += [l for l in data.decode('ascii').splitlines() if l and not l.startswith('-----')]
    return forms, seed, der


def leaks(text, forms):
    return [f[:4] + '...' for f in forms if f and f in text]


def trust_files(root, js_entries, go_entries=None, ids=None):
    """Write gateway/src/updatekeys.js and the launcher's keys.go in the formats of DESIGN-UPDATES 4.5 for
    [(raw public key, name)]; ids overrides the key ids (to test a wrong one)."""
    def kid(i, raw):
        return ids[i] if ids else rc.key_id(raw)
    items = ', '.join("{ id: '%s', key: '%s', name: '%s', added: '2026-10-10' }"
                      % (kid(i, r), base64.b64encode(r).decode(), n) for i, (r, n) in enumerate(js_entries))
    write(os.path.join(root, *rc.UPDATE_KEYS_JS.split('/')),
          "'use strict';\n// test keys\nmodule.exports = Object.freeze([%s]);\n" % items)
    rows = ''.join('\t{ID: "%s", Key: "%s", Name: "%s"},\n' % (kid(i, r), base64.b64encode(r).decode(), n)
                   for i, (r, n) in enumerate(go_entries if go_entries is not None else js_entries))
    write(os.path.join(root, *rc.UPDATE_KEYS_GO.split('/')),
          'package update\n\n// test keys\nvar TrustedKeys = []Key{\n%s}\n' % rows)


def check_signing(tmp):
    """signkey.py and the Ed25519 primitives. Returns the throwaway keys {key, pub, pubfile, forms, key2, pub2} or
    None when the cryptography package is missing."""
    if not sign.have_crypto():
        check('signing: the cryptography package is installed (needed by signkey.py and sign.py)', False, sign.NEED_CRYPTO)
        return None
    kdir = os.path.join(tmp, 'keys', '_keys')
    key = os.path.join(kdir, 'encore-release-selftest.key')
    code, out = capture(signkey.main, ['generate', '--key', key])
    made = code == 0 and os.path.isfile(key) and os.path.isfile(key[:-4] + '.pub')
    check('signkey: generate makes the key pair', made, out)
    if not made:
        return None
    forms, seed, der = secret_forms(key)
    pub = sign.load_public(key[:-4] + '.pub')
    check('signkey: generate prints the public key and its id, nothing private',
          not leaks(out, forms) and rc.key_id(pub) in out and base64.b64encode(pub).decode() in out, leaks(out, forms))
    check('signkey: the key file and its _keys folder are owner-only',
          signkey.is_owner_only(key) and signkey.is_owner_only(kdir, folder=True))
    with open(key, 'rb') as f:
        before = hashlib.sha256(f.read()).hexdigest()
    code, out = capture(signkey.main, ['generate', '--key', key])
    with open(key, 'rb') as f:
        after = hashlib.sha256(f.read()).hexdigest()
    check('signkey: generate never overwrites a key', code == 1 and before == after, out)
    inside = os.path.join(rc.REPO_ROOT, 'encore-release-selftest.key')
    code, out = capture(signkey.main, ['generate', '--key', inside])
    check('signkey: refuses a key inside the working copy', code == 2 and not os.path.exists(inside), out)
    code, out = capture(signkey.main, ['generate', '--key', os.path.join(tmp, 'keys', 'mykey.pem')])
    check('signkey: refuses a file name the never-ship rules don\'t know', code == 2, out)
    if os.name == 'nt':   # elsewhere the file is created with mode 0600 from the start
        open_key = os.path.join(tmp, 'keys', 'plain', 'encore-release-selftest-open.key')
        os.makedirs(os.path.dirname(open_key), exist_ok=True)
        code, out = capture(signkey.main, ['generate', '--key', open_key])
        check('signkey: on Windows refuses a folder that isn\'t _keys and isn\'t owner-only (the key would first get '
              'its access rules)', code == 2 and not os.path.exists(open_key)
              and not os.path.exists(open_key[:-4] + '.pub'), out)
    code, out = capture(signkey.main, ['public', '--key', key, '--format', 'id'])
    check('signkey: public --key gives the .pub\'s key id, nothing private',
          code == 0 and out.strip() == rc.key_id(pub) and not leaks(out, forms), out)
    code, out = capture(signkey.main, ['public', '--pub', key[:-4] + '.pub', '--format', 'js'])
    js_keys, js_probs = rc.parse_trust_list('module.exports = Object.freeze([%s]);' % out.strip(), 'js')
    code2, out2 = capture(signkey.main, ['public', '--pub', key[:-4] + '.pub', '--format', 'go'])
    go_keys, go_probs = rc.parse_trust_list('var TrustedKeys = []Key{\n\t%s,\n}' % out2.strip(), 'go')
    check('signkey: its js and go entries parse as trust lists with this key',
          code == code2 == 0 and not js_probs and not go_probs and js_keys[0]['raw'] == go_keys[0]['raw'] == pub,
          (js_probs, go_probs))
    rfc = sign.crypto()[1].from_private_bytes(RFC_TEST1_SEED)
    check('sign: RFC 8032 TEST 1 gives the RFC\'s signature (PureEdDSA, as the clients verify)',
          sign.raw_public(rfc) == rc.RFC8032_TEST_PUBLIC_KEYS[0] and sign.sign_bytes(rfc, b'') == RFC_TEST1_SIG_EMPTY
          and sign.verify(rc.RFC8032_TEST_PUBLIC_KEYS[0], b'', RFC_TEST1_SIG_EMPTY)
          and not sign.verify(rc.RFC8032_TEST_PUBLIC_KEYS[0], b'x', RFC_TEST1_SIG_EMPTY))
    key2 = os.path.join(kdir, 'encore-release-selftest-2.key')
    code, out = capture(signkey.main, ['generate', '--key', key2])
    check('signkey: a second throwaway key', code == 0, out)
    forms2 = secret_forms(key2)[0] if code == 0 else []
    return {'key': key, 'pub': pub, 'pubfile': key[:-4] + '.pub', 'forms': forms + forms2, 'key2': key2,
            'pub2': sign.load_public(key2[:-4] + '.pub') if code == 0 else b''}


def check_trust_lists(tmp):
    """The trust-list parser (relcommon.read_trust_lists) on fixtures: made-up 32-byte keys, no cryptography."""
    a, b = bytes(range(32)), bytes(range(32, 64))
    cases = [('one key in both lists', [(a, 'encore-release-1')], None, None, ''),
             ('two keys (a rotation)', [(a, 'encore-release-1'), (b, 'encore-release-2')], None, None, ''),
             ('unequal lists', [(a, 'encore-release-1')], [(b, 'encore-release-1')], None, 'different keys'),
             ('the same key, other names', [(a, 'encore-release-1')], [(a, 'encore-release-2')], None, 'different keys'),
             ('an RFC 8032 test key', [(rc.RFC8032_TEST_PUBLIC_KEYS[0], 'encore-release-1')], None, None, 'RFC 8032'),
             ('a wrong key id', [(a, 'encore-release-1')], None, ['0123456789abcdef'], 'is not the key id'),
             ('four keys', [(bytes([i]) * 32, 'k%d' % i) for i in range(4)], None, None, 'at most 3'),
             ('a key listed twice', [(a, 'k1'), (a, 'k2')], None, None, 'listed twice'),
             ('an empty list', [], None, None, 'empty')]
    for n, (label, js, go, ids, want) in enumerate(cases):
        root = os.path.join(tmp, 'trust%d' % n)
        trust_files(root, js, go, ids)
        _, _, problems = rc.read_trust_lists(root)
        ok = (not problems) if not want else any(want in p for p in problems)
        check('trust lists: %s %s' % (label, 'pass' if not want else 'fail'), ok, problems)
    _, _, problems = rc.read_trust_lists(os.path.join(tmp, 'no-trust'))
    check('trust lists: missing files fail', len([p for p in problems if 'missing' in p]) == 2, problems)


def check_sign_flow(tmp, keys):
    """sign.py and checksums.py on a synthetic assets folder."""
    forms = keys['forms']
    tree = os.path.join(tmp, 'sign-tree')
    trust_files(tree, [(keys['pub'], 'encore-release-1')])

    def assets_folder(name):
        d = os.path.join(tmp, name)
        write(os.path.join(d, 'EncoreBridge-9.9.9-win64.zip'), b'PK\x05\x06' + b'\x00' * 18)
        write(os.path.join(d, 'Encore-9.9.9-source.tar.gz'), gzip.compress(b'made-up'))
        os.makedirs(os.path.join(d, 'EncoreBridge-9.9.9-windows-payload'))   # a folder: never listed or signed
        capture(checksums.main, [d])
        return d
    d = assets_folder('sign-assets')
    code, out = capture(sign.main, [d, '--key', keys['key'], '--tree', tree])
    sums_path, sig_path = os.path.join(d, rc.SUMS_NAME), os.path.join(d, rc.SIG_NAME)
    with open(sums_path, 'rb') as f:
        sums = f.read()
    sig = open(sig_path, 'rb').read() if os.path.isfile(sig_path) else b''
    check('sign: signs SHA256SUMS.txt with a listed key (64 raw bytes that verify)',
          code == 0 and len(sig) == 64 and sign.verify(keys['pub'], sums, sig)
          and ('sign: %s (key %s)' % (rc.SIG_NAME, rc.key_id(keys['pub']))) in out, out)
    check('sign: prints nothing private', not leaks(out, forms), leaks(out, forms))
    code, out = capture(checksums.main, [d, '--check'])
    check('checksums: --check passes and doesn\'t report the .sig as NOT LISTED', code == 0 and 'NOT LISTED' not in out, out)
    code, out = capture(checksums.main, [d, '--check', '--pubkey', keys['pubfile']])
    check('checksums: --check --pubkey verifies the signature', code == 0 and '%s: OK' % rc.SIG_NAME in out, out)
    code, out = capture(checksums.main, [d])
    with open(sums_path, 'rb') as f:
        check('checksums: a new list never lists the .sig or itself', code == 0 and f.read() == sums)
    code, out = capture(sign.main, [d, '--key', keys['key'], '--tree', tree])
    check('sign: never overwrites a .sig', code == 2 and open(sig_path, 'rb').read() == sig, out)
    with open(sums_path, 'ab') as f:
        f.write(b'\n')
    code, out = capture(checksums.main, [d, '--check', '--pubkey', keys['pubfile']])
    check('checksums: --check --pubkey fails on a changed list', code == 1 and '%s: FAILED' % rc.SIG_NAME in out, out)

    d2 = assets_folder('sign-unlisted')
    code, out = capture(sign.main, [d2, '--key', keys['key2'], '--tree', tree])
    check('sign: refuses a key outside the trust lists', code == 1 and not os.path.exists(os.path.join(d2, rc.SIG_NAME)), out)
    code, out = capture(sign.main, [d2, '--key', keys['key2'], '--tree', tree, '--trial'])
    sig2 = os.path.join(d2, rc.SIG_NAME)
    check('sign: --trial signs with it, with a warning (exit 3)',
          code == 3 and 'warning' in out and os.path.isfile(sig2)
          and sign.verify(keys['pub2'], open(os.path.join(d2, rc.SUMS_NAME), 'rb').read(), open(sig2, 'rb').read()), out)
    # a trial never signs with a real release key: here the synthetic tree stands in for the working copy, so the
    # throwaway key is "real" for this run
    d6 = assets_folder('sign-trial-real')
    saved_root = rc.REPO_ROOT
    rc.REPO_ROOT = tree
    try:
        code, out = capture(sign.main, [d6, '--key', keys['key'], '--tree', tree, '--trial'])
    finally:
        rc.REPO_ROOT = saved_root
    check('sign: --trial refuses a key the working copy\'s own trust lists hold (a real release key)',
          code == 2 and 'real release key' in out and not os.path.exists(os.path.join(d6, rc.SIG_NAME)), out)
    d3 = assets_folder('sign-rfc')
    rfc_key = os.path.join(tmp, 'keys', 'encore-release-rfc.key')
    ser = sign.crypto()[0]
    write(rfc_key, sign.crypto()[1].from_private_bytes(RFC_TEST1_SEED).private_bytes(
        ser.Encoding.PEM, ser.PrivateFormat.PKCS8, ser.NoEncryption()))
    trust_files(os.path.join(tmp, 'rfc-tree'), [(rc.RFC8032_TEST_PUBLIC_KEYS[0], 'encore-release-1')])
    code, out = capture(sign.main, [d3, '--key', rfc_key, '--tree', os.path.join(tmp, 'rfc-tree'), '--trial'])
    check('sign: refuses an RFC 8032 test key, even in a trial', code == 2 and not os.path.exists(os.path.join(d3, rc.SIG_NAME)),
          out)
    d4 = assets_folder('sign-crlf')
    with open(os.path.join(d4, rc.SUMS_NAME), 'rb') as f:
        data = f.read()
    with open(os.path.join(d4, rc.SUMS_NAME), 'wb') as f:
        f.write(data.replace(b'\n', b'\r\n'))
    code, out = capture(sign.main, [d4, '--key', keys['key'], '--tree', tree])
    check('sign: refuses a list the clients would reject (CRLF)', code == 1 and 'CR' in out
          and not os.path.exists(os.path.join(d4, rc.SIG_NAME)), out)
    d5 = assets_folder('sign-changed')
    write(os.path.join(d5, 'Encore-9.9.9-source.tar.gz'), b'changed after the sums step')
    code, out = capture(sign.main, [d5, '--key', keys['key'], '--tree', tree])
    check('sign: refuses a list that doesn\'t match the assets', code == 1 and 'doesn\'t match' in out
          and not os.path.exists(os.path.join(d5, rc.SIG_NAME)), out)
    code, out = capture(sign.main, [assets_folder('sign-missing'), '--key', os.path.join(tmp, 'nope.key'), '--tree', tree])
    check('sign: a missing key is a usage error', code == 2, out)


def check_scanner_keys(tmp, keys):
    """The scanner on a planted throwaway key: generic Ed25519 rules, and the release key's own material."""
    forms, seed, der = secret_forms(keys['key'])
    with open(keys['key'], 'rb') as f:
        pem = f.read()
    t = os.path.join(tmp, 'keyscan')
    write(os.path.join(t, 'notes', 'pem.txt'), b'pasted by mistake:\n' + pem)
    write(os.path.join(t, 'notes', 'b64.txt'), 'const k = "%s";\n' % base64.b64encode(der).decode())
    write(os.path.join(t, 'notes', 'hex.txt'), 'seed = %s\nSEED = %s\n' % (seed.hex(), seed.hex().upper()))
    write(os.path.join(t, 'notes', 'seed64.txt'), 'a %s b\nc %s d\n' % (
        base64.urlsafe_b64encode(seed).decode().rstrip('='), base64.b64encode(seed + keys['pub']).decode()))
    write(os.path.join(t, 'bin', 'raw.dat'), b'\x00\x01\x02' + seed + b'\x00\xff')
    zbuf = io.BytesIO()
    with zipfile.ZipFile(zbuf, 'w') as z:
        z.writestr('in/blob.bin', b'\x00\x01' + der + b'\x00')
    write(os.path.join(t, 'pkg.zip'), zbuf.getvalue())
    write(os.path.join(t, 'pkg.tar.gz'), tar_bytes([('in/blob.bin', b'\x00' + der)], 'gz'))
    write(os.path.join(t, 'clean', 'updatekeys.js'), "module.exports = Object.freeze([{ id: '%s', key: '%s' }]);\n"
          % (rc.key_id(keys['pub']), base64.b64encode(keys['pub']).decode()))

    def by_path(findings):
        out = collections.defaultdict(list)
        for x in findings:
            out[x['path']].append(x['rule'])
        return out
    sc = scan.Scanner([], [], scan.load_scan_allow(rc.SCAN_ALLOW_DEFAULT))
    sc.scan_path(t)
    p = by_path(sc.findings)
    check('scan: a planted Ed25519 key as PEM (header + PKCS#8 body)',
          {'private-key', 'ed25519-pkcs8'} <= set(p.get('notes/pem.txt', [])), p.get('notes/pem.txt'))
    check('scan: as PKCS#8 base64', 'ed25519-pkcs8' in p.get('notes/b64.txt', []), p.get('notes/b64.txt'))
    check('scan: as DER inside a zip and a tar', 'ed25519-pkcs8-der' in p.get('pkg.zip!in/blob.bin', [])
          and 'ed25519-pkcs8-der' in p.get('pkg.tar.gz!pkg.tar!in/blob.bin', []), dict(p))
    check('scan: the public key list is clean', 'clean/updatekeys.js' not in p, p.get('clean/updatekeys.js'))
    check('scan: without --sign-key a bare seed isn\'t recognised (that is what --sign-key adds)',
          not any(k in p for k in ('notes/hex.txt', 'notes/seed64.txt', 'bin/raw.dat')), dict(p))
    sc = scan.Scanner([], [], scan.load_scan_allow(rc.SCAN_ALLOW_DEFAULT),
                      release_keys=[scan.release_key_needles(keys['key'])])
    sc.scan_path(t)
    p = by_path(sc.findings)
    rk = scan.RELEASE_KEY_RULE
    check('scan --sign-key: the seed as hex (lower and upper case)', p.get('notes/hex.txt', []).count(rk) == 2,
          p.get('notes/hex.txt'))
    check('scan --sign-key: the seed as base64 (URL-safe, unpadded; and followed by the public key)',
          p.get('notes/seed64.txt', []).count(rk) == 2, p.get('notes/seed64.txt'))
    check('scan --sign-key: the raw seed in a binary', rk in p.get('bin/raw.dat', []), p.get('bin/raw.dat'))
    check('scan --sign-key: the PKCS#8 forms (PEM, base64, DER in archives)',
          all(rk in p.get(k, []) for k in ('notes/pem.txt', 'notes/b64.txt', 'pkg.zip!in/blob.bin',
                                             'pkg.tar.gz!pkg.tar!in/blob.bin')), dict(p))
    check('scan --sign-key: key findings keep no value',
          all(x['value'] is None for x in sc.findings if x['rule'] in scan.NEVER_REVEAL))
    rep, js = os.path.join(tmp, 'keyscan-report.txt'), os.path.join(tmp, 'keyscan-report.json')
    code, out = capture(scan.main, ['--no-denylist', '--sign-key', keys['key'], '--show-matches', '--reveal-generic',
                                    '--report', rep, '--json', js, t])
    with open(rep, encoding='utf-8') as f:
        report = f.read()
    with open(js, encoding='utf-8') as f:
        report_json = f.read()
    check('scan --sign-key: exit 1 and the header names the key id',
          code == 1 and 'release key: checked (key %s)' % rc.key_id(keys['pub']) in report, report[:400])
    found = leaks(out + report + report_json, forms)
    check('scan: the console, the report and the JSON never contain the key (not even with --show-matches)',
          not found, found)
    code, out = capture(scan.main, ['--no-denylist', '--final', t])
    check('scan --final: needs the release key (usage error without one)', code == 2, out)
    code, out = capture(scan.main, ['--no-denylist', '--final', '--no-sign-key', t])
    check('scan --final: refuses --no-sign-key', code == 2, out)
    code, out = capture(scan.main, ['--no-denylist', '--quiet', os.path.join(t, 'clean')])
    check('scan: without a key the header says "release key: not checked"', code == 0 and 'release key: not checked' in out
          and 'result  : CLEAN' in out, out)
    write(os.path.join(tmp, 'notakey.key'), b'not a key\n')
    code, out = capture(scan.main, ['--no-denylist', '--sign-key', os.path.join(tmp, 'notakey.key'), t])
    check('scan: an unreadable --sign-key is a usage error', code == 2, out)


def check_never_ship_keys(tmp):
    """The release key's folder and file names never ship (relcommon, export.py, scan.py)."""
    for rel in ('_keys/encore-release-ed25519.key', 'Releases/_keys/encore-release-ed25519.pub',
                'x/_keys/README.txt', 'gateway/windows/encore-release-ed25519-2.key'):
        check('never ship: %s' % rel, bool(rc.forbidden_reason(rel)), rc.forbidden_reason(rel))
    check('never ship: the public trust list is fine', rc.forbidden_reason(rc.UPDATE_KEYS_JS) is None)
    repo = os.path.join(tmp, 'keyrepo')
    for rel, body in [('app/control', 'Package: x\nVersion: 9.9.9\n'), ('gateway/src/config.js', "  version: '9.9.9',\n"),
                      ('gateway/windows/_keys/encore-release-ed25519.key', 'made-up\n'),
                      ('gateway/windows/_keys/encore-release-ed25519.pub', 'made-up\n'),
                      ('gateway/windows/_keys/notes.txt', 'made-up\n'),
                      ('gateway/windows/stray/encore-release-x.key', 'made-up\n'),
                      ('gateway/windows/README-Windows.txt', 'ok\n')]:
        write(os.path.join(repo, *rel.split('/')), body)
    out = os.path.join(tmp, 'keyexport')
    code = export.main(['--repo', repo, '--out', out, '--manifest', os.path.join(tmp, 'KM.txt'),
                        '--log', os.path.join(tmp, 'KL.txt')])
    got = rc.tree_files(out)
    check('export: skips _keys/ and encore-release-*.key (allowlisted folder or not)',
          code == 0 and 'gateway/windows/README-Windows.txt' in got
          and not any('_keys' in g or g.endswith('.key') for g in got), got)
    sc = scan.Scanner([], [], [])
    sc.scan_path(repo)
    names = {x['path'] for x in sc.findings if x['category'] == 'FILENAME'}
    check('scan: a _keys/ folder and a release key name fail',
          'gateway/windows/_keys/' in names and 'gateway/windows/stray/encore-release-x.key' in names, names)


def check_release_signing(tmp, wc, deny, out, order, res, text, keys):
    """The sign step of the trial run above (a throwaway key the synthetic trust lists hold), and one with a key they
    don't hold."""
    check('release: sign runs right after sums', 'sign' in order and order.index('sign') == order.index('sums') + 1, order)
    check('release: sign ok with a listed key', res.get('sign') == 'ok', text)
    assets = os.path.join(out, 'assets')
    sig = os.path.join(assets, rc.SIG_NAME)
    ok = os.path.isfile(sig) and sign.verify(keys['pub'], open(os.path.join(assets, rc.SUMS_NAME), 'rb').read(),
                                             open(sig, 'rb').read())
    check('release: SHA256SUMS.txt.sig is an asset and verifies', ok)
    with open(os.path.join(out, 'reports', 'release-summary.txt'), encoding='utf-8') as f:
        summary = f.read()
    check('release: summary line "sign ok SHA256SUMS.txt.sig (key <id>)"',
          re.search(r'(?m)^sign +ok +%s \(key %s\)$' % (re.escape(rc.SIG_NAME), rc.key_id(keys['pub'])), summary), summary)
    reports = ''
    for fn in sorted(os.listdir(os.path.join(out, 'reports'))):
        with open(os.path.join(out, 'reports', fn), encoding='utf-8', errors='replace') as f:
            reports += f.read()
    check('release: every scan checked the release key', reports.count('release key: checked') >= 3
          and 'release key: not checked' not in reports)
    check('release: the logs name the key as <sign-key>, never its folder', '<sign-key>' in reports
          and os.path.dirname(keys['key']) not in reports and os.path.dirname(keys['key']).replace('\\', '/') not in reports)
    check('release: no report holds the key\'s material', not leaks(reports, keys['forms']), leaks(reports, keys['forms']))
    check('release: the key never lands in the output', not any(f.endswith(('.key', '.pub'))
                                                                for f in rc.tree_files(out)))
    out3 = os.path.join(tmp, 'rel-otherkey')
    code, steps, text = release_run(['--out', out3, '--repo', wc, '--skip', 'deb,windows,gpl', '--denylist', deny,
                                     '--sign-key', keys['key2']])
    res3 = dict(steps)
    check('release: a trial with a key outside the trust lists signs with a warning',
          code == 0 and res3.get('sign') == 'warning' and os.path.isfile(os.path.join(out3, 'assets', rc.SIG_NAME)), text)
    inside = os.path.join(wc, 'encore-release-inside.key')
    shutil.copyfile(keys['key2'], inside)
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        code = release.main(['--out', os.path.join(tmp, 'rel-inside'), '--repo', wc, '--sign-key', inside])
    os.unlink(inside)
    check('release: refuses a key inside the working copy', code == 2, err.getvalue())


def check_windows_update_checks(tmp):
    """build_windows.update_checks on fixtures: trust lists, the launcher's keys and test hooks, the installer script."""
    check('windows: the payload needs update.js and updatekeys.js',
          tuple(build_windows.GATEWAY_UPDATE_FILES) == ('gateway/src/update.js', 'gateway/src/updatekeys.js'))
    a = bytes(range(32))
    iss_ok = '[Run]\n; ENCOREUPDATE=1 mode\nParameters: "--updated"\n; --update-failed from DeinitializeSetup\n'
    good_exe = b'MZ\x00\x00' + base64.b64encode(a) + b'\x00--updated\x00--update-failed\x00'
    cases = (('a release launcher', good_exe, iss_ok, True),
             ('a launcher without the key', b'MZ\x00\x00--updated\x00', iss_ok, False),
             ('a launcher with a test hook', good_exe + b'ENCORE_UPDATE_TEST_KEY\x00', iss_ok, False),
             ('a launcher with --update-test', good_exe + b'--update-test\x00', iss_ok, False),
             ('a launcher with a UTF-16 test hook', good_exe + 'ENCORE_UPDATE_API'.encode('utf-16-le'), iss_ok, False),
             ('an installer without --update-failed', good_exe, iss_ok.replace('--update-failed', ''), False))
    for n, (label, exe, iss, ok) in enumerate(cases):
        tree, stage = os.path.join(tmp, 'wu-tree%d' % n), os.path.join(tmp, 'wu-stage%d' % n)
        trust_files(tree, [(a, 'encore-release-1')])
        write(os.path.join(tree, *build_windows.INSTALLER_ISS.split('/')), iss)
        shutil.copytree(os.path.join(tree, 'gateway'), os.path.join(stage, 'gateway'))
        write(os.path.join(stage, 'Encore Bridge.exe'), exe)
        lines, problems = [], []

        def need(cond, what):
            if not cond:
                problems.append(what)
        build_windows.update_checks(tree, stage, os.path.join(stage, 'Encore Bridge.exe'), need, lines)
        check('windows static check (updates): %s %s' % (label, 'passes' if ok else 'fails'), (not problems) == ok,
              problems)


def check_update_wiring():
    """The working copy: trust lists, shared vectors, the repo constant and the release links (DESIGN-UPDATES 13)."""
    root = rc.REPO_ROOT
    js, go, problems = rc.read_trust_lists(root)
    check('trust lists: %s and %s valid, equal, at most %d keys, no RFC 8032 test key'
          % (rc.UPDATE_KEYS_JS, rc.UPDATE_KEYS_GO, rc.MAX_TRUSTED_KEYS), not problems, '; '.join(problems))
    if REAL_PUB and os.path.isfile(REAL_PUB[0]) and sign.have_crypto():
        try:
            raw = sign.load_public(REAL_PUB[0])
        except sign.SignError as e:
            raw = None
            check('trust lists: the release key\'s .pub is readable', False, str(e))
        if raw is not None:
            check('trust lists: both hold the release key (ENCORE_SIGN_KEY\'s .pub, key %s)' % rc.key_id(raw),
                  any(k['raw'] == raw for k in js) and any(k['raw'] == raw for k in go))
    else:
        print('note no ENCORE_SIGN_KEY .pub here: the release key\'s place in the trust lists is not checked')

    def read(rel):
        try:
            with open(os.path.join(root, *rel.split('/')), 'rb') as f:
                return f.read()
        except OSError:
            return None
    # the published key block ("Release signing") names keys of the embedded list (a replaced key must be replaced
    # there too, tools/release/README.md)
    listed = {k['raw']: k['id'] for k in js}
    bad_docs = []
    for rel in KEY_DOCS:
        data = read(rel)
        text = data.decode('utf-8', 'replace') if data else ''
        blocks = PEM_PUB_RX.findall(text)
        if not blocks:
            bad_docs.append('%s: no public key block' % rel)
        for b in blocks:
            try:
                der = base64.b64decode(''.join(b.split()), validate=True)
            except ValueError:
                der = b''
            if len(der) != 44 or der[-32:] not in listed:
                bad_docs.append('%s: a key block that isn\'t in %s' % (rel, rc.UPDATE_KEYS_JS))
        for kid in KEY_ID_RX.findall(text):
            if kid not in listed.values():
                bad_docs.append('%s: key id %s isn\'t in %s' % (rel, kid, rc.UPDATE_KEYS_JS))
    check('docs: the public key blocks and key ids in %s are keys of the embedded trust list' % ', '.join(KEY_DOCS),
          not bad_docs, '; '.join(bad_docs))
    v = [read(rel) for rel in VECTORS]
    check('update vectors: %s and %s are byte-identical' % VECTORS, v[0] is not None and v[0] == v[1],
          'missing' if None in v else 'they differ')
    js_src, go_src = read(UPDATE_JS), read(UPDATE_GO)
    mj = REPO_CONST_JS.search(js_src.decode('utf-8')) if js_src else None
    mg = REPO_CONST_GO.search(go_src.decode('utf-8')) if go_src else None
    check('repo: UPDATE_REPO (%s) and Repo (%s) are the same' % (UPDATE_JS, UPDATE_GO),
          bool(mj and mg) and mj.group(1) == mg.group(1) and mj.group(1).count('/') == 1,
          'missing' if not (mj and mg) else 'they differ')
    if not mj:
        return
    repo = mj.group(1)
    bad = []
    for rel in ['README.md', 'CHANGELOG.md', 'gateway/src/admin.html'] + ['docs/' + p for p in
                                                                        md_files(os.path.join(root, 'docs'))]:
        data = read(rel)
        if data is None:
            continue
        for n, line in enumerate(data.decode('utf-8', 'replace').splitlines(), 1):
            for m in RELEASE_LINK_RX.finditer(line):
                if m.group(1) != repo:
                    bad.append('%s line %d' % (rel, n))
    check('repo: every GitHub release link in README.md, CHANGELOG.md, docs/ and admin.html names UPDATE_REPO',
          not bad, ', '.join(bad))


# --------------------------------------------------------------------------------------------------------------------
# Docker images (DESIGN-DOCKER-IMAGES 7.5): the prebuilt compose file, the workflow and its scripts, the bridge's
# update card and the docs agree. Each check is a function of file texts, tried on fixtures first.

WORKFLOW = '.github/workflows/docker-images.yml'
SCRIPTS = '.github/scripts'
IMAGE_PLAN = SCRIPTS + '/image_plan.py'
BUILD_IMAGES = SCRIPTS + '/build-images.sh'
GPL_CHECK = SCRIPTS + '/check_gpl_bundle.py'
ENTRYPOINT ='gateway/engine-src/encore-docker/entrypoint.sh'
IMAGE_CONFIG = 'gateway/engine-src/encore-docker/config.yml'
DEFAULT_CONFIG = 'gateway/engine/config.yml'
SOURCE_COMPOSE = 'gateway/compose.yaml'
GHCR_RX = re.compile(r'ghcr\.io/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+')
NO_HASH_RX = re.compile(r'(?i)sha-?256|checksum|\bhash')
USES_RX = re.compile(r'^\s*(?:-\s+)?uses:\s*(\S+)(.*)$')
PINNED_USES_RX = re.compile(r'^[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}$')
RUN_EXPR_RX = re.compile(r'\$\{\{\s*(?:github\.event\.|inputs\.)')
# the BuildKit image the workflow's builder runs (privileged, with the push credentials): pinned by digest
BUILDKIT_RX = re.compile(r'(?m)^\s+BUILDKIT_IMAGE:\s*[A-Za-z0-9._/-]+(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}\s*(?:#.*)?$')
IMAGE_CMDS_RX = re.compile(r'\bUPD_IMAGE_CMDS\s*=\s*\[([^\]]*)\]')
JS_STR_RX = r"""(['"])((?:(?!\1)[^\\]|\\.)*)\1"""
CARD_STRINGS = ('image_intro', 'image_pin', 'image_ui')


def image_owner():
    return rc.IMAGES[0].split('/')[1]


def js_unescape(s):
    return re.sub(r'\\(.)', lambda m: {'n': '\n', 't': '\t'}.get(m.group(1), m.group(1)), s)


def yaml_lines(text):
    """(indent, content) of every line that isn't blank or a whole-line comment, trailing comments cut (the files
    checked here carry no '#' inside values)."""
    out = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        content = re.sub(r'\s+#.*$', '', line.rstrip())
        out.append((len(line) - len(line.lstrip(' ')), content.strip()))
    return out


def compose_services(text):
    """{service: {'keys': {key: value}, 'items': [list items]}} of a compose file's services: (line based)."""
    services, cur, in_services = {}, None, False
    for indent, content in yaml_lines(text):
        if indent == 0:
            in_services = content == 'services:'
            cur = None
            continue
        if not in_services:
            continue
        if indent == 2 and content.endswith(':'):
            cur = services.setdefault(content[:-1], {'keys': {}, 'items': []})
        elif cur is not None and content.startswith('- '):
            cur['items'].append(content[2:].strip().strip('"\''))
        elif cur is not None and indent == 4 and ':' in content:
            k, v = content.split(':', 1)
            cur['keys'][k.strip()] = v.strip().strip('"\'')
    return services


def image_name_problems(texts, update_repo):
    """texts: {label: text or None}. Every ghcr.io name is one of rc.IMAGES, the compose file and the workflow's env:
    name both, and the images' owner is the update check's (UPDATE_REPO)."""
    problems = []
    for label in sorted(texts):
        text = texts[label]
        if text is None:
            if label in (rc.COMPOSE_SRC, WORKFLOW):
                problems.append('%s is missing' % label)
            continue
        for n, line in enumerate(text.splitlines(), 1):
            for m in GHCR_RX.finditer(line):
                if m.group(0).rstrip('.') not in rc.IMAGES:
                    problems.append('%s line %d: an image name that isn\'t one of rc.IMAGES' % (label, n))
    compose, workflow = texts.get(rc.COMPOSE_SRC), texts.get(WORKFLOW)
    for img in rc.IMAGES:
        if compose is not None and img + ':' not in compose:
            problems.append('%s doesn\'t name %s' % (rc.COMPOSE_SRC, img))
        if workflow is not None and not re.search(r'(?m)^\s+[A-Z_]+:\s*%s\s*$' % re.escape(img), workflow):
            problems.append('%s: its env: doesn\'t name %s' % (WORKFLOW, img))
    owners = {img.split('/')[1] for img in rc.IMAGES}
    if owners != {update_repo.split('/')[0]}:
        problems.append('the images\' owner isn\'t UPDATE_REPO\'s owner')
    return problems


def compose_file_problems(text, source_text):
    """The prebuilt compose file (DESIGN-DOCKER-IMAGES 3) against gateway/compose.yaml's names."""
    problems = []
    svc, src = compose_services(text), compose_services(source_text or '')
    content = [c for _, c in yaml_lines(text)]
    for word in ('build:', 'env_file', 'pull_policy'):
        if any(word in c for c in content):
            problems.append('%s has %s' % (rc.COMPOSE_SRC, word.rstrip(':')))
    want = {'gateway': (rc.IMAGES[0], ['./data:/data', './pipe:/pipe']),
            'engine': (rc.IMAGES[1], ['./engine:/config', './pipe:/pipe'])}
    for name, (img, vols) in want.items():
        s = svc.get(name)
        if not s:
            problems.append('%s: no service %s' % (rc.COMPOSE_SRC, name))
            continue
        k = s['keys']
        if k.get('image') != img + ':${ENCORE_TAG:-latest}':
            problems.append('%s: %s\'s image isn\'t %s:${ENCORE_TAG:-latest}' % (rc.COMPOSE_SRC, name, img))
        if k.get('network_mode') != 'host':
            problems.append('%s: %s doesn\'t use network_mode: host' % (rc.COMPOSE_SRC, name))
        if k.get('restart') != 'unless-stopped':
            problems.append('%s: %s isn\'t restart: unless-stopped' % (rc.COMPOSE_SRC, name))
        for v in vols:
            if v not in s['items']:
                problems.append('%s: %s has no volume %s' % (rc.COMPOSE_SRC, name, v))
        theirs = src.get(name, {}).get('keys', {}).get('container_name')
        if not k.get('container_name') or k.get('container_name') != theirs:
            problems.append('%s: %s\'s container_name isn\'t %s\'s (%s)' % (rc.COMPOSE_SRC, name, SOURCE_COMPOSE, theirs))
    extra = sorted(set(svc) - set(want))
    if extra:
        problems.append('%s: other services: %s' % (rc.COMPOSE_SRC, ', '.join(extra)))
    return problems


def workflow_problems(text):
    """The workflow's triggers, permissions, pinned actions, secrets and run: blocks (DESIGN-DOCKER-IMAGES 4.2)."""
    problems = []
    lines = text.splitlines()
    if not re.search(r'(?m)^on:\s*$', text) or not re.search(r'(?m)^\s+release:\s*$', text) \
            or not re.search(r'(?m)^\s+types:\s*\[\s*released\s*\]\s*(?:#.*)?$', text):
        problems.append('%s: not triggered by release types: [released]' % WORKFLOW)
    if not re.search(r'(?m)^\s+workflow_dispatch:\s*$', text):
        problems.append('%s: no workflow_dispatch' % WORKFLOW)
    if not re.search(r'(?m)^permissions:\s*\{\s*\}\s*$', text):
        problems.append('%s: the top-level permissions aren\'t {}' % WORKFLOW)
    for i, line in enumerate(lines):
        m = re.match(r'^(\s+)permissions:\s*(.*?)\s*(?:#.*)?$', line)
        if not m:
            continue
        if m.group(2):
            problems.append('%s line %d: job permissions must be a block (contents: read / packages: write)' % (WORKFLOW, i + 1))
            continue
        ind = len(m.group(1))
        for j in range(i + 1, len(lines)):
            ln = lines[j]
            if not ln.strip() or ln.lstrip().startswith('#'):
                continue
            if len(ln) - len(ln.lstrip(' ')) <= ind:
                break
            perm = re.sub(r'\s+#.*$', '', ln).strip()
            if perm not in ('contents: read', 'packages: write'):
                problems.append('%s line %d: permission "%s" (only contents: read, packages: write)' % (WORKFLOW, j + 1, perm))
    for n, line in enumerate(lines, 1):
        if line.lstrip().startswith('#'):
            continue
        m = USES_RX.match(line)
        if m and not (PINNED_USES_RX.match(m.group(1)) and re.match(r'^\s+#\s*v\d', m.group(2))):
            problems.append('%s line %d: uses: isn\'t owner/repo@<40 hex> # vN' % (WORKFLOW, n))
    for name in set(re.findall(r'\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)', text)) - {'GITHUB_TOKEN'}:
        problems.append('%s: uses secrets.%s (only secrets.GITHUB_TOKEN)' % (WORKFLOW, name))
    if 'pull_request_target' in text:
        problems.append('%s: pull_request_target' % WORKFLOW)
    i = 0
    while i < len(lines):
        m = re.match(r'^(\s*)(?:-\s+)?run:\s*(.*)$', lines[i])
        if not m or lines[i].lstrip().startswith('#'):
            i += 1
            continue
        ind, block = len(m.group(1)), [m.group(2)]
        j = i + 1
        if m.group(2).strip() in ('|', '>', '|-', '>-'):
            while j < len(lines) and (not lines[j].strip() or len(lines[j]) - len(lines[j].lstrip(' ')) > ind):
                block.append(lines[j])
                j += 1
        if any(RUN_EXPR_RX.search(b) for b in block):
            problems.append('%s line %d: ${{ github.event.* }} or ${{ inputs.* }} inside a run: block (use env:)'
                            % (WORKFLOW, i + 1))
        i = j
    if not BUILDKIT_RX.search(text):
        problems.append('%s: BUILDKIT_IMAGE isn\'t pinned by digest (<image>:<tag>@sha256:<64 hex>)' % WORKFLOW)
    for n, line in enumerate(lines, 1):
        if 'buildx create' in line and not line.lstrip().startswith('#') and 'image=${BUILDKIT_IMAGE}' not in line:
            problems.append('%s line %d: buildx create without image=${BUILDKIT_IMAGE}' % (WORKFLOW, n))
    for needle in ('ubuntu-24.04-arm', 'build-images.sh', 'smoke-images.sh', 'check_gpl_bundle.py'):
        if needle not in text:
            problems.append('%s: no %s' % (WORKFLOW, needle))
    return problems


def build_script_problems(build_sh, gateway_dockerfile, config_js, engine_dockerfile):
    problems = []
    if build_sh is None or 'ENCORE_PREBUILT=1' not in build_sh or 'ENCORE_VERSION' not in build_sh:
        problems.append('%s doesn\'t pass ENCORE_PREBUILT=1 (bridge) and ENCORE_VERSION (engine)' % BUILD_IMAGES)
    g = gateway_dockerfile or ''
    if not re.search(r'(?m)^ARG ENCORE_PREBUILT=\s*$', g) or not re.search(r'(?m)^ENV ENCORE_PREBUILT=\$\{ENCORE_PREBUILT\}\s*$', g):
        problems.append('gateway/Dockerfile: no ARG ENCORE_PREBUILT= / ENV ENCORE_PREBUILT=${ENCORE_PREBUILT}')
    if 'ENCORE_PREBUILT' not in (config_js or ''):
        problems.append('gateway/src/config.js doesn\'t read ENCORE_PREBUILT')
    e = engine_dockerfile or ''
    for f in ('encore-docker/config.yml', 'encore-docker/entrypoint.sh'):
        if not re.search(r'(?m)^COPY\s+%s\s' % re.escape(f), e):
            problems.append('gateway/engine-src/Dockerfile doesn\'t copy %s' % f)
    return problems


def card_strings(admin_html):
    """{name: text} of the four new strings of the update card and the setup guide (DESIGN-DOCKER-IMAGES 5.3)."""
    out = {}
    for name in CARD_STRINGS:
        m = re.search(r'get %s\(\)\s*\{\s*return T\(%s' % (name, JS_STR_RX), admin_html or '')
        if m:
            out[name] = js_unescape(m.group(2))
    m = re.search(r'T\((([\'"])(In Dockge or Portainer(?:(?!\2)[^\\]|\\.)*)\2)', admin_html or '')
    if m:
        out['setup_log'] = js_unescape(m.group(3))
    return out


def card_docs_problems(admin_html, update_js, guide, readme, tutorial, update_repo):
    """The update card's commands are the guide's; the compose asset's name is the same everywhere."""
    problems = []
    m = IMAGE_CMDS_RX.search(admin_html or '')
    cmds = [js_unescape(x[1]) for x in re.findall(JS_STR_RX, m.group(1))] if m else []
    if not cmds:
        problems.append('gateway/src/admin.html: no UPD_IMAGE_CMDS')
    else:
        g = guide or ''
        a = g.find('### Bridge on Docker')
        b = min([x for x in (g.find('\n### ', a + 1), g.find('\n## ', a + 1)) if x > 0] or [len(g)])
        if a < 0 or ' &&\n'.join(cmds) not in g[a:b]:
            problems.append('docs/GUIDE.md "Bridge on Docker" doesn\'t show the card\'s commands (UPD_IMAGE_CMDS)')
    m = re.search(r"\bCOMPOSE_ASSET\s*=\s*'([^']+)'", update_js or '')
    if not m or m.group(1) != rc.COMPOSE_ASSET:
        problems.append('gateway/src/update.js: COMPOSE_ASSET isn\'t %s' % rc.COMPOSE_ASSET)
    url = 'https://github.com/%s/releases/latest/download/%s' % (update_repo, rc.COMPOSE_ASSET)
    for label, text in (('README.md', readme), ('docs/TUTORIAL-DOCKER.md', tutorial)):
        if url not in (text or ''):
            problems.append('%s doesn\'t download %s from releases/latest/download/' % (label, rc.COMPOSE_ASSET))
    return problems


def no_hash_problems(texts):
    """{label: text}: none of them may talk about SHA-256, checksums or hashes."""
    return ['%s talks about hashes ("%s")' % (label, m.group(0)) for label, text in sorted(texts.items())
            for m in [NO_HASH_RX.search(text or '')] if m]


def image_plan_problems(script, tmp):
    """.github/scripts/image_plan.py through its command line, on synthetic release lists (DESIGN-DOCKER-IMAGES 4.4)."""
    if not os.path.isfile(script):
        return ['%s is missing' % IMAGE_PLAN]
    import json
    import subprocess
    owner = image_owner()
    repo, sha = owner + '/encore', '0123456789abcdef' * 2 + '01234567'

    def rel(v, kind='final', drop=()):
        names = ['Encore-%s-source.tar.gz' % v, 'Encore-%s-gpl-source.tar.gz' % v, rc.COMPOSE_ASSET,
                 'EncoreBridge-%s-setup.exe' % v, rc.SUMS_NAME, rc.SIG_NAME]
        return {'tag_name': 'v' + v, 'draft': kind == 'draft', 'prerelease': kind == 'pre',
                'assets': [n for n in names if not any(d in n for d in drop)]}
    r130, r131, r140 = rel('1.3.0'), rel('1.3.1'), rel('1.4.0')
    cases = [  # label, event, tag, push, config version, releases, repo, exit, tags (None: not checked)
        ('the newest final release', 'release', 'v1.4.0', 'true', '1.4.0', [r130, r140], repo, 0, 'v1.4.0 1.4 latest'),
        ('a rebuild of v1.3.0 after v1.4.0', 'workflow_dispatch', 'v1.3.0', 'true', '1.3.0', [r130, r140], repo, 0,
         'v1.3.0 1.3'),
        ('a rebuild of v1.3.0 after v1.3.1', 'workflow_dispatch', 'v1.3.0', 'true', '1.3.0', [r130, r131], repo, 0,
         'v1.3.0'),
        ('a pre-release and a draft never count', 'workflow_dispatch', 'v1.3.0', 'true', '1.3.0',
         [r130, rel('1.4.0', 'pre'), rel('1.5.0', 'draft')], repo, 0, 'v1.3.0 1.3 latest'),
        ('a pre-release can\'t be pushed', 'workflow_dispatch', 'v1.4.0', 'true', '1.4.0', [r130, rel('1.4.0', 'pre')],
         repo, 1, None),
        ('a draft can\'t be pushed', 'workflow_dispatch', 'v1.5.0', 'true', '1.5.0', [r130, rel('1.5.0', 'draft')],
         repo, 1, None),
        ('v1.3.0-rc1 with push', 'workflow_dispatch', 'v1.3.0-rc1', 'true', '1.3.0', [r130], repo, 1, None),
        ('a tag that isn\'t config.js\'s version', 'release', 'v1.3.0', 'true', '1.2.1', [r130], repo, 1, None),
        ('v1.2.1 (below 1.3.0)', 'release', 'v1.2.1', 'true', '1.2.1', [rel('1.2.1')], repo, 1, None),
        ('no GPL bundle yet', 'release', 'v1.3.0', 'true', '1.3.0', [rel('1.3.0', drop=('gpl-source',))], repo, 3, None),
        ('no compose file yet', 'release', 'v1.3.0', 'true', '1.3.0', [rel('1.3.0', drop=(rc.COMPOSE_ASSET,))], repo, 3,
         None),
        ('another repo with push', 'release', 'v1.3.0', 'true', '1.3.0', [r130], 'someone/encore', 1, None),
        ('a dry run without a tag', 'workflow_dispatch', '', 'false', '1.3.0', [], repo, 0, ''),
    ]
    problems = []
    for n, (label, event, tag, push, cfg_v, releases, rp, want_code, want_tags) in enumerate(cases):
        d = os.path.join(tmp, 'plan%d' % n)
        write(os.path.join(d, 'config.js'), "module.exports = {\n  version: '%s',\n};\n" % cfg_v)
        write(os.path.join(d, 'releases.ndjson'), ''.join(json.dumps(r) + '\n' for r in releases))
        r = subprocess.run([sys.executable, '-B', script, '--event', event, '--tag', tag, '--push', push, '--sha', sha,
                            '--repo', rp, '--config', os.path.join(d, 'config.js'),
                            '--releases', os.path.join(d, 'releases.ndjson')],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, err = r.stdout.decode('utf-8', 'replace'), r.stderr.decode('utf-8', 'replace')
        got = dict(l.split('=', 1) for l in out.splitlines() if '=' in l)
        ok = r.returncode == want_code
        if ok and want_code == 1:
            ok = err.strip().startswith('image_plan: ')
        if ok and want_tags is not None:
            ok = sorted(got.get('tags', '').split()) == sorted(want_tags.split())
            if want_code == 0 and push == 'true':
                v = tag[1:]
                ok = ok and got.get('version') == v and got.get('ref') == tag and got.get('push') == 'true' and \
                    got.get('source_url') == 'https://github.com/%s/releases/download/%s/Encore-%s-source.tar.gz' % (
                        repo, tag, v) and \
                    got.get('gpl_url') == 'https://github.com/%s/releases/download/%s/Encore-%s-gpl-source.tar.gz' % (
                        repo, tag, v)
            if want_code == 0 and push == 'false':
                ok = ok and got.get('ref') == sha and got.get('version') == cfg_v and got.get('push') == 'false' \
                    and not got.get('source_url') and not got.get('gpl_url')
        if not ok:
            problems.append('image_plan: %s: exit %d, %s' % (label, r.returncode, (out + err).strip()[-300:]))
    return problems


def gpl_check_problems(script, tmp):
    """.github/scripts/check_gpl_bundle.py on bundles written like gpl_bundle.py's (rc.write_tar_gz)."""
    if not os.path.isfile(script):
        return ['%s is missing' % GPL_CHECK]
    import subprocess
    base = os.path.join(tmp, 'gplcheck')
    src = {'LICENSE': 'GPL-3.0\n', 'go.mod': 'module x\n', 'cmd/daemon/main.go': 'package main\n',
           'encore-docker/entrypoint.sh': '#!/bin/sh\nexec "$@"\n'}

    def case(n, tree_files, bundle_files, vendor=True, engine=True):
        d = os.path.join(base, 'c%d' % n)
        for rel, data in tree_files.items():
            write(os.path.join(d, 'tree', *rel.split('/')), data)
        os.makedirs(os.path.join(d, 'tree'), exist_ok=True)
        pre = 'Encore-1.3.0-gpl-source'
        members = [(pre + '/README-SOURCE.md', 'README-SOURCE.md'), (pre + '/windows/build.sh', 'windows/build.sh')]
        if vendor:
            members.append((pre + '/engine/vendor/modules.txt', 'vendor/modules.txt'))
        if engine:
            members += [(pre + '/engine/' + rel, 'b/' + rel) for rel in sorted(bundle_files)]
        for rel, data in [('README-SOURCE.md', '# source\n'), ('windows/build.sh', '#!/bin/sh\n'),
                          ('vendor/modules.txt', '# x v1\n')] + [('b/' + r, v) for r, v in bundle_files.items()]:
            write(os.path.join(d, 'files', *rel.split('/')), data)
        out = os.path.join(d, 'bundle.tar.gz')
        rc.write_tar_gz(out, [(name, os.path.join(d, 'files', *path.split('/'))) for name, path in members])
        r = subprocess.run([sys.executable, '-B', script, out, os.path.join(d, 'tree')],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return r.returncode, (r.stdout + r.stderr).decode('utf-8', 'replace')
    changed = dict(src, **{'cmd/daemon/main.go': 'package main // changed\n'})
    extra = dict(src, **{'cmd/daemon/late_fix.go': 'package main\n'})
    missing = {k: v for k, v in src.items() if k != 'go.mod'}
    with_vendor = dict(src, **{'vendor/modules.txt': '# y v2\n'})
    cases = [  # label, tree, bundle, vendor, engine, exit, text in the output
        ('the same files', src, src, True, True, 0, '(4 files)'),
        ('a vendor/ folder in the tree is left out', with_vendor, src, True, True, 0, '(4 files)'),
        ('a changed file', changed, src, True, True, 1, 'cmd/daemon/main.go differs'),
        ('a file only in the source', extra, src, True, True, 1, 'cmd/daemon/late_fix.go is in the source'),
        ('a file only in the bundle', missing, src, False, True, 1, 'engine/go.mod is in the GPL bundle'),
        ('a bundle without engine/', src, src, False, False, 1, 'no engine/ folder'),
    ]
    problems = []
    for n, (label, tree_files, bundle_files, vendor, engine, want, text) in enumerate(cases):
        code, out = case(n, tree_files, bundle_files, vendor, engine)
        if code != want or text not in out:
            problems.append('check_gpl_bundle: %s: exit %d, %s' % (label, code, out.strip()[-300:]))
    r = subprocess.run([sys.executable, '-B', script], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if r.returncode != 2:
        problems.append('check_gpl_bundle: no arguments: exit %d (want 2)' % r.returncode)
    return problems


def docker_fixtures():
    """Good fixture texts for the Docker checks, from the design (made-up commit ids)."""
    bridge, engine = rc.IMAGES
    compose = (
        '# Encore Bridge on Docker, from prebuilt images.\n'
        '# Settings go into a .env file next to this file.\n'
        'services:\n'
        '  gateway:\n'
        '    image: %s:${ENCORE_TAG:-latest}\n'
        '    container_name: encore-gateway\n'
        '    network_mode: host\n'
        '    restart: unless-stopped\n'
        '    environment:\n'
        '      PORT: "8095"\n'
        '      SPOTIFY_CLIENT_ID: ${SPOTIFY_CLIENT_ID:-}\n'
        '    volumes:\n'
        '      - ./data:/data\n'
        '      - ./pipe:/pipe\n'
        '\n'
        '  engine:\n'
        '    image: %s:${ENCORE_TAG:-latest}\n'
        '    container_name: encore-engine\n'
        '    network_mode: host\n'
        '    restart: unless-stopped\n'
        '    depends_on: [gateway]\n'
        '    volumes:\n'
        '      - ./engine:/config\n'
        '      - ./pipe:/pipe\n'
        '      # - /run/dbus/system_bus_socket:/run/dbus/system_bus_socket\n') % (bridge, engine)
    source = ('services:\n  gateway:\n    build: .\n    container_name: encore-gateway   # the bridge\n'
              '  engine:\n    build: ./engine-src\n    container_name: encore-engine\n')
    pin = 'a1b2c3d4e5' * 4
    workflow = (
        '# builds %s and %s\n'
        'name: Docker images\n'
        'on:\n'
        '  release:\n'
        '    types: [released]          # final releases only\n'
        '  workflow_dispatch:\n'
        '    inputs:\n'
        '      tag:\n'
        '        type: string\n'
        'permissions: {}\n'
        'env:\n'
        '  BRIDGE_IMAGE: %s\n'
        '  ENGINE_IMAGE: %s\n'
        '  BUILDKIT_IMAGE: moby/buildkit:v0.33.0@sha256:%s\n'
        'jobs:\n'
        '  plan:\n'
        '    runs-on: ubuntu-24.04\n'
        '    permissions:\n'
        '      contents: read\n'
        '    steps:\n'
        '      - name: Check out\n'
        '        uses: actions/checkout@%s # v7.0.1\n'
        '        with:\n'
        '          ref: ${{ github.event.release.tag_name || inputs.tag || github.sha }}\n'
        '      - name: Plan\n'
        '        env:\n'
        '          TAG: ${{ github.event.release.tag_name || inputs.tag }}\n'
        '        run: |\n'
        '          python3 .github/scripts/image_plan.py --tag "$TAG"\n'
        '      - run: python3 .github/scripts/check_gpl_bundle.py "$RUNNER_TEMP/gpl/bundle.tar.gz" gateway/engine-src\n'
        '  build:\n'
        '    strategy:\n'
        '      matrix:\n'
        '        include:\n'
        '          - runner: ubuntu-24.04-arm\n'
        '    runs-on: ${{ matrix.runner }}\n'
        '    permissions:\n'
        '      contents: read\n'
        '      packages: write\n'
        '    steps:\n'
        '      - run: docker buildx create --driver docker-container --driver-opt "image=${BUILDKIT_IMAGE}" --use\n'
        '      - run: bash .github/scripts/build-images.sh load\n'
        '      - run: sh .github/scripts/smoke-images.sh docker ci-smoke "$VERSION"\n'
        '      - name: Log in\n'
        '        env:\n'
        '          REGISTRY_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n'
        '        run: printf \'%%s\' "$REGISTRY_TOKEN" | docker login ghcr.io --password-stdin\n') % (
        bridge, engine, bridge, engine, 'ab12' * 16, pin)
    build_sh = ('#!/bin/bash\n$DOCKER buildx build --build-arg ENCORE_PREBUILT=1 gateway\n'
                '$DOCKER buildx build --build-arg "ENCORE_VERSION=$VERSION" gateway/engine-src\n')
    gw_docker = 'FROM node:22-bookworm-slim\nARG ENCORE_PREBUILT=\nENV ENCORE_PREBUILT=${ENCORE_PREBUILT}\n'
    config_js = "prebuiltImage: platformKind === 'docker' && truthy(env.ENCORE_PREBUILT),\n"
    en_docker = ('FROM alpine:3.23\nCOPY encore-docker/config.yml /usr/share/encore/config.yml\n'
                 'COPY encore-docker/entrypoint.sh /usr/share/encore/entrypoint.sh\n')
    admin = ("  get image_intro() { return T('Encore Bridge doesn\\'t update itself on Docker. Update it in the folder "
             "with your <code>compose.yaml</code>:'); },\n"
             "  get image_pin() { return T('If your <code>.env</code> sets <code>ENCORE_TAG</code>, set it to "
             "<code>v{v}</code> first.'); },\n"
             "  get image_ui() { return T('<b>Dockge:</b> press <b>Update</b>.'); },\n"
             "const UPD_IMAGE_CMDS = ['docker compose pull', 'docker compose up -d'];   // never translated\n"
             "h += T('In Dockge or Portainer, look for \"setup code\" in the log of the <code>encore-gateway</code> "
             "container.');\n")
    update_js = "const COMPOSE_ASSET = '%s';\n" % rc.COMPOSE_ASSET
    url = 'https://github.com/%s/encore/releases/latest/download/%s' % (image_owner(), rc.COMPOSE_ASSET)
    guide = ('## 12. Updating\n\n### Bridge on Docker\n\n```sh\ndocker compose pull &&\ndocker compose up -d\n```\n\n'
             '### Update the app\n')
    return {'compose': compose, 'source': source, 'workflow': workflow, 'build_sh': build_sh, 'gw_docker': gw_docker,
            'config_js': config_js, 'en_docker': en_docker, 'admin': admin, 'update_js': update_js, 'guide': guide,
            'readme': 'curl -fL -o compose.yaml %s\n' % url, 'tutorial': 'curl -fL -o compose.yaml %s\n' % url}


def check_docker_images(tmp):
    """DESIGN-DOCKER-IMAGES 7.5: on fixtures (good ones pass, each broken one fails), then on the working copy."""
    f = docker_fixtures()
    repo = image_owner() + '/encore'

    def names(compose=None, workflow=None, extra=None):
        t = {rc.COMPOSE_SRC: f['compose'] if compose is None else compose,
             WORKFLOW: f['workflow'] if workflow is None else workflow}
        t.update(extra or {})
        return t
    p = image_name_problems(names(), repo)
    check('docker images: matching image names pass', not p, p)
    for label, args, want in (
            ('another image name in the docs', dict(extra={'docs/X.md': 'docker pull ghcr.io/someone/encore-bridge\n'}),
             'docs/X.md line 1'),
            ('a compose file without the engine image', dict(compose=f['compose'].replace(rc.IMAGES[1], 'example/x')),
             'doesn\'t name'),
            ('a workflow whose env: lacks the bridge',
             dict(workflow=f['workflow'].replace('  BRIDGE_IMAGE: %s\n' % rc.IMAGES[0], '')), 'env:')):
        p = image_name_problems(names(**args), repo)
        check('docker images: %s fails' % label, any(want in x for x in p), p)
    p = image_name_problems(names(), 'someone/encore')
    check('docker images: an UPDATE_REPO of another owner fails', any('owner' in x for x in p), p)

    p = compose_file_problems(f['compose'], f['source'])
    check('docker compose file: the design\'s shape passes', not p, p)
    for label, old, new, want in (
            ('a build: line', '    restart: unless-stopped\n    environment:', '    restart: unless-stopped\n    build: .\n'
             '    environment:', 'build'),
            ('env_file', '    environment:\n', '    env_file: .env\n    environment:\n', 'env_file'),
            ('pull_policy', '    depends_on', '    pull_policy: always\n    depends_on', 'pull_policy'),
            ('another container name', 'container_name: encore-engine', 'container_name: encore-eng', 'container_name'),
            ('a fixed tag', ':${ENCORE_TAG:-latest}\n    container_name: encore-gateway',
             ':latest\n    container_name: encore-gateway', 'image'),
            ('no ./engine:/config', '      - ./engine:/config\n', '', './engine:/config'),
            ('bridge networking', 'network_mode: host\n    restart: unless-stopped\n    depends_on',
             'network_mode: bridge\n    restart: unless-stopped\n    depends_on', 'network_mode'),
            ('no restart', '    restart: unless-stopped\n    environment:', '    environment:', 'restart')):
        bad = f['compose'].replace(old, new, 1)
        p = compose_file_problems(bad, f['source'])
        check('docker compose file: %s fails' % label, bad != f['compose'] and any(want in x for x in p), p)

    p = workflow_problems(f['workflow'])
    check('docker workflow: the design\'s shape passes', not p, p)
    for label, old, new, want in (
            ('types: [published]', 'types: [released]', 'types: [published]', 'released'),
            ('no workflow_dispatch', '  workflow_dispatch:\n', '  push:\n', 'workflow_dispatch'),
            ('top-level write-all', 'permissions: {}', 'permissions: write-all', 'top-level'),
            ('contents: write', '      contents: read\n      packages', '      contents: write\n      packages',
             'contents: write'),
            ('an action by tag', '@%s # v7.0.1' % ('a1b2c3d4e5' * 4), '@v7 # v7.0.1', 'uses:'),
            ('a pin without its version comment', ' # v7.0.1', '', 'uses:'),
            ('another secret', 'secrets.GITHUB_TOKEN', 'secrets.PAT', 'secrets.PAT'),
            ('pull_request_target', '  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request_target:\n',
             'pull_request_target'),
            ('${{ inputs.tag }} in a run: block', '--tag "$TAG"', '--tag "${{ inputs.tag }}"', 'run:'),
            ('${{ github.event.* }} in a one-line run:', 'docker login ghcr.io',
             'docker login ghcr.io -u ${{ github.event.sender.login }}', 'run:'),
            ('no arm64 runner', 'ubuntu-24.04-arm', 'ubuntu-24.04', 'ubuntu-24.04-arm'),
            ('a BuildKit image by tag only', '@sha256:' + 'ab12' * 16, '', 'BUILDKIT_IMAGE'),
            ('a BuildKit image with a short digest', 'ab12' * 16, 'ab12' * 8, 'BUILDKIT_IMAGE'),
            ('a builder without the pinned BuildKit image', 'image=${BUILDKIT_IMAGE}', 'image=moby/buildkit:latest',
             'buildx create'),
            ('no GPL bundle check', 'check_gpl_bundle.py', 'check.py', 'check_gpl_bundle.py')):
        bad = f['workflow'].replace(old, new, 1)
        p = workflow_problems(bad)
        check('docker workflow: %s fails' % label, bad != f['workflow'] and any(want in x for x in p), p)

    p = build_script_problems(f['build_sh'], f['gw_docker'], f['config_js'], f['en_docker'])
    check('docker build scripts: the design\'s pieces pass', not p, p)
    for label, args, want in (
            ('build-images.sh without ENCORE_PREBUILT=1', (f['build_sh'].replace('ENCORE_PREBUILT=1', ''),
                                                           f['gw_docker'], f['config_js'], f['en_docker']), 'build-images'),
            ('a Dockerfile without ARG ENCORE_PREBUILT', (f['build_sh'], f['gw_docker'].replace('ARG ENCORE_PREBUILT=\n', ''),
                                                         f['config_js'], f['en_docker']), 'gateway/Dockerfile'),
            ('a config.js that ignores it', (f['build_sh'], f['gw_docker'], 'x\n', f['en_docker']), 'config.js'),
            ('an engine Dockerfile without the entrypoint', (f['build_sh'], f['gw_docker'], f['config_js'],
                                                            f['en_docker'].replace('entrypoint.sh /usr', 'x /usr')),
             'entrypoint.sh')):
        p = build_script_problems(*args)
        check('docker build scripts: %s fails' % label, any(want in x for x in p), p)

    def card(**kw):
        a = dict(admin_html=f['admin'], update_js=f['update_js'], guide=f['guide'], readme=f['readme'],
                 tutorial=f['tutorial'], update_repo=repo)
        a.update(kw)
        return card_docs_problems(**a)
    p = card()
    check('docker update card: commands and compose asset agree with the docs', not p, p)
    for label, kw, want in (
            ('a guide with other commands', dict(guide=f['guide'].replace('pull &&\n', 'pull && ')), 'GUIDE.md'),
            ('the commands outside "Bridge on Docker"', dict(guide='### Bridge on Docker\n\n### Update the app\n'
                                                              'docker compose pull &&\ndocker compose up -d\n'), 'GUIDE.md'),
            ('another compose asset in update.js', dict(update_js="const COMPOSE_ASSET = 'compose.yaml';\n"),
             'COMPOSE_ASSET'),
            ('a README without the download', dict(readme='Download the compose file.\n'), 'README.md'),
            ('a tutorial with a versioned link', dict(tutorial=f['tutorial'].replace('latest/download', 'download/v1.3.0')),
             'TUTORIAL-DOCKER')):
        p = card(**kw)
        check('docker update card: %s fails' % label, any(want in x for x in p), p)
    cs = card_strings(f['admin'])
    check('docker update card: the four new strings are found', sorted(cs) == sorted(CARD_STRINGS + ('setup_log',))
          and cs['image_intro'].startswith("Encore Bridge doesn't"), cs)
    p = no_hash_problems(dict(cs, compose=f['compose'], tutorial='Download the file and start it.\n'))
    check('docker no hashes: clean texts pass', not p, p)
    for label, texts in (('a tutorial that mentions checksums', {'tutorial': 'Compare the checksum.\n'}),
                         ('a card string with SHA-256', {'image_pin': 'Check its SHA-256 first.'}),
                         ('a compose file with a hash', {'compose': '# the image hash\n'})):
        check('docker no hashes: %s fails' % label, bool(no_hash_problems(texts)))

    # the working copy
    root = rc.REPO_ROOT

    def read(rel, binary=False):
        try:
            with open(os.path.join(root, *rel.split('/')), 'rb') as fh:
                data = fh.read()
        except OSError:
            return None
        return data if binary else data.decode('utf-8', 'replace')
    scripts_dir = os.path.join(root, *SCRIPTS.split('/'))
    scripts = sorted(SCRIPTS + '/' + n for n in os.listdir(scripts_dir)
                     if os.path.isfile(os.path.join(scripts_dir, n))) if os.path.isdir(scripts_dir) else []
    texts = {rel: read(rel) for rel in [rc.COMPOSE_SRC, WORKFLOW, 'tools/release/docker_smoke.py', 'README.md',
                                        'CHANGELOG.md', 'THIRD-PARTY-NOTICES.md', 'gateway/src/admin.html'] + scripts
             + ['docs/' + x for x in md_files(os.path.join(root, 'docs'))]}
    js = read(UPDATE_JS) or ''
    m = REPO_CONST_JS.search(js)
    update_repo = m.group(1) if m else '?/?'
    p = image_name_problems(texts, update_repo)
    check('docker images: every ghcr.io name in the compose file, workflow, scripts, docs and admin.html is one of '
          'rc.IMAGES, owned by UPDATE_REPO\'s owner', not p, '; '.join(p))
    compose = texts[rc.COMPOSE_SRC]
    p = compose_file_problems(compose, read(SOURCE_COMPOSE)) if compose is not None else ['%s is missing' % rc.COMPOSE_SRC]
    check('docker compose file: %s (services, images, host networking, volumes, restart, no build/env_file/'
          'pull_policy)' % rc.COMPOSE_SRC, not p, '; '.join(p))
    a, b = read(IMAGE_CONFIG, True), read(DEFAULT_CONFIG, True)
    check('docker default config: %s is byte-identical to %s' % (IMAGE_CONFIG, DEFAULT_CONFIG),
          a is not None and a == b, 'missing' if a is None or b is None else 'they differ')
    wf = texts[WORKFLOW]
    p = workflow_problems(wf) if wf is not None else ['%s is missing' % WORKFLOW]
    check('docker workflow: %s (release types [released] + workflow_dispatch, permissions, pinned actions, BuildKit '
          'image pinned by digest, GITHUB_TOKEN only, no expressions in run:, arm64 runner, the scripts)' % WORKFLOW,
          not p, '; '.join(p))
    p = build_script_problems(read(BUILD_IMAGES), read('gateway/Dockerfile'), read('gateway/src/config.js'),
                              read('gateway/engine-src/Dockerfile'))
    check('docker build scripts: ENCORE_PREBUILT and ENCORE_VERSION wired through, the engine image carries its '
          'default config and entrypoint', not p, '; '.join(p))
    admin = texts['gateway/src/admin.html']
    p = card_docs_problems(admin, js, read('docs/GUIDE.md'), texts['README.md'], read('docs/TUTORIAL-DOCKER.md'),
                           update_repo)
    check('docker update card: UPD_IMAGE_CMDS is in the guide\'s "Bridge on Docker", COMPOSE_ASSET == rc.COMPOSE_ASSET, '
          'README and the Docker tutorial download it from releases/latest/download/', not p, '; '.join(p))
    cs = card_strings(admin)
    missing = sorted(set(CARD_STRINGS + ('setup_log',)) - set(cs))
    p = no_hash_problems(dict(cs, **{rc.COMPOSE_SRC: compose or '', 'docs/TUTORIAL-DOCKER.md':
                                     read('docs/TUTORIAL-DOCKER.md') or ''}))
    p += ['gateway/src/admin.html: no %s text' % x for x in missing]
    check('docker no hashes: %s, docs/TUTORIAL-DOCKER.md and the four new card/setup texts never mention SHA-256, '
          'checksums or hashes' % rc.COMPOSE_SRC, not p, '; '.join(p))
    crlf = [rel for rel in [ENTRYPOINT, rc.COMPOSE_SRC, WORKFLOW] + scripts
            if read(rel, True) is None or b'\r' in read(rel, True)]
    check('docker files: LF only in the entrypoint, %s, the workflow and %s/*' % (rc.COMPOSE_SRC, SCRIPTS)
          + ('' if scripts else ' (no scripts found)'), not crlf and bool(scripts), ', '.join(crlf) or 'no scripts')
    p = image_plan_problems(os.path.join(root, *IMAGE_PLAN.split('/')), tmp)
    check('docker image_plan.py: tags v<X.Y.Z> / X.Y / latest from final releases only, refusals, exit 3 while '
          'files are missing, dry run', not p, '; '.join(p))
    p = gpl_check_problems(os.path.join(root, *GPL_CHECK.split('/')), tmp)
    check('docker check_gpl_bundle.py: a bundle whose engine/ is the source passes (vendor/ left out); a changed, '
          'extra or missing file, or no engine/, fails', not p, '; '.join(p))


def png_bytes(extra_chunks=()):
    """A 1x1 grey PNG; extra_chunks [(type, data)] go before the image data."""
    def chunk(t, d):
        return len(d).to_bytes(4, 'big') + t + d + (zlib.crc32(t + d) & 0xffffffff).to_bytes(4, 'big')
    ihdr = (1).to_bytes(4, 'big') + (1).to_bytes(4, 'big') + bytes([8, 0, 0, 0, 0])
    body = [chunk(b'IHDR', ihdr)] + [chunk(t, d) for t, d in extra_chunks]
    body += [chunk(b'IDAT', zlib.compress(b'\x00\x80')), chunk(b'IEND', b'')]
    return b'\x89PNG\r\n\x1a\n' + b''.join(body)


def jpeg_bytes(app1=None):
    """A minimal JPEG header (SOI, APP0, optional APP1, SOS, EOI): enough for the metadata check."""
    seg = lambda m, d: b'\xff' + bytes([m]) + (len(d) + 2).to_bytes(2, 'big') + d
    out = b'\xff\xd8' + seg(0xe0, b'JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00')
    if app1 is not None:
        out += seg(0xe1, app1)
    return out + seg(0xda, b'\x00' * 10) + b'\x00\x00\xff\xd9'


def main():
    # Never the real release key: only its public .pub is read (check_update_wiring); every tool this run starts sees
    # an empty ENCORE_SIGN_KEY, so no scan or release run picks the private key up by default.
    real = rc.read_local_conf().get('ENCORE_SIGN_KEY')
    REAL_PUB[:] = [signkey.pub_path_of(real)] if real else []
    saved_key = os.environ.get('ENCORE_SIGN_KEY')
    os.environ['ENCORE_SIGN_KEY'] = ''
    tmp = tempfile.mkdtemp(prefix='encore-selftest-')
    try:
        server = 'Example' + 'VaultServer'
        handle = 'ex' + 'handle'
        addr = '.'.join(['10', '9', '8', '7'])
        mail = 'joe' + '@' + 'realmail.io'
        deny_file = os.path.join(tmp, 'deny.txt')
        write(deny_file, '\n'.join([
            '# test denylist',
            '[server] ' + server,
            '[owner-handle] ' + handle,
            'allow ** com\\.' + handle + '\\.encore(?![A-Za-z])(?:\\.[A-Za-z0-9_-]+)*',
            'allow **control ^(?:Author|Maintainer): ' + handle + '$',
            '[addr] re:(?<![0-9.])' + addr.replace('.', '\\.') + '(?![0-9])',
            '[fruit] word:Kiwi',
        ]) + '\n')
        t = os.path.join(tmp, 'tree')
        # clean placeholders: no finding expected
        write(os.path.join(t, 'ok.txt'), 'loopback 127.0.0.1, docs 192.0.2.5, net 10.0.0.0/8, Icon@2x.png, '
              'a@example.com, /home/user/x, C:' + '\\Users\\<name>\\x, /users/spotify, kiwifruit, '
              'com.' + handle + '.encore.catalog\n')
        # leaks in text
        write(os.path.join(t, 'leak.txt'), 'server %s at %s\nmail %s\npath /ho' % (server, addr, mail) +
              'me/joe/build and C:' + '\\Users\\Joe\\x\nthe Kiwi tree\ncontact ' + handle + ' today\n')
        # secret shapes
        tok = 'B' + 'Q' + 'x' * 70
        write(os.path.join(t, 'secrets.js'), 'const a = "%s";\nconst b = {"refresh' % tok + '_token": "' + 'r' * 40 +
              '"};\n' + '-' * 5 + 'BEGIN OPENSSH PRIVATE KEY' + '-' * 5 + '\n')
        # secret file: reported by name, never read (it holds a denylist value that must NOT be reported)
        write(os.path.join(t, 'gateway', '.env'), 'ADMIN_PASSWORD=' + server + '\n')
        write(os.path.join(t, 'gateway', '.env.example'), 'ADMIN_PASSWORD=' + 'hunter' + '2\nSPOTIFY_CLIENT_ID=\n')
        # binary with UTF-16LE and an ASCII build path
        blob = b'\x00\x01\x02' + server.encode('utf-16-le') + b'\x00\x00\xff' + ('/Us' + 'ers/joe/dev/app.m').encode() + b'\x00'
        write(os.path.join(t, 'bin.dat'), blob)
        # zip with a state file and a leak, plus a nested tar.gz
        zbuf = io.BytesIO()
        with zipfile.ZipFile(zbuf, 'w') as z:
            z.writestr('pkg/tokens.json', '{"x": "' + server + '"}')
            z.writestr('pkg/inner.txt', 'host ' + addr + '\n')
            z.writestr('pkg/nested.tar.gz', tar_bytes([('deep/readme.txt', ('see ' + server).encode())], 'gz'))
        write(os.path.join(t, 'pkg.zip'), zbuf.getvalue())
        # a deb: control allowed by the control rule; the binary holds the server name as UTF-16
        control = ('Package: com.%s.encore\nMaintainer: %s\nAuthor: %s\n' % (handle, handle, handle)).encode()
        data = tar_bytes([('./Applications/X.app/X', b'\xcf\xfa\xed\xfe\x00\x00' + server.encode('utf-16-le') + b'\x00\x00')], 'lzma')
        write(os.path.join(t, 'test.deb'), ar_bytes([('debian-binary', b'2.0\n'),
                                                     ('control.tar.gz', tar_bytes([('./control', control)], 'gz')),
                                                     ('data.tar.lzma', data)]))
        # the same deb again inside a zip (a release archive that carries the deb asset too): scanned once
        dbuf = io.BytesIO()
        with zipfile.ZipFile(dbuf, 'w') as z:
            with open(os.path.join(t, 'test.deb'), 'rb') as f:
                z.writestr('copies/test.deb', f.read())
        write(os.path.join(t, 'zz-debcopy.zip'), dbuf.getvalue())

        # the bridge's data folder inside an archive: admin.json (the admin password's hash) by name, never read
        write(os.path.join(t, 'bundle.tar.gz'), tar_bytes([('Encore/gateway/data/admin.json', ('{"hash": "' + server + '"}').encode()),
                                                           ('Encore/gateway/data/showcase.json', b'{"showcase": true}')], 'gz'))
        # images: a GPS position in a PNG's eXIf chunk and in a JPEG's Exif segment (binary, no text to match); clean ones
        gps = b'MM\x00*\x00\x00\x00\x08' + bytes(range(64))
        write(os.path.join(t, 'docs', 'images', 'shot.png'), png_bytes([(b'eXIf', gps), (b'tEXt', b'Author\x00x')]))
        write(os.path.join(t, 'docs', 'images', 'clean.png'), png_bytes())
        write(os.path.join(t, 'docs', 'images', 'photo.jpg'), jpeg_bytes(b'Exif\x00\x00' + gps))
        write(os.path.join(t, 'docs', 'images', 'clean.jpg'), jpeg_bytes())

        deny, allows = scan.load_denylist(deny_file)
        sc = scan.Scanner(deny, allows, scan.load_scan_allow(rc.SCAN_ALLOW_DEFAULT))
        sc.scan_path(t)
        f = sc.findings
        by = collections.Counter((x['category'], x['label'] or x['rule']) for x in f)
        paths = collections.defaultdict(list)
        for x in f:
            paths[x['path']].append((x['category'], x['label'] or x['rule']))

        check('placeholders are clean', 'ok.txt' not in paths, paths.get('ok.txt'))
        lk = collections.Counter(paths.get('leak.txt', []))
        check('text: server name', lk[('DENY', 'server')] == 1, lk)
        check('text: denylisted address (generic IP folded in)', lk[('DENY', 'addr')] == 1 and lk[('IP', 'ipv4')] == 0, lk)
        check('text: e-mail', lk[('EMAIL', 'email')] == 1, lk)
        check('text: home paths', lk[('HOMEPATH', 'home-path')] == 2, lk)
        check('text: word entry, not inside other words', lk[('DENY', 'fruit')] == 1, lk)
        check('text: handle outside the allowed id', lk[('DENY', 'owner-handle')] == 1, lk)
        sk = collections.Counter(c for c, _ in paths.get('secrets.js', []))
        check('secrets: token, refresh_token field, private key', sk['SECRET'] == 3, paths.get('secrets.js'))
        env = paths.get('gateway/.env', [])
        check('.env reported by name only (never read)', env == [('FILENAME', 'environment file (only .env.example ships)')], env)
        ex = paths.get('gateway/.env.example', [])
        check('.env.example: secret value flagged', ex == [('SECRET', 'ADMIN_PASSWORD')], ex)
        bn = collections.Counter(paths.get('bin.dat', []))
        check('binary: UTF-16 server name + build path', bn[('DENY', 'server')] == 1 and bn[('HOMEPATH', 'home-path')] == 1, bn)
        zp = {k: v for k, v in paths.items() if k.startswith('pkg.zip!')}
        check('zip: state file by name', any(c == 'FILENAME' for c, _ in zp.get('pkg.zip!pkg/tokens.json', [])), zp)
        check('zip: state file content not read', not any(c == 'DENY' for c, _ in zp.get('pkg.zip!pkg/tokens.json', [])), zp)
        check('zip: leak inside', ('DENY', 'addr') in zp.get('pkg.zip!pkg/inner.txt', []), zp)
        check('zip: nested tar.gz', any(k.endswith('deep/readme.txt') and ('DENY', 'server') in v for k, v in zp.items()), zp)
        db = {k: v for k, v in paths.items() if k.startswith('test.deb!')}
        check('deb: control lines allowed', not any('control' in k for k in db), db)
        check('deb: UTF-16 literal in the binary (lzma data)', any(k.endswith('X.app/X') and ('DENY', 'server') in v
                                                                   for k, v in db.items()), db)
        check('deb met twice: scanned once (SHA-256)', len(sc.same_debs) == 1 and sc.same_debs[0][1] == 'test.deb'
              and not any(k.startswith('zz-debcopy.zip!') for k in paths), sc.same_debs)
        tg = {k: v for k, v in paths.items() if k.startswith('bundle.tar.gz!')}
        adm = [v for k, v in tg.items() if k.endswith('data/admin.json')]
        check('archive: data/admin.json by name', bool(adm) and ('FILENAME', 'secret or state file') in adm[0], tg)
        check('archive: data/admin.json content not read', not any(c == 'DENY' for v in adm for c, _ in v), tg)
        check('archive: data/showcase.json by name', any(k.endswith('data/showcase.json') for k in tg), tg)
        im = collections.Counter(c for k, v in paths.items() if k.startswith('docs/images/') for c, _ in v)
        check('image metadata: PNG eXIf + tEXt', collections.Counter(paths.get('docs/images/shot.png', []))
              == collections.Counter([('METADATA', 'png-eXIf'), ('METADATA', 'png-tEXt')]), paths.get('docs/images/shot.png'))
        check('image metadata: JPEG Exif', paths.get('docs/images/photo.jpg', []) == [('METADATA', 'jpeg-APP1-exif')],
              paths.get('docs/images/photo.jpg'))
        check('image metadata: clean images pass', 'docs/images/clean.png' not in paths and 'docs/images/clean.jpg' not in paths,
              im)
        report = scan.render(f, ['tree'], {'denylist': 'test', 'files': sc.files, 'bytes': sc.bytes,
                                           'same_debs': len(sc.same_debs)})
        check('report never prints denylist values', server.lower() not in report.lower() and addr not in report)
        check('report counts the deb met twice', 'same    : 1 deb(s)' in report)

        # export: allowlist only, never-ship always wins
        repo = os.path.join(tmp, 'repo')
        for rel, body in [('app/control', 'Package: x\nVersion: 9.9.9\n'), ('app/A.m', 'int a;\n'),
                          ('app/ARCH-0.5.md', 'notes\n'), ('ARCH-0.5.md', 'notes\n'), ('PLAN.md', 'plan\n'),
                          ('gateway/src/config.js', "  version: '9.9.9',\n"), ('gateway/.env', 'X=1\n'),
                          ('gateway/.env.example', 'X=\n'), ('probes/k.txt', 'k\n'), ('notes.txt', 'n\n'),
                          ('tools/release/denylist.local.txt', 'x\n'), ('tools/release/release.local.env', 'x\n'),
                          ('gateway/engine-src/LICENSE', 'GPL\n'), ('gateway/engine-src/old.deb', 'x\n')]:
            write(os.path.join(repo, *rel.split('/')), body)
        out = os.path.join(tmp, 'export')
        code = export.main(['--repo', repo, '--out', out, '--manifest', os.path.join(tmp, 'M.txt'),
                            '--log', os.path.join(tmp, 'L.txt')])
        got = set(rc.tree_files(out))
        check('export: ran', code == 0, code)
        check('export: allowlisted files copied', {'app/A.m', 'app/control', 'gateway/.env.example',
                                                   'gateway/engine-src/LICENSE'} <= got, got)
        check('export: nothing never-ship or unlisted copied',
              not got & {'gateway/.env', 'PLAN.md', 'ARCH-0.5.md', 'app/ARCH-0.5.md', 'probes/k.txt', 'notes.txt',
                         'tools/release/denylist.local.txt', 'tools/release/release.local.env',
                         'gateway/engine-src/old.deb'}, got)
        check('export: refuses an output folder inside the repo',
              export.main(['--repo', repo, '--out', os.path.join(repo, 'x')]) == 2)

        keys = check_signing(tmp)
        check_trust_lists(tmp)
        check_never_ship_keys(tmp)
        check_windows_update_checks(tmp)
        if keys:
            check_sign_flow(tmp, keys)
            check_scanner_keys(tmp, keys)
        tree = check_release_flow(tmp, keys)
        check_bundle_checks(tmp, tree)
        check_shared_tutorials()
        check_app_repo()
        check_update_wiring()
        check_docker_images(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        if saved_key is None:
            os.environ.pop('ENCORE_SIGN_KEY', None)
        else:
            os.environ['ENCORE_SIGN_KEY'] = saved_key
    print('\nselftest: %s' % ('PASS' if not FAILS else 'FAIL (%d)' % len(FAILS)))
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
