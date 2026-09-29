// Sova – ľahký prehliadač postavený na Chromium (Electron).
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, session, dialog, Menu, nativeTheme, protocol } = require('electron');
const { Settings } = require('./settings');
const { loadWindowState, trackWindowState } = require('./windowstate');
const { AdBlock } = require('./adblock');
const { TabManager } = require('./tabs');
const { History } = require('./history');
const { SuggestPopup } = require('./suggest');
const { Bookmarks } = require('./bookmarks');
const { BookmarkPopover } = require('./bmpopover');
const { setupBookmarks } = require('./bookmarks-ui');
const { Downloads } = require('./downloads');
const { setupTools } = require('./tools-ui');
const { setupSiteInfo } = require('./siteinfo');
const { Updater } = require('./updater');
const defaultBrowser = require('./defaultbrowser');

// Stránky ako Google/Microsoft niekedy blokujú „Electron“ v User-Agente – odstránime ho,
// aby sa prehliadač hlásil ako bežný Chrome.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s?Electron\/\S+/i, '')
  .replace(new RegExp(`\\s?(${app.getName()}|sova)\\/\\S+`, 'ig'), '');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// Interné stránky prehliadača: sova://settings, sova://history
protocol.registerSchemesAsPrivileged([{ scheme: 'sova', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const PAGES = path.join(__dirname, 'ui', 'pages');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveInternal(req) {
  const u = new URL(req.url);
  const file = u.pathname === '/' || u.pathname === '' ? `${u.hostname}.html` : decodeURIComponent(u.pathname.slice(1));
  const full = path.normalize(path.join(PAGES, file));
  if (!full.startsWith(PAGES + path.sep) || !fs.existsSync(full)) {
    return new Response('Stránka neexistuje', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  return new Response(fs.readFileSync(full), { headers: { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' } });
}

let win, tabs, settings, adblock, history, suggest, bookmarks, popover, bmui, downloads, tools, siteinfo, updater;
let topInset = 80, bottomInset = 0, updating = false;
const certExceptions = new Set();
const permDecisions = new Map();

// Farby systémových tlačidiel okna (minimalizovať/maximalizovať/zavrieť) podľa témy
// Výška = horný riadok okna (karty 38 px, pri kartách dole adresný riadok 42 px)
function overlayColors() {
  const height = settings?.get('tabsPosition') === 'bottom' ? 42 : 38;
  return nativeTheme.shouldUseDarkColors
    ? { color: '#1b1c1f', symbolColor: '#e7e8ea', height }
    : { color: '#e8e9ec', symbolColor: '#1f2023', height };
}

// Presunie fokus z webovej stránky do lišty prehliadača a označí adresný riadok
function focusAddress() { focusUI('focus-address'); }

// Presunie fokus do lišty prehliadača a pošle jej príkaz (napr. otvoriť históriu)
function focusUI(channel) {
  const doFocus = () => {
    if (win.isDestroyed()) return;
    win.focus();
    win.webContents.focus();
    win.webContents.send(channel);
  };
  // Spustiť až po dokončení spracovania klávesovej udalosti – inak Windows vráti fokus späť do stránky
  setTimeout(() => {
    doFocus();
    setTimeout(() => {
      if (!win.isDestroyed() && win.isFocused() && !win.webContents.isFocused()) {
        console.warn('[focus] lišta nedostala fokus, opakujem');
        doFocus();
      }
    }, 250);
  }, 0);
}

// odkaz alebo súbor, s ktorým Windows spustil Sovu (predvolený prehliadač, dvojklik na .html)
function urlFromArgs(argv) {
  const a = argv.slice(1).find((x) => /^(https?:|file:|www\.)/i.test(x) || /\.(s?html?|xht(ml)?|pdf)$/i.test(x));
  if (a && /^[a-z]:[\\/]|^\\\\/i.test(a)) return require('url').pathToFileURL(a).href;   // C:\… alebo \\server\…
  return a;
}

// --------------------------------------------------------- klávesové skratky
function shortcut(input) {
  if (input.type !== 'keyDown') return false;
  const k = input.key.toLowerCase();
  const ctrl = input.control || input.meta;
  const wc = tabs.wc();
  const run = (fn) => { fn(); return true; };

  if (ctrl && input.shift && k === 't') return run(() => setTimeout(() => tabs.reopenClosed(), 0));
  if (ctrl && input.shift && k === 'i') return run(() => wc?.toggleDevTools());
  if (ctrl && input.shift && k === 'r') return run(() => wc?.reloadIgnoringCache());
  if (ctrl && input.shift && k === 'b') return run(() => bmui.toggleBar());
  if (ctrl && input.shift && k === 'o') return run(() => setTimeout(() => tabs.openInternal('bookmarks'), 0));
  if (ctrl && k === 'tab') return run(() => tabs.cycle(input.shift ? -1 : 1));
  if (ctrl && k === 'pagedown') return run(() => tabs.cycle(1));
  if (ctrl && k === 'pageup') return run(() => tabs.cycle(-1));
  if (ctrl && !input.shift) {
    if (k === 't') return run(() => setTimeout(() => tabs.create(), 0));
    if (k === 'w' || k === 'f4') return run(() => tabs.close(tabs.activeId));
    if (k === 'l') return run(focusAddress);
    if (k === 'r' || k === 'f5') return run(() => (k === 'f5' ? wc?.reloadIgnoringCache() : wc?.reload()));
    if (k === 'f') return run(() => win.webContents.send('open-find'));
    if (k === 'h') return run(() => setTimeout(() => tabs.openInternal('history'), 0));
    if (k === 'd') return run(() => win.webContents.send('bm:star-request'));
    if (k === 'j') return run(() => setTimeout(() => tabs.openInternal('downloads'), 0));
    if (k === ',') return run(() => setTimeout(() => tabs.openInternal('settings'), 0));
    if (k === '=' || k === '+') return run(() => wc && wc.setZoomLevel(wc.getZoomLevel() + 0.5));
    if (k === '-') return run(() => wc && wc.setZoomLevel(wc.getZoomLevel() - 0.5));
    if (k === '0') return run(() => wc?.setZoomLevel(0));
    if (/^[1-9]$/.test(k)) {
      const t = k === '9' ? tabs.tabs[tabs.tabs.length - 1] : tabs.tabs[+k - 1];
      return t ? run(() => tabs.activate(t.id)) : false;
    }
  }
  if (input.alt && k === 'arrowleft') return run(() => wc?.navigationHistory.goBack());
  if (input.alt && k === 'arrowright') return run(() => wc?.navigationHistory.goForward());
  if (input.alt && k === 'd') return run(focusAddress);
  if (k === 'f5') return run(() => wc?.reload());
  if (k === 'f6') return run(focusAddress);
  if (k === 'f11') return run(() => win.setFullScreen(!win.isFullScreen()));
  if (k === 'f12') return run(() => wc?.toggleDevTools());
  return false;
}

// ------------------------------------------------------------------- stav → UI
let pending = null;
function pushState() {
  if (pending || !win || win.isDestroyed()) return;
  pending = setTimeout(() => {
    pending = null;
    if (!win.isDestroyed()) {
      win.webContents.send('state', { ...tabs.snapshot(), ...(bmui ? bmui.state() : {}), ...(tools ? tools.state() : {}),
        ...(siteinfo ? siteinfo.state() : {}), update: updater?.state(), tabsPosition: settings.get('tabsPosition') });
    }
  }, 60);
}

// ------------------------------------------------------------ oprávnenia stránok
function setupPermissions(sess) {
  const allowAlways = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);
  const labels = {
    media: 'kameru alebo mikrofón', geolocation: 'tvoju polohu', notifications: 'zobrazovať upozornenia',
    'clipboard-read': 'čítať schránku', 'display-capture': 'zdieľať obrazovku',
  };
  sess.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (allowAlways.has(permission)) return callback(true);
    if (!labels[permission]) return callback(false);
    let origin = '';
    try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch {}
    const key = `${origin}|${permission}`;
    if (permDecisions.has(key)) return callback(permDecisions.get(key));
    dialog.showMessageBox(win, {
      type: 'question', buttons: ['Povoliť', 'Zakázať'], defaultId: 1, cancelId: 1,
      title: 'Oprávnenie', message: `${origin} chce ${labels[permission]}.`,
      detail: 'Rozhodnutie platí do zatvorenia prehliadača.',
    }).then(({ response }) => { permDecisions.set(key, response === 0); callback(response === 0); });
  });
  sess.setPermissionCheckHandler((_wc, permission, origin) =>
    allowAlways.has(permission) || permDecisions.get(`${origin}|${permission}`) === true);
}

// ---------------------------------------------------------------------- štart
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  nativeTheme.themeSource = 'system';
  settings = new Settings(app.getPath('userData'));

  const browsing = session.fromPartition('persist:browsing');
  browsing.protocol.handle('sova', serveInternal);
  setupPermissions(browsing);

  const ws = loadWindowState(app.getPath('userData'));
  win = new BrowserWindow({
    ...ws.bounds, minWidth: 480, minHeight: 300,
    title: 'Sova', backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f2023' : '#f3f3f5',
    icon: path.join(__dirname, 'ui', 'icon.png'),
    show: false,
    titleBarStyle: 'hidden',          // bez samostatného titulného riadku – karty sú hore
    titleBarOverlay: overlayColors(),
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'preload.js'),
      partition: 'ui', sandbox: true, contextIsolation: true, spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  // Po spustení: nová karta s prázdnym adresným riadkom a kurzorom v ňom
  let shown = false, started = false;
  const startupFocus = () => {
    const a = tabs?.active;
    if (!shown || !started || !a || !tabs.isInternal(a.url)) return;
    a.addressFocusUntil = Date.now() + 3000;
    focusAddress();
  };
  trackWindowState(win, ws.file);
  win.once('ready-to-show', () => {
    if (ws.maximized) win.maximize();
    win.show(); shown = true; startupFocus();
  });
  nativeTheme.on('updated', () => { if (!win.isDestroyed()) win.setTitleBarOverlay(overlayColors()); });
  settings.on('change', (k) => { if (k === 'tabsPosition' && !win.isDestroyed()) win.setTitleBarOverlay(overlayColors()); });

  adblock = new AdBlock(settings, pushState);
  history = new History(app.getPath('userData'));
  tabs = new TabManager({
    win, session: browsing, settings, adblock, history, onChange: pushState, shortcut,
    getTopInset: () => topInset, getBottomInset: () => bottomInset, ui: win.webContents, focusAddress,
  });
  adblock.init(browsing).catch((e) => console.error('[adblock]', e));

  // záložky
  bookmarks = new Bookmarks(app.getPath('userData'));
  popover = new BookmarkPopover(win, bookmarks);
  bmui = setupBookmarks({ win, tabs, bookmarks, history, settings, popover, pushState });
  // sťahovanie + vyťaženie a test rýchlosti
  downloads = new Downloads(app.getPath('userData'), settings);
  downloads.attach(browsing);
  tools = setupTools({ win, tabs, downloads, session: browsing, settings, pushState,
    openInternal: (n) => tabs.openInternal(n) });
  // informácie o stránke (zámok v adresnom riadku)
  siteinfo = setupSiteInfo({ win, tabs, session: browsing, settings, adblock, certExceptions, permDecisions, pushState });
  ipcMain.on('site:info', (_e, rect) => siteinfo.toggle(rect));
  // automatické aktualizácie (len v nainštalovanej/prenosnej verzii; SOVA_UPDATE_FEED = test)
  updater = new Updater({ settings, testFeed: process.env.SOVA_UPDATE_FEED });
  updater.on('change', () => {
    pushState();
    for (const w of require('electron').webContents.getAllWebContents()) {
      if (!w.isDestroyed() && w.getURL().startsWith('sova://settings')) w.send('internal:update:changed');
    }
  });
  // reštart kvôli aktualizácii: karty sa po nej obnovia vždy (aj keď je obnovenie relácie vypnuté)
  updater.on('before-install', () => {
    updating = true;
    tabs.saveSession();
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'update-restart'), '1'); } catch {}
  });
  updater.start();
  setTimeout(() => defaultBrowser.refresh().catch(() => {}), 5000);
  ipcMain.on('update:install', () => {
    const s = updater.state();
    if (s.status === 'ready') updater.install();
    else if (s.status === 'portable') tabs.create(s.releaseUrl, { afterActive: true });
  });
  Object.assign(module.exports, { bookmarks, bmui, popover, downloads, tools, siteinfo, updater });
  // klik mimo bubliny záložky ju uloží a zavrie
  const focusElsewhere = (wc) => {
    popover.onFocusElsewhere(wc); bmui.menu.onFocusElsewhere(wc); tools?.onFocusElsewhere(wc); siteinfo?.bubble.onFocusElsewhere(wc);
  };
  app.on('web-contents-created', (_e, wc) => wc.on('focus', () => focusElsewhere(wc)));
  win.webContents.on('focus', () => focusElsewhere(win.webContents));
  Object.assign(module.exports, { win, tabs, adblock, settings, browsing });

  win.webContents.on('before-input-event', (e, input) => { if (shortcut(input)) e.preventDefault(); });
  win.on('resize', () => {
    tabs.layout(); suggest.hide(); bmui?.menu.hide(); tools?.hide(); siteinfo?.bubble.hide();
    if (popover.visible) popover.commit();
  });

  // návrhy domén pod adresným riadkom
  const ENGINE = { google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing' };
  suggest = new SuggestPopup(win, (item) => {
    suggest.hide();
    tabs.navigate(item.type === 'search' ? settings.searchUrl(item.text) : item.url);
  });
  ipcMain.on('suggest:query', (_e, text, rect) => {
    const t = String(text || '').trim();
    if (!t) { suggest.hide(); win.webContents.send('suggest:result', text, []); return; }
    const q = t.toLowerCase();
    const items = history.suggest(t).map((d) => {
      // zobrazujeme doménu bez „www.“, pokiaľ ho nepíšeš
      const shown = q.startsWith('www.') ? d.host.toLowerCase() : d.key;
      const matchLen = shown.startsWith(q) ? q.length : 0;
      return { type: 'domain', key: d.key, host: shown, realHost: d.host, url: d.url, title: d.title, favicon: d.favicon, matchLen };
    });
    items.push({ type: 'search', text: t, label: `Hľadať na ${ENGINE[settings.get('searchEngine')] || 'Google'}` });
    win.webContents.send('suggest:result', text, items);
    // samotné „hľadať“ bez návrhov domén nezobrazujeme – Enter aj tak hľadá
    if (items.length > 1) suggest.show(items, rect); else suggest.hide();
  });
  ipcMain.on('suggest:select', (_e, i) => suggest.select(i));
  ipcMain.on('suggest:hide', () => suggest.hide());
  win.on('enter-full-screen', () => tabs.layout());
  win.on('leave-full-screen', () => tabs.layout());
  win.on('app-command', (_e, cmd) => {   // bočné tlačidlá myši
    const wc = tabs.wc();
    if (cmd === 'browser-backward') wc?.navigationHistory.goBack();
    if (cmd === 'browser-forward') wc?.navigationHistory.goForward();
  });
  win.on('close', () => { if (updating || settings.get('restoreSession')) tabs.saveSession(); history.save(); bookmarks.save(); downloads.save(); });

  // Karty až keď je UI načítané (poznáme výšku lišty)
  win.webContents.once('did-finish-load', () => {
    const argUrl = urlFromArgs(process.argv);
    // karty z minula sa obnovia uspaté (bez načítania) a aktívna bude nová prázdna karta
    const flag = path.join(app.getPath('userData'), 'update-restart');
    const afterUpdate = fs.existsSync(flag);
    if (afterUpdate) try { fs.unlinkSync(flag); } catch {}
    if (afterUpdate || settings.get('restoreSession')) tabs.restoreSession();
    tabs.create(argUrl ? tabs.resolveInput(argUrl) : undefined);
    started = true;
    startupFocus();
  });

  // ------------------------------------------------------------------ IPC z UI
  ipcMain.on('ui-height', (_e, top, bottom) => { topInset = Math.round(top); bottomInset = Math.round(bottom || 0); tabs.layout(); });
  ipcMain.on('tab:new', (_e, url) => tabs.create(url ? tabs.resolveInput(url) : undefined));
  ipcMain.on('tab:activate', (_e, id) => tabs.activate(id));
  ipcMain.on('tab:close', (_e, id) => tabs.close(id));
  ipcMain.on('tab:menu', (_e, id) => tabs.tabMenu(id));
  ipcMain.on('tab:mute', (_e, id) => tabs.toggleMute(id));
  ipcMain.on('nav:go', (_e, input) => tabs.navigate(input));
  ipcMain.on('nav:back', () => tabs.wc()?.navigationHistory.goBack());
  ipcMain.on('nav:forward', () => tabs.wc()?.navigationHistory.goForward());
  ipcMain.on('nav:reload', () => tabs.wc()?.reload());
  ipcMain.on('nav:stop', () => tabs.wc()?.stop());
  ipcMain.on('tab:move', (_e, id, index) => tabs.move(id, index));
  // upozornenie na neplatný certifikát: späť / pokračovať
  ipcMain.on('cert:back', () => {
    const t = tabs.active, wc = tabs.wc();
    if (!t?.certError || !wc) return;
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else tabs.navigate('');
  });
  ipcMain.on('cert:proceed', () => {
    const t = tabs.active, wc = tabs.wc();
    if (!t?.certError || !wc) return;
    certExceptions.add(t.certError.host);
    wc.reload();
  });
  ipcMain.on('find', (_e, text, opts) => {
    const wc = tabs.wc();
    if (!wc) return;
    if (text) wc.findInPage(text, opts || {}); else wc.stopFindInPage('clearSelection');
  });
  ipcMain.on('find:stop', () => tabs.wc()?.stopFindInPage('keepSelection'));
  ipcMain.on('open-internal', (_e, name, hash) => {
    if (['settings', 'history', 'bookmarks', 'downloads'].includes(name)) tabs.openInternal(name, hash);
  });
  ipcMain.on('adblock:toggle-site', () => {
    const host = tabs.snapshot().siteHost;
    if (!host) return;
    const list = settings.get('allowlist');
    const on = adblock.isAllowlisted('https://' + host);
    settings.set({ allowlist: on ? list.filter((d) => d !== host && !host.endsWith('.' + d)) : [...list, host] });
    tabs.wc()?.reload();
    pushState();
  });
  ipcMain.on('sleep-others', () => tabs.sleepOthers());

  // ---------------------------------------- IPC z interných stránok (sova://settings, sova://history)
  // Prijíma sa len od stránok s adresou sova:// – bežný web tieto funkcie volať nemôže.
  const fromInternal = (e) => (e.senderFrame?.url || '').startsWith('sova://');
  const handle = (ch, fn) => ipcMain.handle('internal:' + ch, (e, ...a) => {
    if (!fromInternal(e)) throw new Error('Prístup zamietnutý');
    return fn(...a);
  });
  handle('settings:get', () => settings.all());
  handle('update:state', () => updater.state());
  handle('default:status', () => defaultBrowser.status());
  handle('default:set', () => defaultBrowser.makeDefault());
  handle('update:check', () => updater.check());
  handle('update:download', () => updater.download());
  handle('update:install', () => {
    const s = updater.state();
    if (s.status === 'portable') { tabs.create(s.releaseUrl, { afterActive: true }); return true; }
    return updater.install();
  });
  handle('settings:set', (patch) => { settings.set(patch); pushState(); return settings.all(); });
  handle('settings:pick-download-dir', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Priečinok na stiahnuté súbory', properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.get('downloadDir') || app.getPath('downloads'),
    });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.set({ downloadDir: r.filePaths[0] });
    return r.filePaths[0];
  });
  handle('settings:download-dir', () => settings.get('downloadDir') || app.getPath('downloads'));
  handle('clear-data', async () => { await browsing.clearStorageData(); await browsing.clearCache(); return true; });
  handle('history:query', (opts) => history.query(opts || {}));
  handle('history:removeMany', (ids) => history.removeMany(Array.isArray(ids) ? ids : []));
  handle('history:removeSince', (ms) => history.removeSince(Number(ms) || 0));
  ipcMain.on('internal:history:open', (e, url, foreground) => {
    if (!fromInternal(e) || !/^https?:/i.test(String(url))) return;
    tabs.create(url, { background: !foreground, afterActive: true });
  });
});

// Neplatný certifikát (napr. FortiGate, tlačiareň, NAS so self-signed certifikátom) – upozornenie priamo v okne
app.on('certificate-error', (event, wc, url, error, _cert, callback, isMainFrame) => {
  let host = '';
  try { host = new URL(url).host; } catch {}
  event.preventDefault();
  if (certExceptions.has(host)) return callback(true);
  callback(false);
  // pýtame sa len pri otváraní stránky v karte; obrázky, ikony a rozhranie prehliadača sa potichu zamietnu
  const tab = wc && tabs?.tabs.find((t) => t.view && !t.view.webContents.isDestroyed() && t.view.webContents === wc);
  if (tab && isMainFrame !== false) tabs.showCertError(tab, { url, host, error });
});

app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const u = urlFromArgs(argv);
  tabs.create(u ? tabs.resolveInput(u) : undefined);
});

app.on('window-all-closed', () => { tabs?.destroy(); app.quit(); });
