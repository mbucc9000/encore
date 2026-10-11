# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared rules for the Encore release scripts (export.py, scan.py, gpl_bundle.py, release.py).

Python 3.8+, standard library only, works on Windows and Linux.

The "never ship" rules live here so that the export (which refuses to copy these paths) and the scanner (which fails
when it finds them) can never disagree.
"""
import hashlib
import os
import re

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(TOOLS_DIR, '..', '..'))
DENYLIST_DEFAULT = os.path.join(TOOLS_DIR, 'denylist.local.txt')
SCAN_ALLOW_DEFAULT = os.path.join(TOOLS_DIR, 'scan-allow.txt')
EXPORT_ALLOWLIST_DEFAULT = os.path.join(TOOLS_DIR, 'export-allowlist.txt')
LOCAL_CONF_DEFAULT = os.path.join(TOOLS_DIR, 'release.local.env')


# --------------------------------------------------------------------------------------------------------------------
# Globs: '*' = anything inside one folder name, '**' = any number of folders, '?' = one character.
# Paths are always relative and use '/'.

def glob_to_regex(pat, ignore_case=False):
    out, i, n = [], 0, len(pat)
    while i < n:
        c = pat[i]
        if c == '*':
            if pat.startswith('**/', i):
                out.append('(?:[^/]+/)*')
                i += 3
                continue
            if pat.startswith('**', i):
                out.append('.*')
                i += 2
                continue
            out.append('[^/]*')
        elif c == '?':
            out.append('[^/]')
        elif c == '[':
            j = pat.find(']', i + 1)
            if j < 0:
                out.append(re.escape(c))
            else:
                body = pat[i + 1:j]
                if body.startswith('!'):
                    body = '^' + body[1:]
                out.append('[' + body + ']')
                i = j
        else:
            out.append(re.escape(c))
        i += 1
    return re.compile('^' + ''.join(out) + '$', re.IGNORECASE if ignore_case else 0)


# --------------------------------------------------------------------------------------------------------------------
# What never ships (RELEASE-PLAN.md section 3.9). Matching is case-insensitive on purpose.

# Paths relative to the repository root that the export never copies, whatever the allowlist says.
NEVER_SHIP_REPO_PATHS = [
    'probes/**', 'mockup/**', '.workflows/**', 'tools/pipeline/**',
    'PLAN.md', 'DESIGN-*.md', 'RELEASE-PLAN.md', 'ARCH-*.md', 'app/ARCH-*.md',
    'gateway/tools/LIVE_TEST.md', 'gateway/tools/live_catalog.py',
    'gateway/data/**', 'gateway/pipe/**', 'gateway/engine/state.json',
    'app/.theos/**', 'app/packages/**', 'app/obj/**',
    'tools/release/*.local.*', 'tools/release/*.local',
]
_NEVER_SHIP_REPO_RX = [glob_to_regex(p, ignore_case=True) for p in NEVER_SHIP_REPO_PATHS]

# Folder names that never ship at any depth. '_keys' holds the private release-signing key (DESIGN-UPDATES 4.4).
FORBIDDEN_DIRS = {
    '.git', '.svn', '.hg', '.theos', 'node_modules', '__pycache__', '.ssh', '.claude',
    'probes', 'mockup', '.workflows', '.vscode', '.idea', 'diag', 'pipe', '_keys',
}
# The release-signing key's file names (signkey.py): encore-release-ed25519.key, encore-release-ed25519-2.key, ...
RELEASE_KEY_NAME_RX = re.compile(r'(?i)^encore-release-[a-z0-9_.-]*\.key$')

_KEY_EXTS = ('.pem', '.key', '.p12', '.pfx', '.ppk', '.jks', '.keystore', '.mobileprovision', '.p8', '.gpg', '.asc')
_SECRET_NAMES = {
    'tokens.json', 'devices.json', 'jam.json', 'last.json', 'state.json', 'lockfile', '.encore-cli.json',
    'known_hosts', 'authorized_keys', '.netrc', '.pypirc', '.npmrc', 'settings.env',
    'admin.json', 'showcase.json',          # the bridge's data/: the admin password's salted hash, the Showcase switch
    'denylist.local.txt',
}
_CRED_EXTS = ('', '.json', '.txt', '.yml', '.yaml', '.bin', '.dat', '.ini', '.conf', '.xml', '.toml')
# Build outputs and archives: never part of the SOURCE tree (they are fine as release assets).
BUILD_ARTEFACT_EXTS = ('.deb', '.ipa', '.zip', '.7z', '.rar', '.tar', '.tgz', '.gz', '.xz', '.bz2', '.lzma', '.zst',
                       '.exe', '.dll', '.dylib', '.so', '.a', '.o', '.msi', '.dmg', '.pkg', '.pyc', '.class')
_JUNK_NAMES = {'.ds_store', 'thumbs.db', 'desktop.ini'}


def forbidden_reason(relpath, source_tree=False):
    """Return why this path must never ship, or None. relpath is relative, '/' separated.

    source_tree=True also rejects build outputs and archives (a source tree never holds them; release assets do)."""
    rel = relpath.replace('\\', '/').strip('/')
    parts = [p for p in rel.split('/') if p not in ('', '.')]
    if not parts:
        return None
    name = parts[-1]
    low = name.lower()
    if RELEASE_KEY_NAME_RX.match(name):
        return 'release signing key (private; never leaves the owner\'s PC)'
    if any(d.lower() == '_keys' for d in parts[:-1]) and low.endswith('.pub'):
        return 'release key folder "_keys/" (the public key ships inside the programs, not as a file)'
    for d in parts[:-1]:
        if d.lower() in FORBIDDEN_DIRS:
            return 'forbidden folder "%s/"' % d
    # data/cache from a bridge data folder
    lowparts = [p.lower() for p in parts]
    for i in range(len(lowparts) - 1):
        if lowparts[i] == 'data' and lowparts[i + 1] in ('cache', 'diag', 'personal', 'social', 'membership'):
            return 'bridge data folder'
    if low == '.env' or (low.startswith('.env.') and low != '.env.example'):
        return 'environment file (only .env.example ships)'
    if low.endswith('.env') and not any(w in low for w in ('example', 'template', 'sample')):
        return 'environment file'
    if low in _SECRET_NAMES:
        return 'secret or state file'
    stem, ext = os.path.splitext(low)
    if stem.startswith('credentials') and ext in _CRED_EXTS:   # credentials, credentials.json ... (not credentials.go)
        return 'credentials file'
    if low.endswith('.har') or low.endswith('.mhtml') or low.endswith('.webarchive'):
        return 'saved web traffic or page'
    if low.endswith('.log') or low.endswith('.pcm') or low.endswith('.fifo') or low.startswith('jam-trace'):
        return 'log, trace or audio dump'
    if low.endswith(_KEY_EXTS):
        return 'key or certificate file'
    if re.match(r'^id_(rsa|dsa|ecdsa|ed25519)', low) or re.search(r'_(rsa|dsa|ecdsa|ed25519)(\.pub)?$', low):
        return 'SSH key file'
    if '.local.' in low or low.endswith('.local'):
        return 'local-only file'
    if 'backup' in low and (low.endswith(BUILD_ARTEFACT_EXTS) or low.endswith('.bak')):
        return 'backup archive'
    if low.endswith(('.bak', '.orig', '.rej', '~', '.swp')):
        return 'editor or patch leftover'
    if low in _JUNK_NAMES or low.startswith('._'):
        return 'OS metadata file'
    if source_tree:
        if low.endswith(BUILD_ARTEFACT_EXTS) or low.endswith(('.sqlite', '.db')):
            return 'build output or archive inside the source tree'
    return None


def never_ship_repo_path(relpath):
    rel = relpath.replace('\\', '/').strip('/')
    for rx in _NEVER_SHIP_REPO_RX:
        if rx.match(rel):
            return True
    return False


# --------------------------------------------------------------------------------------------------------------------
# Versions

def read_versions(root):
    """(app_version, bridge_version) from app/control and gateway/src/config.js; None when missing."""
    app = bridge = None
    try:
        with open(os.path.join(root, 'app', 'control'), encoding='utf-8') as f:
            for line in f:
                if line.startswith('Version:'):
                    app = line.split(':', 1)[1].strip()
                    break
    except OSError:
        pass
    try:
        with open(os.path.join(root, 'gateway', 'src', 'config.js'), encoding='utf-8') as f:
            m = re.search(r"\bversion:\s*['\"]([^'\"]+)['\"]", f.read())
            if m:
                bridge = m.group(1)
    except OSError:
        pass
    return app, bridge


def sha256_file(path, bufsize=1 << 20):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            b = f.read(bufsize)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def tree_files(root):
    """Sorted relative '/' paths of every regular file under root (symbolic links are refused)."""
    out = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        for fn in filenames:
            ap = os.path.join(dirpath, fn)
            rel = os.path.relpath(ap, root).replace(os.sep, '/')
            if os.path.islink(ap):
                raise SystemExit('refusing a symbolic link in a release tree: %s' % rel)
            out.append(rel)
    return sorted(out)


def source_date_epoch():
    """Timestamp for archive entries: $SOURCE_DATE_EPOCH, else a fixed date, so the same input gives the same bytes."""
    try:
        return int(os.environ['SOURCE_DATE_EPOCH'])
    except (KeyError, ValueError):
        return 1767225600   # 2026-01-01T00:00:00Z


def write_tar_gz(out_path, members):
    """Write a reproducible .tar.gz. members: [(archive_name, source_path)], written in the given order.

    Owner root/root, no user names, one fixed mtime, mode 0755 for shell scripts and files starting with '#!',
    0644 for everything else, and a gzip header without a file name or time."""
    import gzip
    import io
    import tarfile
    mtime = source_date_epoch()
    with open(out_path, 'wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0, compresslevel=9) as gz:
            with tarfile.open(fileobj=gz, mode='w', format=tarfile.PAX_FORMAT) as tar:
                dirs_done = set()
                for name, src in members:
                    parts = name.split('/')
                    for k in range(1, len(parts)):
                        d = '/'.join(parts[:k])
                        if d not in dirs_done:
                            dirs_done.add(d)
                            ti = tarfile.TarInfo(d)
                            ti.type, ti.mode, ti.mtime = tarfile.DIRTYPE, 0o755, mtime
                            ti.uid = ti.gid = 0
                            ti.uname = ti.gname = ''
                            tar.addfile(ti)
                    with open(src, 'rb') as f:
                        data = f.read()
                    ti = tarfile.TarInfo(name)
                    ti.size, ti.mtime = len(data), mtime
                    ti.mode = 0o755 if (name.endswith('.sh') or data[:2] == b'#!' or '/DEBIAN/' in name) else 0o644
                    ti.uid = ti.gid = 0
                    ti.uname = ti.gname = ''
                    tar.addfile(ti, io.BytesIO(data))


def is_inside(child, parent):
    child = os.path.normcase(os.path.realpath(child))
    parent = os.path.normcase(os.path.realpath(parent))
    return child == parent or child.startswith(parent.rstrip(os.sep) + os.sep)


def read_local_conf(path=LOCAL_CONF_DEFAULT):
    """KEY=VALUE lines from the local, never-exported release.local.env (build host settings). Missing file = {}."""
    conf = {}
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                conf[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    for k, v in os.environ.items():   # the environment wins
        if k.startswith('ENCORE_'):
            conf[k] = v
    return conf


# --------------------------------------------------------------------------------------------------------------------
# Release signing (DESIGN-UPDATES 4): file names, key ids, the trust lists embedded in the bridge and the launcher.
# Standard library only: signing and verifying (sign.py, signkey.py) need Python's "cryptography" package; reading a
# key's seed for the scanner does not.

SUMS_NAME = 'SHA256SUMS.txt'
SIG_NAME = 'SHA256SUMS.txt.sig'          # the raw 64-byte Ed25519 signature over SHA256SUMS.txt, a release asset
UPDATE_KEYS_JS = 'gateway/src/updatekeys.js'
UPDATE_KEYS_GO = 'gateway/windows/launcher/internal/update/keys.go'
MAX_TRUSTED_KEYS = 3
# RFC 8032 section 7.1 TEST 1 and TEST 2 public keys: published test data that the update tests sign with. A release
# is never signed with them and they are never in a trust list.
RFC8032_TEST_PUBLIC_KEYS = (
    bytes.fromhex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'),
    bytes.fromhex('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'),
)
# DER start of an Ed25519 private key in PKCS#8: v1 (RFC 8410, 48 bytes) and v2 (with the public key, 83 bytes)
ED25519_PKCS8_PREFIXES = (bytes.fromhex('302e020100300506032b657004220420'),
                          bytes.fromhex('3051020101300506032b657004220420'))


def key_id(raw_public):
    """The key id of DESIGN-UPDATES 4.4: the first 16 hex digits of SHA-256 over the raw 32-byte public key."""
    return hashlib.sha256(raw_public).hexdigest()[:16]


def ed25519_private_der(data):
    """(seed, PKCS#8 DER) of an unencrypted Ed25519 private key given as PEM ("PRIVATE KEY") or DER bytes, else None.
    Nothing is printed, and nothing raised here carries key bytes."""
    import base64
    import binascii
    der = None
    if data[:16] in ED25519_PKCS8_PREFIXES:
        der = data
    else:
        m = re.search(rb'-{5}BEGIN PRIVATE KEY-{5}\s*([A-Za-z0-9+/=\s]+?)\s*-{5}END PRIVATE KEY-{5}', data)
        if m:
            try:
                der = base64.b64decode(b''.join(m.group(1).split()), validate=True)
            except (ValueError, binascii.Error):
                der = None
    if not der or der[:16] not in ED25519_PKCS8_PREFIXES or len(der) < 48:
        return None
    if der[:16] == ED25519_PKCS8_PREFIXES[0] and len(der) != 48:
        return None
    return der[16:48], der


def _skip_literal(text, i):
    """Index after the string literal or comment that starts at text[i], or None when none starts there."""
    c = text[i]
    if text.startswith('//', i):
        j = text.find('\n', i)
        return len(text) if j < 0 else j
    if text.startswith('/*', i):
        j = text.find('*/', i + 2)
        return len(text) if j < 0 else j + 2
    if c in '\'"`':
        j = i + 1
        while j < len(text):
            if text[j] == '\\' and c != '`':
                j += 2
                continue
            if text[j] == c:
                return j + 1
            j += 1
        return len(text)
    return None


def _balanced(text, i):
    """text[i] is '[', '{' or '(': the index of its matching bracket (strings and comments skipped), or -1."""
    pairs = {'[': ']', '{': '}', '(': ')'}
    stack, j = [], i
    while j < len(text):
        k = _skip_literal(text, j)
        if k is not None:
            j = k
            continue
        ch = text[j]
        if ch in pairs:
            stack.append(pairs[ch])
        elif ch in ')]}':
            if not stack or stack.pop() != ch:
                return -1
            if not stack:
                return j
        j += 1
    return -1


def _entries(block):
    """The top-level {...} objects inside a list body (strings and comments skipped)."""
    out, j = [], 0
    while j < len(block):
        k = _skip_literal(block, j)
        if k is not None:
            j = k
            continue
        if block[j] == '{':
            e = _balanced(block, j)
            if e < 0:
                break
            out.append(block[j:e + 1])
            j = e + 1
            continue
        j += 1
    return out


_TRUST_SYNTAX = {
    # gateway/src/updatekeys.js: module.exports = Object.freeze([{ id: '<16 hex>', key: '<base64>', name: '...', ... }])
    'js': (re.compile(r'module\.exports\s*=\s*Object\.freeze\(\s*(\[)'),
           {'id': re.compile(r'''\bid\s*:\s*(['"])([^'"]*)\1'''), 'key': re.compile(r'''\bkey\s*:\s*(['"])([^'"]*)\1'''),
            'name': re.compile(r'''\bname\s*:\s*(['"])([^'"]*)\1''')}),
    # .../internal/update/keys.go: var TrustedKeys = []Key{{ID: "<16 hex>", Key: "<base64>", Name: "..."}}
    'go': (re.compile(r'\bvar\s+TrustedKeys\s*=\s*\[\]Key\s*(\{)'),
           {'id': re.compile(r'\bID\s*:\s*(")([^"]*)"'), 'key': re.compile(r'\bKey\s*:\s*(")([^"]*)"'),
            'name': re.compile(r'\bName\s*:\s*(")([^"]*)"')}),
}


def parse_trust_list(text, lang):
    """([{'id', 'key', 'name', 'raw'}], [problem]) for an embedded trust list ('js' or 'go'). Public data only."""
    import base64
    import binascii
    start_rx, fields = _TRUST_SYNTAX[lang]
    m = start_rx.search(text)
    if not m:
        return [], ['no trust list declaration']
    end = _balanced(text, m.start(1))
    if end < 0:
        return [], ['the trust list is not closed']
    keys, problems = [], []
    for n, entry in enumerate(_entries(text[m.start(1) + 1:end]), 1):
        row = {}
        for f, rx in fields.items():
            fm = rx.search(entry)
            row[f] = fm.group(2) if fm else None
        try:
            raw = base64.b64decode(row['key'] or '', validate=True)
        except (ValueError, binascii.Error):
            raw = b''
        row['raw'] = raw
        if len(raw) != 32 or base64.b64encode(raw).decode() != row['key']:
            problems.append('entry %d: the key is not the standard base64 of 32 bytes' % n)
        elif row['id'] != key_id(raw):
            problems.append('entry %d: id %s is not the key id of its key (%s)' % (n, row['id'], key_id(raw)))
        if raw in RFC8032_TEST_PUBLIC_KEYS:
            problems.append('entry %d: the RFC 8032 test key (test data, never trusted)' % n)
        if not row['name']:
            problems.append('entry %d: no name' % n)
        keys.append(row)
    if not keys:
        problems.append('the trust list is empty')
    if len(keys) > MAX_TRUSTED_KEYS:
        problems.append('%d keys (at most %d)' % (len(keys), MAX_TRUSTED_KEYS))
    raws = [k['raw'] for k in keys]
    if len(set(raws)) != len(raws):
        problems.append('a key is listed twice')
    return keys, problems


def read_trust_lists(root):
    """(js keys, go keys, [problem]) for the two embedded trust lists under root (a working copy or an exported tree).
    Both must be valid and equal: the same keys, ids and names in the same order."""
    out, problems = {}, []
    for lang, rel in (('js', UPDATE_KEYS_JS), ('go', UPDATE_KEYS_GO)):
        try:
            with open(os.path.join(root, *rel.split('/')), encoding='utf-8') as f:
                text = f.read()
        except OSError:
            out[lang] = []
            problems.append('%s is missing' % rel)
            continue
        out[lang], probs = parse_trust_list(text, lang)
        problems += ['%s: %s' % (rel, p) for p in probs]
    js, go = out['js'], out['go']
    if js and go and [(k['id'], k['key'], k['name']) for k in js] != [(k['id'], k['key'], k['name']) for k in go]:
        problems.append('%s and %s list different keys (they must be equal)' % (UPDATE_KEYS_JS, UPDATE_KEYS_GO))
    return js, go, problems
