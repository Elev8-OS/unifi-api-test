/* Aktionen: schreibende Funktionen der lokalen Network-API (über den Cloud-Connector).
   Jede Aktion verlangt eine Bestätigung im Dialog. Passwörter werden nie angezeigt oder protokolliert. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var NET = '/proxy/network/integration/v1';
  var S = { hosts: [], hostId: '', sites: [], siteId: '', devices: [], wifis: [], vouchers: [] };

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
  function tok() { return $('tok').value; }

  async function api(url, opts) {
    opts = opts || {};
    var headers = { Authorization: 'Bearer ' + tok() };
    if (opts.body) headers['Content-Type'] = 'application/json';
    var r = await fetch(url, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    var t = await r.text(), j;
    try { j = JSON.parse(t); } catch (e) { j = { error: t }; }
    return { ok: r.ok, status: r.status, json: j };
  }
  // GET über den Connector. Liefert { ok, status, data, error }
  async function conn(path) {
    var r = await api('/api/connector?hostId=' + encodeURIComponent(S.hostId) + '&path=' + encodeURIComponent(path));
    var j = r.json || {};
    if (!r.ok) return { ok: false, status: r.status, error: j.error || ('HTTP ' + r.status) };
    var up = j.status;
    if (up < 200 || up >= 300) return { ok: false, status: up, error: (j.body && (j.body.message || j.body.error)) || ('UniFi antwortet mit HTTP ' + up) };
    var b = j.body;
    return { ok: true, status: up, data: b && b.data !== undefined ? b.data : b };
  }

  // ---------- Bestätigungsdialog ----------
  function confirmDialog(title, lines, danger) {
    return new Promise(function (resolve) {
      var dlg = h('dialog', { style: 'border:1px solid var(--line-strong);border-radius:18px;padding:24px;max-width:460px;width:calc(100% - 32px);background:var(--surface);color:var(--ink)' });
      var yes = h('button', { class: danger ? '' : 'primary', text: 'Ausführen', style: danger ? 'background:var(--danger);border-color:var(--danger);color:#fff' : '' });
      var no = h('button', { text: 'Abbrechen' });
      dlg.appendChild(h('h2', { text: title, style: 'margin:0 0 12px;font-size:18px;line-height:26px' }));
      var ul = h('ul', { style: 'margin:0 0 16px;padding-left:20px' });
      lines.forEach(function (l) { ul.appendChild(h('li', { text: l })); });
      dlg.appendChild(ul);
      dlg.appendChild(h('div', { class: 'bar', style: 'justify-content:flex-end' }, [no, yes]));
      function done(v) { dlg.close(); dlg.remove(); resolve(v); }
      yes.onclick = function () { done(true); };
      no.onclick = function () { done(false); };
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); done(false); });
      document.body.appendChild(dlg);
      dlg.showModal();
      no.focus();
    });
  }

  async function write(body, title, lines, danger) {
    if (!S.hostId || !S.siteId) { showResult('warn', 'Ziel fehlt', 'Zuerst Konsole und Site wählen und «Daten laden» klicken.'); return null; }
    var ok = await confirmDialog(title, lines, danger);
    if (!ok) return null;
    showResult('info', 'Wird ausgeführt …', title);
    var payload = Object.assign({ confirm: true, hostId: S.hostId, siteId: S.siteId }, body);
    var r = await api('/api/write', { method: 'POST', body: payload });
    var j = r.json || {};
    if (!r.ok) { showResult('bad', 'Nicht ausgeführt', j.error || ('HTTP ' + r.status)); return null; }
    var good = j.status >= 200 && j.status < 300;
    showResult(good ? 'info' : 'bad', good ? 'Erledigt (HTTP ' + j.status + ')' : 'UniFi lehnt ab (HTTP ' + j.status + ')',
      good ? title : ((j.body && (j.body.message || j.body.error)) || 'Siehe Rohantwort unten.'), j.body);
    return good ? j : null;
  }

  function showResult(kind, title, text, body) {
    var out = $('act-out'); if (!out) return;
    out.textContent = '';
    out.appendChild(notice(kind, title, text));
    if (body !== undefined && body !== null && body !== '') {
      var d = h('details', { class: 'raw' }, [h('summary', { text: 'Antwort der API' }), h('pre', { text: JSON.stringify(body, null, 2) })]);
      out.appendChild(d);
    }
  }

  // ---------- Daten laden ----------
  function opt(v, t) { return h('option', { value: v, text: t }); }

  async function loadHosts() {
    var r = await api('/api/hosts');
    var sel = $('act-host'); sel.textContent = '';
    sel.appendChild(opt('', 'Konsole wählen'));
    var arr = (r.ok && r.json && r.json.body && r.json.body.data) || [];
    S.hosts = Array.isArray(arr) ? arr : [];
    S.hosts.forEach(function (x) {
      var rs = x.reportedState || {};
      sel.appendChild(opt(x.id, (rs.name || rs.hostname || x.id) + ' (' + String(x.id).slice(0, 8) + '…)'));
    });
    if (S.hosts.length === 1) { sel.value = S.hosts[0].id; S.hostId = S.hosts[0].id; loadSites(); }
    if (!r.ok) showResult('bad', 'Konsolen nicht ladbar', (r.json && r.json.error) || ('HTTP ' + r.status));
  }

  async function loadSites() {
    S.hostId = $('act-host').value; S.siteId = '';
    var sel = $('act-site'); sel.textContent = '';
    if (!S.hostId) { sel.appendChild(opt('', 'Zuerst Konsole wählen')); return; }
    var r = await conn(NET + '/sites');
    sel.appendChild(opt('', 'Site wählen'));
    if (!r.ok) { showResult('bad', 'Sites nicht ladbar', r.error + ' Prüfen, ob die Konsole online ist und die Network-Anwendung läuft.'); return; }
    S.sites = Array.isArray(r.data) ? r.data : [];
    S.sites.forEach(function (s) { sel.appendChild(opt(s.id, s.name || s.internalReference || s.id)); });
    if (S.sites.length === 1) { sel.value = S.sites[0].id; S.siteId = S.sites[0].id; }
  }

  async function loadAll() {
    S.hostId = $('act-host').value; S.siteId = $('act-site').value;
    if (!S.hostId || !S.siteId) { showResult('warn', 'Ziel fehlt', 'Bitte Konsole und Site wählen.'); return; }
    var base = NET + '/sites/' + S.siteId;
    showResult('info', 'Lädt …', 'Geräte, WLANs und Vouchers werden abgefragt.');
    var res = await Promise.all([conn(base + '/devices?limit=200'), conn(base + '/wifi/broadcasts?limit=200'), conn(base + '/hotspot/vouchers?limit=200')]);
    S.devices = res[0].ok && Array.isArray(res[0].data) ? res[0].data : [];
    S.wifis = res[1].ok && Array.isArray(res[1].data) ? res[1].data : [];
    S.vouchers = res[2].ok && Array.isArray(res[2].data) ? res[2].data : [];
    renderPanels();
    var errs = [];
    ['Geräte', 'WLANs', 'Vouchers'].forEach(function (n, i) { if (!res[i].ok) errs.push(n + ': ' + res[i].error); });
    if (errs.length) showResult('warn', 'Nicht alles konnte geladen werden', errs.join(' · '));
    else showResult('info', 'Geladen', S.devices.length + ' Geräte, ' + S.wifis.length + ' WLANs, ' + S.vouchers.length + ' Vouchers.');
  }

  // ---------- Panels ----------
  function deviceSelect(id) {
    var sel = h('select', { id: id, 'aria-label': 'Gerät', style: 'width:100%' });
    sel.appendChild(opt('', S.devices.length ? 'Gerät wählen' : 'Keine Geräte geladen'));
    S.devices.forEach(function (d) { sel.appendChild(opt(d.id, (d.name || d.model || d.id) + ' · ' + (d.model || '') + (d.state ? ' · ' + d.state : ''))); });
    return sel;
  }
  function card(title, sub, kids) {
    return h('article', { class: 'card item' }, [h('h3', { text: title }), h('div', { class: 'sub', text: sub, style: 'margin-bottom:12px' })].concat(kids));
  }
  function field(label, el) { return h('label', { style: 'display:block;margin-bottom:10px' }, [h('div', { class: 'muted small', text: label, style: 'margin-bottom:4px' }), el]); }
  function devName(id) { var d = S.devices.filter(function (x) { return x.id === id; })[0]; return d ? (d.name || d.model || id) : id; }

  function renderPanels() {
    var box = $('act-panels'); box.textContent = '';
    var grid = h('div', { class: 'grid' });

    // Gerät neu starten
    var devR = deviceSelect('act-dev-restart');
    var bR = h('button', { text: 'Neu starten', style: 'background:var(--danger);border-color:var(--danger);color:#fff' });
    bR.onclick = function () {
      var id = devR.value; if (!id) return showResult('warn', 'Gerät fehlt', 'Bitte ein Gerät wählen.');
      write({ action: 'restart-device', deviceId: id }, 'Gerät neu starten', ['Gerät: ' + devName(id), 'Es ist während des Neustarts kurz nicht erreichbar. Hängen Geräte daran (z. B. Nuki-Schlösser am WLAN), sind sie kurz offline.'], true);
    };
    grid.appendChild(card('Gerät neu starten', 'Startet ein Gerät der Site neu.', [field('Gerät', devR), bR]));

    // PoE-Port
    var devP = deviceSelect('act-dev-port');
    var port = h('input', { id: 'act-port', type: 'number', min: '1', max: '64', placeholder: 'Portnummer', style: 'width:100%' });
    var bP = h('button', { text: 'PoE aus und ein', style: 'background:var(--danger);border-color:var(--danger);color:#fff' });
    bP.onclick = function () {
      var id = devP.value, p = parseInt(port.value, 10);
      if (!id || !p) return showResult('warn', 'Angaben fehlen', 'Bitte Switch und Portnummer angeben.');
      write({ action: 'power-cycle-port', deviceId: id, portIdx: p }, 'PoE-Port aus- und einschalten', ['Switch: ' + devName(id), 'Port: ' + p, 'Das angeschlossene Gerät verliert kurz den Strom und startet neu.'], true);
    };
    grid.appendChild(card('PoE-Port aus und ein', 'Power-Cycle eines Switch-Ports, z. B. für einen hängenden Access Point.', [field('Switch', devP), field('Port', port), bP]));

    // WLAN-Passwort
    var wsel = h('select', { id: 'act-wifi', 'aria-label': 'WLAN', style: 'width:100%' });
    wsel.appendChild(opt('', S.wifis.length ? 'WLAN wählen' : 'Keine WLANs geladen'));
    S.wifis.forEach(function (w) {
      var t = w.securityConfiguration && w.securityConfiguration.type;
      wsel.appendChild(opt(w.id, (w.name || w.id) + (t ? ' · ' + t : '')));
    });
    var pw = h('input', { id: 'act-pass', type: 'password', autocomplete: 'new-password', placeholder: 'Neues Passwort (8 bis 63 Zeichen)', style: 'width:100%' });
    var show = h('input', { type: 'checkbox', id: 'act-show' });
    show.onchange = function () { pw.type = show.checked ? 'text' : 'password'; };
    var bW = h('button', { text: 'Passwort setzen', style: 'background:var(--danger);border-color:var(--danger);color:#fff' });
    bW.onclick = function () {
      var id = wsel.value, v = pw.value;
      if (!id) return showResult('warn', 'WLAN fehlt', 'Bitte ein WLAN wählen.');
      if (v.length < 8 || v.length > 63) return showResult('warn', 'Passwort ungültig', 'Es muss 8 bis 63 Zeichen lang sein.');
      var name = (S.wifis.filter(function (w) { return w.id === id; })[0] || {}).name || id;
      write({ action: 'wifi-passphrase', wifiId: id, passphrase: v }, 'WLAN-Passwort ändern', ['WLAN: ' + name, 'Alle Geräte mit dem alten Passwort verlieren die Verbindung.', 'Nuki-Schlösser müssen danach in der Nuki-App neu verbunden werden.'], true)
        .then(function (r) { if (r) { pw.value = ''; } });
    };
    grid.appendChild(card('WLAN-Passwort ändern', 'Setzt das Passwort einer bestehenden WPA2- oder WPA3-Personal-SSID.', [
      field('WLAN', wsel), field('Neues Passwort', pw),
      h('label', { class: 'small muted', style: 'display:flex;gap:8px;align-items:center;margin-bottom:12px' }, [show, 'Passwort anzeigen']), bW]));

    // Vouchers
    var vn = h('input', { id: 'act-vname', placeholder: 'Notiz, z. B. Gast Margaretha 1', style: 'width:100%' });
    var vc = h('input', { id: 'act-vcount', type: 'number', min: '1', max: '100', value: '1', style: 'width:100%' });
    var vm = h('input', { id: 'act-vmin', type: 'number', min: '1', value: '1440', style: 'width:100%' });
    var bV = h('button', { class: 'primary', text: 'Voucher erstellen' });
    bV.onclick = function () {
      var name = vn.value.trim(), count = parseInt(vc.value, 10), min = parseInt(vm.value, 10);
      if (!name || !count || !min) return showResult('warn', 'Angaben fehlen', 'Notiz, Anzahl und Gültigkeit sind nötig.');
      write({ action: 'voucher-create', name: name, count: count, timeLimitMinutes: min }, 'Voucher erstellen', ['Notiz: ' + name, 'Anzahl: ' + count, 'Gültigkeit: ' + min + ' Minuten'], false)
        .then(function (r) { if (r) loadVouchers(); });
    };
    grid.appendChild(card('Gast-Vouchers erstellen', 'Erzeugt Zugangscodes für ein Gäste-WLAN mit Hotspot-Portal.', [
      field('Notiz', vn), h('div', { class: 'bar' }, [h('div', { style: 'flex:1 1 90px' }, [field('Anzahl', vc)]), h('div', { style: 'flex:1 1 130px' }, [field('Gültig (Min.)', vm)])]), bV]));

    box.appendChild(grid);

    var vcard = h('section', { class: 'card', style: 'margin-top:16px', id: 'act-vlist' });
    box.appendChild(vcard);
    renderVouchers();
  }

  async function loadVouchers() {
    var r = await conn(NET + '/sites/' + S.siteId + '/hotspot/vouchers?limit=200');
    S.vouchers = r.ok && Array.isArray(r.data) ? r.data : S.vouchers;
    renderVouchers();
  }

  function renderVouchers() {
    var c = $('act-vlist'); if (!c) return;
    c.textContent = '';
    c.appendChild(h('h2', { class: 'sec-h', text: 'Vorhandene Vouchers (' + S.vouchers.length + ')' }));
    if (!S.vouchers.length) { c.appendChild(h('p', { class: 'muted', text: 'Keine Vouchers vorhanden.' })); return; }
    var tb = h('tbody');
    S.vouchers.slice(0, 100).forEach(function (v) {
      var del = h('button', { text: 'Löschen' });
      del.onclick = function () {
        write({ action: 'voucher-delete', voucherId: v.id }, 'Voucher löschen', ['Code: ' + (v.code || v.id), 'Notiz: ' + (v.name || '–')], true).then(function (r) { if (r) loadVouchers(); });
      };
      tb.appendChild(h('tr', null, [
        h('td', { class: 'mono', text: String(v.code || '–') }), h('td', { text: String(v.name || '–') }),
        h('td', { text: v.timeLimitMinutes != null ? v.timeLimitMinutes + ' Min.' : '–' }),
        h('td', null, [v.expired ? pill('abgelaufen', 'bad') : pill('gültig', 'ok')]), h('td', null, [del])]));
    });
    c.appendChild(h('div', { class: 'scroll' }, [h('table', null, [
      h('thead', null, [h('tr', null, ['Code', 'Notiz', 'Gültigkeit', 'Status', ''].map(function (t) { return h('th', { text: t }); }))]), tb])]));
  }

  // ---------- Tab einhängen ----------
  function openTab() {
    document.querySelectorAll('button.tab').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === 'actions')); });
    var conn_ = $('conn'); if (conn_) conn_.hidden = true;
    var res = $('result'); res.textContent = '';
    res.appendChild(h('h2', { class: 'sec-h', text: 'Aktionen' }));
    res.appendChild(notice('warn', 'Schreibzugriff auf das Netz', 'Diese Aktionen verändern die echte Konfiguration. Jede verlangt eine Bestätigung. Vorerst nur an einer Testumgebung ausprobieren.'));
    var pick = h('div', { class: 'bar', style: 'margin:16px 0' }, [
      h('select', { id: 'act-host', 'aria-label': 'Konsole', style: 'flex:1 1 220px' }),
      h('select', { id: 'act-site', 'aria-label': 'Site', style: 'flex:1 1 200px' }),
      h('button', { class: 'primary', id: 'act-load', text: 'Daten laden' })]);
    res.appendChild(pick);
    res.appendChild(h('div', { id: 'act-out', style: 'margin-bottom:16px' }));
    res.appendChild(h('div', { id: 'act-panels' }));
    $('act-host').appendChild(opt('', 'Lädt …'));
    $('act-site').appendChild(opt('', 'Zuerst Konsole wählen'));
    $('act-host').onchange = loadSites;
    $('act-site').onchange = function () { S.siteId = this.value; };
    $('act-load').onclick = loadAll;
    loadHosts();
  }

  function init() {
    var bar = document.querySelector('button.tab') && document.querySelector('button.tab').parentNode;
    if (!bar) return;
    var b = h('button', { class: 'tab', 'data-v': 'actions', text: 'Aktionen' });
    b.onclick = openTab;
    bar.appendChild(b);
  }
  init();
})();
