'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updater', {
  isElectron: true,
  check: () => ipcRenderer.invoke('update:check'),
  download: () => ipcRenderer.invoke('update:download'),
  install: () => ipcRenderer.invoke('update:install'),
  onAvailable: (cb) => ipcRenderer.on('update:available', (_e, info) => cb(info)),
  onNotAvailable: (cb) => ipcRenderer.on('update:not-available', (_e, info) => cb(info)),
  onProgress: (cb) => ipcRenderer.on('update:progress', (_e, progress) => cb(progress)),
  onDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_e, info) => cb(info)),
  onError: (cb) => ipcRenderer.on('update:error', (_e, message) => cb(message)),
});
