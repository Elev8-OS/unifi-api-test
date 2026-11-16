'use strict';
// Testoberfläche für die UniFi Site Manager API. Nur lesend (GET), ohne Abhängigkeiten.
// Variablen: UNIFI_API_KEY (Key aus unifi.ui.com/api), TEST_TOKEN (Zugriffsschutz dieser App), PORT.
const http = require('http');
const crypto = require('crypto');

const UNIFI_BASE = 'https://api.ui.com';
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

const PAGE = `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UniFi API Test</title>
<style>
body{font:15px/22px Inter,system-ui,sans-serif;background:#f5f5f5;color:#000;margin:0;padding:24px}
main{max-width:960px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.card{background:#fff;border:1px solid #e5e5e5;border-radius:18px;padding:20px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:0 0 12px;border-left:4px solid #F6BB12;padding-left:10px}
p{margin:0;color:#5f5f5f}input{font:inherit;padding:8px 12px;border:1px solid #cfcfcf;border-radius:12px;width:100%;box-sizing:border-box}
button{font:inherit;font-weight:600;padding:8px 14px;border:0;border-radius:12px;background:#F6BB12;color:#000;cursor:pointer;margin:0 8px 8px 0}
button:focus-visible,input:focus-visible{outline:2px solid #000;outline-offset:2px}
pre{background:#fafafa;border:1px solid #e5e5e5;border-radius:12px;padding:12px;overflow:auto;max-height:520px;font-size:12px;line-height:18px;margin:0}
.row{display:flex;gap:8px;flex-wrap:wrap}
</style>
<main>
<div class="card"><h1>UniFi API Test</h1><p>Nur lesende Abfragen an die Site Manager API. Der UniFi-Key liegt nur auf dem Server.</p></div>
<div class="card"><h2>Zugriff</h2><input id="t" type="password" placeholder="TEST_TOKEN dieser App" autocomplete="off"></div>
<div class="card"><h2>Abfragen</h2>
<div class="row">
<button data-p="/api/status">Status</button>
<button data-p="/api/hosts">Hosts</button>
<button data-p="/api/sites">Sites</button>
<button data-p="/api/devices">Geräte</button>
<button data-p="/api/isp-metrics/5m">WAN-Metriken (5m)</button>
</div></div>
<div class="card"><h2>Connector (lokale Network-API über die Cloud)</h2>
<p style="margin-bottom:8px">Host-ID aus «Hosts» einsetzen. Pfad beginnt mit <code>/proxy/network/</code>.</p>
<input id="h" placeholder="hostId" style="margin-bottom:8px">
<input id="p" value="/proxy/network/integration/v1/sites" style="margin-bottom:8px">
<button id="go">Connector abfragen</button></div>
<div class="card"><h2>Antwort</h2><pre id="out">noch nichts abgefragt</pre></div>
</main>
<script>
const out=document.getElementById('out');
async function call(url){
  out.textContent='lädt …';
  try{
    const r=await fetch(url,{headers:{Authorization:'Bearer '+document.getElementById('t').value}});
    const t=await r.text();
    try{out.textContent=JSON.stringify(JSON.parse(t),null,2)}catch(e){out.textContent=t}
  }catch(e){out.textContent='Fehler: '+e.message}
}
document.querySelectorAll('button[data-p]').forEach(b=>b.onclick=()=>call(b.dataset.p));
document.getElementById('go').onclick=()=>call('/api/connector?hostId='+encodeURIComponent(document.getElementById('h').value)+'&path='+encodeURIComponent(document.getElementById('p').value));
</script></html>`;

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
