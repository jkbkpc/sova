// Test: presúvanie kariet ťahaním + upozornenie na neplatný certifikát v okne (server.py na 80, https.py na 443)
const { app } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * 127.0.0.1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sova-tc-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ restoreSession: false }));
const ctx = require('../src/main.js');
const { dialog } = require('electron');
let dialogs = 0;
dialog.showMessageBox = async () => { dialogs++; return { response: 0 }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); };
const shot = (name) => new Promise((r) => require('child_process').exec(`import -window root ${path.join(__dirname, name)}`, r));

app.whenReady().then(async () => {
  while (!ctx.bmui || !ctx.tabs.active) await sleep(100);
  await sleep(800);
  const { tabs, win } = ctx;
  const ui = win.webContents;
  const ev = (code) => ui.executeJavaScript(code);

  // ---------------------------------------------------- 1. certifikát
  tabs.navigate('http://news.test/counter.html');
  await sleep(1500);
  tabs.navigate('https://forti.test/counter.html');
  await sleep(2000);
  const a = tabs.active;
  check('žiadne okno Windows', dialogs === 0);
  check('upozornenie v okne', !(await ev("document.querySelector('#certerr').hidden")));
  check('stránka karty je skrytá', !win.contentView.children.includes(a.view));
  check('adresa ostáva v adresnom riadku', (await ev("document.querySelector('#address').value")) === 'https://forti.test/counter.html');
  check('text: host a kód', (await ev("document.querySelector('#cehost').textContent + ' ' + document.querySelector('#cecode').textContent")) === 'forti.test net::ERR_CERT_AUTHORITY_INVALID');
  await shot('shot-certerr.png');
  await ev("document.querySelector('#ceadv').click()");
  await sleep(300);
  await shot('shot-certerr-adv.png');
  // späť do bezpečia
  await ev("document.querySelector('#ceback').click()");
  await sleep(1500);
  check('späť do bezpečia → predchádzajúca stránka', a.view.webContents.getURL() === 'http://news.test/counter.html' && (await ev("document.querySelector('#certerr').hidden")), a.view.webContents.getURL());
  check('stránka karty opäť viditeľná', win.contentView.children.includes(a.view));
  // znova a pokračovať
  tabs.navigate('https://forti.test/counter.html');
  await sleep(1500);
  await ev("document.querySelector('#ceadv').click(); document.querySelector('#ceproceed').click()");
  await sleep(2000);
  check('pokračovať → stránka sa načíta', !(await a.view.webContents.executeJavaScript('document.body.innerText.length === 0')) && (await ev("document.querySelector('#certerr').hidden")) && win.contentView.children.includes(a.view));
  // prepnutie kariet počas upozornenia
  tabs.navigate('https://iny.test/counter.html');
  await sleep(1500);
  const b = tabs.create('http://news.test/counter.html?b=1');
  await sleep(1500);
  check('iná karta: upozornenie skryté', await ev("document.querySelector('#certerr').hidden"));
  tabs.activate(a.id);
  await sleep(500);
  check('späť na kartu: upozornenie znova', !(await ev("document.querySelector('#certerr').hidden")) && !win.contentView.children.includes(a.view));

  // ---------------------------------------------------- 2. ťahanie kariet
  tabs.create('http://news.test/counter.html?c=1');
  tabs.create('http://news.test/counter.html?d=1');
  await sleep(1500);
  const ids = () => tabs.tabs.map((t) => t.id);
  const before = ids();
  const rect = async (id) => JSON.parse(await ev(`(() => { const e = [...document.querySelectorAll('#tabs .tab')][${before.indexOf(id)}].getBoundingClientRect(); return JSON.stringify({x: e.left + e.width/2, y: e.top + e.height/2, w: e.width}); })()`));
  const dragTab = async (from, dx) => {
    ui.focus();
    const x = Math.round(from.x), y = Math.round(from.y);
    ui.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 12; i++) { ui.sendInputEvent({ type: 'mouseMove', x: Math.round(x + dx * i / 12), y, button: 'left', modifiers: ['leftButtonDown'] }); await sleep(30); }
    await sleep(100);
    ui.sendInputEvent({ type: 'mouseUp', x: Math.round(x + dx), y, button: 'left', clickCount: 1 });
    await sleep(500);
  };
  const r0 = await rect(before[0]);
  await dragTab(r0, r0.w * 2.2);   // prvú kartu o dve miesta doprava
  const after = ids();
  check('karta presunutá ťahaním', after[2] === before[0] && after[0] === before[1], `${before} → ${after}`);
  const domOrder = JSON.parse(await ev("JSON.stringify([...document.querySelectorAll('#tabs .tab .title')].map(e => e.textContent))"));
  check('poradie v lište sedí', domOrder.length === after.length);
  // pripnutá karta sa nedá dostať za nepripnuté
  tabs.togglePin(after[3]);
  await sleep(500);
  const p = tabs.tabs[0];
  check('pripnutá je prvá', p.pinned && p.id === after[3]);
  const before2 = ids();
  const rp = JSON.parse(await ev(`(() => { const e = document.querySelector('#tabs .tab.pinned').getBoundingClientRect(); return JSON.stringify({x: e.left + e.width/2, y: e.top + e.height/2, w: e.width}); })()`));
  await dragTab(rp, 400);
  check('pripnutá ostáva medzi pripnutými', tabs.tabs[0].id === p.id && ids().join() === before2.join());
  // nepripnutú nemožno dať pred pripnutú
  const lastR = JSON.parse(await ev(`(() => { const t = [...document.querySelectorAll('#tabs .tab')]; const e = t[t.length-1].getBoundingClientRect(); return JSON.stringify({x: e.left + e.width/2, y: e.top + e.height/2, w: e.width}); })()`));
  const lastId = tabs.tabs.at(-1).id;
  await dragTab(lastR, -2000);
  check('nepripnutá ide najviac hneď za pripnuté', tabs.tabs[0].id === p.id && tabs.tabs[1].id === lastId, ids().join());
  // posledná pozícia: prvú nepripnutú na úplný koniec
  const order = ids(), firstN = order[1];
  const fr = JSON.parse(await ev(`(() => { const e = [...document.querySelectorAll('#tabs .tab')][1].getBoundingClientRect(); return JSON.stringify({x: e.left + e.width/2, y: e.top + e.height/2, w: e.width}); })()`));
  await dragTab(fr, 2000);
  check('karta sa dá dať na posledné miesto', ids().at(-1) === firstN, `${order} → ${ids()}`);
  // ťahanie funguje aj keď fokus prejde na stránku karty (okno lišty dostane blur)
  const o2 = ids();
  const r3 = JSON.parse(await ev(`(() => { const e = [...document.querySelectorAll('#tabs .tab')][3].getBoundingClientRect(); return JSON.stringify({x: e.left + e.width/2, y: e.top + e.height/2, w: e.width}); })()`));
  {
    const x = Math.round(r3.x), y = Math.round(r3.y);
    ui.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(200);
    await ev("window.dispatchEvent(new Event('blur'))");
    for (let i = 1; i <= 12; i++) { ui.sendInputEvent({ type: 'mouseMove', x: Math.round(x - r3.w * 1.6 * i / 12), y, button: 'left', modifiers: ['leftButtonDown'] }); await sleep(30); }
    ui.sendInputEvent({ type: 'mouseUp', x: Math.round(x - r3.w * 1.6), y, button: 'left', clickCount: 1 });
    await sleep(500);
  }
  check('ťahanie po prepnutí fokusu na stránku', ids()[1] === o2[3], `${o2} → ${ids()}`);
  await shot('shot-tabs-drag.png');
  console.log(fails ? `\n${fails} FAIL` : '\nVŠETKO OK');
  app.exit(fails ? 1 : 0);
});
