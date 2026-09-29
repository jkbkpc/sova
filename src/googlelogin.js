// Prihlásenie do Google (Gmail, YouTube…): Google odmieta prehliadače postavené na Electrone
// („Tento prehliadač alebo aplikácia zrejme nie je zabezpečená“). Iba na prihlasovacej stránke Google
// sa preto Sova predstaví ako Firefox – hlavička User-Agent, bez hlavičiek Sec-CH-UA a rovnako aj pre skripty stránky.
// Ostatné stránky (aj samotný YouTube a Gmail) vidia Sovu ako bežný Chrome.
const { ipcMain } = require('electron');

const HOSTS = (process.env.SOVA_UA_HOSTS || 'accounts.google.com').split(',').map((h) => h.trim()).filter(Boolean);

// aktuálna verzia Firefoxu (vychádza každé 4 týždne; 130 = september 2024)
function firefoxVersion(now = Date.now()) {
  return 129 + Math.max(0, Math.floor((now - Date.UTC(2024, 8, 3)) / (28 * 86400000)));
}
function firefoxUA() {
  const v = firefoxVersion();
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`;
}
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
const isLoginHost = (url) => HOSTS.includes(hostOf(url));

// hlavičky požiadaviek na prihlasovaciu stránku (v každej relácii – bežnej aj inkognito)
function setupSession(session) {
  const urls = HOSTS.flatMap((h) => [`https://${h}/*`, `http://${h}/*`]);
  session.webRequest.onBeforeSendHeaders({ urls }, (details, cb) => {
    const h = { ...details.requestHeaders };
    for (const k of Object.keys(h)) if (/^sec-ch-ua/i.test(k)) delete h[k];
    h['User-Agent'] = firefoxUA();
    cb({ requestHeaders: h });
  });
}

// skript pre stránku (spúšťa ho preload karty skôr, než skripty stránky)
function earlyScript(url) {
  if (!isLoginHost(url)) return '';
  const ua = JSON.stringify(firefoxUA());
  const app = JSON.stringify(firefoxUA().replace(/^Mozilla\//, ''));
  return `(() => { try {
    const def = (o, k, v) => Object.defineProperty(o, k, { get: () => v, configurable: true });
    def(Navigator.prototype, 'userAgent', ${ua});
    def(Navigator.prototype, 'appVersion', '5.0 (Windows)');
    def(Navigator.prototype, 'vendor', '');
    def(Navigator.prototype, 'productSub', '20100101');
    def(Navigator.prototype, 'oscpu', 'Windows NT 10.0; Win64; x64');
    if ('userAgentData' in Navigator.prototype) def(Navigator.prototype, 'userAgentData', undefined);
    void ${app};
  } catch (e) {} })();`;
}

function setupGoogleLogin() {
  ipcMain.on('compat:early-scripts', (e, url) => { try { e.returnValue = earlyScript(url); } catch { e.returnValue = ''; } });
}

module.exports = { setupGoogleLogin, setupSession, earlyScript, firefoxUA, firefoxVersion, isLoginHost };
