'use strict';
// Überwachung: Konsole, UniFi-Geräte und Clients im IoT-Netz. Schickt bei Ausfall und Wiederkehr eine E-Mail über Resend.
// Der Zustand liegt nur im Arbeitsspeicher. Nach einem Neustart lernt die Überwachung Geräte und Clients neu.
//
// Variablen (alle optional ausser den ersten drei):
//   RESEND_API_KEY        API-Key von resend.com
//   ALERT_TO              Empfänger, mehrere mit Komma
//   MONITOR_HOST_MATCH    Teil des Konsolennamens (z. B. Dornacherstrasse), oder MONITOR_HOST_IDS mit Host-IDs
//   ALERT_FROM            Absender, Standard: UniFi Monitor <onboarding@resend.dev> (nur für Tests, eigene Domain in Resend einrichten)
//   IOT_SSID              WLAN-Name des IoT-Netzes (Standard Elevate_IOT)
//   IOT_NETWORK           Netzname in UniFi (Standard VLAN_IOT)
//   IOT_IP_PREFIX         IP-Anfang des IoT-Netzes, z. B. 192.168.4.  (hilft, wenn die alte API nicht erreichbar ist)
//   IOT_WATCH_MACS        MAC-Adressen, die immer überwacht werden (Komma), auch wenn sie nie online waren
//   ALERT_AFTER_MIN       Minuten offline, bevor ein Gerät gemeldet wird (Standard 5)
//   ALERT_CLIENT_AFTER_MIN  dasselbe für Clients (Standard 10)
//   MONITOR_INTERVAL_SEC  Abfrageintervall (Standard 60, mindestens 5)

module.exports = function createMonitor(deps) {
  const { upstream, conn, NET } = deps;
  const env = deps.env || process.env;
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const mac = (v) => String(v || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  const prettyMac = (m) => (m.match(/.{1,2}/g) || []).join(':');

  const cfg = {
    apiKey: env.RESEND_API_KEY || '',
    resendUrl: env.RESEND_URL || 'https://api.resend.com/emails',
    to: list(env.ALERT_TO),
    from: env.ALERT_FROM || 'UniFi Monitor <onboarding@resend.dev>',
    hostMatch: String(env.MONITOR_HOST_MATCH || '').trim().toLowerCase(),
    hostIds: list(env.MONITOR_HOST_IDS),
    iotSsid: String(env.IOT_SSID || 'Elevate_IOT').trim(),
    iotNetwork: String(env.IOT_NETWORK || 'VLAN_IOT').trim(),
    iotIpPrefix: String(env.IOT_IP_PREFIX || '').trim(),
    watch: new Set(list(env.IOT_WATCH_MACS).map(mac).filter(Boolean)),
    afterMs: Math.max(0.02, Number(env.ALERT_AFTER_MIN || 5)) * 60000,
    clientAfterMs: Math.max(0.02, Number(env.ALERT_CLIENT_AFTER_MIN || 10)) * 60000,
    intervalMs: Math.max(5, Number(env.MONITOR_INTERVAL_SEC || 60)) * 1000,
  };

  function missing() {
    const m = [];
    if (!cfg.apiKey) m.push('RESEND_API_KEY');
    if (!cfg.to.length) m.push('ALERT_TO');
    if (!cfg.hostMatch && !cfg.hostIds.length) m.push('MONITOR_HOST_MATCH oder MONITOR_HOST_IDS');
    return m;
  }

  const items = new Map(); // key -> { key, kind, name, detail, hostId, hostName, status, since, alerted, lastSeen }
  let pending = [];        // Ereignisse, die noch nicht versendet werden konnten
  let timer = null, running = false;
  const info = { lastRun: null, lastOk: null, lastError: null, lastMail: null, lastMailError: null, mailsSent: 0, notes: [] };

  const get = (o, p) => p.split('.').reduce((c, k) => (c == null ? undefined : c[k]), o);
  const hostName = (x) => get(x, 'reportedState.name') || get(x, 'reportedState.hostname') || get(x, 'userData.name') || x.id;

  function mark(key, meta, up, now, afterMs, events) {
    let it = items.get(key);
    if (!it) {
      it = Object.assign({ key, status: up ? 'up' : 'down', since: now, alerted: false, lastSeen: up ? now : null }, meta);
      items.set(key, it);
    }
    Object.assign(it, meta);
    if (up) {
      it.lastSeen = now;
      if (it.status === 'down') {
        if (it.alerted) events.push({ type: 'up', it: Object.assign({}, it), downMs: now - it.since });
        it.status = 'up'; it.since = now; it.alerted = false;
      }
    } else {
      if (it.status === 'up') { it.status = 'down'; it.since = now; it.alerted = false; }
      if (!it.alerted && now - it.since >= afterMs) {
        it.alerted = true;
        events.push({ type: 'down', it: Object.assign({}, it) });
      }
    }
  }

  async function pagedGet(hostId, path) {
    let all = [], offset = 0, total = Infinity, guard = 0;
    const sep = path.includes('?') ? '&' : '?';
    while (offset < total && guard++ < 10) {
      const r = await upstream(conn(hostId, path + sep + 'limit=200&offset=' + offset));
      if (r.status !== 200) throw new Error('HTTP ' + r.status + ' bei ' + path.split('/').slice(-1)[0]);
      const page = Array.isArray(r.body && r.body.data) ? r.body.data : [];
      all = all.concat(page);
      total = r.body && typeof r.body.totalCount === 'number' ? r.body.totalCount : all.length;
      if (!page.length) break;
      offset += page.length;
    }
    return all;
  }

  const DEV_DOWN = ['OFFLINE', 'ISOLATED', 'CONNECTION_INTERRUPTED'];

  async function pollHost(host, hname, now, events) {
    const sr = await upstream(conn(host.id, NET + '/sites'));
    const site = sr.status === 200 && Array.isArray(sr.body && sr.body.data) ? sr.body.data[0] : null;
    if (!site) throw new Error('Site nicht abrufbar (HTTP ' + sr.status + ')');
    const sid = site.id;

    // Geräte
    const devices = await pagedGet(host.id, NET + '/sites/' + sid + '/devices');
    for (const d of devices) {
      const st = String(d.state).toUpperCase();
      if (st === 'PENDING_ADOPTION') continue;
      mark('dev:' + host.id + ':' + mac(d.macAddress),
        { kind: 'device', name: d.name || d.model || d.macAddress, detail: [d.model, d.ipAddress].filter(Boolean).join(' · '), hostId: host.id, hostName: hname },
        !DEV_DOWN.includes(st), now, cfg.afterMs, events);
    }

    // Clients im IoT-Netz
    const clients = await pagedGet(host.id, NET + '/sites/' + sid + '/clients');
    let legacy = {}, legacyOk = false;
    const lr = await upstream(conn(host.id, '/proxy/network/api/s/' + (site.internalReference || 'default') + '/stat/sta'));
    if (lr.status === 200 && Array.isArray(lr.body && lr.body.data)) {
      legacyOk = true;
      lr.body.data.forEach((x) => { if (x && x.mac) legacy[mac(x.mac)] = x; });
    }
    const canIdentify = legacyOk || !!cfg.iotIpPrefix || cfg.watch.size > 0;
    info.notes = info.notes.filter((n) => n.hostId !== host.id);
    if (!canIdentify) info.notes.push({ hostId: host.id, text: 'IoT-Clients nicht erkennbar: alte API nicht erreichbar. IOT_IP_PREFIX oder IOT_WATCH_MACS setzen.' });
    else if (!legacyOk) info.notes.push({ hostId: host.id, text: 'Alte API nicht erreichbar, IoT-Clients werden nur über IP-Anfang und MAC-Liste erkannt.' });

    const present = new Set();
    for (const c of clients) {
      const m = mac(c.macAddress || c.mac);
      if (!m) continue;
      const l = legacy[m] || {};
      const ip = c.ipAddress || l.ip || '';
      const iot = cfg.watch.has(m) || (l.essid && l.essid === cfg.iotSsid) || (l.network && l.network === cfg.iotNetwork) || (cfg.iotIpPrefix && String(ip).startsWith(cfg.iotIpPrefix));
      if (!iot) continue;
      present.add(m);
      mark('cli:' + host.id + ':' + m,
        { kind: 'client', name: c.name || c.hostname || l.name || l.hostname || m, detail: [ip, l.essid].filter(Boolean).join(' · '), hostId: host.id, hostName: hname, mac: m },
        true, now, cfg.clientAfterMs, events);
    }
    // Bekannte IoT-Clients, die jetzt fehlen, und überwachte MACs, die nie online waren
    for (const it of Array.from(items.values())) {
      if (it.kind === 'client' && it.hostId === host.id && !present.has(it.mac)) mark(it.key, {}, false, now, cfg.clientAfterMs, events);
    }
    for (const m of cfg.watch) {
      const key = 'cli:' + host.id + ':' + m;
      if (!items.has(key) && !present.has(m)) {
        mark(key, { kind: 'client', name: prettyMac(m), detail: 'noch nie gesehen', hostId: host.id, hostName: hname, mac: m }, false, now, cfg.clientAfterMs, events);
      }
    }
  }

  async function poll() {
    if (running) return;
    running = true;
    const now = Date.now(), events = [];
    info.lastRun = new Date(now).toISOString();
    try {
      const hr = await upstream('/v1/hosts');
      if (hr.status !== 200 || !Array.isArray(hr.body && hr.body.data)) throw new Error('Site Manager API: HTTP ' + hr.status);
      const targets = hr.body.data.filter((x) => cfg.hostIds.includes(x.id) || (cfg.hostMatch && String(hostName(x)).toLowerCase().includes(cfg.hostMatch)));
      if (!targets.length) throw new Error('Keine Konsole gefunden, die zu MONITOR_HOST_MATCH oder MONITOR_HOST_IDS passt');
      const errors = [];
      for (const host of targets) {
        const hname = hostName(host);
        const state = String(get(host, 'reportedState.state') || host.state || '').toLowerCase();
        const up = !/offline|disconnected|down/.test(state);
        mark('console:' + host.id, { kind: 'console', name: hname, detail: 'Konsole', hostId: host.id, hostName: hname }, up, now, cfg.afterMs, events);
        if (!up) continue; // Geräte und Clients sind dann nicht prüfbar, die Ausfallmeldung der Konsole genügt
        try { await pollHost(host, hname, now, events); } catch (e) { errors.push(hname + ': ' + e.message); }
      }
      info.lastError = errors.length ? errors.join('; ') : null;
      if (!errors.length) info.lastOk = new Date(now).toISOString();
    } catch (e) {
      info.lastError = String(e && e.message || e);
    }
    try { await flush(events); } finally { running = false; }
  }

  // ---------- Mail ----------
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const KIND = { console: 'Konsole', device: 'UniFi-Gerät', client: 'IoT-Client' };
  const fmtTime = (t) => new Intl.DateTimeFormat('de-CH', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Zurich' }).format(new Date(t));
  const fmtDur = (ms) => { const m = Math.round(ms / 60000); if (m < 1) return 'unter 1 min'; return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };

  function line(ev) {
    const it = ev.it, where = it.hostName && it.hostName !== it.name ? ' (' + it.hostName + ')' : '';
    if (ev.type === 'down') return KIND[it.kind] + ' «' + it.name + '»' + where + ' ist seit ' + fmtTime(it.since) + ' offline.' + (it.detail ? ' ' + it.detail : '');
    return KIND[it.kind] + ' «' + it.name + '»' + where + ' ist wieder online (Ausfall ' + fmtDur(ev.downMs) + ').';
  }

  function compose(events) {
    const downs = events.filter((e) => e.type === 'down'), ups = events.filter((e) => e.type === 'up');
    const first = events[0];
    let subject;
    if (events.length === 1) subject = (first.type === 'down' ? 'Offline: ' : 'Wieder online: ') + first.it.name + (first.it.hostName && first.it.hostName !== first.it.name ? ' · ' + first.it.hostName : '');
    else subject = (downs.length ? downs.length + ' offline' : '') + (downs.length && ups.length ? ', ' : '') + (ups.length ? ups.length + ' wieder online' : '') + ' · ' + (first.it.hostName || 'UniFi');
    const text = [downs.length ? 'Offline:' : '', ...downs.map((e) => '- ' + line(e)), ups.length ? '\nWieder online:' : '', ...ups.map((e) => '- ' + line(e))].filter((x) => x !== '').join('\n');
    const li = (e, c) => '<li style="margin:6px 0;color:' + c + '">' + esc(line(e)) + '</li>';
    const html = '<div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:22px;color:#000">'
      + '<div style="border-left:4px solid #F6BB12;padding-left:10px;font-weight:650;margin-bottom:12px">UniFi Überwachung</div>'
      + (downs.length ? '<p style="margin:0 0 4px;font-weight:600">Offline</p><ul style="margin:0 0 12px;padding-left:20px">' + downs.map((e) => li(e, '#b42318')).join('') + '</ul>' : '')
      + (ups.length ? '<p style="margin:0 0 4px;font-weight:600">Wieder online</p><ul style="margin:0 0 12px;padding-left:20px">' + ups.map((e) => li(e, '#067647')).join('') + '</ul>' : '')
      + '<p style="margin:12px 0 0;color:#5f5f5f;font-size:13px">Automatische Meldung, gesendet ' + esc(fmtTime(Date.now())) + '.</p></div>';
    return { subject: '[UniFi] ' + subject, text, html };
  }

  async function sendMail(m) {
    const r = await fetch(cfg.resendUrl, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.from, to: cfg.to, subject: m.subject, text: m.text, html: m.html }),
      signal: AbortSignal.timeout(15000),
    });
    const t = await r.text();
    if (!r.ok) throw new Error('Resend HTTP ' + r.status + ': ' + t.slice(0, 200));
  }

  async function flush(events) {
    pending = pending.concat(events).slice(-100);
    if (!pending.length) return;
    if (missing().length) return;
    try {
      await sendMail(compose(pending));
      console.log(JSON.stringify({ t: new Date().toISOString(), mail: 'gesendet', ereignisse: pending.length }));
      info.mailsSent++; info.lastMail = new Date().toISOString(); info.lastMailError = null;
      pending = [];
    } catch (e) {
      info.lastMailError = String(e && e.message || e);
      console.log(JSON.stringify({ t: new Date().toISOString(), mail: 'fehler', fehler: info.lastMailError }));
    }
  }

  async function sendTest() {
    const m = missing().filter((x) => x === 'RESEND_API_KEY' || x === 'ALERT_TO');
    if (m.length) throw new Error('Fehlt: ' + m.join(', '));
    await sendMail({
      subject: '[UniFi] Testmeldung',
      text: 'Dies ist eine Testmeldung der UniFi Überwachung. Der Mailversand funktioniert.',
      html: '<div style="font-family:Inter,Arial,sans-serif;font-size:15px"><b>UniFi Überwachung</b><p>Dies ist eine Testmeldung. Der Mailversand funktioniert.</p></div>',
    });
    info.lastMail = new Date().toISOString(); info.lastMailError = null; info.mailsSent++;
  }

  function status() {
    const all = Array.from(items.values());
    const miss = missing();
    return {
      aktiv: miss.length === 0 && !!timer,
      fehlendeVariablen: miss,
      konfiguration: {
        empfaenger: cfg.to, absender: cfg.from, konsole: cfg.hostMatch || cfg.hostIds.join(', '),
        iotSsid: cfg.iotSsid, iotNetz: cfg.iotNetwork, iotIpAnfang: cfg.iotIpPrefix || null, ueberwachteMacs: cfg.watch.size,
        meldenNachMin: cfg.afterMs / 60000, clientsNachMin: cfg.clientAfterMs / 60000, intervallSek: cfg.intervalMs / 1000,
      },
      letzterLauf: info.lastRun, letzterErfolg: info.lastOk, letzterFehler: info.lastError,
      letzteMail: info.lastMail, letzterMailFehler: info.lastMailError, versendet: info.mailsSent, wartendeMeldungen: pending.length,
      hinweise: info.notes.map((n) => n.text),
      zaehlung: {
        konsolen: all.filter((i) => i.kind === 'console').length, geraete: all.filter((i) => i.kind === 'device').length, clients: all.filter((i) => i.kind === 'client').length,
        offline: all.filter((i) => i.status === 'down').length,
      },
      eintraege: all.map((i) => ({ art: KIND[i.kind], name: i.name, detail: i.detail, konsole: i.hostName, status: i.status, seit: new Date(i.since).toISOString(), gemeldet: i.alerted }))
        .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'down' ? -1 : 1)),
    };
  }

  function start() {
    const miss = missing();
    if (miss.length) { console.log('Überwachung aus. Es fehlt: ' + miss.join(', ')); return; }
    if (!process.env.UNIFI_API_KEY) { console.log('Überwachung aus. UNIFI_API_KEY fehlt'); return; }
    console.log('Überwachung läuft: Konsole «' + (cfg.hostMatch || cfg.hostIds.join(',')) + '», Intervall ' + cfg.intervalMs / 1000 + ' s');
    setTimeout(poll, 10000);
    timer = setInterval(poll, cfg.intervalMs);
  }

  return { start, status, sendTest, poll, _items: items };
};
