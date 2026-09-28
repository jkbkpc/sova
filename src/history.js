// História prehliadania + zoznam navštívených domén pre návrhy v adresnom riadku.
// Všetko je uložené lokálne v %APPDATA%\Sova\history.json.
const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 50000;
const MAX_AGE_MS = 180 * 24 * 3600 * 1000; // pol roka

// porovnávanie bez diakritiky a veľkosti písmen („zdravie“ nájde „Zdravie“, „cesky“ nájde „český“)
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

class History {
  constructor(dir) {
    this.file = path.join(dir, 'history.json');
    this.entries = [];   // { id, url, title, ts } – od najstaršieho po najnovší
    this.domains = {};   // key (host bez www.) -> { host, scheme, visits, last, title, favicon }
    this.nextId = 1;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.entries = d.entries || [];
      this.domains = d.domains || {};
      this.nextId = (this.entries.at(-1)?.id || 0) + 1;
    } catch { /* prvé spustenie */ }
    this.prune();
    this.timer = null;
  }

  static parse(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u;
    } catch { return null; }
  }
  static keyOf(host) { return host.toLowerCase().replace(/^www\./, ''); }

  // ------------------------------------------------------------- zápis
  add(url, title) {
    const u = History.parse(url);
    if (!u) return;
    const now = Date.now();
    const last = this.entries.at(-1);
    if (last && last.url === url) {           // obnovenie tej istej stránky = nový čas, nie nový záznam
      last.ts = now;
      if (title) last.title = title;
    } else {
      this.entries.push({ id: this.nextId++, url, title: title || '', ts: now });
    }
    const key = History.keyOf(u.host);
    const d = this.domains[key] || (this.domains[key] = { host: u.host, scheme: u.protocol.slice(0, -1), visits: 0, last: 0, title: '', favicon: '' });
    d.host = u.host;
    d.scheme = u.protocol.slice(0, -1);
    d.visits++;
    d.last = now;
    this.scheduleSave();
  }

  updateTitle(url, title) {
    if (!title) return;
    for (let i = this.entries.length - 1; i >= Math.max(0, this.entries.length - 30); i--) {
      if (this.entries[i].url === url) { this.entries[i].title = title; break; }
    }
    const u = History.parse(url);
    const d = u && this.domains[History.keyOf(u.host)];
    // názov domény berieme z úvodnej stránky (napr. „YouTube“), nie z článkov
    if (d && (u.pathname === '/' || !d.title)) d.title = title;
    this.scheduleSave();
  }

  setFavicon(url, favicon) {
    const u = History.parse(url);
    const d = u && this.domains[History.keyOf(u.host)];
    if (d && favicon && d.favicon !== favicon) { d.favicon = favicon; this.scheduleSave(); }
  }

  // Zmazanie vybraných záznamov (zoznam id)
  removeMany(ids) {
    const set = new Set(ids);
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !set.has(e.id));
    if (this.entries.length !== before) this.afterRemove();
    return before - this.entries.length;
  }

  // Zmazanie všetkého za posledných `ms` milisekúnd (0 = celá história)
  removeSince(ms) {
    if (!ms) { const n = this.entries.length; this.entries = []; this.domains = {}; this.save(); return n; }
    const min = Date.now() - ms;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.ts < min);
    this.afterRemove();
    return before - this.entries.length;
  }

  // Po mazaní prepočítať domény zo zostávajúcich záznamov – zmazaná stránka sa prestane navrhovať
  afterRemove() {
    const old = this.domains;
    const next = {};
    for (const e of this.entries) {
      const u = History.parse(e.url);
      if (!u) continue;
      const key = History.keyOf(u.host);
      const d = next[key] || (next[key] = { host: u.host, scheme: u.protocol.slice(0, -1), visits: 0, last: 0,
        title: old[key]?.title || '', favicon: old[key]?.favicon || '' });
      d.visits++;
      if (e.ts >= d.last) { d.last = e.ts; d.host = u.host; d.scheme = u.protocol.slice(0, -1); }
    }
    this.domains = next;
    this.save();
  }

  prune() {
    const min = Date.now() - MAX_AGE_MS;
    this.entries = this.entries.filter((e) => e.ts >= min).slice(-MAX_ENTRIES);
    for (const [k, d] of Object.entries(this.domains)) if (d.last < min) delete this.domains[k];
  }

  scheduleSave() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 3000);
  }

  save() {
    clearTimeout(this.timer);
    try {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ entries: this.entries, domains: this.domains }));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) { console.error('[history]', e.message); }
  }

  // ------------------------------------------------------------- čítanie
  // Najnovšie záznamy (voliteľne vyhľadávanie), stránkovanie cez `before` (id)
  query({ q = '', before = Infinity, limit = 150 } = {}) {
    const nq = norm(q.trim());
    const out = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (e.id >= before) continue;
      if (nq && !norm(e.title).includes(nq) && !norm(e.url).includes(nq)) continue;
      const u = History.parse(e.url);
      const d = u && this.domains[History.keyOf(u.host)];
      out.push({ ...e, host: u ? u.host : '', favicon: d?.favicon || '' });
    }
    return out;
  }

  // Návrhy domén pre adresný riadok – len domény, nie konkrétne podstránky
  suggest(text, limit = 5) {
    const q = text.trim().toLowerCase().replace(/^https?:\/\//, '');
    if (!q || /[\s/?#]/.test(q)) return [];
    const qk = q.replace(/^www\./, '');
    const now = Date.now();
    const res = [];
    for (const [key, d] of Object.entries(this.domains)) {
      const sub = key.includes('.') ? key.slice(key.indexOf('.') + 1) : '';
      const direct = key.startsWith(qk) || d.host.toLowerCase().startsWith(q);
      if (!direct && !(sub.includes('.') && sub.startsWith(qk))) continue;
      const days = (now - d.last) / 86400000;
      const score = (direct ? 1000 : 0) + d.visits / (1 + days / 7);
      res.push({ key, host: d.host, url: `${d.scheme}://${d.host}/`, title: d.title, favicon: d.favicon, direct, score });
    }
    res.sort((a, b) => b.score - a.score || a.key.length - b.key.length);
    return res.slice(0, limit);
  }
}

module.exports = { History };
