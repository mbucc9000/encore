'use strict';
// The bridge's languages (1.2.0): the same 12 as the app, English as the fallback (it needs no file).
//   Dictionaries: src/i18n/<code>.json = {"<English text>": "<translation>"}, loaded once and cached. Placeholders are
//   {name}; HTML tags inside a string stay as they are.
//   langOf(req): X-Encore-Lang when it is a known code (the app and the admin page send it), else the browser's
//   Accept-Language, else 'en'.
//   t(lang, english, vars): the text in that language (English when there is no translation), {name} filled in.
//   Every English text is a literal at its call (the l10n extractor finds them there). The modules that make a message
//   without knowing who will read it (an error deep in catalog.js, a notice on the event bus) call t('en', …): the text
//   stays English inside the bridge (logs, tests, the event log) and tx(lang, message) translates the finished message
//   where it leaves for the phone or the admin page (http.js), filling the same {name} values back in.
//   GET /admin/i18n/<code>.json (http.js, the admin page's own rules): the dictionary for the page.
// Never translated: log lines, error codes, ids, and values the app or the tray launcher compares.
const fs = require('fs');
const path = require('path');
const log = require('./log');

const CODES = ['es', 'pt', 'fr', 'de', 'it', 'nl', 'pl', 'ru', 'tr', 'ja', 'ko', 'zh_CN'];
const KNOWN = new Set(CODES);
let dir = path.join(__dirname, 'i18n');      // (tests: _setDir)
const PH = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// ---------------------------------------------------------------- the language of a request
// One Accept-Language tag -> a code ('en' for English), or null when the bridge doesn't have it.
function codeOfTag(tag) {
  const s = String(tag || '').trim().toLowerCase().replace(/_/g, '-');
  const primary = s.split('-')[0];
  if (primary === 'en') return 'en';
  if (primary === 'zh') {
    // Simplified Chinese only: zh, zh-CN, zh-SG, zh-Hans(-…); never zh-TW / zh-HK / zh-Hant
    return s === 'zh' || s === 'zh-cn' || s === 'zh-sg' || s === 'zh-hans' || s.startsWith('zh-hans-') || s.startsWith('zh-cn-') || s.startsWith('zh-sg-')
      ? 'zh_CN' : null;
  }
  return KNOWN.has(primary) ? primary : null;
}

// Accept-Language -> the first language (by q, then order) the bridge has; 'en' when none
function fromAcceptLanguage(header) {
  const list = [];
  String(header || '').split(',').slice(0, 30).forEach((part, i) => {
    const [tag, ...params] = part.trim().split(';');
    if (!tag || tag === '*') return;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) q = Number(m[1]);
    }
    if (Number.isFinite(q) && q > 0) list.push({ tag, q, i });
  });
  list.sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of list) {
    const c = codeOfTag(tag);
    if (c) return c;
  }
  return 'en';
}

function langOf(req) {
  const h = (req && req.headers) || {};
  const own = h['x-encore-lang'];
  if (typeof own === 'string' && (own === 'en' || KNOWN.has(own))) return own;
  return fromAcceptLanguage(h['accept-language']);
}

// ---------------------------------------------------------------- the dictionaries (loaded once)
const dicts = new Map();       // code -> { map: {english: text}, body: Buffer (the file as served) }

function load(code) {
  if (dicts.has(code)) return dicts.get(code);
  let ent = { map: {}, body: Buffer.from('{}') };
  let raw = null;
  try { raw = fs.readFileSync(path.join(dir, `${code}.json`)); } catch (e) { raw = null; }     // not there: English
  if (raw) {
    try {
      const j = JSON.parse(raw.toString('utf8'));
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        const map = Object.create(null);
        for (const [k, v] of Object.entries(j)) if (typeof v === 'string' && v) map[k] = v;
        ent = { map, body: raw };
      } else log.warn(`i18n: ${code}.json isn't a JSON object: English is used`);
    } catch (e) { log.warn(`i18n: ${code}.json isn't valid JSON: English is used`); }
  }
  dicts.set(code, ent);
  return ent;
}

const isLang = (lang) => typeof lang === 'string' && KNOWN.has(lang);

function fill(s, vars) {
  return s.replace(PH, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

// ---------------------------------------------------------------- templates seen (for tx)
// Every English text with {name} that t() filled in this process: tx() reads the values back out of a finished
// message with it. The longest literal text is tried first (the most specific template wins).
const templates = new Map();   // english -> { rx, names, lit }
let sorted = null;

function note(key) {
  if (templates.has(key)) return;
  const names = [];
  let src = '';
  let last = 0;
  let lit = 0;
  key.replace(PH, (m, k, at) => {
    const part = key.slice(last, at);
    src += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\s\\S]*?)';
    lit += part.length;
    names.push(k);
    last = at + m.length;
    return m;
  });
  if (!names.length) return;                     // ({"reset": true} and the like: an exact text)
  const tail = key.slice(last);
  src += tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  lit += tail.length;
  templates.set(key, { rx: new RegExp(`^${src}$`), names, lit });
  sorted = null;
}

// t(lang, english, vars): the text in lang ('en', unknown or no translation: the English), {name} filled in from vars
function t(lang, key, vars) {
  let s = key;
  if (lang !== 'en' && isLang(lang)) {
    const v = load(lang).map[key];
    if (v) s = v;
  }
  if (vars && typeof key === 'string' && key.indexOf('{') !== -1) {
    note(key);
    s = fill(s, vars);
  }
  return s;
}

// tx(lang, message): a finished English message (made with t('en', …)) in lang. An exact text first, then the
// templates seen; anything else (a message from Spotify or the engine) stays as it is.
function tx(lang, msg) {
  if (typeof msg !== 'string' || !msg || lang === 'en' || !isLang(lang)) return msg;
  const map = load(lang).map;
  if (map[msg]) return map[msg];
  if (!templates.size) return msg;
  if (!sorted) sorted = [...templates.entries()].sort((a, b) => b[1].lit - a[1].lit);
  for (const [key, tp] of sorted) {
    const m = tp.rx.exec(msg);
    if (!m) continue;
    const vars = {};
    let same = true;
    tp.names.forEach((n, i) => {
      if (Object.prototype.hasOwnProperty.call(vars, n) && vars[n] !== m[i + 1]) same = false;
      vars[n] = m[i + 1];
    });
    if (!same) continue;
    return map[key] ? fill(map[key], vars) : msg;
  }
  return msg;
}

// ---------------------------------------------------------------- GET /admin/i18n/<code>.json
const ROUTE = /^\/admin\/i18n\/([A-Za-z_]{2,5})\.json$/;

// Answers the route and returns true; false when the path isn't the route (http.js checks the admin rules first).
// A known code: its dictionary ({} for English, or while a file is missing); anything else: 404.
function serveDict(res, p) {
  const m = ROUTE.exec(p);
  if (!m) return false;
  const code = m[1];
  if (code !== 'en' && !isLang(code)) {
    const body = JSON.stringify({ error: { code: 'not_found' } });
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  const body = code === 'en' ? Buffer.from('{}') : load(code).body;
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=300', 'Content-Length': body.length });
  res.end(body);
  return true;
}

// tests: read the dictionaries from another folder from now on (the loaded ones are forgotten)
function _setDir(d) {
  dir = d;
  dicts.clear();
}

module.exports = { CODES, langOf, fromAcceptLanguage, codeOfTag, t, tx, serveDict, ROUTE, _setDir };
