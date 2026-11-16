/* Tab «Resend»-Überwachung: zeigt den Zustand der E-Mail-Überwachung und kann eine Testmail senden. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

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
  function fmt(v) {
    if (!v) return '–';
    var d = new Date(v); if (isNaN(d.getTime())) return String(v);
    return new Intl.DateTimeFormat('de-CH', { dateStyle: 'short', timeStyle: 'medium' }).format(d);
  }
  function kv(rows) {
    var dl = h('dl', { class: 'kv' });
    rows.forEach(function (r) {
      if (r[1] === undefined || r[1] === null || r[1] === '') return;
      dl.appendChild(h('dt', { text: r[0] })); dl.appendChild(h('dd', { text: String(r[1]) }));
    });
    return dl;
  }

  async function call(url, method) {
    var r = await fetch(url, { method: method || 'GET', headers: { Authorization: 'Bearer ' + $('tok').value } });
    var t = await r.text(), j; try { j = JSON.parse(t); } catch (e) { j = { error: t }; }
    return { ok: r.ok, status: r.status, json: j };
  }

  async function load() {
    var res = $('result'); res.textContent = '';
    res.appendChild(h('h2', { class: 'sec-h', text: 'Überwachung' }));
    res.appendChild(h('div', { class: 'empty', text: 'Lädt …' }));
    var r = await call('/api/monitor');
    res.textContent = '';
    res.appendChild(h('h2', { class: 'sec-h', text: 'Überwachung' }));
    if (!r.ok) { res.appendChild(notice('bad', r.status === 401 ? 'Zugriff verweigert' : 'Fehler', r.json.error || ('HTTP ' + r.status))); return; }
    var s = r.json, c = s.konfiguration;

    if (s.fehlendeVariablen.length) {
      res.appendChild(notice('warn', 'Überwachung ist aus', 'In Railway fehlt: ' + s.fehlendeVariablen.join(', ') + '. Danach startet die App neu und die Überwachung läuft.'));
    } else if (s.letzterFehler) {
      res.appendChild(notice('warn', 'Letzte Prüfung mit Fehler', s.letzterFehler));
    } else {
      res.appendChild(notice('info', 'Überwachung läuft', 'Letzte Prüfung: ' + fmt(s.letzterLauf) + '.'));
    }
    (s.hinweise || []).forEach(function (t) { res.appendChild(h('div', { style: 'margin-top:8px' }, [notice('warn', 'Hinweis', t)])); });
    if (s.letzterMailFehler) res.appendChild(h('div', { style: 'margin-top:8px' }, [notice('bad', 'Mailversand fehlgeschlagen', s.letzterMailFehler + (s.wartendeMeldungen ? ' (' + s.wartendeMeldungen + ' Meldung(en) warten auf erneuten Versand)' : ''))]));

    res.appendChild(h('div', { class: 'tiles', style: 'margin:16px 0' }, [
      tile('Konsolen', s.zaehlung.konsolen), tile('Geräte', s.zaehlung.geraete), tile('IoT-Clients', s.zaehlung.clients),
      tile('Offline', s.zaehlung.offline), tile('Mails gesendet', s.versendet)]));

    var test = h('button', { class: 'primary', text: 'Testmail senden' });
    var reload = h('button', { text: 'Aktualisieren' });
    var out = h('span', { class: 'muted small' });
    test.onclick = async function () {
      test.disabled = true; out.textContent = 'Sendet …';
      var t = await call('/api/monitor/test', 'POST');
      out.textContent = t.ok ? 'Testmail ist unterwegs. Prüfe das Postfach ' + c.empfaenger.join(', ') + '.' : 'Fehlgeschlagen: ' + (t.json.error || t.status);
      test.disabled = false;
    };
    reload.onclick = load;
    res.appendChild(h('div', { class: 'bar', style: 'margin-bottom:16px' }, [test, reload, out]));

    res.appendChild(h('div', { class: 'sec-h', text: 'Einstellungen' }));
    res.appendChild(kv([
      ['Konsole', c.konsole], ['Empfänger', c.empfaenger.join(', ')], ['Absender', c.absender],
      ['IoT-WLAN', c.iotSsid], ['IoT-Netz', c.iotNetz], ['IoT-IP-Anfang', c.iotIpAnfang], ['Feste MAC-Liste', c.ueberwachteMacs ? c.ueberwachteMacs + ' Adressen' : ''],
      ['Meldung nach', c.meldenNachMin + ' min (Geräte), ' + c.clientsNachMin + ' min (Clients)'], ['Prüfintervall', c.intervallSek + ' s']]));

    res.appendChild(h('div', { class: 'sec-h', style: 'margin-top:20px', text: 'Überwachte Einträge' }));
    if (!s.eintraege.length) { res.appendChild(h('p', { class: 'muted', text: 'Noch keine Einträge. Die erste Prüfung läuft kurz nach dem Start.' })); return; }
    var tb = h('tbody', null, s.eintraege.map(function (e) {
      return h('tr', null, [
        h('td', null, [h('b', { text: e.name })]), h('td', { text: e.art }), h('td', { text: e.konsole || '–' }), h('td', { text: e.detail || '–' }),
        h('td', null, [pill(e.status === 'up' ? 'Online' : 'Offline', e.status === 'up' ? 'ok' : 'bad'), e.gemeldet ? ' ' : null, e.gemeldet ? pill('gemeldet', 'plain') : null]),
        h('td', { text: fmt(e.seit) })]);
    }));
    res.appendChild(h('div', { class: 'scroll' }, [h('table', null, [h('thead', null, [h('tr', null, ['Name', 'Art', 'Konsole', 'Details', 'Status', 'Seit'].map(function (t) { return h('th', { text: t }); }))]), tb])]));
  }

  function openTab() {
    document.querySelectorAll('button.tab').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === 'monitor')); });
    var conn_ = $('conn'); if (conn_) conn_.hidden = true;
    var d = $('drill'); if (d) d.remove();
    load();
  }

  var bar = document.querySelector('button.tab') && document.querySelector('button.tab').parentNode;
  if (bar) {
    var b = h('button', { class: 'tab', 'data-v': 'monitor', text: 'Überwachung' });
    b.onclick = openTab;
    bar.appendChild(b);
  }
})();
