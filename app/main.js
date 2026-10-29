const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, nativeTheme, globalShortcut } = require('electron');

const { getTaskbarGeometry, shouldHideForFullscreen } = require('./taskbar');
const { startSampler } = require('./sampler');
const { formatRate, formatBytes } = require('./format');
const { readUsage } = require('./usage');

const WIDGET_WIDTH = 210;
const WIDGET_HEIGHT = 34;
const GAP_DIP = 10;
const REPOSITION_MS = 150;
const POPOVER_WIDTH = 320;
const POPOVER_HEIGHT = 196;

const THEMES = ['system', 'dark', 'light'];
const WIDGET_MODES = ['speed', 'today'];

let win = null;
let dashboard = null;
let popover = null;
let popoverToken = 0;
let tray = null;
let sampler = null;
let paused = false;
let latestRate = { down: { text: '0.0', unit: 'Kbps' }, up: { text: '0.0', unit: 'Kbps' }, mbps: 0 };
let todayBytes = 0;
let recentMbps = [];
let repositionTimer = null;
let lastRaise = 0;
let settings = {
  theme: 'system',
  widgetMode: 'speed',
  compact: false,
  thresholds: false,
  capGb: 0,
  aliases: {},
  ignored: []
};

const appDaysCache = new Map();

app.setAppUserModelId('local.taskbar-data-monitor');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      if (THEMES.includes(parsed.theme)) settings.theme = parsed.theme;
      if (WIDGET_MODES.includes(parsed.widgetMode)) settings.widgetMode = parsed.widgetMode;
      if (typeof parsed.compact === 'boolean') settings.compact = parsed.compact;
      if (typeof parsed.thresholds === 'boolean') settings.thresholds = parsed.thresholds;
      if (Number.isFinite(parsed.capGb)) settings.capGb = parsed.capGb;
      if (parsed.aliases && typeof parsed.aliases === 'object') settings.aliases = parsed.aliases;
      if (Array.isArray(parsed.ignored)) settings.ignored = parsed.ignored;
    }
  } catch (_) {
    /* first run */
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('[settings] save failed:', err.message);
  }
}

function broadcastSettings() {
  for (const target of [win, dashboard]) {
    if (target && !target.isDestroyed()) target.webContents.send('settings', settings);
  }
}

function applyTheme(theme, persist = true) {
  if (!THEMES.includes(theme)) return;
  settings.theme = theme;
  nativeTheme.themeSource = theme;

  const background = nativeTheme.shouldUseDarkColors ? '#0b0b0f' : '#f5f6f8';
  if (dashboard && !dashboard.isDestroyed()) dashboard.setBackgroundColor(background);

  if (persist) saveSettings();
  refreshTrayMenu();
  broadcastSettings();
}

function createWidget() {
  win = new BrowserWindow({
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

  win.loadFile(path.join(__dirname, 'widget.html'));
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('settings', settings);
    win.webContents.send('paused', paused);
    pushWidget();
  });
}

function createDashboard() {
  if (dashboard && !dashboard.isDestroyed()) {
    if (dashboard.isMinimized()) dashboard.restore();
    if (process.platform === 'win32') app.focus({ steal: true });
    dashboard.show();
    dashboard.focus();
    dashboard.moveTop();
    return;
  }

  dashboard = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 560,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0b0f' : '#f5f6f8',
    title: 'Data Monitor',
    autoHideMenuBar: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  dashboard.loadFile(path.join(__dirname, 'dashboard.html'));
  dashboard.once('ready-to-show', () => {
    if (process.platform === 'win32') app.focus({ steal: true });
    dashboard.show();
    dashboard.focus();
    dashboard.moveTop();

    if (process.env.DASH_SNAPSHOT) {
      const snapshotDelay = Number(process.env.DASH_SNAPSHOT_DELAY || 4000);
      setTimeout(async () => {
        try {
          if (process.env.DASH_TEST_TOGGLE === '1') {
            await dashboard.webContents.executeJavaScript(
              "document.getElementById('themeToggle').click()"
            );
            await new Promise((resolve) => setTimeout(resolve, 1200));
          }
          if (process.env.DASH_TEST_DRILL === '1') {
            await dashboard.webContents.executeJavaScript(
              "document.querySelector('#apps .app')?.click()"
            );
            await new Promise((resolve) => setTimeout(resolve, 22000));
          }
          const image = await dashboard.capturePage();
          require('fs').writeFileSync(process.env.DASH_SNAPSHOT, image.toPNG());
          const metrics = await dashboard.webContents.executeJavaScript(
            'JSON.stringify({ scrollHeight: document.body.scrollHeight, innerHeight: window.innerHeight, scrollWidth: document.body.scrollWidth, innerWidth: window.innerWidth })'
          );
          console.log('layout metrics:', metrics);
          console.log('dashboard snapshot written');
        } catch (err) {
          console.error('dashboard snapshot failed:', err.message);
        }
      }, 4000);
    }
  });
  dashboard.on('closed', () => {
    dashboard = null;
  });
}

function positionWidget() {
  if (!win || win.isDestroyed()) return;

  if (process.env.WIDGET_PREVIEW === '1') {
    win.setBounds({ x: 800, y: 500, width: WIDGET_WIDTH, height: WIDGET_HEIGHT });
    if (!win.isVisible()) win.showInactive();
    return;
  }

  const geo = getTaskbarGeometry();
  if (!geo) {
    if (win.isVisible()) win.hide();
    return;
  }

  const display = screen.getDisplayNearestPoint({ x: geo.left, y: geo.top });
  const scale = display.scaleFactor;
  const screenHeightPx = display.bounds.height * scale;

  const barHidden = geo.top > screenHeightPx - 20;
  if (barHidden) {
    if (win.isVisible()) win.hide();
    return;
  }

  if (shouldHideForFullscreen()) {
    if (win.isVisible()) win.hide();
    return;
  }

  const widthPx = Math.round(WIDGET_WIDTH * scale);
  const heightPx = Math.round(WIDGET_HEIGHT * scale);
  const notifyLeft = geo.notifyLeft !== null ? geo.notifyLeft : geo.right - Math.round(120 * scale);

  let xPx = null;
  if (geo.startLeft !== null) {
    xPx = Math.round(geo.startLeft - widthPx - 18 * scale);
  }
  if (xPx === null || xPx < geo.left + 8) {
    xPx = Math.round(notifyLeft - widthPx - GAP_DIP * scale);
  }

  const yPx = Math.round(geo.top + (geo.height - heightPx) / 2);

  win.setBounds({
    x: Math.round(xPx / scale),
    y: Math.round(yPx / scale),
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT
  });

  if (!win.isVisible()) win.showInactive();

  const now = Date.now();
  if (now - lastRaise > 500) {
    win.moveTop();
    lastRaise = now;
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open dashboard', click: () => createDashboard() },
    { type: 'separator' },
    {
      label: 'Readout',
      submenu: [
        {
          label: 'Live speed',
          type: 'radio',
          checked: settings.widgetMode === 'speed',
          click: () => updateSettings({ widgetMode: 'speed' })
        },
        {
          label: "Today's total",
          type: 'radio',
          checked: settings.widgetMode === 'today',
          click: () => updateSettings({ widgetMode: 'today' })
        },
        { type: 'separator' },
        {
          label: 'Compact (no units)',
          type: 'checkbox',
          checked: settings.compact,
          click: (item) => updateSettings({ compact: item.checked })
        },
        {
          label: 'Colour by speed',
          type: 'checkbox',
          checked: settings.thresholds,
          click: (item) => updateSettings({ thresholds: item.checked })
        }
      ]
    },
    {
      label: 'Theme',
      submenu: [
        {
          label: 'Match Windows',
          type: 'radio',
          checked: settings.theme === 'system',
          click: () => applyTheme('system')
        },
        {
          label: 'Dark',
          type: 'radio',
          checked: settings.theme === 'dark',
          click: () => applyTheme('dark')
        },
        {
          label: 'Light',
          type: 'radio',
          checked: settings.theme === 'light',
          click: () => applyTheme('light')
        }
      ]
    },
    { type: 'separator' },
    {
      label: 'Pause collection',
      type: 'checkbox',
      checked: paused,
      click: (item) => {
        paused = item.checked;
        if (paused) {
          sampler.stop();
          sampler = null;
        } else {
          sampler = startSampler(onRate, logError);
        }
        if (win && !win.isDestroyed()) win.webContents.send('paused', paused);
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Data monitor');
  refreshTrayMenu();
}

function sparkline(values) {
  const glyphs = ' ▁▂▃▄▅▆▇█';
  const max = Math.max(...values, 0.0001);
  return values
    .map((v) => glyphs[Math.min(glyphs.length - 1, Math.max(0, Math.round((v / max) * (glyphs.length - 1))))])
    .join('');
}

function pushWidget() {
  if (!win || win.isDestroyed()) return;

  let payload;
  if (settings.widgetMode === 'today') {
    const total = formatBytes(todayBytes);
    payload = { kind: 'total', text: total.text, unit: total.unit, compact: settings.compact };
  } else {
    payload = {
      kind: 'speed',
      down: latestRate.down,
      up: latestRate.up,
      compact: settings.compact,
      thresholds: settings.thresholds,
      mbps: latestRate.mbps
    };
  }

  win.webContents.send('widget', payload);
}

function onRate(rate) {
  latestRate = {
    down: formatRate(rate.down),
    up: formatRate(rate.up),
    mbps: (rate.down + rate.up) * 8 / 1e6
  };

  if (paused) return;

  recentMbps.push(latestRate.mbps);
  if (recentMbps.length > 60) recentMbps.shift();

  for (const target of [dashboard]) {
    if (target && !target.isDestroyed()) {
      target.webContents.send('sample', { down: latestRate.down, up: latestRate.up });
    }
  }

  pushWidget();

  if (tray) {
    const tail = recentMbps.slice(-40);
    tray.setToolTip(
      `↓ ${latestRate.down.text} ${latestRate.down.unit}   ↑ ${latestRate.up.text} ${latestRate.up.unit}\n${sparkline(tail)}`
    );
  }
}

async function refreshToday() {
  const data = await readUsage({});
  if (data && data.days && data.days.length) {
    const today = data.days[data.days.length - 1];
    todayBytes = today.rx + today.tx;
    pushWidget();
  }
}

function logError(message) {
  if (message) console.error('[sampler]', message);
}

function updateSettings(patch) {
  if (!patch || typeof patch !== 'object') return settings;

  settings = { ...settings, ...patch };
  if (patch.theme) nativeTheme.themeSource = THEMES.includes(patch.theme) ? patch.theme : 'system';
  saveSettings();

  const background = nativeTheme.shouldUseDarkColors ? '#0b0b0f' : '#f5f6f8';
  if (dashboard && !dashboard.isDestroyed()) dashboard.setBackgroundColor(background);

  refreshTrayMenu();
  broadcastSettings();
  pushWidget();

  if (settings.widgetMode === 'today') refreshToday();

  return settings;
}

ipcMain.handle('get-settings', () => settings);
ipcMain.handle('update-settings', (_event, patch) => updateSettings(patch));

ipcMain.handle('app-days', (_event, payload) => {
  return new Promise((resolve) => {
    const { appId, start, end } = payload || {};
    if (!appId || !start || !end) return resolve(null);

    const key = `${appId}|${start}|${end.slice(0, 10)}`;
    const hit = appDaysCache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return resolve(hit.days);

    const { spawn } = require('child_process');
    const ps = spawn(
      'powershell.exe',
      [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'appdays.ps1'),
        '-AppId', appId, '-Start', start, '-End', end
      ],
      { windowsHide: true }
    );

    let out = '';
    ps.stdout.on('data', (c) => (out += c.toString()));
    ps.on('close', () => {
      try {
        const parsed = JSON.parse(out.replace(/^\uFEFF/, '').trim());
        const days = parsed && parsed.days ? parsed.days : null;
        if (days) appDaysCache.set(key, { at: Date.now(), days });
        resolve(days);
      } catch (_) {
        resolve(null);
      }
    });
    ps.on('error', () => resolve(null));
  });
});

ipcMain.on('open-dashboard', () => createDashboard());

ipcMain.on('request-usage', async (event, options) => {
  const data = await readUsage(options || {});
  if (!event.sender.isDestroyed()) {
    event.sender.send('usage', data);
  }
});

ipcMain.on('widget-context', () => {
  if (!win || win.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    {
      label: 'Readout',
      submenu: [
        {
          label: 'Live speed',
          type: 'radio',
          checked: settings.widgetMode === 'speed',
          click: () => updateSettings({ widgetMode: 'speed' })
        },
        {
          label: "Today's total",
          type: 'radio',
          checked: settings.widgetMode === 'today',
          click: () => updateSettings({ widgetMode: 'today' })
        },
        { type: 'separator' },
        {
          label: 'Compact (no units)',
          type: 'checkbox',
          checked: settings.compact,
          click: (item) => updateSettings({ compact: item.checked })
        },
        {
          label: 'Colour by speed',
          type: 'checkbox',
          checked: settings.thresholds,
          click: (item) => updateSettings({ thresholds: item.checked })
        }
      ]
    },
    { type: 'separator' },
    { label: 'Open dashboard', click: () => createDashboard() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  menu.popup({ window: win });
});

function ensurePopover() {
  if (popover && !popover.isDestroyed()) return;

  popover = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: POPOVER_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  popover.setAlwaysOnTop(true, 'screen-saver');
  popover.setIgnoreMouseEvents(true);
  popover.loadFile(path.join(__dirname, 'popover.html'));
}

async function showPopover() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;

  const token = ++popoverToken;
  ensurePopover();

  const bounds = win.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const area = display.workArea;

  let x = Math.round(bounds.x + bounds.width / 2 - POPOVER_WIDTH / 2);
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - POPOVER_WIDTH - 8));

  let y = bounds.y - POPOVER_HEIGHT - 10;
  if (y < area.y + 8) y = bounds.y + bounds.height + 10;

  popover.setBounds({ x, y, width: POPOVER_WIDTH, height: POPOVER_HEIGHT });

  const data = await readUsage({});
  if (token !== popoverToken || !popover || popover.isDestroyed()) return;

  popover.webContents.send('popover-data', data);
  popover.showInactive();
}

function hidePopover() {
  popoverToken += 1;
  if (popover && !popover.isDestroyed() && popover.isVisible()) popover.hide();
}

ipcMain.on('widget-hover-start', () => {
  showPopover();
});

ipcMain.on('widget-hover-end', () => {
  hidePopover();
});

ipcMain.on('set-theme', (_event, theme) => {
  applyTheme(theme);
});

app.whenReady().then(() => {
  loadSettings();
  applyTheme(settings.theme, false);
  createWidget();
  createTray();
  sampler = startSampler(onRate, logError);
  positionWidget();
  repositionTimer = setInterval(positionWidget, REPOSITION_MS);

  refreshToday();
  setInterval(() => {
    if (settings.widgetMode === 'today') refreshToday();
  }, 60000);

  globalShortcut.register('Control+Alt+D', () => createDashboard());
});

app.on('window-all-closed', () => {
  // Tray app: keep running with no widget window. Not calling app.quit() is the point.
});

app.on('before-quit', () => {
  if (repositionTimer) clearInterval(repositionTimer);
  if (sampler) sampler.stop();
  globalShortcut.unregisterAll();
});
