// Most medzi rozhraním prehliadača (lišta s kartami) a hlavným procesom.
// Stránky z internetu k tomu prístup nemajú – tento preload beží len v UI okna.
const { contextBridge, ipcRenderer } = require('electron');

const SEND = ['ui-height', 'tab:new', 'tab:activate', 'tab:close', 'tab:menu', 'tab:mute', 'nav:go', 'nav:back',
  'nav:forward', 'nav:reload', 'nav:stop', 'find', 'find:stop', 'adblock:toggle-site', 'sleep-others',
  'suggest:query', 'suggest:select', 'suggest:hide', 'open-internal',
  'bm:star', 'bm:open', 'bm:folder-menu', 'bm:overflow-menu', 'bm:move', 'bm:context', 'bm:other-menu',
  'tools:stats', 'tools:downloads', 'tools:downloads-rect', 'site:info',
  'bm:add-drop', 'tab:move', 'cert:back', 'cert:proceed', 'update:install', 'zoom:bubble', 'window:new', 'window:menu', 'danger:back', 'danger:proceed'];
const INVOKE = [];
const ON = ['state', 'activated', 'focus-address', 'open-find', 'find-step', 'find-result', 'suggest:result', 'bm:star-request'];

contextBridge.exposeInMainWorld('sova', {
  send: (ch, ...a) => { if (SEND.includes(ch)) ipcRenderer.send(ch, ...a); },
  invoke: (ch, ...a) => (INVOKE.includes(ch) ? ipcRenderer.invoke(ch, ...a) : Promise.reject(new Error('blocked'))),
  on: (ch, cb) => { if (ON.includes(ch)) ipcRenderer.on(ch, (_e, ...a) => cb(...a)); },
});
