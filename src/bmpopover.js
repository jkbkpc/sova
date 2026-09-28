// Bublina na úpravu záložky (po kliknutí na hviezdičku / Ctrl+D / „Upraviť…“ na lište).
// Samostatný malý WebContentsView nad stránkou, podobne ako návrhy v adresnom riadku.
const path = require('path');
const { releaseWhenIdle, keepAlive } = require('./idle');
const { WebContentsView, ipcMain } = require('electron');

const WIDTH = 350;

class BookmarkPopover {
  constructor(win, bookmarks) {
    this.win = win;
    this.bookmarks = bookmarks;
    this.view = null;
    this.visible = false;
    this.draft = null;
    this.anchor = null;
    const own = (e) => this.view && e.sender === this.view.webContents;
    ipcMain.on('bmpop:draft', (e, d) => { if (own(e)) this.draft = d; });
    ipcMain.on('bmpop:done', (e, d) => { if (own(e)) { this.draft = d; this.commit(); } });
    ipcMain.on('bmpop:cancel', (e) => { if (own(e)) { this.draft = null; this.hide(); } });
    ipcMain.on('bmpop:remove', (e, id) => { if (own(e)) { this.bookmarks.remove(id); this.draft = null; this.hide(); } });
    ipcMain.on('bmpop:height', (e, h) => { if (own(e) && this.visible) this.place(h); });
  }

  ensure() {
    if (this.view) return;
    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'ui', 'bookmark-popover-preload.js'),
        partition: 'ui', sandbox: true, contextIsolation: true, spellcheck: false,
      },
    });
    this.view.setBackgroundColor('#00000000');
    this.ready = new Promise((r) => this.view.webContents.once('did-finish-load', r));
    this.view.webContents.loadFile(path.join(__dirname, 'ui', 'bookmark-popover.html'));
  }

  // mode: 'added' (práve pridaná cez hviezdičku) | 'edit'
  async show(id, anchor, mode = 'edit') {
    const node = this.bookmarks.find(id)?.node;
    if (!node) return;
    if (this.visible) this.commit();
    keepAlive(this);
    this.ensure();
    await this.ready;
    const parent = this.bookmarks.find(id).parent;
    this.anchor = anchor;
    this.draft = null;
    const folders = this.bookmarks.folders().filter((f) => node.type !== 'folder' || !this.bookmarks.isAncestor(node.id, this.bookmarks.find(f.id).node));
    this.view.webContents.send('data', {
      mode, id: node.id, type: node.type, title: node.title, url: node.url || '', parentId: parent.id, folders,
    });
    this.place(mode === 'added' ? 190 : 250);
    this.win.contentView.addChildView(this.view);
    this.visible = true;
    this.view.webContents.focus();
  }

  place(h) {
    const { width } = this.win.getContentBounds();
    const a = this.anchor || { x: width - 40, y: 80, width: 30, height: 30 };
    const x = Math.max(8, Math.min(Math.round(a.x + a.width - WIDTH + 12), width - WIDTH - 8));
    const winH = this.win.getContentBounds().height;
    const up = a.y > winH / 2;                       // lišta záložiek dole → bublina nad ňou
    const y = up ? Math.max(4, a.y - Math.ceil(h) - 4) : a.y + a.height + 4;
    this.view.setBounds({ x, y: Math.round(y), width: WIDTH, height: Math.ceil(h) });
  }

  // uloží rozpísané zmeny (názov, adresa, priečinok) a zavrie bublinu
  commit() {
    const d = this.draft;
    this.draft = null;
    if (d && this.bookmarks.find(d.id)) {
      this.bookmarks.update(d.id, { title: d.title, url: d.url || undefined });
      const cur = this.bookmarks.find(d.id).parent.id;
      if (d.parentId && d.parentId !== cur) this.bookmarks.move(d.id, d.parentId, -1);
    }
    this.hide();
  }

  // klik mimo bubliny (do stránky alebo lišty) = uložiť a zavrieť
  onFocusElsewhere(wc) {
    if (this.visible && this.view && wc !== this.view.webContents) this.commit();
  }

  hide() {
    if (this.visible && !this.win.isDestroyed()) this.win.contentView.removeChildView(this.view);
    this.visible = false;
    releaseWhenIdle(this, 30000);
  }
}

module.exports = { BookmarkPopover };
