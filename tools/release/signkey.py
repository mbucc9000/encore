#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""The Encore release-signing key (Ed25519; DESIGN-UPDATES 4.4): make it once, show its public half.

    python tools/release/signkey.py generate --key <folder>/_keys/encore-release-ed25519.key
    python tools/release/signkey.py public --pub <folder>/_keys/encore-release-ed25519.pub [--format ...]
    python tools/release/signkey.py public --key <private key file> [--format ...]

generate  makes a new key pair, only when none exists (never overwrites):
            encore-release-<...>.key  the PRIVATE key, PKCS#8 PEM, unencrypted (release.py --final signs unattended),
                                      created exclusively and made owner-only (Windows: icacls, inheritance removed,
                                      only you; elsewhere: mode 0600). A parent folder named _keys gets the same
                                      first; on Windows any other folder must be owner-only already (refused else).
            encore-release-<...>.pub  the PUBLIC key, PEM SubjectPublicKeyInfo, next to it
          The key must live outside the working copy, in a file named encore-release-<...>.key (the never-ship rules
          of relcommon.py and the scanner know that name and the _keys folder). It prints the public key only.
public    prints the public key again: --format text (default: everything below), pem, base64 (raw 32 bytes), id,
          js (the gateway/src/updatekeys.js entry), go (the launcher's internal/update/keys.go entry), json.
          With --key the private key is read in this process to derive its public half; nothing private is printed.

The key id is the first 16 hex digits of SHA-256 over the raw 32-byte public key. --name (default encore-release-<n>
from the file name: encore-release-ed25519-2.key -> encore-release-2) and --added (default today) fill the list entry.

Nothing private is ever printed: not the key, not its seed, nothing derived from it. Errors are reduced to a message
without content. Needs Python's "cryptography" package (never installed by these tools).
Exit code: 0 = ok, 1 = refused or failed, 2 = usage error.
"""
import argparse
import base64
import datetime
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True   # keep __pycache__ out of the working copy
import relcommon as rc  # noqa: E402
import sign  # noqa: E402


class KeyError_(Exception):
    def __init__(self, msg, code=1):
        Exception.__init__(self, msg)
        self.code = code


def pub_path_of(key_path):
    base = key_path[:-4] if key_path.lower().endswith('.key') else key_path
    return base + '.pub'


def default_name(path):
    m = re.search(r'-(\d+)\.(?:key|pub)$', os.path.basename(path), re.IGNORECASE)
    return 'encore-release-%d' % (int(m.group(1)) if m else 1)


# --------------------------------------------------------------------------------------------------------------------
# Owner-only permissions

def _icacls(args):
    r = subprocess.run(['icacls'] + args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    enc = 'oem' if hasattr(sys, 'getwindowsversion') else 'utf-8'
    try:
        out = r.stdout.decode(enc, 'replace')
    except LookupError:
        out = r.stdout.decode('utf-8', 'replace')
    return r.returncode, out


def acl_entries(path):
    """[access entry text] of a file or folder's ACL (Windows: icacls). For checks only; never printed."""
    code, out = _icacls([path])
    if code != 0:
        return None
    lines = []
    for line in out.splitlines():
        if not line.strip() or line.startswith('Successfully processed') or 'processed' in line.lower():
            continue
        if line.startswith(path):
            line = line[len(path):]
        if ':(' in line:
            lines.append(line.strip())
    return lines


def current_user():
    dom, user = os.environ.get('USERDOMAIN', ''), os.environ.get('USERNAME', '')
    return ('%s\\%s' % (dom, user)) if dom else user


def make_owner_only(path, folder=False):
    """Restrict path to the current user. Returns True when the result is checked: exactly one entry, ours, full."""
    if os.name != 'nt':
        os.chmod(path, 0o700 if folder else 0o600)
        mode = os.stat(path).st_mode & 0o777
        return mode == (0o700 if folder else 0o600)
    user = current_user()
    if not user:
        return False
    grant = '%s:%sF' % (user, '(OI)(CI)' if folder else '')
    code, _ = _icacls([path, '/inheritance:r', '/grant:r', grant])
    if code != 0:
        return False
    ents = acl_entries(path)
    if not ents or len(ents) != 1:
        return False
    e = ents[0].lower()
    want = '(oi)(ci)(f)' if folder else '(f)'
    return e.startswith(user.lower() + ':') and e.endswith(want)


def is_owner_only(path, folder=False):
    """The same check without changing anything."""
    if os.name != 'nt':
        return (os.stat(path).st_mode & 0o777) == (0o700 if folder else 0o600)
    ents = acl_entries(path)
    if not ents or len(ents) != 1:
        return False
    e = ents[0].lower()
    return e.startswith(current_user().lower() + ':') and e.endswith('(oi)(ci)(f)' if folder else '(f)')


# --------------------------------------------------------------------------------------------------------------------

def public_info(raw, name, added):
    b64 = base64.b64encode(raw).decode('ascii')
    kid = rc.key_id(raw)
    return {
        'id': kid, 'key': b64, 'name': name, 'added': added, 'pem': sign.public_pem(raw),
        'js': "{ id: '%s', key: '%s', name: '%s', added: '%s' }" % (kid, b64, name, added),
        'go': '{ID: "%s", Key: "%s", Name: "%s"}' % (kid, b64, name),
    }


def render(info, fmt):
    if fmt == 'pem':
        return info['pem'].rstrip('\n')
    if fmt == 'base64':
        return info['key']
    if fmt == 'id':
        return info['id']
    if fmt == 'js':
        return info['js']
    if fmt == 'go':
        return info['go']
    if fmt == 'json':
        return json.dumps({k: info[k] for k in ('id', 'key', 'name', 'added', 'pem')}, indent=1)
    return '\n'.join([
        'key id     : %s' % info['id'],
        'public key : %s   (base64 of the raw 32 bytes)' % info['key'],
        info['pem'].rstrip('\n'),
        'gateway/src/updatekeys.js entry                    : %s' % info['js'],
        'gateway/windows/launcher/internal/update/keys.go entry: %s' % info['go'],
    ])


def generate(key_path, name, added):
    key_path = os.path.abspath(key_path)
    base = os.path.basename(key_path)
    if not rc.RELEASE_KEY_NAME_RX.match(base):
        raise KeyError_('the key file must be named encore-release-<...>.key (the never-ship rules know that name)', 2)
    if rc.is_inside(key_path, rc.REPO_ROOT):
        raise KeyError_('the key must live outside the working copy', 2)
    pub_path = pub_path_of(key_path)
    if os.path.exists(key_path):
        raise KeyError_('%s already exists: not overwritten (signkey.py public --pub %s shows its public key)'
                        % (base, os.path.basename(pub_path)), 1)
    if os.path.exists(pub_path):
        raise KeyError_('%s exists without its private key: move it away first' % os.path.basename(pub_path), 1)
    serialization, Ed25519PrivateKey, _, _ = sign.crypto()
    folder = os.path.dirname(key_path)
    keys_folder = os.path.basename(folder).lower() == '_keys'
    # Windows ignores the 0600 below: a new file first gets its folder's access rules, and anyone who can open it before
    # make_owner_only() keeps that handle. So the key is only written into a folder that is owner-only already.
    if os.name == 'nt' and not keys_folder and not (os.path.isdir(folder) and is_owner_only(folder, folder=True)):
        raise KeyError_('on Windows the key goes into a folder named _keys (made owner-only before the key is written) '
                        'or a folder that is owner-only already; nothing was written', 2)
    os.makedirs(folder, exist_ok=True)
    if keys_folder and not make_owner_only(folder, folder=True):
        raise KeyError_('the _keys folder couldn\'t be made owner-only; nothing was written', 1)
    key = Ed25519PrivateKey.generate()
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption())
    raw = sign.raw_public(key)
    key = None
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_BINARY', 0)
    fd = os.open(key_path, flags, 0o600)
    try:
        os.write(fd, pem)
    finally:
        os.close(fd)
        pem = None
    if not make_owner_only(key_path):
        os.unlink(key_path)    # never used: a key whose access can't be restricted is not kept
        raise KeyError_('%s couldn\'t be made owner-only, so it was removed again; nothing was kept' % base, 1)
    info = public_info(raw, name or default_name(key_path), added)
    fd = os.open(pub_path, flags, 0o644)
    try:
        os.write(fd, info['pem'].encode('ascii'))
    finally:
        os.close(fd)
    return info, base, os.path.basename(pub_path)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd')
    g = sub.add_parser('generate', help='make the key pair once (never overwrites)')
    g.add_argument('--key', required=True, help='<folder>/_keys/encore-release-ed25519.key, outside the working copy')
    p = sub.add_parser('public', help='print the public key')
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument('--pub', help='the .pub file (public, PEM)')
    src.add_argument('--key', help='the private key file (read here to derive its public half; nothing private is printed)')
    p.add_argument('--format', default='text', choices=('text', 'pem', 'base64', 'id', 'js', 'go', 'json'))
    for x in (g, p):
        x.add_argument('--name', help='list entry name (default encore-release-<n> from the file name)')
        x.add_argument('--added', default=datetime.date.today().isoformat(), help='list entry date (default today)')
    a = ap.parse_args(argv)
    if not a.cmd:
        ap.print_help()
        return 2
    try:
        if a.cmd == 'generate':
            info, kname, pname = generate(a.key, a.name, a.added)
            print('signkey: wrote %s (private, owner-only: checked) and %s (public)' % (kname, pname))
            print(render(info, 'text'))
            return 0
        if a.pub:
            raw = sign.load_public(a.pub)
            path = a.pub
        else:
            raw = sign.raw_public(sign.load_private(a.key))
            path = a.key
        if raw in rc.RFC8032_TEST_PUBLIC_KEYS:
            print('signkey: note: this is an RFC 8032 test key (public test data, never trusted)', file=sys.stderr)
        print(render(public_info(raw, a.name or default_name(path), a.added), a.format))
        return 0
    except (KeyError_, sign.SignError) as e:
        print('signkey: %s' % e, file=sys.stderr)
        return e.code
    except Exception as e:  # noqa: BLE001  (never echo an exception text)
        print('signkey: failed (%s)' % type(e).__name__, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
