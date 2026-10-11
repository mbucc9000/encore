'use strict';
// the player.js changes of §3.5/§4.2/§4.3.4 (shuffle passthrough, play waits, queue 409, track keys, liked,
// quiet pollRemote, takeOver while the 429 gate is up).
const test = require('node:test');
const assert = require('node:assert/strict');
const { PcmClock } = require('../src/pcm');
const { Player } = require('../src/player');
const { EngineModel, fakeEngine, id22 } = require('./support/engine-model');
const { tmp, sleep } = require('./support/helpers');

function setup(webapi = null, modelOpts = {}) {
  const model = new EngineModel({ relink: true, ...modelOpts });
  const engine = fakeEngine(model);
  const clock = new PcmClock(require('path').join(require('os').tmpdir(), 'unused-gw3a.pcm'), { leadMs: 10000 });
  const pushes = [];
  const player = new Player({ engine, clock, bus: { push: (type, data) => pushes.push({ type, data }) }, webapi, dataDir: tmp('pl') });
  const waits = [];
  const orig = player.waitMeta.bind(player);
  player.waitMeta = (seq, ms) => { waits.push(ms); return orig(seq, ms); };
  return { model, engine, player, waits, pushes };
}

const CTX = 'spotify:playlist:' + id22('ctx');
const T = 'spotify:track:' + id22('row');

test('play: shuffle passes through as shuffle_context; 15 s wait for offset/shuffle plays, 8 s otherwise', async () => {
  const { model, player, waits } = setup();
  await player.play({ context_uri: CTX, offset_uri: T });
  assert.deepEqual(model.counts.plays[0], { uri: CTX, skip_to_uri: T, paused: true });
  assert.equal(waits.pop(), 15000);
  await player.play({ context_uri: CTX, shuffle: true });
  assert.equal(model.counts.plays[1].shuffle_context, true);
  assert.equal(waits.pop(), 15000);
  await player.play({ context_uri: CTX, shuffle: false });
  assert.equal(model.counts.plays[2].shuffle_context, false);
  assert.equal(waits.pop(), 8000);
  await player.play({ context_uri: CTX });
  assert.equal('shuffle_context' in model.counts.plays[3], false, 'omitted: the current mode');
  assert.equal(waits.pop(), 8000);
  await player.play({ uri: T, shuffle: true });
  assert.equal('shuffle_context' in model.counts.plays[4], false, 'a single track: no shuffle');
  assert.equal(waits.pop(), 8000);
});

test('queue: 409 not_active with nothing loaded, the engine call otherwise', async () => {
  const { model, engine, player } = setup();
  await assert.rejects(player.queue({ uri: T }), (e) => e.status === 409 && e.code === 'not_active' && e.message === 'Nothing is playing on Encore.');
  assert.equal(model.counts.queue.length, 0);
  await player.play({ context_uri: CTX, offset_uri: T });
  await engine.refresh();
  await player.queue({ uri: T });
  assert.equal(model.counts.queue.length, 1);
});

test('track objects: img, album_uri, artist_uris, context_track_uri; liked from noteLiked; the marker without liked', async () => {
  const { model, player, pushes } = setup();
  await player.play({ context_uri: CTX, offset_uri: T });
  await sleep(50);
  const t = player.snapshot().track;
  assert.equal(t.context_track_uri, T, 'the context entry the engine played');
  assert.notEqual(t.uri, T, 'uri is the relinked media id');
  assert.match(t.img, /^ab67616d00001e02[0-9a-f]{24}$/, 'img: the cover token');
  assert.ok(t.cover.startsWith('https://i.scdn.co/'), 'cover stays');
  assert.match(t.album_uri, /^spotify:album:/); assert.equal(t.artist_uris.length, 2);
  assert.equal('liked' in t, false, 'liked unknown: absent');
  const n = pushes.length;
  player.noteLiked(T, 1);
  assert.equal(player.st.track.liked, 1);
  await sleep(120);
  assert.ok(pushes.length > n && pushes[pushes.length - 1].data.track.liked === 1, 'published');
  player.noteLiked('spotify:track:' + id22('other'), 0);
  assert.equal(player.st.track.liked, 1, 'another song: unchanged');
  const m = player.trackMarker();
  assert.equal(m.context_track_uri, T); assert.equal(m.img, t.img); assert.equal('liked' in m, false);
  // a later metadata event for the same song keeps the known state
  model.emit('event', { type: 'metadata', data: model.status().json.track });
  await sleep(20);
  assert.equal(player.st.track.liked, 1);
  // remote track gets an img too
  player.remote = { device: { name: 'PC' }, is_playing: false, at: Date.now(), position_ms: 0,
    track: { uri: T, name: 'x', cover: 'https://i.scdn.co/image/ab67616d0000b273' + 'e'.repeat(24), album_uri: 'spotify:album:' + id22('a'), artist_uris: [] } };
  assert.equal(player.snapshot().remote.track.img, 'ab67616d0000b273' + 'e'.repeat(24));
});

test('pollRemote is quiet (gate up or window full); takeOver skips the Web API while blocked', async () => {
  let calls = 0;
  const webapi = { ready: true, blk: true, win: 0, blocked() { return this.blk; }, window() { return this.win; },
    playback: async () => { calls++; return null; }, transfer: async () => { calls++; }, lastPlayed: async () => { calls++; return null; } };
  const { model, player } = setup(webapi);
  player.lastPhone = Date.now();
  await player.pollRemote();
  assert.equal(calls, 0, 'blocked: no call');
  webapi.blk = false; webapi.win = 25;
  await player.pollRemote();
  assert.equal(calls, 0, 'window full: no call');
  webapi.win = 0;
  await player.pollRemote();
  assert.equal(calls, 1, 'otherwise it polls');
  // resume with the gate up: Encore's own last song, no Web API
  webapi.blk = true;
  player.lastOwn = { uri: T, context_uri: CTX, position: 1234 };
  calls = 0;
  await player.resume();
  assert.equal(calls, 0);
  const p = model.counts.plays.pop();
  assert.equal(p.uri, CTX); assert.equal(p.skip_to_uri, T); assert.equal(p.position, 1234);
});
