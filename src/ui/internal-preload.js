// Preload pre všetky karty. API sprístupní LEN interným stránkam sova:// (nastavenia, história).
// Bežné webové stránky ho nevidia a hlavný proces navyše overuje adresu odosielateľa.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Blokovanie reklám: scriptlety (napr. YouTube) vložíme hneď na začiatku, ešte pred skriptmi stránky
if (/^https?:$/.test(location.protocol)) {
  try {
    const code = ipcRenderer.sendSync('adblock:early-scripts', location.href);
    if (code) webFrame.executeJavaScript(code);
  } catch { /* stránka sa načíta aj bez nich */ }
}

if (location.protocol === 'sova:') {
  contextBridge.exposeInMainWorld('sova', {
    invoke: (ch, ...a) => ipcRenderer.invoke('internal:' + ch, ...a),
    send: (ch, ...a) => ipcRenderer.send('internal:' + ch, ...a),
    on: (ch, cb) => ipcRenderer.on('internal:' + ch, (_e, ...a) => cb(...a)),
  });
}
