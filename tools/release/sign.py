#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Sign a release's checksum list with the Encore release key (Ed25519; DESIGN-UPDATES 4).

    python tools/release/sign.py <assets folder> --key <private key file> --tree <exported tree> [--trial]

Signs the exact bytes of <assets>/SHA256SUMS.txt and writes <assets>/SHA256SUMS.txt.sig: the raw 64-byte signature
(PureEdDSA, RFC 8032: no prehash, no context) and nothing else, so stock OpenSSL 3 can check it:

    openssl pkeyutl -verify -pubin -inkey encore-release-ed25519.pub -rawin -in SHA256SUMS.txt -sigfile SHA256SUMS.txt.sig

Before signing it checks that SHA256SUMS.txt has the strict format the bridge and the launcher read (UTF-8, LF, sorted,
"<64 hex>  <name>" lines) and that it lists every asset with its current SHA-256. After writing it verifies the
signature with the key's public half. The signature never covers a list the clients would reject.

Refused (exit 2): a missing or unreadable key, an RFC 8032 test key, a key file inside the working copy, a .sig that
already exists. Refused (exit 1): a key whose public half isn't in BOTH trust lists of the exported tree
(gateway/src/updatekeys.js and gateway/windows/launcher/internal/update/keys.go, which must also be equal), because
installed bridges couldn't verify the release.
--trial (release.py without --final): a key outside the lists, or a tree without them, signs anyway and exits 3 with a
warning. Such a signature is a rehearsal and never a release. A real release key (one the working copy's own trust
lists hold) is refused in a trial (exit 2): only throwaway keys rehearse.

The private key is read in this process only. Nothing about it is printed except its public key id.
Needs Python's "cryptography" package (the release tools never install anything).
Exit code: 0 = signed and verified, 3 = signed in a trial with a key outside the trust lists, 1 = refused or failed,
2 = usage error.
"""
import argparse
import os
import re
import sys

sys.dont_write_bytecode = True   # keep __pycache__ out of the working copy
import relcommon as rc  # noqa: E402

NEED_CRYPTO = ('the "cryptography" package is needed for signing (pip install cryptography; the release tools never '
               'install anything)')
SUMS_LINE_RX = re.compile(r'^([0-9a-f]{64})  ([A-Za-z0-9._+-]{1,128})$')


class SignError(Exception):
    """A refusal or failure. Its message never carries key material."""

    def __init__(self, msg, code=1):
        Exception.__init__(self, msg)
        self.code = code


def crypto():
    """The cryptography classes this module uses; SignError when the package is missing."""
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
    except ImportError:
        raise SignError(NEED_CRYPTO, 2)
    return serialization, Ed25519PrivateKey, Ed25519PublicKey, InvalidSignature


def have_crypto():
    try:
        crypto()
        return True
    except SignError:
        return False


# --------------------------------------------------------------------------------------------------------------------
# Keys

def load_private(path):
    """The Ed25519 private key in the file (unencrypted PKCS#8 PEM). Errors are reduced to a message without content."""
    serialization, Ed25519PrivateKey, _, _ = crypto()
    try:
        with open(path, 'rb') as f:
            data = f.read()
    except OSError as e:
        raise SignError('the key file can\'t be read (%s)' % type(e).__name__, 2)
    try:
        key = serialization.load_pem_private_key(data, password=None)
    except TypeError:
        raise SignError('the key file is encrypted (a passphrase-protected key isn\'t supported yet)', 2)
    except Exception:  # noqa: BLE001  (the exception text could quote the file: never shown)
        raise SignError('the key file isn\'t an unencrypted Ed25519 private key in PKCS#8 PEM', 2)
    finally:
        data = None
    if not isinstance(key, Ed25519PrivateKey):
        raise SignError('the key file holds a private key that isn\'t Ed25519', 2)
    return key


def raw_public(key):
    """The raw 32 bytes of a private or public Ed25519 key's public half."""
    serialization, Ed25519PrivateKey, _, _ = crypto()
    pub = key.public_key() if isinstance(key, Ed25519PrivateKey) else key
    return pub.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def public_pem(raw):
    serialization, _, Ed25519PublicKey, _ = crypto()
    return Ed25519PublicKey.from_public_bytes(raw).public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode('ascii')


def load_public(path):
    """Raw 32-byte public key from a .pub file: PEM SubjectPublicKeyInfo, or one line of base64 of the raw 32 bytes."""
    import base64
    import binascii
    serialization, _, Ed25519PublicKey, _ = crypto()
    try:
        with open(path, 'rb') as f:
            data = f.read()
    except OSError as e:
        raise SignError('the public key file can\'t be read (%s)' % type(e).__name__, 2)
    if b'PRIVATE KEY' in data:
        raise SignError('that is a private key file, not a public one', 2)
    if b'-----BEGIN PUBLIC KEY-----' in data:
        try:
            pub = serialization.load_pem_public_key(data)
        except Exception:  # noqa: BLE001
            raise SignError('the public key file isn\'t a PEM public key', 2)
        if not isinstance(pub, Ed25519PublicKey):
            raise SignError('the public key isn\'t Ed25519', 2)
        return raw_public(pub)
    try:
        raw = base64.b64decode(data.strip(), validate=True)
    except (ValueError, binascii.Error):
        raw = b''
    if len(raw) != 32:
        raise SignError('the public key file is neither PEM nor the base64 of 32 bytes', 2)
    return raw


def sign_bytes(key, data):
    return key.sign(data)


def verify(raw_pub, data, sig):
    """True when sig is a valid Ed25519 signature of data under the raw public key."""
    _, _, Ed25519PublicKey, InvalidSignature = crypto()
    if len(sig) != 64:
        return False
    try:
        Ed25519PublicKey.from_public_bytes(raw_pub).verify(sig, data)
        return True
    except InvalidSignature:
        return False


# --------------------------------------------------------------------------------------------------------------------
# The checksum list

def sums_problems(data, assets_folder=None):
    """[problem] for SHA256SUMS.txt bytes in the strict format the clients parse (DESIGN-UPDATES 4.1, 4.3 step 3).
    With assets_folder, every listed file must exist there with that SHA-256 and every asset must be listed."""
    problems = []
    if data[:3] == b'\xef\xbb\xbf':
        problems.append('starts with a BOM')
    if b'\r' in data:
        problems.append('has CR characters (LF line ends only)')
    if not data:
        return ['is empty']
    if not data.endswith(b'\n'):
        problems.append('the last line doesn\'t end with a newline')
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return problems + ['isn\'t UTF-8']
    rows = text[:-1].split('\n') if text.endswith('\n') else text.split('\n')
    names = []
    for n, line in enumerate(rows, 1):
        m = SUMS_LINE_RX.match(line)
        if not m:
            problems.append('line %d isn\'t "<64 lower-case hex>  <name>"' % n)
            continue
        names.append((m.group(2), m.group(1)))
    plain = [nm for nm, _ in names]
    if len(set(plain)) != len(plain):
        problems.append('a name is listed twice')
    if plain != sorted(plain):
        problems.append('the lines aren\'t sorted by name')
    if rc.SUMS_NAME in plain or rc.SIG_NAME in plain:
        problems.append('lists itself or the signature')
    if assets_folder is not None:
        for nm, h in names:
            p = os.path.join(assets_folder, nm)
            if not os.path.isfile(p):
                problems.append('%s is listed but not in the assets folder' % nm)
            elif rc.sha256_file(p) != h:
                problems.append('%s doesn\'t match its listed SHA-256' % nm)
        for nm in sorted(os.listdir(assets_folder)):
            if nm in (rc.SUMS_NAME, rc.SIG_NAME) or not os.path.isfile(os.path.join(assets_folder, nm)):
                continue
            if nm not in plain:
                problems.append('%s is in the assets folder but not listed' % nm)
    return problems


# --------------------------------------------------------------------------------------------------------------------

def sign_assets(assets, key_path, tree, trial=False, out=print):
    """Sign <assets>/SHA256SUMS.txt. Returns (exit code, key id or None). Prints result lines through out()."""
    sums_path = os.path.join(assets, rc.SUMS_NAME)
    sig_path = os.path.join(assets, rc.SIG_NAME)
    if not os.path.isfile(sums_path):
        raise SignError('no %s in the assets folder' % rc.SUMS_NAME, 2)
    if os.path.exists(sig_path):
        raise SignError('%s already exists (never overwritten)' % rc.SIG_NAME, 2)
    if rc.is_inside(key_path, rc.REPO_ROOT) or (tree and rc.is_inside(key_path, tree)):
        raise SignError('the key file is inside the working copy or the exported tree: move it out first', 2)
    key = load_private(key_path)
    pub = raw_public(key)
    kid = rc.key_id(pub)
    if pub in rc.RFC8032_TEST_PUBLIC_KEYS:
        raise SignError('that is an RFC 8032 test key (public test data): never used for a release', 2)
    if trial:
        # only a throwaway key rehearses: a real release key (one this working copy's own trust lists hold) would make a
        # signature installed bridges accept, over assets built without --final's checks
        rjs, rgo, _ = rc.read_trust_lists(rc.REPO_ROOT)
        if any(k['raw'] == pub for k in rjs + rgo):
            raise SignError('refused: key %s is a real release key (in this working copy\'s embedded trust lists); a '
                            'trial signs only with a throwaway key (signkey.py generate in a scratch folder), and a '
                            'release is signed by release.py --final' % kid, 2)
    js, go, problems = rc.read_trust_lists(tree) if tree else ([], [], ['no --tree given'])
    listed = bool(js) and any(k['raw'] == pub for k in js) and any(k['raw'] == pub for k in go)
    warning = None
    if problems or not listed:
        why = '; '.join(problems) if problems else 'key %s is not in both embedded trust lists' % kid
        if not trial:
            raise SignError('refused: %s (installed bridges couldn\'t verify this release)' % why, 1)
        warning = '%s: a trial signature, never a release' % why
    with open(sums_path, 'rb') as f:
        data = f.read()
    bad = sums_problems(data, assets)
    if bad:
        raise SignError('%s: %s' % (rc.SUMS_NAME, '; '.join(bad)), 1)
    sig = sign_bytes(key, data)
    key = None
    with open(sig_path, 'xb') as f:          # exclusive create: never overwrites
        f.write(sig)
    with open(sums_path, 'rb') as f:
        again = f.read()
    with open(sig_path, 'rb') as f:
        written = f.read()
    if len(written) != 64 or again != data or not verify(pub, again, written):
        os.unlink(sig_path)
        raise SignError('the written signature doesn\'t verify: removed', 1)
    out('sign: %s (key %s)' % (rc.SIG_NAME, kid))
    if warning:
        out('sign: warning: %s' % warning)
        return 3, kid
    return 0, kid


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('assets', help='the release assets folder with SHA256SUMS.txt')
    ap.add_argument('--key', required=True, help='the private Ed25519 key file (PKCS#8 PEM, kept outside the repo)')
    ap.add_argument('--tree', help='the exported source tree whose trust lists must hold the key')
    ap.add_argument('--trial', action='store_true', help='a rehearsal: a key outside the trust lists signs with a warning')
    a = ap.parse_args(argv)
    try:
        code, _ = sign_assets(os.path.abspath(a.assets), os.path.abspath(a.key), a.tree and os.path.abspath(a.tree),
                              a.trial)
        return code
    except SignError as e:
        print('sign: %s' % e, file=sys.stderr)
        return e.code
    except Exception as e:  # noqa: BLE001  (never echo an exception text: it could carry key bytes)
        print('sign: failed (%s)' % type(e).__name__, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
