// Záložky: strom priečinkov (lišta záložiek + ostatné záložky), import z Chrome/Brave/Edge a z HTML.
// Uložené v %APPDATA%\Sova\bookmarks.json
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const BAR = 'bar';
const OTHER = 'other';

class Bookmarks extends EventEmitter {
  constructor(dir) {
    super();
    this.file = path.join(dir, 'bookmarks.json');
    this.root = null;
    try { this.root = JSON.parse(fs.readFileSync(this.file, 'utf8')).root; } catch { /* prvé spustenie */ }
    if (!this.root) {
      this.root = { id: 'root', type: 'folder', title: '', children: [
        { id: BAR, type: 'folder', title: 'Lišta záložiek', children: [] },
        { id: OTHER, type: 'folder', title: 'Ostatné záložky', children: [] },
      ] };
    }
    this.nextId = 1;
    this.walk((n) => { const m = /^b(\d+)$/.exec(n.id); if (m) this.nextId = Math.max(this.nextId, +m[1] + 1); });
    this.timer = null;
  }

  // ------------------------------------------------------------ pomocné
  walk(fn, node = this.root, parent = null) {
    if (fn(node, parent) === false) return false;
    for (const c of node.children || []) if (this.walk(fn, c, node) === false) return false;
    return true;
  }
  find(id) {
    let hit = null, par = null;
    this.walk((n, p) => { if (n.id === id) { hit = n; par = p; return false; } return true; });
    return hit ? { node: hit, parent: par } : null;
  }
  isAncestor(aId, node) {           // je `aId` predkom (alebo samotným) uzlom `node`?
    let yes = false;
    this.walk((n) => { if (n.id === aId) yes = true; return !yes; }, node);
    return yes;
  }
  static norm(url) { return String(url || '').replace(/#.*$/, '').replace(/\/$/, ''); }
  findByUrl(url) {
    const u = Bookmarks.norm(url);
    if (!u) return null;
    let hit = null;
    this.walk((n) => { if (n.type === 'url' && Bookmarks.norm(n.url) === u) { hit = n; return false; } return true; });
    return hit;
  }
  newId() { return 'b' + this.nextId++; }
  changed() { this.emit('change'); this.scheduleSave(); }
  scheduleSave() { clearTimeout(this.timer); this.timer = setTimeout(() => this.save(), 800); }
  save() {
    clearTimeout(this.timer);
    try {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, root: this.root }));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) { console.error('[bookmarks]', e.message); }
  }

  // ------------------------------------------------------------ čítanie
  tree() { return this.root; }
  bar() { return this.find(BAR).node.children; }
  folders() {                        // plochý zoznam priečinkov pre výber (s odsadením)
    const out = [];
    const rec = (n, depth) => {
      for (const c of n.children || []) if (c.type === 'folder') { out.push({ id: c.id, title: c.title, depth }); rec(c, depth + 1); }
    };
    rec(this.root, 0);
    return out;
  }
  search(q) {
    const nq = q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const out = [];
    this.walk((n) => {
      if (n.type === 'url') {
        const t = (n.title + ' ' + n.url).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        if (t.includes(nq)) out.push(n);
      }
      return out.length < 500;
    });
    return out;
  }

  // ------------------------------------------------------------ úpravy
  add({ parentId = BAR, title, url = '', type = 'url', index = -1 }) {
    const p = this.find(parentId)?.node;
    if (!p || p.type !== 'folder') throw new Error('Priečinok neexistuje');
    const node = type === 'folder'
      ? { id: this.newId(), type: 'folder', title: title || 'Nový priečinok', children: [], added: Date.now() }
      : { id: this.newId(), type: 'url', title: typeof title === 'string' ? title : url, url, added: Date.now() };
    if (index < 0 || index > p.children.length) p.children.push(node); else p.children.splice(index, 0, node);
    this.changed();
    return node;
  }
  update(id, { title, url }) {
    const n = this.find(id)?.node;
    if (!n || n.id === BAR || n.id === OTHER || n.id === 'root') return null;
    if (typeof title === 'string') n.title = title;
    if (typeof url === 'string' && n.type === 'url') n.url = url;
    this.changed();
    return n;
  }
  move(id, parentId, index = -1) {
    const f = this.find(id);
    const target = this.find(parentId)?.node;
    if (!f || !target || target.type !== 'folder' || [BAR, OTHER, 'root'].includes(id)) return false;
    if (f.node.type === 'folder' && this.isAncestor(id, target)) return false; // priečinok nemôže ísť do seba
    const from = f.parent.children;
    const oldIdx = from.indexOf(f.node);
    from.splice(oldIdx, 1);
    let i = index;
    if (from === target.children && i > oldIdx) i--;       // posun v rámci toho istého priečinka
    if (i < 0 || i > target.children.length) target.children.push(f.node); else target.children.splice(i, 0, f.node);
    this.changed();
    return true;
  }
  remove(id) {
    const f = this.find(id);
    if (!f || [BAR, OTHER, 'root'].includes(id)) return null;
    const index = f.parent.children.indexOf(f.node);
    f.parent.children.splice(index, 1);
    this.changed();
    return { node: f.node, parentId: f.parent.id, index };   // pre „Späť“
  }
  restore({ node, parentId, index }) {
    const p = this.find(parentId)?.node || this.find(OTHER).node;
    if (!node || this.find(node.id)) return false;
    p.children.splice(Math.min(Math.max(index, 0), p.children.length), 0, node);
    this.changed();
    return true;
  }

  // ------------------------------------------------------------ import
  // Chrome/Brave/Edge: súbor „Bookmarks“ (JSON) v profile prehliadača
  importChromium(file, label) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const conv = (n) => (n.type === 'folder'
      ? { id: this.newId(), type: 'folder', title: n.name || 'Priečinok', children: (n.children || []).map(conv), added: Date.now() }
      : { id: this.newId(), type: 'url', title: n.name || n.url, url: n.url, added: Date.now() });
    const r = data.roots || {};
    const barItems = (r.bookmark_bar?.children || []).map(conv);
    const otherItems = [...(r.other?.children || []), ...(r.synced?.children || [])].map(conv);
    return this.placeImport(barItems, otherItems, label);
  }

  // Univerzálny HTML súbor (export z Firefoxu, Chrome, Edge, Safari…)
  importHtml(file) {
    const html = fs.readFileSync(file, 'utf8');
    const dec = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(+d)).trim();
    const top = { children: [] };
    const stack = [top];
    let pending = null, barFolder = null;
    const re = /<DT>\s*<H3([^>]*)>([\s\S]*?)<\/H3>|<DT>\s*<A\s([^>]*)>([\s\S]*?)<\/A>|<DL[^>]*>|<\/DL>/gi;
    let m;
    while ((m = re.exec(html))) {
      const tok = m[0];
      if (m[2] !== undefined) {
        pending = { id: this.newId(), type: 'folder', title: dec(m[2]) || 'Priečinok', children: [], added: Date.now() };
        if (/PERSONAL_TOOLBAR_FOLDER\s*=\s*"true"/i.test(m[1])) barFolder = pending;
        stack.at(-1).children.push(pending);
      } else if (m[3] !== undefined) {
        const href = /HREF\s*=\s*"([^"]*)"/i.exec(m[3])?.[1];
        if (href && !/^(javascript|place):/i.test(href)) {
          stack.at(-1).children.push({ id: this.newId(), type: 'url', title: dec(m[4]) || href, url: dec(href), added: Date.now() });
        }
      } else if (/^<DL/i.test(tok)) {
        if (pending) { stack.push(pending); pending = null; }
      } else if (stack.length > 1) {
        stack.pop();
      }
    }
    let barItems = [], otherItems = top.children;
    if (barFolder) {                     // priečinok označený ako „lišta“ ide na lištu
      barItems = barFolder.children;
      const rm = (list) => { const i = list.indexOf(barFolder); if (i >= 0) { list.splice(i, 1); return true; } return list.some((c) => c.children && rm(c.children)); };
      rm(otherItems);
    } else if (otherItems.length === 1 && otherItems[0].type === 'folder') {
      otherItems = otherItems[0].children; // obalový priečinok „Bookmarks“ / „Záložky“
    }
    return this.placeImport(barItems, otherItems, 'HTML súboru');
  }

  // Ak je lišta prázdna, importovaná lišta ide priamo na ňu; inak do priečinka „Importované z …“
  placeImport(barItems, otherItems, label) {
    const count = (list) => list.reduce((s, n) => s + (n.type === 'url' ? 1 : count(n.children || [])), 0);
    const bar = this.find(BAR).node;
    const other = this.find(OTHER).node;
    const name = `Importované z ${label}`;
    if (!bar.children.length) {
      bar.children.push(...barItems);
      if (otherItems.length) other.children.push({ id: this.newId(), type: 'folder', title: name, children: otherItems, added: Date.now() });
    } else {
      const f = { id: this.newId(), type: 'folder', title: name, children: [...barItems], added: Date.now() };
      if (otherItems.length) f.children.push({ id: this.newId(), type: 'folder', title: 'Ostatné záložky', children: otherItems, added: Date.now() });
      bar.children.push(f);
    }
    this.changed();
    return count(barItems) + count(otherItems);
  }

  // ------------------------------------------------------------ export
  exportHtml() {
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const rec = (n, ind) => (n.children || []).map((c) => (c.type === 'folder'
      ? `${ind}<DT><H3${c.id === BAR ? ' PERSONAL_TOOLBAR_FOLDER="true"' : ''}>${esc(c.title)}</H3>\n${ind}<DL><p>\n${rec(c, ind + '    ')}${ind}</DL><p>\n`
      : `${ind}<DT><A HREF="${esc(c.url)}" ADD_DATE="${Math.floor((c.added || Date.now()) / 1000)}">${esc(c.title)}</A>\n`)).join('');
    return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${rec(this.root, '    ')}</DL><p>\n`;
  }
}

// Nájde profily Chrome / Brave / Edge na tomto PC, ktoré majú záložky
function findBrowserProfiles() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return [];
  const browsers = [
    { name: 'Google Chrome', dir: path.join(local, 'Google', 'Chrome', 'User Data') },
    { name: 'Brave', dir: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
    { name: 'Microsoft Edge', dir: path.join(local, 'Microsoft', 'Edge', 'User Data') },
    { name: 'Vivaldi', dir: path.join(local, 'Vivaldi', 'User Data') },
    { name: 'Opera', dir: path.join(process.env.APPDATA || '', 'Opera Software', 'Opera Stable') },
  ];
  const out = [];
  for (const b of browsers) {
    let names = {};
    try { names = JSON.parse(fs.readFileSync(path.join(b.dir, 'Local State'), 'utf8')).profile?.info_cache || {}; } catch {}
    let dirs = [];
    try { dirs = fs.readdirSync(b.dir); } catch { continue; }
    if (fs.existsSync(path.join(b.dir, 'Bookmarks'))) dirs = ['.', ...dirs];   // Opera nemá podpriečinky profilov
    for (const d of dirs) {
      const file = path.join(b.dir, d, 'Bookmarks');
      if (!fs.existsSync(file)) continue;
      const profile = d === '.' ? '' : (names[d]?.name || d);
      out.push({ id: `${b.name}|${d}`, browser: b.name, profile, file });
    }
  }
  return out;
}

module.exports = { Bookmarks, findBrowserProfiles, BAR, OTHER };
