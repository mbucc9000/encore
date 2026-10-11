'use strict';
// Stub engine for bridge-jam.test.js: the patch-3 engine model (jam-engine.js) over HTTP with the /events websocket
// (handshake + unmasked text frames, as stub-engine.js). Retry-After and X-Upstream-Status go out as headers.
const http = require('http');
const crypto = require('crypto');

function frame(str) {
  const p = Buffer.from(str);
  let h;
  if (p.length < 126) h = Buffer.from([0x81, p.length]);
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  return Buffer.concat([h, p]);
}

function startStubJamEngine(model, port) {
  const clients = new Set();
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let b = {};
    try { b = raw ? JSON.parse(raw) : {}; } catch (e) { res.writeHead(400); return res.end(); }
    const r = await model.handle(req.method, req.url, b);
    const h = { ...(r.headers || {}) };
    if (r.json === undefined || r.status === 204) { res.writeHead(r.status, h); return res.end(); }
    const out = JSON.stringify(r.json);
    res.writeHead(r.status, { ...h, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(out) });
    res.end(out);
  });
  srv.on('upgrade', (req, socket) => {
    if (req.url !== '/events') return socket.destroy();
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    clients.add(socket);
    socket.on('data', () => {});
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });
  model.on('event', (ev) => { for (const s of clients) s.write(frame(JSON.stringify(ev))); });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ srv, clients })));
}

module.exports = { startStubJamEngine };
