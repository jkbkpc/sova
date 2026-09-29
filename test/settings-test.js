// Test: nová stránka nastavení (bočné menu, hľadanie, prepínače)
const { app } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * 127.0.0.1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sova-set-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ restoreSession: false }));
const ctx = require('../src/main.js');
process.on('unhandledRejection', (e) => { console.log('FAIL výnimka', e); app.exit(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); };
const shot = (name) => new Promise((r) => require('child_process').exec(`import -window root ${path.join(__dirname, name)}`, r));
app.whenReady().then(async () => {
  while (!ctx.windows?.size || ![...ctx.windows][0].tabsReady) await sleep(100);
  const W = [...ctx.windows][0];
  W.tabs.openInternal('settings');
  await sleep(2000);
  const wc = W.tabs.wc();
  const js = (c) => wc.executeJavaScript(c);
  await shot('shot-settings-new.png');
  check('8 oddielov a menu', (await js("document.querySelectorAll('.sec').length")) === 8 && (await js("document.querySelectorAll('#nav a').length")) === 8);
  check('všetky nastavenia načítané', (await js("[...document.querySelectorAll('select[data-key]')].every(e => e.value !== '')")));
  check('prvý oddiel vyznačený v menu', (await js("document.querySelector('#nav a.on')?.dataset.sec")) === 'vseobecne');
  // klik na menu
  await js("document.querySelector('#nav a[data-sec=vykon]').click()");
  await sleep(900);
  check('klik v menu → oddiel Šetrenie výkonu', (await js("document.querySelector('#nav a.on')?.dataset.sec")) === 'vykon', await js("document.querySelector('#nav a.on')?.dataset.sec"));
  // prepínač uloží nastavenie
  await js("document.querySelector('[data-key=keepAudibleAwake]').click()");
  await sleep(400);
  check('prepínač uloží nastavenie', ctx.settings.get('keepAudibleAwake') === false);
  // hľadanie bez diakritiky
  await js("{ const q = document.getElementById('q'); q.value = 'uspat'; q.dispatchEvent(new Event('input')) }");
  await sleep(300);
  const vis = await js("[...document.querySelectorAll('.sec')].filter(s => !s.hidden).map(s => s.id).join(',')");
  check('hľadanie „uspat“ nájde Šetrenie výkonu', vis.includes('vykon') && !vis.includes('stahovanie'), vis);
  const rows = await js("[...document.querySelectorAll('#vykon .row, #vykon .col')].filter(r => !r.hidden).length");
  check('v oddiele ostanú len zodpovedajúce riadky', rows >= 1 && rows < 4, rows);
  await shot('shot-settings-search.png');
  await js("{ const q = document.getElementById('q'); q.value = 'xyzxyz'; q.dispatchEvent(new Event('input')) }");
  await sleep(200);
  check('nič sa nenašlo', !(await js("document.getElementById('nothing').hidden")));
  await js("{ const q = document.getElementById('q'); q.value = 'ctrl+d'; q.dispatchEvent(new Event('input')) }");
  await sleep(200);
  check('hľadanie v skratkách', (await js("[...document.querySelectorAll('.krow')].filter(r => !r.hidden).length")) >= 1);
  await js("{ const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input')) }");
  // okno inkognito z nastavení
  await js("document.getElementById('incog').click()");
  await sleep(1500);
  check('tlačidlo otvorí okno inkognito', [...ctx.windows].some((c) => c.incognito));
  // odkaz na oddiel (#zabezpecenie)
  W.tabs.navigate('sova://settings/#zabezpecenie');
  await sleep(1500);
  check('odkaz sova://settings/#zabezpecenie', (await W.tabs.wc().executeJavaScript("document.querySelector('#nav a.on')?.dataset.sec")) === 'zabezpecenie');
  // úzke okno
  W.win.setSize(760, 700);
  await sleep(800);
  await shot('shot-settings-narrow.png');
  console.log(fails ? `\n${fails} FAIL` : '\nVŠETKO OK');
  app.exit(fails ? 1 : 0);
});
