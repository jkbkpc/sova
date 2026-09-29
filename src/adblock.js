// Blokovanie reklám a sledovacích skriptov pomocou knižnice Ghostery
// (rovnaké zoznamy ako EasyList, EasyPrivacy, uBlock filtre).
// - sieťové blokovanie: požiadavky na reklamné servery sa vôbec neodošlú
// - kozmetické filtre: skrytie prázdnych reklamných boxov na stránke
const fs = require('fs');
const path = require('path');
const { net, app, ipcMain } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { parse } = require('tldts-experimental');

const MAX_AGE_MS = 24 * 3600 * 1000; // zoznamy sa aktualizujú denne (YouTube mení reklamy často)

class AdBlock {
  constructor(settings, onChange) {
    this.settings = settings;
    this.onChange = onChange;
    this.sessions = new Set();          // bežné okná + inkognito
    this.blocker = null;
    this.counts = new Map(); // webContentsId -> počet zablokovaných
    this.total = 0;
    this.scriptCache = new Map(); // hostname -> skripty (scriptlety) pre danú stránku

    // Scriptlety (napr. proti reklamám na YouTube) musia bežať SKôR než skripty stránky.
    // Preload karty si ich preto vypýta synchrónne hneď na začiatku načítania stránky.
    ipcMain.on('adblock:early-scripts', (e, url) => {
      try { e.returnValue = this.scriptsFor(url); } catch { e.returnValue = ''; }
    });
  }

  scriptsFor(url) {
    if (!this.blocker || !/^https?:/i.test(url) || this.isAllowlisted(url)) return '';
    const p = parse(url);
    const hostname = p.hostname || '';
    if (this.scriptCache.has(hostname)) return this.scriptCache.get(hostname);
    const { active, scripts } = this.blocker.getCosmeticsFilters({
      url, hostname, domain: p.domain || '',
      getBaseRules: false, getInjectionRules: true, getExtendedRules: false,
      getRulesFromHostname: true, getRulesFromDOM: false,
    });
    const code = active === false || !scripts.length ? ''
      : scripts.map((s) => `try{${s}}catch(e){}`).join(';\n');
    if (this.scriptCache.size > 500) this.scriptCache.clear();
    this.scriptCache.set(hostname, code);
    return code;
  }

  hostOf(url) {
    try { return parse(url).hostname || ''; } catch { return ''; }
  }

  isAllowlisted(url) {
    const host = this.hostOf(url);
    if (!host) return false;
    return this.settings.get('allowlist').some((d) => host === d || host.endsWith('.' + d));
  }

  async load(level) {
    const cache = path.join(app.getPath('userData'), `adblock-${level}.bin`);
    const bundled = path.join(process.resourcesPath || '', `adblock-${level}.bin`);
    const devBundled = path.join(__dirname, '..', 'resources', `adblock-${level}.bin`);
    const fromFile = (f) => ElectronBlocker.deserialize(new Uint8Array(fs.readFileSync(f)));

    // 1) čerstvá kópia v cache
    try {
      if (Date.now() - fs.statSync(cache).mtimeMs < MAX_AGE_MS) return fromFile(cache);
    } catch { /* nie je */ }
    // 2) stiahnuť aktuálne zoznamy (net.fetch používa systémové proxy nastavenia)
    try {
      const f = (url, opts) => net.fetch(url, opts);
      const engine = level === 'full'
        ? await ElectronBlocker.fromPrebuiltFull(f)
        : await ElectronBlocker.fromPrebuiltAdsAndTracking(f);
      fs.writeFileSync(cache, engine.serialize());
      return engine;
    } catch (e) {
      console.warn('[adblock] sťahovanie zlyhalo, používam záložný zoznam:', e.message);
    }
    // 3) staršia cache alebo zoznam pribalený v inštalácii
    for (const f of [cache, bundled, devBundled]) {
      try { return fromFile(f); } catch { /* ďalší */ }
    }
    return ElectronBlocker.empty();
  }

  async init(sess) {
    this.sessions.add(sess);
    if (this.settings.get('adblock')) await this.start();
    this.settings.on('change', async (key) => {
      if (key === 'adblock') this.settings.get('adblock') ? await this.start() : this.stop();
      if (key === 'adblockLevel' && this.blocker) { this.stop(); await this.start(); }
    });
  }

  // ďalšia relácia (okno inkognito) – blokovanie platí aj v nej
  addSession(sess) {
    if (this.sessions.has(sess)) return;
    this.sessions.add(sess);
    if (this.blocker) this.enableIn(this.blocker, sess);
  }
  enableIn(blocker, sess) {
    // knižnica si pre každú reláciu registruje rovnaké IPC kanály – pri druhej relácii by to zlyhalo;
    // obsluha je rovnaká (volá ten istý blocker), stačí ju zaregistrovať znova
    for (const ch of ['@ghostery/adblocker/inject-cosmetic-filters', '@ghostery/adblocker/is-mutation-observer-enabled']) ipcMain.removeHandler(ch);
    blocker.enableBlockingInSession(sess);
  }

  async start() {
    if (this.blocker) return;
    const blocker = await this.load(this.settings.get('adblockLevel'));

    // výnimky pre domény, kde používateľ blokovanie vypol
    const topUrl = (details) =>
      details.resourceType === 'mainFrame' ? details.url : (details.webContents?.getURL() || details.referrer || '');
    const origReq = blocker.onBeforeRequest;
    blocker.onBeforeRequest = (details, cb) => (this.isAllowlisted(topUrl(details)) ? cb({}) : origReq(details, cb));
    const origHdr = blocker.onHeadersReceived;
    blocker.onHeadersReceived = (details, cb) => (this.isAllowlisted(topUrl(details)) ? cb({}) : origHdr(details, cb));
    // Kozmetické filtre (skrytie reklamných boxov). Skripty sa tu už nevkladajú – bežia skôr cez preload.
    blocker.onInjectCosmeticFilters = async (event, url, msg) => {
      if (this.isAllowlisted(event.sender.getURL() || url)) return;
      const p = parse(url);
      const first = msg === undefined;
      const { active, styles } = blocker.getCosmeticsFilters({
        url, hostname: p.hostname || '', domain: p.domain || '',
        classes: msg?.classes, hrefs: msg?.hrefs, ids: msg?.ids,
        getBaseRules: first, getInjectionRules: false, getExtendedRules: false,
        getRulesFromHostname: first, getRulesFromDOM: !first,
        callerContext: { frameId: event.frameId, processId: event.processId, lifecycle: msg?.lifecycle },
      });
      if (active !== false && styles.length) event.sender.insertCSS(styles, { cssOrigin: 'user' });
    };

    const count = (request) => {
      this.total++;
      if (request.tabId) this.counts.set(request.tabId, (this.counts.get(request.tabId) || 0) + 1);
      this.onChange();
    };
    blocker.on('request-blocked', count);
    blocker.on('request-redirected', count); // nahradené neškodnou „prázdnou“ verziou skriptu

    // počas načítavania mohlo byť blokovanie vypnuté
    if (!this.settings.get('adblock')) return;
    for (const sess of this.sessions) this.enableIn(blocker, sess);
    this.blocker = blocker;
    this.scriptCache.clear();
    this.onChange();
  }

  stop() {
    if (!this.blocker) return;
    for (const sess of this.sessions) { try { this.blocker.disableBlockingInSession(sess); } catch {} }
    this.blocker = null;
    this.scriptCache.clear();
    this.onChange();
  }

  countFor(wcId) { return this.counts.get(wcId) || 0; }
  resetCount(wcId) { this.counts.delete(wcId); }
  get enabled() { return !!this.blocker; }
}

module.exports = { AdBlock };
