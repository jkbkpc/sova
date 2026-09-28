// Test: zapamätanie veľkosti/polohy okna. Spúšťa sa 2x: electron test/window-test.js <fáza> <priečinok>
const { app } = require('electron');
const path = require('path'), fs = require('fs');
const [phase, dir] = process.argv.slice(-2);
app.commandLine.appendSwitch('no-proxy-server');
app.setPath('userData', dir);
const ctx = require('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  while (!ctx.win || !ctx.win.isVisible()) await sleep(100);
  await sleep(800);
  const { win } = ctx;
  const b = win.getBounds();
  console.log('BOUNDS', phase, JSON.stringify(b), 'max', win.isMaximized());
  if (phase === '1') { win.setBounds({ x: 150, y: 90, width: 1000, height: 650 }); await sleep(900); }
  if (phase === '2') { win.maximize(); await sleep(900); }
  if (phase === '3') {
    const html = fs.readFileSync(path.join(__dirname, '../src/ui/bookmark-menu.html'), 'utf8');
    console.log('OPENALL', /Otvoriť všetky/.test(html) ? 'still there' : 'gone');
  }
  win.close();
});
