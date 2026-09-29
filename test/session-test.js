// Test: obnovenie relácie s viacerými oknami aj zo starého formátu (jedno okno)
const { app } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * 127.0.0.1');
const mode = process.argv.at(-1);          // „v2“ alebo „stary“
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sova-ses-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ restoreSession: true }));
const tab = (u, extra = {}) => ({ url: u, title: u, ...extra });
if (mode === 'v2') {
  fs.writeFileSync(path.join(tmp, 'session.json'), JSON.stringify({ version: 2, windows: [
    { bounds: { x: 50, y: 40, width: 900, height: 600 }, maximized: false, tabs: [tab('http://a.test/1'), tab('http://a.test/2')] },
    { bounds: { x: 300, y: 200, width: 1000, height: 700 }, maximized: false, tabs: [tab('http://b.test/1', { pinned: true }), tab('http://b.test/2')] },
  ] }));
} else {
  fs.writeFileSync(path.join(tmp, 'session.json'), JSON.stringify({ active: 0, tabs: [tab('http://c.test/1'), tab('http://c.test/2'), tab('http://c.test/3')] }));
}
const ctx = require('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); };
app.whenReady().then(async () => {
  while (!ctx.windows || [...ctx.windows].some((c) => !c.tabsReady) || !ctx.windows.size) await sleep(100);
  await sleep(800);
  const ws = [...ctx.windows];
  const urls = (c) => c.tabs.tabs.filter((t) => !c.tabs.isInternal(t.url)).map((t) => t.url);
  if (mode === 'v2') {
    check('obnovené 2 okná', ws.length === 2, ws.length);
    check('prvé okno: a.test', JSON.stringify(urls(ws[0])) === JSON.stringify(['http://a.test/1', 'http://a.test/2']), JSON.stringify(urls(ws[0])));
    check('druhé (aktívne) okno: b.test + nová karta', JSON.stringify(urls(ws[1])) === JSON.stringify(['http://b.test/1', 'http://b.test/2']) && ws[1].tabs.tabs.length === 3, JSON.stringify(urls(ws[1])));
    check('pripnutá karta ostala pripnutá', ws[1].tabs.tabs[0].pinned === true);
    const b = ws[0].win.getBounds();
    check('poloha prvého okna', b.x === 50 && b.y === 40 && b.width === 900, JSON.stringify(b));
  } else {
    check('starý formát: 1 okno', ws.length === 1);
    check('starý formát: 3 karty + nová', urls(ws[0]).length === 3 && ws[0].tabs.tabs.length === 4, JSON.stringify(urls(ws[0])));
  }
  console.log(fails ? `\n${fails} FAIL` : '\nVŠETKO OK');
  app.exit(fails ? 1 : 0);
});
