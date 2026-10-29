const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onSample: (callback) => ipcRenderer.on('sample', (_event, data) => callback(data)),
  onPaused: (callback) => ipcRenderer.on('paused', (_event, value) => callback(value)),
  openDashboard: () => ipcRenderer.send('open-dashboard'),
  requestUsage: (options) => ipcRenderer.send('request-usage', options || {}),
  onUsage: (callback) => ipcRenderer.on('usage', (_event, data) => callback(data)),
  hoverStart: () => ipcRenderer.send('widget-hover-start'),
  hoverEnd: () => ipcRenderer.send('widget-hover-end'),
  setTheme: (theme) => ipcRenderer.send('set-theme', theme),
  onPopover: (callback) => ipcRenderer.on('popover-data', (_event, data) => callback(data)),
  onWidget: (callback) => ipcRenderer.on('widget', (_event, data) => callback(data)),
  widgetContext: () => ipcRenderer.send('widget-context'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (patch) => ipcRenderer.invoke('update-settings', patch),
  onSettings: (callback) => ipcRenderer.on('settings', (_event, data) => callback(data)),
  appDays: (payload) => ipcRenderer.invoke('app-days', payload)
});
