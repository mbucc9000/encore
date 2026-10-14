'use strict';
// The bridge's languages (1.2.0, src/i18n.js): langOf (X-Encore-Lang, then Accept-Language, else English), t() with
// {name} values and the English fallback, tx() for the modules' finished English messages, GET /admin/i18n/<code>.json
// behind the admin page's own rules, and the messages http.js sends (errors, refusals, notices, the Spotify card, the
// sign-in page) in the request's language, English byte for byte when none is asked for. The dictionaries here are
// made up (a temporary folder, "«xx» …" texts), never the shipped ones.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const i18n = require('../src/i18n');
const { langOf, t, tx, CODES } = i18n;
const { WebApi } = require('../src/webapi');
const { UPDATE_MSG } = require('../src/update');
const { jamQr } = require('../src/http');
const { Showcase, deviceLabel, trimAdminStatus, trimReply } = require('../src/showcase');
const { wizardServer, cleanup, tmp, AUTH } = require('./support/wizard-server');

after(cleanup);

const DICT_DIR = tmp('encore-i18n-');
const DE = {
  'Use the admin page itself.': '«de» Benutze die Admin-Seite selbst.',
  'Unknown action.': '«de» Unbekannte Aktion.',
  'Spotify is limiting requests. Try again in {s} s.': '«de» Spotify bremst. In {s} s erneut versuchen.',
  'There is no Jam link right now.': '«de» Gerade gibt es keinen Jam-Link.',
  'Pairing only works on your home network. Connect this iPhone to the same Wi-Fi as your Encore Bridge and try again.': '«de» Koppeln nur zu Hause.',
  'Nobody was listening to your Jam on Encore, so it’s paused.': '«de» Niemand hat zugehört.',
  'Spotify started the Jam on {device}. Play it on Encore from there, or end it.': '«de» Jam auf {device} gestartet.',
  'Spotify sign-in expired: reconnect on the Encore Bridge admin page': '«de» Anmeldung abgelaufen.',
  'This address only finishes a Spotify sign-in started on the Encore Bridge admin page.': '«de» Nur für die Anmeldung.',
  'Hello {name}, {name}!': '«de» Hallo {name}, {name}!',
  'Use at least {n} characters.': '«de» Mindestens {n} Zeichen.',
  'Spotify refused ({status})': '«de» Spotify lehnte ab ({status})',
  'your computer': '«de» dein Computer',
  'another device': '«de» ein anderes Gerät',
  'Phone {n}': '«de» Telefon {n}',
};
const JA = { 'Use the admin page itself.': '«ja» 管理ページを使ってください。' };
fs.writeFileSync(path.join(DICT_DIR, 'de.json'), JSON.stringify(DE));
fs.writeFileSync(path.join(DICT_DIR, 'ja.json'), JSON.stringify(JA));
fs.writeFileSync(path.join(DICT_DIR, 'fr.json'), '{ not json');        // a broken file: English, never a crash
i18n._setDir(DICT_DIR);

const req = (headers) => ({ headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) });

test('langOf: X-Encore-Lang when it is a known code, else Accept-Language (by q), else English', () => {
  for (const c of [...CODES, 'en']) assert.equal(langOf(req({ 'X-Encore-Lang': c })), c);
  assert.deepEqual(CODES, ['es', 'pt', 'fr', 'de', 'it', 'nl', 'pl', 'ru', 'tr', 'ja', 'ko', 'zh_CN']);
  // the header wins over the browser's languages, English included
  assert.equal(langOf(req({ 'X-Encore-Lang': 'en', 'Accept-Language': 'de-DE' })), 'en');
  assert.equal(langOf(req({ 'X-Encore-Lang': 'ja', 'Accept-Language': 'de-DE' })), 'ja');
  // not a code the bridge has: the Accept-Language decides
  for (const bad of ['xx', 'DE', 'zh-CN', 'zh_cn', '', 'de ', 'en-US']) assert.equal(langOf(req({ 'X-Encore-Lang': bad, 'Accept-Language': 'it' })), 'it', bad);
  const al = {
    'es-ES': 'es', 'es-419': 'es', es: 'es', 'pt-BR': 'pt', 'pt-PT': 'pt', 'fr-CA': 'fr', 'de-AT': 'de', 'it-IT': 'it', 'nl-BE': 'nl',
    'pl-PL': 'pl', 'ru-RU': 'ru', 'tr-TR': 'tr', 'ja-JP': 'ja', 'ko-KR': 'ko', zh: 'zh_CN', 'zh-CN': 'zh_CN', 'zh-cn': 'zh_CN',
    'zh-Hans': 'zh_CN', 'zh-Hans-CN': 'zh_CN', 'zh-SG': 'zh_CN', 'zh_CN': 'zh_CN', 'zh-TW': 'en', 'zh-HK': 'en', 'zh-Hant': 'en',
    'zh-Hant-TW': 'en', 'en-US': 'en', en: 'en', 'sv-SE': 'en', '*': 'en', '': 'en',
    'en-US,en;q=0.9,de;q=0.8': 'en', 'sv-SE,de;q=0.8': 'de', 'fr;q=0.5, de;q=0.9': 'de', 'de;q=0, it;q=0.1': 'it',
    'zh-TW,zh;q=0.9,ja;q=0.8': 'zh_CN', 'zh-TW, ko;q=0.5': 'ko', 'da, pt-BR;q=0.7, es;q=0.7': 'pt', 'x;q=abc, nl': 'nl',
  };
  for (const [h, want] of Object.entries(al)) assert.equal(langOf(req({ 'Accept-Language': h })), want, h);
  assert.equal(langOf(req({})), 'en');
  assert.equal(langOf({}), 'en');
  assert.equal(langOf(null), 'en');
});

test('t: the English text unchanged without a language, {name} filled in, the translation when there is one, English otherwise', () => {
  const s = 'Use the admin page itself.';
  assert.equal(t('en', s), s);
  assert.equal(t(undefined, s), s);
  assert.equal(t('xx', s), s);
  assert.equal(t('de', s), DE[s]);
  assert.equal(t('ja', s), JA[s]);
  assert.equal(t('ko', s), s);                                   // no file for it: English
  assert.equal(t('fr', s), s);                                   // a broken file: English
  assert.equal(t('de', 'A text nobody translated.'), 'A text nobody translated.');
  // {name}: every one filled in, values never filled in again, $ patterns kept, unknown names left as they are
  assert.equal(t('en', 'Use at least {n} characters.', { n: 8 }), 'Use at least 8 characters.');
  assert.equal(t('de', 'Use at least {n} characters.', { n: 8 }), '«de» Mindestens 8 Zeichen.');
  assert.equal(t('en', 'Hello {name}, {name}!', { name: '{name} $& $1' }), 'Hello {name} $& $1, {name} $& $1!');
  assert.equal(t('en', 'Hi {who} and {other}.', { who: 'Sam' }), 'Hi Sam and {other}.');
  assert.equal(t('en', 'Hi {who}.', { who: undefined }), `Hi ${undefined}.`);       // as the template literal it replaced
  assert.equal(t('en', 'Send {"reset": true}.'), 'Send {"reset": true}.');
  assert.equal(t('en', 'Send {"reset": true}.', {}), 'Send {"reset": true}.');
});

test('tx: a finished English message in the language asked for: exact, then by its template; anything else as it is', () => {
  const english = t('en', 'Spotify is limiting requests. Try again in {s} s.', { s: 12 });
  assert.equal(english, 'Spotify is limiting requests. Try again in 12 s.');
  assert.equal(tx('en', english), english);
  assert.equal(tx('de', english), '«de» Spotify bremst. In 12 s erneut versuchen.');
  assert.equal(tx('ja', english), english);                     // no translation of it in ja
  assert.equal(tx('de', 'Unknown action.'), '«de» Unbekannte Aktion.');
  assert.equal(tx('de', 'Spotify GET /me: Something Spotify said'), 'Spotify GET /me: Something Spotify said');
  assert.equal(tx('xx', english), english);
  assert.equal(tx('de', undefined), undefined);
  assert.equal(tx('de', ''), '');
  // a name with the template's own words in it, and the same {name} twice
  const away = t('en', 'Spotify started the Jam on {device}. Play it on Encore from there, or end it.', { device: 'Sam’s iPad. Play it' });
  assert.equal(tx('de', away), '«de» Jam auf Sam’s iPad. Play it gestartet.');
  t('en', 'Hello {name}, {name}!', { name: 'x' });
  assert.equal(tx('de', 'Hello Ana, Ana!'), '«de» Hallo Ana, Ana!');
  assert.equal(tx('de', 'Hello Ana, Bo!'), 'Hello Ana, Bo!');
  // the modules' English is what it was before 1.2.0
  const w = new WebApi(tmp(), '', { fetch: async () => { throw new Error('no network in tests'); } });
  w.blockedUntil = Date.now() + 6500;
  assert.equal(w.gateError().message, 'Spotify is limiting requests. Try again in 7 s.');
  assert.equal(UPDATE_MSG.update_here_only('1.2.0'), 'To update, use the Encore Bridge icon on the PC: Encore Bridge 1.2.0 is available → Update now…');
  assert.equal(UPDATE_MSG.update_here_only(null), 'To update, use the Encore Bridge icon on the PC.');
});

test('GET /admin/i18n/<code>.json: the admin page\'s rules (password, or setup mode), known codes only, JSON with a short cache', async () => {
  let s = await wizardServer();
  try {
    let r = await s.call('/admin/i18n/de.json', { headers: AUTH });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
    assert.match(r.headers['cache-control'], /^private, max-age=\d{1,4}$/);
    assert.deepEqual(r.buf, fs.readFileSync(path.join(DICT_DIR, 'de.json')));
    r = await s.call('/admin/i18n/zh_CN.json', { headers: AUTH });        // a known code without a file yet: {}
    assert.equal(r.status, 200);
    assert.deepEqual(r.j, {});
    r = await s.call('/admin/i18n/en.json', { headers: AUTH });
    assert.equal(r.status, 200);
    assert.deepEqual(r.j, {});
    r = await s.call('/admin/i18n/fr.json', { headers: AUTH });          // not valid JSON on disk: never served as it is
    assert.deepEqual(r.j, {});
    for (const p of ['/admin/i18n/xx.json', '/admin/i18n/DE.json', '/admin/i18n/zh-CN.json', '/admin/i18n/de.js', '/admin/i18n/de',
      '/admin/i18n/', '/admin/i18n/..%2Fadmin.json', '/admin/i18n/de.json/x']) {
      r = await s.call(p, { headers: AUTH });
      assert.equal(r.status, 404, p);
      assert.equal(r.j.error.code, 'not_found', p);
    }
    r = await s.call('/admin/i18n/de.json');
    assert.equal(r.status, 401);
    r = await s.call('/admin/i18n/de.json', { headers: { ...AUTH, 'X-Forwarded-For': '203.0.113.10' } });
    assert.equal(r.status, 403);
    r = await s.inject('/admin/i18n/de.json', { headers: AUTH, peer: '203.0.113.9' });
    assert.equal(r.status, 403);
    assert.equal(r.j.error.code, 'forbidden');
  } finally { await s.close(); }
  // first-run setup: the setup card is in the page's language too, like the page itself (no password yet)
  s = await wizardServer({ adminPassword: '' });
  try {
    let r = await s.call('/admin/i18n/de.json');
    assert.equal(r.status, 200);
    assert.equal(r.j['Unknown action.'], DE['Unknown action.']);
    r = await s.call('/admin/i18n/xx.json');
    assert.equal(r.status, 404);
    r = await s.call('/admin/api/wizard');
    assert.equal(r.status, 503);                                 // the other admin routes stay closed
  } finally { await s.close(); }
});

test('admin messages: in the X-Encore-Lang / Accept-Language language, English byte for byte otherwise', async () => {
  const s = await wizardServer();
  try {
    const cross = (headers) => s.call('/admin/api/wizard', { method: 'POST', type: 'text/plain', body: '{}', headers: { ...AUTH, ...headers } });
    let r = await cross({});
    assert.equal(r.status, 403);
    assert.equal(r.text, '{"error":{"code":"cross_site","message":"Use the admin page itself."}}');
    r = await cross({ 'X-Encore-Lang': 'de' });
    assert.deepEqual(r.j.error, { code: 'cross_site', message: DE['Use the admin page itself.'] });
    r = await cross({ 'Accept-Language': 'ja-JP,ja;q=0.9' });
    assert.equal(r.j.error.message, JA['Use the admin page itself.']);
    r = await cross({ 'X-Encore-Lang': 'en', 'Accept-Language': 'de' });
    assert.equal(r.j.error.message, 'Use the admin page itself.');
    // a module's error (wizard.js, English inside the bridge) through http.js's catch
    const act = (headers) => s.call('/admin/api/wizard', { method: 'POST', body: { action: 'made-up' }, headers: { ...AUTH, ...headers } });
    r = await act({});
    assert.equal(r.status, 400);
    assert.equal(r.text, '{"error":{"code":"bad_request","message":"Unknown action."}}');
    r = await act({ 'X-Encore-Lang': 'de' });
    assert.deepEqual(r.j.error, { code: 'bad_request', message: DE['Unknown action.'] });
    r = await act({ 'X-Encore-Lang': 'ko' });                     // no dictionary: English
    assert.equal(r.j.error.message, 'Unknown action.');
    // the Spotify card's sign-in problem (webapi.js keeps it in English)
    const w = s.ctx.webapi;
    w.refreshToken = 'rt-made-up';
    w.user = { id: 'alexexample42', name: 'Alex Example' };
    const msg = 'Spotify sign-in expired: reconnect on the Encore Bridge admin page';
    w.authBroken = { at: 1, message: msg, tried: 1 };
    r = await s.call('/admin/api/status', { headers: AUTH });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.j.spotify.auth_broken.message, msg);
    r = await s.call('/admin/api/status', { headers: { ...AUTH, 'X-Encore-Lang': 'de' } });
    assert.equal(r.j.spotify.auth_broken.message, DE[msg]);
    assert.equal(w.authBroken.message, msg);                      // the bridge's own copy stays English
  } finally { await s.close(); }
});

test('the Jam access check\'s reason (Advanced): English inside the bridge, the page\'s language in the answer', async () => {
  const reason = t('en', 'Spotify refused ({status})', { status: 403 });
  assert.equal(reason, 'Spotify refused (403)');
  const s = await wizardServer({ ctx: { jam: { statusInfo: () => ({}), info: () => ({}), check: async () => ({ on: false, verdict: 'refused', reason, status: 403 }) } } });
  try {
    let r = await s.call('/admin/api/jam/check', { method: 'POST', body: {}, headers: AUTH });
    assert.equal(r.text, '{"on":false,"verdict":"refused","reason":"Spotify refused (403)","status":403}');
    r = await s.call('/admin/api/jam/check', { method: 'POST', body: {}, headers: { ...AUTH, 'X-Encore-Lang': 'de' } });
    assert.equal(r.text, '{"on":false,"verdict":"refused","reason":"«de» Spotify lehnte ab (403)","status":403}');
  } finally { await s.close(); }
});

test('phone messages: pairing, the Jam QR, errors from the modules and the event log\'s notices in the app\'s language', async () => {
  const notice = t('en', 'Spotify started the Jam on {device}. Play it on Encore from there, or end it.', { device: 'Sam’s iPad' });
  const events = [
    { id: 1, t: 1, type: 'notice', data: { code: 'jam_idle', message: 'Nobody was listening to your Jam on Encore, so it’s paused.' } },
    { id: 2, t: 2, type: 'notice', data: { code: 'jam_away', message: notice } },
    { id: 3, t: 3, type: 'engine_error', data: { message: 'Nobody was listening to your Jam on Encore, so it’s paused.' } },
  ];
  const before = JSON.stringify(events);
  const w = new WebApi(tmp(), '', { fetch: async () => { throw new Error('no network in tests'); } });
  const s = await wizardServer({ verify: () => ({ id: 'dev_made_up' }), ctx: {
    bus: { seq: 3, wait: async () => events },
    jam: { statusInfo: () => ({}), info: () => ({}), link: () => null },
    catalog: { counters: () => ({}), info: async () => ({}), search: async () => { w.blockedUntil = Date.now() + 4200; throw w.gateError(); } },
  } });
  try {
    // pairing from outside the home network
    const pair = (headers) => s.inject('/v1/pair', { method: 'POST', peer: '203.0.113.9', headers: { 'Content-Type': 'application/json', ...headers }, body: { code: '123456' } });
    let r = await pair({});
    assert.equal(r.status, 403);
    assert.equal(r.j.error.message, 'Pairing only works on your home network. Connect this iPhone to the same Wi-Fi as your Encore Bridge and try again.');
    r = await pair({ 'X-Encore-Lang': 'de' });
    assert.deepEqual(r.j.error, { code: 'pair_forbidden', message: DE['Pairing only works on your home network. Connect this iPhone to the same Wi-Fi as your Encore Bridge and try again.'] });
    // the Jam QR without a Jam
    r = await s.call('/v1/jam/qr');
    assert.equal(r.status, 404);
    assert.equal(r.text, '{"error":{"code":"no_jam","message":"There is no Jam link right now."}}');
    r = await s.call('/v1/jam/qr', { headers: { 'X-Encore-Lang': 'de' } });
    assert.equal(r.j.error.message, DE['There is no Jam link right now.']);
    // a module's message with a value in it (webapi.js's rate limit), through the catch
    r = await s.call('/v1/search?q=abc');
    assert.equal(r.status, 503);
    assert.equal(r.j.error.message, 'Spotify is limiting requests. Try again in 5 s.');
    assert.equal(r.j.error.retry_after, 5);
    r = await s.call('/v1/search?q=abc', { headers: { 'X-Encore-Lang': 'de' } });
    assert.deepEqual(r.j.error, { code: 'rate_limited', message: '«de» Spotify bremst. In 5 s erneut versuchen.', retry_after: 5 });
    // the event log: notices translated, everything else (and the bus itself) as it was
    r = await s.call('/v1/events?cursor=0&timeout=0');
    assert.equal(r.status, 200);
    assert.equal(JSON.stringify(r.j.events), before);
    r = await s.call('/v1/events?cursor=0&timeout=0', { headers: { 'X-Encore-Lang': 'de' } });
    assert.equal(r.j.events[0].data.message, DE['Nobody was listening to your Jam on Encore, so it’s paused.']);
    assert.equal(r.j.events[1].data.message, '«de» Jam auf Sam’s iPad gestartet.');
    assert.equal(r.j.events[1].data.code, 'jam_away');
    assert.equal(r.j.events[2].data.message, events[2].data.message);       // the engine's own text
    assert.equal(JSON.stringify(events), before);
  } finally { await s.close(); }
});

test('jamQr and the Spotify sign-in page (the browser\'s language) keep their English as it was', async () => {
  const fake = () => {
    const out = { status: 0, head: null, body: '' };
    return { out, writeHead(st, h) { out.status = st; out.head = h; }, end(b) { out.body = String(b || ''); } };
  };
  let res = fake();
  jamQr(res, null);
  assert.equal(res.out.body, '{"error":{"code":"no_jam","message":"There is no Jam link right now."}}');
  res = fake();
  jamQr(res, null, { lang: 'de' });
  assert.equal(JSON.parse(res.out.body).error.message, DE['There is no Jam link right now.']);
  const w = new WebApi(tmp(), '', { fetch: async () => { throw new Error('no network in tests'); } });
  const page = async (headers) => {
    const r = fake();
    await w.onCallback({ method: 'GET', url: '/elsewhere', headers: { host: '127.0.0.1:8888', ...headers } }, r);
    return r.out;
  };
  let p = await page({});
  assert.equal(p.status, 404);
  assert.match(p.body, /^<!doctype html><html lang="en"><head><meta charset="utf-8">/);
  assert.match(p.body, /<p>This address only finishes a Spotify sign-in started on the Encore Bridge admin page\.<\/p>/);
  p = await page({ 'accept-language': 'de-DE,de;q=0.9' });
  assert.match(p.body, /<html lang="de">/);
  assert.match(p.body, /<p>«de» Nur für die Anmeldung\.<\/p>/);
  p = await page({ 'accept-language': 'zh-CN' });
  assert.match(p.body, /<html lang="zh-CN">/);
  assert.equal(p.head['Content-Length'], Buffer.byteLength(p.body));
});

test('Showcase\'s own words on the admin page (another device\'s kind, "Phone n") in the page\'s language, English as it was', async () => {
  assert.equal(deviceLabel('Computer'), 'your computer');
  assert.equal(deviceLabel('Computer', 'de'), DE['your computer']);
  assert.equal(deviceLabel('Speaker', 'de'), 'a speaker');                 // not in the dictionary: English
  assert.equal(deviceLabel('Unknown', 'de'), DE['another device']);
  assert.equal(deviceLabel(undefined, 'xx'), 'another device');
  const st = { devices: [{ name: 'Made-up iPhone', id: 'dev_made_up_1' }, { name: 'Made-up iPod', id: 'dev_made_up_2' }],
    player: { status: 'paused', remote: { type: 'Computer', device: 'MADE-UP-PC', is_playing: false } } };
  assert.deepEqual(trimAdminStatus(st).devices, [{ name: 'Phone 1' }, { name: 'Phone 2' }]);
  assert.equal(trimAdminStatus(st).player.remote.device, 'your computer');
  const de = trimAdminStatus(st, 'de');
  assert.deepEqual(de.devices, [{ name: '«de» Telefon 1' }, { name: '«de» Telefon 2' }]);
  assert.equal(de.player.remote.device, DE['your computer']);
  assert.equal(trimReply({ gen: 1, state: st.player }, 'de').state.remote.device, DE['your computer']);
  // through the admin routes: GET /admin/api/status in the page's language while Showcase is on
  const sc = new Showcase();
  sc.set(true);
  const s = await wizardServer({ devices: st.devices, player: { snapshot: () => ({ ...st.player }) }, ctx: { showcase: sc } });
  try {
    let r = await s.call('/admin/api/status', { headers: AUTH });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.j.devices, [{ name: 'Phone 1' }, { name: 'Phone 2' }]);
    assert.equal(r.j.player.remote.device, 'your computer');
    r = await s.call('/admin/api/status', { headers: { ...AUTH, 'X-Encore-Lang': 'de' } });
    assert.deepEqual(r.j.devices, [{ name: '«de» Telefon 1' }, { name: '«de» Telefon 2' }]);
    assert.equal(r.j.player.remote.device, DE['your computer']);
  } finally { await s.close(); }
});

test('every t(…) in src/*.js has a literal English text (the l10n extractor finds them only so)', () => {
  const dir = path.join(__dirname, '..', 'src');
  const bad = [];
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && x !== 'i18n.js')) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      for (const m of line.matchAll(/(?<![\w$.])t\((?!\))/g)) {       // (log.js's t() is its clock)
        const rest = line.slice(m.index);
        n++;
        if (!/^t\(\s*[^,()]+,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*[,)]/.test(rest)) bad.push(`${f}:${i + 1}: ${rest.slice(0, 80)}`);
      }
    });
  }
  assert.ok(n > 100, `only ${n} t( calls found`);
  assert.deepEqual(bad, []);
});

test('the shipped dictionaries (src/i18n/*.json, when there are any) are known codes with only string values', () => {
  const dir = path.join(__dirname, '..', 'src', 'i18n');
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) { files = []; }
  for (const f of files) {
    assert.match(f, /^[a-zA-Z_]+\.json$/, f);
    assert.ok(CODES.includes(f.replace(/\.json$/, '')), `${f}: not one of the bridge's languages`);
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.equal(typeof j, 'object');
    assert.ok(j && !Array.isArray(j));
    for (const [k, v] of Object.entries(j)) {
      assert.equal(typeof v, 'string', `${f}: ${k}`);
      const ph = (s) => (s.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) || []).sort().join(' ');
      assert.equal(ph(v), ph(k), `${f}: the {names} of ${JSON.stringify(k).slice(0, 60)}`);
    }
  }
});

test('the prebuilt images\' texts (DESIGN-DOCKER-IMAGES.md §5.4): in the admin page and in all 12 shipped dictionaries, same {names}, tags and English names', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin.html'), 'utf8').replace(/\\'/g, '\'');
  // each text, and what stays in English in every language (file and setting names, the third-party labels)
  const texts = [
    ['Encore Bridge doesn\'t update itself on Docker. Update it on the computer that runs it, in the folder with your <code>compose.yaml</code>:',
      ['<code>compose.yaml</code>']],
    ['If your <code>.env</code> sets <code>ENCORE_TAG</code> to stay on one version, set it to <code>v{v}</code> first.',
      ['<code>.env</code>', '<code>ENCORE_TAG</code>', '<code>v{v}</code>']],
    ['<b>Dockge:</b> press <b>Update</b> on the Encore stack. <b>Portainer:</b> open the stack, choose <b>Update the stack</b> and turn on <b>Re-pull image and redeploy</b>.',
      ['Dockge', 'Portainer', '<b>Update</b>', '<b>Update the stack</b>', '<b>Re-pull image and redeploy</b>']],
    ['In Dockge or Portainer, look for "setup code" in the log of the <code>encore-gateway</code> container.',
      ['Dockge', 'Portainer', 'setup code', '<code>encore-gateway</code>']],
  ];
  const ph = (s) => (s.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) || []).sort().join(' ');
  const tags = (s) => (s.match(/<\/?[a-z]+>/g) || []).sort().join(' ');
  for (const [en] of texts) assert.ok(html.includes(`T('${en}')`), `admin.html: T('${en.slice(0, 60)}…')`);
  for (const code of CODES) {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', `${code}.json`), 'utf8'));
    for (const [en, keep] of texts) {
      const v = j[en];
      assert.equal(typeof v, 'string', `${code}: ${en.slice(0, 60)}`);
      assert.ok(v && v !== en, `${code}: translated: ${en.slice(0, 60)}`);
      assert.equal(ph(v), ph(en), `${code}: the {names} of ${en.slice(0, 60)}`);
      assert.equal(tags(v), tags(en), `${code}: the tags of ${en.slice(0, 60)}`);
      for (const k of keep) assert.ok(v.includes(k), `${code}: ${k} kept in ${v}`);
      assert.ok(!/sha-?256|checksum|\bhash/i.test(v), `${code}: no hash wording`);
    }
  }
});
