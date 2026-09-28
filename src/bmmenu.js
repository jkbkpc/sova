// Rozbaľovacie menu priečinka záložiek (lišta záložiek, „Ostatné záložky“, »).
// Vlastné HTML menu namiesto systémového: ukazuje ikony stránok, dá sa v ňom kliknúť pravým
// (upraviť, odstrániť, presunúť na lištu) a položky sa dajú ťahať myšou.
const path = require('path');
const { releaseWhenIdle, keepAlive } = require('./idle');
const { WebContentsView, ipcMain, Menu } = require('electron');
const { BAR } = require('./bookmarks');

class BookmarkMenu {
  constructor({ win, bookmarks, slim, open, openAll, popover }) {
    Object.assign(this, { win, bookmarks, slim, open, openAll, popover });
    this.view = null;
    this.visible = false;
    this.spec = null;        // { folderId } alebo { ids } (položky, ktoré sa nezmestili na lištu)
    this.anchor = null;
    this.size = { w: 280, h: 100 };
    this.lastClose = { key: null, at: 0 };
    const own = (e) => this.view && e.sender === this.view.webContents;
    ipcMain.on('bmmenu:size', (e, w, h) => { if (own(e)) { this.size = { w, h }; if (this.visible) this.place(); } });
    ipcMain.on('bmmenu:open', (e, id, how) => {
      if (!own(e)) return;
      const n = this.bookmarks.find(id)?.node;
      if (!n) return;
      if (how !== 'background') this.hide();   // na pozadí = menu ostane otvorené (ako v Chrome)
      if (n.type === 'url') this.open(n.url, how); else this.openAll(n);
    });
    ipcMain.on('bmmenu:close', (e) => { if (own(e)) this.hide(); });
    ipcMain.on('bmmenu:move', (e, id, parentId, index) => { if (own(e)) this.bookmarks.move(id, parentId, index); });
    ipcMain.on('bmmenu:context', (e, id) => { if (own(e)) this.context(id); });
    bookmarks.on('change', () => { if (this.visible) this.send(); });
  }

  key(spec) { return spec.folderId || 'overflow'; }

  ensure() {
    if (this.view) return;
    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'ui', 'bookmark-menu-preload.js'),
        partition: 'ui', sandbox: true, contextIsolation: true, spellcheck: false,
      },
    });
    this.view.setBackgroundColor('#00000000');
    this.ready = new Promise((r) => this.view.webContents.once('did-finish-load', r));
    this.view.webContents.loadFile(path.join(__dirname, 'ui', 'bookmark-menu.html'));
  }

  // strom položiek (aj s podpriečinkami) pre menu
  data() {
    const conv = (n) => (n.type === 'folder' ? { ...this.slim(n), children: (n.children || []).map(conv) } : this.slim(n));
    if (this.spec.folderId) {
      const f = this.bookmarks.find(this.spec.folderId)?.node;
      return f ? conv(f) : null;
    }
    // položky z konca lišty, ktoré sa nezmestili – presúvanie medzi nimi = presúvanie na lište
    const nodes = this.spec.ids.map((i) => this.bookmarks.find(i)?.node).filter(Boolean);
    const offset = nodes.length ? this.bookmarks.bar().indexOf(nodes[0]) : 0;
    return { id: BAR, type: 'folder', offset, overflow: true, children: nodes.map(conv) };
  }
  send() {
    const d = this.data();
    if (!d) { this.hide(); return; }
    const { height } = this.win.getContentBounds();
    const a = this.anchor || { y: 80, height: 0 };
    const up = this.up();
    const maxH = up ? a.y - 8 : height - (a.y + a.height) - 12;
    this.view.webContents.send('data', d, this.spec.reset, Math.max(120, maxH), up);
    this.spec.reset = false;
  }

  // Klik na to isté tlačidlo, keď je menu otvorené, ho len zavrie
  async toggle(spec, anchor) {
    if (this.lastClose.key === this.key(spec) && Date.now() - this.lastClose.at < 300) return;
    if (this.visible && this.key(this.spec) === this.key(spec)) { this.hide(); return; }
    keepAlive(this);
    this.ensure();
    await this.ready;
    this.spec = { ...spec, reset: true };
    this.anchor = anchor;
    this.send();
    this.place();
    this.win.contentView.addChildView(this.view);
    this.visible = true;
    this.view.webContents.focus();
  }

  // menu z lišty záložiek dole sa otvára smerom hore
  up() {
    const a = this.anchor || { y: 80 };
    return a.y > this.win.getContentBounds().height / 2;
  }

  place() {
    const { width, height } = this.win.getContentBounds();
    const a = this.anchor || { x: 8, y: 80, width: 0, height: 0 };
    const w = Math.min(this.size.w, width - 8);
    const x = Math.max(4, Math.min(Math.round(a.x), width - w - 4));
    if (this.up()) {
      // celý priestor nad lištou; menu je v ňom prilepené k spodku (priehľadné okolie)
      const h = Math.max(100, Math.round(a.y - 4));
      this.view.setBounds({ x, y: Math.round(a.y - 2 - h), width: Math.round(w), height: h });
      return;
    }
    const y = Math.round(a.y + a.height + 2);
    this.view.setBounds({ x, y, width: Math.round(w), height: Math.round(Math.min(this.size.h, height - y - 4)) });
  }

  context(id) {
    const n = this.bookmarks.find(id)?.node;
    if (!n) return;
    const found = this.bookmarks.find(id);
    const anchor = this.anchor;
    const inBar = found.parent.id === BAR;
    const t = [];
    if (n.type === 'url') {
      t.push(
        { label: 'Otvoriť', click: () => { this.hide(); this.open(n.url, 'current'); } },
        { label: 'Otvoriť v novej karte', click: () => { this.hide(); this.open(n.url, 'new'); } },
        { label: 'Otvoriť na pozadí', click: () => this.open(n.url, 'background') },
      );
    } else {
      const c = (n.children || []).filter((x) => x.type === 'url').length;
      t.push({ label: `Otvoriť všetky (${c})`, enabled: c > 0, click: () => { this.hide(); this.openAll(n); } });
    }
    t.push(
      { type: 'separator' },
      { label: n.type === 'folder' ? 'Premenovať…' : 'Upraviť…', click: () => { this.hide(); this.popover.show(n.id, anchor, 'edit'); } },
      { label: 'Presunúť na lištu záložiek', enabled: !inBar, click: () => this.bookmarks.move(n.id, BAR, -1) },
      { label: 'Odstrániť', click: () => this.bookmarks.remove(n.id) },
    );
    Menu.buildFromTemplate(t).popup({ window: this.win });
  }

  onFocusElsewhere(wc) {
    if (this.visible && this.view && wc !== this.view.webContents) this.hide();
  }

  hide() {
    if (!this.visible) return;
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(this.view);
    this.visible = false;
    this.lastClose = { key: this.key(this.spec), at: Date.now() };
    releaseWhenIdle(this, 30000);
  }
}

module.exports = { BookmarkMenu };
