'use strict';
// POST /v1/diag from the phone: its recent log lines + a stats snapshot, kept per device in data/diag/<device>.log
// (rotated at 4 MB). Stalls, failures and crashes are also echoed to the bridge log, so `docker logs` tells the
// whole story of a listening session from both ends. The echo names the device by its id, never by its name.
const fs = require('fs');
const path = require('path');
const log = require('./log');

const MAX_BYTES = 4 * 1024 * 1024;
const LOUD = /stall|ran dry|fail|crash|exception|signal|error|reconnect|unclean|interrupt|route|memory/i;

class Diag {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'diag');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  file(id) { return path.join(this.dir, String(id || 'unknown').replace(/[^\w.-]/g, '_') + '.log'); }

  add(dev, body) {
    const f = this.file(dev.id);
    const out = [];
    for (const l of Array.isArray(body.lines) ? body.lines.slice(-500) : []) {
      const t = Number(l && l.t) ? new Date(Number(l.t) * 1000).toISOString() : '?';
      const msg = String((l && l.m) || '').slice(0, 1000);
      out.push(`${t} ${msg}`);
      if (LOUD.test(msg)) log.info(`phone ${dev.id}: ${msg}`);
    }
    if (body.stats && typeof body.stats === 'object') out.push(`${new Date().toISOString()} STATS ${JSON.stringify(body.stats).slice(0, 2000)}`);
    if (!out.length) return;
    try {
      if (fs.existsSync(f) && fs.statSync(f).size > MAX_BYTES) fs.renameSync(f, f + '.1');
      fs.appendFileSync(f, out.join('\n') + '\n');
    } catch (e) { log.warn('diag write:', e.message); }
  }

  tail(id, n = 200) {
    try {
      const files = id ? [this.file(id)] : fs.readdirSync(this.dir).filter((x) => x.endsWith('.log')).map((x) => path.join(this.dir, x));
      const lines = [];
      for (const f of files) lines.push(...fs.readFileSync(f, 'utf8').trim().split('\n').slice(-n));
      return lines.slice(-n);
    } catch (e) { return []; }
  }
}

module.exports = { Diag };
