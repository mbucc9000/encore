'use strict';
// image.js CoverWarm: the covers around the playing song, handed to the image cache's queue lane on a song change. A fake
// player (events, st.track, prevTrack, pending, lastPhone), a fake engine (/player/queue, /status) and a fake image
// cache that records warmQueue calls. No network, no ffmpeg.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { CoverWarm } = require('../src/image');
const { sleep } = require('./support/helpers');

const tok = (n) => require('crypto').createHash('sha1').update('cover' + n).digest('hex');      // 40 hex = an i.scdn.co token
const cover = (n) => 'https://i.scdn.co/image/' + tok(n);
const song = (n) => ({ uri: 'spotify:track:' + String(n).padStart(22, 'x'), name: 'Song ' + n, duration_ms: 200000, img: tok(n) });
const entry = (n, meta = true) => ({ uri: 'spotify:track:' + String(n).padStart(22, 'x'), uid: 'u' + n, provider: 'context',
  ...(meta ? { track: { name: 'Song ' + n, album_cover_url: cover(n) } } : {}) });

function setup({ queue, status, timing } = {}) {
  const player = new EventEmitter();
  Object.assign(player, { pending: null, st: { track: song(1) }, prevTrack: song(0), lastPhone: Date.now() });
  const engine = new EventEmitter();
  engine.calls = [];
  engine.queue = queue || { status: 200, json: { current: entry(1), next: [entry(2), entry(3), entry(4)], rev: 'r' } };
  engine.statusR = status || { status: 200, json: { track: {}, next_track: { album_cover_url: cover(2) } } };
  engine.get = async (p) => {
    engine.calls.push(p);
    await sleep(5);
    if (p === '/player/queue') { if (engine.queue instanceof Error) throw engine.queue; return typeof engine.queue === 'function' ? engine.queue() : engine.queue; }
    if (p === '/status') return engine.statusR;
    return { status: 404, json: null };
  };
  const images = { calls: [], warmQueue(t) { this.calls.push(t); return t.length * 2; } };
  const cw = new CoverWarm({ player, engine, images, timing: { debounceMs: 20, retryMs: 120, ...timing } });
  return { player, engine, images, cw };
}

test('a song change: next 2, the one before and the current one, in that order, once per window', async () => {
  const { player, engine, images, cw } = setup();
  player.emit('track', { natural: true });
  await sleep(80);
  assert.deepEqual(images.calls, [[tok(2), tok(3), tok(0), tok(1)]], 'next, next+1, previous, current');
  assert.deepEqual(engine.calls, ['/player/queue'], 'the engine\'s queue, nothing else');
  // a seek or resume of the same song (a generation, same window): nothing new
  player.emit('genStart', 5);
  await sleep(80);
  assert.equal(images.calls.length, 1, 'same song, same window: not handed over again');
  // the next song
  player.prevTrack = song(1);
  player.st.track = song(2);
  engine.queue = { status: 200, json: { current: entry(2), next: [entry(3), entry(4)], rev: 's' } };
  player.emit('track', { natural: false });
  await sleep(80);
  assert.deepEqual(images.calls[1], [tok(3), tok(4), tok(1), tok(2)]);
  assert.equal(cw.info().windows, 2);
});

test('our own command: nothing while it is pending, then once at its genStart; a burst of changes is one look', async () => {
  const { player, engine, images } = setup();
  player.pending = { gen: 2 };
  player.emit('gen', 2);
  player.emit('track', { natural: false });
  await sleep(80);
  assert.equal(engine.calls.length, 0, 'nothing asked while a generation starts');
  // three quick changes (a swipe burst) and the start: one look, for where it landed
  player.st.track = song(5);
  player.prevTrack = song(4);
  engine.queue = { status: 200, json: { current: entry(5), next: [entry(6), entry(7)], rev: 't' } };
  player.emit('track', {});
  player.emit('track', {});
  player.pending = null;
  player.emit('genStart', 2);
  await sleep(80);
  assert.deepEqual(engine.calls, ['/player/queue'], 'one look');
  assert.deepEqual(images.calls, [[tok(6), tok(7), tok(4), tok(5)]]);
});

test('a next entry without metadata yet: one more look later, then the full window; never a third', async () => {
  const { player, engine, images } = setup();
  engine.queue = { status: 200, json: { current: entry(1), next: [entry(2), entry(3, false)], rev: 'r' } };
  player.emit('track', {});
  await sleep(60);
  assert.deepEqual(images.calls, [[tok(2), tok(0), tok(1)]], 'what is known now');
  engine.queue = { status: 200, json: { current: entry(1), next: [entry(2), entry(3)], rev: 'r' } };
  await sleep(200);
  assert.equal(engine.calls.length, 2, 'one more look');
  assert.deepEqual(images.calls[1], [tok(2), tok(3), tok(0), tok(1)]);
  // still missing for good: the extra look is used up for this song
  engine.queue = { status: 200, json: { current: entry(1), next: [entry(2, false), entry(3, false)], rev: 'r' } };
  player.emit('genStart', 3);
  await sleep(300);
  assert.equal(engine.calls.length, 3, 'no second extra look for the same song');
});

test('an engine without /player/queue: its /status next_track, until the engine reconnects', async () => {
  const { player, engine, images, cw } = setup({ queue: { status: 404, json: null } });
  player.emit('track', {});
  await sleep(80);
  assert.deepEqual(engine.calls, ['/player/queue', '/status']);
  assert.deepEqual(images.calls, [[tok(2), tok(0), tok(1)]]);
  assert.equal(cw.info().queue_route, false);
  player.st.track = song(9);
  player.emit('track', {});
  await sleep(80);
  assert.deepEqual(engine.calls.slice(2), ['/status'], 'the queue route is not asked again');
  engine.emit('connected');
  engine.queue = { status: 200, json: { current: entry(9), next: [entry(10)], rev: 'r' } };
  player.st.track = song(10);
  player.emit('track', {});
  await sleep(80);
  assert.equal(engine.calls[engine.calls.length - 1], '/player/queue', 'asked again after a reconnect');
});

test('no phone around, no song, an engine that fails or moved on: nothing handed over, nothing thrown', async () => {
  const a = setup();
  a.player.lastPhone = Date.now() - 11 * 60000;
  a.player.emit('track', {});
  await sleep(60);
  assert.equal(a.engine.calls.length, 0, 'no phone in 10 min: not even a look');
  const b = setup();
  b.player.st.track = null;
  b.player.emit('track', {});
  await sleep(60);
  assert.equal(b.engine.calls.length, 0);
  const c = setup();
  c.engine.queue = new Error('down');
  c.engine.statusR = { status: 200, json: { next_track: null } };
  c.player.emit('track', {});
  await sleep(80);
  assert.deepEqual(c.images.calls, [[tok(0), tok(1)]], 'queue down, no next_track: previous + current only');
  assert.equal(c.cw.info().errors, 1);
  const d = setup();
  d.engine.queue = () => { d.player.st.track = song(7); return { status: 200, json: { next: [entry(8)] } }; };
  d.player.emit('track', {});
  await sleep(30);
  assert.equal(d.images.calls.length, 0, 'the song changed during the look: that window is not used');
  await sleep(80);
  assert.equal(d.images.calls.length, 0, 'the next change kicks its own look');
});
