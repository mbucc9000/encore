'use strict';
// A stand-in for the engine (go-librespot with Encore's patches) for the supervisor tests: it answers --version, logs
// in logrus's text format on stderr like the real one, and does what the FAKE_* variables say. Nothing in it talks
// to Spotify; every name and path in its log lines is made up.
//   FAKE_VERSION_LINE   what --version prints (default "encore-engine 1.1.0 (go-librespot 0.0.0-test, Encore patches 1-6)")
//   FAKE_STARTUP        the second "running …" log line (default the same as --version)
//   FAKE_RECORD         a file: each start appends one JSON line {args, env} (env: which secrets it was given)
//   FAKE_LINES          a JSON array of extra raw log lines to print after starting
//   FAKE_EXIT_AFTER     exit after this many ms with FAKE_EXIT_CODE (default 3)
//   FAKE_PCM            write this many bytes of PCM into the audio_output_pipe it was given (a Unix socket or a
//                       Windows named pipe), then keep running
const fs = require('fs');
const net = require('net');

const env = process.env;
const args = process.argv.slice(2);
const versionLine = env.FAKE_VERSION_LINE || 'encore-engine 1.1.0 (go-librespot 0.0.0-test, Encore patches 1-6)';

if (args.includes('--version')) {
  process.stdout.write(versionLine + '\n');
  process.exit(Number(env.FAKE_VERSION_EXIT || 0));
}

const t = () => new Date().toISOString();
const line = (level, msg, extra = '') => process.stderr.write(`time="${t()}" level=${level} msg=${JSON.stringify(msg)}${extra}\n`);

if (env.FAKE_RECORD) {
  fs.appendFileSync(env.FAKE_RECORD, JSON.stringify({
    args, pid: process.pid,
    env: { launcherToken: !!env.ENCORE_LAUNCHER_TOKEN, adminPassword: !!env.ADMIN_PASSWORD, clientId: !!env.SPOTIFY_CLIENT_ID },
  }) + '\n');
}

line('info', 'running go-librespot 0.0.0-test');
line('info', 'running ' + (env.FAKE_STARTUP || versionLine));
line('info', 'api server listening on 127.0.0.1:3678');
for (const l of JSON.parse(env.FAKE_LINES || '[]')) process.stderr.write(l + '\n');

const conf = (k) => { for (let i = 0; i < args.length - 1; i++) if (args[i] === '-c' && args[i + 1].startsWith(k + '=')) return args[i + 1].slice(k.length + 1); return null; };
if (env.FAKE_PCM) {
  const pipe = conf('audio_output_pipe');
  const sock = net.connect(pipe, () => sock.write(Buffer.alloc(Number(env.FAKE_PCM), 7)));
  sock.on('error', (e) => line('error', 'failed to open pipe', ` error="${e.code}"`));
}

process.on('SIGTERM', () => { line('info', 'stopping on SIGTERM'); process.exit(0); });
if (env.FAKE_EXIT_AFTER) setTimeout(() => { line('error', 'giving up'); process.exit(Number(env.FAKE_EXIT_CODE || 3)); }, Number(env.FAKE_EXIT_AFTER));
setInterval(() => {}, 1000);
