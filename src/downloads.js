// Správca sťahovania: ukladanie do priečinka Stiahnuté (alebo sa spýta kam), priebeh, pauza,
// zrušenie, opakovanie a zoznam stiahnutých súborov (%APPDATA%\Sova\downloads.json).
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { app, shell } = require('electron');

const MAX_ITEMS = 500;

class Downloads extends EventEmitter {
  constructor(dir, settings) {
    super();
    this.file = path.join(dir, 'downloads.json');
    this.settings = settings;
    this.list = [];                 // najnovšie prvé
    this.items = new Map();         // id -> DownloadItem (len počas sťahovania)
    this.nextId = 1;
    this.unseen = 0;                // dokončené, ktoré si ešte nevidel
    try {
      this.list = JSON.parse(fs.readFileSync(this.file, 'utf8')).list || [];
      // nedokončené z minula sa po reštarte nedajú obnoviť
      for (const d of this.list) if (d.state === 'progressing') d.state = 'interrupted';
      this.nextId = Math.max(0, ...this.list.map((d) => d.id)) + 1;
    } catch { /* prvé spustenie */ }
    this.timer = null;
    this.emitTimer = null;
  }

  dir() {
    const d = this.settings.get('downloadDir');
    return d && fs.existsSync(d) ? d : app.getPath('downloads');
  }

  // „subor.pdf“ → „subor (1).pdf“, ak už existuje
  uniquePath(dir, name) {
    const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'stiahnuty-subor';
    const ext = path.extname(safe);
    const base = safe.slice(0, safe.length - ext.length);
    let p = path.join(dir, safe);
    for (let i = 1; fs.existsSync(p) || this.list.some((d) => d.path === p && d.state === 'progressing'); i++) {
      p = path.join(dir, `${base} (${i})${ext}`);
    }
    return p;
  }

  // incognito: sťahovanie funguje, ale do zoznamu na disku sa neuloží
  attach(session, { incognito = false } = {}) {
    session.on('will-download', (_e, item, wc) => {
      const id = this.nextId++;
      // súbor zo stránky so škodlivým softvérom sa nestiahne
      const bad = this.guard?.(item.getURL());
      if (bad) {
        item.cancel();
        this.list.unshift({ id, url: item.getURL(), filename: item.getFilename(), path: '', total: item.getTotalBytes(), received: 0,
          state: 'cancelled', blocked: bad.kind, start: Date.now(), end: Date.now(), speed: 0, ...(incognito ? { incognito: true } : {}) });
        this.changed(true);
        this.emit('started', this.list[0], wc && !wc.isDestroyed() ? wc.id : 0);
        return;
      }
      if (!this.settings.get('askWhereToSave')) item.setSavePath(this.uniquePath(this.dir(), item.getFilename()));
      const d = {
        id, url: item.getURL(), filename: item.getFilename(), path: item.getSavePath(),
        total: item.getTotalBytes(), received: 0, state: 'progressing', paused: false,
        start: Date.now(), end: 0, speed: 0, mime: item.getMimeType(),
      };
      if (incognito) d.incognito = true;
      this.items.set(id, item);
      this.list.unshift(d);
      if (this.list.length > MAX_ITEMS) this.list.length = MAX_ITEMS;
      let last = { t: Date.now(), b: 0 };
      item.on('updated', (_ev, state) => {
        d.received = item.getReceivedBytes();
        d.total = item.getTotalBytes();
        d.paused = item.isPaused();
        d.state = state === 'interrupted' ? 'interrupted' : 'progressing';
        const p = item.getSavePath();
        if (p) { d.path = p; d.filename = path.basename(p); }
        const t = Date.now();
        if (t - last.t >= 800) {             // rýchlosť – kĺzavý priemer
          const s = ((d.received - last.b) * 1000) / (t - last.t);
          d.speed = d.speed ? d.speed * 0.6 + s * 0.4 : s;
          last = { t, b: d.received };
        }
        this.changed(false);
      });
      item.once('done', (_ev, state) => {
        this.items.delete(id);
        d.state = state;                     // completed | cancelled | interrupted
        d.received = item.getReceivedBytes();
        d.end = Date.now();
        d.speed = 0;
        const p = item.getSavePath();
        if (p) { d.path = p; d.filename = path.basename(p); }
        if (state === 'completed') this.unseen++;
        this.changed(true);
        this.emit('done', d);
      });
      this.changed(true);
      this.emit('started', d, wc && !wc.isDestroyed() ? wc.id : 0);
    });
  }

  changed(saveNow) {
    // UI obnovujeme najviac 4× za sekundu
    if (!this.emitTimer) this.emitTimer = setTimeout(() => { this.emitTimer = null; this.emit('change'); }, 250);
    if (saveNow) this.save(); else this.scheduleSave();
  }
  // zatvorené posledné okno inkognito → jeho sťahovania zmiznú zo zoznamu (súbory ostanú na disku)
  forgetIncognito() {
    const before = this.list.length;
    this.list = this.list.filter((d) => !d.incognito || d.state === 'progressing');
    if (this.list.length !== before) this.changed(false);
  }
  scheduleSave() { clearTimeout(this.timer); this.timer = setTimeout(() => this.save(), 2000); }
  save() {
    clearTimeout(this.timer);
    try { fs.writeFileSync(this.file, JSON.stringify({ list: this.list.filter((d) => !d.incognito) })); } catch (e) { console.error('[downloads]', e.message); }
  }

  // ------------------------------------------------------------ zoznam
  get(id) { return this.list.find((d) => d.id === id); }
  view(limit = MAX_ITEMS, q = '') {
    const nq = q.trim().toLowerCase();
    return this.list
      .filter((d) => !nq || d.filename.toLowerCase().includes(nq) || d.url.toLowerCase().includes(nq))
      .slice(0, limit)
      .map((d) => ({ ...d, exists: d.state === 'completed' ? fs.existsSync(d.path) : undefined }));
  }
  active() { return this.list.filter((d) => d.state === 'progressing'); }
  summary() {
    const act = this.active();
    const total = act.reduce((s, d) => s + (d.total || 0), 0);
    const got = act.reduce((s, d) => s + d.received, 0);
    return {
      active: act.length,
      progress: act.length && total ? got / total : act.length ? -1 : 0,   // -1 = neznáma veľkosť
      unseen: this.unseen,
      any: this.list.length > 0,
    };
  }
  markSeen() { if (this.unseen) { this.unseen = 0; this.emit('change'); } }

  // ------------------------------------------------------------ akcie
  open(id) { const d = this.get(id); if (d && fs.existsSync(d.path)) shell.openPath(d.path); }
  show(id) {
    const d = this.get(id);
    if (d && fs.existsSync(d.path)) shell.showItemInFolder(d.path); else shell.openPath(this.dir());
  }
  openFolder() { shell.openPath(this.dir()); }
  pause(id) { this.items.get(id)?.pause(); }
  resume(id) { const it = this.items.get(id); if (it?.canResume()) it.resume(); }
  cancel(id) { this.items.get(id)?.cancel(); }
  remove(id) {
    if (this.items.has(id)) return;
    this.list = this.list.filter((d) => d.id !== id);
    this.changed(true);
  }
  clear() {
    this.list = this.list.filter((d) => d.state === 'progressing');
    this.unseen = 0;
    this.changed(true);
  }
  // súbor presunutý do koša (len ak existuje a je dokončený)
  async trash(id) {
    const d = this.get(id);
    if (!d || d.state !== 'completed' || !fs.existsSync(d.path)) return false;
    await shell.trashItem(d.path);
    this.remove(id);
    return true;
  }
}

module.exports = { Downloads };
