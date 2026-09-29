// Sova – ľahký prehliadač postavený na Chromium (Electron).
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, session, dialog, Menu, nativeTheme, protocol, webContents } = require('electron');
const { Settings } = require('./settings');
const { loadWindowState, trackWindowState, onScreen } = require('./windowstate');
const { setupBookmarksShared } = require('./bookmarks-ui');
const { setupToolsShared } = require('./tools-ui');
const { NetStats } = require('./netstats');
const { ZoomStore } = require('./zoom');
const { createBrowserWindow } = require('./window');
const googleLogin = require('./googlelogin');
const { SafeBrowsing } = require('./safebrowsing');
const { AdBlock } = require('./adblock');
const { History } = require('./history');
const { Bookmarks } = require('./bookmarks');
const { Downloads } = require('./downloads');
const { Updater } = require('./updater');
const defaultBrowser = require('./defaultbrowser');

const { log } = require('./log');

// Stránky ako Google/Microsoft niekedy blokujú „Electron“ v User-Agente – odstránime ho,
// aby sa prehliadač hlásil ako bežný Chrome.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s?Electron\/\S+/i, '')
  .replace(new RegExp(`\\s?(${app.getName()}|sova)\\/\\S+`, 'ig'), '');

if (!app.requestSingleInstanceLock()) { log('druhá inštancia – odovzdané bežiacej Sove', process.argv.slice(1)); app.quit(); process.exit(0); }
log('štart', app.getVersion(), process.argv.slice(1));

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


let settings, adblock, history, bookmarks, downloads, updater, net, browsing, incognitoSession, bookmarksShared, safe;
let updating = false;
const certExceptions = new Set();
const permDecisions = new Map();
const windows = new Set();          // otvorené okná (kontexty z window.js)
let focused = null;                  // naposledy aktívne okno
let zoomNormal = null, zoomIncognito = null, incognitoGen = 0;
const SESSION_FILE = () => path.join(app.getPath('userData'), 'session.json');

const lastWindow = (incognito) => {
  const list = [...windows].filter((c) => !c.win.isDestroyed() && (incognito === undefined || c.incognito === incognito));
  return list.includes(focused) ? focused : list[list.length - 1] || null;
};
const pushAll = () => { for (const c of windows) c.pushState(); };
// okno, ktorému patrí webContents (lišta, karta, bublina)
const ctxOf = (wc) => [...windows].find((c) => !c.win.isDestroyed() && c.owns(wc)) || null;
const ctxOfUI = (wc) => [...windows].find((c) => !c.win.isDestroyed() && c.win.webContents === wc) || null;

// odkaz alebo súbor, s ktorým Windows spustil Sovu (predvolený prehliadač, dvojklik na .html)
function urlFromArgs(argv) {
  const a = argv.slice(1).find((x) => /^(https?:|file:|www\.)/i.test(x) || /\.(s?html?|xht(ml)?|pdf)$/i.test(x));
  if (a && /^[a-z]:[\\/]|^\\\\/i.test(a)) return require('url').pathToFileURL(a).href;   // C:\… alebo \\server\…
  return a;
}

// Ctrl+S – uloží stránku (PDF a iné súbory sa stiahnu)
async function savePage(ctx) {
  const wc = ctx.tabs.wc();
  if (!wc) return;
  const url = wc.getURL();
  if (!/^(https?|file):/i.test(url)) return;
  if (/\.pdf($|[?#])/i.test(url) || !/html/i.test(await wc.executeJavaScript('document.contentType').catch(() => 'text/html'))) {
    wc.downloadURL(url);
    return;
  }
  const name = (wc.getTitle() || 'stranka').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);
  const r = await dialog.showSaveDialog(ctx.win, {
    title: 'Uložiť stránku', defaultPath: path.join(app.getPath('downloads'), name + '.html'),
    filters: [{ name: 'Celá webová stránka', extensions: ['html'] }],
  });
  if (!r.canceled && r.filePath) wc.savePage(r.filePath, 'HTMLComplete').catch((e) => console.warn('[savePage]', e.message));
}
// Ctrl+U – zdrojový kód stránky v novej karte
function viewSource(ctx) {
  const url = ctx.tabs.wc()?.getURL();
  if (url && /^(https?|file):/i.test(url)) ctx.tabs.create('view-source:' + url, { afterActive: true });
}

// --------------------------------------------------------- klávesové skratky
function shortcut(ctx, input) {
  if (input.type !== 'keyDown') return false;
  const { tabs, win } = ctx;
  const k = input.key.toLowerCase();
  const ctrl = input.control || input.meta;
  const wc = tabs.wc();
  const run = (fn) => { fn(); return true; };

  if (ctrl && input.shift && k === 'n') return run(() => setTimeout(() => openWindow({ incognito: true, from: ctx }), 0));
  if (ctrl && input.shift && k === 'w') return run(() => setTimeout(() => win.close(), 0));
  if (ctrl && input.shift && k === 't') return run(() => setTimeout(() => tabs.reopenClosed(), 0));
  if (ctrl && input.shift && k === 'i') return run(() => wc?.toggleDevTools());
  if (ctrl && input.shift && k === 'r') return run(() => wc?.reloadIgnoringCache());
  if (ctrl && input.shift && k === 'b') return run(() => ctx.bmui.toggleBar());
  if (ctrl && input.shift && k === 'o') return run(() => setTimeout(() => tabs.openInternal('bookmarks'), 0));
  if (ctrl && input.shift && k === 'j') return run(() => wc?.toggleDevTools());
  if (ctrl && input.shift && k === 'g') return run(() => win.webContents.send('find-step', false));
  if (ctrl && input.shift && k === 'delete') return run(() => setTimeout(() => tabs.openInternal('history'), 0));
  if (ctrl && input.shift && k === 'pagedown') return run(() => tabs.moveActive(1));
  if (ctrl && input.shift && k === 'pageup') return run(() => tabs.moveActive(-1));
  if (ctrl && k === 'tab') return run(() => tabs.cycle(input.shift ? -1 : 1));
  if (ctrl && k === 'pagedown') return run(() => tabs.cycle(1));
  if (ctrl && k === 'pageup') return run(() => tabs.cycle(-1));
  if (ctrl && !input.shift) {
    if (k === 't') return run(() => setTimeout(() => tabs.create(), 0));
    if (k === 'n') return run(() => setTimeout(() => openWindow({ incognito: false, from: ctx }), 0));
    if (k === 'w' || k === 'f4') return run(() => tabs.close(tabs.activeId));
    if (k === 'l') return run(ctx.focusAddress);
    if (k === 'r' || k === 'f5') return run(() => (k === 'f5' ? wc?.reloadIgnoringCache() : wc?.reload()));
    if (k === 'f') return run(() => win.webContents.send('open-find'));
    if (k === 'h') return run(() => setTimeout(() => tabs.openInternal('history'), 0));
    if (k === 'd') return run(() => win.webContents.send('bm:star-request'));
    if (k === 'j') return run(() => setTimeout(() => tabs.openInternal('downloads'), 0));
    if (k === ',') return run(() => setTimeout(() => tabs.openInternal('settings'), 0));
    if (k === '=' || k === '+') return run(() => tabs.zoomStep(1));
    if (k === '-') return run(() => tabs.zoomStep(-1));
    if (k === '0') return run(() => tabs.zoomStep(0));
    if (k === 'p') return run(() => wc?.print({}, () => {}));
    if (k === 's') return run(() => savePage(ctx));
    if (k === 'u') return run(() => viewSource(ctx));
    if (k === 'e' || k === 'k') return run(ctx.focusAddress);
    if (k === 'g') return run(() => win.webContents.send('find-step', true));
    if (/^[1-9]$/.test(k)) {
      const t = k === '9' ? tabs.tabs[tabs.tabs.length - 1] : tabs.tabs[+k - 1];
      return t ? run(() => tabs.activate(t.id)) : false;
    }
  }
  if (input.alt && k === 'arrowleft') return run(() => wc?.navigationHistory.goBack());
  if (input.alt && k === 'arrowright') return run(() => wc?.navigationHistory.goForward());
  if (input.alt && k === 'd') return run(ctx.focusAddress);
  if (k === 'f5') return run(() => wc?.reload());
  if (k === 'f3') return run(() => win.webContents.send('find-step', !input.shift));
  if (input.alt && k === 'home') return run(() => tabs.navigate(''));
  if (k === 'escape' && wc?.isLoading()) { wc.stop(); return false; }   // zastaví načítanie, Esc dostane aj stránka
  if (k === 'f6') return run(ctx.focusAddress);
  if (k === 'f11') return run(() => win.setFullScreen(!win.isFullScreen()));
  if (k === 'f12') return run(() => wc?.toggleDevTools());
  return false;
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
    dialog.showMessageBox(BrowserWindow.fromWebContents(wc) || lastWindow()?.win, {
      type: 'question', buttons: ['Povoliť', 'Zakázať'], defaultId: 1, cancelId: 1,
      title: 'Oprávnenie', message: `${origin} chce ${labels[permission]}.`,
      detail: 'Rozhodnutie platí do zatvorenia prehliadača.',
    }).then(({ response }) => { permDecisions.set(key, response === 0); callback(response === 0); });
  });
  sess.setPermissionCheckHandler((_wc, permission, origin) =>
    allowAlways.has(permission) || permDecisions.get(`${origin}|${permission}`) === true);
}

// ------------------------------------------------------------ relácie (bežná / inkognito)
function sessionFor(incognito) {
  if (!incognito) return browsing;
  if (!incognitoSession) {
    // v pamäti – cookies, cache ani úložisko stránok sa nezapisujú na disk
    // každé „kolo“ inkognita má novú reláciu – po zatvorení posledného okna sa stará zahodí aj s údajmi
    incognitoSession = session.fromPartition(`sova-incognito-${++incognitoGen}`);
    incognitoSession.protocol.handle('sova', serveInternal);
    setupPermissions(incognitoSession);
    googleLogin.setupSession(incognitoSession);
    adblock.addSession(incognitoSession);
    downloads.attach(incognitoSession, { incognito: true });
  }
  return incognitoSession;
}
function zoomFor(incognito) {
  if (!incognito) return zoomNormal;
  if (!zoomIncognito) zoomIncognito = new ZoomStore(null);
  return zoomIncognito;
}

// ------------------------------------------------------------ uloženie a obnovenie relácie (všetky bežné okná)
function saveSession(reason) {
  const list = [...windows].filter((c) => !c.incognito && !c.win.isDestroyed() && c.tabs);
  if (!list.length) return;
  // aktívne okno nakoniec (po obnovení bude navrchu)
  list.sort((a, b) => (a === focused) - (b === focused));
  const data = {
    version: 2,
    windows: list.map((c) => ({
      bounds: c.win.getNormalBounds(), maximized: c.win.isMaximized(), ...c.tabs.serialize(),
    })),
  };
  try { fs.writeFileSync(SESSION_FILE(), JSON.stringify(data)); } catch (e) { console.error(e); }
  log('relácia uložená', reason || '', { okná: data.windows.length, karty: data.windows.reduce((s, w) => s + w.tabs.length, 0) });
}
function readSession() {
  try {
    const d = JSON.parse(fs.readFileSync(SESSION_FILE(), 'utf8'));
    if (Array.isArray(d.windows)) return d.windows;
    if (Array.isArray(d.tabs)) return [d];              // starší formát (jedno okno)
  } catch {}
  return [];
}

// ------------------------------------------------------------ nové okno
const services = {};
function openWindow({ incognito = false, url = null, from = null, restore = null, bounds = null, maximized = false, first = false } = {}) {
  let b = bounds, max = maximized;
  if (!b && from && !from.win.isDestroyed()) {             // nové okno kúsok vedľa aktuálneho (ako v Chrome)
    const f = from.win.getNormalBounds();
    b = { x: f.x + 30, y: f.y + 30, width: f.width, height: f.height };
    if (!onScreen(b)) b = { width: f.width, height: f.height };
  }
  if (b && b.x !== undefined && !onScreen(b)) b = { width: b.width || 1280, height: b.height || 820 };
  const ctx = createBrowserWindow(services, {
    bounds: b, maximized: max, incognito,
    onReady: (c) => {
      if (restore) c.tabs.restore(restore);
      if (first) {
        c.tabs.create(url ? c.tabs.resolveInput(url) : undefined);
        for (const u of pendingUrls.splice(0)) c.tabs.create(c.tabs.resolveInput(u), { background: true });
      } else if (!restore || url) c.tabs.create(url ? c.tabs.resolveInput(url) : undefined);
      c.tabsReady = true;
      log('okno pripravené', c.id, { incognito, karty: c.tabs.tabs.length });
    },
  });
  windows.add(ctx);
  focused = ctx;
  if (!incognito && first) trackWindowState(ctx.win, loadWindowState(app.getPath('userData')).file);
  else if (!incognito) trackWindowState(ctx.win, path.join(app.getPath('userData'), 'window.json'));
  return ctx;
}

// ---------------------------------------------------------------------- štart
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  nativeTheme.themeSource = 'system';
  settings = new Settings(app.getPath('userData'));

  browsing = session.fromPartition('persist:browsing');
  browsing.protocol.handle('sova', serveInternal);
  setupPermissions(browsing);
  googleLogin.setupGoogleLogin();
  googleLogin.setupSession(browsing);

  adblock = new AdBlock(settings, pushAll);
  history = new History(app.getPath('userData'));
  bookmarks = new Bookmarks(app.getPath('userData'));
  downloads = new Downloads(app.getPath('userData'), settings);
  // ochrana pred podvodnými a nebezpečnými stránkami (aj sťahovanie z nich sa zablokuje)
  safe = new SafeBrowsing(app.getPath('userData'), settings);
  safe.start().catch((e) => console.error('[ochrana]', e));
  safe.on('change', () => {
    for (const w of webContents.getAllWebContents()) {
      if (!w.isDestroyed() && w.getURL().startsWith('sova://settings')) w.send('internal:safe:changed');
    }
  });
  downloads.guard = (url) => safe.check(url);
  downloads.attach(browsing);
  net = new NetStats(pushAll, 2000);
  zoomNormal = new ZoomStore(app.getPath('userData'));
  adblock.init(browsing).catch((e) => console.error('[adblock]', e));
  bookmarksShared = setupBookmarksShared({ bookmarks, history, session: browsing, pushAll,
    windowFor: (e) => (e && ctxOf(e.sender)) || lastWindow() });
  setupToolsShared({ downloads, session: browsing });

  // automatické aktualizácie (len v nainštalovanej/prenosnej verzii; SOVA_UPDATE_FEED = test)
  updater = new Updater({ settings, testFeed: process.env.SOVA_UPDATE_FEED });
  updater.on('change', () => {
    pushAll();
    for (const w of webContents.getAllWebContents()) {
      if (!w.isDestroyed() && w.getURL().startsWith('sova://settings')) w.send('internal:update:changed');
    }
  });
  // reštart kvôli aktualizácii: karty sa po nej obnovia vždy (aj keď je obnovenie relácie vypnuté)
  updater.on('before-install', () => {
    updating = true;
    saveSession('aktualizácia');
    for (const c of windows) if (!c.win.isDestroyed()) c.win.hide();   // okná zmiznú hneď
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'update-restart'), '1'); } catch {}
  });
  updater.start();
  setTimeout(() => defaultBrowser.refresh().catch(() => {}), 5000);

  Object.assign(services, {
    settings, history, bookmarks, bookmarksShared, adblock, downloads, net, updater, certExceptions, permDecisions,
    shortcut, sessionFor, zoomFor, guard: (url) => safe.check(url),
    newWindow: (url, incognito) => openWindow({ url, incognito, from: lastWindow() }),
    focusElsewhere: (wc) => { for (const c of windows) if (!c.win.isDestroyed()) c.onFocusElsewhere(wc); },
    onFocus: (c) => { focused = c; },
    onClose: (c) => {
      // zatvára sa posledné bežné okno → uložíme reláciu (s ostatnými bežnými oknami, ak ešte sú)
      const normal = [...windows].filter((x) => !x.incognito && !x.win.isDestroyed());
      if (!c.incognito && normal.length === 1 && (updating || settings.get('restoreSession'))) saveSession('zatvorenie okna');
      if (normal.length === 1 || windows.size === 1) { history.save(); bookmarks.save(); downloads.save(); }
    },
    onClosed: (c) => {
      windows.delete(c);
      if (focused === c) focused = lastWindow();
      // posledné okno inkognito zatvorené → zabudneme všetko, čo si v ňom robil
      if (c.incognito && ![...windows].some((x) => x.incognito) && incognitoSession) {
        const old = incognitoSession;
        incognitoSession = null;
        old.clearStorageData().catch(() => {});
        old.clearCache().catch(() => {});
        downloads.forgetIncognito?.();
        zoomIncognito = null;
        log('inkognito ukončené – údaje vymazané');
      }
    },
  });
  Object.assign(module.exports, { settings, adblock, history, bookmarks, downloads, updater, browsing, windows, openWindow, saveSession, safe });

  app.on('web-contents-created', (_e, wc) => wc.on('focus', () => services.focusElsewhere(wc)));

  // prvé okno: obnovenie kariet z minula (uspané) + nová prázdna karta
  const flag = path.join(app.getPath('userData'), 'update-restart');
  const afterUpdate = fs.existsSync(flag);
  if (afterUpdate) try { fs.unlinkSync(flag); } catch {}
  const saved = afterUpdate || settings.get('restoreSession') ? readSession() : [];
  const ws = loadWindowState(app.getPath('userData'));
  const argUrl = urlFromArgs(process.argv);
  // okná z minula (aktívne bolo uložené posledné – otvorí sa posledné, aby bolo navrchu)
  saved.slice(0, -1).forEach((w) => openWindow({ restore: w, bounds: w.bounds, maximized: w.maximized }));
  const main = saved[saved.length - 1];
  openWindow({ first: true, url: argUrl, restore: main || null,
    bounds: main?.bounds && onScreen(main.bounds) ? main.bounds : ws.bounds, maximized: main ? !!main.maximized : ws.maximized });
  log('okná obnovené', { afterUpdate, okná: saved.length || 1 });

  // ------------------------------------------------------------------ IPC z lišty (každé okno má svoju)
  const ui = (ch, fn) => ipcMain.on(ch, (e, ...a) => { const c = ctxOfUI(e.sender); if (c) fn(c, ...a); });
  ui('ui-height', (c, top, bottom) => { c.topInset = Math.round(top); c.bottomInset = Math.round(bottom || 0); c.tabs.layout(); });
  ui('tab:new', (c, url) => c.tabs.create(url ? c.tabs.resolveInput(url) : undefined));
  ui('tab:activate', (c, id) => c.tabs.activate(id));
  ui('tab:close', (c, id) => c.tabs.close(id));
  ui('tab:menu', (c, id) => c.tabs.tabMenu(id));
  ui('tab:mute', (c, id) => c.tabs.toggleMute(id));
  ui('tab:move', (c, id, index) => c.tabs.move(id, index));
  ui('nav:go', (c, input) => c.tabs.navigate(input));
  ui('nav:back', (c) => c.tabs.wc()?.navigationHistory.goBack());
  ui('nav:forward', (c) => c.tabs.wc()?.navigationHistory.goForward());
  ui('nav:reload', (c) => c.tabs.wc()?.reload());
  ui('nav:stop', (c) => c.tabs.wc()?.stop());
  ui('window:new', (c, incognito) => openWindow({ incognito: !!incognito, from: c }));
  ui('window:menu', (c) => Menu.buildFromTemplate([
    { label: 'Nová karta', accelerator: 'Ctrl+T', click: () => c.tabs.create() },
    { label: 'Nové okno', accelerator: 'Ctrl+N', click: () => openWindow({ from: c }) },
    { label: 'Nové okno inkognito', accelerator: 'Ctrl+Shift+N', click: () => openWindow({ incognito: true, from: c }) },
  ]).popup({ window: c.win }));
  // upozornenie na neplatný certifikát: späť / pokračovať
  ui('cert:back', (c) => {
    const t = c.tabs.active, wc = c.tabs.wc();
    if (!t?.certError || !wc) return;
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else c.tabs.navigate('');
  });
  ui('cert:proceed', (c) => {
    const t = c.tabs.active, wc = c.tabs.wc();
    if (!t?.certError || !wc) return;
    certExceptions.add(t.certError.host);
    wc.reload();
  });
  // varovanie pred nebezpečnou stránkou: späť / pokračovať
  ui('danger:back', (c) => c.tabs.dangerBack());
  ui('danger:proceed', (c) => c.tabs.dangerProceed(c.tabs.active, (host) => safe.allow(host)));
  ui('find', (c, text, opts) => {
    const wc = c.tabs.wc();
    if (!wc) return;
    if (text) wc.findInPage(text, opts || {}); else wc.stopFindInPage('clearSelection');
  });
  ui('find:stop', (c) => c.tabs.wc()?.stopFindInPage('keepSelection'));
  ui('open-internal', (c, name, hash) => {
    if (['settings', 'history', 'bookmarks', 'downloads'].includes(name)) c.tabs.openInternal(name, hash);
  });
  ui('adblock:toggle-site', (c) => {
    const host = c.tabs.snapshot().siteHost;
    if (!host) return;
    const list = settings.get('allowlist');
    const on = adblock.isAllowlisted('https://' + host);
    settings.set({ allowlist: on ? list.filter((d) => d !== host && !host.endsWith('.' + d)) : [...list, host] });
    c.tabs.wc()?.reload();
    pushAll();
  });
  ui('sleep-others', (c) => c.tabs.sleepOthers());
  ui('site:info', (c, rect) => c.siteinfo.toggle(rect));
  ui('suggest:query', (c, text, rect) => c.suggestQuery(text, rect));
  ui('suggest:select', (c, i) => c.suggest.select(i));
  ui('suggest:hide', (c) => c.suggest.hide());
  ui('update:install', (c) => {
    const s = updater.state();
    if (s.status === 'ready') updater.install();
    else if (s.status === 'portable') c.tabs.create(s.releaseUrl, { afterActive: true });
  });

  // ---------------------------------------- IPC z interných stránok (sova://settings, sova://history)
  // Prijíma sa len od stránok s adresou sova:// – bežný web tieto funkcie volať nemôže.
  const fromInternal = (e) => (e.senderFrame?.url || '').startsWith('sova://');
  const handle = (ch, fn) => ipcMain.handle('internal:' + ch, (e, ...a) => {
    if (!fromInternal(e)) throw new Error('Prístup zamietnutý');
    return fn(...a, ctxOf(e.sender) || lastWindow());
  });
  handle('settings:get', () => settings.all());
  handle('update:state', () => updater.state());
  handle('safe:state', () => safe.state());
  handle('safe:refresh', () => safe.refresh(true).then(() => safe.state()));
  handle('default:status', () => defaultBrowser.status());
  handle('default:set', () => defaultBrowser.makeDefault());
  handle('update:check', () => updater.check());
  handle('update:download', () => updater.download());
  handle('update:install', (c) => {
    const s = updater.state();
    if (s.status === 'portable') { c?.tabs.create(s.releaseUrl, { afterActive: true }); return true; }
    return updater.install();
  });
  handle('settings:set', (patch) => { settings.set(patch); pushAll(); return settings.all(); });
  handle('settings:pick-download-dir', async (c) => {
    const r = await dialog.showOpenDialog(c?.win, {
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
    (ctxOf(e.sender) || lastWindow())?.tabs.create(url, { background: !foreground, afterActive: true });
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
  for (const c of windows) {
    const tab = wc && c.tabs?.tabs.find((t) => t.view && !t.view.webContents.isDestroyed() && t.view.webContents === wc);
    if (tab && isMainFrame !== false) { c.tabs.showCertError(tab, { url, host, error }); return; }
  }
});

// Sova už beží a niekto ju spustil znova (ikona, odkaz z Outlooku, inštalátor po aktualizácii)
let pendingUrls = [];
app.on('second-instance', (_e, argv) => {
  const u = urlFromArgs(argv);
  log('second-instance', argv.slice(1), 'url:', u || '-');
  const c = lastWindow(false) || lastWindow();
  if (!c) { if (u) pendingUrls.push(u); return; }
  const win = c.win;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  if (!u) return;                              // len ikona → stačí okno ukázať, žiadna nová prázdna karta
  if (c.tabsReady) c.tabs.create(c.tabs.resolveInput(u));
  else pendingUrls.push(u);                    // karty sa ešte obnovujú – otvoríme po nich
});

app.on('window-all-closed', () => { log('všetky okná zatvorené'); app.quit(); });
app.on('before-quit', () => { log('ukončovanie'); if (windows.size > 1 && (updating || settings?.get('restoreSession'))) saveSession('ukončenie'); });
app.on('quit', () => log('ukončené'));

// pre testy: aktuálne okno a jeho časti
for (const k of ['win', 'tabs', 'bmui', 'popover', 'tools', 'siteinfo', 'zoomui', 'suggest']) {
  Object.defineProperty(module.exports, k, { get: () => lastWindow()?.[k], enumerable: true });
}
