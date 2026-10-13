#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Encore Bridge installer: the languages other than English, made at build time from the bridge's dictionaries.

    python3 make_languages.py --iss EncoreBridge.iss --i18n <gateway/src/i18n> --inno-languages <Inno's Languages>
                              --out <file.iss>

Reads the installer's own texts (the unprefixed Name=English lines of [CustomMessages] in --iss) and, for each language
of the bridge (gateway/src/i18n/<code>.json, {"<English text>": "<translation>"}) that Inno Setup has a translation
of its own for (an .isl file in --inno-languages), writes to --out:
    [Languages]       Name: "<code>"; MessagesFile: "compiler:Languages\\<Name>.isl"
    [CustomMessages]  <code>.<Name>=<translation>
EncoreBridge.iss includes --out (ISCC /DLanguagesFile=<out>) after its English [CustomMessages] (an unprefixed
message listed later would replace the translations). A language without a dictionary or without an Inno Setup
translation is left out (its users get English), and so is any single text without a usable translation (an
unprefixed message is the fallback for every language): missing dictionaries give an English-only installer. Never
copy translations into EncoreBridge.iss by hand. The output is UTF-8 with a BOM, as Inno Setup reads it.
Exit code: 0 = written (the summary says which languages), 2 = usage error or unreadable --iss.
"""
import argparse
import json
import os
import re
import sys

# The bridge's language codes and Inno Setup's translation for each (Languages\<name>.isl).
INNO_NAMES = [
    ('es', 'Spanish'), ('pt', 'BrazilianPortuguese'), ('fr', 'French'), ('de', 'German'), ('it', 'Italian'),
    ('nl', 'Dutch'), ('pl', 'Polish'), ('ru', 'Russian'), ('tr', 'Turkish'), ('ja', 'Japanese'), ('ko', 'Korean'),
    ('zh_CN', 'ChineseSimplified'),
]

ARGS = re.compile(r'%[1-9]')


def english_messages(iss_path):
    """[(name, English text)] of the unprefixed [CustomMessages] lines, in file order."""
    out, section = [], None
    with open(iss_path, encoding='utf-8-sig') as f:
        for line in f:
            s = line.strip()
            if s.startswith('['):
                section = s.lower()
                continue
            if section != '[custommessages]' or not s or s.startswith((';', '#')) or '=' not in s:
                continue
            name, text = s.split('=', 1)
            name = name.strip()
            if '.' in name:
                continue
            out.append((name, text))
    return out


def usable(english, text):
    """A translation Inno Setup can carry: one line, not empty, the same %1..%9 arguments as the English text."""
    if not isinstance(text, str):
        return False
    t = text.strip()
    return bool(t) and '\r' not in t and '\n' not in t and sorted(ARGS.findall(t)) == sorted(ARGS.findall(english))


def build(messages, i18n_dir, inno_dir):
    """The include file's text and a summary line per language."""
    langs, lines, notes = [], [], []
    for code, inno in INNO_NAMES:
        path = os.path.join(i18n_dir, code + '.json')
        if not os.path.isfile(path):
            notes.append('%s: English (no dictionary)' % code)
            continue
        if not os.path.isfile(os.path.join(inno_dir, inno + '.isl')):
            notes.append('%s: English (Inno Setup has no %s.isl)' % (code, inno))
            continue
        try:
            with open(path, encoding='utf-8-sig') as f:
                d = json.load(f)
            if not isinstance(d, dict):
                raise ValueError('not a JSON object')
        except (OSError, ValueError) as e:
            notes.append('%s: English (dictionary unreadable: %s)' % (code, e))
            continue
        got = [(name, d[text].strip()) for name, text in messages if usable(text, d.get(text))]
        langs.append('Name: "%s"; MessagesFile: "compiler:Languages\\%s.isl"' % (code, inno))
        lines.extend('%s.%s=%s' % (code, name, text) for name, text in got)
        notes.append('%s: %d of %d texts' % (code, len(got), len(messages)))
    head = ['; Made by make_languages.py at build time from gateway\\src\\i18n\\*.json: never edit or commit it.']
    body = head + (['[Languages]'] + langs + ['', '[CustomMessages]'] + lines if langs else [])
    return '\r\n'.join(body) + '\r\n', notes, len(langs)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--iss', required=True)
    ap.add_argument('--i18n', required=True)
    ap.add_argument('--inno-languages', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    try:
        messages = english_messages(a.iss)
    except OSError as e:
        print('make_languages: %s' % e, file=sys.stderr)
        return 2
    if not messages:
        print('make_languages: no [CustomMessages] in %s' % a.iss, file=sys.stderr)
        return 2
    text, notes, n = build(messages, a.i18n, a.inno_languages)
    with open(a.out, 'w', encoding='utf-8-sig', newline='') as f:
        f.write(text)
    print('installer languages: English + %d (%s)' % (n, '; '.join(notes)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
