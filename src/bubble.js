// Všeobecná „bublina“ – malé okienko nad stránkou pod tlačidlom v lište (sťahovania, test rýchlosti).
// Je to samostatný WebContentsView, aby ho webová stránka neprekryla.
const path = require('path');
const { releaseWhenIdle, keepAlive } = require('./idle');
const { WebContentsView, ipcMain } = require('electron');

class Bubble {
  constructor({ win, name, file, width = 360, align = 'right' }) {
    Object.assign(this, { win, name, file, width, align });
    this.view = null;
    this.visible = false;
    this.anchor = null;
    this.height = 120;
    this.lastClose = 0;
    this.on('size', (h) => { this.height = Math.ceil(h); if (this.visible) this.place(); });
    this.on('close', () => this.hide());
  }

  own(e) { return this.view && e.sender === this.view.webContents; }
  // správy z bubliny: kanál „<meno>:<ch>“, prijímajú sa len od tejto bubliny
  on(ch, fn) { ipcMain.on(`${this.name}:${ch}`, (e, ...a) => { if (this.own(e)) fn(...a); }); }
  handle(ch, fn) {
    ipcMain.handle(`${this.name}:${ch}`, (e, ...a) => { if (!this.own(e)) throw new Error('denied'); return fn(...a); });
  }
  send(ch, ...a) { if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.send(ch, ...a); }

  ensure() {
    if (this.view) return;
    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'ui', 'bubble-preload.js'),
        partition: 'ui', sandbox: true, contextIsolation: true, spellcheck: false,
      },
    });
    this.view.setBackgroundColor('#00000000');
    this.ready = new Promise((r) => this.view.webContents.once('did-finish-load', r));
    this.view.webContents.loadFile(path.join(__dirname, 'ui', this.file), { query: { bubble: this.name } });
  }

  async show(anchor, { focus = true } = {}) {
    keepAlive(this);
    this.ensure();
    await this.ready;
    this.anchor = anchor || this.anchor;
    this.place();
    this.win.contentView.addChildView(this.view);
    this.visible = true;
    this.send('shown');
    if (focus) this.view.webContents.focus();
  }

  // klik na to isté tlačidlo pri otvorenej bubline ju zavrie
  toggle(anchor) {
    if (Date.now() - this.lastClose < 300) return;
    if (this.visible) this.hide(); else this.show(anchor);
  }

  place() {
    const { width, height } = this.win.getContentBounds();
    const a = this.anchor || { x: width - 40, y: 40, width: 30, height: 30 };
    const want = this.align === 'left' ? a.x - 8 : a.x + a.width - this.width + 8;
    const x = Math.max(4, Math.min(Math.round(want), width - this.width - 8));
    const y = Math.round(a.y + a.height + 4);
    this.view.setBounds({ x, y, width: this.width, height: Math.min(this.height, height - y - 8) });
  }

  onFocusElsewhere(wc) {
    if (this.visible && this.view && wc !== this.view.webContents) this.hide();
  }

  hide() {
    if (!this.visible) return;
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(this.view);
    this.visible = false;
    this.lastClose = Date.now();
    this.send('hidden');
    releaseWhenIdle(this, 30000);
  }
}

module.exports = { Bubble };
