// Most pre bubliny (sťahovania, test rýchlosti). Názov bubliny je v adrese (?bubble=…).
const { contextBridge, ipcRenderer } = require('electron');

const name = new URLSearchParams(location.search).get('bubble') || 'bubble';
contextBridge.exposeInMainWorld('bubble', {
  on: (ch, cb) => ipcRenderer.on(ch, (_e, ...a) => cb(...a)),
  send: (ch, ...a) => ipcRenderer.send(`${name}:${ch}`, ...a),
  invoke: (ch, ...a) => ipcRenderer.invoke(`${name}:${ch}`, ...a),
  size: (h) => ipcRenderer.send(`${name}:size`, h),
  close: () => ipcRenderer.send(`${name}:close`),
});
