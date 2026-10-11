'use strict';
// GET /v1/stream?gen=N&q=very_high|high|normal|low[&from=FRAME][&live=1][&switch=1][&lead=SECONDS]
//   -> the phone's live audio, ENC1-framed:
//   "ENC1" + u32 header length + JSON header {gen, codec:"aac-adts", rate, ch, spf, tier, kbps, start_frame, start,
//     frames:"global", lead_ms, tiers}
//   then records:  u8 type | u24 length | payload
//     'A' one ADTS AAC frame (1024 samples)
//     'M' JSON track metadata, takes effect at the next 'A' frame
//     'P' JSON {position_ms}, position at the next 'A' frame
//     'Z' JSON {gen} end of this generation (the phone reopens with the new gen)
// Frame numbers are global (frame G = stream samples [G*1024, (G+1)*1024) in every tier), so a quality change is a
// reconnect of the same generation at another tier with from=<next frame> (switch=1 only labels the log line).
// lead=<s> is the buffer the phone wants (20 away, 10 at home): the clock's lead target is the biggest ask.
const log = require('./log');
const { isPrivate } = require('./adminauth');

function rec(type, payload) {
  const h = Buffer.alloc(4);
  h[0] = type.charCodeAt(0);
  h.writeUIntBE(payload.length, 1, 3);
  return [h, payload];
}

// Where the phone streams from, for the log: never its address. Away from home that is the phone's public address
// (its carrier's, which roughly locates it), and the guide has users share this log in bug reports. "home" = a private,
// loopback or carrier-grade NAT address (the home network, or a VPN into it); "away" = anything else.
const where = (req) => (isPrivate(req.socket && req.socket.remoteAddress) ? 'a phone at home' : 'a phone away from home');

// Lead asks of the phone streams ({ms, until}). A closed stream's ask lingers for a while: the phone usually reconnects
// right away (a new generation, a quality switch, a Wi-Fi blip), and the lead shouldn't flap in between.
const asks = new Set();
const LINGER_MS = 20000;

function updateLead(clock, cfg) {
  let ms = 0;
  for (const a of asks) {
    if (a.until && a.until <= Date.now()) asks.delete(a);
    else if (a.ms > ms) ms = a.ms;
  }
  const target = ms || cfg.leadMs;
  if (target === clock.leadMs) return;
  clock.setLead(target);
  log.info(`lead ${clock.leadMs / 1000} s (${!ms ? 'default' : ms > cfg.leadMs ? 'away phone' : 'home phone'})`);
}

const leadAsks = () => [...asks].map((a) => ({ ms: a.ms, open: !a.until }));

async function serveStream(req, res, url, { player, encoders, cfg, clock }) {
  const gen = parseInt(url.searchParams.get('gen'), 10);
  const tier = url.searchParams.get('q') || cfg.defaultTier;
  const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (!cfg.tiers[tier]) return json(400, { error: { code: 'bad_tier', message: 'q must be one of ' + Object.keys(cfg.tiers).join(', ') } });
  if (!(gen > 0) || gen > player.gen) return json(400, { error: { code: 'bad_gen' }, gen: player.gen });
  if (gen < player.gen) return json(410, { error: { code: 'stale_gen' }, gen: player.gen });
  encoders.warmAll();             // all tiers on the same frames, so the phone can switch quality between any two

  const info = await player.waitGenStart(gen, 5000);
  if (!info) return json(gen < player.gen ? 410 : 503, { error: { code: gen < player.gen ? 'stale_gen' : 'gen_not_ready' }, gen: player.gen });
  // the phone gave up while we waited ('close' has fired already): nothing would ever release its listener or lead ask
  if (req.destroyed || res.destroyed) return;

  const enc = encoders.get(tier);
  enc.listeners++;
  const start = info.sample;
  const from = url.searchParams.has('from') ? parseInt(url.searchParams.get('from'), 10) : null;
  const live = url.searchParams.get('live') === '1';
  const sw = url.searchParams.get('switch') === '1';
  const leadS = parseFloat(url.searchParams.get('lead'));
  const ask = leadS > 0 ? { ms: Math.round(Math.min(30, Math.max(5, leadS)) * 1000), until: 0 } : null;
  if (ask) { asks.add(ask); updateLead(clock, cfg); }
  let next = from != null ? from : enc.frameForSample(start);
  // live=1: join what's playing now (started from the PC, a Jam, the admin page) at the point that's due now, so the
  // phone hears what a real-time listener would and gets the whole lead as its buffer at once
  if (live) next = Math.max(next, enc.frameForSample(Math.floor(clock.due())));
  if (!(next >= enc.first)) next = Math.max(enc.first, enc.frameForSample(start));
  let lastMarker = 0;
  for (const m of player.markersAfter(0)) if (m.sample < start) lastMarker = m.id;   // markers from before this gen don't apply

  res.writeHead(200, { 'Content-Type': 'application/x-encore-stream', 'Cache-Control': 'no-store', 'X-Encore-Gen': String(gen) });
  const head = Buffer.from(JSON.stringify({ gen, codec: 'aac-adts', rate: 44100, ch: 2, spf: 1024, tier, kbps: enc.kbps, start_frame: next, start: info.how,
    frames: 'global', lead_ms: clock.leadMs, tiers: cfg.tiers }));
  const pre = Buffer.alloc(8);
  pre.write('ENC1', 0, 'latin1');
  pre.writeUInt32BE(head.length, 4);
  res.write(Buffer.concat([pre, head]));

  // per-connection stats, logged when it ends
  const peer = where(req);
  const st = { t0: Date.now(), frames: 0, bytes: 0, waits: 0, maxWaitMs: 0, maxLagFrames: 0, end: 'client closed' };
  const behind = Math.round(cfg.behindSec * 44100 / 1024);
  let closed = false;
  let waiting = false;
  let waitSince = 0;
  let batchTimer = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(batchTimer);
    enc.listeners--;
    enc.off('frame', onFrame);
    player.off('gen', onGen);
    if (ask) { ask.until = Date.now() + LINGER_MS; setTimeout(() => updateLead(clock, cfg), LINGER_MS + 100).unref(); }
    const secs = (Date.now() - st.t0) / 1000;
    const how = [sw ? 'quality switch' + (from != null ? ' from ' + from : '') : from != null ? 'resume from ' + from : live ? 'live' : '',
      ask ? `lead ${ask.ms / 1000} s` : ''].filter(Boolean).join(', ');
    log.info(`stream gen ${gen} ${tier} to ${peer}${how ? ' (' + how + ')' : ''}: ` +
      `${secs.toFixed(1)} s, ${(st.frames * 1024 / 44100).toFixed(1)} s of audio, ${Math.round(st.bytes / 1024)} KB, ` +
      `${st.waits} socket waits (max ${st.maxWaitMs} ms), max lag ${(st.maxLagFrames * 1024 / 44100).toFixed(1)} s, ended by ${st.end}`);
  };
  const finish = () => { if (!closed) { st.end = 'Z'; res.end(Buffer.concat(rec('Z', Buffer.from(JSON.stringify({ gen: player.gen }))))); cleanup(); } };
  const pump = () => {
    if (closed || waiting) return;
    if (player.gen > gen) return finish();
    const lag = enc.last - next;
    if (lag > st.maxLagFrames) st.maxLagFrames = lag;
    if (lag > behind) { st.end = `falling ${cfg.behindSec} s behind`; res.end(); return cleanup(); }
    const parts = [];
    while (next <= enc.last && parts.length < 96) {
      // Of the markers due by this frame only the newest of each type matters. Catching up (live join, reconnect,
      // quality switch) that is the current song and position, not the whole generation's history again.
      const due = new Map();
      for (const m of player.markersAfter(lastMarker)) {
        if (m.sample < start) { lastMarker = m.id; continue; }
        if (enc.frameForSample(m.sample) > next) break;
        due.set(m.type, m);
        lastMarker = m.id;
      }
      for (const m of [...due.values()].sort((a, b) => a.id - b.id)) {
        let data = m.data;
        // catching up: a position from frames ago has moved on since, so the phone's clock stays right
        if (m.type === 'P' && enc.frameForSample(m.sample) < next) data = { ...data, position_ms: Math.round(data.position_ms + (enc.sampleForFrame(next) - m.sample) / 44.1) };
        parts.push(...rec(m.type, Buffer.from(JSON.stringify(data))));
      }
      const f = enc.frame(next);
      if (!f) { next = enc.first; continue; }
      parts.push(...rec('A', f));
      st.frames++;
      st.bytes += f.length + 4;
      next++;
    }
    if (!parts.length) return;
    if (!res.write(Buffer.concat(parts))) {      // the phone isn't taking data as fast as we have it: wait
      waiting = true;
      waitSince = Date.now();
      st.waits++;
      res.once('drain', () => {
        const w = Date.now() - waitSince;
        if (w > st.maxWaitMs) st.maxWaitMs = w;
        waiting = false;
        pump();
      });
      return;
    }
    if (next <= enc.last) setImmediate(pump);
  };
  // In steady playback frames come every 23 ms. Send them ~5 times a second instead: the phone has seconds of
  // buffer, and fewer, bigger packets cost far less Wi-Fi airtime (the iPhone 5 shares its radio with Bluetooth)
  // and let the phone's Wi-Fi doze in between. A backlog (burst, catch-up) still goes out at once.
  const onFrame = () => {
    if (enc.last - next >= 8) { clearTimeout(batchTimer); batchTimer = null; return pump(); }
    if (!batchTimer) batchTimer = setTimeout(() => { batchTimer = null; pump(); }, cfg.batchMs);
  };
  const onGen = () => finish();
  enc.on('frame', onFrame);
  player.on('gen', onGen);
  req.on('close', cleanup);
  res.on('error', (e) => { st.end = 'error ' + e.code; cleanup(); });
  pump();
}

// Admin-only: plain ADTS audio of whatever is playing, for listening in a browser on the home network.
function serveListen(req, res, url, { encoders, cfg, clock }) {
  const tier = cfg.tiers[url.searchParams.get('q')] ? url.searchParams.get('q') : 'high';
  const enc = encoders.get(tier);
  enc.listeners++;
  let next = Math.max(enc.first, Math.min(enc.last, enc.frameForSample(Math.floor(clock.due()))));
  res.writeHead(200, { 'Content-Type': 'audio/aac', 'Cache-Control': 'no-store' });
  let closed = false;
  let waiting = false;
  const pump = () => {
    if (closed || waiting) return;
    const parts = [];
    while (next <= enc.last) { const f = enc.frame(next); if (!f) { next = enc.first; continue; } parts.push(f); next++; }
    if (parts.length && !res.write(Buffer.concat(parts))) { waiting = true; res.once('drain', () => { waiting = false; pump(); }); }
  };
  const onFrame = () => pump();
  enc.on('frame', onFrame);
  const cleanup = () => { if (!closed) { closed = true; enc.listeners--; enc.off('frame', onFrame); } };
  req.on('close', cleanup);
  res.on('error', cleanup);
  pump();
}

module.exports = { serveStream, serveListen, leadAsks };
