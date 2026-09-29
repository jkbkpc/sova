// Jedno okno prehliadača: lišta (karty, adresný riadok, záložky), karty a bubliny nad stránkou.
// Zdieľané služby (nastavenia, história, záložky, blokovanie reklám, sťahovanie) dostáva zvonku.
const path = require('path');
const { app, BrowserWindow, dialog, nativeTheme } = require('electron');
const { TabManager } = require('./tabs');
const { SuggestPopup } = require('./suggest');
const { BookmarkPopover } = require('./bmpopover');
const { setupBookmarks } = require('./bookmarks-ui');
const { setupTools } = require('./tools-ui');
const { setupSiteInfo } = require('./siteinfo');
const { setupZoom } = require('./zoom-ui');
const { log } = require('./log');

let nextId = 1;

// Farby systémových tlačidiel okna (minimalizovať/maximalizovať/zavrieť) podľa témy
// Výška = horný riadok okna (karty 38 px, pri kartách dole adresný riadok 42 px)
function overlayColors(settings, incognito) {
  const height = settings.get('tabsPosition') === 'bottom' ? 42 : 38;
  if (incognito) return { color: '#2b2140', symbolColor: '#ece7f7', height };
  return nativeTheme.shouldUseDarkColors
    ? { color: '#1b1c1f', symbolColor: '#e7e8ea', height }
    : { color: '#e8e9ec', symbolColor: '#1f2023', height };
}

// services: { settings, history, bookmarks, bookmarksShared, adblock, downloads, net, updater, certExceptions,
//             permDecisions, shortcut(ctx, input), sessionFor(incognito), onClosed(ctx), newWindow(url, incognito) }
function createBrowserWindow(services, { bounds, maximized = false, incognito = false, onReady } = {}) {
  const { settings, history, bookmarks, adblock, downloads, net, updater } = services;
  const id = nextId++;
  const session = services.sessionFor(incognito);
  const ctx = { id, incognito, session, topInset: 80, bottomInset: 0, ready: false };

  const win = new BrowserWindow({
    ...(bounds || { width: 1280, height: 820 }), minWidth: 480, minHeight: 300,
    title: incognito ? 'Sova – inkognito' : 'Sova',
    backgroundColor: incognito ? '#231b33' : nativeTheme.shouldUseDarkColors ? '#1f2023' : '#f3f3f5',
    icon: path.join(__dirname, 'ui', 'icon.png'),
    show: false,
    titleBarStyle: 'hidden',          // bez samostatného titulného riadku – karty sú hore
    titleBarOverlay: overlayColors(settings, incognito),
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'preload.js'),
      partition: 'ui', sandbox: true, contextIsolation: true, spellcheck: false,
    },
  });
  ctx.win = win;
  win.loadFile(path.join(__dirname, 'ui', 'index.html'), { query: incognito ? { incognito: '1' } : {} });

  // ------------------------------------------------------------ fokus lišty
  // Presunie fokus do lišty prehliadača a pošle jej príkaz (napr. označiť adresný riadok)
  ctx.focusUI = (channel) => {
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
        if (!win.isDestroyed() && win.isFocused() && !win.webContents.isFocused()) doFocus();
      }, 250);
    }, 0);
  };
  ctx.focusAddress = () => ctx.focusUI('focus-address');

  // ------------------------------------------------------------ stav → lišta
  let pending = null;
  ctx.pushState = () => {
    if (pending || win.isDestroyed()) return;
    pending = setTimeout(() => {
      pending = null;
      if (win.isDestroyed() || !ctx.tabs) return;
      win.webContents.send('state', {
        ...ctx.tabs.snapshot(), ...(ctx.bmui ? ctx.bmui.state() : {}), ...(ctx.tools ? ctx.tools.state() : {}),
        ...(ctx.siteinfo ? ctx.siteinfo.state() : {}), update: updater?.state(),
        tabsPosition: settings.get('tabsPosition'), incognito,
      });
    }, 60);
  };

  // ------------------------------------------------------------ karty a časti lišty
  ctx.tabs = new TabManager({
    win, session, settings, adblock, history: incognito ? null : history, incognito,
    onChange: ctx.pushState, shortcut: (input) => services.shortcut(ctx, input),
    getTopInset: () => ctx.topInset, getBottomInset: () => ctx.bottomInset, ui: win.webContents,
    focusAddress: ctx.focusAddress, zoom: services.zoomFor(incognito), guard: services.guard,
  });
  const tabs = ctx.tabs;
  tabs.newWindow = services.newWindow;

  ctx.popover = new BookmarkPopover(win, bookmarks);
  ctx.bmui = setupBookmarks({ win, tabs, bookmarks, settings, popover: ctx.popover, pushState: ctx.pushState,
    shared: services.bookmarksShared, newWindow: services.newWindow });
  ctx.tools = setupTools({ win, id, tabs, downloads, session, net, pushState: ctx.pushState,
    openInternal: (n) => tabs.openInternal(n) });
  ctx.siteinfo = setupSiteInfo({ win, id, tabs, session, settings, adblock, certExceptions: services.certExceptions,
    permDecisions: services.permDecisions, pushState: ctx.pushState });
  ctx.zoomui = setupZoom({ win, id, tabs });

  const ENGINE = { google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing' };
  ctx.suggest = new SuggestPopup(win, (item) => {
    ctx.suggest.hide();
    tabs.navigate(item.type === 'search' ? settings.searchUrl(item.text) : item.url);
  });
  ctx.suggestQuery = (text, rect) => {
    const t = String(text || '').trim();
    if (!t) { ctx.suggest.hide(); win.webContents.send('suggest:result', text, []); return; }
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
    if (items.length > 1) ctx.suggest.show(items, rect); else ctx.suggest.hide();
  };

  // bubliny a menu nad stránkou
  const popups = () => [ctx.popover, ctx.bmui.menu, ctx.suggest, ...(ctx.tools.bubbles || []), ctx.siteinfo.bubble, ctx.zoomui.bubble];
  ctx.onFocusElsewhere = (wc) => {
    ctx.popover.onFocusElsewhere(wc); ctx.bmui.menu.onFocusElsewhere(wc); ctx.tools.onFocusElsewhere(wc);
    ctx.siteinfo.bubble.onFocusElsewhere(wc); ctx.zoomui.bubble.onFocusElsewhere(wc);
  };
  ctx.hidePopups = () => {
    ctx.suggest.hide(); ctx.bmui.menu.hide(); ctx.tools.hide(); ctx.siteinfo.bubble.hide(); ctx.zoomui.hide();
    if (ctx.popover.visible) ctx.popover.commit();
  };
  // patrí webContents tomuto oknu? (lišta, karta alebo bublina)
  ctx.owns = (wc) => !!wc && (wc === win.webContents
    || tabs.tabs.some((t) => t.view && !t.view.webContents.isDestroyed() && t.view.webContents === wc)
    || popups().some((p) => p?.view && p.view.webContents === wc));

  // ------------------------------------------------------------ udalosti okna
  const onTheme = () => { if (!win.isDestroyed()) win.setTitleBarOverlay(overlayColors(settings, incognito)); };
  const onSetting = (k) => { if (k === 'tabsPosition') onTheme(); ctx.pushState(); };
  nativeTheme.on('updated', onTheme);
  settings.on('change', onSetting);
  win.webContents.on('focus', () => services.focusElsewhere(win.webContents));
  win.webContents.on('before-input-event', (e, input) => { if (services.shortcut(ctx, input)) e.preventDefault(); });
  win.on('focus', () => services.onFocus?.(ctx));
  win.on('resize', () => { tabs.layout(); ctx.hidePopups(); });
  win.on('enter-full-screen', () => tabs.layout());
  win.on('leave-full-screen', () => tabs.layout());
  win.on('app-command', (_e, cmd) => {   // bočné tlačidlá myši
    const wc = tabs.wc();
    if (cmd === 'browser-backward') wc?.navigationHistory.goBack();
    if (cmd === 'browser-forward') wc?.navigationHistory.goForward();
  });
  win.on('close', () => {
    services.onClose?.(ctx);
    // bubliny odpojíme od okna ešte pred jeho zrušením (inak Chromium neskôr zamrzne pri novom okne)
    for (const p of popups()) {
      try {
        if (p?.view) {
          win.contentView.removeChildView(p.view);
          p.visible = false;
          if (!p.view.webContents.isDestroyed()) p.view.webContents.close();
          p.view = null;
        }
      } catch {}
    }
  });
  win.on('closed', () => {
    nativeTheme.off('updated', onTheme);
    settings.off('change', onSetting);
    tabs.destroy();
    // stránky a bubliny tohto okna ukončíme (inak by ich procesy ostali bežať)
    for (const t of tabs.tabs) { try { if (t.view && !t.view.webContents.isDestroyed()) t.view.webContents.close(); } catch {} }
    services.onClosed?.(ctx);
  });

  // zobrazenie okna (ready-to-show niekedy nepríde – napr. po spustení inštalátorom)
  let shown = false;
  const startupFocus = () => {
    const a = tabs.active;
    if (!shown || !ctx.ready || !a || !tabs.isInternal(a.url)) return;
    a.addressFocusUntil = Date.now() + 3000;
    ctx.focusAddress();
  };
  const showWin = (why) => {
    if (shown || win.isDestroyed()) return;
    log('zobrazenie okna', id, why);
    if (maximized) win.maximize();
    win.show(); shown = true; startupFocus();
  };
  win.once('ready-to-show', () => showWin('ready-to-show'));
  setTimeout(() => showWin('poistka po 3 s'), 3000);

  // karty až keď je lišta načítaná (poznáme jej výšku)
  win.webContents.once('did-finish-load', () => {
    try { onReady?.(ctx); } catch (e) { console.error('[okno]', e); }
    if (!tabs.tabs.length) tabs.create();
    ctx.ready = true;
    startupFocus();
  });

  ctx.dialogParent = win;
  ctx.showMessage = (opts) => dialog.showMessageBox(win, opts);
  return ctx;
}

module.exports = { createBrowserWindow, overlayColors };
