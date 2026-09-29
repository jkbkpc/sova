// Test automatických aktualizácií proti lokálnemu „generic“ serveru (server.py na porte 80)
const { app } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * 127.0.0.1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sova-up-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ restoreSession: false }));

// falošné vydanie 99.0.0
const dir = path.join(__dirname, 'site', 'updates');
fs.mkdirSync(dir, { recursive: true });
const bin = crypto.randomBytes(300000);
fs.writeFileSync(path.join(dir, 'Sova-Setup-99.0.0.exe'), bin);
const sha = crypto.createHash('sha512').update(bin).digest('base64');
fs.writeFileSync(path.join(dir, 'latest.yml'), `version: 99.0.0\nfiles:\n  - url: Sova-Setup-99.0.0.exe\n    sha512: ${sha}\n    size: ${bin.length}\npath: Sova-Setup-99.0.0.exe\nsha512: ${sha}\nreleaseDate: '2026-09-29T00:00:00.000Z'\n`);
// na Linuxe (test) hľadá updater latest-linux.yml, na Windows latest.yml
fs.copyFileSync(path.join(dir, 'latest.yml'), path.join(dir, 'latest-linux.yml'));
process.env.SOVA_UPDATE_FEED = 'http://updates.test/updates/';

const ctx = require('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); };
const shot = (name) => new Promise((r) => require('child_process').exec(`import -window root ${path.join(__dirname, name)}`, r));

app.whenReady().then(async () => {
  while (!ctx.updater || !ctx.tabs?.active) await sleep(100);
  const { updater, win, tabs } = ctx;
  const ev = (c) => win.webContents.executeJavaScript(c);
  await sleep(500);
  check('stav na začiatku', ['idle', 'checking'].includes(updater.state().status), updater.state().status);
  check('tlačidlo v lište skryté', await ev("document.querySelector('#update').hidden"));
  // nastavenia
  tabs.openInternal('settings');
  await sleep(1500);
  const st = tabs.active.view.webContents;
  const upText = () => st.executeJavaScript("document.getElementById('upstatus').textContent + ' | ' + document.getElementById('upbtn').textContent");
  console.log('     nastavenia:', await upText());
  await st.executeJavaScript("document.getElementById('upbtn').click()");
  for (let i = 0; i < 60 && updater.state().status !== 'ready'; i++) await sleep(250);
  const s = updater.state();
  check('nová verzia stiahnutá', s.status === 'ready' && s.newVersion === '99.0.0', JSON.stringify(s));
  await sleep(400);
  check('zelené „Aktualizovať“ v lište', !(await ev("document.querySelector('#update').hidden")) && (await ev("document.querySelector('#update span').textContent")) === 'Aktualizovať');
  const t = await upText();
  check('nastavenia ukazujú pripravenú verziu', /99\.0\.0/.test(t) && /Reštartovať/.test(t), t);
  await shot('shot-update.png');
  // chyba: feed bez vydania
  const { Updater } = require('../src/updater');
  const u2 = new Updater({ settings: ctx.settings, testFeed: 'http://updates.test/nic/' });
  await u2.check();
  for (let i = 0; i < 20 && u2.state().status === 'checking'; i++) await sleep(200);
  check('bez vydania → zrozumiteľná chyba', u2.state().status === 'error', u2.state().error);
  console.log(fails ? `\n${fails} FAIL` : '\nVŠETKO OK');
  app.exit(fails ? 1 : 0);
});
