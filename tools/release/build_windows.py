#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Build the Windows bridge (portable zip + installer) from an EXPORTED tree, locally or on a Docker machine over SSH,
then check the result statically.

    python tools/release/build_windows.py --tree <exported tree> --out <assets folder> --engine <engine build folder>
        --ffmpeg <FFmpeg build folder> [--engine-build <folder>] [--go-vendor <vendor folder>]
        [--reports <folder>] [--local] [--dev]

It runs gateway/windows/build.sh from the exported tree (the launcher build, then bundle/bundle.sh in the packaging
image: the staging folder, the zip and the Inno Setup installer). Results:
  <out>/EncoreBridge-<ver>-win64.zip          the portable zip                    (a release asset)
  <out>/EncoreBridge-<ver>-setup.exe          the installer                       (a release asset)
  <out>/EncoreBridge-<ver>-windows-payload/   the staging folder = the installer's payload and the zip's content.
                                              release.py scans it; it is never checksummed or published
  <reports>/EncoreBridge-<ver>-bundle-report.txt, -iscc-log.txt (Inno Setup's log), windows-build-log.txt,
  windows-static-checks.txt

--engine is the output folder of gateway/windows/build-engine/build.sh: encore-engine.exe, and usually its
licenses/, BUILDINFO.txt and SHA256SUMS (taken from --engine-build when they are not next to the exe). The exe must
match that SHA256SUMS. --go-vendor (a "go mod vendor" folder of gateway/engine-src) adds the license files of every Go
module that BUILDINFO.txt lists as compiled into the exe, and the Go toolchain's license when the folder above it holds
go-LICENSE.txt, to the engine's licenses (shipped as licenses/go-librespot/third_party/).

The bridge hosts no Cydia source (DESIGN-WIZARD 5.6): phones install the app from the owner's Encore repo, so the
payload must hold no gateway/repo/ folder and no .deb anywhere (a static check).

The update system (DESIGN-UPDATES 13), also static: the payload holds gateway/src/update.js and updatekeys.js; the
bridge's trust list (gateway/src/updatekeys.js) and the launcher's (internal/update/keys.go) are valid, equal and free
of the RFC 8032 test keys; Encore Bridge.exe contains every trusted key's base64 string and none of the test hooks
(ENCORE_UPDATE_TEST_KEY, ENCORE_UPDATE_API, ENCORE_UPDATE_DOWNLOAD, --update-test: only builds with the Go build tag
encoreupdatetest have them); gateway/windows/installer/EncoreBridge.iss has its update mode (ENCOREUPDATE, --updated,
--update-failed).

--ffmpeg is the output folder of gateway/windows/build-ffmpeg/build.sh: Encore's minimal LGPL ffmpeg.exe with its
SHA256SUMS, BUILDINFO.txt and licenses/ (its sources/ stay here: release.py puts them into the GPL bundle).

The bundle script runs the release scan's generic checks (--no-denylist) inside the build image before the installer
is compiled; the local denylist never leaves this machine. release.py then scans the zip, the installer and the
payload folder with the full denylist.

Remote settings (tools/release/release.local.env, never exported, or the environment):
  ENCORE_WIN_SSH       user@host of a Linux x86-64 machine with Docker (never a server that runs your live bridge)
  ENCORE_WIN_SSH_KEY   private key file for it (optional)
  ENCORE_WIN_DIR       parent folder for the temporary build folder there (default: encore-release-win in the home
                       folder); the build folder is removed afterwards
  ENCORE_WIN_CACHE     optional folder there that keeps the pinned Node.js download between runs
  ENCORE_WIN_SUDO      1 to run docker through "sudo -n"
  ENCORE_SSH_BIN / ENCORE_SCP_BIN   ssh and scp programs (default: from PATH)
Without ENCORE_WIN_SSH (or with --local) it runs build.sh on this machine, which then needs bash and Docker.
Exit code: 0 = built and every static check passed, 1 = failed, 2 = usage error.
"""
import argparse
import io
import os
import re
import shlex
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile

sys.dont_write_bytecode = True   # keep __pycache__ out of the working copy
import relcommon as rc  # noqa: E402

ENGINE_EXE = 'encore-engine.exe'
LICENSE_NAMES = ('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'PATENTS', 'COPYRIGHT', 'UNLICENSE')
SCAN_WRAPPER = '''#!/bin/sh
# Generic release scan of the staging folder (bundle.sh --scan). The local denylist never leaves the release machine;
# release.py scans the finished bundle with it afterwards.
exec python3 "$(dirname "$0")/scan.py" --no-denylist --quiet "$1"
'''


def log(msg):
    print('build_windows: %s' % msg, flush=True)


# --------------------------------------------------------------------------------------------------------------------
# The engine folder handed to bundle.sh: encore-engine.exe, licenses/ (+ Go module licenses), BUILDINFO.txt

def read_sums(folder):
    sums = {}
    p = os.path.join(folder, 'SHA256SUMS')
    if os.path.isfile(p):
        with open(p, encoding='utf-8') as f:
            for line in f:
                m = re.match(r'^([0-9a-f]{64})\s+\*?(.+?)\s*$', line)
                if m:
                    sums[m.group(2)] = m.group(1)
    return sums


def go_deps(buildinfo):
    """[(module path, version)] from the "go version -m" part of BUILDINFO.txt."""
    deps = []
    with open(buildinfo, encoding='utf-8') as f:
        for line in f:
            m = re.match(r'^\s*dep\s+(\S+)\s+(\S+)', line)
            if m:
                deps.append((m.group(1), m.group(2)))
            m = re.match(r'^\s*=>\s+(\S+)\s+(\S+)', line)   # a replaced module: the replacement is what is compiled
            if m and deps:
                deps[-1] = (m.group(1), m.group(2))
    return deps


def assemble_engine(engine, engine_build, go_vendor, dst, dev, problems, warnings):
    exe = os.path.join(engine, ENGINE_EXE)
    if not os.path.isfile(exe):
        (warnings if dev else problems).append('no %s in --engine' % ENGINE_EXE)
        return False
    meta = engine_build if engine_build else engine
    if not os.path.isdir(os.path.join(meta, 'licenses')) and os.path.isdir(os.path.join(engine, 'licenses')):
        meta = engine
    sums = read_sums(engine) or read_sums(meta)
    digest = rc.sha256_file(exe)
    if ENGINE_EXE in sums:
        if sums[ENGINE_EXE] != digest:
            problems.append('%s does not match the SHA256SUMS of its build' % ENGINE_EXE)
    else:
        (warnings if dev else problems).append('no SHA256SUMS line for %s next to the engine build' % ENGINE_EXE)
    os.makedirs(dst)
    shutil.copyfile(exe, os.path.join(dst, ENGINE_EXE))
    lic_src = os.path.join(meta, 'licenses')
    lic = os.path.join(dst, 'licenses')
    if os.path.isdir(lic_src):
        shutil.copytree(lic_src, lic)
    else:
        os.makedirs(lic)
        (warnings if dev else problems).append('no licenses/ in the engine build')
    bi = os.path.join(meta, 'BUILDINFO.txt')
    if os.path.isfile(bi):
        shutil.copyfile(bi, os.path.join(dst, 'BUILDINFO.txt'))
    if go_vendor:
        if not os.path.isfile(os.path.join(go_vendor, 'modules.txt')):
            problems.append('--go-vendor has no modules.txt (not a "go mod vendor" folder)')
            return True
        if not os.path.isfile(bi):
            problems.append('--go-vendor needs the engine build\'s BUILDINFO.txt (the list of compiled modules)')
            return True
        gm = os.path.join(lic, 'go-modules')
        os.makedirs(gm)
        rows, missing = [], []
        for path, ver in go_deps(bi):
            mdir = os.path.join(go_vendor, *path.split('/'))
            files = []
            if os.path.isdir(mdir):
                for fn in sorted(os.listdir(mdir)):
                    if os.path.isfile(os.path.join(mdir, fn)) and fn.upper().startswith(LICENSE_NAMES):
                        out = '%s-%s' % (path.replace('/', '_'), fn)
                        if not out.lower().endswith(('.txt', '.md')):
                            out += '.txt'
                        shutil.copyfile(os.path.join(mdir, fn), os.path.join(gm, out))
                        files.append(out)
            if not files:
                missing.append(path)
            rows.append('%s %s  %s' % (path, ver, ', '.join(files) if files else '(no license file published by the module)'))
        with open(os.path.join(gm, 'MODULES.txt'), 'w', encoding='utf-8', newline='\n') as f:
            f.write('Go modules compiled into encore-engine.exe (from BUILDINFO.txt) and their license files here.\n\n')
            f.write('\n'.join(rows) + '\n')
        go_lic = os.path.join(os.path.dirname(os.path.abspath(go_vendor)), 'go-LICENSE.txt')
        if os.path.isfile(go_lic):
            shutil.copyfile(go_lic, os.path.join(lic, 'go-LICENSE.txt'))
        else:
            warnings.append('no go-LICENSE.txt next to the vendor folder: the Go toolchain license is not added')
        for path in missing:
            warnings.append('Go module %s has no license file' % path)
        log('engine licenses: %d Go modules, %d without a license file' % (len(rows), len(missing)))
    return True


def assemble_ffmpeg(src, dst, problems):
    """The FFmpeg build folder handed to bundle.sh: ffmpeg.exe, SHA256SUMS, BUILDINFO.txt and licenses/ (not sources/:
    the source tarball goes into the GPL bundle, not the Windows bundle)."""
    exe = os.path.join(src, 'ffmpeg.exe')
    if not os.path.isfile(exe):
        problems.append('no ffmpeg.exe in --ffmpeg (gateway/windows/build-ffmpeg/build.sh)')
        return
    sums = read_sums(src)
    if sums.get('ffmpeg.exe') != rc.sha256_file(exe):
        problems.append('ffmpeg.exe does not match the SHA256SUMS of its build')
    os.makedirs(dst)
    for fn in ('ffmpeg.exe', 'SHA256SUMS', 'BUILDINFO.txt'):
        if os.path.isfile(os.path.join(src, fn)):
            shutil.copyfile(os.path.join(src, fn), os.path.join(dst, fn))
    if os.path.isdir(os.path.join(src, 'licenses')):
        shutil.copytree(os.path.join(src, 'licenses'), os.path.join(dst, 'licenses'))
    else:
        problems.append('no licenses/ in the FFmpeg build')


def scan_kit(tree, dst):
    os.makedirs(dst)
    for fn in ('scan.py', 'relcommon.py', 'scan-allow.txt'):
        shutil.copyfile(os.path.join(tree, 'tools', 'release', fn), os.path.join(dst, fn))
    with open(os.path.join(dst, 'scan-bundle.sh'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(SCAN_WRAPPER)


def pack(root, members):
    """.tar.gz in memory of root/<member> folders; shell scripts executable."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as t:
        for top in members:
            base = os.path.join(root, top)
            for rel in rc.tree_files(base):
                with open(os.path.join(base, *rel.split('/')), 'rb') as f:
                    data = f.read()
                if rel.endswith('.sh'):
                    data = data.replace(b'\r\n', b'\n')
                ti = tarfile.TarInfo('%s/%s' % (top, rel))
                ti.size, ti.mtime = len(data), int(time.time())
                ti.mode = 0o755 if (rel.endswith('.sh') or data[:2] == b'#!') else 0o644
                ti.uid = ti.gid = 0
                ti.uname = ti.gname = ''
                t.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


def safe_extract(tgz, dst):
    with tarfile.open(tgz, 'r:gz') as t:
        for m in t.getmembers():
            if m.name.startswith(('/', '..')) or '/../' in m.name or not (m.isfile() or m.isdir()):
                raise SystemExit('build_windows: refusing archive member %s' % m.name)
        if hasattr(tarfile, 'data_filter'):
            t.extractall(dst, filter='data')
        else:
            t.extractall(dst)


# --------------------------------------------------------------------------------------------------------------------
# Running build.sh

class Remote:
    def __init__(self, conf):
        self.host = conf['ENCORE_WIN_SSH']
        self.opts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15']
        if conf.get('ENCORE_WIN_SSH_KEY'):
            self.opts = ['-i', os.path.expanduser(conf['ENCORE_WIN_SSH_KEY'])] + self.opts
        self.ssh = conf.get('ENCORE_SSH_BIN', 'ssh')
        self.scp = conf.get('ENCORE_SCP_BIN', 'scp')

    def run(self, cmd, check=True, timeout=120):
        r = subprocess.run([self.ssh] + self.opts + [self.host, cmd], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           timeout=timeout)
        out = r.stdout.decode('utf-8', 'replace')
        if check and r.returncode != 0:
            raise SystemExit('build_windows: remote command failed (%d): %s' % (r.returncode, out.strip()[-400:]))
        return r.returncode, out

    def put(self, local, remote):
        subprocess.run([self.scp, '-q'] + self.opts + [local, '%s:%s' % (self.host, remote)], check=True, timeout=1800)

    def get(self, remote, local):
        subprocess.run([self.scp, '-q'] + self.opts + ['%s:%s' % (self.host, remote), local], check=True, timeout=1800)


def home_expr(path, default):
    q = shlex.quote
    p = path or default
    if p.startswith('/'):
        return q(p)
    return '"$HOME"/' + q(p[2:] if p.startswith('~/') else p)


RESULT_SH = r'''cd "$1/out" && set -- && for f in EncoreBridge-*; do [ -f "$f" ] && set -- "$@" "$f"; done
[ -d staging ] && set -- "$@" staging
tar -czf ../result.tgz "$@"
'''


def build_remote(work, conf, ver, dev, timeout):
    rm = Remote(conf)
    q = shlex.quote
    parent = home_expr(conf.get('ENCORE_WIN_DIR'), 'encore-release-win')
    _, rdir = rm.run('mkdir -p %s && mktemp -d %s/winrelease.XXXXXX' % (parent, parent))
    rdir = rdir.strip().splitlines()[-1]
    if '/winrelease.' not in rdir:
        raise SystemExit('build_windows: unexpected remote folder')
    docker = 'sudo -n docker' if conf.get('ENCORE_WIN_SUDO') == '1' else 'docker'
    cache = conf.get('ENCORE_WIN_CACHE')
    try:
        fd, tmp = tempfile.mkstemp(suffix='.tgz')
        with os.fdopen(fd, 'wb') as f:
            f.write(pack(work, [d for d in ('tree', 'engine', 'ffmpeg', 'scan') if os.path.isdir(os.path.join(work, d))]))
        try:
            log('uploading the exported tree (%.1f MB)' % (os.path.getsize(tmp) / 1e6))
            rm.put(tmp, rdir + '/src.tgz')
        finally:
            os.unlink(tmp)
        args = ['--tree', 'tree', '--out', 'out', '--scan', 'scan/scan-bundle.sh']
        if os.path.isdir(os.path.join(work, 'engine')):
            args += ['--engine', 'engine']
        if os.path.isdir(os.path.join(work, 'ffmpeg')):
            args += ['--ffmpeg', 'ffmpeg']
        if dev:
            args.append('--dev')
        cache_arg = (' --cache ' + home_expr(cache, cache)) if cache else ''
        job = ('cd %s && tar -xzf src.tgz && DOCKER=%s SOURCE_DATE_EPOCH=%d bash tree/gateway/windows/build.sh %s%s '
               '> build.log 2>&1; echo $? > rc' % (q(rdir), q(docker), rc.source_date_epoch(),
                                                   ' '.join(q(a) for a in args), cache_arg))
        rm.run('nohup sh -c %s </dev/null >/dev/null 2>&1 &' % q(job))
        log('building on the Docker machine (launcher, staging folder, zip, installer) ...')
        t0 = time.time()
        while True:
            time.sleep(10)
            _, rcv = rm.run('cat %s/rc 2>/dev/null' % q(rdir), check=False)
            if rcv.strip():
                break
            if time.time() - t0 > timeout:
                raise SystemExit('build_windows: the remote build did not finish in %d s' % timeout)
        code = int(rcv.strip() or 1)
        rm.get(rdir + '/build.log', os.path.join(work, 'build.log'))
        if code == 0:
            log('fetching the results')
            rm.run('sh -c %s _ %s' % (q(RESULT_SH), q(rdir)), timeout=900)
            rm.get(rdir + '/result.tgz', os.path.join(work, 'result.tgz'))
            os.makedirs(os.path.join(work, 'out'))
            safe_extract(os.path.join(work, 'result.tgz'), os.path.join(work, 'out'))
        _, home = rm.run('printf %s "$HOME"', check=False)
        return code, home.strip()
    finally:
        c, _ = rm.run('rm -rf %s' % q(rdir), check=False)
        if c != 0 and docker.startswith('sudo'):
            rm.run('sudo -n rm -rf %s' % q(rdir), check=False)


def build_local(work, ver, dev):
    if not shutil.which('bash') or not shutil.which('docker'):
        raise SystemExit('build_windows: a local build needs bash and Docker; set ENCORE_WIN_SSH for a remote one')
    args = ['bash', os.path.join(work, 'tree', 'gateway', 'windows', 'build.sh'), '--tree', os.path.join(work, 'tree'),
            '--out', os.path.join(work, 'out'), '--scan', os.path.join(work, 'scan', 'scan-bundle.sh')]
    if os.path.isdir(os.path.join(work, 'engine')):
        args += ['--engine', os.path.join(work, 'engine')]
    if os.path.isdir(os.path.join(work, 'ffmpeg')):
        args += ['--ffmpeg', os.path.join(work, 'ffmpeg')]
    if dev:
        args.append('--dev')
    env = dict(os.environ, SOURCE_DATE_EPOCH=str(rc.source_date_epoch()))
    with open(os.path.join(work, 'build.log'), 'wb') as f:
        r = subprocess.run(args, stdout=f, stderr=subprocess.STDOUT, env=env)
    return r.returncode, os.path.expanduser('~')


# --------------------------------------------------------------------------------------------------------------------
# Static checks of the result (nothing is run)

def pe_versions(path):
    """{key: value} from a PE file's version resource (StringFileInfo), read without running the program."""
    with open(path, 'rb') as f:
        data = f.read()
    out = {}
    if data[:2] != b'MZ':
        return out
    for key in ('FileVersion', 'ProductVersion', 'ProductName', 'FileDescription', 'CompanyName', 'OriginalFilename',
                'LegalCopyright'):
        k = key.encode('utf-16-le') + b'\x00\x00'
        i = data.find(k)
        if i < 0:
            continue
        j = i + len(k)
        j += (4 - (j % 4)) % 4    # values are 32-bit aligned
        end = data.find(b'\x00\x00', j)
        while end >= 0 and (end - j) % 2:
            end = data.find(b'\x00\x00', end + 1)
        if end > j:
            out[key] = data[j:end].decode('utf-16-le', 'replace').strip()
    return out


def read_file(path):
    with open(path, 'rb') as f:
        return f.read()


def has_bytes(path, needle):
    return needle in read_file(path)


def read_pins(tree):
    pins = {}
    with open(os.path.join(tree, 'gateway', 'windows', 'bundle', 'pins.conf'), encoding='utf-8') as f:
        for line in f:
            m = re.match(r'^([A-Z0-9_]+)=(\S*)$', line.strip())
            if m:
                pins[m.group(1)] = m.group(2)
    return pins


GATEWAY_WIZARD_FILES = ('gateway/src/clientid.js', 'gateway/src/netcheck.js',
                        'gateway/src/wizard.js')   # the setup guide's modules (DESIGN-WIZARD 6.5, 11)
GATEWAY_UPDATE_FILES = ('gateway/src/update.js', 'gateway/src/updatekeys.js')   # the update check (DESIGN-UPDATES 7, 13)
# Test hooks that exist only in launcher builds with the Go build tag encoreupdatetest (DESIGN-UPDATES 9): a release
# launcher contains none of these strings
LAUNCHER_TEST_HOOKS = ('ENCORE_UPDATE_TEST_KEY', 'ENCORE_UPDATE_API', 'ENCORE_UPDATE_DOWNLOAD', '--update-test')
# The installer's update mode (DESIGN-UPDATES 5.7): gateway/windows/installer/EncoreBridge.iss must have these
INSTALLER_UPDATE_MARKS = ('ENCOREUPDATE', '--updated', '--update-failed')
INSTALLER_ISS = 'gateway/windows/installer/EncoreBridge.iss'


def update_checks(tree, stage, launcher, need, lines):
    """The update system in the payload (DESIGN-UPDATES 13): the bridge's and the launcher's trust lists are valid and
    equal, the launcher carries every trusted key and no test hook, and the installer script has its update mode."""
    lines.append('Updates (DESIGN-UPDATES):')
    js, go, problems = rc.read_trust_lists(tree)
    need(not problems, 'trust lists %s and %s valid and equal (%s)'
         % (rc.UPDATE_KEYS_JS, rc.UPDATE_KEYS_GO, '; '.join(problems) or '%d key(s): %s' % (
             len(js), ', '.join('%s %s' % (k['name'], k['id']) for k in js))))
    staged = os.path.join(stage, *rc.UPDATE_KEYS_JS.split('/'))
    same = os.path.isfile(staged) and read_file(staged) == read_file(os.path.join(tree, *rc.UPDATE_KEYS_JS.split('/')))
    need(same, 'the payload\'s %s is the exported tree\'s' % rc.UPDATE_KEYS_JS)
    exe = read_file(launcher) if os.path.isfile(launcher) else b''
    missing = [k['id'] for k in go if k['key'].encode('ascii') not in exe]
    need(bool(exe) and bool(go) and not missing,
         'Encore Bridge.exe carries every trusted key (%s)' % (('missing: ' + ', '.join(missing)) if missing else
                                                              '%d key(s)' % len(go)))
    hooks = [h for h in LAUNCHER_TEST_HOOKS if h.encode('ascii') in exe or h.encode('utf-16-le') in exe]
    need(bool(exe) and not hooks, 'Encore Bridge.exe has no update test hooks (%s)' % (', '.join(hooks) or 'none'))
    try:
        with open(os.path.join(tree, *INSTALLER_ISS.split('/')), encoding='utf-8-sig') as f:
            iss = f.read()
    except OSError:
        iss = ''
    gone = [m for m in INSTALLER_UPDATE_MARKS if m not in iss]
    need(bool(iss) and not gone, '%s has its update mode (%s)' % (INSTALLER_ISS, ('missing: ' + ', '.join(gone)) if gone
                                                                  else ', '.join(INSTALLER_UPDATE_MARKS)))
    lines.append('')


def no_app_package_checks(stage, files, need, lines):
    """The payload carries no app package and no Cydia source (DESIGN-WIZARD 5.6, 6.5): phones install Encore from the
    owner's Encore repo in Cydia, never from the bridge."""
    lines.append('No app package (the bridge hosts no Cydia source):')
    repo = [f for f in files if f.lower().startswith('gateway/repo/')]
    debs = [f for f in files if f.lower().endswith('.deb')]
    need(not repo and not os.path.isdir(os.path.join(stage, 'gateway', 'repo')),
         'no gateway/repo/ in the payload (%s)' % (', '.join(repo) or 'none'))
    need(not debs, 'no .deb in the payload (%s)' % (', '.join(debs) or 'none'))
    lines.append('')


def static_checks(tree, ver, zip_path, setup, payload, dev):
    """(report lines, problems)"""
    lines, problems = [], []
    stage = os.path.join(payload, 'Encore Bridge')
    files = rc.tree_files(stage)
    total = 0
    lines.append('Payload: "Encore Bridge\\" (%d files)' % len(files))
    for rel in files:
        p = os.path.join(stage, *rel.split('/'))
        size = os.path.getsize(p)
        total += size
        lines.append('  %s  %11d  %s' % (rc.sha256_file(p), size, rel))
    lines.append('  total %d bytes (%.1f MB)' % (total, total / 1e6))
    lines.append('')

    def need(cond, what):
        lines.append('  [%s] %s' % ('ok' if cond else 'FAIL', what))
        if not cond:
            problems.append(what)

    pins = read_pins(tree)
    lines.append('Versions (read from the files; nothing was run):')
    launcher = os.path.join(stage, 'Encore Bridge.exe')
    lv = pe_versions(launcher) if os.path.isfile(launcher) else {}
    lines.append('  Encore Bridge.exe   FileVersion %s, ProductVersion %s, ProductName %s'
                 % (lv.get('FileVersion'), lv.get('ProductVersion'), lv.get('ProductName')))
    need(os.path.isfile(launcher) and has_bytes(launcher, ver.encode()), 'launcher carries the version %s' % ver)
    numver = re.sub(r'[^0-9.].*$', '', ver)
    need(lv.get('FileVersion', '').startswith(numver), 'launcher FileVersion is %s' % numver)
    eng = os.path.join(stage, 'engine', ENGINE_EXE)
    if os.path.isfile(eng):
        stamp = has_bytes(eng, b'encore-engine %s') and has_bytes(eng, ver.encode())
        lines.append('  %s  sha256 %s, Encore stamp "encore-engine %s" %s'
                     % (ENGINE_EXE, rc.sha256_file(eng), ver, 'present' if stamp else 'MISSING'))
        need(stamp, 'engine is stamped %s (patch 6 version line)' % ver)
        imports = pe_imports(eng)
        lines.append('  %s  DLL imports: %s' % (ENGINE_EXE, ', '.join(imports)))
        need(imports and all(SYSTEM_DLLS.match(d) for d in imports), 'engine imports system DLLs only')
    else:
        need(dev, 'engine present')
    node = os.path.join(stage, 'runtime', 'node.exe')
    nv = pe_versions(node) if os.path.isfile(node) else {}
    lines.append('  node.exe            ProductVersion %s, sha256 %s' % (nv.get('ProductVersion'),
                                                                        rc.sha256_file(node) if nv else '-'))
    need(nv.get('ProductVersion', '').lstrip('v') == pins.get('NODE_VERSION'), 'node.exe is Node.js %s' % pins.get('NODE_VERSION'))
    need(os.path.isfile(node) and rc.sha256_file(node) == pins.get('NODE_EXE_SHA256'), 'node.exe matches the pinned SHA-256')
    ff = os.path.join(stage, 'ffmpeg', 'ffmpeg.exe')
    fv = pe_versions(ff) if os.path.isfile(ff) else {}
    conf_line = ''
    if os.path.isfile(ff):
        with open(ff, 'rb') as f:
            m = re.search(rb'--(?:prefix|target-os|enable-|disable-)[ -~]{20,}', f.read())
            conf_line = m.group(0).decode('ascii', 'replace') if m else ''
    lgpl = bool(conf_line) and not any(o in ' ' + conf_line for o in (' --enable-gpl', ' --enable-nonfree', ' --enable-version3'))
    lines.append('  ffmpeg.exe          sha256 %s, configure: %s' % (
        rc.sha256_file(ff) if os.path.isfile(ff) else '-', 'LGPL-2.1 (no --enable-gpl/nonfree/version3)' if lgpl else 'NOT LGPL-2.1'))
    need(lgpl, 'ffmpeg.exe is an LGPL-2.1 build')
    if os.path.isfile(ff):
        ffimports = pe_imports(ff)
        lines.append('  ffmpeg.exe          DLL imports: %s' % ', '.join(ffimports))
        need(ffimports and all(SYSTEM_DLLS.match(d) for d in ffimports), 'ffmpeg.exe imports system DLLs only (one static build)')
    ffver = pins.get('FFMPEG_VERSION', '')
    need(bool(ffver) and os.path.isfile(ff) and has_bytes(ff, ('version ' + ffver).encode()),
         'ffmpeg.exe reports version %s' % ffver)
    vtxt = os.path.join(stage, 'VERSIONS.txt')
    if os.path.isfile(vtxt):
        with open(vtxt, encoding='utf-8') as f:
            lines.append('  VERSIONS.txt:')
            lines += ['    ' + l.rstrip() for l in f]
    need(rc.read_versions(stage)[1] == ver, 'gateway/src/config.js in the payload says %s' % ver)
    need(not os.path.exists(os.path.join(stage, 'DEV-BUILD.txt')) or dev, 'not a DEV bundle')
    lines.append('')

    lines.append('Required files:')
    for rel in ('Encore Bridge.exe', 'runtime/node.exe', 'ffmpeg/ffmpeg.exe', 'engine/' + ENGINE_EXE,
                'engine/config.template.yml', 'settings.env.template', 'README-Windows.txt', 'VERSIONS.txt',
                'gateway/src/main.js', 'gateway/src/admin.html', 'licenses/Encore/LICENSE.txt',
                'licenses/THIRD-PARTY-NOTICES.md', 'licenses/go-librespot/LICENSE.txt',
                'licenses/go-librespot/ENCORE_PATCH.md', 'licenses/go-librespot/SOURCE.txt', 'licenses/node/LICENSE.txt',
                'licenses/ffmpeg/LICENSE.txt', 'licenses/ffmpeg/SOURCE.txt', 'licenses/ffmpeg/zlib.txt',
                'licenses/ffmpeg/BUILDINFO.txt', 'licenses/launcher/MODULES.txt') + GATEWAY_WIZARD_FILES \
            + GATEWAY_UPDATE_FILES:
        need(rel in files, rel)
    bad = [f for f in files if rc.forbidden_reason(f)]
    need(not bad, 'no never-ship file names (%s)' % (', '.join(bad) or 'none'))
    lines.append('')
    no_app_package_checks(stage, files, need, lines)
    update_checks(tree, stage, launcher, need, lines)

    lines.append('Portable zip: %s' % os.path.basename(zip_path))
    if os.path.isfile(zip_path):
        with zipfile.ZipFile(zip_path) as z:
            infos = [i for i in z.infolist() if not i.is_dir()]
            names = sorted(i.filename for i in infos)
            want = sorted('Encore Bridge/' + f for f in files)
            need(names == want, 'zip holds exactly the payload files (%d)' % len(names))
            same = names == want and all(z.read(i.filename) == read_file(os.path.join(payload, *i.filename.split('/')))
                                         for i in infos)
            need(same, 'zip file contents are byte-identical to the payload')
        lines.append('  %s  %d bytes' % (rc.sha256_file(zip_path), os.path.getsize(zip_path)))
    else:
        need(False, 'zip present')
    lines.append('')
    lines.append('Installer: %s' % (os.path.basename(setup) if setup else '-'))
    if setup and os.path.isfile(setup):
        sv = pe_versions(setup)
        with open(setup, 'rb') as f:
            head = f.read()
        need(head[:2] == b'MZ', 'installer is a Windows program')
        need(b'Inno Setup' in head, 'installer is an Inno Setup installer')
        lines.append('  version resource: %s' % ', '.join('%s=%s' % kv for kv in sorted(sv.items())))
        need(sv.get('ProductVersion', '').startswith(ver) or sv.get('FileVersion', '').startswith(numver),
             'installer version resource names %s' % ver)
        lines.append('  %s  %d bytes' % (rc.sha256_file(setup), os.path.getsize(setup)))
    else:
        need(False, 'installer present')
    return lines, problems


SYSTEM_DLLS = re.compile(r'(?i)^(kernel32|msvcrt|ucrtbase|api-ms-win-[a-z0-9-]+|ntdll|advapi32|ws2_32|winmm|ole32|'
                         r'oleaut32|user32|shell32|bcrypt|crypt32|secur32|iphlpapi|dnsapi|userenv|powrprof|shlwapi|'
                         r'mswsock|wsock32)\.dll$')


def pe_imports(path):
    """Imported DLL names of a PE32+ file (import directory only)."""
    with open(path, 'rb') as f:
        d = f.read()
    try:
        pe = struct.unpack_from('<I', d, 0x3c)[0]
        if d[pe:pe + 4] != b'PE\0\0':
            return []
        nsec = struct.unpack_from('<H', d, pe + 6)[0]
        optsz = struct.unpack_from('<H', d, pe + 20)[0]
        opt = pe + 24
        magic = struct.unpack_from('<H', d, opt)[0]
        dd = opt + (112 if magic == 0x20b else 96)
        imp_rva = struct.unpack_from('<I', d, dd + 8)[0]
        secs = []
        for i in range(nsec):
            s = opt + optsz + 40 * i
            vsize, va, rsize, raw = struct.unpack_from('<IIII', d, s + 8)
            secs.append((va, max(vsize, rsize), raw))

        def off(rva):
            for va, size, raw in secs:
                if va <= rva < va + size:
                    return rva - va + raw
            raise ValueError(rva)
        names, p = [], off(imp_rva)
        while True:
            ilt, _, _, name_rva, iat = struct.unpack_from('<IIIII', d, p)
            if not (ilt or name_rva or iat):
                break
            o = off(name_rva)
            names.append(d[o:d.index(b'\0', o)].decode('ascii', 'replace'))
            p += 20
        return sorted(set(names), key=str.lower)
    except (struct.error, ValueError):
        return []


# --------------------------------------------------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--tree', required=True, help='the exported source tree')
    ap.add_argument('--out', required=True, help='assets folder')
    ap.add_argument('--engine', help='output folder of gateway/windows/build-engine/build.sh (encore-engine.exe)')
    ap.add_argument('--engine-build', help='folder with that build\'s licenses/, BUILDINFO.txt and SHA256SUMS, '
                    'when they are not next to the exe')
    ap.add_argument('--go-vendor', help='"go mod vendor" folder of gateway/engine-src: adds the Go module licenses')
    ap.add_argument('--ffmpeg', help='output folder of gateway/windows/build-ffmpeg/build.sh (ffmpeg.exe, SHA256SUMS, '
                    'BUILDINFO.txt, licenses/)')
    ap.add_argument('--reports', help='where the bundle report, logs and static checks go (default: <out>/../reports)')
    ap.add_argument('--local', action='store_true', help='build on this machine (bash + Docker)')
    ap.add_argument('--dev', action='store_true', help='a development bundle (bundle.sh --dev); never a release')
    ap.add_argument('--conf', default=rc.LOCAL_CONF_DEFAULT)
    ap.add_argument('--timeout', type=int, default=3600, help='seconds for the build itself')
    a = ap.parse_args(argv)

    tree, out = os.path.abspath(a.tree), os.path.abspath(a.out)
    reports = os.path.abspath(a.reports or os.path.join(os.path.dirname(out), 'reports'))
    if not os.path.isfile(os.path.join(tree, 'gateway', 'windows', 'build.sh')):
        print('build_windows: %s has no gateway/windows/build.sh (not an exported tree?)' % tree, file=sys.stderr)
        return 2
    if os.path.isdir(os.path.join(tree, '.git')) or os.path.exists(os.path.join(tree, 'RELEASE-PLAN.md')):
        print('build_windows: that looks like a working copy; build only from an exported tree', file=sys.stderr)
        return 2
    ver = rc.read_versions(tree)[1]
    if not ver:
        print('build_windows: no bridge version in gateway/src/config.js', file=sys.stderr)
        return 2
    if not a.engine and not a.dev:
        print('build_windows: --engine is required (only a --dev bundle may lack the engine)', file=sys.stderr)
        return 2
    if not a.ffmpeg and not a.dev:
        print('build_windows: --ffmpeg is required (only a --dev bundle may lack FFmpeg)', file=sys.stderr)
        return 2
    conf = rc.read_local_conf(a.conf)
    name = 'EncoreBridge-%s%s' % (ver, '-DEV' if a.dev else '')
    for p in (os.path.join(out, name + '-win64.zip'), os.path.join(out, name + '-setup.exe'),
              os.path.join(out, name + '-windows-payload')):
        if os.path.exists(p):
            print('build_windows: %s already exists' % p, file=sys.stderr)
            return 2

    problems, warnings = [], []
    work = tempfile.mkdtemp(prefix='encore-win-')
    try:
        shutil.copytree(tree, os.path.join(work, 'tree'))
        if a.engine:
            assemble_engine(os.path.abspath(a.engine), a.engine_build and os.path.abspath(a.engine_build),
                            a.go_vendor and os.path.abspath(a.go_vendor), os.path.join(work, 'engine'), a.dev,
                            problems, warnings)
        if a.ffmpeg:
            assemble_ffmpeg(os.path.abspath(a.ffmpeg), os.path.join(work, 'ffmpeg'), problems)
        for w in warnings:
            log('warning: %s' % w)
        if problems:
            for p in problems:
                log('FAIL %s' % p)
            return 1
        scan_kit(tree, os.path.join(work, 'scan'))
        if a.local or not conf.get('ENCORE_WIN_SSH'):
            code, home = build_local(work, ver, a.dev)
        else:
            code, home = build_remote(work, conf, ver, a.dev, a.timeout)

        os.makedirs(reports, exist_ok=True)
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(work, 'build.log'), 'rb') as f:
            text = f.read().decode('utf-8', 'replace')
        for path, tag in sorted({(work, '<work>'), (home, '~')} - {('', '~')}, key=lambda x: -len(x[0])):
            text = text.replace(path, tag)
        with open(os.path.join(reports, 'windows-build-log.txt'), 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
        res = os.path.join(work, 'out')
        # (the Inno Setup log is kept as .txt: release.py scans reports/, and the scan never opens a *.log file)
        for suffix, dest in (('-bundle-report.txt', '-bundle-report.txt'), ('-iscc.log', '-iscc-log.txt')):
            p = os.path.join(res, name + suffix)
            if os.path.isfile(p):
                shutil.copyfile(p, os.path.join(reports, name + dest))
        if code != 0:
            tail = '\n'.join(text.strip().splitlines()[-25:])
            print(tail)
            log('FAILED (build.sh exit %d); log in %s' % (code, os.path.join(reports, 'windows-build-log.txt')))
            return 1
        zip_src, setup_src = os.path.join(res, name + '-win64.zip'), os.path.join(res, name + '-setup.exe')
        staging = os.path.join(res, 'staging')
        if not (os.path.isfile(zip_src) and os.path.isdir(staging)):
            log('FAILED: build.sh made no zip or staging folder')
            return 1
        try:
            os.unlink(os.path.join(work, 'result.tgz'))   # disk space: the results are unpacked already
        except OSError:
            pass
        zip_dst = os.path.join(out, name + '-win64.zip')
        shutil.move(zip_src, zip_dst)
        setup_dst = None
        if os.path.isfile(setup_src):
            setup_dst = os.path.join(out, name + '-setup.exe')
            shutil.move(setup_src, setup_dst)
        payload = os.path.join(out, name + '-windows-payload')
        shutil.move(staging, payload)

        lines, bad = static_checks(tree, ver, zip_dst, setup_dst, payload, a.dev)
        head = ['Encore Bridge %s for Windows: static checks (%s)' % (ver, time.strftime('%Y-%m-%d %H:%M')),
                'result: %s' % ('PASS' if not bad else 'FAIL (%d)' % len(bad))]
        head += ['warning: %s' % w for w in warnings]
        with open(os.path.join(reports, 'windows-static-checks.txt'), 'w', encoding='utf-8', newline='\n') as f:
            f.write('\n'.join(head + [''] + lines) + '\n')
        for p in bad:
            log('FAIL %s' % p)
        for p in (zip_dst, setup_dst):
            if p:
                log('%s  %s (%d bytes)' % (rc.sha256_file(p), os.path.basename(p), os.path.getsize(p)))
        log('static checks: %s; report %s' % ('PASS' if not bad else 'FAIL', os.path.join(reports, 'windows-static-checks.txt')))
        return 1 if bad else 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
