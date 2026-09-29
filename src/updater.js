// Automatické aktualizácie z GitHub Releases (github.com/jkbkpc/sova).
//  - nainštalovaná verzia (Setup): nová verzia sa stiahne na pozadí, v lište sa ukáže „Aktualizovať“
//    a nainštaluje sa po kliknutí alebo pri najbližšom zatvorení Sovy
//  - prenosná verzia (Portable): len upozorní na novú verziu a otvorí stránku so stiahnutím
const { app, net } = require('electron');
const { EventEmitter } = require('events');
const { log } = require('./log');

const REPO = 'jkbkpc/sova';
const FIRST_CHECK_MS = 15 * 1000;
const INTERVAL_MS = 4 * 3600 * 1000;

const newer = (a, b) => {                  // je verzia a novšia ako b? (1.10.0 > 1.9.2)
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

class Updater extends EventEmitter {
  // options: { settings, testFeed } – testFeed = URL „generic“ servera pre testy
  constructor({ settings, testFeed } = {}) {
    super();
    this.settings = settings;
    this.portable = !!process.env.PORTABLE_EXECUTABLE_FILE;
    this.enabled = app.isPackaged || !!testFeed;
    this.s = { version: app.getVersion(), status: this.enabled ? 'idle' : 'disabled', portable: this.portable,
      newVersion: '', progress: 0, error: '', lastCheck: 0, releaseUrl: `https://github.com/${REPO}/releases/latest` };
    this.timer = null;
    if (!this.enabled || this.portable) return;

    const { NsisUpdater } = require('electron-updater');
    // bez testFeed si updater prečíta resources/app-update.yml, ktorý vytvorí electron-builder
    this.u = new NsisUpdater(testFeed ? { provider: 'generic', url: testFeed } : undefined);
    if (testFeed) {                          // test mimo zabalenej aplikácie
      const cfg = require('path').join(app.getPath('userData'), 'test-app-update.yml');
      require('fs').writeFileSync(cfg, `provider: generic\nurl: ${testFeed}\nupdaterCacheDirName: sova-updater-test\n`);
      this.u.forceDevUpdateConfig = true;
      this.u.updateConfigPath = cfg;
    }
    this.u.logger = { info() {}, warn() {}, debug() {}, error: (e) => console.warn('[update]', String(e).slice(0, 300)) };
    this.u.autoDownload = settings.get('autoUpdate') !== false;
    this.u.autoInstallOnAppQuit = true;
    this.u.on('checking-for-update', () => this.set({ status: 'checking', error: '' }));
    this.u.on('update-not-available', () => this.set({ status: 'latest', lastCheck: Date.now() }));
    this.u.on('update-available', (i) => this.set({ status: this.u.autoDownload ? 'downloading' : 'available',
      newVersion: i.version, progress: 0, lastCheck: Date.now() }));
    this.u.on('download-progress', (p) => this.set({ status: 'downloading', progress: Math.round(p.percent || 0) }));
    this.u.on('update-downloaded', (i) => this.set({ status: 'ready', newVersion: i.version, progress: 100 }));
    this.u.on('error', (e) => this.set({ status: 'error', error: this.message(e), lastCheck: Date.now() }));
    settings.on?.('change', () => { this.u.autoDownload = settings.get('autoUpdate') !== false; });
  }

  message(e) {
    const m = String(e?.message || e || '');
    if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|ERR_CONNECTION_(REFUSED|TIMED_OUT|RESET|CLOSED)|ERR_ADDRESS_UNREACHABLE|ETIMEDOUT|ECONNREFUSED/i.test(m)) return 'Nepodarilo sa pripojiť na GitHub (internet alebo firewall)';
    if (/404|Cannot find latest|No published versions/i.test(m)) return 'Na GitHube zatiaľ nie je žiadne vydanie';
    if (/CERT|certificate/i.test(m)) return 'Problém s certifikátom pri pripojení na GitHub';
    return m.split('\n')[0].slice(0, 160) || 'Neznáma chyba';
  }

  set(patch) {
    if (patch.status && patch.status !== this.s.status) log('aktualizácia:', patch.status, patch.newVersion || '', patch.error || '');
    Object.assign(this.s, patch);
    this.emit('change', this.state());
  }
  state() { return { ...this.s }; }

  start() {
    if (!this.enabled) return;
    setTimeout(() => this.check(), FIRST_CHECK_MS);
    this.timer = setInterval(() => this.check(), INTERVAL_MS);
  }

  async check() {
    if (!this.enabled || ['checking', 'downloading', 'ready'].includes(this.s.status)) return this.state();
    if (this.portable) return this.checkPortable();
    try { await this.u.checkForUpdates(); } catch (e) { this.set({ status: 'error', error: this.message(e), lastCheck: Date.now() }); }
    return this.state();
  }

  // prenosná verzia sa nedá aktualizovať sama – len zistíme, či je na GitHube novšia
  async checkPortable() {
    this.set({ status: 'checking', error: '' });
    try {
      const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error(r.status === 404 ? '404' : `HTTP ${r.status}`);
      const j = await r.json();
      const v = String(j.tag_name || j.name || '').replace(/^v/, '');
      if (v && newer(v, this.s.version)) this.set({ status: 'portable', newVersion: v, releaseUrl: j.html_url || this.s.releaseUrl, lastCheck: Date.now() });
      else this.set({ status: 'latest', lastCheck: Date.now() });
    } catch (e) { this.set({ status: 'error', error: this.message(e), lastCheck: Date.now() }); }
    return this.state();
  }

  // stiahnuť ručne (keď je automatické sťahovanie vypnuté)
  async download() {
    if (this.s.status !== 'available' || !this.u) return;
    this.set({ status: 'downloading', progress: 0 });
    try { await this.u.downloadUpdate(); } catch (e) { this.set({ status: 'error', error: this.message(e) }); }
  }

  // reštart do novej verzie (inštalátor beží potichu a Sovu po inštalácii znova spustí)
  install() {
    if (this.s.status !== 'ready' || !this.u) return false;
    log('inštalácia aktualizácie', this.s.newVersion);
    this.emit('before-install');
    setImmediate(() => { log('spúšťam inštalátor'); this.u.quitAndInstall(true, true); });
    return true;
  }
}

module.exports = { Updater, newer };
