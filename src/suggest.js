// Rozbaľovací zoznam návrhov pod adresným riadkom.
// Je to samostatný malý WebContentsView nad stránkou – inak by ho webová stránka prekryla.
const path = require('path');
const { releaseWhenIdle, keepAlive } = require('./idle');
const { WebContentsView, ipcMain } = require('electron');

const ROW = 36;
const PAD = 22; // okraj + tieň karty

class SuggestPopup {
  constructor(win, onPick) {
    this.win = win;
    this.onPick = onPick;
    this.view = null;
    this.visible = false;
    this.items = [];
    this.token = 0;
    ipcMain.on('suggest:pick', (e, i) => {
      if (this.view && e.sender === this.view.webContents && this.items[i]) this.onPick(this.items[i]);
    });
  }

  ensure() {
    if (this.view) return;
    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'ui', 'suggest-preload.js'),
        partition: 'ui', sandbox: true, contextIsolation: true, spellcheck: false,
      },
    });
    this.view.setBackgroundColor('#00000000');
    this.ready = new Promise((r) => this.view.webContents.once('did-finish-load', r));
    this.view.webContents.loadFile(path.join(__dirname, 'ui', 'suggest.html'));
  }

  async show(items, rect, selected = -1) {
    const token = ++this.token;
    if (!items.length) return this.hide();
    keepAlive(this);
    this.ensure();
    await this.ready;
    if (token !== this.token || this.win.isDestroyed()) return; // medzitým sa zoznam zavrel/zmenil
    this.items = items;
    this.view.webContents.send('items', items, selected);
    this.view.setBounds({
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: items.length * ROW + PAD,
    });
    // vždy navrch nad stránku
    this.win.contentView.addChildView(this.view);
    this.visible = true;
  }

  select(i) { if (this.visible) this.view.webContents.send('select', i); }

  hide() {
    this.token++;
    if (this.visible && !this.win.isDestroyed()) this.win.contentView.removeChildView(this.view);
    this.visible = false;
    this.items = [];
    releaseWhenIdle(this, 60000);
  }
}

module.exports = { SuggestPopup };
