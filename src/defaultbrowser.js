// Sova ako predvolený prehliadač (Windows).
// Windows nedovolí aplikácii nastaviť sa za predvolenú sama – Sova sa zaregistruje ako prehliadač
// (HKCU, bez práv správcu) a otvorí Nastavenia Windows, kde stačí kliknúť na „Nastaviť ako predvolené“.
const { app, shell } = require('electron');
const { execFile } = require('child_process');

const NAME = 'Sova';
const PROGID = 'SovaHTML';
const CLIENT = `HKCU\\Software\\Clients\\StartMenuInternet\\${NAME}`;
const CLASSES = `HKCU\\Software\\Classes\\${PROGID}`;
const URL_TYPES = ['http', 'https'];
const FILE_TYPES = ['.htm', '.html', '.shtml', '.xht', '.xhtml', '.pdf'];

const reg = (args) => new Promise((resolve) => {
  execFile('reg.exe', args, { windowsHide: true, timeout: 10000 }, (err, stdout) => resolve(err ? null : String(stdout)));
});
const add = (key, name, value) => reg(['add', key, ...(name === null ? ['/ve'] : ['/v', name]), '/t', 'REG_SZ', '/d', value, '/f']);

// cesta k .exe (prenosná verzia sa spúšťa z dočasného priečinka – potrebujeme pôvodný súbor)
const exePath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
const supported = () => process.platform === 'win32' && app.isPackaged;

async function register() {
  const exe = exePath();
  const icon = `"${exe}",0`;
  const open = `"${exe}" "%1"`;
  // typ dokumentu, ktorým Sova otvára odkazy a súbory
  await add(CLASSES, null, 'Sova HTML dokument');
  await add(CLASSES, 'FriendlyTypeName', 'Sova HTML dokument');
  await add(`${CLASSES}\\DefaultIcon`, null, icon);
  await add(`${CLASSES}\\Application`, 'ApplicationName', NAME);
  await add(`${CLASSES}\\Application`, 'ApplicationIcon', icon);
  await add(`${CLASSES}\\shell\\open\\command`, null, open);
  // prehliadač v zozname „Predvolené aplikácie“
  await add(CLIENT, null, NAME);
  await add(`${CLIENT}\\DefaultIcon`, null, icon);
  await add(`${CLIENT}\\shell\\open\\command`, null, `"${exe}"`);
  const cap = `${CLIENT}\\Capabilities`;
  await add(cap, 'ApplicationName', NAME);
  await add(cap, 'ApplicationDescription', 'Ľahký prehliadač s uspávaním kariet a blokovaním reklám');
  await add(cap, 'ApplicationIcon', icon);
  await add(`${cap}\\StartMenu`, 'StartMenuInternet', NAME);
  for (const t of URL_TYPES) await add(`${cap}\\URLAssociations`, t, PROGID);
  for (const t of FILE_TYPES) await add(`${cap}\\FileAssociations`, t, PROGID);
  await add('HKCU\\Software\\RegisteredApplications', NAME, `Software\\Clients\\StartMenuInternet\\${NAME}\\Capabilities`);
}

async function registeredPath() {
  const out = await reg(['query', `${CLASSES}\\shell\\open\\command`, '/ve']);
  const m = out && /REG_SZ\s+"([^"]+)"/.exec(out);
  return m ? m[1] : '';
}

async function isDefault() {
  // novší Windows 11 ukladá voľbu do UserChoiceLatest, starší do UserChoice
  const base = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https';
  for (const k of ['UserChoiceLatest', 'UserChoice']) {
    const out = await reg(['query', `${base}\\${k}`, '/v', 'ProgId']);
    if (out) return new RegExp(`ProgId\\s+REG_SZ\\s+${PROGID}\\b`, 'i').test(out);
  }
  return false;
}

async function status() {
  if (!supported()) return { supported: false, isDefault: false };
  return { supported: true, isDefault: await isDefault() };
}

// zaregistruje Sovu a otvorí Nastavenia Windows priamo na stránke Sovy
async function makeDefault() {
  if (!supported()) return false;
  await register();
  const ok = await shell.openExternal(`ms-settings:defaultapps?registeredAppUser=${NAME}`).then(() => true, () => false);
  if (!ok) await shell.openExternal('ms-settings:defaultapps').catch(() => {});
  return true;
}

// po aktualizácii alebo presune prenosnej verzie opraví cestu v registri (len ak už bola Sova zaregistrovaná)
async function refresh() {
  if (!supported()) return;
  const p = await registeredPath();
  if (p && p.toLowerCase() !== exePath().toLowerCase()) await register();
}

module.exports = { status, makeDefault, refresh };
