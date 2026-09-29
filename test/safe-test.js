// Test: ochrana pred podvodnými a nebezpečnými stránkami (server.py na 80, zoznamy v test/site/sb)
process.env.SOVA_SB_LISTS = JSON.stringify([
  { id: 't-phish', name: 'Test phishing', kind: 'phishing', type: 'domains', urls: ['http://lists.test/sb/domains.txt'] },
  { id: 't-urls', name: 'Test URL', kind: 'phishing', type: 'urls', urls: ['http://lists.test/sb/urls.txt'] },
  { id: 't-mal', name: 'Test malvér', kind: 'malware', type: 'hosts', urls: ['http://lists.test/sb/nie-je.txt', 'http://lists.test/sb/hosts.txt'] },
]);
const { app } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * 127.0.0.1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sova-sb-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ restoreSession: false }));
const ctx = require('../src/main.js');
process.on('unhandledRejection', (e) => { console.log('FAIL výnimka', e); app.exit(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); };
const shot = (name) => new Promise((r) => require('child_process').exec(`import -window root ${path.join(__dirname, name)}`, r));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(150); } return false; };
const loaded = (wc) => new Promise((r) => { if (!wc.isLoading()) return setTimeout(r, 300); wc.once('did-stop-loading', () => setTimeout(r, 400)); });

app.whenReady().then(async () => {
  while (!ctx.windows?.size || ![...ctx.windows][0].tabsReady || !ctx.safe) await sleep(100);
  const { safe } = ctx;
  await until(() => safe.state().total >= 6, 10000);
  const st = safe.state();
  check('zoznamy stiahnuté (aj záložná adresa)', st.total === 6 && st.lists.every((l) => l.count > 0), JSON.stringify(st.lists.map((l) => [l.id, l.count, l.error])));
  const W = [...ctx.windows][0], tabs = W.tabs, ui = W.win.webContents;
  const ev = (c) => ui.executeJavaScript(c);
  const danger = () => tabs.active.danger;

  tabs.navigate('http://news.test/links.html');
  await sleep(300); await loaded(tabs.wc());
  // 1) priamo zadaná adresa
  tabs.navigate('http://evil.test/counter.html');
  await sleep(500);
  check('zadaná podvodná adresa: varovanie', danger()?.kind === 'phishing' && !(await ev("document.getElementById('danger').hidden")));
  check('stránka sa nenačítala, adresa v adresnom riadku', tabs.wc().getURL().endsWith('/links.html') && (await ev("document.getElementById('address').value")) === 'http://evil.test/counter.html');
  check('stránka karty je skrytá', !W.win.contentView.children.includes(tabs.active.view));
  await shot('shot-danger.png');
  await ev("document.getElementById('dgback').click()");
  await sleep(500);
  check('späť do bezpečia → pôvodná stránka', !danger() && W.win.contentView.children.includes(tabs.active.view) && tabs.wc().getURL().endsWith('/links.html'));
  // 2) odkaz na subdoménu zlej domény
  await tabs.wc().executeJavaScript("document.getElementById('l1').click()");
  await sleep(700);
  check('odkaz na a.bad.test zablokovaný (nadradená doména)', danger()?.host === 'a.bad.test' && tabs.wc().getURL().endsWith('/links.html'), tabs.wc().getURL());
  await ev("document.getElementById('dgback').click()"); await sleep(400);
  // 3) presmerovanie
  await tabs.wc().executeJavaScript("document.getElementById('l2').click()");
  await sleep(1000);
  check('presmerovanie na podvodnú stránku zablokované', danger()?.host === 'evil.test', JSON.stringify(danger()));
  await ev("document.getElementById('dgback').click()"); await sleep(400);
  // 4) konkrétna adresa zo zoznamu URL
  tabs.navigate('http://news.test/phish-page.html');
  await sleep(400);
  check('konkrétna podvodná adresa (zoznam URL)', danger()?.kind === 'phishing' && danger()?.list === 'Test URL');
  tabs.dangerBack(); await sleep(300);
  tabs.navigate('http://news.test/counter.html');
  await sleep(300); await loaded(tabs.wc());
  check('ostatné stránky na tej istej doméne fungujú', !danger() && tabs.wc().getURL().endsWith('/counter.html'));
  // 5) malvér
  tabs.navigate('http://malware.test/counter.html');
  await sleep(400);
  check('stránka s malvérom: varovanie', danger()?.kind === 'malware' && /škodlivým/.test(await ev("document.getElementById('dgtitle').textContent")));
  // 6) pokračovať aj tak
  await ev("document.getElementById('dgadv').click(); document.getElementById('dgproceed').click()");
  await sleep(500); await loaded(tabs.wc());
  check('pokračovať → stránka sa načíta', !danger() && tabs.wc().getURL() === 'http://malware.test/counter.html' && W.win.contentView.children.includes(tabs.active.view));
  // 7) chránené veľké domény sa celé neblokujú
  tabs.navigate('http://docs.google.com/counter.html');
  await sleep(400); await loaded(tabs.wc());
  check('docs.google.com v zozname domén sa neblokuje', !danger());
  // 8) nová karta so zlou adresou (window.open / odkaz do novej karty)
  const n = tabs.create('http://evil.test/x', { afterActive: true });
  await sleep(400);
  check('nová karta so zlou adresou: varovanie bez načítania', n.danger?.host === 'evil.test' && !n.view);
  tabs.dangerBack(n); await sleep(400);
  check('späť z novej karty → nová karta', !n.danger && tabs.isInternal(tabs.active.url || '') || tabs.active.url.startsWith('sova://newtab'));
  // 9) sťahovanie zo zlej stránky
  tabs.navigate('http://news.test/links.html');
  await sleep(300); await loaded(tabs.wc());
  const before = ctx.downloads.list.length;
  await tabs.wc().executeJavaScript("document.getElementById('l3').click()");
  await sleep(700);
  check('odkaz na súbor zo stránky s malvérom: varovanie', danger()?.kind === 'malware' && ctx.downloads.list.length === before);
  tabs.dangerBack(); await sleep(300);
  tabs.wc().downloadURL('http://dl-malware.test/big.bin?size=1000&rate=100000');   // napr. „Uložiť ako…“
  await until(() => ctx.downloads.list.length > before, 4000);
  const d = ctx.downloads.list[0];
  check('priame sťahovanie zo stránky s malvérom zablokované', d?.blocked === 'malware' && d.state === 'cancelled', JSON.stringify(d));
  // 10) vypnutá ochrana
  ctx.settings.set({ safeBrowsing: false });
  tabs.navigate('http://evil.test/counter.html');
  await sleep(400); await loaded(tabs.wc());
  check('vypnutá ochrana → stránka sa načíta', !danger() && tabs.wc().getURL() === 'http://evil.test/counter.html');
  ctx.settings.set({ safeBrowsing: true });
  // 11) aktualizácia bez zmeny (304) a stav v nastaveniach
  await safe.refresh(true);
  check('opakovaná aktualizácia bez chyby', safe.state().lists.every((l) => !l.error && l.count > 0));
  tabs.openInternal('settings');
  await sleep(1500);
  const txt = await tabs.wc().executeJavaScript("document.getElementById('sbstatus').textContent");
  check('nastavenia ukazujú stav zoznamov', /6 nebezpečných stránok/.test(txt), txt);
  const ver = await tabs.wc().executeJavaScript("document.getElementById('upver').textContent");
  check('nastavenia ukazujú verziu Chromia', /Chromium \d+/.test(ver), ver);
  console.log(fails ? `\n${fails} FAIL` : '\nVŠETKO OK');
  app.exit(fails ? 1 : 0);
});
