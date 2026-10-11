'use strict';
// Encore Bridge (the "gateway" in code): go-librespot's PCM -> AAC stream + control API for the iOS 6 app.
// On Windows (gateway/windows/CONTRACT.md) it also starts and watches the engine (supervisor.js), reads its PCM from a
// named pipe it serves (pcm.js), stops on the launcher's stdin "quit" line, and exits with a code the launcher reads:
// 10 the port is in use, 11 the port isn't allowed, 12 a settings problem. Docker runs it exactly as before.
const fs = require('fs');
const cfg = require('./config');
const log = require('./log');
const { PcmClock, sourceFor } = require('./pcm');
const { Encoders } = require('./encoder');
const { Engine } = require('./engine');
const { EventBus } = require('./events');
const { Player } = require('./player');
const { Auth } = require('./auth');
const { AdminAuth } = require('./adminauth');
const { WebApi } = require('./webapi');
const { Images, CoverWarm } = require('./image');
const { Catalog } = require('./catalog');
const { Jam } = require('./jam');
const { Personal } = require('./personal');
const { Membership } = require('./membership');
const { Lyrics } = require('./lyrics');
const { Social } = require('./social');
const { Supervisor } = require('./supervisor');
const { makeUpdate } = require('./update');
const { createServer } = require('./http');

const EXIT_PORT_IN_USE = 10;
const EXIT_PORT_DENIED = 11;
const EXIT_SETTINGS = 12;

for (const w of cfg.settingsWarnings) log.warn(w);
if (cfg.settingsErrors.length) {
  for (const e of cfg.settingsErrors) log.error(e);
  process.exit(EXIT_SETTINGS);
}
try {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
} catch (e) {
  log.error(`the data folder can't be created (${e.code || e.message}): check DATA_DIR`);
  process.exit(EXIT_SETTINGS);
}
log.info(`Encore Bridge ${cfg.version} starting`);
const adminAuth = new AdminAuth({ cfg });      // the admin password (or first-run setup), ADMIN_ALLOW, the failure limit
adminAuth.announce(cfg.port);
// (the setup guide saves it and it applies at once: DESIGN-WIZARD.md §3)
if (!cfg.spotifyClientId) log.warn('no Spotify Client ID yet: the setup guide on the admin page asks for it');

const clock = new PcmClock(sourceFor(cfg), { leadMs: cfg.leadMs, gapMs: cfg.gapMs });
const encoders = new Encoders(clock, cfg);
const engine = new Engine(cfg.engineUrl);
const supervisor = new Supervisor({ cfg });     // the engine as a child process (Windows); 'unmanaged' on Docker
const bus = new EventBus();
const webapi = new WebApi(cfg.dataDir, cfg.spotifyClientId, { api: cfg.spotifyApi, accounts: cfg.spotifyAccounts,
  catchCallback: cfg.spotifyCallbackCatcher });       // Windows: the sign-in's redirect is caught on this computer (D12)
webapi.on('notice', (n) => bus.push('notice', n));
const player = new Player({ engine, clock, bus, webapi, dataDir: cfg.dataDir });
webapi.on('caught', () => player.pollRemote());       // as the admin page's Finish does after a pasted sign-in
const images = new Images(cfg, player);
images.coverWarm = new CoverWarm({ player, engine, images });      // the covers around the playing song, before the phone asks
const catalog = new Catalog({ cfg, engine, webapi, bus, player, images });
const jam = new Jam({ cfg, engine, player, bus, webapi, encoders });
const personal = new Personal({ cfg, webapi, catalog, engine, bus, player });
const membership = new Membership({ cfg, catalog });
const lyrics = new Lyrics({ cfg, engine, player });
const social = new Social({ cfg, engine, webapi, catalog });        // other people's profiles (0.10)
catalog.hintFor = (id) => social.hint(id);
player.jam = jam;
const auth = new Auth(cfg.dataDir);

// Updates (DESIGN-UPDATES.md): Docker / other: the bridge's own daily check (the first look 10 min after start, unref'd
// timers); Windows with the tray launcher: the launcher checks and pushes its view (POST /local/v1/update)
const update = makeUpdate({ cfg });
update.start();

clock.start();
supervisor.start().catch((e) => log.error('engine start:', e.message));
encoders.get(cfg.defaultTier);       // keep the default tier warm so the first play starts instantly
engine.connect();

// Playing with nobody listening (the phone app was closed, or a computer picked Encore with no phone around): pause, so
// the player doesn't run through the queue for no one. Not in a Jam: that would pause everyone's Jam (as a guest, the
// unproven guest-device pause); jam.js has its own idle safety for Jams (DESIGN-4b.md §5.6 rule 7), which needs an
// engine with patch 3 to see a Jam end (jam.idleOwn()).
let idleSince = 0;
setInterval(() => {
  if (player.st.status === 'playing' && !player.pending && encoders.listening() === 0 && !jam.idleOwn()) {
    if (!idleSince) idleSince = Date.now();
    else if (Date.now() - idleSince > cfg.idlePauseSec * 1000) {
      idleSince = 0;
      log.info(`nobody has been listening for ${cfg.idlePauseSec} s: pausing`);
      player.pause({}).catch((e) => log.warn('idle pause:', e.message));
    }
  } else idleSince = 0;
}, 5000).unref();

// Stops the bridge: SIGTERM / SIGINT (Docker, a terminal), SIGBREAK (Windows), the launcher's stdin "quit" or end of
// input, and the loopback shutdown route (R3c, through ctx.shutdown). With an engine of its own, the bridge stops it
// first and gives pending state writes a moment; otherwise it exits at once, as it always has.
let stopping = false;
function stop(why) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down');
  update.stop();
  server.close();
  if (!supervisor.managed && !cfg.launcher) process.exit(0);
  if (why) log.info(`stop requested (${why})`);
  setTimeout(() => process.exit(0), 5000).unref();          // whatever happens, out within about 5 s
  supervisor.stop(3000)
    .then(() => new Promise((r) => setTimeout(r, 250)))     // state files are written with tmp + rename, async
    .then(() => { clock.stop(); process.exit(0); });
}

const server = createServer({ cfg, player, auth, adminAuth, bus, encoders, engine, clock, webapi, images, catalog, jam, personal, lyrics, membership, social, supervisor, update, shutdown: stop, started: Date.now() });
server.keepAliveTimeout = 65000;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { log.error(`port ${cfg.port} is in use by another program (choose another PORT, or stop that program)`); exitNow(EXIT_PORT_IN_USE); }
  if (e.code === 'EACCES') { log.error(`port ${cfg.port} isn't allowed on this computer (choose another PORT; on Windows it may be in a reserved range)`); exitNow(EXIT_PORT_DENIED); }
  log.error('http server:', e.code || e.message);
  exitNow(1);
});
server.listen(cfg.port, '0.0.0.0', () => log.info(`listening on :${cfg.port}`));

// Exits without the graceful path (the port problem comes before anything was served), but never leaves the engine.
function exitNow(code) {
  supervisor.killNow();
  process.exit(code);
}

process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
if (process.platform === 'win32') process.on('SIGBREAK', () => stop('Ctrl+Break'));
process.on('exit', () => supervisor.killNow());
process.on('uncaughtException', (e) => log.error('uncaught:', e.stack || e.message));
process.on('unhandledRejection', (e) => log.error('unhandled:', (e && e.stack) || e));

// The Windows launcher talks to the bridge over stdin (CONTRACT.md §2). Other lines are ignored, never logged.
if (cfg.launcher) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    if (buf.length > 4096 && buf.indexOf('\n') < 0) buf = '';
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === 'quit') stop('quit line');
    }
  });
  process.stdin.on('end', () => stop('the launcher closed stdin'));
  process.stdin.on('error', () => stop('the launcher closed stdin'));
}
