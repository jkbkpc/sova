// Test: prihlasovacia stránka Google vidí Firefox, ostatné stránky Chrome (server.py na 80; login.test = náhrada za accounts.google.com)
process.env.SOVA_UA_HOSTS = 'login.test';
const { app } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * 127.0.0.1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sova-gl-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ restoreSession: false }));
const ctx = require('../src/main.js');
process.on('unhandledRejection', (e) => { console.log('FAIL výnimka', e); app.exit(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); };
const loaded = (wc) => new Promise((r) => { if (!wc.isLoading()) return setTimeout(r, 300); wc.once('did-stop-loading', () => setTimeout(r, 400)); });
app.whenReady().then(async () => {
  while (!ctx.windows?.size || ![...ctx.windows][0].tabsReady) await sleep(100);
  await sleep(500);
  const W = [...ctx.windows][0];
  const probe = async (tabs) => {
    const wc = tabs.wc();
    await sleep(300); await loaded(wc);
    return JSON.parse(await wc.executeJavaScript(`JSON.stringify({ hdr: JSON.parse(document.getElementById('h').textContent),
      ua: navigator.userAgent, uad: typeof navigator.userAgentData, vendor: navigator.vendor })`));
  };
  W.tabs.navigate('http://login.test/__ua');
  const a = await probe(W.tabs);
  check('prihlasovacia stránka: hlavička User-Agent = Firefox', /Firefox\/\d+/.test(a.hdr['user-agent']) && !/Chrome/.test(a.hdr['user-agent']), a.hdr['user-agent']);
  check('prihlasovacia stránka: bez hlavičiek Sec-CH-UA', !Object.keys(a.hdr).some((k) => k.startsWith('sec-ch-ua')), Object.keys(a.hdr).filter((k) => k.startsWith('sec-ch')).join(','));
  check('prihlasovacia stránka: navigator.userAgent = Firefox', /Firefox\//.test(a.ua) && !/Chrome/.test(a.ua), a.ua);
  check('prihlasovacia stránka: bez userAgentData, vendor prázdny', a.uad === 'undefined' && a.vendor === '', `${a.uad} / ${JSON.stringify(a.vendor)}`);
  W.tabs.navigate('http://news.test/__ua');
  const b = await probe(W.tabs);
  // (Sec-CH-UA a navigator.userAgentData posiela Chromium len cez https – testovací server je http)
  check('iná stránka: Chrome (hlavička aj skripty)', /Chrome\//.test(b.hdr['user-agent']) && /Chrome\//.test(b.ua) && !/Electron|Firefox/.test(b.ua + b.hdr['user-agent']), b.ua);
  const WI = ctx.openWindow({ incognito: true });
  while (!WI.tabsReady) await sleep(100);
  WI.tabs.navigate('http://login.test/__ua');
  const c = await probe(WI.tabs);
  check('inkognito: prihlasovacia stránka = Firefox', /Firefox\//.test(c.hdr['user-agent']) && /Firefox\//.test(c.ua));
  console.log(fails ? `\n${fails} FAIL` : '\nVŠETKO OK');
  app.exit(fails ? 1 : 0);
});
