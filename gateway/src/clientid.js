'use strict';
// The Spotify Client ID without Notepad (DESIGN-WIZARD.md §3): the setup guide's paste box saves it, and it applies at
// once, with no restart.
//
// Where it is kept (§3.2): settings.env when the bridge has one (Windows, or any ENCORE_HOME), else
// <DATA_DIR>/settings.json ({"v":1,"spotify_client_id":"<32 hex>"}; Docker, a bare Linux run). config.js reads it in
// this order: the process environment (non-empty) > settings.env > data/settings.json > unset, and records which one
// won as cfg.spotifyClientIdSource ("env" | "settings" | "data" | null). An ID from the environment can't be changed
// here (the bridge would read the environment's again at its next start).
//
// settings.env is edited with the rules of §3.3 (the bridge is the only writer of SPOTIFY_CLIENT_ID lines): only
// SPOTIFY_CLIENT_ID lines change, every other byte of the file stays as it was, a BOM and each line's own terminator
// are kept, and the file is replaced with tmp + rename.
//
// The value is never logged, in any form (a Client ID is not a secret, but it identifies the owner's developer app).
const fs = require('fs');
const path = require('path');
const log = require('./log');
const { renameRetrySync } = require('./fsutil');

const KEY = 'SPOTIFY_CLIENT_ID';
const ID_RE = /^[0-9a-fA-F]{32}$/;
const DATA_FILE = 'settings.json';
const BOM = '﻿';

const fail = (status, code, message, extra) => Object.assign(new Error(message), { status, code }, extra);

// The user-visible messages (DESIGN-WIZARD.md §1.7)
const MSG = {
  bad_client_id: 'That isn\'t a Client ID. It is 32 letters (a-f) and digits, under Settings → Basic Information in your developer app. (Not the client secret.)',
  client_id_env: 'This bridge\'s Client ID is set in its environment (.env on Docker), so it can\'t be changed here. Change it there and restart the bridge.',
  client_id_replace: 'Changing the Client ID disconnects your Spotify account. You\'ll connect it again in the next step. Change it?',
};

// trimmed + lower-cased when it is a Client ID (32 hex characters), else null
function normalize(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return ID_RE.test(s) ? s.toLowerCase() : null;
}

const hint = (id) => (id ? '…' + String(id).slice(-4) : null);

// ------------------------------------------------------------------ settings.env (§3.3)
// [{content, eol}] per line; eol is '\r\n', '\n' or '' (the last line without one). A lone '\r' stays in the content.
function splitLines(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const n = text.indexOf('\n', i);
    if (n < 0) { out.push({ content: text.slice(i), eol: '' }); break; }
    const crlf = n > i && text[n - 1] === '\r';
    out.push({ content: text.slice(i, crlf ? n - 1 : n), eol: crlf ? '\r\n' : '\n' });
    i = n + 1;
  }
  return out;
}

// A line is active for KEY when (trimmed; the file's BOM is set aside first) it doesn't start with '#', contains '=',
// and the trimmed text before the first '=' is exactly KEY.
function activeFor(content, key) {
  const s = content.trim();
  if (!s || s.startsWith('#')) return false;
  const eq = s.indexOf('=');
  return eq >= 0 && s.slice(0, eq).trim() === key;
}

// Replace mode (the only one): every active SPOTIFY_CLIENT_ID line becomes SPOTIFY_CLIENT_ID=<value>; with none, the
// line is appended. platform picks the EOL of a file that has none yet (CRLF on Windows, LF elsewhere). A BOM is set
// aside and put back, so a BOM-only file counts as empty.
// -> { text, changed }
function editSettingsEnv(text, value, { platform = process.platform } = {}) {
  const src = String(text == null ? '' : text);
  const bom = src.startsWith(BOM) ? BOM : '';
  const body = bom ? src.slice(1) : src;
  const lines = splitLines(body);
  const active = [];
  lines.forEach((l, i) => { if (activeFor(l.content, KEY)) active.push(i); });
  const want = `${KEY}=${value}`;
  let out;
  if (active.length) {
    out = lines.map((l, i) => (active.includes(i) ? want : l.content) + l.eol).join('');
  } else {
    const firstEol = (lines.find((l) => l.eol) || {}).eol;
    const eol = firstEol || (platform === 'win32' ? '\r\n' : '\n');
    const endsWithEol = !body.length || body.endsWith('\n');
    out = body + (endsWithEol ? '' : eol) + want + eol;
  }
  out = bom + out;
  return { text: out, changed: out !== src };
}

// settings.env with the new value (replace mode). A missing file starts from <appDir>/settings.env.template when there
// is one, else empty. Written next to it as settings.env.tmp, then renamed over (retried on Windows).
function writeSettingsEnv(file, value, { template = null, platform = process.platform } = {}) {
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    text = '';
    if (template) { try { text = fs.readFileSync(template, 'utf8'); } catch (e2) { text = ''; } }
  }
  const r = editSettingsEnv(text, value, { platform });
  if (!r.changed && fs.existsSync(file)) return r;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, r.text, { mode: 0o600 });
  renameRetrySync(tmp, file, { platform });
  return r;
}

// ------------------------------------------------------------------ data/settings.json
// -> { id: '<32 hex>' | null, warning: string | null }. Only the spotify_client_id key is read.
function readDataClientId(dataDir) {
  if (!dataDir) return { id: null, warning: null };
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dataDir, DATA_FILE), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return { id: null, warning: null };
    return { id: null, warning: 'data/settings.json can\'t be read, so it is ignored' };
  }
  const v = j && typeof j === 'object' ? j.spotify_client_id : undefined;
  if (v == null || v === '') return { id: null, warning: null };
  const id = normalize(v);
  return id ? { id, warning: null } : { id: null, warning: 'data/settings.json: the saved Spotify Client ID isn\'t valid and is ignored' };
}

function writeDataClientId(dataDir, id, { platform = process.platform } = {}) {
  const file = path.join(dataDir, DATA_FILE);
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, spotify_client_id: id }), { mode: 0o600 });
  renameRetrySync(tmp, file, { platform });
}

// ------------------------------------------------------------------ POST /admin/api/wizard/client-id (§3.1)
// body {client_id, replace}. Throws {status, code, message}; returns {ok, source, hint, disconnected}.
// opts.showcase: the hint is left out while Showcase is on. opts.onDisconnect: the player forgets the account's
// remote state (http.js passes it, as the Disconnect button does).
function saveClientId({ cfg, webapi, body = {}, showcase = false, onDisconnect = null }) {
  const id = normalize(body.client_id);
  if (!id) throw fail(400, 'bad_client_id', MSG.bad_client_id);
  if (cfg.spotifyClientIdSource === 'env') throw fail(409, 'client_id_env', MSG.client_id_env);
  const current = (webapi && webapi.clientId) || cfg.spotifyClientId || '';
  const toSettings = !!cfg.settingsFile;
  const source = toSettings ? 'settings' : 'data';
  if (current && current.toLowerCase() === id) {
    return { ok: true, source: cfg.spotifyClientIdSource || source, hint: showcase ? null : hint(id), disconnected: false };
  }
  if (current && webapi && webapi.refreshToken && body.replace !== true) throw fail(409, 'client_id_replace', MSG.client_id_replace);
  try {
    if (toSettings) {
      const template = cfg.appDir ? path.join(cfg.appDir, 'settings.env.template') : null;
      writeSettingsEnv(cfg.settingsFile, id, { template });
    } else writeDataClientId(cfg.dataDir, id);
  } catch (e) {
    const code = /^[A-Z][A-Z0-9_]{1,20}$/.test(String(e.code || '')) ? e.code : 'error';
    log.warn(`the Spotify Client ID couldn't be saved (${code})`);
    throw fail(500, 'client_id_save', `The Client ID couldn't be saved (${code}).`);
  }
  log.info(`Spotify Client ID saved (${toSettings ? 'settings.env' : 'data/settings.json'})`);
  let disconnected = false;
  if (webapi && typeof webapi.setClientId === 'function') disconnected = !!webapi.setClientId(id).disconnected;
  else if (webapi) webapi.clientId = id;
  cfg.spotifyClientId = id;
  cfg.spotifyClientIdSource = source;
  if (disconnected) {
    log.info('Spotify account disconnected: the Client ID changed');
    if (onDisconnect) { try { onDisconnect(); } catch (e) { /* the player's own state */ } }
  }
  return { ok: true, source, hint: showcase ? null : hint(id), disconnected };
}

module.exports = { normalize, hint, editSettingsEnv, writeSettingsEnv, readDataClientId, writeDataClientId, saveClientId, splitLines,
  MSG, KEY, DATA_FILE };
