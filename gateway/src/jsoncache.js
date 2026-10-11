'use strict';
// A small memory + disk JSON store for the catalog: get(kind, key) / put(kind, key, obj), a memory LRU per kind in front
// of <dir>/<kind>/<key>.json. Disk writes are async (tmp file + rename, the newest write of a key wins) and each kind's
// directory is pruned to its newest N files. Losing the directory only costs a refetch.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const log = require('./log');
const { renameRetry } = require('./fsutil');

class JsonCache {
  // kinds: { name: { mem: LRU entries, keep: files kept on disk (0 = no pruning), sub: subdirectory ('' = dir itself) } }
  constructor(dir, kinds) {
    this.dir = dir;
    this.kinds = kinds;
    this.mem = new Map();          // kind -> Map(key -> obj)
    this.writes = new Map();       // file -> { obj, busy }
    this.pruned = new Map();       // kind -> last prune time
    for (const [k, o] of Object.entries(kinds)) {
      this.mem.set(k, new Map());
      fs.mkdirSync(path.join(dir, o.sub == null ? k : o.sub), { recursive: true });
    }
  }

  file(kind, key) {
    const o = this.kinds[kind];
    return path.join(this.dir, o.sub == null ? kind : o.sub, String(key).replace(/[^\w.-]/g, '_') + '.json');
  }

  touch(kind, key, obj) {
    const m = this.mem.get(kind);
    m.delete(key);
    m.set(key, obj);
    while (m.size > this.kinds[kind].mem) m.delete(m.keys().next().value);
  }

  // memory only (sync)
  peek(kind, key) { return this.mem.get(kind).get(key) || null; }
  values(kind) { return [...this.mem.get(kind).values()]; }

  async get(kind, key) {
    const hit = this.mem.get(kind).get(key);
    if (hit) { this.touch(kind, key, hit); return hit; }
    let obj = null;
    try { obj = JSON.parse(await fsp.readFile(this.file(kind, key), 'utf8')); } catch (e) { return null; }
    if (this.mem.get(kind).has(key)) return this.mem.get(kind).get(key);   // a put landed while we read
    this.touch(kind, key, obj);
    return obj;
  }

  // Sync read for small files at boot.
  getSync(kind, key) {
    try { const obj = JSON.parse(fs.readFileSync(this.file(kind, key), 'utf8')); this.touch(kind, key, obj); return obj; } catch (e) { return null; }
  }

  put(kind, key, obj) {
    this.touch(kind, key, obj);
    const f = this.file(kind, key);
    const w = this.writes.get(f);
    if (w) { w.obj = obj; w.deleted = false; return; }   // a write is running: it writes this one next
    const job = { obj };
    this.writes.set(f, job);
    // serialize in its own event-loop turn: a long list costs ~15 ms of stringify
    setImmediate(() => this.flush(kind, f, job));
  }

  async flush(kind, f, job) {
    try {
      for (;;) {
        if (job.deleted) { await fsp.unlink(f).catch(() => {}); break; }
        const obj = job.obj;
        job.obj = null;
        const tmp = `${f}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(obj));
        await renameRetry(tmp, f);         // Windows: retried while a scanner holds the old file for a moment
        if (!job.obj && !job.deleted) break;
        await new Promise((r) => setImmediate(r));
      }
    } catch (e) {
      log.warn('cache write:', e.message);
    } finally {
      this.writes.delete(f);
    }
    this.prune(kind);
  }

  async del(kind, key) {
    this.mem.get(kind).delete(key);
    const w = this.writes.get(this.file(kind, key));
    if (w) { w.obj = null; w.deleted = true; }      // the running write deletes it when it is done
    await fsp.unlink(this.file(kind, key)).catch(() => {});
  }

  async has(kind, key) {
    if (this.mem.get(kind).has(key)) return true;
    try { await fsp.access(this.file(kind, key)); return true; } catch (e) { return false; }
  }

  async clear(kind) {
    this.mem.get(kind).clear();
    const o = this.kinds[kind];
    const d = path.join(this.dir, o.sub == null ? kind : o.sub);
    if (o.sub === '') return;                       // top-level kinds are deleted one by one (del)
    for (const [f, w] of this.writes) if (path.dirname(f) === d) { w.obj = null; w.deleted = true; }
    for (const f of await fsp.readdir(d).catch(() => [])) await fsp.unlink(path.join(d, f)).catch(() => {});
  }

  async count(kind) {
    const o = this.kinds[kind];
    return (await fsp.readdir(path.join(this.dir, o.sub == null ? kind : o.sub)).catch(() => [])).filter((f) => f.endsWith('.json')).length;
  }

  // At most once a minute per kind: keep the newest `keep` files by mtime.
  async prune(kind) {
    const keep = this.kinds[kind].keep;
    if (!keep || Date.now() - (this.pruned.get(kind) || 0) < 60000) return;
    this.pruned.set(kind, Date.now());
    const o = this.kinds[kind];
    const d = path.join(this.dir, o.sub == null ? kind : o.sub);
    try {
      const names = (await fsp.readdir(d)).filter((f) => f.endsWith('.json'));
      if (names.length <= keep) return;
      const files = [];
      for (const n of names) { try { files.push({ n, t: (await fsp.stat(path.join(d, n))).mtimeMs }); } catch (e) { /* gone */ } }
      files.sort((a, b) => b.t - a.t);
      for (const f of files.slice(keep)) {
        await fsp.unlink(path.join(d, f.n)).catch(() => {});
        this.mem.get(kind).delete(f.n.slice(0, -5));
      }
    } catch (e) { /* the next write tries again */ }
  }
}

module.exports = { JsonCache };
