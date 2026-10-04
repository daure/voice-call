const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceCall', {
  ready: () => ipcRenderer.invoke('voice:ready'),
  begin: (id, voice) => ipcRenderer.invoke('voice:begin', id, voice),
  connect: (id, sdp) => ipcRenderer.invoke('voice:connect', id, sdp),
  stopTools: (id) => ipcRenderer.invoke('voice:stop-tools', id),
  finish: (id, result) => ipcRenderer.invoke('voice:finish', id, result),
  onCall: (callback) => ipcRenderer.on('voice:call', (_event, call) => callback(call)),
  onCloseRequest: (callback) => ipcRenderer.on('voice:close-request', () => callback()),
});
