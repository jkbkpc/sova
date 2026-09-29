// Bublina priblíženia (ako v Chrome): po Ctrl +/−/koliesku sa na chvíľu ukáže pri lupe v adresnom riadku.
const { ipcMain } = require('electron');
const { Bubble } = require('./bubble');

function setupZoom({ win, id, tabs }) {
  const bubble = new Bubble({ win, name: `zb${id}`, file: 'zoom-bubble.html', width: 300, align: 'right' });
  let timer = null, hovered = false, auto = false;
  const pct = () => {
    const wc = tabs.wc();
    return wc && !wc.isDestroyed() ? Math.round(wc.getZoomFactor() * 100) : 100;
  };
  const autoHide = () => {
    clearTimeout(timer);
    if (auto && !hovered) timer = setTimeout(() => bubble.hide(), 2200);
  };
  ipcMain.on('zoom:bubble', async (e, rect, isAuto) => {
    if (e.sender !== win.webContents) return;
    if (!isAuto && bubble.visible && !auto) { bubble.hide(); return; }
    auto = !!isAuto;
    await bubble.show(rect, { focus: !auto });
    bubble.send('data', pct());
    autoHide();
  });
  bubble.on('ready', () => bubble.send('data', pct()));
  bubble.on('hover', (h) => { hovered = !!h; autoHide(); });
  bubble.on('step', (d) => { tabs.zoomStep(d > 0 ? 1 : -1); bubble.send('data', pct()); });
  bubble.on('reset', () => { tabs.zoomStep(0); bubble.send('data', pct()); });
  return { bubble, hide: () => bubble.hide() };
}

module.exports = { setupZoom };
