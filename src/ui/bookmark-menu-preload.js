// Most pre rozbaľovacie menu priečinka záložiek
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bmm', {
  onData: (cb) => ipcRenderer.on('data', (_e, d, reset, maxH, up) => cb(d, reset, maxH, up)),
  size: (w, h) => ipcRenderer.send('bmmenu:size', w, h),
  open: (id, how) => ipcRenderer.send('bmmenu:open', id, how),
  close: () => ipcRenderer.send('bmmenu:close'),
  move: (id, parentId, index) => ipcRenderer.send('bmmenu:move', id, parentId, index),
  context: (id) => ipcRenderer.send('bmmenu:context', id),
});
