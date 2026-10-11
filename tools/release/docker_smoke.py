#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Docker smoke build of the bridge from an EXPORTED tree, on a scratch Linux machine with Docker (never a live server).

    python tools/release/docker_smoke.py --tree <exported tree> [--keep]

It builds both images exactly the way compose.yaml does (gateway/ and gateway/engine-src/) under throw-away
"release-smoke" tags, checks that the bridge's JavaScript parses, that the image has no /app/repo and no .deb under
/app (the bridge hosts no Cydia source: phones install the app from the owner's Encore repo, DESIGN-WIZARD 5.6) and
that the engine binary exists, then deletes the images (unless --keep) and the copied sources.
Nothing is started on the network and no Spotify sign-in is needed.

Settings (tools/release/release.local.env, never exported, or the environment):
  ENCORE_DOCKER_SSH       user@host of the Docker machine
  ENCORE_DOCKER_SSH_KEY   private key file (optional)
  ENCORE_DOCKER_DIR       parent folder for the copied sources on that machine (default: encore-release-smoke in the
                          remote home folder)
  ENCORE_DOCKER_SUDO      1 to run docker through "sudo -n"
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

SMOKE_SH = r'''#!/bin/sh
# runs inside the copied release folder on the Docker machine
set -eu
D="$1"; TAG="$2"; KEEP="$3"
GW="encore-gateway:release-smoke-$TAG"
EN="encore-engine:release-smoke-$TAG"
echo "smoke: building $GW"
$D build -t "$GW" tree/gateway
echo "smoke: building $EN"
$D build -t "$EN" tree/gateway/engine-src
echo "smoke: checking the bridge sources parse"
$D run --rm --network none --entrypoint /bin/sh "$GW" -c 'for f in /app/src/*.js; do node --check "$f" || exit 1; done; node --version'
echo "smoke: checking the image carries no Cydia source"
$D run --rm --network none --entrypoint /bin/sh "$GW" -c 'test ! -e /app/repo && test -z "$(find /app -name "*.deb" | head -n 1)" && echo no /app/repo, no deb'
echo "smoke: checking the engine binary"
$D run --rm --network none --entrypoint /bin/sh "$EN" -c 'test -x /usr/bin/go-librespot && echo engine binary ok'
if [ "$KEEP" != "1" ]; then
  $D image rm "$GW" "$EN" >/dev/null
  echo "smoke: images removed"
fi
echo "smoke: OK"
'''


def make_tar(tree):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as t:
        def add(name, data, mode=0o644):
            ti = tarfile.TarInfo(name)
            ti.size, ti.mtime, ti.mode = len(data), int(time.time()), mode
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = ''
            t.addfile(ti, io.BytesIO(data))
        gw = os.path.join(tree, 'gateway')
        for rel in rc.tree_files(gw):
            if rel.startswith(('windows/', 'test/', 'tools/')):
                continue
            with open(os.path.join(gw, *rel.split('/')), 'rb') as f:
                add('tree/gateway/' + rel, f.read(), 0o755 if rel.endswith('.sh') else 0o644)
        add('smoke.sh', SMOKE_SH.encode(), 0o755)
    return buf.getvalue()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--tree', required=True)
    ap.add_argument('--keep', action='store_true', help='keep the built images')
    ap.add_argument('--conf', default=rc.LOCAL_CONF_DEFAULT)
    ap.add_argument('--timeout', type=int, default=2400)
    a = ap.parse_args(argv)
    tree = os.path.abspath(a.tree)
    conf = rc.read_local_conf(a.conf)
    host = conf.get('ENCORE_DOCKER_SSH')
    if not host:
        print('docker_smoke: no ENCORE_DOCKER_SSH configured; skipped', file=sys.stderr)
        return 3
    if not os.path.isfile(os.path.join(tree, 'gateway', 'Dockerfile')):
        print('docker_smoke: %s is not an exported tree' % tree, file=sys.stderr)
        return 2
    opts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15']
    if conf.get('ENCORE_DOCKER_SSH_KEY'):
        opts = ['-i', os.path.expanduser(conf['ENCORE_DOCKER_SSH_KEY'])] + opts
    ssh, scp = conf.get('ENCORE_SSH_BIN', 'ssh'), conf.get('ENCORE_SCP_BIN', 'scp')
    q = shlex.quote
    parent = conf.get('ENCORE_DOCKER_DIR', 'encore-release-smoke')
    docker = 'sudo -n docker' if conf.get('ENCORE_DOCKER_SUDO') == '1' else 'docker'
    ver = (rc.read_versions(tree)[0] or 'x').replace('+', '-')

    def run(cmd, timeout=120, check=True):
        r = subprocess.run([ssh] + opts + [host, cmd], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        out = r.stdout.decode('utf-8', 'replace')
        if check and r.returncode:
            raise SystemExit('docker_smoke: remote command failed (%d): %s' % (r.returncode, out.strip()[-600:]))
        return r.returncode, out

    parent_expr = parent if parent.startswith('/') else '"$HOME"/' + q(parent.lstrip('~/'))
    _, rdir = run('mkdir -p %s && mktemp -d %s/run.XXXXXX' % (parent_expr, parent_expr))
    rdir = rdir.strip().splitlines()[-1]
    if '/run.' not in rdir:
        raise SystemExit('docker_smoke: unexpected remote folder')
    try:
        fd, tmp = tempfile.mkstemp(suffix='.tgz')
        with os.fdopen(fd, 'wb') as f:
            f.write(make_tar(tree))
        try:
            subprocess.run([scp, '-q'] + opts + [tmp, '%s:%s/src.tgz' % (host, rdir)], check=True, timeout=600)
        finally:
            os.unlink(tmp)
        code, out = run('cd %s && tar -xzf src.tgz && sh smoke.sh %s %s %s 2>&1 | tail -n 40'
                        % (q(rdir), q(docker), q(ver), '1' if a.keep else '0'), timeout=a.timeout, check=False)
        print(out.rstrip())
        ok = code == 0 and 'smoke: OK' in out
    finally:
        run('rm -rf %s' % q(rdir), check=False)
    print('docker_smoke: %s' % ('OK' if ok else 'FAILED'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
