// Test ikon záložiek: electron test/favicons-test.js (v xvfb, s test/site/server.py na porte 80)
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * 127.0.0.1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sova-fav-test-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ restoreSession: false }));

const ctx = require('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); };
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(200); } return false; };
const color = (dataUrl) => {
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromDataURL(dataUrl);
  const b = img.toBitmap(); // BGRA
  return { w: img.getSize().width, r: b[2], g: b[1], bl: b[0] };
};

app.whenReady().then(async () => {
  while (!ctx.tabs || !ctx.bmui) await sleep(100);
  const { tabs, bookmarks } = ctx;

  // falošný profil Chrome: Bookmarks + Favicons (SQLite)
  const prof = path.join(tmp, 'Chrome', 'Default');
  fs.mkdirSync(prof, { recursive: true });
  const mk = (url, name) => ({ type: 'url', url, name });
  fs.writeFileSync(path.join(prof, 'Bookmarks'), JSON.stringify({ roots: {
    bookmark_bar: { children: [mk('http://chromeicon.test/a', 'A z Chrome'), mk('http://fav.test/fav/page.html', 'B bez ikony')] },
    other: { children: [mk('http://chromeicon.test/iny', 'C rovnaká doména')] },
  } }));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(prof, 'Favicons'));
  db.exec(`CREATE TABLE favicons(id INTEGER PRIMARY KEY, url TEXT, icon_type INTEGER);
    CREATE TABLE icon_mapping(id INTEGER PRIMARY KEY, page_url TEXT, icon_id INTEGER);
    CREATE TABLE favicon_bitmaps(id INTEGER PRIMARY KEY, icon_id INTEGER, last_updated INTEGER, image_data BLOB, width INTEGER, height INTEGER);`);
  db.prepare('INSERT INTO favicons VALUES (1, ?, 1)').run('http://chromeicon.test/favicon.ico');
  db.prepare('INSERT INTO icon_mapping VALUES (1, ?, 1)').run('http://chromeicon.test/a');
  db.prepare('INSERT INTO favicon_bitmaps VALUES (1, 1, 0, ?, 16, 16)').run(fs.readFileSync(path.join(__dirname, 'site/fav/green.png')));
  db.close();

  const n = bookmarks.importChromium(path.join(prof, 'Bookmarks'), 'Google Chrome');
  check('import 3 záložiek', n === 3, `(${n})`);
  const byTitle = (t) => { let hit; bookmarks.walk((x) => { if (x.title === t) hit = x; }); return hit; };
  const A = byTitle('A z Chrome'), B = byTitle('B bez ikony'), C = byTitle('C rovnaká doména');
  check('ikona z databázy Chrome hneď po importe', !!A.icon && color(A.icon).g > 150, A.icon ? JSON.stringify(color(A.icon)) : '');
  check('rovnaká doména dostala ikonu tiež', !!C.icon);

  // doplnenie na pozadí podľa <link rel="icon">
  await until(() => B.icon);
  check('ikona doplnená na pozadí z <link rel=icon>', !!B.icon && color(B.icon).r > 150, B.icon ? JSON.stringify(color(B.icon)) : '');
  check('veľká ikona zmenšená na 32 px', B.icon && color(B.icon).w === 32);

  // návšteva stránky cez presmerovanie → ikona sa uloží k záložke
  const V = bookmarks.add({ title: 'Presmerovaná', url: 'http://visit.test/__redir?to=http://visit2.test/fav/visited.html' });
  bookmarks.markIconTried(V);       // nech to nespraví doplňovanie na pozadí
  tabs.navigate(V.url);
  await until(() => V.icon);
  check('ikona po návšteve (aj po presmerovaní)', !!V.icon && color(V.icon).bl > 150, V.icon ? JSON.stringify(color(V.icon)) : '');
  const bar = ctx.bmui.state().bmBar;
  check('lišta posiela data: ikonu', bar.some((b) => b.favicon.startsWith('data:image/')));

  // export/import HTML zachová ikony
  const html = bookmarks.exportHtml();
  check('export HTML obsahuje ICON', /ICON="data:image\//.test(html));
  await sleep(1200);
  console.log(fails ? `\n${fails} FAIL` : '\nVŠETKO OK');
  app.exit(fails ? 1 : 0);
});
