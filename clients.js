/* Drilldown für die Sites-Kacheln und die Geräteliste.
   Clients (alle, WLAN, LAN, Gast, je Gerät, je SSID), Geräte (alle, AP, Switch, Gateway, offline, Updates), WLANs, LAN-Netze, WAN.
   Quelle: lokale Network-API über den Cloud-Connector (nur GET). Zusatzdaten (SSID, Signal, Port) aus der alten API, falls verfügbar. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var NET = '/proxy/network/integration/v1';
  var cache = {}; // hostId -> { siteId, siteName, devices, clients, legacy, legacyOk, loadedAt, extra }

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
  function yesNo(v) { return v === true ? 'ja' : v === false ? 'nein' : '–'; }

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
  async function paged(hostId, path) {
    var all = [], offset = 0, total = Infinity, guard = 0, sep = path.indexOf('?') >= 0 ? '&' : '?';
    while (offset < total && guard++ < 10) {
      var r = await conn(hostId, path + sep + 'limit=200&offset=' + offset);
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
      paged(hostId, NET + '/sites/' + site.id + '/devices'),
      paged(hostId, NET + '/sites/' + site.id + '/clients'),
      conn(hostId, '/proxy/network/api/s/' + (site.internalReference || 'default') + '/stat/sta')
    ]);
    if (!res[1].ok) throw new Error('Clients nicht abrufbar: ' + res[1].error);
    var legacy = {};
    var legacyOk = res[2].ok && Array.isArray(res[2].data);
    if (legacyOk) res[2].data.forEach(function (x) { if (x && x.mac) legacy[mac(x.mac)] = x; });
    cache[hostId] = {
      siteId: site.id, siteName: site.name || site.internalReference || site.id, multiSite: list.length > 1,
      devices: res[0].ok && Array.isArray(res[0].data) ? res[0].data : [],
      devicesOk: res[0].ok,
      clients: res[1].data, legacy: legacy, legacyOk: legacyOk, loadedAt: new Date(), extra: {}
    };
    return cache[hostId];
  }

  // WLANs, LAN-Netze und WAN werden erst bei Bedarf geladen
  async function getExtra(hostId, ctx, name, force) {
    if (ctx.extra[name] && !force) return ctx.extra[name];
    var path = { wifis: '/wifi/broadcasts', networks: '/networks', wans: '/wans' }[name];
    ctx.extra[name] = await paged(hostId, NET + '/sites/' + ctx.siteId + path);
    return ctx.extra[name];
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

  // ---------- Geräte ----------
  function devType(d) {
    var f = (d.features || []).map(function (x) { return String(x).toLowerCase(); });
    if (/^(UCG|UDM|UXG|UDR|UDW|USG|EFG)/i.test(String(d.model || '')) || f.indexOf('gateway') >= 0) return 'gateway';
    if (f.indexOf('accesspoint') >= 0) return 'ap';
    if (f.indexOf('switching') >= 0) return 'switch';
    return 'other';
  }
  var TYPE_LABEL = { gateway: 'Gateway', ap: 'Access Point', switch: 'Switch', other: 'Gerät' };
  var STATE_LABEL = { ONLINE: 'Online', OFFLINE: 'Offline', PENDING_ADOPTION: 'Adoption offen', UPDATING: 'Update läuft', GETTING_READY: 'Startet', ADOPTING: 'Wird adoptiert',
    DELETING: 'Wird entfernt', CONNECTION_INTERRUPTED: 'Verbindung unterbrochen', ISOLATED: 'Isoliert' };
  function isOffline(d) { return ['OFFLINE', 'ISOLATED', 'CONNECTION_INTERRUPTED'].indexOf(String(d.state).toUpperCase()) >= 0; }
  function stateKind(d) { var s = String(d.state).toUpperCase(); return s === 'ONLINE' ? 'ok' : isOffline(d) ? 'bad' : 'warn'; }
  function deviceFilter(f) {
    var m = /^offline-(ap|switch|gateway)$/.exec(f || '');
    if (m) return function (d) { return isOffline(d) && devType(d) === m[1]; };
    if (f === 'ap' || f === 'switch' || f === 'gateway') return function (d) { return devType(d) === f; };
    if (f === 'offline') return isOffline;
    if (f === 'update') return function (d) { return d.firmwareUpdatable === true; };
    return function () { return true; };
  }

  // ---------- Panel ----------
  function ensurePanel() {
    var p = $('drill');
    if (!p) {
      p = h('section', { class: 'card', id: 'drill', style: 'margin-top:16px', 'aria-live': 'polite' });
      $('result').parentNode.insertBefore(p, $('result').nextSibling);
    }
    return p;
  }

  var LIST_KINDS = { devices: 1, wifis: 1, networks: 1, wans: 1 };

  async function open(o) {
    var panel = ensurePanel(); panel.textContent = '';
    panel.appendChild(h('h2', { class: 'sec-h', text: o.title || 'Details' }));
    panel.appendChild(h('div', { class: 'empty', text: 'Daten werden geladen …' }));
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var ctx;
    try { ctx = await load(o.hostId, o.force); }
    catch (e) { panel.textContent = ''; panel.appendChild(h('h2', { class: 'sec-h', text: o.title || 'Details' })); panel.appendChild(notice('bad', 'Daten nicht ladbar', e.message)); return; }
    if (LIST_KINDS[o.kind]) await renderList(panel, o, ctx); else render(panel, o, ctx);
  }

  function frame(panel, o, ctx, note) {
    panel.textContent = '';
    var head = h('div', { class: 'bar', style: 'justify-content:space-between;margin-bottom:12px' }, [h('h2', { class: 'sec-h', text: o.title || 'Details', style: 'margin:0' })]);
    var reload = h('button', { text: 'Neu laden' }); reload.onclick = function () { open(Object.assign({}, o, { force: true })); };
    var close = h('button', { text: 'Schliessen' }); close.onclick = function () { panel.remove(); };
    head.appendChild(h('div', { class: 'bar' }, [reload, close]));
    panel.appendChild(head);
    var strip = h('div', { class: 'strip' }, [pill('Site: ' + ctx.siteName, 'plain'), pill('Stand ' + new Intl.DateTimeFormat('de-CH', { timeStyle: 'medium' }).format(ctx.loadedAt), 'plain'),
      ctx.legacyOk ? pill('mit Zusatzdaten (SSID, Signal, Port)', 'ok') : pill('nur Basisdaten', 'warn')]);
    if (ctx.multiSite) strip.appendChild(pill('Mehrere Sites: erste angezeigt', 'warn'));
    panel.appendChild(strip);
    if (note) panel.appendChild(h('div', { style: 'margin-bottom:12px' }, [note]));
  }

  // Suchfeld und Tabelle. cols: [[Titel, function(row) -> Text oder Node]]
  function searchTable(panel, rows, cols, keyFn, emptyText) {
    if (!rows.length) { panel.appendChild(h('p', { class: 'muted', text: emptyText || 'Keine Einträge.' })); return; }
    var search = h('input', { placeholder: 'Suchen', 'aria-label': 'Suchen', style: 'width:100%;margin-bottom:12px' });
    panel.appendChild(search);
    var wrap = h('div', { class: 'scroll' }); panel.appendChild(wrap);
    function draw() {
      var q = search.value.trim().toLowerCase();
      var shown = rows.filter(function (r) { return !q || keyFn(r).join(' ').toLowerCase().indexOf(q) >= 0; })
        .sort(function (a, b) { return (keyFn(a)[0] || '~').toLowerCase() < (keyFn(b)[0] || '~').toLowerCase() ? -1 : 1; });
      wrap.textContent = '';
      var tb = h('tbody', null, shown.map(function (r) {
        return h('tr', null, cols.map(function (c) { var v = c[1](r), td = h('td'); if (v instanceof Node) td.appendChild(v); else td.textContent = v == null || v === '' ? '–' : v; return td; }));
      }));
      wrap.appendChild(h('table', null, [h('thead', null, [h('tr', null, cols.map(function (c) { return h('th', { text: c[0] }); }))]), tb]));
      if (!shown.length) wrap.appendChild(h('p', { class: 'muted', text: 'Kein Treffer.' }));
    }
    search.oninput = draw; draw();
  }

  // ---------- Clients ----------
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
    else if (o.kind === 'ssid') {
      if (!ctx.legacyOk) note = notice('warn', 'SSID nicht ermittelbar', 'Ohne Zusatzdaten nennt die API die SSID der Clients nicht. Es werden alle WLAN-Clients gezeigt.');
      rows = rows.filter(function (r) { return r.type === 'WIRELESS' && (!ctx.legacyOk || r.ssid === o.ssid); });
    }

    frame(panel, o, ctx, note);
    var cnt = function (f) { return rows.filter(f).length; };
    panel.appendChild(h('div', { class: 'tiles', style: 'margin-bottom:16px' }, [
      tile('Clients', rows.length), tile('WLAN', cnt(function (r) { return r.type === 'WIRELESS'; })),
      tile('LAN', cnt(function (r) { return r.type === 'WIRED'; })), tile('Gast', cnt(function (r) { return r.guest; }))]));

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
    searchTable(panel, rows, cols, function (r) { return [r.name, r.ip, r.mac, r.ssid, r.uplinkName]; },
      o.kind === 'device' ? 'An diesem Gerät ist aktuell kein Client verbunden.' : 'Keine passenden Clients.');
  }

  // ---------- Geräte, WLANs, LAN-Netze, WAN ----------
  async function renderList(panel, o, ctx) {
    var rows, cols, keyFn, note = null, tiles = null, empty = 'Keine Einträge.';
    var clientRows = ctx.clients.map(function (c) { return normalize(c, ctx); });
    var haveUplinks = clientRows.some(function (r) { return r.hasUplinkInfo; });

    if (o.kind === 'devices') {
      if (!ctx.devicesOk) { frame(panel, o, ctx, notice('bad', 'Geräte nicht abrufbar', 'Die Konsole hat die Geräteliste nicht geliefert.')); return; }
      var all = ctx.devices;
      rows = all.filter(deviceFilter(o.filter));
      tiles = [tile('In dieser Liste', rows.length), tile('Online', rows.filter(function (d) { return String(d.state).toUpperCase() === 'ONLINE'; }).length),
        tile('Offline', rows.filter(isOffline).length), tile('Update verfügbar', rows.filter(function (d) { return d.firmwareUpdatable === true; }).length)];
      note = notice('info', 'Zählung', 'Die Liste kommt direkt von der Network-Anwendung. Die Gerätetypen werden aus Modell und Funktionen abgeleitet, die Zahl in der Kachel kann deshalb leicht abweichen.');
      cols = [['Name', function (d) { return h('b', { text: d.name || d.model || d.id }); }],
        ['Typ', function (d) { return TYPE_LABEL[devType(d)]; }],
        ['Modell', function (d) { return d.model; }],
        ['Status', function (d) { return pill(STATE_LABEL[String(d.state).toUpperCase()] || d.state || 'unbekannt', stateKind(d)); }],
        ['IP', function (d) { return d.ipAddress; }],
        ['Firmware', function (d) { return h('span', null, [d.firmwareVersion ? d.firmwareVersion + ' ' : '–', d.firmwareUpdatable ? pill('Update', 'warn') : null]); }],
        ['MAC', function (d) { return h('span', { class: 'mono', text: d.macAddress || '–' }); }],
        ['Clients', function (d) {
          if (!d.macAddress) return '–';
          var n = clientRows.filter(function (r) { return r.uplinkId === d.id; }).length;
          var b = h('button', { type: 'button', text: (haveUplinks ? n + ' · ' : '') + 'Anzeigen ›' });
          b.onclick = function () { open({ hostId: o.hostId, kind: 'device', deviceMac: d.macAddress, title: 'Clients an ' + (d.name || d.model || d.macAddress) }); };
          return b;
        }]];
      keyFn = function (d) { return [d.name, d.model, d.ipAddress, d.macAddress, TYPE_LABEL[devType(d)]]; };
      empty = 'Keine Geräte in dieser Liste.';
    } else if (o.kind === 'wifis') {
      var rw = await getExtra(o.hostId, ctx, 'wifis', o.force);
      if (!rw.ok) { frame(panel, o, ctx, notice('bad', 'WLANs nicht abrufbar', rw.error)); return; }
      var rn = await getExtra(o.hostId, ctx, 'networks', o.force);
      var nets = {}; if (rn.ok) rn.data.forEach(function (n) { nets[n.id] = n; });
      rows = rw.data;
      tiles = [tile('WLANs', rows.length), tile('Aktiv', rows.filter(function (w) { return w.enabled !== false; }).length),
        tile('Clients im WLAN', ctx.legacyOk ? clientRows.filter(function (r) { return r.type === 'WIRELESS'; }).length : '–')];
      cols = [['Name', function (w) { return h('b', { text: w.name || w.id }); }],
        ['Status', function (w) { return w.enabled === false ? pill('Aus', 'plain') : pill('Aktiv', 'ok'); }],
        ['Typ', function (w) { return w.type === 'IOT_OPTIMIZED' ? 'IoT-optimiert' : w.type === 'STANDARD' ? 'Standard' : w.type; }],
        ['Netzwerk', function (w) {
          var nid = get(w, ['network', 'networkId']), n = nid ? nets[nid] : null;
          if (n) return n.name + (n.vlanId != null ? ' · VLAN ' + n.vlanId : '');
          return get(w, ['network', 'type']) === 'NATIVE' ? 'Natives Netzwerk' : '';
        }],
        ['Sicherheit', function (w) { var t = get(w, ['securityConfiguration', 'type']); return t ? String(t).replace('_PERSONAL', ' Personal').replace('_ENTERPRISE', ' Enterprise') : ''; }],
        ['Band', function (w) { return Array.isArray(w.frequenciesGHz) ? w.frequenciesGHz.join(' / ') + ' GHz' : ''; }],
        ['Client-Isolation', function (w) { return yesNo(w.clientIsolationEnabled); }],
        ['Versteckt', function (w) { return yesNo(w.hideName); }],
        ['Clients', function (w) {
          if (!ctx.legacyOk) return '–';
          var n = clientRows.filter(function (r) { return r.ssid === w.name; }).length;
          if (!n) return '0';
          var b = h('button', { type: 'button', text: n + ' · Anzeigen ›' });
          b.onclick = function () { open({ hostId: o.hostId, kind: 'ssid', ssid: w.name, title: 'Clients im WLAN «' + w.name + '»' }); };
          return b;
        }]];
      keyFn = function (w) { return [w.name, w.type]; };
      empty = 'Die Konsole meldet keine WLANs.';
    } else if (o.kind === 'networks') {
      var rnw = await getExtra(o.hostId, ctx, 'networks', o.force);
      if (!rnw.ok) { frame(panel, o, ctx, notice('bad', 'Netze nicht abrufbar', rnw.error)); return; }
      rows = rnw.data;
      tiles = [tile('Netze', rows.length), tile('Aktiv', rows.filter(function (n) { return n.enabled !== false; }).length)];
      cols = [['Name', function (n) { return h('b', { text: n.name || n.id }); }],
        ['VLAN', function (n) { return n.vlanId != null ? String(n.vlanId) : ''; }],
        ['Status', function (n) { return n.enabled === false ? pill('Aus', 'plain') : pill('Aktiv', 'ok'); }],
        ['Verwaltung', function (n) { return n.management === 'GATEWAY' ? 'Gateway (mit Routing)' : n.management === 'SWITCH' ? 'Switch' : n.management === 'UNMANAGED' ? 'Nicht verwaltet' : n.management; }],
        ['Standard', function (n) { return n.default === true ? 'ja' : ''; }],
        ['ID', function (n) { return h('span', { class: 'mono', text: n.id || '–' }); }]];
      keyFn = function (n) { return [n.name, n.vlanId != null ? String(n.vlanId) : '']; };
      empty = 'Die Konsole meldet keine Netze.';
    } else {
      var rwan = await getExtra(o.hostId, ctx, 'wans', o.force);
      if (!rwan.ok) { frame(panel, o, ctx, notice('bad', 'WAN nicht abrufbar', rwan.error)); return; }
      rows = rwan.data;
      tiles = [tile('WAN-Anschlüsse', rows.length)];
      cols = [['Name', function (w) { return h('b', { text: w.name || w.id }); }], ['ID', function (w) { return h('span', { class: 'mono', text: w.id || '–' }); }]];
      keyFn = function (w) { return [w.name]; };
      empty = 'Die Konsole meldet keine WAN-Anschlüsse.';
    }

    frame(panel, o, ctx, null);
    if (tiles) panel.appendChild(h('div', { class: 'tiles', style: 'margin-bottom:16px' }, tiles));
    searchTable(panel, rows, cols, keyFn, empty);
    if (note) panel.appendChild(h('div', { style: 'margin-top:12px' }, [note]));
  }

  window.Drill = { open: open };
})();
