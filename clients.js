/* Drilldown: Clients je Access Point / Switch, sowie Listen für WLAN-, LAN- und Gast-Clients.
   Quelle: lokale Network-API über den Cloud-Connector (GET). Zusatzdaten (SSID, Signal, Port) aus der alten API, falls verfügbar. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var NET = '/proxy/network/integration/v1';
  var cache = {}; // hostId -> { siteId, siteName, devices, clients, legacy, legacyOk, loadedAt }

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else el.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function pill(text, kind) { return h('span', { class: 'pill ' + (kind || 'plain'), text: text }); }
  function notice(kind, title, text) { return h('div', { class: 'notice ' + kind }, [h('b', { text: title }), h('span', { text: text || '' })]); }
  function tile(label, value) { return h('div', { class: 'tile' }, [h('div', { class: 'l', text: label }), h('div', { class: 'v', text: String(value) })]); }
  function get(o, path) { var c = o; for (var i = 0; i < path.length; i++) { if (c == null) return undefined; c = c[path[i]]; } return c; }
  function mac(v) { return String(v || '').toLowerCase().replace(/[^0-9a-f]/g, ''); }
  function fmtDate(v) {
    if (!v) return '–'; var d = new Date(v); if (isNaN(d.getTime())) return String(v);
    return new Intl.DateTimeFormat('de-CH', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
  }
  function since(v) {
    var d = new Date(v); if (isNaN(d.getTime())) return '';
    var s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min';
    if (s < 86400) return Math.round(s / 3600) + ' h';
    return Math.round(s / 86400) + ' Tage';
  }

  async function api(url) {
    var r = await fetch(url, { headers: { Authorization: 'Bearer ' + $('tok').value } });
    var t = await r.text(), j; try { j = JSON.parse(t); } catch (e) { j = { error: t }; }
    return { ok: r.ok, status: r.status, json: j };
  }
  async function conn(hostId, path) {
    var r = await api('/api/connector?hostId=' + encodeURIComponent(hostId) + '&path=' + encodeURIComponent(path));
    var j = r.json || {};
    if (!r.ok) return { ok: false, error: j.error || ('HTTP ' + r.status) };
    if (j.status < 200 || j.status >= 300) return { ok: false, status: j.status, error: (j.body && (j.body.message || j.body.error)) || ('UniFi antwortet mit HTTP ' + j.status) };
    var b = j.body;
    return { ok: true, body: b, data: b && b.data !== undefined ? b.data : b };
  }
  async function pagedClients(hostId, siteId) {
    var all = [], offset = 0, total = Infinity, guard = 0;
    while (offset < total && guard++ < 10) {
      var r = await conn(hostId, NET + '/sites/' + siteId + '/clients?limit=200&offset=' + offset);
      if (!r.ok) return all.length ? { ok: true, data: all } : r;
      var page = Array.isArray(r.data) ? r.data : [];
      all = all.concat(page);
      total = r.body && typeof r.body.totalCount === 'number' ? r.body.totalCount : all.length;
      if (!page.length) break;
      offset += page.length;
    }
    return { ok: true, data: all };
  }

  async function load(hostId, force) {
    if (cache[hostId] && !force) return cache[hostId];
    var sites = await conn(hostId, NET + '/sites');
    if (!sites.ok) throw new Error('Sites nicht abrufbar: ' + sites.error + ' (Ist die Konsole online und läuft die Network-Anwendung?)');
    var list = Array.isArray(sites.data) ? sites.data : [];
    if (!list.length) throw new Error('Die Konsole meldet keine Site.');
    var site = list[0];
    var res = await Promise.all([
      conn(hostId, NET + '/sites/' + site.id + '/devices?limit=200'),
      pagedClients(hostId, site.id),
      conn(hostId, '/proxy/network/api/s/' + (site.internalReference || 'default') + '/stat/sta')
    ]);
    if (!res[1].ok) throw new Error('Clients nicht abrufbar: ' + res[1].error);
    var legacy = {};
    var legacyOk = res[2].ok && Array.isArray(res[2].data);
    if (legacyOk) res[2].data.forEach(function (x) { if (x && x.mac) legacy[mac(x.mac)] = x; });
    cache[hostId] = {
      siteId: site.id, siteName: site.name || site.internalReference || site.id, multiSite: list.length > 1,
      devices: res[0].ok && Array.isArray(res[0].data) ? res[0].data : [],
      clients: res[1].data, legacy: legacy, legacyOk: legacyOk, loadedAt: new Date()
    };
    return cache[hostId];
  }

  // Einheitliche Client-Zeile aus Integration-API und alter API
  function normalize(c, ctx) {
    var m = mac(c.macAddress || c.mac);
    var l = ctx.legacy[m] || {};
    var type = String(c.type || (l.is_wired === true ? 'WIRED' : l.is_wired === false ? 'WIRELESS' : '')).toUpperCase();
    var accessType = String(get(c, ['access', 'type']) || '').toUpperCase();
    var upId = c.uplinkDeviceId || get(c, ['uplink', 'deviceId']) || get(c, ['uplinkDevice', 'id']);
    var upDev = null;
    if (upId) upDev = ctx.devices.filter(function (d) { return d.id === upId; })[0] || null;
    if (!upDev && (l.ap_mac || l.sw_mac)) {
      var um = mac(l.ap_mac || l.sw_mac);
      upDev = ctx.devices.filter(function (d) { return mac(d.macAddress) === um; })[0] || null;
    }
    return {
      name: c.name || c.hostname || l.name || l.hostname || '',
      mac: c.macAddress || c.mac || '', ip: c.ipAddress || l.ip || '',
      type: type || '?', guest: accessType === 'GUEST' || l.is_guest === true,
      authorized: get(c, ['access', 'authorized']),
      connectedAt: c.connectedAt || (l.assoc_time ? new Date(l.assoc_time * 1000).toISOString() : ''),
      uplinkId: upDev ? upDev.id : (upId || ''), uplinkName: upDev ? (upDev.name || upDev.model) : '',
      ssid: l.essid || get(c, ['wireless', 'ssid']) || '', signal: l.signal != null ? l.signal : (l.rssi != null ? l.rssi : get(c, ['wireless', 'signal'])),
      band: l.radio === 'na' ? '5 GHz' : l.radio === 'ng' ? '2,4 GHz' : l.radio === '6e' ? '6 GHz' : (get(c, ['wireless', 'frequencyGHz']) ? get(c, ['wireless', 'frequencyGHz']) + ' GHz' : ''),
      port: l.sw_port != null ? l.sw_port : get(c, ['wired', 'portIdx']),
      hasUplinkInfo: !!(upId || l.ap_mac || l.sw_mac)
    };
  }

  function typeLabel(c) { return c.type === 'WIRELESS' ? 'WLAN' : c.type === 'WIRED' ? 'LAN' : c.type === 'VPN' ? 'VPN' : c.type; }

  function ensurePanel() {
    var p = $('drill');
    if (!p) {
      p = h('section', { class: 'card', id: 'drill', style: 'margin-top:16px', 'aria-live': 'polite' });
      $('result').parentNode.insertBefore(p, $('result').nextSibling);
    }
    return p;
  }

  async function open(o) {
    var panel = ensurePanel(); panel.textContent = '';
    panel.appendChild(h('h2', { class: 'sec-h', text: o.title || 'Clients' }));
    panel.appendChild(h('div', { class: 'empty', text: 'Clients werden geladen …' }));
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var ctx;
    try { ctx = await load(o.hostId, o.force); }
    catch (e) { panel.textContent = ''; panel.appendChild(h('h2', { class: 'sec-h', text: o.title || 'Clients' })); panel.appendChild(notice('bad', 'Clients nicht ladbar', e.message)); return; }
    render(panel, o, ctx);
  }

  function render(panel, o, ctx) {
    var rows = ctx.clients.map(function (c) { return normalize(c, ctx); });
    var note = null, dev = null;
    if (o.kind === 'device') {
      var dm = mac(o.deviceMac);
      dev = ctx.devices.filter(function (d) { return mac(d.macAddress) === dm; })[0] || null;
      if (!dev) note = notice('warn', 'Gerät nicht gefunden', 'Das Gerät ist in der lokalen Network-API nicht aufgeführt.');
      else if (!rows.some(function (r) { return r.hasUplinkInfo; })) note = notice('warn', 'Keine Zuordnung zu Geräten', 'Die API nennt nicht, an welchem Gerät ein Client hängt. Es werden alle Clients gezeigt.');
      else rows = rows.filter(function (r) { return r.uplinkId === dev.id; });
    } else if (o.kind === 'wireless') rows = rows.filter(function (r) { return r.type === 'WIRELESS'; });
    else if (o.kind === 'wired') rows = rows.filter(function (r) { return r.type === 'WIRED'; });
    else if (o.kind === 'guest') rows = rows.filter(function (r) { return r.guest; });

    panel.textContent = '';
    var head = h('div', { class: 'bar', style: 'justify-content:space-between;margin-bottom:12px' }, [h('h2', { class: 'sec-h', text: o.title || 'Clients', style: 'margin:0' })]);
    var reload = h('button', { text: 'Neu laden' }); reload.onclick = function () { open(Object.assign({}, o, { force: true })); };
    var close = h('button', { text: 'Schliessen' }); close.onclick = function () { panel.remove(); };
    head.appendChild(h('div', { class: 'bar' }, [reload, close]));
    panel.appendChild(head);

    var strip = h('div', { class: 'strip' }, [pill('Site: ' + ctx.siteName, 'plain'), pill('Stand ' + new Intl.DateTimeFormat('de-CH', { timeStyle: 'medium' }).format(ctx.loadedAt), 'plain'),
      ctx.legacyOk ? pill('mit Zusatzdaten (SSID, Signal, Port)', 'ok') : pill('nur Basisdaten', 'warn')]);
    if (ctx.multiSite) strip.appendChild(pill('Mehrere Sites: erste angezeigt', 'warn'));
    panel.appendChild(strip);
    if (note) panel.appendChild(h('div', { style: 'margin-bottom:12px' }, [note]));

    var cnt = function (f) { return rows.filter(f).length; };
    panel.appendChild(h('div', { class: 'tiles', style: 'margin-bottom:16px' }, [
      tile('Clients', rows.length), tile('WLAN', cnt(function (r) { return r.type === 'WIRELESS'; })),
      tile('LAN', cnt(function (r) { return r.type === 'WIRED'; })), tile('Gast', cnt(function (r) { return r.guest; }))]));

    if (!rows.length) { panel.appendChild(h('p', { class: 'muted', text: o.kind === 'device' ? 'An diesem Gerät ist aktuell kein Client verbunden.' : 'Keine passenden Clients.' })); return; }

    var search = h('input', { placeholder: 'Suchen (Name, IP, MAC, SSID)', 'aria-label': 'Suchen', style: 'width:100%;margin-bottom:12px' });
    panel.appendChild(search);
    var showUplink = o.kind !== 'device';
    var showSsid = rows.some(function (r) { return r.ssid; });
    var showSig = rows.some(function (r) { return r.signal != null && r.signal !== ''; });
    var cols = [['Name', function (r) { return h('span', null, [h('b', { text: r.name || '(ohne Namen)' }), r.guest ? ' ' : null, r.guest ? pill('Gast', 'warn') : null]); }],
      ['Typ', function (r) { return typeLabel(r) + (r.band ? ' · ' + r.band : ''); }]];
    if (showUplink) cols.push(['Verbunden mit', function (r) { return r.uplinkName ? r.uplinkName + (r.port != null && r.type === 'WIRED' ? ' · Port ' + r.port : '') : '–'; }]);
    else if (rows.some(function (r) { return r.port != null && r.type === 'WIRED'; })) cols.push(['Port', function (r) { return r.port != null && r.type === 'WIRED' ? 'Port ' + r.port : '–'; }]);
    if (showSsid) cols.push(['WLAN', function (r) { return r.ssid || '–'; }]);
    if (showSig) cols.push(['Signal', function (r) { return r.signal != null && r.signal !== '' ? r.signal + ' dBm' : '–'; }]);
    cols.push(['IP', function (r) { return r.ip || '–'; }]);
    cols.push(['MAC', function (r) { return h('span', { class: 'mono', text: r.mac || '–' }); }]);
    cols.push(['Verbunden seit', function (r) { return r.connectedAt ? since(r.connectedAt) + ' (' + fmtDate(r.connectedAt) + ')' : '–'; }]);

    var wrap = h('div', { class: 'scroll' }); panel.appendChild(wrap);
    function draw() {
      var q = search.value.trim().toLowerCase();
      var shown = rows.filter(function (r) { return !q || [r.name, r.ip, r.mac, r.ssid, r.uplinkName].join(' ').toLowerCase().indexOf(q) >= 0; })
        .sort(function (a, b) { return (a.name || '~').toLowerCase() < (b.name || '~').toLowerCase() ? -1 : 1; });
      wrap.textContent = '';
      var tb = h('tbody', null, shown.map(function (r) {
        return h('tr', null, cols.map(function (c) { var v = c[1](r), td = h('td'); if (v instanceof Node) td.appendChild(v); else td.textContent = v; return td; }));
      }));
      wrap.appendChild(h('table', null, [h('thead', null, [h('tr', null, cols.map(function (c) { return h('th', { text: c[0] }); }))]), tb]));
      if (!shown.length) wrap.appendChild(h('p', { class: 'muted', text: 'Kein Treffer.' }));
    }
    search.oninput = draw; draw();
  }

  window.Drill = { open: open };
})();
