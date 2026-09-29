// Informácie o stránke (tlačidlo vľavo v adresnom riadku): zabezpečenie a certifikát,
// cookies a údaje stránky, oprávnenia, blokovanie reklám a uspávanie pre danú stránku.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shell } = require('electron');
const { parse } = require('tldts-experimental');
const { Bubble } = require('./bubble');

const PERM_LABELS = {
  media: 'Kamera a mikrofón', geolocation: 'Poloha', notifications: 'Upozornenia',
  'clipboard-read': 'Čítanie schránky', 'display-capture': 'Zdieľanie obrazovky',
};

// posledný overený certifikát pre každý server (nemení overovanie – výsledok necháva na Chromium);
// jeden zoznam pre každú reláciu (bežné okná / inkognito), zdieľaný všetkými oknami
const certsBySession = new WeakMap();
function certsFor(session) {
  let certs = certsBySession.get(session);
  if (!certs) {
    certs = new Map();
    certsBySession.set(session, certs);
    session.setCertificateVerifyProc((req, cb) => {
      certs.set(req.hostname, { cert: req.certificate, result: req.verificationResult });
      if (certs.size > 2000) certs.delete(certs.keys().next().value);
      cb(-3);
    });
  }
  return certs;
}

function setupSiteInfo({ win, id, tabs, session, settings, adblock, certExceptions, permDecisions, pushState }) {
  const certs = certsFor(session);

  const activeUrl = () => {
    const a = tabs.active;
    if (!a) return '';
    return a.view && !a.view.webContents.isDestroyed() ? a.view.webContents.getURL() : a.url;
  };

  function security(url) {
    if (!url || tabs.isInternal(url)) return 'none';
    let u;
    try { u = new URL(url); } catch { return 'none'; }
    if (u.protocol === 'sova:') return 'internal';
    if (u.protocol === 'file:') return 'file';
    if (u.protocol === 'http:') return 'insecure';
    if (u.protocol === 'https:') {
      const c = certs.get(u.hostname);
      return certExceptions.has(u.host) || (c?.result && c.result !== 'net::OK') ? 'cert-error' : 'secure';
    }
    return 'none';
  }

  function certInfo(hostname) {
    const c = certs.get(hostname);
    if (!c) return null;
    const chain = [];
    for (let x = c.cert, i = 0; x && i < 6; x = x.issuerCert, i++) {
      chain.push(x.subject?.commonName || x.subjectName);
      if (x.issuerCert && x.issuerCert.fingerprint === x.fingerprint) break; // koreňový (sám sebe vydavateľom)
    }
    return {
      subject: c.cert.subject?.commonName || c.cert.subjectName,
      org: (c.cert.subject?.organizations || []).join(', '),
      issuer: c.cert.issuer?.commonName || c.cert.issuerName,
      issuerOrg: (c.cert.issuer?.organizations || []).join(', '),
      validFrom: c.cert.validStart * 1000,
      validTo: c.cert.validExpiry * 1000,
      serial: c.cert.serialNumber,
      fingerprint: c.cert.fingerprint,
      chain,
      result: c.result,
    };
  }

  async function data() {
    const url = activeUrl();
    const sec = security(url);
    const out = { url, security: sec };
    if (!/^https?:/i.test(url)) return out;
    const u = new URL(url);
    const domain = parse(url).domain || u.hostname;
    out.host = u.host;
    out.origin = u.origin;
    out.cert = sec === 'secure' || sec === 'cert-error' ? certInfo(u.hostname) : null;
    try {
      const own = await session.cookies.get({ url: u.origin });
      const site = await session.cookies.get({ domain });
      out.cookies = own.length;
      out.siteCookies = site.length;
    } catch { out.cookies = 0; }
    out.perms = [];
    for (const [key, allowed] of permDecisions) {
      const [origin, perm] = key.split('|');
      if (origin === u.origin) out.perms.push({ perm, label: PERM_LABELS[perm] || perm, state: allowed ? 'allow' : 'block' });
    }
    out.adblock = adblock.enabled;
    out.allowlisted = adblock.isAllowlisted(url);
    out.blocked = tabs.active?.wcId ? adblock.countFor(tabs.active.wcId) : 0;
    out.neverSleep = tabs.matchesList(url, 'neverSleep');
    out.domain = domain;
    return out;
  }

  const bubble = new Bubble({ win, name: `sib${id}`, file: 'siteinfo-bubble.html', width: 370, align: 'left' });
  const refresh = async () => { if (bubble.visible) bubble.send('data', await data()); };
  bubble.on('ready', refresh);

  bubble.on('viewcert', () => {
    const url = activeUrl();
    let hostname;
    try { hostname = new URL(url).hostname; } catch { return; }
    const c = certs.get(hostname);
    if (!c) return;
    // Windows otvorí .crt súbor vo vlastnom okne s podrobnosťami certifikátu a celou cestou dôvery
    const file = path.join(os.tmpdir(), `sova-${hostname.replace(/[^a-z0-9.-]/gi, '_')}.crt`);
    fs.writeFileSync(file, c.cert.data);
    bubble.hide();
    shell.openPath(file);
  });

  bubble.on('clear-site', async () => {
    const url = activeUrl();
    let u;
    try { u = new URL(url); } catch { return; }
    const domain = parse(url).domain || u.hostname;
    for (const c of await session.cookies.get({ domain })) {
      const cu = `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path}`;
      await session.cookies.remove(cu, c.name).catch(() => {});
    }
    await session.clearStorageData({ origin: u.origin }).catch(() => {});
    bubble.hide();
    tabs.wc()?.reload();
  });

  bubble.on('perm', (perm, state) => {
    const url = activeUrl();
    let origin;
    try { origin = new URL(url).origin; } catch { return; }
    const key = `${origin}|${perm}`;
    if (state === 'ask') permDecisions.delete(key); else permDecisions.set(key, state === 'allow');
    refresh();
  });

  bubble.on('toggle-adblock', () => {
    const url = activeUrl();
    const host = tabs.host(url);
    if (!host) return;
    const list = settings.get('allowlist');
    const on = adblock.isAllowlisted(url);
    settings.set({ allowlist: on ? list.filter((d) => d !== host && !host.endsWith('.' + d)) : [...list, host] });
    tabs.wc()?.reload();
    pushState();
    refresh();
  });

  bubble.on('toggle-sleep', () => {
    const host = tabs.host(activeUrl());
    if (!host) return;
    const never = tabs.matchesList(activeUrl(), 'neverSleep');
    const list = settings.get('neverSleep').filter((d) => d !== host && !host.endsWith('.' + d));
    settings.set({ neverSleep: never ? list : [...list, host] });
    pushState();
    refresh();
  });

  bubble.on('forget-cert', () => {
    try { certExceptions.delete(new URL(activeUrl()).host); } catch {}
    bubble.hide();
    tabs.wc()?.reload();
    pushState();
  });

  bubble.on('settings', () => { bubble.hide(); tabs.openInternal('settings'); });

  return {
    bubble,
    state: () => ({ security: security(activeUrl()) }),
    toggle: (rect) => { bubble.toggle(rect); setTimeout(refresh, 50); },
  };
}

module.exports = { setupSiteInfo };
