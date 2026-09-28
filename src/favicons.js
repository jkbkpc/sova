// Ikony stránok pre záložky: stiahnutie a zmenšenie na malý obrázok (data: URL uložený priamo v záložke),
// vyhľadanie ikony podľa <link rel="icon"> a načítanie ikon z profilu Chrome/Brave/Edge pri importe.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nativeImage } = require('electron');

const MAX_RAW = 64 * 1024;      // nezmenšiteľné formáty (SVG, ICO mimo Windows) do 64 kB
const SIZE = 32;

const hostKey = (url) => { try { return new URL(url).host.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

function sniff(buf, type) {
  const t = String(type || '').split(';')[0].trim().toLowerCase();
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  const head = buf.slice(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  if (t.startsWith('image/') && !head.startsWith('<')) return t;
  return '';                       // HTML chybová stránka a pod. → nie je to ikona
}

// Obrázok → malý PNG data: URL (alebo pôvodný, ak ho nevieme spracovať a je malý)
function toDataUrl(buf, type) {
  if (!buf || !buf.length) return '';
  const mime = sniff(buf, type);
  if (!mime) return '';
  if (mime !== 'image/svg+xml') {
    try {
      let img = nativeImage.createFromBuffer(buf);
      if (!img.isEmpty()) {
        const { width, height } = img.getSize();
        if (width > SIZE || height > SIZE) img = img.resize({ width: SIZE, height: SIZE, quality: 'best' });
        return img.toDataURL();
      }
    } catch { /* napr. ICO na Linuxe */ }
  }
  if (buf.length > MAX_RAW) return '';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function fetchWithTimeout(session, url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await session.fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { Accept: 'image/*,*/*;q=0.5' } });
  } finally { clearTimeout(t); }
}

async function fetchIcon(session, iconUrl) {
  if (!iconUrl) return '';
  if (iconUrl.startsWith('data:')) {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(iconUrl);
    if (!m) return '';
    const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
    return toDataUrl(buf, m[1]);
  }
  if (!/^https?:/i.test(iconUrl)) return '';
  try {
    const r = await fetchWithTimeout(session, iconUrl);
    if (!r.ok) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 2 * 1024 * 1024) return '';
    return toDataUrl(buf, r.headers.get('content-type'));
  } catch (e) { if (process.env.SOVA_DEBUG) console.log('[fav]', iconUrl, e.message); return ''; }
}

// Nájde ikonu stránky: stiahne jej HTML, prečíta <link rel="icon">, inak /favicon.ico
async function discoverIcon(session, pageUrl) {
  if (!/^https?:/i.test(pageUrl)) return '';
  let finalUrl = pageUrl, html = '';
  try {
    const r = await fetchWithTimeout(session, pageUrl, 10000);
    finalUrl = r.url || pageUrl;
    if (/html/i.test(r.headers.get('content-type') || '')) html = (await r.text()).slice(0, 300000);
  } catch { /* stránka nedostupná – skúsime aspoň /favicon.ico */ }
  const cands = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (/\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1] || '').toLowerCase();
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const h = href && (href[1] ?? href[2] ?? href[3]);
    if (!h || !/\bicon\b/.test(rel) || /mask-icon/.test(rel)) continue;
    const sizes = parseInt(/\bsizes\s*=\s*["']?(\d+)/i.exec(tag)?.[1] || '0', 10);
    // poradie: rel="icon" s rozumnou veľkosťou, potom apple-touch-icon
    const score = (rel.includes('apple') ? 100 : 0) + (sizes ? Math.abs(sizes - SIZE) : 16);
    try { cands.push({ url: new URL(h.replace(/&amp;/g, '&'), finalUrl).href, score }); } catch {}
  }
  cands.sort((a, b) => a.score - b.score);
  try { cands.push({ url: new URL('/favicon.ico', finalUrl).href }); } catch {}
  for (const c of cands.slice(0, 4)) {
    const icon = await fetchIcon(session, c.url);
    if (icon) return icon;
  }
  return '';
}

// Ikony z profilu Chromium (súbor „Favicons“ – SQLite). Vracia { byUrl, byHost } s data: URL.
function readChromiumFavicons(profileDir) {
  const src = path.join(profileDir, 'Favicons');
  const byUrl = new Map(), byHost = new Map();
  if (!fs.existsSync(src)) return { byUrl, byHost };
  // prehliadač môže mať súbor otvorený → pracujeme s kópiou
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sova-fav-'));
  const copy = path.join(tmp, 'Favicons');
  let db;
  try {
    fs.copyFileSync(src, copy);
    for (const ext of ['-journal', '-wal']) {
      if (fs.existsSync(src + ext)) try { fs.copyFileSync(src + ext, copy + ext); } catch {}
    }
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(copy, { readOnly: true });
    const rows = db.prepare(`SELECT m.page_url AS page, b.image_data AS data, b.width AS w
      FROM icon_mapping m JOIN favicon_bitmaps b ON b.icon_id = m.icon_id
      WHERE b.image_data IS NOT NULL AND length(b.image_data) > 0`).all();
    const best = new Map();          // page -> {data, w}
    const rank = (w) => (w === SIZE ? 0 : w === 16 ? 1 : w > SIZE ? 2 + w / 1000 : 3);
    for (const r of rows) {
      const cur = best.get(r.page);
      if (!cur || rank(r.w) < rank(cur.w)) best.set(r.page, r);
    }
    for (const [page, r] of best) {
      const icon = toDataUrl(Buffer.from(r.data), 'image/png');
      if (!icon) continue;
      byUrl.set(page, icon);
      const h = hostKey(page);
      if (h && !byHost.has(h)) byHost.set(h, icon);
    }
  } catch (e) {
    console.warn('[favicons] import ikon zlyhal:', e.message);
  } finally {
    try { db?.close(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  return { byUrl, byHost };
}

module.exports = { toDataUrl, fetchIcon, discoverIcon, readChromiumFavicons, hostKey };
