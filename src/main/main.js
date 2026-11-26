'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell, powerSaveBlocker } = require('electron');

const { AuthManager } = require('./auth');
const { startProxy } = require('./proxy');
const net = require('./net');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

// WebRTC must expose real LAN host candidates. Chromium otherwise replaces local
// IPs with mDNS .local names, which an Xbox cannot resolve. This is the single
// most important switch for a direct LAN media path.
app.commandLine.appendSwitch(
  'disable-features',
  ['WebRtcHideLocalIpsWithMdns', 'CalculateNativeWinOcclusion', 'IntensiveWakeUpThrottling'].join(',')
);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Low-latency presentation is the default. Both switches are required: with
// only vsync disabled Chromium still paces to the frame-rate limit and the
// measured pipeline stayed at 15-20 ms; with both it dropped to 7-10 ms.
// Pass --no-low-latency if the resulting tearing is objectionable.
if (!process.argv.includes('--no-low-latency')) {
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('disable-frame-rate-limit');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow = null;
let proxy = null;
let auth = null;
let streamBlocker = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#08090a',
    autoHideMenuBar: true,
    show: false,
    title: 'Xbox LAN Stream',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function broadcastAuth() {
  if (!auth) return;
  const snapshot = auth.snapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('auth:changed', snapshot);
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app
  .whenReady()
  .then(async () => {
    auth = new AuthManager({
      userData: app.getPath('userData'),
      projectRoot: PROJECT_ROOT,
    });
    auth.on('change', broadcastAuth);

    proxy = await startProxy(auth);
    auth.init().catch(() => {});

    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((err) => {
    console.error('Failed to start:', err);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (streamBlocker !== null) {
    powerSaveBlocker.stop(streamBlocker);
    streamBlocker = null;
  }
  if (proxy) proxy.close();
  app.quit();
});

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    proxyOrigin: proxy.origin,
    lowLatency: !process.argv.includes('--no-low-latency'),
    uncapped: !process.argv.includes('--no-low-latency'),
  }));

  ipcMain.handle('auth:snapshot', () => auth.snapshot());
  ipcMain.handle('auth:init', () => auth.init());
  ipcMain.handle('auth:login', () => auth.beginDeviceCode());
  ipcMain.handle('auth:refresh', () => auth.refresh());
  ipcMain.handle('auth:forget', () => {
    auth.forget();
    return auth.snapshot();
  });

  ipcMain.handle('net:ping', (_event, host) => {
    if (typeof host !== 'string' || host.length > 64 || !/^[0-9a-fA-F:.]+$/.test(host)) return null;
    return net.pingHost(host);
  });
  ipcMain.handle('net:interfaces', () => net.listInterfaces());
  ipcMain.handle('net:adapters', () => net.listAdapters());

  ipcMain.handle('ics:status', () => net.icsStatus());
  ipcMain.handle('ics:enable', (_event, opts) => {
    if (!opts || typeof opts !== 'object') return { ok: false, error: 'Invalid options' };
    return net.icsEnable({
      publicAlias: String(opts.publicAlias || ''),
      privateAlias: String(opts.privateAlias || ''),
      privateIp: String(opts.privateIp || '192.168.137.1'),
    });
  });
  ipcMain.handle('ics:disable', () => net.icsDisable());

  ipcMain.handle('nat:status', () => net.natStatus());
  ipcMain.handle('nat:enable', (_event, opts) => {
    if (!opts || typeof opts !== 'object') return { ok: false, error: 'Invalid options' };
    return net.natEnable({
      publicAlias: String(opts.publicAlias || ''),
      privateAlias: String(opts.privateAlias || ''),
      privateIp: String(opts.privateIp || '192.168.137.1'),
    });
  });
  ipcMain.handle('nat:disable', () => net.natDisable());

  ipcMain.handle('app:relaunch', (_event, lowLatency) => {
    const args = process.argv
      .slice(1)
      .filter((arg) => arg !== '--no-low-latency' && arg !== '--low-latency');
    if (!lowLatency) args.push('--no-low-latency');
    app.relaunch({ args });
    app.exit(0);
    return true;
  });

  ipcMain.handle('power:stream', (_event, active) => {
    if (active) {
      if (streamBlocker === null) {
        streamBlocker = powerSaveBlocker.start('prevent-display-sleep');
      }
    } else if (streamBlocker !== null) {
      powerSaveBlocker.stop(streamBlocker);
      streamBlocker = null;
    }
    return streamBlocker !== null;
  });

  ipcMain.handle('win:fullscreen', (_event, value) => {
    if (mainWindow) mainWindow.setFullScreen(Boolean(value));
    return mainWindow ? mainWindow.isFullScreen() : false;
  });
  ipcMain.handle('win:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.handle('win:close', () => mainWindow && mainWindow.close());
  ipcMain.handle('shell:open', (_event, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) return shell.openExternal(url);
    return null;
  });
}
