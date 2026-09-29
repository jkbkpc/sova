// Test: priblíženie (pamätané pre doménu, bublina), PDF v karte, nové klávesové skratky (server.py na 80)
const { app } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * 127.0.0.1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sova-zp-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ restoreSession: false }));
const ctx = require('../src/main.js');
process.on('unhandledRejection', (e) => { console.log('FAIL výnimka', e); app.exit(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); };
const shot = (name) => new Promise((r) => require('child_process').exec(`import -window root ${path.join(__dirname, name)}`, r));
const loaded = (wc) => new Promise((r) => { if (!wc.isLoading()) return setTimeout(r, 300); wc.once('did-stop-loading', () => setTimeout(r, 400)); });

app.whenReady().then(async () => {
  while (!ctx.tabs?.active || !ctx.bmui) await sleep(100);
  await sleep(800);
  const { tabs, win } = ctx;
  const ui = win.webContents;
  const ev = (c) => ui.executeJavaScript(c);
  const key = async (wc, keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(500);
  };

  // ---------------------------------------------------- priblíženie
  tabs.navigate('http://news.test/counter.html');
  await sleep(300); await loaded(tabs.active.view.webContents);
  const A = tabs.active, wa = A.view.webContents;
  wa.focus();
  await key(wa, '=', ['control']);
  check('Ctrl + priblíži na 110 %', Math.abs(wa.getZoomFactor() - 1.1) < 0.01, wa.getZoomFactor());
  await sleep(300);
  check('lupa v adresnom riadku ukazuje 110 %', !(await ev("document.querySelector('#zoom').hidden")) && (await ev("document.querySelector('#zoom span').textContent")) === '110 %');
  check('bublina priblíženia sa ukázala', ctx.zoomui?.bubble.visible === true);
  await shot('shot-zoom.png');
  await sleep(2800);
  check('bublina sa sama skryla', ctx.zoomui.bubble.visible === false);
  tabs.zoomStep(1);
  check('druhý krok 125 %', Math.abs(wa.getZoomFactor() - 1.25) < 0.01);
  await sleep(700);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'zoom.json'), 'utf8'));
  check('uložené pre doménu', saved['news.test'] === 1.25, JSON.stringify(saved));
  // tá istá doména v novej karte → 125 %, iná doména → 100 %
  const B = tabs.create('http://news.test/counter.html?b=1');
  await sleep(300); await loaded(B.view.webContents);
  check('rovnaká doména v novej karte 125 %', Math.abs(B.view.webContents.getZoomFactor() - 1.25) < 0.01, B.view.webContents.getZoomFactor());
  tabs.navigate('http://iny.test/counter.html');
  await sleep(300); await loaded(B.view.webContents);
  check('iná doména 100 %', Math.abs(B.view.webContents.getZoomFactor() - 1) < 0.01, B.view.webContents.getZoomFactor());
  // koliesko myši s Ctrl
  B.view.webContents.emit('zoom-changed', {}, 'in');
  await sleep(200);
  check('Ctrl + koliesko priblíži', Math.abs(B.view.webContents.getZoomFactor() - 1.1) < 0.01);
  await key(B.view.webContents, '0', ['control']);
  check('Ctrl+0 vráti 100 %', Math.abs(B.view.webContents.getZoomFactor() - 1) < 0.01);
  await sleep(300);
  check('pri 100 % lupa zmizne', await ev("document.querySelector('#zoom').hidden"));

  // ---------------------------------------------------- PDF
  let downloads = 0;
  ctx.browsing.on('will-download', () => downloads++);
  tabs.navigate('http://news.test/doc.pdf');
  await sleep(3000);
  const wb = B.view.webContents;
  check('PDF sa otvorí v karte (nestiahne sa)', downloads === 0 && wb.getURL().endsWith('/doc.pdf'), `downloads=${downloads} url=${wb.getURL()}`);
  const hasViewer = (await Promise.race([wb.executeJavaScript('document.contentType'), sleep(3000).then(() => '')]).catch(() => '')) === 'application/pdf';
  check('prehliadač PDF je načítaný', hasViewer);
  await shot('shot-pdf.png');

  // ---------------------------------------------------- skratky
  tabs.activate(A.id);
  await sleep(500);
  const order0 = tabs.tabs.map((t) => t.id);
  await key(A.view.webContents, 'PageDown', ['control', 'shift']);
  const order1 = tabs.tabs.map((t) => t.id);
  check('Ctrl+Shift+PgDn posunie kartu doprava', order1.indexOf(A.id) === order0.indexOf(A.id) + 1, `${order0} → ${order1}`);
  const n0 = tabs.tabs.length;
  await key(A.view.webContents, 'U', ['control']);
  await sleep(800);
  check('Ctrl+U otvorí zdrojový kód', tabs.tabs.length === n0 + 1 && /^view-source:/.test(tabs.active.url), tabs.active.url);
  const vwc = tabs.active.view.webContents;
  check('zdrojový kód sa zobrazí', !vwc.isCrashed() && vwc.getURL().startsWith('view-source:') && !vwc.isLoading(), vwc.getURL());
  tabs.activate(A.id); await sleep(400);
  await key(A.view.webContents, 'F3');
  check('F3 otvorí hľadanie', !(await ev("document.querySelector('#findbar').hidden")));


  console.log(fails ? `\n${fails} FAIL` : '\nVŠETKO OK');
  app.exit(fails ? 1 : 0);
});
