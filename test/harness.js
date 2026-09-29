// Automatický test: electron test/harness.js  (v xvfb)
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * 127.0.0.1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sova-test-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ freezeDelaySec: 1, restoreSession: true }));

const ctx = require('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const shot = (name) => new Promise((r) => require('child_process').exec(`import -window root ${path.join(__dirname, name)}`, r));
const check = (name, ok, extra = '') => { results.push(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); console.log(results.at(-1)); };
const js = (tab, code) => tab.view.webContents.executeJavaScript(code);
const waitLoad = (tab) => new Promise((r) => {
  const wc = tab.view.webContents;
  if (!wc.isLoading() && wc.getURL() && !wc.getURL().startsWith('about')) return setTimeout(r, 300);
  wc.once('did-finish-load', () => setTimeout(r, 500));
});

app.whenReady().then(async () => {
  while (!ctx.tabs || ctx.tabs.tabs.length === 0) await sleep(100);
  const { tabs, adblock, win } = ctx;
  while (!adblock.enabled) await sleep(100);
  check('adblock načítaný', true);

  // ---------------------------------------------------------- 1. blokovanie
  const A = tabs.active;
  tabs.navigate('http://news.test/counter.html?x=1');
  await waitLoad(A);
  const adLoaded = await js(A, 'window.__adLoaded || 0');
  check('reklamný skript zablokovaný', adLoaded === 0, `(__adLoaded=${adLoaded})`);
  const hidden1 = await js(A, 'getComputedStyle(document.getElementById("adtest")).display');
  const hidden2 = await js(A, 'getComputedStyle(document.getElementById("adtest2")).display');
  check('kozmetické filtre skryli reklamné boxy', hidden1 === 'none' && hidden2 === 'none', `(${hidden1}, ${hidden2})`);
  const cnt = adblock.countFor(A.view.webContents.id);
  check('počítadlo blokovaných', cnt >= 1, `(${cnt})`);

  // druhá navigácia pre históriu + vyplnený formulár
  tabs.navigate('http://news.test/counter.html?x=2');
  await waitLoad(A);
  await js(A, 'document.getElementById("f").focus(); document.execCommand("insertText", false, "ahoj Jakub"); window.scrollTo(0, 50);');
  await sleep(1500);

  // ---------------------------------------------------------- 2. zmrazenie
  const B = tabs.create(); // A ide do pozadia
  await sleep(600);
  check('A je na pozadí (hidden)', A.state === 'hidden', `(${A.state})`);
  await sleep(1500);
  check('A je zmrazená po 1 s', A.state === 'frozen', `(${A.state})`);
  await sleep(5000);
  await shot('shot-frozen.png');
  tabs.activate(A.id);
  await sleep(1500);
  const gap = await js(A, 'window.__maxGap');
  const vis = await js(A, 'JSON.stringify(window.__vis)');
  if (process.env.SOVA_DEBUG) console.log('ticks', await js(A, 'JSON.stringify(window.__tt.slice(-90))'));
  check('počas zmrazenia nebežal JavaScript', gap >= 5000, `(najdlhšia pauza časovača ${gap} ms)`);
  check('stránka dostala visibility hidden + freeze/resume', vis.includes('hidden') && vis.includes('freeze-event'), vis);

  // ---------------------------------------------------------- 3. uspanie
  tabs.activate(B.id);
  await sleep(300);
  const procsBefore = require('electron').app.getAppMetrics().length;
  tabs.discard(A, true);
  await sleep(1500);
  const procsAfter = require('electron').app.getAppMetrics().length;
  check('A uspaná, proces ukončený', A.state === 'sleeping' && !A.view && procsAfter < procsBefore, `(procesy ${procsBefore} → ${procsAfter})`);
  tabs.activate(A.id);
  await waitLoad(A);
  await sleep(800);
  const url = A.view.webContents.getURL();
  const canBack = A.view.webContents.navigationHistory.canGoBack();
  check('po zobudení správna adresa + história', url.endsWith('x=2') && canBack, `(${url}, späť=${canBack})`);
  const formVal = await js(A, 'document.getElementById("f").value');
  check('obnovený obsah formulára', formVal === 'ahoj Jakub', `("${formVal}")`);

  // ---------------------------------------------------------- 4. výnimka pre doménu
  ctx.settings.set({ allowlist: ['news.test'] });
  A.view.webContents.reload();
  await waitLoad(A);
  const adAllowed = await js(A, 'window.__adLoaded || 0');
  check('výnimka: na povolenej doméne sa reklama načíta', adAllowed > 0, `(__adLoaded=${adAllowed})`);
  ctx.settings.set({ allowlist: [] });

  // ---------------------------------------------------------- 5. popis UI a relácia
  const C = tabs.create('http://news.test/counter.html?x=3', { background: true });
  await sleep(3000);
  tabs.discard(B, true);
  await sleep(500);
  const snap = tabs.snapshot();
  console.log('stavy kariet:', snap.tabs.map((t) => `${t.title}=${t.state}`).join(', '), '| RAM', snap.totalMemMB, 'MB');
  await shot('shot-tabs.png');
  ctx.saveSession('test');
  const sess = JSON.parse(fs.readFileSync(path.join(tmp, 'session.json'), 'utf8'));
  check('relácia uložená', sess.windows[0].tabs.length === 3, `(${sess.windows[0].tabs.length} kariet)`);

  // nastavenia
  win.webContents.send('state', tabs.snapshot());
  await win.webContents.executeJavaScript('document.getElementById("settings").click()');
  await sleep(800);
  await shot('shot-settings.png');

  fs.writeFileSync(path.join(__dirname, 'results.txt'), results.join('\n'));
  app.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});
