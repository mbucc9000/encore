#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Build the public Encore source tree from the working copy, by allowlist.

    python tools/release/export.py --out <new folder outside the repo> [--final]

* Copies only files that match tools/release/export-allowlist.txt. Nothing else is copied.
* The never-ship rules in relcommon.py (secret and state files, keys, logs, dev folders, build outputs, local-only
  files) win over the allowlist. Never-ship files are skipped by name and are never opened.
* The output folder must be new (or empty) and outside the working copy.
* Writes a MANIFEST (sha256, size, path for every exported file) and an export log that lists every file left
  behind, so a file another lane added but nobody allowlisted is noticed instead of silently dropped.
* --final: every '+' allowlist entry must match a file, and the app and bridge versions must be equal (D8).

Exit code: 0 = ok, 1 = a --final check failed, 2 = usage error.
"""
import argparse
import os
import shutil
import sys

sys.dont_write_bytecode = True   # keep __pycache__ out of the working copy
import relcommon as rc  # noqa: E402


def load_allowlist(path):
    entries = []
    with open(path, encoding='utf-8') as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            required = line.startswith('+')
            pat = line[1:].strip() if required else line
            if pat in ('**', '*', '**/*') or pat.startswith('/') or '..' in pat.split('/'):
                raise SystemExit('export-allowlist line %d: "%s" is not allowed (no whole-repo globs)' % (n, pat))
            entries.append({'pattern': pat, 'rx': rc.glob_to_regex(pat), 'required': required, 'hits': 0})
    return entries


def walk_repo(root, log):
    """Yield (relpath, abspath) for every regular file, pruning never-ship folders without listing their contents."""
    for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        reldir = os.path.relpath(dirpath, root).replace(os.sep, '/')
        reldir = '' if reldir == '.' else reldir
        keep = []
        for d in sorted(dirnames):
            rel = (reldir + '/' + d) if reldir else d
            if os.path.islink(os.path.join(dirpath, d)):
                log.append(('symlink', rel + '/', 'symbolic link, not followed'))
            elif d.lower() in rc.FORBIDDEN_DIRS or rc.never_ship_repo_path(rel + '/x'):
                log.append(('never-ship', rel + '/', 'never-ship folder (contents not listed)'))
            else:
                keep.append(d)
        dirnames[:] = keep
        for fn in sorted(filenames):
            rel = (reldir + '/' + fn) if reldir else fn
            ap = os.path.join(dirpath, fn)
            if os.path.islink(ap):
                log.append(('symlink', rel, 'symbolic link, not copied'))
                continue
            yield rel, ap


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', required=True, help='new folder for the exported tree (outside the working copy)')
    ap.add_argument('--repo', default=rc.REPO_ROOT, help='working copy root (default: this script\'s repo)')
    ap.add_argument('--allowlist', default=rc.EXPORT_ALLOWLIST_DEFAULT)
    ap.add_argument('--manifest', help='MANIFEST path (default: <out>.MANIFEST.txt)')
    ap.add_argument('--log', help='export log path (default: <out>.export-log.txt)')
    ap.add_argument('--final', action='store_true', help='fail on missing required entries or a version mismatch')
    a = ap.parse_args(argv)

    repo = os.path.abspath(a.repo)
    out = os.path.abspath(a.out)
    if rc.is_inside(out, repo):
        print('export: --out must be outside the working copy', file=sys.stderr)
        return 2
    if os.path.exists(out) and (not os.path.isdir(out) or os.listdir(out)):
        print('export: --out must be a new or empty folder: %s' % out, file=sys.stderr)
        return 2
    manifest = os.path.abspath(a.manifest or (out.rstrip('/\\') + '.MANIFEST.txt'))
    logpath = os.path.abspath(a.log or (out.rstrip('/\\') + '.export-log.txt'))
    for p in (manifest, logpath):
        if rc.is_inside(p, repo) or rc.is_inside(p, out):
            print('export: the manifest and log must be outside the working copy and the exported tree', file=sys.stderr)
            return 2

    entries = load_allowlist(a.allowlist)
    log, copied = [], []
    os.makedirs(out, exist_ok=True)
    for rel, src in walk_repo(repo, log):
        if rc.never_ship_repo_path(rel):
            log.append(('never-ship', rel, 'never-ship path'))
            continue
        why = rc.forbidden_reason(rel, source_tree=True)
        if why:
            log.append(('never-ship', rel, why))
            continue
        hit = [e for e in entries if e['rx'].match(rel)]
        if not hit:
            log.append(('not-allowlisted', rel, 'not on the allowlist'))
            continue
        for e in hit:
            e['hits'] += 1
        dst = os.path.join(out, *rel.split('/'))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        copied.append(rel)

    problems = []
    for e in entries:
        if e['required'] and e['hits'] == 0:
            problems.append('required allowlist entry matched nothing: %s' % e['pattern'])
    app_v, bridge_v = rc.read_versions(out)
    if app_v is None:
        problems.append('no app version (app/control) in the exported tree')
    if app_v and bridge_v and app_v != bridge_v:
        problems.append('app version %s != bridge version %s (D8: one shared version)' % (app_v, bridge_v))

    copied.sort()
    with open(manifest, 'w', encoding='utf-8', newline='\n') as f:
        f.write('# Encore %s source tree manifest: sha256, size in bytes, path. %d files.\n' % (app_v or '?', len(copied)))
        for rel in copied:
            p = os.path.join(out, *rel.split('/'))
            f.write('%s  %10d  %s\n' % (rc.sha256_file(p), os.path.getsize(p), rel))
    with open(logpath, 'w', encoding='utf-8', newline='\n') as f:
        f.write('# Encore export log. Exported %d files to the new tree.\n' % len(copied))
        f.write('# app version %s, bridge version %s\n' % (app_v, bridge_v))
        for p in problems:
            f.write('PROBLEM  %s\n' % p)
        for kind in ('never-ship', 'symlink', 'not-allowlisted'):
            rows = [r for r in log if r[0] == kind]
            f.write('\n## %s (%d)\n' % (kind, len(rows)))
            for _, rel, why in rows:
                f.write('%-60s  %s\n' % (rel, why))

    n_ns = sum(1 for r in log if r[0] == 'never-ship')
    n_na = sum(1 for r in log if r[0] == 'not-allowlisted')
    print('export: %d files copied, %d never-ship items skipped, %d files not on the allowlist' % (len(copied), n_ns, n_na))
    print('export: manifest %s' % manifest)
    print('export: log      %s' % logpath)
    for p in problems:
        print('export: %s %s' % ('FAIL' if a.final else 'warning', p))
    return 1 if (a.final and problems) else 0


if __name__ == '__main__':
    sys.exit(main())
