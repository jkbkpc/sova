// Lišta: vyťaženie (CPU, RAM, sieť) s testom rýchlosti internetu a správca sťahovania.
const os = require('os');
const path = require('path');
const { app, ipcMain, webContents } = require('electron');
const { Bubble } = require('./bubble');
const { runSpeedTest } = require('./speedtest');

// ikony súborov (skutočné ikony Windows) – spoločné pre všetky okná
const iconCache = new Map();
async function iconFor(d) {
  const ext = path.extname(d.filename || '').toLowerCase() || '.';
  if (iconCache.has(ext)) return iconCache.get(ext);
  if (d.state !== 'completed' || !d.exists) return '';
  try {
    const img = await app.getFileIcon(d.path, { size: 'normal' });
    const url = img.isEmpty() ? '' : img.toDataURL();
    iconCache.set(ext, url);
    return url;
  } catch { return ''; }
}
async function listWithIcons(downloads, limit, q) {
  const list = downloads.view(limit, q);
  for (const d of list) d.icon = await iconFor(d);
  return list;
}
const actions = (downloads, session) => ({
  open: (id) => downloads.open(id), show: (id) => downloads.show(id), pause: (id) => downloads.pause(id),
  resume: (id) => downloads.resume(id), cancel: (id) => downloads.cancel(id), remove: (id) => downloads.remove(id),
  retry: (id) => { const d = downloads.get(id); if (d) { downloads.remove(id); session.downloadURL(d.url); } },
  folder: () => downloads.openFolder(),
});

// ------------------------------------------------------------ raz: API pre sova://downloads
function setupToolsShared({ downloads, session }) {
  const act = actions(downloads, session);
  const fromInternal = (e) => (e.senderFrame?.url || '').startsWith('sova://');
  const handle = (ch, fn) => ipcMain.handle('internal:' + ch, (e, ...a) => {
    if (!fromInternal(e)) throw new Error('Prístup zamietnutý');
    return fn(...a);
  });
  handle('downloads:list', (q) => listWithIcons(downloads, 500, String(q || '')));
  for (const [k, fn] of Object.entries(act)) handle('downloads:' + k, (id) => fn(id));
  handle('downloads:clear', () => downloads.clear());
  handle('downloads:trash', (id) => downloads.trash(id));
  handle('downloads:dir', () => downloads.dir());
  downloads.on('change', () => {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed() && wc.getURL().startsWith('sova://downloads')) wc.send('internal:downloads:changed');
    }
  });
}

// ------------------------------------------------------------ pre každé okno: bubliny v lište
function setupTools({ win, id, tabs, downloads, session, net, pushState, openInternal }) {
  const on = (ch, fn) => ipcMain.on(ch, (e, ...a) => { if (!win.isDestroyed() && e.sender === win.webContents) fn(...a); });

  // ------------------------------------------------------------ bublina sťahovaní
  const dlBubble = new Bubble({ win, name: `dlb${id}`, file: 'downloads-bubble.html', width: 380 });
  const refreshBubble = async () => { if (dlBubble.visible) dlBubble.send('list', await listWithIcons(downloads, 6)); };
  dlBubble.on('ready', refreshBubble);
  const act = actions(downloads, session);
  for (const [k, fn] of Object.entries(act)) dlBubble.on(k, (x) => fn(x));
  dlBubble.on('all', () => { dlBubble.hide(); openInternal('downloads'); });

  on('tools:downloads', async (rect) => {
    downloads.markSeen();
    dlBubble.toggle(rect);
    setTimeout(refreshBubble, 50);
  });

  // pri začatí sťahovania sa bublina ukáže sama (bez zobratia fokusu – klik do stránky ju zavrie)
  let lastRect = null;
  on('tools:downloads-rect', (rect) => { lastRect = rect; });
  // bublina sa ukáže len v okne, z ktorého sťahovanie prišlo (alebo v aktívnom okne)
  const onStarted = async (_d, wcId) => {
    if (win.isDestroyed()) return;
    const fromHere = wcId && tabs.tabs.some((t) => t.view && !t.view.webContents.isDestroyed() && t.view.webContents.id === wcId);
    const focused = require('electron').BrowserWindow.getFocusedWindow() === win;
    if (!(fromHere || (!wcId && focused))) return;
    if (lastRect && !dlBubble.visible) { await dlBubble.show(lastRect, { focus: false }); refreshBubble(); }
  };
  const onChange = () => { if (win.isDestroyed()) return; pushState(); refreshBubble(); };
  downloads.on('started', onStarted);
  downloads.on('change', onChange);
  win.on('closed', () => { downloads.off('started', onStarted); downloads.off('change', onChange); clearInterval(statsTimer); });

  // ------------------------------------------------------------ bublina vyťaženia + test rýchlosti
  const stBubble = new Bubble({ win, name: `stb${id}`, file: 'speed-bubble.html', width: 340 });
  let test = { running: false, cancelled: false, result: null, at: 0 };
  const sendStats = () => { if (stBubble.visible) stBubble.send('stats', statsState(), test); };
  stBubble.on('ready', sendStats);
  stBubble.on('start', async () => {
    if (test.running) return;
    test = { running: true, cancelled: false, result: null, at: 0, progress: { phase: 'ping' } };
    sendStats();
    try {
      const r = await runSpeedTest((p) => { test.progress = p; sendStats(); }, () => test.cancelled);
      test = { running: false, cancelled: false, result: r, at: Date.now() };
    } catch (e) {
      test = { running: false, cancelled: false, result: null, error: 'Test sa nepodaril: ' + (e.message || e), at: Date.now() };
    }
    sendStats();
  });
  stBubble.on('cancel', () => { test.cancelled = true; });
  on('tools:stats', (rect) => { stBubble.toggle(rect); setTimeout(sendStats, 50); });
  const statsTimer = setInterval(sendStats, 1000);

  // ------------------------------------------------------------ stav pre lištu
  function statsState() {
    return {
      cpu: tabs.totalCpu || 0,
      mem: Math.round(tabs.totalMem || 0),
      down: net.down, up: net.up,
      cores: os.cpus().length,
    };
  }
  function state() {
    return { stats: statsState(), dl: downloads.summary() };
  }

  return {
    state,
    bubbles: [dlBubble, stBubble],
    onFocusElsewhere: (wc) => { dlBubble.onFocusElsewhere(wc); stBubble.onFocusElsewhere(wc); },
    hide: () => { dlBubble.hide(); stBubble.hide(); },
  };
}

module.exports = { setupTools, setupToolsShared };
