'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lan', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  relaunch: (lowLatency) => ipcRenderer.invoke('app:relaunch', Boolean(lowLatency)),

  auth: {
    snapshot: () => ipcRenderer.invoke('auth:snapshot'),
    init: () => ipcRenderer.invoke('auth:init'),
    login: () => ipcRenderer.invoke('auth:login'),
    refresh: () => ipcRenderer.invoke('auth:refresh'),
    forget: () => ipcRenderer.invoke('auth:forget'),
    onChanged: (callback) => {
      const listener = (_event, snapshot) => callback(snapshot);
      ipcRenderer.on('auth:changed', listener);
      return () => ipcRenderer.removeListener('auth:changed', listener);
    },
  },

  net: {
    ping: (host) => ipcRenderer.invoke('net:ping', host),
    interfaces: () => ipcRenderer.invoke('net:interfaces'),
    adapters: () => ipcRenderer.invoke('net:adapters'),
  },

  ics: {
    status: () => ipcRenderer.invoke('ics:status'),
    enable: (opts) => ipcRenderer.invoke('ics:enable', opts),
    disable: () => ipcRenderer.invoke('ics:disable'),
  },

  nat: {
    status: () => ipcRenderer.invoke('nat:status'),
    enable: (opts) => ipcRenderer.invoke('nat:enable', opts),
    disable: () => ipcRenderer.invoke('nat:disable'),
  },

  power: {
    stream: (active) => ipcRenderer.invoke('power:stream', Boolean(active)),
  },

  win: {
    fullscreen: (value) => ipcRenderer.invoke('win:fullscreen', value),
    minimize: () => ipcRenderer.invoke('win:minimize'),
    close: () => ipcRenderer.invoke('win:close'),
  },

  open: (url) => ipcRenderer.invoke('shell:open', url),
});
