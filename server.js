'use strict';
// Testoberfläche für die UniFi Site Manager API und die lokale Network-API (über den Cloud-Connector).
// Lesen: GET. Schreiben: nur über POST /api/write mit fester Liste erlaubter Aktionen und expliziter Bestätigung.
// Variablen: UNIFI_API_KEY (Key aus unifi.ui.com/api), TEST_TOKEN (Zugriffsschutz dieser App), PORT.
const http = require('http');
const fs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');

const UNIFI_BASE = process.env.UNIFI_BASE || 'https://api.ui.com';
const KEY = process.env.UNIFI_API_KEY || '';
const TOKEN = process.env.TEST_TOKEN || '';
const PORT = Number(process.env.PORT || 3000);
const NET = '/proxy/network/integration/v1';

function authorized(req) {
  if (!TOKEN) return false;
  const h = req.headers['authorization'] || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = Buffer.from(given), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function upstream(path, opts) {
  opts = opts || {};
  const started = Date.now();
  const headers = { 'X-API-Key': KEY, 'Accept': 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(UNIFI_BASE + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, ms: Date.now() - started, path, body };
}

// Entfernt Passwörter aus Antworten, damit sie nie zum Browser oder ins Log gelangen.
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = /passphrase|password|presharedKeys/i.test(k) ? '***' : scrub(v[k]);
    return o;
  }
  return v;
}

function send(res, code, obj, type) {
  const data = type ? obj : JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 20000) { reject(new Error('Anfrage zu gross')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('Ungültiges JSON')); } });
    req.on('error', reject);
  });
}

const PAGE = fs.readFileSync(nodePath.join(__dirname, 'index.html'), 'utf8')
  .replace('</body>', '<script src="/actions.js"></script>\n</body>');
const ACTIONS_JS = fs.readFileSync(nodePath.join(__dirname, 'actions.js'), 'utf8');

const ROUTES = {
  '/api/hosts': () => '/v1/hosts',
  '/api/sites': () => '/v1/sites',
  '/api/devices': () => '/v1/devices',
  '/api/isp-metrics/5m': () => '/v1/isp-metrics/5m',
  '/api/isp-metrics/1h': () => '/v1/isp-metrics/1h',
};

const RE_HOST = /^[A-Za-z0-9:_-]+$/;
const RE_ID = /^[0-9a-fA-F-]{8,64}$/;
const conn = (hostId, p) => '/v1/connector/consoles/' + hostId + p;

// Erlaubte Schreibaktionen. Alles andere wird abgelehnt.
const WRITE = {
  'restart-device': async (b) => {
    need(b, ['hostId', 'siteId', 'deviceId']);
    return {
      log: { deviceId: b.deviceId },
      run: () => upstream(conn(b.hostId, `${NET}/sites/${b.siteId}/devices/${b.deviceId}/actions`), { method: 'POST', body: { action: 'RESTART' } }),
    };
  },
  'power-cycle-port': async (b) => {
    need(b, ['hostId', 'siteId', 'deviceId']);
    const port = Number(b.portIdx);
    if (!Number.isInteger(port) || port < 0 || port > 128) throw bad('Portnummer ungültig');
    return {
      log: { deviceId: b.deviceId, portIdx: port },
      run: () => upstream(conn(b.hostId, `${NET}/sites/${b.siteId}/devices/${b.deviceId}/interfaces/ports/${port}/actions`), { method: 'POST', body: { action: 'POWER_CYCLE' } }),
    };
  },
  'wifi-passphrase': async (b) => {
    need(b, ['hostId', 'siteId', 'wifiId']);
    const pass = typeof b.passphrase === 'string' ? b.passphrase : '';
    if (pass.length < 8 || pass.length > 63) throw bad('Das Passwort muss 8 bis 63 Zeichen lang sein');
    return {
      log: { wifiId: b.wifiId },
      run: async () => {
        const path = conn(b.hostId, `${NET}/sites/${b.siteId}/wifi/broadcasts/${b.wifiId}`);
        const g = await upstream(path);
        if (g.status !== 200 || !g.body || typeof g.body !== 'object') return Object.assign(g, { body: scrub(g.body) });
        const sec = g.body.securityConfiguration;
        if (!sec || !/_PERSONAL$/.test(String(sec.type))) throw bad('Nur WPA2/WPA3 Personal wird unterstützt, nicht ' + (sec && sec.type));
        if (sec.presharedKeys) throw bad('Diese SSID nutzt mehrere Schlüssel (presharedKeys), das wird nicht unterstützt');
        const put = JSON.parse(JSON.stringify(g.body));
        delete put.id; delete put.metadata;
        put.securityConfiguration.passphrase = pass;
        return upstream(path, { method: 'PUT', body: put });
      },
    };
  },
  'voucher-create': async (b) => {
    need(b, ['hostId', 'siteId']);
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const count = Number(b.count || 1), minutes = Number(b.timeLimitMinutes);
    if (!name || name.length > 100) throw bad('Name fehlt oder ist zu lang');
    if (!Number.isInteger(count) || count < 1 || count > 100) throw bad('Anzahl muss 1 bis 100 sein');
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1000000) throw bad('Gültigkeit in Minuten ungültig');
    const body = { name, count, timeLimitMinutes: minutes };
    if (b.authorizedGuestLimit) body.authorizedGuestLimit = Number(b.authorizedGuestLimit);
    return {
      log: { name, count, minutes },
      run: () => upstream(conn(b.hostId, `${NET}/sites/${b.siteId}/hotspot/vouchers`), { method: 'POST', body }),
    };
  },
  'voucher-delete': async (b) => {
    need(b, ['hostId', 'siteId', 'voucherId']);
    return {
      log: { voucherId: b.voucherId },
      run: () => upstream(conn(b.hostId, `${NET}/sites/${b.siteId}/hotspot/vouchers/${b.voucherId}`), { method: 'DELETE' }),
    };
  },
};

function bad(msg) { const e = new Error(msg); e.code = 400; return e; }
function need(b, fields) {
  for (const f of fields) {
    const v = b[f];
    if (typeof v !== 'string' || !(f === 'hostId' ? RE_HOST : RE_ID).test(v)) throw bad(f + ' fehlt oder ist ungültig');
  }
}

async function handleWrite(req, res) {
  let b;
  try { b = await readJson(req); } catch (e) { return send(res, 400, { error: e.message }); }
  if (b.confirm !== true) return send(res, 400, { error: 'Bestätigung fehlt' });
  const action = WRITE[b.action];
  if (!action) return send(res, 400, { error: 'Unbekannte Aktion' });
  try {
    const plan = await action(b);
    console.log(JSON.stringify({ t: new Date().toISOString(), schreibaktion: b.action, hostId: b.hostId, siteId: b.siteId, ...plan.log }));
    const r = await plan.run();
    return send(res, 200, Object.assign({}, r, { body: scrub(r.body) }));
  } catch (e) {
    return send(res, e.code || 502, { error: String(e && e.message || e) });
  }
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/write') {
      if (!authorized(req)) return send(res, 401, { error: 'Token fehlt oder falsch (Header Authorization: Bearer <TEST_TOKEN>)' });
      if (!KEY) return send(res, 500, { error: 'UNIFI_API_KEY ist nicht gesetzt' });
      return handleWrite(req, res);
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Methode nicht erlaubt' });
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
    if (url.pathname === '/actions.js') return send(res, 200, ACTIONS_JS, 'application/javascript; charset=utf-8');
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'nicht gefunden' });
    if (!authorized(req)) return send(res, 401, { error: 'Token fehlt oder falsch (Header Authorization: Bearer <TEST_TOKEN>)' });
    if (!KEY) return send(res, 500, { error: 'UNIFI_API_KEY ist nicht gesetzt' });

    if (url.pathname === '/api/status') {
      const r = await upstream('/v1/hosts');
      const n = Array.isArray(r.body && r.body.data) ? r.body.data.length : null;
      return send(res, 200, { keyGesetzt: true, upstreamStatus: r.status, ms: r.ms, anzahlHosts: n });
    }
    if (ROUTES[url.pathname]) {
      const qs = url.search || '';
      return send(res, 200, await upstream(ROUTES[url.pathname]() + qs));
    }
    if (url.pathname === '/api/connector') {
      const hostId = url.searchParams.get('hostId') || '';
      const path = url.searchParams.get('path') || '';
      if (!RE_HOST.test(hostId)) return send(res, 400, { error: 'hostId ungültig' });
      if (!path.startsWith('/proxy/network/') || path.includes('..')) {
        return send(res, 400, { error: 'Pfad muss mit /proxy/network/ beginnen' });
      }
      return send(res, 200, await upstream(conn(hostId, path)));
    }
    return send(res, 404, { error: 'nicht gefunden' });
  } catch (e) {
    return send(res, 502, { error: String(e && e.message || e) });
  }
}).listen(PORT, () => console.log('unifi-api-test läuft auf Port ' + PORT));
