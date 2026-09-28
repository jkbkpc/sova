// Most pre zoznam návrhov pod adresným riadkom.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('suggest', {
  onItems: (cb) => ipcRenderer.on('items', (_e, items, sel) => cb(items, sel)),
  onSelect: (cb) => ipcRenderer.on('select', (_e, i) => cb(i)),
  pick: (i) => ipcRenderer.send('suggest:pick', i),
});
