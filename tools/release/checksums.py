#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""SHA-256 checksums for the release assets, in the format "sha256sum -c" reads.

    python tools/release/checksums.py <assets folder>                         writes <assets folder>/SHA256SUMS.txt
    python tools/release/checksums.py <assets folder> --check                 verifies it
    python tools/release/checksums.py <assets folder> --check --pubkey <.pub> also verifies SHA256SUMS.txt.sig

Every regular file directly inside the folder is listed (not sub-folders), sorted by name, except SHA256SUMS.txt
itself and its signature SHA256SUMS.txt.sig (sign.py writes that after this list; DESIGN-UPDATES 4.1).
(.txt so that Windows opens it with a double-click; the guide tells users to compare against it.)
On Windows: `certutil -hashfile <file> SHA256` or PowerShell `Get-FileHash <file>` prints the same value.
--pubkey takes the release key's public half (PEM, or the base64 of its raw 32 bytes) and needs Python's
"cryptography" package; OpenSSL 3 does the same check:
    openssl pkeyutl -verify -pubin -inkey <.pub> -rawin -in SHA256SUMS.txt -sigfile SHA256SUMS.txt.sig
"""
import argparse
import os
import sys

sys.dont_write_bytecode = True   # keep __pycache__ out of the working copy
import relcommon as rc  # noqa: E402

NAME = rc.SUMS_NAME
SIG = rc.SIG_NAME


def assets(folder):
    return sorted(f for f in os.listdir(folder) if f not in (NAME, SIG) and os.path.isfile(os.path.join(folder, f)))


def check_signature(folder, pubkey):
    """(ok, message) for SHA256SUMS.txt.sig under the public key file."""
    import sign
    try:
        raw = sign.load_public(pubkey)
        with open(os.path.join(folder, NAME), 'rb') as f:
            data = f.read()
        try:
            with open(os.path.join(folder, SIG), 'rb') as f:
                sig = f.read(1025)
        except OSError:
            return False, '%s: MISSING' % SIG
        if len(sig) != 64:
            return False, '%s: FAILED (not a 64-byte signature)' % SIG
        ok = sign.verify(raw, data, sig)
        return ok, '%s: %s (key %s)' % (SIG, 'OK' if ok else 'FAILED', rc.key_id(raw))
    except sign.SignError as e:
        return False, '%s: not checked (%s)' % (SIG, e)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('folder')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--pubkey', help='with --check: also verify SHA256SUMS.txt.sig with this public key')
    a = ap.parse_args(argv)
    sums = os.path.join(a.folder, NAME)
    if a.pubkey and not a.check:
        ap.error('--pubkey goes with --check')
    if a.check:
        bad = 0
        listed = set()
        with open(sums, encoding='utf-8', newline='') as f:
            for n, line in enumerate(f, 1):
                h, sep, name = line.rstrip('\n').partition('  ')
                if not sep or not name or '/' in name or '\\' in name or name in ('.', '..') or line.endswith('\r\n'):
                    bad += 1
                    print('line %d: MALFORMED' % n)
                    continue
                listed.add(name)
                p = os.path.join(a.folder, name)
                ok = os.path.isfile(p) and rc.sha256_file(p) == h
                bad += not ok
                print('%s: %s' % (name, 'OK' if ok else ('FAILED' if os.path.isfile(p) else 'MISSING')))
        for name in assets(a.folder):
            if name not in listed:
                bad += 1
                print('%s: NOT LISTED' % name)
        if a.pubkey:
            ok, msg = check_signature(a.folder, a.pubkey)
            bad += not ok
            print(msg)
        return 1 if bad else 0
    rows = ['%s  %s' % (rc.sha256_file(os.path.join(a.folder, n)), n) for n in assets(a.folder)]
    with open(sums, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(rows) + ('\n' if rows else ''))
    print('checksums: %d files -> %s' % (len(rows), sums))
    return 0


if __name__ == '__main__':
    sys.exit(main())
