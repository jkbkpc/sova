// Prepojenie záložiek s oknom: hviezdička, lišta záložiek (menu priečinkov, kontextové menu),
// a API pre správcu záložiek sova://bookmarks.
const fs = require('fs');
const { ipcMain, Menu, dialog, webContents } = require('electron');
const { BAR, OTHER, findBrowserProfiles } = require('./bookmarks');
const { BookmarkMenu } = require('./bmmenu');

function setupBookmarks({ win, tabs, bookmarks, history, settings, popover, pushState }) {
  const menuLabel = (s, max = 60) => {
    const t = String(s || '').replace(/&/g, '&&');
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  };
  const favicon = (url) => {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return '';
      return history.domains[u.host.toLowerCase().replace(/^www\./, '')]?.favicon || `${u.origin}/favicon.ico`;
    } catch { return ''; }
  };
  const slim = (n) => ({ id: n.id, type: n.type, title: n.title, url: n.url || '', favicon: n.type === 'url' ? favicon(n.url) : '' });

  // --------------------------------------------------------- otváranie
  // how: 'current' | 'new' (nová karta v popredí) | 'background'
  function open(url, how = 'current') {
    if (!url) return;
    if (how === 'current' && tabs.active) tabs.navigate(url);
    else tabs.create(url, { background: how === 'background', afterActive: true });
  }
  const howFromEvent = (ev) => (ev && (ev.ctrlKey || ev.metaKey) ? 'background' : ev && ev.shiftKey ? 'new' : 'current');
  function openAll(folder) {
    const urls = [];
    bookmarks.walk((n) => { if (n.type === 'url') urls.push(n.url); }, folder);
    urls.slice(0, 50).forEach((u, i) => tabs.create(u, { background: i > 0, afterActive: true }));
  }

  // --------------------------------------------------------- menu priečinka
  function folderMenu(folder) {
    const items = (folder.children || []).map((c) => (c.type === 'folder'
      ? { label: menuLabel(c.title), submenu: folderMenu(c) }
      : { label: menuLabel(c.title || c.url), click: (_m, _w, ev) => open(c.url, howFromEvent(ev)) }));
    if (!items.length) items.push({ label: '(prázdny priečinok)', enabled: false });
    const n = (folder.children || []).filter((c) => c.type === 'url').length;
    if (n > 1) items.push({ type: 'separator' }, { label: `Otvoriť všetky (${n}) v nových kartách`, click: () => openAll(folder) });
    return items;
  }
  const popupAt = (template, rect) => Menu.buildFromTemplate(template).popup(rect
    ? { window: win, x: Math.round(rect.x), y: Math.round(rect.y + rect.height) } : { window: win });
  // rozbaľovacie menu priečinkov s ikonami, pravým tlačidlom a ťahaním
  const menu = new BookmarkMenu({ win, bookmarks, slim, open, openAll, popover });

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
  ipcMain.on('bm:star', (_e, rect) => star(rect));
  ipcMain.on('bm:open', (_e, id, how) => {
    const n = bookmarks.find(id)?.node;
    if (n?.type === 'url') open(n.url, how);
  });
  ipcMain.on('bm:folder-menu', (_e, id, rect) => {
    if (bookmarks.find(id)?.node?.type === 'folder') menu.toggle({ folderId: id }, rect);
  });
  ipcMain.on('bm:overflow-menu', (_e, ids, rect) => menu.toggle({ ids: Array.isArray(ids) ? ids : [] }, rect));
  ipcMain.on('bm:move', (_e, id, parentId, index) => bookmarks.move(id, parentId, index));
  // potiahnutý zámok (url = null → aktuálna stránka) alebo odkaz zo stránky pustený na lištu
  ipcMain.on('bm:add-drop', (_e, url, title, parentId, index) => {
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
  });
  ipcMain.on('bm:context', (_e, id, rect) => {
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
        { type: 'separator' },
        { label: 'Upraviť…', click: () => popover.show(n.id, rect, 'edit') },
        { label: 'Odstrániť', click: () => bookmarks.remove(n.id) },
        ...common,
      ];
    }
    popupAt(t, null);
  });
  ipcMain.on('bm:other-menu', (_e, rect) => menu.toggle({ folderId: OTHER }, rect));

  // --------------------------------------------------------- API pre sova://bookmarks
  const fromInternal = (e) => (e.senderFrame?.url || '').startsWith('sova://');
  const handle = (ch, fn) => ipcMain.handle('internal:' + ch, (e, ...a) => {
    if (!fromInternal(e)) throw new Error('Prístup zamietnutý');
    return fn(...a);
  });
  const withIcons = (n) => (n.type === 'folder' ? { ...n, children: n.children.map(withIcons) } : { ...n, favicon: favicon(n.url) });
  handle('bookmarks:tree', () => withIcons(bookmarks.tree()));
  handle('bookmarks:search', (q) => bookmarks.search(String(q || '')).map(withIcons));
  handle('bookmarks:add', (o) => bookmarks.add(o || {}));
  handle('bookmarks:update', (id, o) => bookmarks.update(id, o || {}));
  handle('bookmarks:move', (id, parentId, index) => bookmarks.move(id, parentId, index));
  handle('bookmarks:remove', (id) => bookmarks.remove(id));
  handle('bookmarks:restore', (info) => bookmarks.restore(info));
  handle('bookmarks:open', (id, how) => {
    const n = bookmarks.find(id)?.node;
    if (n?.type === 'url') open(n.url, how || 'new');
    else if (n?.type === 'folder') openAll(n);
  });
  handle('bookmarks:sources', () => findBrowserProfiles().map(({ id, browser, profile }) => ({ id, browser, profile })));
  handle('bookmarks:import', (id) => {
    const src = findBrowserProfiles().find((p) => p.id === id);
    if (!src) throw new Error('Zdroj sa nenašiel');
    return bookmarks.importChromium(src.file, src.browser);
  });
  handle('bookmarks:import-html', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Importovať záložky zo súboru HTML', properties: ['openFile'],
      filters: [{ name: 'Záložky (HTML)', extensions: ['html', 'htm'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return bookmarks.importHtml(r.filePaths[0]);
  });
  handle('bookmarks:export-html', async () => {
    const d = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win, {
      title: 'Exportovať záložky', defaultPath: `sova-zalozky-${d}.html`,
      filters: [{ name: 'Záložky (HTML)', extensions: ['html'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, bookmarks.exportHtml());
    return r.filePath;
  });

  // zmeny → lišta + otvorené stránky správcu záložiek
  bookmarks.on('change', () => {
    pushState();
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed() && wc.getURL().startsWith('sova://bookmarks')) wc.send('internal:bookmarks:changed');
    }
  });

  return { state, star, toggleBar, menu };
}

module.exports = { setupBookmarks };
