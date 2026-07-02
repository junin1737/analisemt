'use strict';
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

const PORT = 5050;
let mainWindow;

// Inicia o Express server no mesmo processo
require('./server.js');

// ─── Auto-update (GitHub Releases via electron-builder) ────────────────────
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

function sendUpdate(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
autoUpdater.on('update-available',     (info) => sendUpdate('update:available', { version: info.version }));
autoUpdater.on('update-not-available', (info) => sendUpdate('update:not-available', { version: info.version }));
autoUpdater.on('download-progress',    (p)    => sendUpdate('update:progress', { percent: p.percent }));
autoUpdater.on('update-downloaded',    (info) => sendUpdate('update:downloaded', { version: info.version }));
autoUpdater.on('error',                (err)  => sendUpdate('update:error', err.message));

ipcMain.handle('update:check', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, version: result && result.updateInfo ? result.updateInfo.version : null };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('update:download', async () => {
  try { await autoUpdater.downloadUpdate(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('update:install', () => {
  // Silencioso e reabre o app sozinho após instalar.
  autoUpdater.quitAndInstall(true, true);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    title: 'Painel CLIPP - MT Automações',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Aguarda Express subir antes de carregar
  const tryLoad = (attempts) => {
    const http = require('http');
    const req = http.get(`http://localhost:${PORT}`, (res) => {
      mainWindow.loadURL(`http://localhost:${PORT}`);
    });
    req.on('error', () => {
      if (attempts > 0) setTimeout(() => tryLoad(attempts - 1), 500);
      else mainWindow.loadURL(`http://localhost:${PORT}`);
    });
    req.end();
  };
  tryLoad(10);

  // Abre links externos no browser do sistema
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
