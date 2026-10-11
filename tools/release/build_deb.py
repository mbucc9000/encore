#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Build the public deb from an EXPORTED tree, locally or on a Theos machine over SSH.

    python tools/release/build_deb.py --tree <exported tree> --out <assets folder> [--local]

Local (--local, or no build host configured): runs build-deb.sh here; needs Theos ($THEOS).
Remote: settings come from tools/release/release.local.env (never exported; see release.example.env) or from the
environment:
  ENCORE_DEB_SSH       user@host of the Theos machine
  ENCORE_DEB_SSH_KEY   private key file for it (optional)
  ENCORE_DEB_THEOS     Theos path on that machine (default: ~/theos)
  ENCORE_SSH_BIN / ENCORE_SCP_BIN   ssh and scp programs (default: from PATH)
The remote build runs detached (nohup) in a fresh mktemp folder under /tmp, is polled until it finishes, the deb is
copied back, and the folder is removed. It waits while another "make package" runs on that machine, so two builds
never share it.
"""
import argparse
import io
import os
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time

sys.dont_write_bytecode = True   # keep __pycache__ out of the working copy
import relcommon as rc  # noqa: E402


def tar_for_build(tree):
    """app/ + tools/release/build-deb.sh as a .tar.gz in memory, with executable maintainer scripts."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as t:
        files = ['app/' + r for r in rc.tree_files(os.path.join(tree, 'app'))] + ['tools/release/build-deb.sh']
        for rel in files:
            with open(os.path.join(tree, *rel.split('/')), 'rb') as f:
                data = f.read()
            if rel.endswith('.sh'):
                data = data.replace(b'\r\n', b'\n')
            ti = tarfile.TarInfo('tree/' + rel)
            ti.size = len(data)
            ti.mtime = int(time.time())
            ti.mode = 0o755 if ('/DEBIAN/' in rel or rel.endswith('.sh')) else 0o644
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = ''
            t.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


class Remote:
    def __init__(self, conf):
        self.host = conf['ENCORE_DEB_SSH']
        key = conf.get('ENCORE_DEB_SSH_KEY')
        self.opts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15']
        if key:
            self.opts = ['-i', os.path.expanduser(key)] + self.opts
        self.ssh = conf.get('ENCORE_SSH_BIN', 'ssh')
        self.scp = conf.get('ENCORE_SCP_BIN', 'scp')

    def run(self, cmd, check=True, timeout=120):
        r = subprocess.run([self.ssh] + self.opts + [self.host, cmd], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           timeout=timeout)
        out = r.stdout.decode('utf-8', 'replace')
        if check and r.returncode != 0:
            raise SystemExit('build_deb: remote command failed (%d): %s' % (r.returncode, out.strip()[-400:]))
        return r.returncode, out

    def put(self, local, remote):
        subprocess.run([self.scp, '-q'] + self.opts + [local, '%s:%s' % (self.host, remote)], check=True, timeout=600)

    def get(self, remote, local):
        subprocess.run([self.scp, '-q'] + self.opts + ['%s:%s' % (self.host, remote), local], check=True, timeout=600)


def build_remote(tree, out, conf, wait_busy, timeout):
    rm = Remote(conf)
    theos = conf.get('ENCORE_DEB_THEOS', '~/theos')
    t0 = time.time()
    while True:   # "[m]ake" keeps pgrep from matching this very command line
        code, _ = rm.run('pgrep -f "[m]ake package" >/dev/null', check=False)
        if code != 0:
            break
        if time.time() - t0 > wait_busy:
            raise SystemExit('build_deb: another build is still running on the build machine; try again later')
        print('build_deb: the build machine is busy, waiting ...')
        time.sleep(20)
    _, rdir = rm.run('mktemp -d /tmp/encore-release.XXXXXX')
    rdir = rdir.strip().splitlines()[-1]
    if not rdir.startswith('/tmp/encore-release.'):
        raise SystemExit('build_deb: unexpected remote folder')
    q = shlex.quote
    try:
        fd, tmp = tempfile.mkstemp(suffix='.tgz')
        with os.fdopen(fd, 'wb') as f:
            f.write(tar_for_build(tree))
        try:
            rm.put(tmp, rdir + '/src.tgz')
        finally:
            os.unlink(tmp)
        theos_expr = '"$HOME"/' + q(theos[2:]) if theos.startswith('~/') else q(theos)
        job = ('cd %s && tar -xzf src.tgz && THEOS=%s sh tree/tools/release/build-deb.sh tree out > build.log 2>&1; '
               'echo $? > rc' % (q(rdir), theos_expr))
        rm.run('nohup sh -c %s </dev/null >/dev/null 2>&1 &' % q(job))
        t1 = time.time()
        while True:
            time.sleep(5)
            code, rcv = rm.run('cat %s/rc 2>/dev/null' % q(rdir), check=False)
            if rcv.strip():
                break
            if time.time() - t1 > timeout:
                raise SystemExit('build_deb: the remote build did not finish in %d s' % timeout)
        if rcv.strip() != '0':
            _, log = rm.run('grep -E "error|Error|warning:" %s/build.log | head -n 40' % q(rdir), check=False)
            print(log)
            raise SystemExit('build_deb: remote build FAILED (rc=%s)' % rcv.strip())
        _, name = rm.run('cd %s/out && ls *.deb' % q(rdir))
        name = name.strip().splitlines()[-1]
        os.makedirs(out, exist_ok=True)
        rm.get('%s/out/%s' % (rdir, name), os.path.join(out, name))
        return os.path.join(out, name)
    finally:
        rm.run('rm -rf %s' % q(rdir), check=False)


def build_local(tree, out):
    script = os.path.join(tree, 'tools', 'release', 'build-deb.sh')
    subprocess.run(['sh', script, tree, out], check=True)
    ver = rc.read_versions(tree)[0]
    return os.path.join(out, 'Encore_%s_iphoneos-arm.deb' % ver)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--tree', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--local', action='store_true', help='build here with Theos instead of over SSH')
    ap.add_argument('--conf', default=rc.LOCAL_CONF_DEFAULT)
    ap.add_argument('--wait-busy', type=int, default=900, help='seconds to wait for a busy build machine')
    ap.add_argument('--timeout', type=int, default=1200, help='seconds for the build itself')
    a = ap.parse_args(argv)
    tree, out = os.path.abspath(a.tree), os.path.abspath(a.out)
    if not os.path.isfile(os.path.join(tree, 'app', 'control')):
        print('build_deb: %s is not an exported tree' % tree, file=sys.stderr)
        return 2
    if os.path.isdir(os.path.join(tree, '.git')) or os.path.exists(os.path.join(tree, 'RELEASE-PLAN.md')):
        print('build_deb: that looks like a working copy; build only from an exported tree', file=sys.stderr)
        return 2
    conf = rc.read_local_conf(a.conf)
    if a.local or not conf.get('ENCORE_DEB_SSH'):
        deb = build_local(tree, out)
    else:
        deb = build_remote(tree, out, conf, a.wait_busy, a.timeout)
    print('build_deb: %s (%d bytes)' % (deb, os.path.getsize(deb)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
