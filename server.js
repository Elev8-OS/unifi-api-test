'use strict';
// Testoberfläche für die UniFi Site Manager API. Nur lesend (GET), ohne Abhängigkeiten.
// Variablen: UNIFI_API_KEY (Key aus unifi.ui.com/api), TEST_TOKEN (Zugriffsschutz dieser App), PORT.
const http = require('http');
const fs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');

const UNIFI_BASE = process.env.UNIFI_BASE || 'https://api.ui.com';
const KEY = process.env.UNIFI_API_KEY || '';
const TOKEN = process.env.TEST_TOKEN || '';
const PORT = Number(process.env.PORT || 3000);

function authorized(req) {
  if (!TOKEN) return false;
  const h = req.headers['authorization'] || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = Buffer.from(given), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function upstream(path) {
  const started = Date.now();
  const r = await fetch(UNIFI_BASE + path, {
    headers: { 'X-API-Key': KEY, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, ms: Date.now() - started, path, body };
}

function send(res, code, obj, type) {
  const data = type ? obj : JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

const PAGE = fs.readFileSync(nodePath.join(__dirname, 'index.html'), 'utf8');

const ROUTES = {
  '/api/hosts': () => '/v1/hosts',
  '/api/sites': () => '/v1/sites',
  '/api/devices': () => '/v1/devices',
  '/api/isp-metrics/5m': () => '/v1/isp-metrics/5m',
  '/api/isp-metrics/1h': () => '/v1/isp-metrics/1h',
};

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method !== 'GET') return send(res, 405, { error: 'nur GET' });
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
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
      if (!/^[A-Za-z0-9:_-]+$/.test(hostId)) return send(res, 400, { error: 'hostId ungültig' });
      if (!path.startsWith('/proxy/network/') || path.includes('..')) {
        return send(res, 400, { error: 'Pfad muss mit /proxy/network/ beginnen' });
      }
      return send(res, 200, await upstream('/v1/connector/consoles/' + hostId + path));
    }
    return send(res, 404, { error: 'nicht gefunden' });
  } catch (e) {
    return send(res, 502, { error: String(e && e.message || e) });
  }
}).listen(PORT, () => console.log('unifi-api-test läuft auf Port ' + PORT));
