'use strict';
// Player: phone commands -> go-librespot, plus the stream timeline.
//
// Generations: every discontinuity starts a new generation; the phone drops its buffer and opens /v1/stream?gen=N.
//  - Our own commands (play, seek, skip, resume) get exact boundaries: pause the engine, let the pipe drain (that
//    audio is discarded), run the command while paused, then resume. The generation starts on the first sample of the
//    new audio: nothing of it is lost, nothing old leaks in, and the engine never free-runs while we discard.
//  - Jumps made by other devices (PC, Jam guests) can't be paused around. Their generation starts where the change
//    lands in the stream (give or take what's still in the kernel pipe, <0.4 s).
//
// Markers: 'M' (track metadata) and 'P' (position anchor) are pinned to a sample, and the stream sends each one
// right before the AAC frame that contains it, so the phone's UI changes exactly when the audio does.
//
// Heard reports: the phone tells us which frame it is playing (or stalled at). The PCM clock follows it, so the engine
// never runs more than the lead ahead of the listener, and the patched engine is told how far its decoder is ahead
// (/player/output_delay), so the Spotify app shows what the listener actually hears.
//
// Jams (DESIGN-4b.md §5.6; jam.js owns the state): every check reads `this.jam && this.jam.real()`. A pause never
// steps the engine back a song (that would move the whole Jam back), a jam-list is never remembered as a context,
// takeOver never quietly leaves a Jam, and with the flag hostJump 'cut' the host's jumps skip the pause around them.
// Foreign detection (always): the engine's `command` events (patch 3) say when another device moved playback.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const log = require('./log');
const { tokenFor } = require('./image');
const { deviceType } = require('./showcase');

const HEARD_STALE_MS = 20000;        // no report for this long: back to real-time pacing
const FOREIGN_CMD_MS = 2000;         // events this soon after another device's moving command are that device's (rule 2)
const SKIP_CMD_MAX_MS = 15000;       // a song change this soon after a skip command is a skip, even at a song's end (rule 3)
const MOVING = new Set(['play', 'skip_next', 'skip_prev', 'seek_to', 'pause', 'resume']);   // + a transfer that doesn't continue
const SKIPPING = new Set(['play', 'skip_next', 'skip_prev']);
const JAM_LIST = 'spotify:list:jam-list:';
// a Jam, never a play: its invite as a URI or as an open.spotify.com link (any intl- segment, any case), or its list
const JAM_PLAY = /^\s*(?:spotify:(?:socialsession|list:jam-list)(?::|$)|(?:https?:\/\/)?(?:[\w-]+\.)*spotify\.com\/(?:intl-[\w-]+\/)?socialsession\/)/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Spotify "relinks" tracks: the engine's events and its /status can name the same song by different ids (the
// playable one vs the album's). Compare songs by name + length instead.
const songKey = (t) => t ? `${t.name}|${Math.round((t.duration_ms || 0) / 1000)}` : '';
// Keys a track object gained in 0.5 (older apps ignore them; `cover` stays): the album cover's image token, album and
// artist uris, and the context entry the engine played (Encore patch 2; absent when unknown).
const trackExtra = (d) => ({ img: tokenFor(d.album_cover_url) || undefined, album_uri: d.album_uri || undefined,
  artist_uris: Array.isArray(d.artist_uris) ? d.artist_uris : undefined, context_track_uri: d.context_track_uri || undefined });

class Player extends EventEmitter {
  constructor({ engine, clock, bus, webapi, dataDir }) {
    super();
    Object.assign(this, { engine, clock, bus, webapi, dataDir });
    this.remote = null;
    this.lastOwn = null;
    try { this.lastOwn = JSON.parse(fs.readFileSync(path.join(dataDir, 'last.json'), 'utf8')); } catch (e) { /* none yet */ }
    this.gen = 1;
    this.genInfo = new Map([[1, { sample: 0, how: 'start' }]]);
    this.pending = null;
    this.cmdLock = Promise.resolve();
    this.ownUntil = 0;              // engine events before this time are echoes of our own commands
    this.metaSeq = 0;
    this.markers = [];
    this.markerSeq = 0;
    this.heard = null;              // the phone's last playhead report for this generation
    this.connectSync = null;        // engine has /player/output_delay: null = not known yet, false = stock engine
    this.connectSent = null;        // last output_delay the engine took
    this.likedMap = new Map();      // uri -> 1/0: Liked Songs membership the catalog found out (for st.track.liked)
    this.jam = null;                // jam.js (main.js sets it)
    this.lastMovingCmd = 0;         // another device's last command that moved playback (engine `command` events)
    this.lastSkipCmd = 0;           // ... that changes the song
    this.lastMetaAt = 0;
    this.cut = null;                // a 'cut' jump of ours in flight: { reason, kind: 'meta'|'seek'|'any', until }
    this.announced = [];            // songs the engine announced since the last metadata: [{ uri, ctx, seq }] (songContext)
    this.annSeq = 0;
    this.loadCtx = null;            // our own load's target while it runs: { ctx, seq } (loadPaused)
    this.st = { status: 'stopped', track: null, context_uri: null, shuffle: false, repeat_context: false, repeat_track: false,
      active: false, pos: { ms: 0, at: Date.now(), speed: 0 } };
    this.setMaxListeners(100);
    engine.on('event', (type, d) => this.onEngine(type, d));
    engine.on('status', (s) => this.fromStatus(s));
    engine.on('connected', () => this.engineConnected());
    engine.on('disconnected', () => this.publish());
    clock.on('resume', (sample) => this.onAudioResume(sample));
    setInterval(() => { if (this.st.status === 'playing' && !this.pending) engine.refresh(); }, 10000).unref();
    setInterval(() => this.pollRemote(), 6000).unref();
    setInterval(() => { if (this.heard && Date.now() - this.heard.at > HEARD_STALE_MS) this.clearHeard(); }, 2000).unref();
    // While the phone is stalled the listener stands still but the position the engine published runs on, and D doesn't
    // change: always send (the engine only republishes once it is 750 ms off).
    setInterval(() => { if (this.st.status === 'playing') this.syncConnect(!!(this.heard && this.heard.stalled)); }, 5000).unref();
  }

  // ------------------------------------------------------------------ generations
  begin(reason) {
    if (this.pending) {
      const old = this.pending;
      clearTimeout(old.fallback);
      this.genInfo.set(old.gen, null);
      this.emit('genAbandon', old.gen);
    }
    this.gen += 1;
    const p = { gen: this.gen, t: Date.now(), reason, armed: false };
    this.pending = p;
    this.clearHeard();
    this.clock.beginDiscard();
    this.bus.push('gen', { gen: p.gen, reason });
    this.emit('gen', p.gen);
    this.publish();
    return p;
  }

  // The PCM clock saw real audio start after silence (exact sample).
  onAudioResume(sample) {
    const p = this.pending;
    if (p) { if (p.armed && !this.clock.discarding) this.resolve(p, sample, 'audio'); return; }
    this.lastAudioStart = { sample, real: this.clock.stats.real, t: Date.now() };
    if (this.foreignResumeAt && Date.now() - this.foreignResumeAt < 4000) this.foreignResumed();
  }

  // Another device pressed play: start a generation exactly where the audio comes back, so the phone joins there.
  // (The 'playing' event and the first audio can arrive in either order.)
  foreignResumed() {
    const a = this.lastAudioStart;
    this.foreignResumeAt = 0;
    if (a && Date.now() - a.t < 4000) this.externalGen('resume', this.anchorPosAt(a.real), a.sample, a.real);
  }

  anchorPosAt(real) {
    const an = this.anchor;
    return an && this.st.track && an.key === songKey(this.st.track) ? an.pos + (real - an.real) / 44.1 : this.posNow();
  }

  resolve(p, sample, how) {
    if (this.pending !== p) return;
    clearTimeout(p.fallback);
    this.pending = null;
    this.setGenInfo(p.gen, { sample, how, ms: Date.now() - p.t, reason: p.reason });
    log.info(`gen ${p.gen} (${p.reason}) starts at sample ${sample}: ${how}, ${Date.now() - p.t} ms after the command`);
    if (this.st.track) this.addMarker(sample, 'M', this.trackMarker());
    this.addMarker(sample, 'P', { position_ms: Math.round(p.positionMs || 0) });
    if (how === 'audio') this.setAnchor(p.positionMs, this.clock.stats.real);     // fired right before the first new sample
    this.emit('genStart', p.gen);
    this.publish();
    this.syncConnect(true);
  }

  setGenInfo(gen, info) {
    this.genInfo.set(gen, info);
    if (this.genInfo.size > 60) this.genInfo.delete(this.genInfo.keys().next().value);
  }

  // A jump made by another device: cut a generation where it lands in the stream. (own: a 'cut' jump of ours, rule 14)
  externalGen(reason, positionMs, sample = this.boundary(), real = null, own = false) {
    this.gen += 1;
    const g = this.gen;
    this.setGenInfo(g, { sample, how: 'external', ms: 0, reason });
    if (this.st.track) this.addMarker(sample, 'M', this.trackMarker());
    this.addMarker(sample, 'P', { position_ms: Math.round(positionMs || 0) });
    if (real != null) this.setAnchor(positionMs, real);
    this.clearHeard();
    this.clock.anchorAt(sample);         // the lead restarts at the jump, so the phone's buffer refills in a burst
    log.info(`gen ${g} (${reason}${own ? ', our jump without a pause' : ' from another device'}) at sample ${sample}`);
    this.bus.push('gen', { gen: g, reason });
    this.emit('gen', g);
    this.emit('genStart', g);
    this.syncConnect(true);
  }

  // Where audio the engine produces right now will land in the stream: after what we've queued, what the reader holds
  // but hasn't delivered yet, and the (full) pipe (pcm.js inFlightSamples; R3c: the held part matters on Windows, where
  // one read of the named pipe can hold 64 KB).
  inFlight() {
    const c = this.clock;
    return c.inFlightSamples != null ? c.inFlightSamples : c.queuedSamples + (c.readerPaused ? c.pipeSamples : 0);
  }

  boundary() { return this.clock.sample + this.inFlight(); }

  // genInfo: object = started at that sample, null = abandoned (superseded before it started), missing = pending
  waitGenStart(gen, ms) {
    return new Promise((resolve) => {
      const v = this.genInfo.get(gen);
      if (v || v === null) return resolve(v);
      const on = (g) => { if (g === gen) { cleanup(); resolve(this.genInfo.get(gen) || null); } };
      const cleanup = () => { clearTimeout(timer); this.off('genStart', on); this.off('genAbandon', on); };
      const timer = setTimeout(() => { cleanup(); resolve(this.genInfo.get(gen) || null); }, ms);
      this.on('genStart', on);
      this.on('genAbandon', on);
    });
  }

  async waitMeta(seq, ms) {
    const t0 = Date.now();
    while (this.metaSeq <= seq && Date.now() - t0 < ms) await sleep(25);
    return this.metaSeq > seq;
  }

  noteTrack(t) {
    if (!t || !t.uri) return;
    if (!this.ids) this.ids = new Map();
    this.ids.set(t.uri, songKey(t));
    if (this.ids.size > 300) this.ids.delete(this.ids.keys().next().value);
  }
  // does this phone-supplied uri name the same song as t?
  isSong(uri, t) { return !!(uri && t) && (uri === t.uri || (this.ids && this.ids.get(uri) === songKey(t))); }

  // ------------------------------------------------------------------ markers
  addMarker(sample, type, data) {
    this.markers.push({ id: ++this.markerSeq, sample, type, data });
    if (this.markers.length > 400) this.markers.splice(0, this.markers.length - 400);
  }

  markersAfter(id) {
    let i = this.markers.length;
    while (i > 0 && this.markers[i - 1].id > id) i--;
    return this.markers.slice(i);
  }

  trackMarker() {
    const t = this.st.track || {};
    return { uri: t.uri, name: t.name, artists: t.artists, album: t.album, cover: t.cover, duration_ms: t.duration_ms, context_uri: this.st.context_uri,
      img: t.img, album_uri: t.album_uri, artist_uris: t.artist_uris, context_track_uri: t.context_track_uri };
  }

  // ------------------------------------------------------------------ the context of each song
  // go-librespot's 'metadata' event (the new song) carries no context_uri. The events around it do, each for the song
  // it names: will_play (a load starting, always before its metadata), playing, paused, not_playing, seek. A song's
  // context is the one announced for that song, so its marker and the status never carry the song before's context.
  announce(uri, ctx) {
    this.announced.push({ uri, ctx, seq: ++this.annSeq });
    if (this.announced.length > 8) this.announced.shift();
  }

  // For a metadata event: the context announced for its song (by uri, or by the context entry when Spotify relinked
  // it); else the newest announcement (the engine's newest will_play is the load that commits: older ones were
  // superseded), but during our own load only one made after we started it; else our load's target; else the
  // current one (a song that ended into the next of the same context, from an engine that announces nothing).
  songContext(d) {
    const a = this.announced;
    this.announced = [];
    if (d.context_uri) return d.context_uri;
    for (let i = a.length - 1; i >= 0; i--) if (a[i].uri === d.uri || (d.context_track_uri && a[i].uri === d.context_track_uri)) return a[i].ctx;
    const own = this.loadCtx;
    const last = a[a.length - 1];
    if (last && (!own || last.seq > own.seq)) return last.ctx;
    if (own) return own.ctx;
    return this.st.context_uri;
  }

  // playing / paused / not_playing / seek name the song the engine is on ({context_uri, uri}; uri is empty while a
  // context resolves, when the engine has no track): the current song's context, or an announcement for the next one.
  eventContext(d) {
    if (!d || typeof d.uri !== 'string' || !d.uri || !('context_uri' in d)) return;
    const ctx = d.context_uri || null;
    const t = this.st.track;
    if (t && (d.uri === t.uri || d.uri === t.context_track_uri || this.isSong(d.uri, t))) this.st.context_uri = ctx;
    else this.announce(d.uri, ctx);
  }

  // ------------------------------------------------------------------ liked state of the current song (catalog.js)
  // st.track.liked: 1/0 for that song (absent = unknown); keyed by the context entry when the engine names it.
  applyLiked() {
    const t = this.st.track;
    if (!t) return;
    let v = this.likedMap.get(t.context_track_uri || t.uri);
    if (v == null && t.context_track_uri) v = this.likedMap.get(t.uri);
    if (v == null) delete t.liked; else t.liked = v;
  }

  noteLiked(uri, s) {
    this.likedMap.delete(uri);
    this.likedMap.set(uri, s ? 1 : 0);
    if (this.likedMap.size > 300) this.likedMap.delete(this.likedMap.keys().next().value);
    const t = this.st.track;
    if (t && (t.context_track_uri === uri || t.uri === uri) && t.liked !== (s ? 1 : 0)) { t.liked = s ? 1 : 0; this.publish(); }
  }

  // ------------------------------------------------------------------ engine events -> state
  setPos(ms, playing) { this.st.pos = { ms: Math.max(0, ms || 0), at: Date.now(), speed: playing ? 1 : 0 }; }

  // The engine's true position. With a 10 s lead it runs well ahead of wall-clock time after every burst, so count
  // the real audio samples it has produced since a known position instead (what we've read + queued + the pipe).
  realNow() { return this.clock.stats.real + this.inFlight(); }
  setAnchor(positionMs, real = this.realNow()) { this.anchor = { real, pos: Math.max(0, positionMs || 0), key: songKey(this.st.track) }; }
  posNow() {
    const a = this.anchor;
    const t = this.st.track;
    if (a && t && a.key === songKey(t)) return Math.round(Math.min(a.pos + (this.realNow() - a.real) / 44.1, t.duration_ms || Infinity));
    const p = this.st.pos;
    return Math.round(p.ms + (Date.now() - p.at) * p.speed);
  }

  onEngine(type, d) {
    const now = Date.now();
    if (type === 'command') return this.onCommand(d, now);
    // caused by another device, not by us: no command of ours is running or just finished, or another device moved
    // playback just now (rule 2: a guest's seek or resume right after one of our commands isn't an echo of ours)
    const foreign = !this.pending && (now > this.ownUntil || now - this.lastMovingCmd < FOREIGN_CMD_MS);
    switch (type) {
      case 'metadata': {
        const old = this.st.track;
        const oldAnchor = this.anchor;
        const oldPos = this.posNow();                                  // where the engine got to in the old song
        this.st.track = { uri: d.uri, name: d.name, artists: d.artist_names || [], album: d.album_name, cover: d.album_cover_url,
          duration_ms: d.duration, format: d.format, bitrate: d.bitrate, ...trackExtra(d) };
        this.applyLiked();
        this.noteTrack(this.st.track);
        const changed = !old || songKey(old) !== songKey(this.st.track);
        if (old && changed) this.prevTrack = old;
        this.st.context_uri = this.songContext(d);
        this.setPos(d.position, this.st.status === 'playing');
        this.metaSeq++;
        const silenceSoFar = this.clock.sample - this.clock.stats.real;    // stream samples = real samples + silence
        let at = this.boundary();
        // Not ours if no command is running (ours wait for their metadata before resuming): either the song ended
        // (keep streaming, just mark where the new one starts) or another device jumped (cut a generation).
        if (!this.pending && (changed || oldPos > (d.position || 0) + 3000)) {
          const cut = this.takeCut('meta');                            // our own 'cut' jump: always a cut
          // a skip command since the last song change (≤ 15 s ago) makes it a skip even at the old song's end (rule 3)
          const skipCmd = this.lastSkipCmd > this.lastMetaAt && now - this.lastSkipCmd <= SKIP_CMD_MAX_MS;
          const natural = !cut && !skipCmd && old && old.duration_ms && oldPos >= old.duration_ms - 3000;      // the song simply ended
          // The engine announces a song change a moment after the new audio has started (a lot of audio, during a
          // burst), but we know exactly where the old song's samples ran out.
          if (natural && oldAnchor && oldAnchor.key === songKey(old)) at = Math.round(oldAnchor.real + (old.duration_ms - oldAnchor.pos) * 44.1) + silenceSoFar;
          if (old && !natural && this.st.status === 'playing') this.externalGen(cut ? cut.reason : 'skip', d.position, undefined, null, !!cut);
          else { this.addMarker(at, 'M', this.trackMarker()); this.addMarker(at, 'P', { position_ms: d.position || 0 }); this.syncConnect(true); }
          // positions only: song names never go into the log
          log.info(`track change ${natural ? 'at song end' : cut ? 'by our jump' : 'by another device'}: ${old ? '@' + oldPos + '/' + old.duration_ms : '-'} -> a ${d.duration || '?'} ms song`);
          if (changed) this.emit('track', { natural: !!natural, foreign: !cut, cut: !!cut });
        } else if (this.pending && changed) this.emit('track', { natural: false, foreign: false, cut: false });
        this.lastMetaAt = now;
        this.setAnchor(d.position, at - silenceSoFar);
        break;
      }
      case 'will_play': if (d && typeof d.uri === 'string' && d.uri) this.announce(d.uri, d.context_uri || null); break;
      case 'playing': {
        this.eventContext(d);
        const was = this.st.status;
        this.st.status = 'playing';
        this.setPos(this.posNow(), true);
        if (foreign && was !== 'playing') {                            // resumed from another device (not a song change)
          this.foreignResumeAt = Date.now();
          if (this.lastAudioStart && Date.now() - this.lastAudioStart.t < 1500) this.foreignResumed();
        }
        break;
      }
      case 'paused': this.eventContext(d); this.st.status = 'paused'; this.setPos(this.posNow(), false); break;
      case 'not_playing': case 'stopped':
        this.eventContext(d);                                          // (not_playing: the song that ended; stopped: none)
        if (this.pending) break;                                       // a load in progress, not the end of anything
        this.rememberOwn();
        this.st.status = 'stopped';
        this.setPos(this.posNow(), false);
        this.engine.refresh();
        break;
      case 'seek': {
        this.eventContext(d);
        this.setPos(d.position, this.st.status === 'playing');
        this.setAnchor(d.position);
        const cut = this.takeCut('seek');
        if (cut || foreign) {
          if (this.st.status === 'playing') this.externalGen(cut ? cut.reason : 'seek', d.position, undefined, null, !!cut);
          else this.addMarker(this.boundary(), 'P', { position_ms: d.position || 0 });
        }
        break;
      }
      case 'active': this.st.active = true; this.remote = null; break;
      case 'inactive':                       // another device took playback (go-librespot drops its session)
        this.rememberOwn();
        this.anchor = null;
        this.clearHeard();
        this.st.active = false;
        this.engine.refresh();
        setTimeout(() => this.pollRemote(), 1500);
        break;
      case 'shuffle_context': this.st.shuffle = !!d.value; break;
      case 'repeat_context': this.st.repeat_context = !!d.value; break;
      case 'repeat_track': this.st.repeat_track = !!d.value; break;
      case 'playback_error': this.onPlaybackError(d); break;
      default: break;
    }
    this.publish();
  }

  // An engine `command` event (patch 3): another device's (or the Web API's) Connect command, right before the engine
  // applies it; the API's own requests never emit one. One that arrives while a command of ours runs (the Web API
  // transfer in takeOver) is ours.
  onCommand(d, now) {
    // (engine patch 4: a transfer the engine could not apply comes with `error` and moved nothing: not rule 2 or 3)
    if (this.pending || d.error) return;
    const ep = d.endpoint;
    const transfer = ep === 'transfer' && !d.continues;              // a continuing transfer (a guest's add) moves nothing
    if (transfer || MOVING.has(ep)) this.lastMovingCmd = now;
    if (transfer || SKIPPING.has(ep)) this.lastSkipCmd = now;
  }

  takeCut(kind) {
    const c = this.cut;
    if (!c || Date.now() > c.until || (c.kind !== kind && c.kind !== 'any')) return null;
    this.cut = null;
    return c;
  }

  // Spotify refusing audio keys sends go-librespot into a fast skip loop (it tries up to 50 tracks in a few seconds),
  // which only makes a refusal (e.g. rate limiting) worse. Spot the storm, pause, and hold off for a minute.
  // In a Jam (rule 10): the host's Jam is paused for everyone (it protects the account); a guest leaves the Jam first,
  // because the engine's pause there is the unproven guest-device pause.
  onPlaybackError(d) {
    const now = Date.now();
    const key = /audio key/i.test(d.message || '');
    this.errLog = (this.errLog || []).filter((t) => now - t < 20000);
    this.errLog.push(now);
    if (this.errLog.length <= 3) log.warn('playback error:', JSON.stringify(d).slice(0, 300));
    else if (this.errLog.length === 4) log.warn('more playback errors (not logging each one)');
    this.bus.push('engine_error', { message: d.message, kind: d.kind, uri: d.uri, key });
    if (key && this.errLog.length >= 4 && !(this.keyHoldUntil > now)) {
      this.keyHoldUntil = now + 60000;
      const jam = this.jam && this.jam.real() ? this.jam.role() || 'host' : '';
      log.warn(`Spotify is refusing audio keys: ${jam === 'guest' ? 'leaving the Jam, then ' : ''}pausing the player and holding off for 60 s`);
      const pause = () => this.engine.call('/player/pause').catch(() => {});
      if (jam === 'guest') this.jam.autoLeave('refusing').finally(pause);
      else pause();
      this.bus.push('notice', { code: 'spotify_refusing', message: jam === 'host'
        ? 'Spotify is refusing to play right now, so the Jam is paused. Try again in a minute or two.'
        : 'Spotify is refusing to play right now (it may be limiting requests). Try again in a minute or two.' });
    }
  }

  fromStatus(s) {
    if (!s) return;
    if (s.track) {
      const t = s.track;
      const keepUri = this.st.track && songKey(this.st.track) === songKey({ name: t.name, duration_ms: t.duration }) ? this.st.track.uri : t.uri;
      this.st.track = { uri: keepUri, name: t.name, artists: t.artist_names || [], album: t.album_name, cover: t.album_cover_url,
        duration_ms: t.duration, format: t.format, bitrate: t.bitrate, ...trackExtra(t) };
      this.applyLiked();
      this.noteTrack({ uri: t.uri, name: t.name, duration_ms: t.duration });
      this.noteTrack(this.st.track);
      this.setPos(t.position, !s.paused && !s.stopped);
    }
    // e.g. after a gateway restart (not while engineConnected() resets the delay: until then it's the listener's position)
    if (s.track && !this.anchorHold && (!this.anchor || this.anchor.key !== songKey(this.st.track))) this.setAnchor(s.track.position);
    // session gone (another device took playback). Not while loading: the engine briefly reports no track then.
    if (!s.track && this.st.track && !this.st.active && !this.pending) { this.rememberOwn(); this.st.track = null; }
    this.st.status = s.stopped ? 'stopped' : s.paused ? 'paused' : (s.track ? 'playing' : 'stopped');
    if (s.track && !s.stopped) this.st.active = true;
    // (not from a load in progress without a track: that names the coming context while we still show the old song)
    if (s.track || !this.pending) this.st.context_uri = s.context_uri || null;
    this.st.shuffle = !!s.shuffle_context;
    this.st.repeat_context = !!s.repeat_context;
    this.st.repeat_track = !!s.repeat_track;
    this.publish();
  }

  snapshot() {
    const r = this.remote;
    // in a Jam: `jam` {r?, hn?, cnt, lim?, away?, wait?} and track.by, the member who added the playing song
    const jam = this.jam ? this.jam.summary() : undefined;
    const by = jam && this.jam.trackBy(this.st.track);
    const s = {
      gen: this.gen, status: this.pending ? 'loading' : this.st.status, track: by ? { ...this.st.track, by } : this.st.track, context_uri: this.st.context_uri,
      position_ms: this.posNow(), at: Date.now(), shuffle: this.st.shuffle,
      repeat: this.st.repeat_track ? 'track' : this.st.repeat_context ? 'context' : 'off',
      engine: { connected: this.engine.connected, active: this.st.active, loaded: this.loaded() },
      // what the account is playing on another device while Encore is idle (needs the Spotify account connected);
      // type (1.1.0, H1): its kind ("computer", "smartphone", ...; showcase.js), so Anonymous Mode can say "your
      // computer" without the device's name
      remote: r ? { device: r.device.name, type: deviceType(r.device.type), is_playing: r.is_playing, track: r.track && { ...r.track, img: tokenFor(r.track.cover) || undefined },
        position_ms: Math.round(r.position_ms + (r.is_playing ? Date.now() - r.at : 0)) } : null,
      account: !!(this.webapi && this.webapi.ready),
    };
    if (jam) s.jam = jam;
    return s;
  }

  publish() {
    if (this.pubTimer) return;
    this.pubTimer = setTimeout(() => { this.pubTimer = null; this.bus.push('player', this.snapshot()); }, 80);
  }

  // ------------------------------------------------------------------ taking playback back from another device
  loaded() { return this.st.status !== 'stopped' && !!this.st.track; }

  async waitLoaded(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await this.engine.refresh();
      if (s && !s.stopped && s.track) return s;
      await sleep(200);
    }
    return null;
  }

  // Our own load knows its context: body.uri, or none for a song on its own (songContext; the engine's will_play wins).
  async loadPaused(body, waitMs = 8000) {
    const seq = this.metaSeq;
    const own = { ctx: /^spotify:(?:track|episode):/.test(String(body.uri)) ? null : body.uri, seq: this.annSeq };
    this.loadCtx = own;
    try {
      await this.engine.call('/player/play', { ...body, paused: true });
      await this.waitMeta(seq, waitMs);
    } finally {
      if (this.loadCtx === own) this.loadCtx = null;
    }
  }

  // Encore's player is empty when another device took playback (or nothing has played yet). Bring playback here,
  // paused at the right spot. Returns the position to start from, or null if Encore already had a session.
  // In a Jam (it is `away`, rule 9) only the Web API transfer may bring it back: recently-played or last.json would
  // quietly leave the Jam, so without the transfer the answer is 409 jam_moved.
  async takeOver() {
    const s0 = await this.engine.refresh();
    if (s0 && !s0.stopped && s0.track) return null;
    const jam = !!(this.jam && this.jam.real());
    let before = null;
    if (this.webapi && this.webapi.ready && !this.webapi.blocked()) {        // Spotify limiting us: Encore's own last song
      before = await this.webapi.playback('player').catch(() => null);
      try {
        await this.webapi.transfer(s0 && s0.device_id, false);       // like "play on this device" in the Spotify app
        const s = await this.waitLoaded(7000);
        if (s) {
          if (!s.paused) await this.engine.call('/player/pause');     // it arrives playing; we start it on a clean boundary
          await this.clock.quiet(40, 1500);
          let pos = s.track.position || 0;
          if (before && before.track && before.track.name === s.track.name) pos = before.position_ms + (before.is_playing ? Date.now() - before.at : 0);
          pos = Math.max(0, Math.round(pos));
          await this.engine.call('/player/seek', { position: pos });
          const kind = before && before.device && deviceType(before.device.type);
          log.info(`took playback over${before ? ' from another device' + (kind ? ' (' + kind + ')' : '') : ''} at ${pos} ms`);   // never its name
          this.remote = null;
          return pos;
        }
      } catch (e) {
        // 404: nothing is playing anywhere on the account; a limit or a broken sign-in: what was played last
        if (jam) log.info(`taking the Jam back failed: ${e.code || e.message}`);
        else if (e.status !== 404 && !['rate_limited', 'busy', 'spotify_auth'].includes(e.code)) throw e;
      }
      if (!jam) {
        const last = await this.webapi.lastPlayed().catch(() => null);
        if (last) {
          await this.loadPaused(last.context_uri ? { uri: last.context_uri, skip_to_uri: last.uri } : { uri: last.uri });
          return 0;
        }
      }
    }
    if (jam) {
      const dev = (before && before.device && before.device.name) || (this.remote && this.remote.device && this.remote.device.name) || 'another device';
      throw Object.assign(new Error(`Your Jam is playing on ${dev}. Play it here from Spotify on that device.`), { status: 409, code: 'jam_moved' });
    }
    const t = this.lastOwn;                                            // no account connected: what Encore itself last played
    if (!t) throw Object.assign(new Error('Encore isn\'t playing anything. Paste a link, pick Encore in Spotify, or connect your Spotify account on the Encore Bridge admin page.'), { status: 409, code: 'not_active' });
    await this.loadPaused(t.context_uri && t.context_uri !== t.uri ? { uri: t.context_uri, skip_to_uri: t.uri, position: t.position } : { uri: t.uri, position: t.position });
    return t.position || 0;
  }

  // The engine runs ahead of the phone by the phone's buffer (up to ~10 s), so near the end of a song it may already
  // be on the next one. Step it back to the song the phone is actually on. (By queue position, not id: Spotify
  // relinks track ids, so the phone's id may not be in the context.)
  async alignTo(uri) {
    if (!uri || !this.st.track || this.isSong(uri, this.st.track) || !this.isSong(uri, this.prevTrack)) return;
    const seq = this.metaSeq;
    await this.engine.call('/player/seek', { position: 0 });           // so prev goes back instead of restarting
    await this.engine.call('/player/prev');
    await this.waitMeta(seq, 6000);
  }

  rememberOwn() {
    const t = this.st.track;
    if (!t) return;
    // a Jam's list answers 403 once the Jam is over: the song alone (rule 8)
    const ctx = this.st.context_uri && !String(this.st.context_uri).startsWith(JAM_LIST) ? this.st.context_uri : null;
    // the context entry, not the media: after Spotify relinks a song, t.uri isn't in the context, so takeOver's
    // skip_to_uri would miss it and the engine would start the context from its first song
    this.lastOwn = { uri: t.context_track_uri || t.uri, context_uri: ctx, position: Math.round(this.posNow()) };
    if (this.dataDir) try { fs.writeFileSync(path.join(this.dataDir, 'last.json'), JSON.stringify(this.lastOwn)); } catch (e) { /* not important */ }
  }

  // While Encore is idle and a phone is around, keep an eye on what the account plays elsewhere (6 s poll).
  async pollRemote() {
    if (this.polling) return;
    this.polling = true;
    try {
      let r = null;
      if (this.webapi && this.webapi.ready && !this.loaded() && !this.pending && Date.now() - (this.lastPhone || 0) < 90000) {
        // quiet: never while Spotify is limiting us or the phone's own requests fill the window
        if (this.webapi.blocked() || this.webapi.window() >= 20) return;
        const pb = await this.webapi.playback(undefined, true);
        if (pb === undefined) return;                                  // turned away: keep what we know
        const mine = this.engine.status && this.engine.status.device_id;
        r = pb && pb.device && pb.device.id !== mine && pb.track ? pb : null;
      }
      const key = (x) => x ? `${x.device.id}|${x.is_playing}|${x.track.uri}` : '';
      const drift = r && this.remote ? Math.abs(r.position_ms - (this.remote.position_ms + (this.remote.is_playing ? r.at - this.remote.at : 0))) : 0;
      if (key(r) !== key(this.remote) || drift > 3000) { this.remote = r; this.publish(); }
      else if (r) this.remote = r;
    } catch (e) {
      if (e.code !== 'spotify_not_connected') log.warn('remote playback check:', e.message);
    } finally {
      this.polling = false;
    }
  }

  // ------------------------------------------------------------------ the phone's playhead (POST /v1/player/heard)
  // {gen, frame, stalled, buffered_s, tier, kbps}: frame = the global frame the phone is playing now (or stalled at).
  // Not a command: no serial lock, no generation; the engine only hears of it through syncConnect().
  // Ignored for a generation the phone paused (pause() makes none): a report still in flight from the closed stream
  // could freeze the clock again with the pipe full, and go-librespot can't pause mid-write.
  onHeard(b) {
    const g = this.genInfo.get(this.gen);
    if (b && b.gen === this.gen && this.gen !== this.heardOff && !this.pending && Number.isFinite(b.frame) && !(g && (b.frame + 1) * 1024 <= g.sample)) {
      const sample = b.frame * 1024;
      const stalled = !!b.stalled;
      const was = this.heard;
      this.heard = { gen: b.gen, sample, stalled, at: Date.now(), buffered_s: Number(b.buffered_s) || 0,
        tier: String(b.tier || '').slice(0, 20), kbps: Number(b.kbps) || 0 };
      this.clock.follow(sample, stalled);
      // a stall starting or ending doesn't change D (the clock stands still with the phone), but the listener stops or
      // goes on against the engine's running published position: send it either way
      this.syncConnect(!was || was.stalled !== stalled);
    }
    return { ok: true, lead_ms: this.clock.leadMs };
  }

  // no (fresh) reports: real-time pacing again, from where the phone was last heard
  clearHeard() {
    this.heard = null;
    this.clock.unfreeze();
  }

  heardInfo() {
    const h = this.heard;
    return h && { gen: h.gen, frame: h.sample / 1024, stalled: h.stalled, age_ms: Date.now() - h.at, buffered_s: h.buffered_s, tier: h.tier, kbps: h.kbps };
  }

  // ------------------------------------------------------------------ Spotify Connect sync (engine "Encore patch 1")
  // How far (ms) the engine's decoder is ahead of what the listener hears: our lead plus the phone's stalls.
  connectDelay() {
    const h = this.heard;
    let heard;
    if (h && h.gen === this.gen && Date.now() - h.at <= HEARD_STALE_MS) {
      heard = Math.min(h.stalled ? h.sample : h.sample + (Date.now() - h.at) * 44.1, this.clock.sample);
    } else heard = this.clock.due();         // an old app (no reports): a real-time listener
    return Math.max(0, (this.boundary() - heard) / 44.1);
  }

  // Tell the engine, so the Spotify app shows the listener's position and a song change when it is heard, not when it
  // is decoded. On a real change, every 15 s, and right after a song change or a phone stall's start or end (force).
  syncConnect(force = false) {
    if (this.connectSync === false) return;
    if (force) this.syncForce = true;
    if (this.pending || this.syncBusy) return;           // a busy call re-runs a forced sync when it's done
    const delay = Math.min(120000, Math.round(this.connectDelay()));       // what the engine accepts
    const now = Date.now();
    const last = this.connectSent;
    if (!this.syncForce && last && Math.abs(delay - last.delay_ms) < 200 && now - (this.syncTriedAt || 0) < 15000) return;
    this.syncForce = false;
    this.syncBusy = true;
    this.syncTriedAt = now;
    this.engine.call('/player/output_delay', { delay_ms: delay })
      .then((r) => {
        this.connectSync = true;
        this.connectSent = { delay_ms: delay, at: Date.now(), republished: !!(r && r.republished), position_ms: r ? r.position_ms : null };
      })
      .catch((e) => this.syncFailed(e))
      .finally(() => { this.syncBusy = false; if (this.syncForce) this.syncConnect(); });
  }

  syncFailed(e) {
    const now = Date.now();
    if (e.code === 'engine_404') {
      this.connectSync = false;
      log.info('the engine has no /player/output_delay (stock go-librespot): Spotify Connect sync is off');
    } else if (!(now - (this.syncErrAt || 0) < 60000)) {
      this.syncErrAt = now;
      log.warn('output_delay:', e.message);
    }
  }

  // The engine's events socket (re)connected, maybe to another engine process (an update can replace a stock engine
  // with the patched one under a running gateway): find out again whether it has /player/output_delay.
  engineConnected() {
    this.connectSync = null;
    this.connectSent = null;
    this.publish();
    if (this.anchor) return;
    // No anchor yet (the gateway just started): it comes from /status, which a patched engine reports as the listener's
    // position, behind its decoder by the delay an earlier gateway set. Nothing is buffered here yet, so the listener
    // is at the decoder: delay 0 first, then anchor; the sync after it sets our own delay.
    this.anchorHold = true;
    this.syncBusy = true;
    this.engine.call('/player/output_delay', { delay_ms: 0 })
      .then(() => { this.connectSync = true; }, (e) => this.syncFailed(e))
      .then(() => { this.anchorHold = false; return this.engine.refresh(); })
      .finally(() => { this.anchorHold = false; this.syncBusy = false; this.syncConnect(true); });
  }

  syncInfo() {
    const s = this.connectSent;
    return { supported: this.connectSync, delay_ms: Math.round(this.connectDelay()),
      sent: s && { delay_ms: s.delay_ms, age_ms: Date.now() - s.at, republished: s.republished, position_ms: s.position_ms } };
  }

  // ------------------------------------------------------------------ commands (from the phone or the admin page)
  reply(gen) { return { gen, stream: `/v1/stream?gen=${gen}`, state: this.snapshot() }; }

  // Engine work is serialized; a newer command supersedes an older one, which then stops at its next step.
  serial(fn) {
    const job = this.cmdLock.then(fn);
    this.cmdLock = job.catch(() => {});
    return job;
  }

  // A generation-making command. `work` runs while the engine is paused and returns the position to start from
  // (null = wherever the engine is).
  command(reason, work) {
    if (this.keyHoldUntil > Date.now()) {
      throw Object.assign(new Error(`Spotify is refusing to play right now. Try again in ${Math.ceil((this.keyHoldUntil - Date.now()) / 1000)} s.`), { status: 503, code: 'spotify_refusing' });
    }
    const p = this.begin(reason);
    return this.serial(async () => {
      const live = () => this.pending === p;
      try {
        if (!live()) return this.reply(p.gen);
        const s = this.engine.status;
        if (this.st.status === 'playing' || (s && s.track && !s.paused && !s.stopped)) await this.engine.call('/player/pause');
        await this.clock.quiet(40, 1500);                                // the pipe is drained: what comes next is new
        if (!live()) return this.reply(p.gen);
        let pos = await work(live);
        if (!live()) return this.reply(p.gen);
        if (pos == null) { const st = await this.engine.refresh(); pos = st && st.track ? st.track.position : 0; }
        p.positionMs = pos;
        this.ownUntil = Date.now() + 2500;
        this.clock.endDiscard();
        p.armed = true;
        p.fallback = setTimeout(() => this.resolve(p, this.clock.sample, 'silence'), 4000);
        await this.engine.call('/player/resume');
        return this.reply(p.gen);
      } catch (e) {
        if (live()) { this.clock.endDiscard(); this.resolve(p, this.clock.sample, 'error'); }
        throw e;
      }
    });
  }

  // A Jam link (from app 0.5.1's link field, say: it passed any spotify: string through) is never a play: the engine
  // would ask Spotify to resolve it, with the join token in the request. A 400 for any of the play's uris; http.js asks
  // first, so that is the answer ahead of a guest's Jam rules too.
  refuseJam({ context_uri, uri, offset_uri } = {}) {
    if ([context_uri, uri, offset_uri].some((u) => typeof u === 'string' && JAM_PLAY.test(u))) {
      throw Object.assign(new Error('That’s a Jam link. Join it from the Jam screen in Encore 0.6.'), { status: 400, code: 'bad_request' });
    }
  }

  play({ context_uri, uri, offset_uri, position_ms, shuffle } = {}) {
    const target = context_uri || uri;
    if (!target) throw Object.assign(new Error('play needs uri or context_uri'), { status: 400, code: 'bad_request' });
    this.refuseJam({ context_uri, uri, offset_uri });
    const body = { uri: target };
    if (offset_uri) body.skip_to_uri = offset_uri;
    // the engine (patch 2) sets the mode before the context loads, so a shuffled play starts on a random song;
    // omitted = the current mode
    if (context_uri && typeof shuffle === 'boolean') body.shuffle_context = shuffle;
    const at = Math.max(0, Math.round(position_ms || 0));
    if (at) body.position = at;
    // the engine may walk the context for up to 10 s first (to find the row, or to shuffle it)
    const waitMs = offset_uri || body.shuffle_context === true ? 15000 : 8000;
    return this.command('play', async () => {
      await this.loadPaused(body, waitMs);
      if (at) {                                                        // the engine seeks after the load: wait for it
        for (let i = 0; i < 40; i++) { const s = await this.engine.refresh(); if (s && s.track && Math.abs(s.track.position - at) < 1500) break; await sleep(50); }
      }
      return at;
    });
  }

  resume() { return this.command('resume', () => this.takeOver()); }

  // Rule 14 (flag hostJump 'cut'): while hosting a Jam, next, prev and an unpaused seek don't pause the engine around
  // the jump (every guest would hear that pause). The engine jumps at once and the generation is cut where the new
  // audio lands, as for another device's jump; the events it causes are ours. The reply waits ≤ 8 s for that cut.
  cutting() { return !!(this.jam && this.jam.real() && this.jam.hostJump() === 'cut' && this.jam.hosting() && this.loaded()); }

  cutJump(reason, kind, op) {
    if (this.keyHoldUntil > Date.now()) {
      throw Object.assign(new Error(`Spotify is refusing to play right now. Try again in ${Math.ceil((this.keyHoldUntil - Date.now()) / 1000)} s.`), { status: 503, code: 'spotify_refusing' });
    }
    return this.serial(async () => {
      const before = this.gen;
      this.cut = { reason, kind, until: Date.now() + 8000 };
      this.ownUntil = Infinity;
      try { await op(); } catch (e) { this.cut = null; throw e; } finally { this.ownUntil = Date.now() + 2500; }
      if (this.gen === before) {
        await new Promise((resolve) => {
          const on = () => { cleanup(); resolve(); };
          const cleanup = () => { clearTimeout(timer); this.off('gen', on); };
          const timer = setTimeout(() => { cleanup(); resolve(); }, 8000);
          this.on('gen', on);
        });
      }
      this.cut = null;
      return this.reply(this.gen);
    });
  }

  seek({ position_ms, uri, paused } = {}) {
    if (!Number.isFinite(position_ms)) throw Object.assign(new Error('seek needs position_ms'), { status: 400, code: 'bad_request' });
    const at = Math.max(0, Math.round(position_ms));
    if (!paused && this.cutting()) return this.cutJump('seek', 'seek', () => this.engine.call('/player/seek', { position: at }));
    if (paused) {                    // scrubbing while paused: move, stay paused, no new generation
      return this.serial(async () => {
        if (!this.loaded()) return this.reply(this.gen);
        this.ownUntil = Infinity;
        try {
          if (this.st.status === 'playing') await this.engine.call('/player/pause');
          await this.alignTo(uri);
          await this.engine.call('/player/seek', { position: at });
          this.setPos(at, false);
        } finally { this.ownUntil = Date.now() + 2500; }
        return this.reply(this.gen);
      });
    }
    return this.command('seek', async () => {
      await this.takeOver();
      await this.alignTo(uri);
      await this.engine.call('/player/seek', { position: at });
      return at;
    });
  }

  next({ uri } = {}) {
    if (this.cutting()) {
      // the engine already ran into the song the phone wants next (see below): start it over
      const ahead = !!(uri && this.st.track && !this.isSong(uri, this.st.track) && this.isSong(uri, this.prevTrack));
      return this.cutJump('next', ahead ? 'seek' : 'meta', () => (ahead ? this.engine.call('/player/seek', { position: 0 }) : this.engine.call('/player/next')));
    }
    return this.command('next', async (live) => {
      await this.takeOver();
      // The engine ran ahead into the next song already (the phone names the song before it): that IS the song the
      // phone wants. Start it over instead of loading prev + next.
      if (uri && this.st.track && !this.isSong(uri, this.st.track) && this.isSong(uri, this.prevTrack)) {
        await this.engine.call('/player/seek', { position: 0 });
        return 0;
      }
      await this.alignTo(uri);
      const seq = this.metaSeq;
      const d0 = this.clock.stats.dropped;
      await this.engine.call('/player/next');
      if (!(await this.waitMeta(seq, 8000)) || !live()) return 0;
      log.info(`next: the engine had played ${Math.round((this.clock.stats.dropped - d0) / 44.1)} ms of the new song before announcing it: starting it over at 0:00`);
      // go-librespot's next (no uri) loads the new song PLAYING despite our pause (daemon/controls.go advanceNext/advanceTo:
      // IsPaused = !hasNextTrack, loadCurrentTrack(paused=false); seen live 2026-10-06: every skip logged "paused: false")
      // and announces it only after its first ~0.5-2 s went down the pipe — into our discard. That was the cut-off start
      // of every skipped-to song. Stop it again, drain, and start it over from 0:00 while paused (as takeOver does).
      await this.engine.call('/player/pause');
      await this.clock.quiet(40, 1500);
      if (!live()) return 0;
      await this.engine.call('/player/seek', { position: 0 });
      return 0;
    });
  }

  prev({ played_ms, uri } = {}) {
    if (this.cutting()) {
      // from the phone a prev always means the previous song (see below); without played_ms it may restart this one
      const back = Number.isFinite(played_ms) && played_ms <= 3000;
      return this.cutJump('prev', back ? 'meta' : 'any', async () => {
        if (back) await this.engine.call('/player/seek', { position: 0 });
        await this.engine.call('/player/prev');
      });
    }
    return this.command('prev', async () => {
      await this.takeOver();
      await this.alignTo(uri);
      // The phone restarts the song itself (a seek) when it's past 3 s, so a prev from the phone always means the
      // previous song. The engine is ahead of the phone, so make sure it doesn't restart instead.
      if (Number.isFinite(played_ms) && played_ms <= 3000) await this.engine.call('/player/seek', { position: 0 });
      const seq = this.metaSeq;
      await this.engine.call('/player/prev');
      await this.waitMeta(seq, Number.isFinite(played_ms) ? 8000 : 1500);   // without played_ms the engine may restart (no metadata)
      return 0;
    });
  }

  pause({ played_ms, uri } = {}) {
    this.clearHeard();              // (a frozen clock would hold the pipe full, and go-librespot can't pause mid-write)
    this.heardOff = this.gen;       // and no late report re-freezes it: reports count again from the next generation
    // In a Jam (rule 4) a pause never steps the engine back a song (that would move the whole Jam back): it seeks only
    // within the song the engine is on, and only when the engine was playing when the pause arrived.
    const jam = !!(this.jam && this.jam.real());
    const wasPlaying = this.st.status === 'playing';
    return this.serial(async () => {
      if (!this.loaded()) return this.reply(this.gen);              // nothing here to pause (another device has playback)
      this.ownUntil = Infinity;                                       // the events this causes are ours, not another device's
      try {
        await this.engine.call('/player/pause');
        // The engine ran ahead of what the phone actually heard (by the phone's buffer). Put it back there.
        if (Number.isFinite(played_ms)) {
          const position = Math.max(0, Math.round(played_ms));
          if (!jam) await this.alignTo(uri);
          if (jam ? wasPlaying && uri && this.isSong(uri, this.st.track) : !uri || this.isSong(uri, this.st.track)) {
            await this.engine.call('/player/seek', { position });
            this.setPos(position, false);
          }
        }
      } finally {
        this.ownUntil = Date.now() + 2500;
      }
      return this.reply(this.gen);
    });
  }

  async shuffle({ on }) { await this.engine.call('/player/shuffle_context', { shuffle_context: !!on }); return this.reply(this.gen); }
  async repeat({ mode }) {
    await this.engine.call('/player/repeat_track', { repeat_track: mode === 'track' });
    await this.engine.call('/player/repeat_context', { repeat_context: mode === 'context' });
    return this.reply(this.gen);
  }
  async queue({ uri }) {
    if (!uri) throw Object.assign(new Error('queue needs uri'), { status: 400, code: 'bad_request' });
    // in a Jam this is Add to Jam: jam.js picks the mechanism (role, flag hostAdd), the reply stays the same
    if (this.jam && this.jam.shown()) { await this.jam.add(uri); return this.reply(this.gen); }
    // the engine answers 200 and does nothing when nothing is loaded
    if (!this.loaded()) throw Object.assign(new Error('Nothing is playing on Encore.'), { status: 409, code: 'not_active' });
    await this.engine.call('/player/add_to_queue', { uri });
    return this.reply(this.gen);
  }
}

module.exports = { Player };
