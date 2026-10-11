#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Encore release privacy scan. Any finding fails the release.

    python tools/release/scan.py [options] <folder or file> [<folder or file> ...]

Targets can be folders (the exported source tree, a Windows staging folder) or files (.deb, .zip, .tar.*, .exe, ...).
Archives are opened in memory and scanned member by member (nested archives too). Every binary file gets a
"strings" pass: printable ASCII/UTF-8 runs plus UTF-16 LE and BE runs (Objective-C keeps string literals that hold
non-ASCII characters as UTF-16), so build paths and literals inside executables are checked as well.

Checks
  FILENAME  forbidden names: .env (only .env.example ships), tokens.json, devices.json, jam.json, last.json,
            state.json, credentials files, *.har, logs, key files, backup archives, local-only files, dev folders;
            in --source-tree mode also build outputs and archives
  DENY      the local denylist (tools/release/denylist.local.txt): the owner's real names, server name, addresses,
            domains, key names, paths, real library data. It is never exported, and this report never prints its
            values: a hit is shown as its denylist line number and label
  SECRET    token, cookie, key and credential shapes (Spotify tokens, sp_dc, refresh_token fields, private keys, Ed25519
            PKCS#8 keys as base64 or as DER bytes in any file, ...). With --sign-key (default: ENCORE_SIGN_KEY from
            release.local.env or the environment) also the release-signing key's own material: its seed as raw bytes,
            hex or base64 and its PKCS#8 form, in every file, archive member and binary (rule release-signing-key).
            Key material is never printed, not even with --show-matches; the report header says whether the release
            key was checked, and --final requires it
  IP        IPv4 addresses, except loopback, unspecified, multicast, documentation ranges, network/CIDR notation,
            well-known public resolvers and entries in scan-allow.txt
  EMAIL     e-mail addresses, except example/test domains and entries in scan-allow.txt
  HOMEPATH  user-profile and home paths (/home/<name>, /Users/<name>, C:\\Users\\<name>): build paths in binaries
  METADATA  image metadata the text checks can't read: PNG tEXt/iTXt/zTXt/eXIf/tIME chunks, JPEG APP1 (Exif, XMP) and
            APP13 (IPTC) segments, WebP EXIF/XMP chunks. A camera photo or an unstripped screenshot can carry a GPS
            position, the device, dates and names; a shipped image holds pixels only (strip it, then scan again)
  ERROR     a file or archive the scan could not read; it fails like a finding

A .deb is opened like any archive wherever it is met: as a target (the release deb asset), in a folder or inside
another archive (a zip or tarball that carries one). A copy that is byte-identical (SHA-256) to a deb already
scanned in the same run has its name checked but its content not scanned again; the report counts those copies.

Exit code: 0 = clean, 1 = findings, 2 = usage error (for example a missing denylist without --no-denylist).
"""
import argparse
import bisect
import bz2
import gzip
import hashlib
import io
import json
import lzma
import os
import re
import sys
import tarfile
import zipfile

sys.dont_write_bytecode = True   # keep __pycache__ out of the working copy
import relcommon as rc  # noqa: E402

MAX_DEPTH = 6
CTX = 70

# --------------------------------------------------------------------------------------------------------------------
# Generic rules (public). Written so that this file never matches its own patterns.

SECRET_RULES = [
    ('spotify-access-token', r'(?<![A-Za-z0-9_-])BQ[A-Za-z0-9_-]{60,}'),
    ('spotify-refresh-token', r'(?<![A-Za-z0-9_-])AQ[A-Za-z0-9_-]{60,}'),
    ('spotify-cookie', r'(?i)\bsp_(?:dc|key|t)\b["\']?\s*[=:]\s*["\']?[A-Za-z0-9_-]{20,}'),
    ('token-field', r'(?i)["\']?\b(?:refresh_token|access_token|id_token)["\']?\s*[:=]\s*["\'][A-Za-z0-9._~+/-]{20,}=*["\']'),
    ('private-key', r'-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-{5}'),
    ('putty-key', r'PuTTY-User-Key-File-[0-9]'),
    ('ssh-public-key', r'\b(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp[0-9]+) AAAA[0-9A-Za-z+/]{40,}'),
    ('bearer-token', r'\bBearer\s+[A-Za-z0-9._~+/-]{40,}=*'),
    ('jwt', r'\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'),
    ('client-id', r'(?i)\b(?:SPOTIFY_CLIENT_ID|client_?id)\b["\']?\s*[:=]\s*["\']?[0-9a-f]{32}\b'),
    ('client-secret', r'(?i)\bclient_?secret\b["\']?\s*[:=]\s*["\']?[A-Za-z0-9_-]{16,}'),
    ('url-credentials', r'\b[a-z][a-z0-9+.-]*://[^\s/:@"\'<>]+:[^\s/@"\'<>]{8,}@'),
    ('aws-key', r'\bAKIA[0-9A-Z]{16}\b'),
    ('github-token', r'\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})'),
    ('slack-token', r'\bxox[abprs]-[A-Za-z0-9-]{10,}'),
    ('google-api-key', r'\bAIza[0-9A-Za-z_-]{35}\b'),
    ('anthropic-key', r'\bsk-ant-[A-Za-z0-9_-]{20,}'),
    ('openai-key', r'\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}'),
    ('tailscale-key', r'\btskey-[A-Za-z0-9-]{10,}'),
    # an Ed25519 private key in PKCS#8, base64 (a PEM body without its header): v1 (RFC 8410) and v2 (with the public
    # key). The Encore release-signing key is one (DESIGN-UPDATES 4.4)
    ('ed25519-pkcs8', r'MC4CAQAwBQYDK2VwBCIEI[A-Za-z0-9+/]{43}'),
    ('ed25519-pkcs8-v2', r'MFECAQEwBQYDK2VwBCIEI[A-Za-z0-9+/]{40,}'),
]
SECRET_RX = [(n, re.compile(p)) for n, p in SECRET_RULES]
# Findings whose matched text is key material: never kept, so never printed (not even with --show-matches)
NEVER_REVEAL = {'ed25519-pkcs8', 'ed25519-pkcs8-v2', 'ed25519-pkcs8-der', 'release-signing-key'}
RELEASE_KEY_RULE = 'release-signing-key'
_B64_TOKEN = re.compile(r'[A-Za-z0-9+/=_-]')
# Only in env-style files (.env.example, settings templates): a secret-looking variable must stay empty.
ENV_VALUE_RX = re.compile(r'(?m)^[ \t]*(?:export[ \t]+)?([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|CLIENT_ID)[A-Z0-9_]*)'
                          r'[ \t]*=[ \t]*([^\s#]+)')

IP_RX = re.compile(r'(?<![\w.])((?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3})'
                   r'(?!\.?[0-9]|\w)(?:/([0-9]{1,2}))?')
_RESOLVERS = {'1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112'}

EMAIL_RX = re.compile(r'(?<![\w.%+\\-])([A-Za-z0-9][A-Za-z0-9._%+-]*)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![\w-])')
_EMAIL_OK_SUFFIXES = ('example.com', 'example.org', 'example.net', '.example', '.invalid', '.test', '.localhost',
                      'users.noreply.github.com')
_FILE_EXTS = {'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf', 'ico', 'icns'}

HOME_RXS = [
    re.compile(r'(?<![\w.~-])/home/([A-Za-z0-9._-]+)'),
    re.compile(r'(?<![\w.~-])(?:/[A-Za-z])?/Users/([A-Za-z0-9._-]+)'),
    re.compile(r'(?i)(?<![A-Za-z0-9])[A-Z]:(?:\\\\|\\|/){1,2}(?:Users|Documents and Settings)(?:\\\\|\\|/){1,2}([^\\/\s"\'<>:*?|]+)'),
]
_HOME_PLACEHOLDERS = {
    'user', 'username', 'you', 'yourname', 'your-name', 'yourusername', 'your_user', 'me', 'name', 'example',
    'runner', 'build', 'builder', 'nonroot', 'node', 'app', 'shared', 'public', 'default', 'default user',
    'all users', 'someone', 'alice', 'bob', 'pi', 'ubuntu', 'debian', 'vagrant', 'root', 'other', 'otheruser',
    'other-user', 'test', 'testuser', 'test-user', 'demo', 'sample', 'yourself',
}

# --------------------------------------------------------------------------------------------------------------------
# Image metadata: binary (GPS positions are numbers, not text), so the strings pass never sees it

_PNG_META = {b'tEXt', b'iTXt', b'zTXt', b'eXIf', b'tIME'}


def image_metadata(data):
    """[(rule, where)] for every metadata block in a PNG, JPEG or WebP file; [] for anything else."""
    out = []
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        i = 8
        while i + 8 <= len(data):
            n = int.from_bytes(data[i:i + 4], 'big')
            t = data[i + 4:i + 8]
            if t in _PNG_META:
                out.append(('png-' + t.decode('latin1'), 'chunk at 0x%x' % i))
            if t == b'IEND':
                break
            i += 12 + n
    elif data[:3] == b'\xff\xd8\xff':
        i = 2
        while i + 4 <= len(data) and data[i] == 0xff:
            m = data[i + 1]
            if m == 0xff:                    # a fill byte
                i += 1
                continue
            if m == 0x01 or 0xd0 <= m <= 0xd8:
                i += 2
                continue
            if m in (0xd9, 0xda):            # end of image / start of the compressed data
                break
            n = int.from_bytes(data[i + 2:i + 4], 'big')
            if m == 0xe1:
                kind = 'exif' if data[i + 4:i + 10] == b'Exif\x00\x00' else 'xmp' if data[i + 4:i + 8] == b'http' else 'app1'
                out.append(('jpeg-APP1-' + kind, 'segment at 0x%x' % i))
            elif m == 0xed:
                out.append(('jpeg-APP13-iptc', 'segment at 0x%x' % i))
            i += 2 + n
    elif data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        i = 12
        while i + 8 <= len(data):
            t = data[i:i + 4]
            n = int.from_bytes(data[i + 4:i + 8], 'little')
            if t in (b'EXIF', b'XMP '):
                out.append(('webp-' + t.decode('latin1').strip(), 'chunk at 0x%x' % i))
            i += 8 + n + (n & 1)
    return out


# --------------------------------------------------------------------------------------------------------------------
# Binary "strings"

STR_UTF8_RX = re.compile(rb'(?:[\x20-\x7e\t]|[\xc2-\xdf][\x80-\xbf]|[\xe0-\xef][\x80-\xbf]{2}|[\xf0-\xf4][\x80-\xbf]{3}){4,}')
STR_U16LE_RX = re.compile(rb'(?:[\x20-\x7e\t]\x00|[\xa0-\xff]\x00|[\x00-\x7f]\x01|[\x00-\x6f]\x20){4,}')
STR_U16BE_RX = re.compile(rb'(?:\x00[\x20-\x7e\t]|\x00[\xa0-\xff]|\x01[\x00-\x7f]|\x20[\x00-\x6f]){4,}')


def binary_strings(data):
    """[(offset, encoding, text)] for printable runs in a binary blob."""
    out = []
    for m in STR_UTF8_RX.finditer(data):
        out.append((m.start(), 'ascii', m.group().decode('utf-8', 'replace')))
    le_starts, le_ends = [], []
    for m in STR_U16LE_RX.finditer(data):
        le_starts.append(m.start())
        le_ends.append(m.end())
        out.append((m.start(), 'utf16le', m.group().decode('utf-16-le', 'replace')))
    for m in STR_U16BE_RX.finditer(data):
        k = bisect.bisect_right(le_starts, m.start() + 1) - 1
        if k >= 0 and le_ends[k] >= m.end() - 1:
            continue              # the same UTF-16 LE text read one byte off
        out.append((m.start(), 'utf16be', m.group().decode('utf-16-be', 'replace')))
    return out


# --------------------------------------------------------------------------------------------------------------------
# Denylist and allow files

_APOS = str.maketrans({'\u2019': "'", '\u2018': "'", '\u02bc': "'", '`': "'"})


def fold(s):
    """Lower-case + one apostrophe, keeping the length (so indexes still match the original text)."""
    t = s.lower()
    if len(t) != len(s):
        t = ''.join(c.lower() if len(c.lower()) == 1 else c for c in s)
    return t.translate(_APOS)


class DenyEntry:
    __slots__ = ('id', 'label', 'kind', 'needle', 'rx')

    def __init__(self, ident, label, kind, value):
        self.id, self.label, self.kind = ident, label, kind
        self.needle = self.rx = None
        if kind in ('lit', 'word'):
            self.needle = fold(value)
        elif kind == 'case':
            self.needle = value
        else:
            if value.startswith('(?i)'):
                value = '(?i:' + value[4:] + ')'
            self.rx = re.compile(value)

    def find(self, text, folded):
        if self.rx is not None:
            for m in self.rx.finditer(text):
                if m.end() > m.start():
                    yield m.start(), m.end()
            return
        hay = text if self.kind == 'case' else folded
        n, i = len(self.needle), 0
        if not n:
            return
        while True:
            i = hay.find(self.needle, i)
            if i < 0:
                return
            j = i + n
            if self.kind == 'word':
                before = hay[i - 1] if i > 0 else ' '
                after = hay[j] if j < len(hay) else ' '
                if (before.isalnum() or before == '_') or (after.isalnum() or after == '_'):
                    i += 1
                    continue
            yield i, j
            i = j


def load_denylist(path):
    entries, allows = [], []
    with open(path, encoding='utf-8') as f:
        for n, raw in enumerate(f, 1):
            line = raw.rstrip('\r\n')
            s = line.strip()
            if not s or s.startswith('#'):
                continue
            if s.startswith('allow '):
                parts = s.split(None, 2)
                if len(parts) != 3:
                    raise SystemExit('denylist line %d: use "allow <path-glob> <regex>"' % n)
                allows.append((n, rc.glob_to_regex(parts[1], ignore_case=True), re.compile(parts[2])))
                continue
            label = ''
            m = re.match(r'\[([^\]]+)\]\s*(.*)$', s)
            if m:
                label, s = m.group(1), m.group(2)
            kind = 'lit'
            for k in ('re', 'word', 'case', 'lit'):
                if s.startswith(k + ':'):
                    kind, s = k, s[len(k) + 1:]
                    break
            if not s:
                continue
            try:
                entries.append(DenyEntry(n, label, kind, s))
            except re.error as e:
                raise SystemExit('denylist line %d: bad regex (%s)' % (n, e))
    return entries, allows


def load_scan_allow(path):
    """Lines: CATEGORY[:rule] <path-glob> <value-regex>  # reason. The regex must match the whole finding."""
    rules = []
    if not path or not os.path.exists(path):
        return rules
    with open(path, encoding='utf-8') as f:
        for n, raw in enumerate(f, 1):
            s = raw.strip()
            if not s or s.startswith('#'):
                continue
            s = re.split(r'\s+#', s, maxsplit=1)[0].strip()
            parts = s.split(None, 2)
            if len(parts) != 3:
                raise SystemExit('scan-allow line %d: use "CATEGORY[:rule] <path-glob> <value-regex>"' % n)
            cat, _, rule = parts[0].partition(':')
            if cat.upper() == 'DENY':
                raise SystemExit('scan-allow line %d: denylist exceptions belong in the local denylist' % n)
            rules.append((cat.upper(), rule or None, rc.glob_to_regex(parts[1], ignore_case=True), re.compile(parts[2]), n))
    return rules


def glob_hit(grx, path):
    """An allow glob matches the path or any tail of it that starts after a '/' or '!', so one rule written for the
    source tree also covers the same file inside the source archive, the GPL bundle or another archive."""
    if grx.match(path):
        return True
    for i, ch in enumerate(path):
        if ch in '/!' and grx.match(path[i + 1:]):
            return True
    return False


# --------------------------------------------------------------------------------------------------------------------
# The release-signing key's own material (--sign-key; DESIGN-UPDATES 4.4)

class ReleaseKeyError(Exception):
    """The key file can't be used. The message never carries key material."""


def release_key_needles(path):
    """What the scan looks for when it checks one private release key: {'raw': [(label, bytes)], 'text': [(label, str)],
    'id': public key id or None}. The key's bytes stay in this process; they are never printed or written."""
    import base64
    try:
        with open(path, 'rb') as f:
            data = f.read()
    except OSError as e:
        raise ReleaseKeyError('can\'t be read (%s)' % type(e).__name__)
    got = rc.ed25519_private_der(data)
    data = None
    if not got:
        raise ReleaseKeyError('isn\'t an unencrypted Ed25519 private key in PKCS#8 (PEM or DER)')
    seed, der = got
    forms = {rc.ED25519_PKCS8_PREFIXES[0] + seed, der}     # the PKCS#8 DER as written, and the v1 form of the seed
    text = [('seed (hex)', seed.hex()), ('seed (hex)', seed.hex().upper())]
    # base64 of the seed's first 30 bytes: present in every base64 text that starts with the seed (padded or not,
    # standard or URL-safe, the seed alone or followed by its public key as in Go's 64-byte private keys)
    head = base64.b64encode(seed[:30]).decode('ascii')
    text += [('seed (base64)', head), ('seed (base64)', head.replace('+', '-').replace('/', '_'))]
    for d in sorted(forms):
        b = base64.b64encode(d).decode('ascii').rstrip('=')
        text += [('PKCS#8 (base64)', b), ('PKCS#8 (base64)', b.replace('+', '-').replace('/', '_'))]
    seen, uniq = set(), []
    for label, needle in text:
        if needle not in seen:
            seen.add(needle)
            uniq.append((label, needle))
    kid = None
    try:                                    # the public key id, when the cryptography package is there
        import sign
        kid = rc.key_id(sign.raw_public(sign.crypto()[1].from_private_bytes(seed)))
    except Exception:  # noqa: BLE001  (optional; never echo an exception text)
        kid = None
    return {'raw': [('seed (raw bytes)', seed)], 'text': uniq, 'id': kid}


# --------------------------------------------------------------------------------------------------------------------
# The scanner

class Scanner:
    def __init__(self, deny, deny_allows, scan_allows, source_tree=False, release_keys=()):
        self.deny, self.deny_allows, self.scan_allows = deny, deny_allows, scan_allows
        self.source_tree = source_tree
        # the release-signing keys checked by --sign-key: their raw and text forms (in memory only)
        self.key_raw = [n for k in release_keys for n in k['raw']]
        self.key_text = [n for k in release_keys for n in k['text']]
        self.findings = []
        self.files = 0
        self.bytes = 0
        self.target = ''
        self.debs_seen = {}      # SHA-256 -> path of the first copy of each deb scanned in this run
        self.same_debs = []      # (path, first path): later copies, not scanned again

    # ---- helpers
    def add(self, cat, rule, path, where, value=None, line_text=None, spans=None, label=''):
        self.findings.append({'category': cat, 'rule': rule, 'label': label, 'target': self.target, 'path': path, 'where': where,
                              'value': value, 'line': line_text, 'spans': spans or []})

    def generic_allowed(self, cat, rule, path, value):
        for c, r, grx, vrx, _ in self.scan_allows:
            if c == cat and (r is None or r == rule) and glob_hit(grx, path) and vrx.fullmatch(value or ''):
                return True
        return False

    def deny_allowed(self, path, line_text, s, e):
        for _, grx, vrx in self.deny_allows:
            if not glob_hit(grx, path):
                continue
            for m in vrx.finditer(line_text):
                if m.start() <= s and m.end() >= e:
                    return True
        return False

    # ---- names
    def check_name(self, path, member=False):
        why = rc.forbidden_reason(path.split('!')[-1], source_tree=self.source_tree and not member)
        if not why and not member and self.source_tree and rc.never_ship_repo_path(path):
            why = 'never-ship path'
        if why:
            self.add('FILENAME', why, path, 'name')
        folded = fold(path)
        for d in self.deny:
            for s, e in d.find(path, folded):
                if not self.deny_allowed(path, path, s, e):
                    self.add('DENY', 'deny:%d' % d.id, path, 'name', path[s:e], path, [(s, e, 'DENY:%d' % d.id)], d.label)

    # ---- content
    def scan_text(self, path, text, env_file=False, where_of=None):
        """where_of(index) -> description; default 'line N:col'."""
        folded = fold(text)

        def bounds(s, e):
            ls = text.rfind('\n', 0, s) + 1
            le = text.find('\n', e)
            return ls, (len(text) if le < 0 else le)

        hits = []          # (s, e, cat, rule, label)
        deny_spans = []
        for d in self.deny:
            for s, e in d.find(text, folded):
                ls, le = bounds(s, e)
                if self.deny_allows and self.deny_allowed(path, text[ls:le], s - ls, e - ls):
                    continue
                hits.append((s, e, 'DENY', 'deny:%d' % d.id, d.label))
                deny_spans.append((s, e))

        def covered(s, e):
            return any(not (e <= ds or s >= de) for ds, de in deny_spans)

        for name, rx in SECRET_RX:
            for m in rx.finditer(text):
                if not self.generic_allowed('SECRET', name, path, m.group()):
                    hits.append((m.start(), m.end(), 'SECRET', name, ''))
        key_spans = set()
        for label, needle in self.key_text:       # the release key's own material: no exception can allow it
            i = text.find(needle)
            while i >= 0:
                s, e = i, i + len(needle)
                while s > 0 and _B64_TOKEN.match(text[s - 1]):      # mask the whole token around it
                    s -= 1
                while e < len(text) and _B64_TOKEN.match(text[e]):
                    e += 1
                if (s, e) not in key_spans:
                    key_spans.add((s, e))
                    hits.append((s, e, 'SECRET', RELEASE_KEY_RULE, label))
                i = text.find(needle, i + 1)
        if env_file:
            for m in ENV_VALUE_RX.finditer(text):
                if not self.generic_allowed('SECRET', 'env-value', path, m.group(2)):
                    hits.append((m.start(2), m.end(2), 'SECRET', 'env-value', m.group(1)))
        for m in IP_RX.finditer(text):
            if covered(m.start(), m.end()) or ip_ok(m.group(1), m.group(2)):
                continue
            if not self.generic_allowed('IP', None, path, m.group(1)):
                hits.append((m.start(1), m.end(1), 'IP', 'ipv4', ''))
        for m in EMAIL_RX.finditer(text):
            if covered(m.start(), m.end()) or email_ok(text, m):
                continue
            if not self.generic_allowed('EMAIL', None, path, m.group()):
                hits.append((m.start(), m.end(), 'EMAIL', 'email', ''))
        for rx in HOME_RXS:
            for m in rx.finditer(text):
                val = m.group().rstrip(_TRAIL)
                s, e = m.start(), m.start() + len(val)
                if e <= s or covered(s, e) or home_ok(m.group(1)):
                    continue
                if not self.generic_allowed('HOMEPATH', None, path, val):
                    hits.append((s, e, 'HOMEPATH', 'home-path', ''))
        if not hits:
            return
        hits.sort()
        nl = [m.start() for m in re.finditer('\n', text)]

        def line_of(i):
            k = bisect.bisect_left(nl, i)
            start = nl[k - 1] + 1 if k > 0 else 0
            end = nl[k] if k < len(nl) else len(text)
            return k + 1, start, end

        by_line = {}
        for h in hits:
            ln, ls, le = line_of(h[0])
            by_line.setdefault((ln, ls, le), []).append(h)
        for (ln, ls, le), hs in sorted(by_line.items()):
            line_text = text[ls:le]
            spans = [(s - ls, min(e, le) - ls, '%s:%s' % (c, r.split(':')[-1] if c == 'DENY' else r)) for s, e, c, r, _ in hs]
            for s, e, c, r, lab in hs:
                where = where_of(s) if where_of else 'line %d:%d' % (ln, s - ls + 1)
                self.add(c, r, path, where, None if r in NEVER_REVEAL else text[s:e], line_text, spans, lab)

    def scan_binary(self, path, data):
        strs = binary_strings(data)
        if not strs:
            return
        strs.sort()
        pieces, starts, pos = [], [], 0
        for off, enc, s in strs:
            starts.append(pos)
            pieces.append(s)
            pos += len(s) + 1
        blob = '\n'.join(pieces)

        def where_of(i):
            k = bisect.bisect_right(starts, i) - 1
            off, enc, _ = strs[k]
            return 'offset 0x%x (%s)' % (off, enc)

        self.scan_text(path, blob, where_of=where_of)

    # ---- dispatch
    def scan_bytes(self, path, data, depth=0, member=False):
        self.files += 1
        self.bytes += len(data)
        self.check_name(path, member=member)
        if self.is_secret_name(path.split('!')[-1]):
            return                    # a secret or state file inside an archive: report the name, never its content
        if depth > MAX_DEPTH:
            self.add('ERROR', 'archive nesting too deep', path, '-')
            return
        low = path.lower()
        try:
            if data[:8] == b'!<arch>\n':
                if low.endswith('.deb') and self.seen_deb(path, data):
                    return
                return self.scan_ar(path, data, depth)
            if data[:4] == b'PK\x03\x04' or (data[:4] == b'PK\x05\x06' and low.endswith('.zip')):
                return self.scan_zip(path, data, depth)
            if len(data) > 262 and data[257:262] == b'ustar':
                return self.scan_tar(path, data, depth)
            if data[:2] == b'\x1f\x8b':
                return self.scan_compressed(path, gzip.decompress(data), depth, '.gz')
            if data[:6] == b'\xfd7zXZ\x00':
                return self.scan_compressed(path, lzma.decompress(data), depth, '.xz')
            if data[:3] == b'BZh' and low.endswith(('.bz2', '.tbz', '.tbz2')):
                return self.scan_compressed(path, bz2.decompress(data), depth, '.bz2')
            if low.endswith(('.lzma', '.tlz')) and data[:1] == b'\x5d':
                return self.scan_compressed(path, lzma.decompress(data, format=lzma.FORMAT_ALONE), depth, '.lzma')
            if data[:4] == b'\x28\xb5\x2f\xfd' or data[:6] == b'7z\xbc\xaf\x27\x1c' or data[:4] == b'Rar!':
                self.add('ERROR', 'archive format not supported by the scanner (zstd/7z/rar)', path, '-')
                self.scan_raw_keys(path, data)
                return self.scan_binary(path, data)
        except Exception as e:  # a corrupt archive must fail the scan, never pass silently
            self.add('ERROR', 'cannot open archive: %s' % type(e).__name__, path, '-')
            self.scan_raw_keys(path, data)
            return self.scan_binary(path, data)
        self.scan_content(path, data)

    def seen_deb(self, path, data):
        """True when a byte-identical deb was scanned already in this run (the same deb as a target and again inside
        a folder or another archive): its name is checked, its content not again."""
        h = hashlib.sha256(data).hexdigest()
        first = self.debs_seen.get(h)
        if first is None:
            self.debs_seen[h] = path
            return False
        self.same_debs.append((path, first))
        return True

    def scan_raw_keys(self, path, data):
        """Binary key material the strings pass can't see: an Ed25519 PKCS#8 DER private key (any key), and the raw
        seed of the release keys given with --sign-key. Values are never kept."""
        for prefix in rc.ED25519_PKCS8_PREFIXES:
            i = data.find(prefix)
            while i >= 0:
                if len(data) - i - len(prefix) >= 32 and not self.generic_allowed('SECRET', 'ed25519-pkcs8-der', path,
                                                                                    'ed25519-pkcs8-der'):
                    self.add('SECRET', 'ed25519-pkcs8-der', path, 'offset 0x%x' % i)
                i = data.find(prefix, i + 1)
        for label, needle in self.key_raw:
            i = data.find(needle)
            while i >= 0:
                self.add('SECRET', RELEASE_KEY_RULE, path, 'offset 0x%x' % i, label=label)
                i = data.find(needle, i + 1)

    def scan_content(self, path, data):
        self.scan_raw_keys(path, data)
        for rule, where in image_metadata(data):
            if not self.generic_allowed('METADATA', rule, path, rule):
                self.add('METADATA', rule, path, where)
        name = path.split('!')[-1].split('/')[-1].lower()
        env_file = name.endswith('.env') or '.env.' in name or name.startswith('.env') or name.endswith('env.example')
        if data[:2] in (b'\xff\xfe', b'\xfe\xff'):
            try:
                return self.scan_text(path, data.decode('utf-16'), env_file)
            except UnicodeDecodeError:
                pass
        if b'\x00' in data[:65536] or b'\x00' in data[-65536:]:
            return self.scan_binary(path, data)
        text = data.decode('utf-8-sig', 'replace')
        self.scan_text(path, text, env_file)
        # a text file can still hold UTF-16 pieces; cheap to check
        if b'\x00' in data:
            self.scan_binary(path, data)

    def scan_compressed(self, path, raw, depth, ext):
        last = re.split(r'[/!]', path)[-1]
        inner = re.sub(r'\.(?:gz|xz|bz2|lzma)$', '', last, flags=re.IGNORECASE)
        inner = re.sub(r'\.(?:tgz|txz|tbz2?|tlz)$', '.tar', inner, flags=re.IGNORECASE)
        if inner == last:
            inner = last + '.unpacked'
        self.scan_bytes(path + '!' + inner, raw, depth + 1, member=True)

    def scan_ar(self, path, data, depth):
        i = 8
        while i + 60 <= len(data):
            hdr = data[i:i + 60]
            name = hdr[:16].decode('ascii', 'replace').strip().rstrip('/')
            size = int(hdr[48:58].decode('ascii').strip() or 0)
            body = data[i + 60:i + 60 + size]
            self.scan_bytes(path + '!' + name, body, depth + 1, member=True)
            i += 60 + size + (size & 1)

    def scan_zip(self, path, data, depth):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                if info.is_dir():
                    self.check_name(path + '!' + info.filename.rstrip('/') + '/x', member=True)
                    continue
                self.scan_bytes(path + '!' + info.filename, z.read(info), depth + 1, member=True)

    def scan_tar(self, path, data, depth):
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as t:
            for m in t.getmembers():
                mp = path + '!' + re.sub(r'^(?:\./)+', '', m.name).lstrip('/')
                if m.isdir():
                    self.check_name(mp.rstrip('/') + '/x', member=True)
                    continue
                if m.issym() or m.islnk():
                    self.check_name(mp, member=True)
                    tgt = m.linkname
                    self.scan_text(mp + ' (link target)', tgt)
                    continue
                if not m.isfile():
                    continue
                f = t.extractfile(m)
                self.scan_bytes(mp, f.read() if f else b'', depth + 1, member=True)

    def scan_path(self, target):
        target = os.path.abspath(target)
        base = os.path.basename(target.rstrip('/\\')) or target
        self.target = base
        if os.path.isfile(target):
            with open(target, 'rb') as f:
                self.scan_bytes(base, f.read())
            return
        for dirpath, dirnames, filenames in os.walk(target, followlinks=False):
            rel = os.path.relpath(dirpath, target).replace(os.sep, '/')
            rel = '' if rel == '.' else rel
            keep = []
            for d in sorted(dirnames):
                p = (rel + '/' + d) if rel else d
                if os.path.islink(os.path.join(dirpath, d)):
                    self.add('FILENAME', 'symbolic link in a release folder', p + '/', 'name')
                elif d.lower() in rc.FORBIDDEN_DIRS or (self.source_tree and rc.never_ship_repo_path(p + '/x')):
                    self.add('FILENAME', 'never-ship folder (not opened)', p + '/', 'name')
                else:
                    keep.append(d)
            dirnames[:] = keep
            for fn in sorted(filenames):
                p = (rel + '/' + fn) if rel else fn
                ap = os.path.join(dirpath, fn)
                if os.path.islink(ap):
                    self.add('FILENAME', 'symbolic link in a release folder', p, 'name')
                    continue
                if self.is_secret_name(p):
                    # never open secret or state files: report the name only
                    self.files += 1
                    self.check_name(p)
                    continue
                try:
                    with open(ap, 'rb') as f:
                        data = f.read()
                except OSError as e:
                    self.add('ERROR', 'cannot read: %s' % type(e).__name__, p, '-')
                    continue
                self.scan_bytes(p, data)

    @staticmethod
    def is_secret_name(p):
        why = rc.forbidden_reason(p) or ''
        return any(w in why for w in ('environment', 'secret', 'credentials', 'key', 'saved web', 'log', 'local-only',
                                      'backup'))


def ip_ok(ip, cidr):
    o = [int(x) for x in ip.split('.')]
    if cidr is not None:
        n = int(cidr)
        if n <= 32:
            v = (o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]
            if n == 32 or v & ((1 << (32 - n)) - 1) == 0:
                return True
    if o[0] in (0, 127) or o[0] >= 224:
        return True                   # unspecified, loopback, multicast, reserved, netmasks
    if (o[0], o[1], o[2]) in ((192, 0, 2), (198, 51, 100), (203, 0, 113)):
        return True                   # documentation ranges (RFC 5737)
    if o[0] == 169 and o[1] == 254:
        return True                   # link-local
    return ip in _RESOLVERS


def email_ok(text, m):
    local, domain = m.group(1).lower(), m.group(2).lower()
    if domain.rsplit('.', 1)[-1] in _FILE_EXTS:
        return True                   # Icon@2x.png
    if domain.endswith(_EMAIL_OK_SUFFIXES) or local in ('git', 'noreply', 'no-reply'):
        return True
    before = text[max(0, m.start() - 200):m.start()]
    if re.search(r'://[^\s/@]*:$', before):
        return True                   # user:password@host in a URL (the url-credentials rule covers it)
    return False


_TRAIL = '.,;:)]}"\'`'


def home_ok(name):
    n = name.lower().strip().rstrip(_TRAIL)
    # placeholders, variables (<user>, $USER, %USERNAME%, {user}), regex syntax, and one-letter test names
    return n in _HOME_PLACEHOLDERS or n.startswith(('<', '$', '%', '{', '*', '(', '[')) or len(n) <= 1


# --------------------------------------------------------------------------------------------------------------------
# Report

def mask_line(line, spans, reveal_generic, values):
    """Replace every finding on the line with a placeholder, then cut a window around the first one."""
    if line is None:
        return ''
    out = line
    for s, e, tag in sorted(spans, key=lambda x: -x[0]):
        cat = tag.split(':')[0]
        if reveal_generic and cat in ('IP', 'EMAIL', 'HOMEPATH') and (s, e) in values:
            continue
        out = out[:s] + '\u00ab' + tag + '\u00bb' + out[e:]
    first = min((s for s, _, _ in spans), default=0)
    a = max(0, first - CTX)
    b = min(len(out), first + CTX + 40)
    snippet = ('\u2026' if a > 0 else '') + out[a:b] + ('\u2026' if b < len(out) else '')
    return snippet.replace('\t', ' ').replace('\r', ' ').replace('\n', ' ')


def render(findings, targets, meta, reveal_generic=False, show_matches=False, per_file_cap=25):
    lines = []
    lines.append('Encore release privacy scan')
    lines.append('targets : %s' % ', '.join(targets))
    lines.append('denylist: %s' % meta['denylist'])
    lines.append('release key: %s' % meta.get('release_key', 'not checked'))
    lines.append('scanned : %d files, %.1f MB' % (meta['files'], meta['bytes'] / 1e6))
    lines.append('result  : %s' % ('CLEAN' if not findings else 'FAIL, %d findings' % len(findings)))
    if meta.get('same_debs'):
        lines.append('same    : %d deb(s) byte-identical to one scanned above (SHA-256), not scanned again'
                     % meta['same_debs'])
    if not findings:
        return '\n'.join(lines) + '\n'
    cats = {}
    for f in findings:
        cats.setdefault(f['category'], 0)
        cats[f['category']] += 1
    lines.append('')
    lines.append('By category: ' + ', '.join('%s %d' % kv for kv in sorted(cats.items())))
    areas = {}
    for f in findings:
        p = f['path'].split('!')[0]
        area = '/'.join(p.split('/')[:2]) if '/' in p else p
        if len(targets) > 1 and not p.startswith(f['target']):
            area = f['target'] + ' : ' + area
        areas.setdefault(area, {}).setdefault(f['category'], 0)
        areas[area][f['category']] += 1
    lines.append('')
    lines.append('By area:')
    for area in sorted(areas):
        lines.append('  %-50s %s' % (area, ', '.join('%s %d' % kv for kv in sorted(areas[area].items()))))
    lines.append('')
    lines.append('Findings (values masked as \u00abCATEGORY:rule\u00bb; denylist values are never printed):')
    multi = len(set(f['target'] for f in findings)) > 1 or len(targets) > 1
    by_file = {}
    for f in findings:
        by_file.setdefault((f['target'], f['path']), []).append(f)
    for key in sorted(by_file):
        fs = by_file[key]
        shown = mask_path(key[1], fs)
        lines.append('')
        lines.append('== %s%s (%d)' % ((key[0] + ' : ') if multi and not key[1].startswith(key[0]) else '', shown, len(fs)))
        seen = 0
        for f in fs:
            if seen >= per_file_cap:
                lines.append('   ... %d more in this file (see the JSON report)' % (len(fs) - seen))
                break
            seen += 1
            tag = f['rule'] + (' [%s]' % f['label'] if f['label'] else '')
            if f['category'] == 'SECRET' and f['rule'] == 'env-value':
                tag = 'env-value %s' % f['label']
            vals = {(s, e) for s, e, t in f['spans']}
            ex = mask_line(f['line'], f['spans'], reveal_generic, vals) if f['line'] is not None else ''
            if show_matches and f['value'] is not None:
                ex += '   [match: %r]' % f['value']
            lines.append('   %-8s %-28s %-26s %s' % (f['category'], tag, f['where'], ex))
    return '\n'.join(lines) + '\n'


def mask_path(path, fs):
    out = path
    for f in fs:
        if f['category'] == 'DENY' and f['where'] == 'name':
            for s, e, tag in sorted(f['spans'], key=lambda x: -x[0]):
                if out == path:
                    out = out[:s] + '\u00ab' + tag + '\u00bb' + out[e:]
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('targets', nargs='+')
    ap.add_argument('--denylist', default=rc.DENYLIST_DEFAULT, help='local denylist (default: tools/release/denylist.local.txt)')
    ap.add_argument('--no-denylist', action='store_true', help='run the generic checks only (for people without the denylist)')
    ap.add_argument('--allow', default=rc.SCAN_ALLOW_DEFAULT, help='public exceptions for the generic checks')
    ap.add_argument('--source-tree', action='store_true', help='targets are source trees: build outputs and archives also fail')
    ap.add_argument('--report', help='write the text report here')
    ap.add_argument('--json', help='write the findings as JSON here (values masked unless --show-matches)')
    ap.add_argument('--reveal-generic', action='store_true', help='show IP/e-mail/path values in excerpts (never denylist values)')
    ap.add_argument('--show-matches', action='store_true', help='LOCAL DEBUGGING ONLY: print the raw matched text, denylist hits included')
    ap.add_argument('--quiet', action='store_true', help='print only the summary lines')
    ap.add_argument('--sign-key', action='append', default=[], metavar='KEY',
                    help='a private release-signing key whose own material must appear nowhere (read in memory, never '
                         'printed; repeatable). Default: ENCORE_SIGN_KEY from release.local.env or the environment')
    ap.add_argument('--no-sign-key', action='store_true', help='don\'t check for the release key\'s material')
    ap.add_argument('--final', action='store_true', help='a release scan: the release key check is required')
    a = ap.parse_args(argv)

    keys = [os.path.abspath(k) for k in a.sign_key]
    if a.no_sign_key and (keys or a.final):
        print('scan: --no-sign-key can\'t be combined with --sign-key or --final', file=sys.stderr)
        return 2
    if not keys and not a.no_sign_key:
        default = rc.read_local_conf().get('ENCORE_SIGN_KEY')
        if default and os.path.isfile(default):
            keys = [os.path.abspath(default)]
        elif default:
            print('scan: ENCORE_SIGN_KEY names no file, so the release key isn\'t checked', file=sys.stderr)
    if a.final and not keys:
        print('scan: --final needs the release key (--sign-key, or ENCORE_SIGN_KEY in release.local.env)', file=sys.stderr)
        return 2
    release_keys = []
    for n, k in enumerate(keys, 1):
        try:
            release_keys.append(release_key_needles(k))
        except ReleaseKeyError as e:
            print('scan: release key %d %s' % (n, e), file=sys.stderr)
            return 2
    if release_keys:
        ids = [k['id'] for k in release_keys if k['id']]
        key_desc = 'checked (%s)' % (', '.join('key %s' % i for i in ids) if ids else '%d key(s)' % len(release_keys))
    else:
        key_desc = 'not checked'

    if a.no_denylist:
        deny, allows, deny_desc = [], [], 'not used (generic checks only)'
    else:
        if not os.path.exists(a.denylist):
            print('scan: the local denylist is missing (%s). Create it from denylist.example.txt, or pass --no-denylist '
                  'to run the generic checks only.' % os.path.basename(a.denylist), file=sys.stderr)
            return 2
        deny, allows = load_denylist(a.denylist)
        deny_desc = '%d entries, %d allow rules (local file, never shipped)' % (len(deny), len(allows))
    scan_allows = load_scan_allow(a.allow)
    sc = Scanner(deny, allows, scan_allows, source_tree=a.source_tree, release_keys=release_keys)
    release_keys = None
    names = []
    for t in a.targets:
        if not os.path.exists(t):
            print('scan: no such file or folder: %s' % t, file=sys.stderr)
            return 2
        names.append(os.path.basename(os.path.abspath(t).rstrip('/\\')))
        sc.scan_path(t)
    meta = {'denylist': deny_desc, 'files': sc.files, 'bytes': sc.bytes, 'same_debs': len(sc.same_debs),
            'release_key': key_desc}
    text = render(sc.findings, names, meta, a.reveal_generic, a.show_matches)
    if a.report:
        with open(a.report, 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
    if a.json:
        rows = []
        for f in sc.findings:
            vals = {(s, e) for s, e, t in f['spans']}
            r = {k: f[k] for k in ('category', 'rule', 'label', 'target', 'path', 'where')}
            r['excerpt'] = mask_line(f['line'], f['spans'], a.reveal_generic, vals) if f['line'] is not None else ''
            if a.show_matches:
                r['value'] = f['value']
            rows.append(r)
        with open(a.json, 'w', encoding='utf-8', newline='\n') as f:
            json.dump({'targets': names, 'meta': meta, 'findings': rows}, f, indent=1, ensure_ascii=False)
    if a.quiet:
        head = text.split('\n\n', 1)[0]           # the header block, up to the first blank line
        print(head.rstrip('\n'))
    else:
        enc = sys.stdout.encoding or 'utf-8'
        # consoles disagree about encodings: ASCII markers on screen, the Unicode ones in the report files
        out = text.replace('«', '<<').replace('»', '>>').replace('…', '...')
        out = out.encode(enc, 'replace').decode(enc, 'replace')
        sys.stdout.write(out)
    return 1 if sc.findings else 0


if __name__ == '__main__':
    sys.exit(main())
