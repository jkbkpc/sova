// Priblíženie stránok – ako v Chrome: kroky 25 % … 500 %, zapamätané pre každú doménu (%APPDATA%\Sova\zoom.json).
const fs = require('fs');
const path = require('path');

const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

class ZoomStore {
  // dir = null → len v pamäti (okno inkognito)
  constructor(dir) {
    this.file = dir ? path.join(dir, 'zoom.json') : null;
    this.map = {};
    if (this.file) try { this.map = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { /* prvé spustenie */ }
    this.timer = null;
  }
  // kľúč = doména aj s portom (sova://settings → „sova:settings“, súbory → „file“)
  key(url) {
    try {
      const u = new URL(url);
      if (/^https?:$/.test(u.protocol)) return u.host.toLowerCase();
      if (u.protocol === 'sova:') return 'sova:' + u.host;
      if (u.protocol === 'file:') return 'file';
    } catch {}
    return '';
  }
  get(url) { return this.map[this.key(url)] || 1; }
  set(url, factor) {
    const k = this.key(url);
    if (!k) return;
    if (Math.abs(factor - 1) < 0.001) delete this.map[k]; else this.map[k] = factor;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 500);
  }
  save() { if (this.file) try { fs.writeFileSync(this.file, JSON.stringify(this.map)); } catch {} }
  static next(current, dir) {
    if (dir > 0) return STEPS.find((s) => s > current + 0.001) || STEPS[STEPS.length - 1];
    return [...STEPS].reverse().find((s) => s < current - 0.001) || STEPS[0];
  }
}

module.exports = { ZoomStore, STEPS };
