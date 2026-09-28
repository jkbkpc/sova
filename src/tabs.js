// Správa kariet. Každá karta = vlastný WebContentsView (samostatná stránka Chromium).
//
// Životný cyklus karty:
//   active   – karta je zobrazená, beží normálne
//   hidden   – práve si sa preklikol preč; o pár sekúnd sa zmrazí
//   frozen   – JavaScript, časovače, animácie a vykresľovanie sú zastavené (CPU/GPU ≈ 0 %),
//              stránka ostáva v RAM, návrat je okamžitý
//   sleeping – stránka je úplne zatvorená a jej proces ukončený (RAM uvoľnená);
//              ostáva len adresa, história a stav formulárov/scrollu. Pri kliknutí sa obnoví.
const path = require('path');
const fs = require('fs');
const { WebContentsView, Menu, clipboard, app } = require('electron');
const { parse } = require('tldts-experimental');

// Nová karta je interná stránka sova://newtab – v adresnom riadku sa nezobrazuje
const NEWTAB_URL = 'sova://newtab/';

class TabManager {
  constructor({ win, session, settings, adblock, history, onChange, shortcut, getTopInset, getBottomInset, ui, focusAddress }) {
    this.win = win;
    this.session = session;
    this.settings = settings;
    this.adblock = adblock;
    this.onChange = onChange;
    this.shortcut = shortcut;
    this.getTopInset = getTopInset;
    this.getBottomInset = getBottomInset || (() => 0);
    this.ui = ui;
    this.focusAddress = focusAddress;
    this.history = history;
    this.tabs = [];
    this.activeId = null;
    this.nextId = 1;
    this.closed = []; // pre Ctrl+Shift+T
    this.fullscreen = false;
    this.memory = new Map(); // pid -> MB

    this.sessionFile = path.join(app.getPath('userData'), 'session.json');
    // pravidelná kontrola: uspávanie dlho neaktívnych kariet + meranie RAM
    this.ticker = setInterval(() => this.tick(), 15000);
    this.memTicker = setInterval(() => this.measure(), 2000);
    setTimeout(() => this.measure(), 1500);
    settings.on('change', (k) => { if (k === 'searchEngine') this.onChange(); });
  }

  get active() { return this.tabs.find((t) => t.id === this.activeId) || null; }
  get(id) { return this.tabs.find((t) => t.id === id) || null; }
  isInternal(url) {
    // aj stará adresa file:///…/newtab.html z predchádzajúcich verzií
    return !url || url.startsWith(NEWTAB_URL) || /^file:\/\/.*\/newtab\.html/i.test(url);
  }
  newTabUrl() { return `${NEWTAB_URL}?engine=${this.settings.get('searchEngine')}`; }

  host(url) { try { return parse(url).hostname || ''; } catch { return ''; } }
  matchesList(url, key) {
    const h = this.host(url);
    return !!h && this.settings.get(key).some((d) => h === d || h.endsWith('.' + d));
  }
  canSleep(tab) {
    if (tab.id === this.activeId) return false;
    if (this.matchesList(tab.url, 'neverSleep')) return false;
    if (this.settings.get('keepAudibleAwake') && tab.view && tab.view.webContents.isCurrentlyAudible()) return false;
    return true;
  }

  // Prázdna nová karta nemá vlastnú stránku ani proces – kreslí ju priamo lišta prehliadača.
  // Proces stránky (≈ 50–100 MB) vznikne až keď do nej niečo zadáš.
  isBlank(tab) { return !tab.view && this.isInternal(tab.url) && !(tab.history && tab.history.length > 1); }

  // ------------------------------------------------------------------ tvorba
  create(url, { background = false, afterActive = false, restore = null } = {}) {
    const tab = {
      id: this.nextId++, view: null, state: 'sleeping',
      url: url || this.newTabUrl(), title: 'Nová karta', favicon: null,
      loading: false, audible: false, muted: false, crashed: false,
      history: null, historyIndex: undefined, hiddenAt: Date.now(), freezeTimer: null,
    };
    if (restore) Object.assign(tab, restore);
    let idx = afterActive && this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
    if (!tab.pinned) idx = Math.max(idx, this.pinnedCount());   // nové karty nikdy medzi pripnuté
    this.tabs.splice(idx, 0, tab);

    if (!restore && this.isInternal(tab.url)) {
      tab.state = 'blank';
    } else if (!restore) {
      this.createView(tab);
      tab.view.webContents.loadURL(tab.url).catch(() => {});
      if (background) {
        tab.state = 'hidden';
        this.scheduleFreeze(tab);
      }
    }
    if (!background) this.activate(tab.id);
    this.onChange();
    return tab;
  }

  createView(tab) {
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        preload: path.join(__dirname, 'ui', 'internal-preload.js'), // API len pre sova:// stránky
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: true,
        spellcheck: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    tab.view = view;
    tab.crashed = false;
    const wc = view.webContents;
    tab.wcId = wc.id;
    wc.setAudioMuted(tab.muted);

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      this.history?.updateTitle(wc.getURL(), title);
      this.onChange();
    });
    wc.on('page-favicon-updated', (_e, icons) => {
      tab.favicon = icons[0] || null;
      this.history?.setFavicon(wc.getURL(), tab.favicon);
      if (tab.favicon) this.onFavicon?.({ url: wc.getURL(), startUrl: tab.navStart, icon: tab.favicon, wc });
      this.onChange();
    });
    wc.on('did-start-loading', () => { tab.loading = true; this.onChange(); });
    wc.on('did-stop-loading', () => { tab.loading = false; this.onChange(); });
    wc.on('did-start-navigation', (d) => {
      if (d.isMainFrame && !d.isSameDocument) {
        this.adblock.resetCount(wc.id); tab.favicon = null; tab.navStart = d.url;
        if (tab.certError) this.clearCertError(tab);
      }
    });
    const onNav = () => {
      tab.url = wc.getURL();
      if (this.isInternal(tab.url)) tab.title = 'Nová karta';
      this.onChange();
    };
    wc.on('did-navigate', onNav);
    wc.on('did-navigate-in-page', onNav);
    // história – obnovenie uspanej karty sa nepočíta ako nová návšteva
    const record = (url) => {
      if (tab.skipNextNav) { tab.skipNextNav = false; return; }
      this.history?.add(url, wc.getTitle() === url ? '' : wc.getTitle());
    };
    wc.on('did-navigate', (_e, url) => record(url));
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) record(url); });
    wc.on('audio-state-changed', (e) => { tab.audible = e.audible; this.onChange(); });
    wc.on('render-process-gone', () => { tab.crashed = true; tab.loading = false; this.onChange(); });

    // nové okná / odkazy s target=_blank → nová karta; skutočné popupy (napr. prihlásenie) ako okno
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: { session: this.session, sandbox: true, contextIsolation: true },
          },
        };
      }
      this.create(url, { background: disposition === 'background-tab', afterActive: true });
      return { action: 'deny' };
    });

    wc.on('before-input-event', (e, input) => { if (this.shortcut(input)) e.preventDefault(); });
    const keepAddressFocus = () => {
      if (tab.addressFocusUntil > Date.now() && tab.id === this.activeId && this.isInternal(tab.url)) this.focusAddress();
    };
    wc.on('focus', keepAddressFocus);
    wc.on('did-finish-load', keepAddressFocus);
    wc.on('before-mouse-event', (_e, m) => { if (m.type === 'mouseDown') tab.addressFocusUntil = 0; });
    wc.on('context-menu', (_e, p) => this.pageMenu(tab, p));
    wc.on('enter-html-full-screen', () => { this.fullscreen = true; this.win.setFullScreen(true); this.layout(); });
    wc.on('leave-html-full-screen', () => { this.fullscreen = false; this.win.setFullScreen(false); this.layout(); });
    wc.on('found-in-page', (_e, r) => this.ui.send('find-result', r));
    return view;
  }

  // -------------------------------------------------------------- prepínanie
  activate(id) {
    const tab = this.get(id);
    if (!tab) return;
    const prev = this.active;
    if (prev && prev !== tab) this.hide(prev);
    this.activeId = tab.id;
    clearTimeout(tab.freezeTimer);

    const blank = this.isBlank(tab);
    if (!tab.view && !blank) this.wake(tab);
    else if (tab.state === 'frozen') this.setLifecycle(tab, 'active');
    else if (tab.crashed) tab.view.webContents.reload();
    tab.state = 'active';

    if (tab.view && !tab.certError) {
      this.win.contentView.addChildView(tab.view);
      this.layout();
    } else if (tab.view) this.win.contentView.removeChildView(tab.view);
    this.ui.send('activated', this.isInternal(tab.url) ? '' : tab.url);
    if (this.isInternal(tab.url)) {
      // Nová karta si po načítaní sama zoberie fokus – ešte chvíľu ho vraciame do adresného riadku
      tab.addressFocusUntil = Date.now() + 3000;
      this.focusAddress();
    }
    else tab.view?.webContents.focus();
    this.onChange();
  }

  hide(tab) {
    if (this.isBlank(tab)) { tab.state = 'blank'; return; }
    if (tab.view) {
      this.win.contentView.removeChildView(tab.view);
      tab.view.webContents.stopFindInPage('clearSelection');
    }
    tab.state = tab.view ? 'hidden' : 'sleeping';
    tab.hiddenAt = Date.now();
    this.scheduleFreeze(tab);
  }

  scheduleFreeze(tab) {
    clearTimeout(tab.freezeTimer);
    tab.freezeTimer = setTimeout(() => this.freeze(tab), this.settings.get('freezeDelaySec') * 1000);
  }

  // Zmrazenie cez Chrome DevTools Protocol – to isté, čo robí Chrome pri „Memory Saver“.
  async setLifecycle(tab, state) {
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed()) return false;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      if (process.env.SOVA_DEBUG) console.log('[lifecycle]', tab.id, state, Date.now() % 100000);
      await wc.debugger.sendCommand('Page.setWebLifecycleState', { state });
      return true;
    } catch (e) {
      console.warn(`[tabs] ${state} zlyhalo pre kartu ${tab.id}:`, e.message);
      return false;
    }
  }

  async freeze(tab) {
    if (tab.state !== 'hidden' || !tab.view) return;
    if (!this.canSleep(tab)) { tab.freezeTimer = setTimeout(() => this.freeze(tab), 30000); return; }
    if (tab.loading) { tab.freezeTimer = setTimeout(() => this.freeze(tab), 5000); return; }
    if (await this.setLifecycle(tab, 'frozen') && tab.state === 'hidden') {
      tab.state = 'frozen';
      this.onChange();
    }
  }

  // Uspanie: uloží históriu (vrátane scrollu a vyplnených formulárov) a zatvorí stránku.
  discard(tab, force = false) {
    if (!tab.view || tab.id === this.activeId) return;
    if (!force && !this.canSleep(tab)) return;
    const wc = tab.view.webContents;
    try {
      tab.history = wc.navigationHistory.getAllEntries();
      tab.historyIndex = wc.navigationHistory.getActiveIndex();
    } catch { tab.history = null; }
    clearTimeout(tab.freezeTimer);
    this.win.contentView.removeChildView(tab.view);
    if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false });
    tab.view = null;
    tab.state = 'sleeping';
    tab.loading = false;
    tab.audible = false;
    this.onChange();
  }

  wake(tab) {
    this.createView(tab);
    tab.skipNextNav = true;
    const wc = tab.view.webContents;
    const entries = (tab.history || []).filter((e) => e && e.url);
    if (entries.length) {
      const index = Math.min(Math.max(tab.historyIndex ?? entries.length - 1, 0), entries.length - 1);
      wc.navigationHistory.restore({ entries, index }).catch(() => wc.loadURL(tab.url).catch(() => {}));
    } else {
      wc.loadURL(tab.url).catch(() => {});
    }
  }

  tick() {
    const min = this.settings.get('discardAfterMin');
    if (!min) return;
    const now = Date.now();
    for (const t of this.tabs) {
      if (t.view && t.id !== this.activeId && (t.state === 'frozen' || t.state === 'hidden')
          && now - t.hiddenAt >= min * 60000) this.discard(t);
    }
  }

  measure() {
    const m = new Map();
    let total = 0, cpu = 0;
    for (const p of app.getAppMetrics()) {
      // Windows: súkromná pamäť procesu (ako Správca úloh); zdieľaná pamäť (DLL) by sa inak rátala viackrát
      const mb = (p.memory?.privateBytes ?? p.memory?.workingSetSize ?? 0) / 1024;
      m.set(p.pid, mb);
      total += mb;
      cpu += p.cpu?.percentCPUUsage || 0;   // % celého procesora od posledného merania
    }
    this.memory = m;
    this.totalMem = total;
    // Electron už hodnotu prepočítava na celý procesor (ako Správca úloh Windows)
    this.totalCpu = Math.min(100, cpu);
    this.onChange();
  }

  // ----------------------------------------------------------------- akcie
  close(id) {
    const tab = this.get(id);
    if (!tab) return;
    const i = this.tabs.indexOf(tab);
    let history = tab.history, historyIndex = tab.historyIndex;
    if (tab.view) {
      const wc = tab.view.webContents;
      try { history = wc.navigationHistory.getAllEntries(); historyIndex = wc.navigationHistory.getActiveIndex(); } catch {}
      this.win.contentView.removeChildView(tab.view);
      if (!wc.isDestroyed()) wc.close();
    }
    clearTimeout(tab.freezeTimer);
    if (!this.isInternal(tab.url)) {
      this.closed.push({ url: tab.url, title: tab.title, history, historyIndex });
      if (this.closed.length > 25) this.closed.shift();
    }
    this.tabs.splice(i, 1);
    if (this.activeId === id) {
      this.activeId = null;
      if (this.tabs.length === 0) { this.create(); return; }
      this.activate(this.tabs[Math.min(i, this.tabs.length - 1)].id);
    }
    this.onChange();
  }

  // pripnuté karty ostávajú (ako v Chrome)
  closeOthers(id) { for (const t of [...this.tabs]) if (t.id !== id && !t.pinned) this.close(t.id); }

  // ---------------------------------------------------------- pripnuté karty
  pinnedCount() { return this.tabs.filter((t) => t.pinned).length; }
  togglePin(id) {
    const t = this.get(id);
    if (!t) return;
    this.tabs.splice(this.tabs.indexOf(t), 1);
    t.pinned = !t.pinned;
    // pripnutá ide na koniec pripnutých vľavo, odopnutá hneď za ne
    this.tabs.splice(this.pinnedCount(), 0, t);
    this.onChange();
  }
  // presun karty ťahaním – pripnuté ostávajú medzi pripnutými, ostatné za nimi
  move(id, index) {
    const t = this.get(id);
    if (!t) return;
    const from = this.tabs.indexOf(t);
    this.tabs.splice(from, 1);
    const pc = this.pinnedCount();
    const lo = t.pinned ? 0 : pc, hi = t.pinned ? pc : this.tabs.length;
    this.tabs.splice(Math.min(Math.max(Number(index) || 0, lo), hi), 0, t);
    this.onChange();
  }

  // ---------------------------------------------------------- neplatný certifikát
  // Stránka sa nenačíta; namiesto nej lišta prehliadača ukáže upozornenie (adresa ostáva v adresnom riadku)
  showCertError(tab, info) {
    tab.certError = info;
    tab.url = info.url;
    tab.title = info.host;
    if (tab.id === this.activeId && tab.view) {
      this.win.contentView.removeChildView(tab.view);
      this.ui.send('activated', info.url);
    }
    this.onChange();
  }
  clearCertError(tab) {
    delete tab.certError;
    if (tab.id === this.activeId && tab.view) { this.win.contentView.addChildView(tab.view); this.layout(); }
    this.onChange();
  }

  sleepOthers() { for (const t of this.tabs) if (t.id !== this.activeId) this.discard(t, true); }

  reopenClosed() {
    const c = this.closed.pop();
    if (!c) return;
    const tab = this.create(c.url, { restore: { url: c.url, title: c.title, history: c.history, historyIndex: c.historyIndex }, afterActive: true });
    this.activate(tab.id);
  }

  duplicate(id) {
    const t = this.get(id);
    if (t) this.create(t.url, { afterActive: true });
  }

  cycle(dir) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length].id);
  }

  toggleMute(id) {
    const t = this.get(id);
    if (!t) return;
    t.muted = !t.muted;
    t.view?.webContents.setAudioMuted(t.muted);
    this.onChange();
  }

  // Nastavenia / história na samostatnej karte – ak už je otvorená, len sa na ňu prepne
  openInternal(name, hash = '') {
    const url = `sova://${name}/`;
    const existing = this.tabs.find((t) => (t.url || '').startsWith(url));
    if (existing) {
      this.activate(existing.id);
      if (hash) existing.view?.webContents.loadURL(url + '#' + hash).catch(() => {});
    } else this.create(url + (hash ? '#' + hash : ''), { afterActive: true });
  }

  navigate(input) {
    const tab = this.active;
    if (!tab) return;
    const url = this.resolveInput(input);
    tab.addressFocusUntil = 0;
    if (!tab.view) {                     // prázdna nová karta – až teraz vznikne stránka
      this.createView(tab);
      this.win.contentView.addChildView(tab.view);
      this.layout();
    }
    tab.url = url;
    tab.view.webContents.loadURL(url).catch(() => {});
    tab.view.webContents.focus();
  }

  resolveInput(input) {
    const s = (input || '').trim();
    if (!s) return this.newTabUrl();
    if (/^(https?|file|about|chrome|data|view-source|sova):/i.test(s)) return s;
    if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) return 'http://' + s;
    if (!/\s/.test(s) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return 'https://' + s;
    return this.settings.searchUrl(s);
  }

  wc() { return this.active?.view?.webContents || null; }

  // ---------------------------------------------------------------- rozloženie
  layout() {
    const tab = this.active;
    if (!tab?.view) return;
    const { width, height } = this.win.getContentBounds();
    const top = this.fullscreen ? 0 : this.getTopInset();
    const bottom = this.fullscreen ? 0 : this.getBottomInset();     // karty/záložky dole
    tab.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top - bottom) });
  }

  // --------------------------------------------------------------- kontextové menu
  pageMenu(tab, p) {
    const wc = tab.view.webContents;
    const items = [];
    if (p.linkURL) {
      items.push(
        { label: 'Otvoriť odkaz v novej karte', click: () => this.create(p.linkURL, { background: true, afterActive: true }) },
        { label: 'Kopírovať adresu odkazu', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' });
    }
    if (p.hasImageContents && p.srcURL) {
      items.push(
        { label: 'Otvoriť obrázok v novej karte', click: () => this.create(p.srcURL, { background: true, afterActive: true }) },
        { label: 'Kopírovať obrázok', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Uložiť obrázok ako…', click: () => wc.downloadURL(p.srcURL) },
        { type: 'separator' });
    }
    if (p.isEditable) {
      items.push({ role: 'undo', label: 'Späť' }, { role: 'cut', label: 'Vystrihnúť' }, { role: 'copy', label: 'Kopírovať' },
        { role: 'paste', label: 'Vložiť' }, { role: 'selectAll', label: 'Vybrať všetko' }, { type: 'separator' });
    } else if (p.selectionText) {
      const q = p.selectionText.trim().slice(0, 200);
      items.push({ role: 'copy', label: 'Kopírovať' },
        { label: `Hľadať „${q.length > 30 ? q.slice(0, 30) + '…' : q}“`, click: () => this.create(this.settings.searchUrl(q), { afterActive: true }) },
        { type: 'separator' });
    }
    items.push(
      { label: 'Späť', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Dopredu', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Obnoviť', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Preskúmať prvok', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  tabMenu(id) {
    const t = this.get(id);
    if (!t) return;
    const host = this.host(t.url);
    const never = this.matchesList(t.url, 'neverSleep');
    Menu.buildFromTemplate([
      { label: t.pinned ? 'Odopnúť kartu' : 'Pripnúť kartu', click: () => this.togglePin(id) },
      { type: 'separator' },
      { label: 'Nová karta', click: () => this.create() },
      { label: 'Obnoviť', enabled: !!t.view, click: () => t.view?.webContents.reload() },
      { label: 'Duplikovať', click: () => this.duplicate(id) },
      { label: t.muted ? 'Zapnúť zvuk' : 'Stlmiť kartu', click: () => this.toggleMute(id) },
      { type: 'separator' },
      { label: 'Uspať teraz (uvoľniť RAM)', enabled: !!t.view && t.id !== this.activeId, click: () => this.discard(t, true) },
      { label: 'Uspať všetky ostatné karty', click: () => this.sleepOthers() },
      {
        label: host ? `Nikdy neuspávať ${host}` : 'Nikdy neuspávať túto stránku',
        type: 'checkbox', checked: never, enabled: !!host,
        click: () => {
          const list = this.settings.get('neverSleep').filter((d) => d !== host && !host.endsWith('.' + d));
          this.settings.set({ neverSleep: never ? list : [...list, host] });
          this.onChange();
        },
      },
      { type: 'separator' },
      { label: 'Zavrieť ostatné karty', click: () => this.closeOthers(id) },
      { label: 'Zavrieť kartu', click: () => this.close(id) },
    ]).popup({ window: this.win });
  }

  // ------------------------------------------------------------------- stav
  snapshot() {
    const a = this.active;
    const wc = a?.view?.webContents;
    return {
      activeId: this.activeId,
      tabs: this.tabs.map((t) => {
        const pid = t.view && !t.view.webContents.isDestroyed() ? t.view.webContents.getOSProcessId() : 0;
        return {
          id: t.id,
          title: t.title || t.url,
          url: this.isInternal(t.url) ? '' : t.url,
          favicon: t.favicon,
          state: t.state,
          loading: t.loading,
          audible: t.audible,
          muted: t.muted,
          pinned: !!t.pinned,
          crashed: t.crashed,
          neverSleep: this.matchesList(t.url, 'neverSleep'),
          memMB: pid ? Math.round(this.memory.get(pid) || 0) : 0,
          blocked: t.wcId ? this.adblock.countFor(t.wcId) : 0,
        };
      }),
      canGoBack: !!wc && wc.navigationHistory.canGoBack(),
      canGoForward: !!wc && wc.navigationHistory.canGoForward(),
      totalMemMB: Math.round(this.totalMem || 0),
      activeBlank: !!a && this.isBlank(a),
      certError: a?.certError ? { host: a.certError.host, error: a.certError.error } : null,
      adblock: this.adblock.enabled,
      adblockTotal: this.adblock.total,
      siteAllowlisted: a && /^https?:/i.test(a.url) ? this.adblock.isAllowlisted(a.url) : false,
      siteHost: a && /^https?:/i.test(a.url) ? this.host(a.url) : '',
    };
  }

  // ---------------------------------------------------------- uloženie relácie
  saveSession() {
    const data = {
      active: this.tabs.indexOf(this.active),
      tabs: this.tabs.map((t) => {
        let history = t.history, historyIndex = t.historyIndex;
        if (t.view && !t.view.webContents.isDestroyed()) {
          try { history = t.view.webContents.navigationHistory.getAllEntries(); historyIndex = t.view.webContents.navigationHistory.getActiveIndex(); } catch {}
        }
        return { url: t.url, title: t.title, favicon: t.favicon, muted: t.muted, pinned: !!t.pinned, history, historyIndex };
      }),
    };
    try { fs.writeFileSync(this.sessionFile, JSON.stringify(data)); } catch (e) { console.error(e); }
  }

  restoreSession() {
    let data;
    try { data = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8')); } catch { return false; }
    // prázdne „Nové karty“ sa neobnovujú
    const list = (data.tabs || []).filter((t) => t.url && !this.isInternal(t.url));
    // všetky karty sa vytvoria uspaté – nenačítajú sa, kým na ne neklikneš
    for (const t of list) this.create(t.url, { background: true, restore: t });
    return list.length > 0;
  }

  destroy() {
    clearInterval(this.ticker);
    clearInterval(this.memTicker);
  }
}

module.exports = { TabManager, NEWTAB_URL };
