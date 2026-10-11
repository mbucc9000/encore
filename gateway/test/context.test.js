'use strict';
// Offline test of the "Playing from" context (player.js): every song's marker and the status carry the context of THAT
// song, never the song before's. A fake engine sends go-librespot's events in its real order (engine-src
// daemon/controls.go): a load sends will_play {context_uri, uri} when it starts, then metadata (an ApiTrack: NO
// context_uri; uri = the media, which relinking can change, context_track_uri = the entry it was asked as) when it
// lands, then playing / paused {context_uri, uri}; not_playing {context_uri, uri} names the song that ended, before
// the next one loads. A context play goes through go-librespot's load stages (loadContext, then loadCurrentTrack, then
// commitLoad): the context is claimed at once while the old stream plays on (/status: the OLD track with the NEW
// context), will_play lets the old stream go (/status: no track), and metadata brings the new one.
// Options: announce:false = an engine that names no song in its events (support/engine-model.js: no will_play,
// playing/paused without context_uri or uri); patched:false = no context_track_uri (stock go-librespot);
// resolveMs / loadMs = how long the two load stages take.
// Every check runs on its own (a failure doesn't hide the checks after it); the exit code is 1 if any failed.
//   node gateway/test/context.test.js   (PLAYER=path/to/player.js / PERSONAL=path/to/personal.js run it against other
//                                    copies; VERBOSE=1 shows logs)
const assert = require('assert');
const { EventEmitter } = require('events');
const { PcmClock } = require('../src/pcm');
const { Player } = require(process.env.PLAYER || '../src/player');
const { id22 } = require('./support/engine-model');
const { tmp } = require('./support/helpers');

const lines = [];
for (const k of ['log', 'warn', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { lines.push(a.map(String).join(' ')); if (process.env.VERBOSE) orig(...a); };
}
const out = (s) => process.stdout.write(s + '\n');
let nOk = 0;
const ok = (m) => { nOk++; out('ok   ' + m); };
const failed = [];
async function check(name, fn) {
  try { await fn(); } catch (e) { failed.push(name); out('FAIL ' + name + ': ' + String((e && e.stack) || e).split('\n').slice(0, 2).join(' | ')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIKED = 'spotify:user:testuser:collection';
const DW = 'spotify:playlist:' + id22('discover-weekly');
const MIX = 'spotify:playlist:' + id22('mix');
const JAM = 'spotify:list:jam-list:' + id22('jam');
const STATION = 'spotify:station:playlist:' + id22('station');
const tr = (tag) => 'spotify:track:' + id22(tag);
const LISTS = {
  [LIKED]: [tr('l1'), tr('l2'), tr('l3')],
  [DW]: [tr('d1'), tr('d2'), tr('d3')],
  [MIX]: [tr('m1'), tr('m2'), tr('m3')],
  [JAM]: [tr('j1'), tr('j2')],
};
const gid = (u) => 'spotify:track:' + id22('gid:' + u);

class RealOrderEngine extends EventEmitter {
  constructor({ clock, announce = true, relink = true, patched = true, resolveMs = 10, loadMs = 20 } = {}) {
    super();
    Object.assign(this, { clock, announce, relink, patched, resolveMs, loadMs });
    this.connected = true;
    this.status = null;
    this.cur = null;                 // { ctx, uri (the context entry; '' while the context resolves: no Track), paused }
    this.primary = null;             // the entry of the stream playing (/status's track): none from will_play to metadata
    this.plays = [];
  }
  ev(type, data) { this.emit('event', type, data); }
  track(uri) {
    return { uri: this.relink ? gid(uri) : uri, name: 'Song ' + uri.slice(-6), artist_names: ['Artist'], artist_uris: [],
      album_name: 'Album', album_uri: '', album_cover_url: null, duration: 200000, position: 0, format: 'OGG_VORBIS_320',
      bitrate: 320, ...(this.patched ? { context_track_uri: uri } : {}) };
  }
  named() { return this.announce ? { context_uri: this.cur.ctx, uri: this.cur.uri, play_origin: 'go-librespot' } : {}; }
  // a load (loadCurrentTrack): will_play now (the old stream is let go: no track in /status), metadata when it lands
  // (commitLoad), then (unpaused) playing
  load(ctx, uri, paused, { metaFirst = false } = {}) {
    this.cur = { ctx, uri, paused };
    this.primary = null;
    const wp = () => { if (this.announce) this.ev('will_play', { context_uri: ctx, uri, play_origin: 'go-librespot' }); };
    if (!metaFirst) wp();
    setTimeout(() => {
      this.primary = uri;
      this.ev('metadata', this.track(uri));
      if (metaFirst) wp();
      if (!paused) this.ev('playing', { ...this.named(), resume: false });
    }, this.loadMs);
  }
  // a context play (loadContext): the context is claimed at once and the old stream plays on while it resolves
  // (/status: the old track with the new context; Track is nil, so events name no song), then its song loads
  contextLoad(ctx, first, paused) {
    this.cur = { ctx, uri: '', paused };
    setTimeout(() => this.load(ctx, first, paused), this.resolveMs);
  }
  // another device took playback: the session is gone (/status: stopped, no track, no context)
  gone() { this.cur = null; this.primary = null; }
  async call(p, b = {}) {
    await new Promise((r) => setImmediate(r));
    if (p === '/player/play') {
      this.plays.push(b);
      // a skip_to_uri that isn't in the context starts it from the top (tracks.TrySeek -> moveStart); a track's context
      // is the track (context-resolve)
      const l = LISTS[b.uri];
      const first = b.skip_to_uri && (!l || l.includes(b.skip_to_uri)) ? b.skip_to_uri : l ? l[0] : b.uri;
      setTimeout(() => this.contextLoad(b.uri, first, !!b.paused), 5);
      return null;
    }
    // next / prev: the next / previous song of the context loads (go-librespot's next loads it playing even when
    // paused: player.js next; prev keeps the pause)
    if ((p === '/player/next' || p === '/player/prev') && this.cur) {
      const l = LISTS[this.cur.ctx] || [this.cur.uri];
      const i = l.indexOf(this.cur.uri);
      const to = p === '/player/next' ? l[i + 1] || l[0] : l[Math.max(0, i - 1)];
      setTimeout(() => this.load(this.cur.ctx, to, p === '/player/next' ? false : this.cur.paused), 5);
      return null;
    }
    if (p === '/player/pause' && this.cur) { this.cur.paused = true; setTimeout(() => this.ev('paused', this.named()), 5); return null; }
    if (p === '/player/resume' && this.cur) {
      this.cur.paused = false;
      setTimeout(() => this.ev('playing', { ...this.named(), resume: true }), 5);
      setTimeout(() => this.clock.emit('resume', this.clock.sample), 10);   // the new audio's first sample
      return null;
    }
    if (p === '/player/seek' && this.cur) { setTimeout(() => this.ev('seek', { ...this.named(), position: b.position || 0, duration: 200000 }), 5); return null; }
    if (p === '/player/output_delay') return { delay_ms: b.delay_ms, republished: false, position_ms: 0 };
    return null;
  }
  // /status: the context claimed, the track of the stream playing (the primary stream: daemon/player.go status)
  async refresh() {
    const c = this.cur;
    this.status = { username: 'testuser', device_id: 'dev1', context_uri: c ? c.ctx : null, stopped: !c, paused: !!(c && c.paused),
      buffering: false, shuffle_context: false, repeat_context: false, repeat_track: false, track: c && this.primary ? this.track(this.primary) : null };
    this.emit('status', this.status);
    return this.status;
  }
  // the song played to its end: not_playing (that song), then the next one of the same context loads
  naturalEnd() {
    const l = LISTS[this.cur.ctx];
    const next = l[l.indexOf(this.cur.uri) + 1];
    this.ev('not_playing', this.named());
    this.load(this.cur.ctx, next, false);
  }
  // the context ran out: not_playing (its last song), then autoplay's station loads as a new context
  // (advanceTo -> startAutoplay -> loadContext)
  autoplayEnd(station, first) {
    this.ev('not_playing', this.named());
    this.contextLoad(station, first, false);
  }
  // another device (the PC) plays something here
  foreignPlay(ctx, uri) {
    this.ev('command', { endpoint: 'play', from: 'pc' });
    this.contextLoad(ctx, uri || LISTS[ctx][0], false);
  }
}

function setup(opts = {}) {
  const clock = new PcmClock(require('path').join(require('os').tmpdir(), 'unused-ctx.pcm'), { leadMs: 10000 });
  const engine = new RealOrderEngine({ clock, ...opts });
  const pushes = [];
  const player = new Player({ engine, clock, bus: { push: (type, data) => pushes.push({ type, data }) }, webapi: null, dataDir: tmp('ctx') });
  return { clock, engine, player, pushes };
}

const lastM = (player) => { const m = player.markers.filter((x) => x.type === 'M'); return m.length ? m[m.length - 1].data : null; };
const mCount = (player) => player.markers.filter((x) => x.type === 'M').length;
// our play, then the audio coming back (the marker is pinned there)
async function play(player, body) { const r = await player.play(body); await sleep(60); return r; }

module.exports = { RealOrderEngine, setup, play, lastM, LISTS, LIKED, DW, MIX, STATION };
if (require.main === module) (async () => {
  // 1. Alex's report: a song from Liked Songs, then one from Discover Weekly, then one from a third playlist. Each
  //    song's marker (what Now Playing reads first) and the status say its own context at once, with no /status refresh.
  for (const opts of [{}, { patched: false }, { relink: false }]) {
    const tag = opts.patched === false ? ' (stock engine: no context_track_uri, relinked)' : opts.relink === false ? ' (no relinking)' : ' (relinked, context_track_uri)';
    await check('1' + tag, async () => {
      const { engine, player, pushes } = setup(opts);
      let refreshes = 0;
      const orig = engine.refresh.bind(engine);
      engine.refresh = () => { refreshes++; return orig(); };
      await play(player, { context_uri: LIKED, offset_uri: LISTS[LIKED][1] });
      let m = lastM(player);
      assert.strictEqual(m.context_track_uri || m.uri, opts.patched === false ? gid(LISTS[LIKED][1]) : LISTS[LIKED][1]);
      assert.strictEqual(m.context_uri, LIKED, 'the first song: Liked Songs');
      assert.strictEqual(player.snapshot().context_uri, LIKED);
      await play(player, { context_uri: DW, offset_uri: LISTS[DW][2] });
      m = lastM(player);
      assert.strictEqual(m.name, 'Song ' + LISTS[DW][2].slice(-6), 'the Discover Weekly song');
      assert.strictEqual(m.context_uri, DW, 'its marker says Discover Weekly, not Liked Songs (the one-behind bug)');
      assert.strictEqual(player.snapshot().context_uri, DW, 'the status too');
      await sleep(120);
      const pub = pushes.filter((x) => x.type === 'player').pop().data;
      assert.strictEqual(pub.context_uri, DW, 'the published state');
      assert.strictEqual(pub.track.name, m.name);
      await play(player, { context_uri: MIX, offset_uri: LISTS[MIX][0] });
      assert.strictEqual(lastM(player).context_uri, MIX, 'the third song: its own playlist, not Discover Weekly');
      assert.strictEqual(player.snapshot().context_uri, MIX);
      await play(player, { context_uri: LIKED });
      assert.strictEqual(lastM(player).context_uri, LIKED, 'back to Liked Songs (the header Play: no offset)');
      assert.strictEqual(refreshes, 0, 'none of it waited for the 10 s /status refresh');
      ok('play from Liked, then Discover Weekly, then a mix, then Liked: each marker + status = its own context at once' + tag);
    });
  }

  // 2. A one-song play: never the old context. The engine names the song itself as its context (context-resolve of a
  //    track uri: Now Playing shows nothing for spotify:track:); an engine that announces nothing: null.
  await check('2 one-song play', async () => {
    const { player } = setup();
    await play(player, { context_uri: DW, offset_uri: LISTS[DW][0] });
    assert.strictEqual(lastM(player).context_uri, DW);
    const one = tr('single');
    await play(player, { uri: one });
    assert.strictEqual(lastM(player).context_uri, one, 'the engine\'s own context for a one-song play (the track)');
    assert.strictEqual(player.snapshot().context_uri, one);
    const s2 = setup({ announce: false });
    await play(s2.player, { context_uri: DW, offset_uri: LISTS[DW][0] });
    assert.strictEqual(lastM(s2.player).context_uri, DW, 'no will_play: the play\'s own target');
    await play(s2.player, { uri: one });
    assert.strictEqual(lastM(s2.player).context_uri, null, 'one song, nothing announced: null (no "Playing from")');
    assert.strictEqual(s2.player.snapshot().context_uri, null);
    await play(s2.player, { context_uri: MIX, offset_uri: LISTS[MIX][1] });
    assert.strictEqual(lastM(s2.player).context_uri, MIX, 'and the next context play: the mix');
    ok('a one-song play after Discover Weekly: the engine\'s track context (or null when nothing is announced), never Discover Weekly');
  });

  // 3. A song ending into the next one of the same context keeps the context (marker pinned at the song boundary).
  for (const opts of [{}, { announce: false }]) {
    await check('3' + (opts.announce === false ? ' (no will_play)' : ''), async () => {
      const { engine, player } = setup(opts);
      await play(player, { context_uri: DW, offset_uri: LISTS[DW][0] });
      player.setAnchor(199000);                                          // the engine is at the song's end
      const n = mCount(player);
      const l0 = lines.length;
      engine.naturalEnd();
      await sleep(60);
      assert.strictEqual(mCount(player), n + 1, 'one new marker');
      const m = lastM(player);
      assert.strictEqual(m.name, 'Song ' + LISTS[DW][1].slice(-6));
      assert.strictEqual(m.context_uri, DW, 'the next song of Discover Weekly: still Discover Weekly');
      assert.strictEqual(player.snapshot().context_uri, DW);
      assert.ok(lines.slice(l0).some((l) => /track change at song end/.test(l)), 'the natural path (no generation cut)');
      ok('natural advance within the same context keeps it' + (opts.announce === false ? ' (no will_play)' : ''));
    });
  }

  // 4. Another device plays another context here: the cut's marker says the new context.
  await check('4 foreign play', async () => {
    const { engine, player } = setup();
    await play(player, { context_uri: LIKED, offset_uri: LISTS[LIKED][0] });
    await sleep(2600);                                                // past our own command's echo window
    const g = player.gen;
    engine.foreignPlay(MIX);
    await sleep(60);
    assert.strictEqual(player.gen, g + 1, 'a generation cut where it lands');
    assert.strictEqual(lastM(player).context_uri, MIX, 'its marker: the mix, not Liked Songs');
    assert.strictEqual(player.snapshot().context_uri, MIX);
    ok('another device\'s play of another context: the cut\'s marker + status carry the new context');
  });

  // 5. Event order. The engine always sends a load's will_play before its metadata (loadCurrentTrack emits it before
  //    submitting the load; one writer goroutine per client keeps the order), and a superseded load never commits.
  await check('5a superseded will_play', async () => {
    // a burst: will_play for a load that was superseded, then the one that lands (stock engine: relinked, no entry)
    const { engine, player } = setup({ patched: false });
    await play(player, { context_uri: LIKED, offset_uri: LISTS[LIKED][0] });
    await sleep(2600);
    engine.ev('command', { endpoint: 'play', from: 'pc' });
    engine.ev('will_play', { context_uri: LIKED, uri: LISTS[LIKED][2], play_origin: 'x' });   // superseded at once
    engine.foreignPlay(DW, LISTS[DW][1]);
    await sleep(60);
    assert.strictEqual(lastM(player).name, 'Song ' + LISTS[DW][1].slice(-6));
    assert.strictEqual(lastM(player).context_uri, DW, 'the newest will_play is the load that landed (relinked uri, no entry to match)');
    // the same song again from another context: the newer announcement for that uri wins
    engine.foreignPlay(MIX, LISTS[DW][1]);
    await sleep(60);
    assert.strictEqual(player.snapshot().context_uri, MIX, 'same song, now from the mix');
    ok('superseded will_play + relinked metadata: the context of the load that landed; the same song from another context: the new one');
  });
  await check('5b lost will_play', async () => {
    // a will_play lost on the way (not seen) during our own play: the play's target, not an older announcement
    const { engine, player } = setup();
    await play(player, { context_uri: LIKED, offset_uri: LISTS[LIKED][0] });
    engine.ev('will_play', { context_uri: LIKED, uri: LISTS[LIKED][1], play_origin: 'x' });   // an older load (never landed)
    engine.announce = false;
    await play(player, { context_uri: DW, offset_uri: LISTS[DW][0] });
    assert.strictEqual(lastM(player).context_uri, DW, 'our own play\'s target, not the stale Liked announcement');
    ok('our play with its will_play missing: the play\'s own context, never an announcement from before it');
  });
  await check('5c metadata before will_play', async () => {
    // metadata before will_play (the engine never does this): the marker can't know, but the status follows the
    // events that name the song (will_play, then playing) and the next song isn't misled by the late announcement
    const { engine, player } = setup();
    await play(player, { context_uri: LIKED, offset_uri: LISTS[LIKED][0] });
    await sleep(2600);
    engine.ev('command', { endpoint: 'play', from: 'pc' });
    engine.load(MIX, LISTS[MIX][0], false, { metaFirst: true });
    await sleep(60);
    assert.strictEqual(player.snapshot().context_uri, MIX, 'the status: the mix (playing names the song)');
    player.setAnchor(199000);
    engine.naturalEnd();
    await sleep(60);
    assert.strictEqual(lastM(player).context_uri, MIX, 'the next song: the mix');
    ok('metadata before will_play (hypothetical): the status is put right by the events that name the song');
  });

  // 6. Pause / seek / paused events naming the current song keep the status in step; a load in progress without a
  //    track (/status names the coming context) doesn't pair it with the old song.
  await check('6 events + /status', async () => {
    const { engine, player } = setup();
    await play(player, { context_uri: DW, offset_uri: LISTS[DW][0] });
    engine.ev('paused', { context_uri: JAM, uri: LISTS[DW][0], play_origin: 'x' });   // e.g. a Jam's list took over the song
    assert.strictEqual(player.snapshot().context_uri, JAM);
    engine.ev('seek', { context_uri: DW, uri: LISTS[DW][0], position: 1000, duration: 200000 });
    assert.strictEqual(player.snapshot().context_uri, DW);
    engine.ev('stopped', { play_origin: 'x' });                       // no uri: nothing to say about a context
    engine.ev('jam', { mode: 'on', origin: '', context_uri: JAM });   // nor this (jam.js's)
    assert.strictEqual(player.snapshot().context_uri, DW);
    engine.ev('paused', { context_uri: MIX, uri: '', play_origin: 'x' });   // a context resolving: no track yet
    assert.strictEqual(player.snapshot().context_uri, DW, 'no uri: ignored');
    player.pending = { gen: 999 };
    player.fromStatus({ track: null, context_uri: MIX, stopped: false, paused: true });
    assert.strictEqual(player.st.context_uri, DW, 'a load in progress without a track: the context stays with the song shown');
    player.pending = null;
    player.fromStatus({ track: { ...engine.track(LISTS[DW][0]) }, context_uri: DW, stopped: false, paused: false });
    assert.strictEqual(player.st.context_uri, DW, '/status with a track: taken as before');
    player.fromStatus({ track: { ...engine.track(LISTS[DW][0]) }, context_uri: null, stopped: false, paused: false });
    assert.strictEqual(player.st.context_uri, null, '... including none');
    ok('playing/paused/seek naming the song update the status; uri-less events and a trackless load\'s /status don\'t');
  });

  // 7. Jams: a jam-list context is carried like any other (the app hides the line in a Jam), and is still never
  //    remembered as a context (rule 8); the Jam's end restart (jam.js keepGoing: a one-song play) isn't the jam-list.
  await check('7 Jam', async () => {
    const { engine, player } = setup();
    await play(player, { context_uri: DW, offset_uri: LISTS[DW][0] });
    await sleep(2600);
    engine.ev('command', { endpoint: 'transfer', from: 'social-connect' });
    engine.load(JAM, LISTS[JAM][0], false);
    await sleep(60);
    assert.strictEqual(lastM(player).context_uri, JAM, 'the Jam\'s song: the jam-list (not Discover Weekly)');
    engine.ev('inactive', {});
    assert.strictEqual(player.lastOwn.uri, LISTS[JAM][0], 'the context entry, not the relinked media');
    assert.strictEqual(player.lastOwn.context_uri, null, 'a jam-list is kept as the song alone (rule 8)');
    engine.announce = false;
    await play(player, { uri: LISTS[JAM][0], position_ms: 0 });
    assert.strictEqual(lastM(player).context_uri, null, 'the end restart: no context, not the jam-list');
    ok('Jam: the jam-list goes with the Jam\'s songs, is never remembered (rule 8); the end restart carries no jam-list');
  });

  // 8. lastOwn (takeOver without an account) right after a context change: the new song with ITS context.
  await check('8 lastOwn', async () => {
    const { engine, player } = setup();
    await play(player, { context_uri: LIKED, offset_uri: LISTS[LIKED][0] });
    await play(player, { context_uri: DW, offset_uri: LISTS[DW][1] });
    engine.ev('inactive', {});
    assert.strictEqual(player.lastOwn.uri, LISTS[DW][1], 'the context entry, not the relinked media');
    assert.strictEqual(player.lastOwn.context_uri, DW, 'Discover Weekly, not Liked Songs');
    ok('another device taking playback right after a context change: lastOwn = the song + its own context');
  });

  // 9. Our own next / prev after a context change: the song they land on carries the context it is in.
  for (const how of ['next', 'prev']) {
    await check('9 own ' + how, async () => {
      const { player } = setup();
      await play(player, { context_uri: LIKED, offset_uri: LISTS[LIKED][1] });
      await play(player, { context_uri: DW, offset_uri: LISTS[DW][1] });
      const n = mCount(player);
      if (how === 'next') await player.next({}); else await player.prev({ played_ms: 1000 });
      await sleep(60);
      const m = lastM(player);
      assert.strictEqual(mCount(player), n + 1, 'one new marker');
      assert.strictEqual(m.name, 'Song ' + LISTS[DW][how === 'next' ? 2 : 0].slice(-6));
      assert.strictEqual(m.context_uri, DW, 'Discover Weekly, not Liked Songs');
      assert.strictEqual(player.snapshot().context_uri, DW);
      ok(`our own ${how} after Liked -> Discover Weekly: the song it lands on says Discover Weekly`);
    });
  }

  // 10. The context runs out and autoplay carries on (a natural advance, no command): not_playing for the last song,
  //     then the station loads as a new context. The station's first song says the station, not the playlist.
  await check('10 autoplay station', async () => {
    const { engine, player } = setup();
    await play(player, { context_uri: DW, offset_uri: LISTS[DW][2] });
    player.setAnchor(199000);                                          // the last song is at its end
    const n = mCount(player);
    const l0 = lines.length;
    engine.autoplayEnd(STATION, tr('radio1'));
    await sleep(80);
    assert.strictEqual(mCount(player), n + 1, 'one new marker');
    assert.strictEqual(lastM(player).name, 'Song ' + tr('radio1').slice(-6));
    assert.strictEqual(lastM(player).context_uri, STATION, 'the station, not Discover Weekly');
    assert.strictEqual(player.snapshot().context_uri, STATION);
    assert.ok(lines.slice(l0).some((l) => /track change at song end/.test(l)), 'the natural path (no generation cut)');
    ok('the context ran out into an autoplay station: its first song says the station');
  });

  // 11. Resume without an account (takeOver from lastOwn) after a context change: Liked, then Discover Weekly, another
  //     device takes playback, Encore resumes. (No relinking here; 11b is the relinked song.)
  await check('11 resume from lastOwn', async () => {
    const { engine, player } = setup({ relink: false });
    await play(player, { context_uri: LIKED, offset_uri: LISTS[LIKED][0] });
    await play(player, { context_uri: DW, offset_uri: LISTS[DW][1] });
    engine.gone();
    engine.ev('inactive', {});
    await sleep(20);
    assert.deepStrictEqual([player.lastOwn.uri, player.lastOwn.context_uri], [LISTS[DW][1], DW]);
    assert.strictEqual(player.st.track, null, 'the session is gone');
    await player.resume();
    await sleep(60);
    assert.deepStrictEqual(engine.plays[engine.plays.length - 1], { uri: DW, skip_to_uri: LISTS[DW][1], position: player.lastOwn.position, paused: true });
    assert.strictEqual(lastM(player).name, 'Song ' + LISTS[DW][1].slice(-6));
    assert.strictEqual(lastM(player).context_uri, DW, 'the resumed song: Discover Weekly');
    assert.strictEqual(player.snapshot().context_uri, DW);
    ok('a resume from lastOwn after Liked -> Discover Weekly: the resumed song says Discover Weekly');
  });

  // 11b. The same with Spotify relinking the song (0.10.3): the engine's uri is the media, which isn't an entry of the
  //      context, so lastOwn keeps the context entry (context_track_uri) and the resume's skip_to_uri finds it (before,
  //      the engine missed it and started Discover Weekly from its first song). Also after a gateway restart (last.json),
  //      and a one-song play (its context is the entry itself: the song alone, no skip_to_uri). A stock engine names no
  //      entry: the media uri, as before.
  await check('11b resume from lastOwn, relinked', async () => {
    const fs = require('fs');
    const path = require('path');
    const { engine, player } = setup();
    await play(player, { context_uri: LIKED, offset_uri: LISTS[LIKED][0] });
    await play(player, { context_uri: DW, offset_uri: LISTS[DW][1] });
    assert.deepStrictEqual([player.st.track.uri, player.st.track.context_track_uri], [gid(LISTS[DW][1]), LISTS[DW][1]], 'relinked: media uri + entry');
    engine.gone();
    engine.ev('inactive', {});
    await sleep(20);
    assert.deepStrictEqual([player.lastOwn.uri, player.lastOwn.context_uri], [LISTS[DW][1], DW], 'lastOwn: the entry, not the media');
    const saved = JSON.parse(fs.readFileSync(path.join(player.dataDir, 'last.json'), 'utf8'));
    assert.deepStrictEqual(saved, player.lastOwn, 'last.json the same');
    await player.resume();
    await sleep(60);
    assert.deepStrictEqual(engine.plays[engine.plays.length - 1], { uri: DW, skip_to_uri: LISTS[DW][1], position: player.lastOwn.position, paused: true });
    assert.strictEqual(lastM(player).name, 'Song ' + LISTS[DW][1].slice(-6), 'resumed on that song, not the first of Discover Weekly');
    assert.strictEqual(player.st.track.context_track_uri, LISTS[DW][1]);
    assert.strictEqual(player.snapshot().context_uri, DW);
    // a gateway restart: a new Player reads last.json and resumes the same song
    const clock2 = new PcmClock(require('path').join(require('os').tmpdir(), 'unused-ctx.pcm'), { leadMs: 10000 });
    const engine2 = new RealOrderEngine({ clock: clock2 });
    const p2 = new Player({ engine: engine2, clock: clock2, bus: { push() {} }, webapi: null, dataDir: player.dataDir });
    assert.deepStrictEqual(p2.lastOwn, saved, 'read back from last.json');
    await p2.resume();
    await sleep(60);
    assert.deepStrictEqual(engine2.plays[engine2.plays.length - 1], { uri: DW, skip_to_uri: LISTS[DW][1], position: saved.position, paused: true });
    assert.strictEqual(lastM(p2).name, 'Song ' + LISTS[DW][1].slice(-6), 'after a restart: the same song');
    // a one-song play, relinked: its context is the entry, so the resume plays the song alone
    const one = tr('single');
    await play(p2, { uri: one });
    assert.deepStrictEqual([p2.st.track.uri, p2.st.context_uri], [gid(one), one]);
    engine2.gone();
    engine2.ev('inactive', {});
    await sleep(20);
    assert.deepStrictEqual([p2.lastOwn.uri, p2.lastOwn.context_uri], [one, one]);
    await p2.resume();
    await sleep(60);
    assert.deepStrictEqual(engine2.plays[engine2.plays.length - 1], { uri: one, position: p2.lastOwn.position, paused: true }, 'the song alone');
    assert.strictEqual(lastM(p2).name, 'Song ' + one.slice(-6));
    // a stock engine (no context_track_uri): only the media uri is known, kept as before
    const s3 = setup({ patched: false });
    await play(s3.player, { context_uri: DW, offset_uri: LISTS[DW][1] });
    s3.engine.gone();
    s3.engine.ev('inactive', {});
    await sleep(20);
    assert.deepStrictEqual([s3.player.lastOwn.uri, s3.player.lastOwn.context_uri], [gid(LISTS[DW][1]), DW], 'stock engine: the media uri');
    ok('a resume from lastOwn after a relinked song: lastOwn keeps the context entry, the resume (and one after a restart) skips to it; a one-song play resumes alone');
  });

  // 12. /status polled all through our plays (jam.js and others refresh it): it shows the OLD track with the NEW
  //     context while the context resolves, then no track until the metadata. Each song still says its own context.
  await check('12 /status polled through the load stages', async () => {
    const { engine, player } = setup({ resolveMs: 40, loadMs: 40 });
    const seen = { oldWithNew: 0, noTrack: 0 };
    const orig = engine.refresh.bind(engine);
    engine.refresh = async () => {
      const s = await orig();
      if (s.track && s.context_uri && !LISTS[s.context_uri].includes(s.track.context_track_uri)) seen.oldWithNew++;
      if (!s.track && s.context_uri) seen.noTrack++;
      return s;
    };
    const poll = setInterval(() => engine.refresh(), 7);
    try {
      for (const [ctx, off] of [[LIKED, LISTS[LIKED][1]], [DW, LISTS[DW][2]], [MIX, LISTS[MIX][0]], [LIKED, LISTS[LIKED][0]]]) {
        await play(player, { context_uri: ctx, offset_uri: off });
        assert.strictEqual(lastM(player).name, 'Song ' + off.slice(-6));
        assert.strictEqual(lastM(player).context_uri, ctx, 'its marker: its own context');
        assert.strictEqual(player.snapshot().context_uri, ctx, 'the status: its own context');
      }
    } finally { clearInterval(poll); }
    assert.ok(seen.oldWithNew > 0 && seen.noTrack > 0, 'the polls saw both load stages ' + JSON.stringify(seen));
    ok('/status polled through Liked -> DW -> mix -> Liked (old track + new context, then no track): each song its own context');
  });

  // 13. Jump back in's play log (personal.js) on the same events, the player listening first (as main.js makes them):
  //     each play is logged under its own context; a Jam and an autoplay station are not logged.
  await check('13 personal play log', async () => {
    const { Personal } = require(process.env.PERSONAL || '../src/personal');
    const { engine, player } = setup();
    const alb = (u) => 'spotify:album:' + id22('album:' + u);
    const t0 = engine.track.bind(engine);
    engine.track = (u) => ({ ...t0(u), album_uri: alb(u) });
    const pers = new Personal({ cfg: { cacheDir: tmp('ctx-pers') }, webapi: {}, catalog: {}, engine, player, timing: { playedSaveMs: 50 } });
    await play(player, { context_uri: LIKED, offset_uri: LISTS[LIKED][0] });
    await play(player, { context_uri: DW, offset_uri: LISTS[DW][1] });
    const one = tr('single');
    await play(player, { uri: one });
    engine.ev('command', { endpoint: 'transfer', from: 'social-connect' });
    engine.contextLoad(JAM, LISTS[JAM][0], false);
    await sleep(80);
    engine.contextLoad(STATION, tr('radio2'), false);
    await sleep(80);
    assert.deepStrictEqual(pers.played.map((x) => [x.k, x.u]), [['album', alb(one)], ['playlist', DW], ['liked', LIKED]]);
    ok('Jump back in\'s log: Liked Songs, Discover Weekly, a one-song play\'s album; no Jam, no station');
  });

  // nothing logged names a context
  await check('no context uri in the log', async () => {
    const ctxs = [LIKED, DW, MIX, JAM, STATION];
    assert.ok(!lines.some((l) => ctxs.some((c) => l.includes(c))), 'no context uri in the log');
    ok('no context uri in any log line (' + lines.length + ' lines)');
  });
  if (failed.length) { out(`FAILED ${failed.length}: ${failed.join('; ')} (${nOk} ok)`); process.exit(1); }
  out(`ALL OK ${nOk} checks`);
  process.exit(0);
})().catch((e) => { out('FAIL ' + (e && e.stack || e)); process.exit(1); });
