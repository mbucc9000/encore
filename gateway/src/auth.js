'use strict';
// Pairing + request signing.
//  - The admin page (ADMIN_ALLOW addresses only, adminauth.js) issues a 6-digit code, valid 5 minutes, single use.
//  - POST /v1/pair {code, device_name} -> {device_id, secret}. The phone keeps the secret in its Keychain.
//    This reply is the only time the secret crosses the network (plain HTTP), so http.js answers /v1/pair only to
//    ADMIN_ALLOW addresses: pair at home, on the same network as the bridge.
//  - Every request carries X-Encore-Device, X-Encore-Time, X-Encore-Sig where
//    sig = hex(HMAC-SHA256(secret, METHOD + "\n" + PATH?QUERY + "\n" + TIME + "\n" + hex(SHA256(body)))).
//    After pairing only these signatures travel, never the secret.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./log');
const { t } = require('./i18n');
const { renameRetrySync } = require('./fsutil');

class Auth {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'devices.json');
    this.devices = {};
    try { this.devices = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { /* first run */ }
    this.codes = new Map();
    this.failures = [];
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.devices, null, 1), { mode: 0o600 });
    renameRetrySync(tmp, this.file);          // (Windows: retried while a scanner holds the old file a moment)
  }

  newCode() {
    const now = Date.now();
    for (const [c, exp] of this.codes) if (exp < now) this.codes.delete(c);      // (expired ones are of no use)
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    this.codes.set(code, now + 5 * 60 * 1000);
    return { code, expires_in: 300 };
  }

  pair(code, name) {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < 60000);
    if (this.failures.length >= 10) throw Object.assign(new Error(t('en', 'too many attempts, wait a minute')), { status: 429, code: 'rate_limited' });
    const exp = this.codes.get(String(code || '').replace(/\D/g, ''));
    if (!exp || exp < now) {
      this.failures.push(now);
      throw Object.assign(new Error(t('en', 'wrong or expired pairing code')), { status: 401, code: 'bad_code' });
    }
    this.codes.delete(String(code).replace(/\D/g, ''));
    const id = 'dev_' + crypto.randomBytes(6).toString('hex');
    const secret = crypto.randomBytes(32).toString('base64');
    this.devices[id] = { name: String(name || 'iPhone').slice(0, 60), secret, created: new Date().toISOString(), last_seen: null };
    this.save();
    log.info(`paired device ${id}`);                         // never the device's name (it's often its owner's name)
    return { device_id: id, secret, secret_hex: Buffer.from(secret, 'base64').toString('hex'), gateway: 'Encore Bridge' };
  }

  verify(req, body) {
    const id = req.headers['x-encore-device'];
    const t = req.headers['x-encore-time'];
    const sig = String(req.headers['x-encore-sig'] || '');
    // own entries only: a device id such as "constructor" or "__proto__" names nothing (an unsigned request stays a 401)
    const d = id && Object.prototype.hasOwnProperty.call(this.devices, id) ? this.devices[id] : null;
    if (!d || typeof d.secret !== 'string' || !t || !sig) return null;
    if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return null;
    const bodyHash = crypto.createHash('sha256').update(body || Buffer.alloc(0)).digest('hex');
    const msg = `${req.method}\n${req.url}\n${t}\n${bodyHash}`;
    const expect = crypto.createHmac('sha256', Buffer.from(d.secret, 'base64')).update(msg).digest('hex');
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const seen = Date.now();
    if (!d._seen || seen - d._seen > 60000) { d._seen = seen; d.last_seen = new Date(seen).toISOString(); try { this.save(); } catch (e) { /* ignore */ } }
    return { id, name: d.name };
  }

  list() { return Object.entries(this.devices).map(([id, d]) => ({ id, name: d.name, created: d.created, last_seen: d.last_seen })); }

  revoke(id) { if (this.devices[id]) { delete this.devices[id]; this.save(); log.info(`revoked device ${id}`); return true; } return false; }
}

module.exports = { Auth };
