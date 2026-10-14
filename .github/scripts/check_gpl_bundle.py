#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Checks that a release's GPL bundle holds exactly the engine source the images are built from. Standard library only.

    check_gpl_bundle.py <Encore-X.Y.Z-gpl-source.tar.gz> <gateway/engine-src>

The engine image's io.github.mbucc9000.encore.gpl-source label names the release's GPL bundle as its source, so the
bundle's engine/ folder (tools/release/gpl_bundle.py: every file of gateway/engine-src, plus engine/vendor/, the Go
modules) must hold the same files with the same bytes as the gateway/engine-src that is built. vendor/ is left out on
both sides. The archive is only read, never unpacked.

exit: 0 the same; 1 they differ (each difference on its own line, at most 20); 2 usage or an unreadable input
"""
import os
import sys
import tarfile

LIMIT = 20


def bundle_files(path):
    """{relative path under engine/: bytes} of the bundle (vendor/ left out), or raises ValueError."""
    out = {}
    with tarfile.open(path, 'r:gz') as t:
        for m in t:
            parts = m.name.split('/')
            if len(parts) < 3 or parts[1] != 'engine' or parts[2] == 'vendor':
                continue
            rel = '/'.join(parts[2:])
            if m.isdir():
                continue
            if not m.isfile():
                raise ValueError('engine/%s in the bundle isn\'t a plain file' % rel)
            out[rel] = t.extractfile(m).read()
    return out


def tree_files(root):
    """{relative path: bytes} of every file under root (vendor/ left out), or raises ValueError."""
    out = {}
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, '/')
        if rel_dir == '.':
            dirnames[:] = [d for d in dirnames if d != 'vendor']
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            rel = fn if rel_dir == '.' else rel_dir + '/' + fn
            if os.path.islink(p) or not os.path.isfile(p):
                raise ValueError('%s isn\'t a plain file' % rel)
            with open(p, 'rb') as f:
                out[rel] = f.read()
    return out


def differences(bundle, tree):
    """Sorted lines naming every file that differs between the two {path: bytes} maps."""
    out = []
    for rel in sorted(set(bundle) | set(tree)):
        if rel not in tree:
            out.append('engine/%s is in the GPL bundle but not in the source that is built' % rel)
        elif rel not in bundle:
            out.append('%s is in the source that is built but not in the GPL bundle' % rel)
        elif bundle[rel] != tree[rel]:
            out.append('%s differs from the GPL bundle\'s engine/%s' % (rel, rel))
    return out


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 2:
        print('usage: check_gpl_bundle.py <Encore-X.Y.Z-gpl-source.tar.gz> <gateway/engine-src>', file=sys.stderr)
        return 2
    bundle_path, root = argv
    if not os.path.isdir(root):
        print('check_gpl_bundle: %s isn\'t a folder' % root, file=sys.stderr)
        return 2
    try:
        bundle = bundle_files(bundle_path)
        tree = tree_files(root)
    except (OSError, ValueError, tarfile.TarError, EOFError) as e:
        print('check_gpl_bundle: can\'t read the inputs (%s)' % e, file=sys.stderr)
        return 2
    if not bundle:
        print('check_gpl_bundle: the GPL bundle has no engine/ folder', file=sys.stderr)
        return 1
    diff = differences(bundle, tree)
    if diff:
        for line in diff[:LIMIT]:
            print('check_gpl_bundle: %s' % line, file=sys.stderr)
        if len(diff) > LIMIT:
            print('check_gpl_bundle: and %d more' % (len(diff) - LIMIT), file=sys.stderr)
        print('check_gpl_bundle: the GPL bundle wasn\'t made from this source: make the release files again from the '
              'tagged tree', file=sys.stderr)
        return 1
    print('check_gpl_bundle: the GPL bundle\'s engine/ is exactly %s (%d files)' % (root, len(tree)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
