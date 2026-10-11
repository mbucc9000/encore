'use strict';
// File helpers that also hold up on Windows.
//
// renameRetry / renameRetrySync: the tmp-file + rename that every state and cache write uses. On Windows, rename onto
// an existing file (MoveFileEx with REPLACE_EXISTING) fails with EPERM, EACCES or EBUSY while another process has the
// target open for a moment: Defender scanning a new cache file, the search indexer, or our own concurrent read. Those
// clear up within milliseconds, so the rename is retried for about a second before the error is passed on. On every
// other platform a rename is atomic and never hits this, so it runs exactly once, as before.
const fs = require('fs');
const fsp = fs.promises;

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const DELAYS_MS = [10, 20, 30, 50, 80, 100, 150, 200, 250, 300];   // about 1.2 s in all

const retryable = (e, platform) => platform === 'win32' && !!e && RETRY_CODES.has(e.code);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// opts.platform is for tests (it defaults to this machine's); opts.delays overrides the waits between tries.
async function renameRetry(from, to, { platform = process.platform, delays = DELAYS_MS } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to);
    } catch (e) {
      if (!retryable(e, platform) || i >= delays.length) throw e;
      await sleep(delays[i]);
    }
  }
}

// The synchronous twin for the few small state files written with renameSync. It blocks the event loop while it waits,
// so it waits less (about 0.4 s in all); those files are tiny and rarely contended.
const SYNC_DELAYS_MS = [5, 10, 20, 40, 60, 80, 100, 100];
let waitCell = null;
function sleepSync(ms) {
  if (!waitCell) waitCell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitCell, 0, 0, ms);
}

function renameRetrySync(from, to, { platform = process.platform, delays = SYNC_DELAYS_MS } = {}) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      if (!retryable(e, platform) || i >= delays.length) throw e;
      sleepSync(delays[i]);
    }
  }
}

module.exports = { renameRetry, renameRetrySync, RETRY_CODES };
