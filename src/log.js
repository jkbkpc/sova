// Jednoduchý denník udalostí pri štarte a aktualizácii (%APPDATA%\Sova\sova.log) – na hľadanie chýb.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let file = null;
function log(...parts) {
  try {
    if (!file) {
      file = path.join(app.getPath('userData'), 'sova.log');
      try { if (fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + '.old'); } catch {}
    }
    const line = `${new Date().toISOString()} [${process.pid}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
    fs.appendFileSync(file, line);
  } catch { /* denník nie je dôležitý */ }
}
module.exports = { log };
