'use strict';
// Event log for the phone's long-poll: GET /v1/events?cursor=N returns everything after N (or waits for it).
class EventBus {
  constructor() { this.list = []; this.seq = 0; this.waiters = new Set(); }

  push(type, data) {
    this.list.push({ id: ++this.seq, t: Date.now(), type, data });
    if (this.list.length > 500) this.list.shift();
    for (const w of [...this.waiters]) w();
  }

  since(cursor) {
    if (cursor > this.seq) return [{ id: this.seq, t: Date.now(), type: 'reset', data: {} }];   // gateway restarted
    return this.list.filter((e) => e.id > cursor);
  }

  wait(cursor, ms) {
    return new Promise((resolve) => {
      const now = this.since(cursor);
      if (now.length) return resolve(now);
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(this.since(cursor)); };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }
}

module.exports = { EventBus };
