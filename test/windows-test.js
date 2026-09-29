// Test: viac okien (Ctrl+N), okno inkognito (Ctrl+Shift+N), uloženie relácie s viacerými oknami (server.py na 80)
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * 127.0.0.1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sova-win-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ restoreSession: true }));
const ctx = require('../src/main.js');
process.on('unhandledRejection', (e) => { console.log('FAIL výnimka', e); app.exit(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); };
const shot = (name) => new Promise((r) => require('child_process').exec(`import -window root ${path.join(__dirname, name)}`, r));
const loaded = (wc) => new Promise((r) => { if (!wc.isLoading()) return setTimeout(r, 300); wc.once('did-stop-loading', () => setTimeout(r, 400)); });
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(100); } return false; };
const key = async (wc, keyCode, modifiers = []) => { wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(400); };

app.whenReady().then(async () => {
  while (!ctx.windows || !ctx.windows.size || ![...ctx.windows][0].tabsReady) await sleep(100);
  await sleep(800);
  const W1 = [...ctx.windows][0];
  W1.tabs.navigate('http://news.test/counter.html?w=1');
  await sleep(300); await loaded(W1.tabs.wc());

  // ---------------------------------------------------- Ctrl+N = nové okno
  W1.tabs.wc().focus();
  await key(W1.tabs.wc(), 'N', ['control']);
  await until(() => ctx.windows.size === 2 && [...ctx.windows][1].tabsReady);
  check('Ctrl+N otvorí nové okno', ctx.windows.size === 2 && BrowserWindow.getAllWindows().length === 2);
  const W2 = [...ctx.windows][1];
  await until(() => W2.win.isVisible());
  check('nové okno má vlastnú prázdnu kartu', W2.tabs.tabs.length === 1 && W2.tabs.isBlank(W2.tabs.active) && W1.tabs.tabs.length === 1);
  const b1 = W1.win.getBounds(), b2 = W2.win.getBounds();
  check('nové okno je posunuté vedľa', b2.x === b1.x + 30 && b2.y === b1.y + 30, JSON.stringify([b1, b2]));
  W2.tabs.navigate('http://iny.test/counter.html?w=2');
  await sleep(300); await loaded(W2.tabs.wc());
  // lišta druhého okna ovláda druhé okno
  await W2.win.webContents.executeJavaScript("document.getElementById('newtab').click()");
  await sleep(500);
  check('„+“ v druhom okne pridá kartu do druhého okna', W2.tabs.tabs.length === 2 && W1.tabs.tabs.length === 1);
  // priblíženie + bublina v druhom okne
  W2.tabs.activate(W2.tabs.tabs[0].id);
  await sleep(300);
  W2.tabs.zoomStep(1);
  await sleep(600);
  check('bublina priblíženia v druhom okne', W2.zoomui.bubble.visible && !W1.zoomui.bubble.visible);
  W2.tabs.zoomStep(0);

  // ---------------------------------------------------- inkognito
  await key(W1.tabs.wc(), 'N', ['control', 'shift']);
  await until(() => ctx.windows.size === 3 && [...ctx.windows][2].tabsReady);
  const WI = [...ctx.windows][2];
  check('Ctrl+Shift+N otvorí okno inkognito', WI?.incognito === true);
  await until(() => WI.win.isVisible());
  await sleep(500);
  check('lišta inkognito (farby + označenie)', await WI.win.webContents.executeJavaScript("document.documentElement.classList.contains('incognito') && !document.getElementById('incog').hidden && !document.getElementById('ntpincog').hidden"));
  await shot('shot-incognito.png');
  WI.tabs.navigate('http://news.test/counter.html?tajne=1');
  await sleep(300); await loaded(WI.tabs.wc());
  await WI.tabs.wc().executeJavaScript("document.cookie = 'tajne=ano; path=/; max-age=3600'; localStorage.setItem('x', 'inkognito')");
  const histHit = ctx.history.query({ q: 'tajne' });
  const found = JSON.stringify(histHit).includes('tajne=1');
  check('inkognito sa nezapisuje do histórie', !found);
  const c1 = await W1.tabs.wc().executeJavaScript('document.cookie');
  check('bežné okno nevidí cookies z inkognita', !/tajne/.test(c1), JSON.stringify(c1));
  const ci = await WI.tabs.wc().executeJavaScript('document.cookie');
  check('inkognito má vlastné cookies', /tajne=ano/.test(ci));
  WI.tabs.zoomStep(1);
  await sleep(700);
  const zj = fs.existsSync(path.join(tmp, 'zoom.json')) ? fs.readFileSync(path.join(tmp, 'zoom.json'), 'utf8') : '{}';
  check('priblíženie v inkognite sa neukladá', !/news\.test/.test(zj), zj);
  // uloženie relácie – inkognito sa neukladá
  ctx.saveSession('test');
  const sess = JSON.parse(fs.readFileSync(path.join(tmp, 'session.json'), 'utf8'));
  const allUrls = JSON.stringify(sess);
  check('relácia: 2 bežné okná, bez inkognita', sess.windows.length === 2 && !/tajne/.test(allUrls), `${sess.windows.length} okná`);
  // zatvorenie inkognita vymaže jeho údaje
  const incSess = WI.session;
  const incWcs = WI.tabs.tabs.map((t) => t.view?.webContents).filter(Boolean);
  WI.win.close();
  await until(() => ctx.windows.size === 2);
  await sleep(800);
  const cookies = await Promise.race([incSess.cookies.get({}), sleep(3000).then(() => ['TIMEOUT'])]);
  check('po zatvorení inkognita sú cookies vymazané', cookies.length === 0, cookies.length);
  check('stránky zatvoreného okna sú ukončené', incWcs.every((w) => w.isDestroyed()));
  // nové inkognito je čisté
  await key(W1.tabs.wc(), 'N', ['control', 'shift']);
  await until(() => [...ctx.windows].some((c) => c.incognito && c.tabsReady));
  const WI2 = [...ctx.windows].find((c) => c.incognito);
  WI2.tabs.navigate('http://news.test/counter.html?tajne=2');
  await sleep(300); await loaded(WI2.tabs.wc());
  const ls = await Promise.race([WI2.tabs.wc().executeJavaScript("localStorage.getItem('x') + '|' + document.cookie"), sleep(4000).then(() => 'TIMEOUT')]);
  check('nové okno inkognito začína načisto', ls === 'null|', ls);
  WI2.win.close();
  await until(() => ctx.windows.size === 2);

  // zatvorenie druhého bežného okna – prvé ostáva
  W2.win.close();
  await until(() => ctx.windows.size === 1);
  check('po zatvorení okna aplikácia beží ďalej', ctx.windows.size === 1 && !W1.win.isDestroyed());
  console.log(fails ? `\n${fails} FAIL` : '\nVŠETKO OK');
  app.exit(fails ? 1 : 0);
});
