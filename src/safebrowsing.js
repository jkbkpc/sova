// Ochrana pred podvodnými (phishing) a nebezpečnými (malvér) stránkami.
// Verejné zoznamy sa sťahujú každých 30 minút (len ak sa na serveri zmenili) a kontrola prebieha
// priamo v Sove – adresy, ktoré navštíviš, sa nikam neposielajú.
// V pamäti sú len 53-bitové odtlačky (hash) domén, nie texty – aj státisíce záznamov zaberú pár MB.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');
const { net } = require('electron');
const { getDomain } = require('tldts-experimental');
const { log } = require('./log');

const REFRESH_MS = 30 * 60 * 1000;

const DEFAULT_LISTS = [
  { id: 'urlhaus', name: 'URLhaus (abuse.ch)', kind: 'malware', type: 'hosts', urls: ['https://urlhaus.abuse.ch/downloads/hostfile/'] },
  { id: 'phishingarmy', name: 'Phishing Army', kind: 'phishing', type: 'domains', urls: ['https://phishing.army/download/phishing_army_blocklist.txt'] },
  { id: 'certpl', name: 'CERT Polska', kind: 'phishing', type: 'domains', urls: ['https://hole.cert.pl/domains/v2/domains.txt', 'https://hole.cert.pl/domains/domains.txt'] },
  { id: 'openphish', name: 'OpenPhish', kind: 'phishing', type: 'urls', urls: ['https://openphish.com/feed.txt'] },
];
// test: SOVA_SB_LISTS='[{"id":"t","kind":"phishing","type":"domains","urls":["http://…"]}]'
const LISTS = process.env.SOVA_SB_LISTS ? JSON.parse(process.env.SOVA_SB_LISTS) : DEFAULT_LISTS;

// veľké a dôveryhodné domény – zoznamy domén ich nikdy nezablokujú celé (konkrétne podvodné adresy áno)
const PROTECTED = new Set(['google.com', 'google.sk', 'youtube.com', 'gmail.com', 'microsoft.com', 'live.com', 'office.com',
  'microsoftonline.com', 'outlook.com', 'sharepoint.com', 'windows.net', 'azure.com', 'apple.com', 'icloud.com', 'github.com',
  'githubusercontent.com', 'gitlab.com', 'amazon.com', 'amazonaws.com', 'cloudflare.com', 'facebook.com', 'instagram.com',
  'whatsapp.com', 'linkedin.com', 'wikipedia.org', 'mozilla.org', 'fortinet.com', 'fortiguard.com', 'dropbox.com',
  'adobe.com', 'zoom.us', 'slack.com', 'cloudfront.net', 'akamaihd.net', 'googleusercontent.com', 'blogspot.com',
  'wordpress.com', 'web.app', 'firebaseapp.com', 'pages.dev', 'workers.dev', 'netlify.app', 'vercel.app', 'github.io']);

// cyrb53 – rýchly 53-bitový hash (rovnaký kód beží aj v pracovnom vlákne)
const HASH_SRC = `function h53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
function normUrl(u) {
  try {
    const x = new URL(u.trim());
    if (!/^https?:$/.test(x.protocol)) return '';
    let p = x.pathname.replace(/\\/+$/, '');
    return (x.hostname.toLowerCase().replace(/\\.$/, '') + p + x.search).replace(/^www\\./, '');
  } catch { return ''; }
}`;
const h53 = new Function(`${HASH_SRC}; return h53;`)();
const normUrl = new Function(`${HASH_SRC}; return normUrl;`)();

// spracovanie zoznamu v samostatnom vlákne (státisíce riadkov nezdržia okno)
const WORKER_SRC = `const { parentPort } = require('worker_threads');
${HASH_SRC}
parentPort.on('message', ({ text, type }) => {
  const out = [];
  for (let line of text.split(/\\r?\\n/)) {
    line = line.trim();
    if (!line || line[0] === '#' || line[0] === '!') continue;
    let key = '';
    if (type === 'urls') key = normUrl(line);
    else {
      if (type === 'hosts') { const p = line.split(/\\s+/); line = p[1] || ''; }
      key = line.toLowerCase().replace(/^\\*\\./, '').replace(/^www\\./, '').replace(/\\.$/, '');
      if (!key || key === 'localhost' || key.indexOf('.') < 0 || /[\\/\\s]/.test(key)) key = '';
    }
    if (key) out.push(h53(key));
  }
  const arr = Float64Array.from(out).sort();
  parentPort.postMessage(arr, [arr.buffer]);
});`;

function parse(text, type) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_SRC, { eval: true });
    w.once('message', (arr) => { resolve(arr); w.terminate(); });
    w.once('error', (e) => { reject(e); w.terminate(); });
    w.postMessage({ text, type });
  });
}
function has(arr, x) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = arr[mid];
    if (v === x) return true;
    if (v < x) lo = mid + 1; else hi = mid - 1;
  }
  return false;
}

class SafeBrowsing extends EventEmitter {
  constructor(dir, settings) {
    super();
    this.dir = path.join(dir, 'safebrowsing');
    this.settings = settings;
    this.sets = new Map();            // id → Float64Array (zoradené odtlačky)
    this.meta = {};                   // id → { etag, lastModified, fetched, count, error }
    this.allowed = new Set();         // domény, pri ktorých si zvolil „Pokračovať“ (do zatvorenia Sovy)
    this.checking = false;
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
    try { this.meta = JSON.parse(fs.readFileSync(path.join(this.dir, 'meta.json'), 'utf8')); } catch {}
  }

  get enabled() { return this.settings.get('safeBrowsing') !== false; }

  async start() {
    // najprv zoznamy z disku (funguje aj bez internetu), potom kontrola aktualizácií
    for (const l of LISTS) {
      try {
        const text = fs.readFileSync(path.join(this.dir, `${l.id}.txt`), 'utf8');
        this.sets.set(l.id, await parse(text, l.type));
      } catch { /* ešte nestiahnutý */ }
    }
    this.emit('change');
    this.refresh();
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  saveMeta() { try { fs.writeFileSync(path.join(this.dir, 'meta.json'), JSON.stringify(this.meta)); } catch {} }

  async refresh(force = false) {
    if (this.checking) return;
    this.checking = true;
    this.emit('change');
    try {
      for (const l of LISTS) {
        const m = this.meta[l.id] || (this.meta[l.id] = {});
        if (!force && m.fetched && Date.now() - m.fetched < REFRESH_MS - 60000 && this.sets.has(l.id)) continue;
        let done = false, lastErr = '';
        for (const url of l.urls) {
          try {
            const headers = {};
            if (this.sets.has(l.id) && m.url === url) {
              if (m.etag) headers['If-None-Match'] = m.etag;
              if (m.lastModified) headers['If-Modified-Since'] = m.lastModified;
            }
            const r = await net.fetch(url, { headers, cache: 'no-store' });
            if (r.status === 304) { m.fetched = Date.now(); m.error = ''; done = true; break; }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const text = await r.text();
            const arr = await parse(text, l.type);
            if (arr.length === 0 && this.sets.get(l.id)?.length > 100) throw new Error('prázdny zoznam');
            this.sets.set(l.id, arr);
            fs.writeFileSync(path.join(this.dir, `${l.id}.txt`), text);
            Object.assign(m, { url, etag: r.headers.get('etag') || '', lastModified: r.headers.get('last-modified') || '',
              fetched: Date.now(), updated: Date.now(), count: arr.length, error: '' });
            done = true;
            break;
          } catch (e) { lastErr = String(e.message || e).slice(0, 120); }
        }
        if (!done) { m.error = lastErr; m.failedAt = Date.now(); log('ochrana: zoznam', l.id, 'sa nepodarilo stiahnuť:', lastErr); }
      }
      this.saveMeta();
    } finally {
      this.checking = false;
      this.emit('change');
    }
  }

  // je adresa nebezpečná? → { kind: 'phishing'|'malware', list, host } alebo null
  check(url) {
    if (!this.enabled || !this.sets.size) return null;
    let u;
    try { u = new URL(url); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (this.allowed.has(host)) return null;
    // doména a jej nadradené domény až po registrovanú (a.b.podvod.sk → b.podvod.sk → podvod.sk)
    const reg = getDomain(host) || host;
    const cands = [];
    if (!PROTECTED.has(reg)) {
      let h = host.replace(/^www\./, '');
      while (h) {
        cands.push(h53(h));
        if (h === reg) break;
        const i = h.indexOf('.');
        if (i < 0) break;
        h = h.slice(i + 1);
      }
    }
    const nu = normUrl(url);
    const urlHash = nu ? h53(nu) : null;
    for (const l of LISTS) {
      const arr = this.sets.get(l.id);
      if (!arr) continue;
      const hit = l.type === 'urls' ? urlHash !== null && has(arr, urlHash) : cands.some((c) => has(arr, c));
      if (hit) return { kind: l.kind, list: l.name, host };
    }
    return null;
  }

  allow(host) { if (host) this.allowed.add(String(host).toLowerCase()); }

  state() {
    const lists = LISTS.map((l) => ({ id: l.id, name: l.name, kind: l.kind, count: this.sets.get(l.id)?.length || 0,
      updated: this.meta[l.id]?.updated || 0, fetched: this.meta[l.id]?.fetched || 0, error: this.meta[l.id]?.error || '' }));
    return { enabled: this.enabled, checking: this.checking, total: lists.reduce((s, l) => s + l.count, 0), lists };
  }
}

module.exports = { SafeBrowsing, h53, normUrl };
