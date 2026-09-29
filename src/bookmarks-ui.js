// Prepojenie záložiek s oknom: hviezdička, lišta záložiek (menu priečinkov, kontextové menu),
// a API pre správcu záložiek sova://bookmarks.
//  - setupBookmarksShared: raz pre celý prehliadač (ikony, API pre sova://bookmarks)
//  - setupBookmarks: pre každé okno (lišta, hviezdička, menu)
const fs = require('fs');
const { ipcMain, Menu, dialog, webContents } = require('electron');
const { Bookmarks, BAR, OTHER, findBrowserProfiles } = require('./bookmarks');
const { BookmarkMenu } = require('./bmmenu');
const { fetchIcon, discoverIcon, hostKey } = require('./favicons');

function setupBookmarksShared({ bookmarks, history, session, pushAll, windowFor }) {
  const favicon = (url) => {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return '';
      // skutočná ikona je uložená v záložke (n.icon); tu len záloha z histórie
      return history.domains[u.host.toLowerCase().replace(/^www\./, '')]?.favicon || '';
    } catch { return ''; }
  };
  const iconOf = (n) => n.icon || favicon(n.url);
  const slim = (n) => ({ id: n.id, type: n.type, title: n.title, url: n.url || '', favicon: n.type === 'url' ? iconOf(n) : '' });

  // --------------------------------------------------------- API pre sova://bookmarks
  const fromInternal = (e) => (e.senderFrame?.url || '').startsWith('sova://');
  let currentEvent = null;                        // okno, z ktorého prišla požiadavka (otvorenie, dialógy)
  const handle = (ch, fn) => ipcMain.handle('internal:' + ch, (e, ...a) => {
    if (!fromInternal(e)) throw new Error('Prístup zamietnutý');
    currentEvent = e;
    return fn(...a);
  });
  const withIcons = (n) => {
    if (n.type === 'folder') return { ...n, children: n.children.map(withIcons) };
    const { icon, iconTried, ...rest } = n;
    return { ...rest, favicon: iconOf(n) };
  };
  handle('bookmarks:tree', () => withIcons(bookmarks.tree()));
  handle('bookmarks:search', (q) => bookmarks.search(String(q || '')).map(withIcons));
  handle('bookmarks:add', (o) => bookmarks.add(o || {}));
  handle('bookmarks:update', (id, o) => bookmarks.update(id, o || {}));
  handle('bookmarks:move', (id, parentId, index) => bookmarks.move(id, parentId, index));
  handle('bookmarks:remove', (id) => bookmarks.remove(id));
  handle('bookmarks:restore', (info) => bookmarks.restore(info));
  handle('bookmarks:open', (id, how) => {
    const b = windowFor(currentEvent)?.bmui;
    const n = bookmarks.find(id)?.node;
    if (!b) return;
    if (n?.type === 'url') b.open(n.url, how || 'new');
    else if (n?.type === 'folder') b.openAll(n);
  });
  handle('bookmarks:sources', () => findBrowserProfiles().map(({ id, browser, profile }) => ({ id, browser, profile })));
  handle('bookmarks:import', (id) => {
    const src = findBrowserProfiles().find((p) => p.id === id);
    if (!src) throw new Error('Zdroj sa nenašiel');
    return bookmarks.importChromium(src.file, src.browser);
  });
  handle('bookmarks:import-html', async () => {
    const r = await dialog.showOpenDialog(windowFor(currentEvent)?.win, {
      title: 'Importovať záložky zo súboru HTML', properties: ['openFile'],
      filters: [{ name: 'Záložky (HTML)', extensions: ['html', 'htm'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return bookmarks.importHtml(r.filePaths[0]);
  });
  handle('bookmarks:export-html', async () => {
    const d = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(windowFor(currentEvent)?.win, {
      title: 'Exportovať záložky', defaultPath: `sova-zalozky-${d}.html`,
      filters: [{ name: 'Záložky (HTML)', extensions: ['html'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, bookmarks.exportHtml());
    return r.filePath;
  });


  // --------------------------------------------------------- ikony záložiek
  const iconCache = new Map();                   // adresa ikony → data: URL
  async function iconFromUrl(iconUrl) {
    if (iconCache.has(iconUrl)) return iconCache.get(iconUrl);
    const icon = await fetchIcon(session, iconUrl);
    if (iconCache.size > 300) iconCache.delete(iconCache.keys().next().value);
    iconCache.set(iconUrl, icon);
    return icon;
  }
  // navštívená stránka ukázala ikonu → uložíme ju do záložiek tej stránky (aj po presmerovaní)
  // a do záložiek z tej istej domény, ktoré ešte ikonu nemajú
  // záloha: ikonu prečíta priamo stránka (napr. zariadenie s neplatným certifikátom, ktorý si povolil)
  const PAGE_ICON = `(async (src) => {
    const img = new Image();
    await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = src; });
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    c.getContext('2d').drawImage(img, 0, 0, 32, 32);
    return c.toDataURL('image/png');
  })`;
  async function iconFromPage(wc, iconUrl) {
    if (!wc || wc.isDestroyed()) return '';
    if (wc.isLoading()) {                        // počas načítania by skript čakal – počkáme na koniec
      await new Promise((res) => { const t = setTimeout(res, 15000); wc.once('did-stop-loading', () => { clearTimeout(t); res(); }); });
      if (wc.isDestroyed()) return '';
    }
    try {
      const r = await Promise.race([
        wc.executeJavaScript(`${PAGE_ICON}(${JSON.stringify(iconUrl)})`),
        new Promise((res) => setTimeout(() => res(''), 5000)),
      ]);
      return typeof r === 'string' && r.startsWith('data:image/png') && r.length < 100000 ? r : '';
    } catch (e) { if (process.env.SOVA_DEBUG) console.log('[fav-page]', iconUrl, e.message); return ''; }
  }
  // navštívená stránka ukázala ikonu → uložíme ju do záložiek tej stránky (aj po presmerovaní)
  // a do záložiek z tej istej domény, ktoré ešte ikonu nemajú
  async function onFavicon({ url, startUrl, icon: iconUrl, wc }) {
    const exact = new Set([url, startUrl].filter(Boolean).map((u) => Bookmarks.norm(u)));
    const hosts = new Set([url, startUrl].filter(Boolean).map(hostKey).filter(Boolean));
    const hits = [];
    bookmarks.walk((n) => {
      if (n.type !== 'url') return;
      if (exact.has(Bookmarks.norm(n.url))) hits.push(n);
      else if (!n.icon && hosts.has(hostKey(n.url))) hits.push(n);
    });
    if (!hits.length) return;
    const icon = (await iconFromUrl(iconUrl)) || (await iconFromPage(wc, iconUrl));
    if (icon) for (const n of hits) bookmarks.setIcon(n, icon);
  }

  // na pozadí doplní ikony záložkám, ktoré ich nemajú (napr. po importe)
  const RETRY = 7 * 24 * 3600e3;
  let filling = false, fillTimer = null;
  const scheduleFill = (ms = 3000) => { clearTimeout(fillTimer); fillTimer = setTimeout(fill, ms); };
  async function fill() {
    if (filling) return scheduleFill(5000);
    filling = true;
    try {
      const todo = [];
      bookmarks.walk((n) => {
        if (n.type === 'url' && !n.icon && /^https?:/i.test(n.url) && !(n.iconTried > Date.now() - RETRY)) todo.push(n);
      });
      const byHost = new Map();                  // doména → Promise<data: URL>
      const one = async (n) => {
        const h = hostKey(n.url);
        if (!byHost.has(h)) {
          byHost.set(h, (async () => {
            const known = history.domains[h]?.favicon;
            return (known && await iconFromUrl(known)) || discoverIcon(session, n.url);
          })());
        }
        let icon = await byHost.get(h);
        if (!icon) icon = await discoverIcon(session, n.url);   // iná podstránka môže mať vlastnú ikonu
        if (!bookmarks.find(n.id)) return;
        if (icon) bookmarks.setIcon(n, icon); else bookmarks.markIconTried(n);
      };
      let i = 0;
      const worker = async () => { while (i < todo.length) await one(todo[i++]).catch(() => {}); };
      await Promise.all([worker(), worker(), worker(), worker()]);
    } finally { filling = false; }
  }
  scheduleFill(8000);

  // zmeny → lišty všetkých okien + otvorené stránky správcu záložiek
  bookmarks.on('change', () => {
    scheduleFill();
    pushAll();
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed() && wc.getURL().startsWith('sova://bookmarks')) wc.send('internal:bookmarks:changed');
    }
  });

  return { slim, onFavicon };
}

function setupBookmarks({ win, tabs, bookmarks, settings, popover, pushState, shared, newWindow }) {
  const { slim } = shared;
  // správy z lišty prijímame len z lišty tohto okna
  const on = (ch, fn) => ipcMain.on(ch, (e, ...a) => { if (!win.isDestroyed() && e.sender === win.webContents) fn(...a); });

  // --------------------------------------------------------- otváranie
  // how: 'current' | 'new' (nová karta v popredí) | 'background'
  function open(url, how = 'current') {
    if (!url) return;
    if (how === 'current' && tabs.active) tabs.navigate(url);
    else tabs.create(url, { background: how === 'background', afterActive: true });
  }
  function openAll(folder) {
    const urls = [];
    bookmarks.walk((n) => { if (n.type === 'url') urls.push(n.url); }, folder);
    urls.slice(0, 50).forEach((u, i) => tabs.create(u, { background: i > 0, afterActive: true }));
  }

  const popupAt = (template, rect) => Menu.buildFromTemplate(template).popup(rect
    ? { window: win, x: Math.round(rect.x), y: Math.round(rect.y + rect.height) } : { window: win });
  // rozbaľovacie menu priečinkov s ikonami, pravým tlačidlom a ťahaním
  const menu = new BookmarkMenu({ win, bookmarks, slim, open, openAll, popover });

  // ikony: nová ikona stránky v karte → záložky
  tabs.onFavicon = (info) => shared.onFavicon(info);
  function iconFromActive() {
    const a = tabs.active;
    const wc = a?.view && !a.view.webContents.isDestroyed() ? a.view.webContents : null;
    if (wc && a.favicon) shared.onFavicon({ url: wc.getURL(), startUrl: a.navStart, icon: a.favicon, wc });
  }

  // --------------------------------------------------------- hviezdička
  function star(anchor) {
    const a = tabs.active;
    const url = a?.view?.webContents.getURL() || a?.url;
    if (!url || tabs.isInternal(url)) return;
    let node = bookmarks.findByUrl(url);
    let mode = 'edit';
    if (!node) {
      node = bookmarks.add({ parentId: BAR, title: a.title || url, url });
      mode = 'added';
      iconFromActive();
    }
    popover.show(node.id, anchor, mode);
  }

  // --------------------------------------------------------- stav pre lištu
  function state() {
    const a = tabs.active;
    const url = a?.view && !a.view.webContents.isDestroyed() ? a.view.webContents.getURL() : a?.url;
    return {
      bmBar: bookmarks.bar().map(slim),
      bmOther: bookmarks.find(OTHER).node.children.length,
      bookmarked: !!(url && bookmarks.findByUrl(url)),
      canBookmark: !!url && !tabs.isInternal(url),
      showBar: settings.get('showBookmarkBar'),
    };
  }

  function toggleBar() {
    settings.set({ showBookmarkBar: !settings.get('showBookmarkBar') });
    pushState();
  }

  function newFolder(parentId = BAR, anchor) {
    const f = bookmarks.add({ parentId, type: 'folder', title: 'Nový priečinok' });
    popover.show(f.id, anchor, 'edit');
  }

  // --------------------------------------------------------- IPC z lišty
  on('bm:star', (rect) => star(rect));
  on('bm:open', (id, how) => {
    const n = bookmarks.find(id)?.node;
    if (n?.type === 'url') open(n.url, how);
  });
  on('bm:folder-menu', (id, rect) => {
    if (bookmarks.find(id)?.node?.type === 'folder') menu.toggle({ folderId: id }, rect);
  });
  on('bm:overflow-menu', (ids, rect) => menu.toggle({ ids: Array.isArray(ids) ? ids : [] }, rect));
  on('bm:move', (id, parentId, index) => bookmarks.move(id, parentId, index));
  // potiahnutý zámok (url = null → aktuálna stránka) alebo odkaz zo stránky pustený na lištu
  on('bm:add-drop', (url, title, parentId, index) => {
    let u = url, t = title;
    if (!u) {
      const a = tabs.active;
      u = a?.view && !a.view.webContents.isDestroyed() ? a.view.webContents.getURL() : a?.url;
      t = a?.title || '';
    }
    if (!u || !/^(https?|file):/i.test(u) || tabs.isInternal(u)) return;
    if (!t) { try { t = new URL(u).hostname.replace(/^www\./, ''); } catch { t = u; } }
    if (!bookmarks.find(parentId)) parentId = BAR;
    bookmarks.add({ parentId, title: t, url: u, index: typeof index === 'number' ? index : -1 });
    if (!url) iconFromActive();
  });
  on('bm:context', (id, rect) => {
    const n = id ? bookmarks.find(id)?.node : null;
    const common = [
      { type: 'separator' },
      { label: 'Pridať priečinok', click: () => newFolder(BAR, rect) },
      { label: 'Správca záložiek', accelerator: 'Ctrl+Shift+O', click: () => tabs.openInternal('bookmarks') },
      { label: 'Zobrazovať lištu záložiek', type: 'checkbox', checked: settings.get('showBookmarkBar'), accelerator: 'Ctrl+Shift+B', click: toggleBar },
    ];
    let t;
    if (!n) {
      const cur = state();
      t = [{ label: 'Pridať túto stránku', enabled: cur.canBookmark && !cur.bookmarked, click: () => win.webContents.send('bm:star-request') }, ...common];
    } else if (n.type === 'folder') {
      const count = (n.children || []).filter((c) => c.type === 'url').length;
      t = [
        { label: `Otvoriť všetky (${count})`, enabled: count > 0, click: () => openAll(n) },
        { type: 'separator' },
        { label: 'Premenovať…', click: () => popover.show(n.id, rect, 'edit') },
        { label: 'Odstrániť', click: () => bookmarks.remove(n.id) },
        ...common,
      ];
    } else {
      t = [
        { label: 'Otvoriť', click: () => open(n.url, 'current') },
        { label: 'Otvoriť v novej karte', click: () => open(n.url, 'new') },
        { label: 'Otvoriť v novom okne', click: () => newWindow?.(n.url, false) },
        { label: 'Otvoriť v okne inkognito', click: () => newWindow?.(n.url, true) },
        { type: 'separator' },
        { label: 'Upraviť…', click: () => popover.show(n.id, rect, 'edit') },
        { label: 'Odstrániť', click: () => bookmarks.remove(n.id) },
        ...common,
      ];
    }
    popupAt(t, null);
  });
  on('bm:other-menu', (rect) => menu.toggle({ folderId: OTHER }, rect));

  return { state, star, toggleBar, menu, open, openAll };
}

module.exports = { setupBookmarks, setupBookmarksShared };
