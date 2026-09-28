// Most pre bublinu úpravy záložky
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bm', {
  onData: (cb) => ipcRenderer.on('data', (_e, d) => cb(d)),
  draft: (d) => ipcRenderer.send('bmpop:draft', d),
  done: (d) => ipcRenderer.send('bmpop:done', d),
  cancel: () => ipcRenderer.send('bmpop:cancel'),
  remove: (id) => ipcRenderer.send('bmpop:remove', id),
  height: (h) => ipcRenderer.send('bmpop:height', h),
});
