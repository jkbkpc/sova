// Zapamätanie veľkosti a polohy okna (%APPDATA%\Sova\window.json)
const fs = require('fs');
const path = require('path');
const { screen } = require('electron');

const DEFAULT = { width: 1280, height: 820 };

// je okno aspoň čiastočne na niektorom monitore? (napr. po odpojení druhého monitora)
function onScreen(s) {
  const ok = s && [s.x, s.y, s.width, s.height].every(Number.isFinite) && s.width >= 480 && s.height >= 300;
  return ok && screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(s.x + s.width, a.x + a.width) - Math.max(s.x, a.x);
    const h = Math.min(s.y + s.height, a.y + a.height) - Math.max(s.y, a.y);
    return w >= 120 && h >= 60 && s.y >= a.y - 8;
  });
}

function loadWindowState(dir) {
  const file = path.join(dir, 'window.json');
  let s = null;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* prvé spustenie */ }
  const ok = s && [s.x, s.y, s.width, s.height].every(Number.isFinite) && s.width >= 480 && s.height >= 300;
  // okno musí byť aspoň čiastočne na niektorom monitore (napr. po odpojení druhého monitora)
  const visible = ok && screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(s.x + s.width, a.x + a.width) - Math.max(s.x, a.x);
    const h = Math.min(s.y + s.height, a.y + a.height) - Math.max(s.y, a.y);
    return w >= 120 && h >= 60 && s.y >= a.y - 8;    // aj titulok (karty) musí byť viditeľný
  });
  const bounds = visible ? { x: s.x, y: s.y, width: s.width, height: s.height } : { ...DEFAULT };
  return { bounds, maximized: !!(ok && s.maximized), file };
}

function trackWindowState(win, file) {
  let timer = null;
  const save = () => {
    if (win.isDestroyed()) return;
    const b = win.getNormalBounds();          // veľkosť pred maximalizovaním/minimalizovaním
    const data = { ...b, maximized: win.isMaximized() || (win.isFullScreen() && !!win._wasMaximized) };
    try { fs.writeFileSync(file, JSON.stringify(data)); } catch {}
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(save, 500); };
  win.on('enter-full-screen', () => { win._wasMaximized = win.isMaximized(); });
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, later);
  win.on('close', () => { clearTimeout(timer); save(); });
}

module.exports = { loadWindowState, trackWindowState, onScreen };
