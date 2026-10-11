'use strict';
// What the machine running the tests can do, for the few tests that need more than Node:
//   - ffmpeg on PATH (or FFMPEG=<path>): the image tests and the bridge tests (the bridge encodes with ffmpeg)
//   - a POSIX FIFO for the bridge's PCM input (Linux, macOS): the tests that start the real bridge (src/main.js)
//   - ENCORE_SLOW_TESTS=1: also run the slow end-to-end tests (about 10 minutes)
// A test that can't run here is reported as skipped with the reason, never as passed.
const { spawnSync } = require('child_process');
const net = require('net');

const found = new Map();
function hasCommand(cmd, args = ['-version']) {
  if (!found.has(cmd)) {
    const r = spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    found.set(cmd, !r.error);                  // only "can't start it" counts; any exit code means it is there
  }
  return found.get(cmd);
}

const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const hasFfmpeg = () => hasCommand(ffmpeg);
const hasFifo = () => process.platform !== 'win32' && hasCommand('mkfifo', ['--help']);
const slow = /^(1|true|yes|on)$/i.test(process.env.ENCORE_SLOW_TESTS || '');

// The reason a test must be skipped here, or false: pass as node:test's { skip }.
function needs({ ffmpeg: f = false, fifo = false, slow: s = false } = {}) {
  if (f && !hasFfmpeg()) return `ffmpeg is not on PATH (set FFMPEG to its path)`;
  if (fifo && !hasFifo()) return 'needs a POSIX FIFO for the PCM input (Linux or macOS)';
  if (s && !slow) return 'slow end-to-end test: set ENCORE_SLOW_TESTS=1 to run it';
  return false;
}

// A free TCP port on 127.0.0.1 (for a child process that needs a fixed PORT up front).
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

module.exports = { hasCommand, hasFfmpeg, hasFifo, ffmpeg, slow, needs, freePort };
