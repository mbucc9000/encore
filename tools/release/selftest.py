#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Self-test of the release scripts on generated fixtures (no real data, no network).

    python tools/release/selftest.py

Checks that scan.py finds every kind of leak (text, UTF-16 inside a binary, inside zip / tar / deb archives,
forbidden names, secret shapes, image metadata) and stays quiet on placeholders, that secret files (the bridge's
data/admin.json too) are reported by name without being read, that a deb met twice in one scan is scanned once, and
that export.py copies only allowlisted files and never a never-ship one.
The release flow on a synthetic working copy with a synthetic deb (made-up fields): the steps run in the order export,
scan, deb, source, windows, gpl, docker, sums (there is no step "repo": the bridge hosts no Cydia source, phones
install the app from the owner's Encore repo, DESIGN-WIZARD 5.6); the deb is a release asset only, never in the
exported tree, the source archive or the Windows build's environment; a leftover gateway/repo/ in a working copy is
never exported. The Windows static check fails on a gateway/repo/ folder or any .deb in the payload, build_windows.py
has no --deb any more, and the Docker smoke test checks that the image has no /app/repo.
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
KEY_DOCS = ('README.md', 'docs/GUIDE.md', 'docs/BUILDING.md')   # they publish the release key for the openssl check
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
    main_order = [st for st in order if st in ('export', 'deb', 'source', 'windows', 'gpl', 'docker', 'sums')]
    check('release: export, deb, source, windows, gpl, docker, sums in that order',
          main_order == ['export', 'deb', 'source', 'windows', 'gpl', 'docker', 'sums'], order)
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
    # the published key blocks ("Checking a download", "Release signing") name keys of the embedded list, so the
    # documented openssl check works (a replaced key must be replaced there too, tools/release/README.md)
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
