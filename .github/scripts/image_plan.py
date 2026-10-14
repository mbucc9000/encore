#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""What the Docker images workflow builds and how it tags it (DESIGN-DOCKER-IMAGES.md 4.4). Standard library only.

    image_plan.py --event release|workflow_dispatch --tag TAG --push true|false --sha SHA --repo OWNER/NAME
                  --config gateway/src/config.js --releases releases.ndjson

stdout: ref=, version=, tags=, push=, source_url=, gpl_url= (one per line, the GITHUB_OUTPUT format)
exit:   0 ok; 1 refused (one line "image_plan: <reason>" on stderr); 2 usage; 3 the release's files aren't all
        uploaded yet (the workflow looks again)

The releases file is what `gh api --paginate --jq '.[] | {tag_name, draft, prerelease, assets: [.assets[].name]}'`
writes: JSON objects one after the other. Only those four fields are read; nothing from a release's name or notes is
ever read or printed.

Push (always for a release event): the repository must be mbucc9000/encore, the tag vX.Y.Z (the update check's
grammar), equal to config.js's version and at least 1.3.0; its release must be a final one (not a draft, not a
pre-release) with Encore-X.Y.Z-source.tar.gz, Encore-X.Y.Z-gpl-source.tar.gz and encore-docker-compose.yaml uploaded.
Tags: vX.Y.Z; X.Y when it is the highest final X.Y.* release; latest when it is the highest final release.
No push (a manual dry run): a tag must still match the grammar and config.js; without a tag the run builds
config.js's version from the commit it runs on. No tags, no release URLs.
"""
import argparse
import json
import re
import sys

REPO = 'mbucc9000/encore'
MIN_VERSION = (1, 3, 0)
TAG_RE = re.compile(r'^v(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$')
VERSION_RE = re.compile(r"\bversion:\s*['\"]([^'\"]+)['\"]")   # the line tools/release (read_versions) reads
COMPOSE_ASSET = 'encore-docker-compose.yaml'
DOWNLOAD = 'https://github.com/%s/releases/download/%s/%s'
KEYS = ('ref', 'version', 'tags', 'push', 'source_url', 'gpl_url')


class PlanError(Exception):
    """A plan that can't be made. code: the exit code (1 refused, 3 not yet)."""
    code = 1


class Refused(PlanError):
    code = 1


class NotYet(PlanError):
    code = 3


def parse_tag(tag):
    """(X, Y, Z) for 'vX.Y.Z' in the update check's grammar, else None."""
    m = TAG_RE.match(tag or '')
    return tuple(int(g) for g in m.groups()) if m else None


def config_version(text):
    """The bridge's version from config.js's text (the first `version: '...'`), or None."""
    m = VERSION_RE.search(text or '')
    return m.group(1) if m else None


def read_releases(text):
    """The release objects from the releases file (concatenated JSON values, one per line or pretty-printed)."""
    dec = json.JSONDecoder()
    out, i, n = [], 0, len(text)
    while True:
        while i < n and text[i] in ' \t\r\n':
            i += 1
        if i >= n:
            return out
        obj, i = dec.raw_decode(text, i)
        if isinstance(obj, list):
            out.extend(obj)
        else:
            out.append(obj)


def _bool(v):
    if isinstance(v, bool):
        return v
    if v in ('true', 'false'):
        return v == 'true'
    raise ValueError('push must be true or false')


def _dotted(t):
    return '.'.join(str(x) for x in t)


def plan(event, tag, push, sha, repo, cfg_version, releases):
    """The plan as a dict of strings (KEYS), or raises Refused / NotYet.

    event 'release' | 'workflow_dispatch'; tag the git tag ('' for none); push True/False or 'true'/'false' (always
    on for a release); sha the commit the run is on; repo OWNER/NAME; cfg_version config.js's version (None when it
    has none); releases a list of {'tag_name', 'draft', 'prerelease', 'assets': [names]}.
    """
    if event not in ('release', 'workflow_dispatch'):
        raise ValueError('event must be release or workflow_dispatch')
    push = event == 'release' or _bool(push)
    tag = (tag or '').strip()
    if not cfg_version:
        raise Refused("config.js has no version: '...' line")

    if not push:
        if tag:
            v = parse_tag(tag)
            if not v:
                raise Refused('the tag must look like v1.3.0')
            if _dotted(v) != cfg_version:
                raise Refused('the tag says %s, config.js says %s' % (_dotted(v), cfg_version))
            ref = tag
        else:
            if not parse_tag('v' + cfg_version):
                raise Refused('config.js\'s version must look like 1.3.0 (it is %s)' % cfg_version)
            ref = sha
        return {'ref': ref, 'version': cfg_version, 'tags': '', 'push': 'false', 'source_url': '', 'gpl_url': ''}

    if repo != REPO:
        raise Refused('images are pushed from %s only (a fork changes the image names first)' % REPO)
    v = parse_tag(tag)
    if not v:
        raise Refused('pushing needs a tag like v1.3.0')
    version = _dotted(v)
    if version != cfg_version:
        raise Refused('the tag says %s, config.js says %s' % (version, cfg_version))
    if v < MIN_VERSION:
        raise Refused('the first version with images is %s' % _dotted(MIN_VERSION))

    rel = [r for r in releases if r.get('tag_name') == tag]
    if not rel:
        raise Refused('there is no release for %s' % tag)
    rel = rel[0]
    if rel.get('draft') or rel.get('prerelease'):
        raise Refused('the release for %s is a draft or a pre-release' % tag)
    need = ['Encore-%s-source.tar.gz' % version, 'Encore-%s-gpl-source.tar.gz' % version, COMPOSE_ASSET]
    names = set(rel.get('assets') or [])
    missing = [a for a in need if a not in names]
    if missing:
        raise NotYet('the release for %s has no %s yet' % (tag, ', '.join(missing)))

    finals = [parse_tag(r.get('tag_name')) for r in releases if not r.get('draft') and not r.get('prerelease')]
    finals = [f for f in finals if f] + [v]
    tags = [tag]
    if v == max(f for f in finals if f[:2] == v[:2]):
        tags.append('%d.%d' % v[:2])
    if v == max(finals):
        tags.append('latest')
    return {
        'ref': tag,
        'version': version,
        'tags': ' '.join(tags),
        'push': 'true',
        'source_url': DOWNLOAD % (REPO, tag, need[0]),
        'gpl_url': DOWNLOAD % (REPO, tag, need[1]),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--event', required=True, choices=('release', 'workflow_dispatch'))
    ap.add_argument('--tag', default='')
    ap.add_argument('--push', required=True, choices=('true', 'false'))
    ap.add_argument('--sha', required=True)
    ap.add_argument('--repo', required=True)
    ap.add_argument('--config', required=True, help='gateway/src/config.js')
    ap.add_argument('--releases', required=True, help='the releases file (see above)')
    a = ap.parse_args(argv)   # a usage error exits 2
    try:
        with open(a.config, encoding='utf-8') as f:
            cfg_version = config_version(f.read())
        with open(a.releases, encoding='utf-8') as f:
            releases = read_releases(f.read())
    except (OSError, ValueError) as e:
        print('image_plan: can\'t read the inputs (%s)' % e.__class__.__name__, file=sys.stderr)
        return 1
    try:
        p = plan(a.event, a.tag, a.push, a.sha, a.repo, cfg_version, releases)
    except PlanError as e:
        print('image_plan: %s' % e, file=sys.stderr)
        return e.code
    for k in KEYS:
        print('%s=%s' % (k, p[k]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
