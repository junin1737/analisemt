'use strict';
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');

const PORT = 5050;
let mainWindow;

// Inicia o Express server no mesmo processo
require('./server.js');

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
