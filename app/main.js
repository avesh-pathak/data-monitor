const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, nativeTheme } = require('electron');

const { getTaskbarGeometry, shouldHideForFullscreen } = require('./taskbar');
const { startSampler } = require('./sampler');
const { formatRate } = require('./format');
const { readUsage } = require('./usage');

const WIDGET_WIDTH = 210;
const WIDGET_HEIGHT = 34;
const GAP_DIP = 10;
const REPOSITION_MS = 150;
const POPOVER_WIDTH = 320;
const POPOVER_HEIGHT = 196;

const THEMES = ['system', 'dark', 'light'];

let win = null;
let dashboard = null;
let popover = null;
let popoverToken = 0;
let tray = null;
let sampler = null;
let paused = false;
let latest = { down: { text: '0.0', unit: 'Kbps' }, up: { text: '0.0', unit: 'Kbps' } };
let repositionTimer = null;
let lastRaise = 0;
let settings = { theme: 'system' };

app.setAppUserModelId('local.taskbar-data-monitor');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && THEMES.includes(parsed.theme)) settings.theme = parsed.theme;
  } catch (_) {
    /* first run, or unreadable: keep defaults */
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    console.log('[settings] saved', settings.theme, 'to', settingsPath());
  } catch (err) {
    console.error('[settings] save failed:', err.message);
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

  // screen-saver level sits above the taskbar itself.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

  win.loadFile(path.join(__dirname, 'widget.html'));
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('sample', latest);
    win.webContents.send('paused', paused);
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
    height: 700,
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
    // The widget is a no-activate window, so the app never owns the foreground when
    // the click arrives. Without this, the dashboard opens behind the user's window.
    if (process.platform === 'win32') app.focus({ steal: true });
    dashboard.show();
    dashboard.focus();
    dashboard.moveTop();

    if (process.env.DASH_SNAPSHOT) {
      setTimeout(async () => {
        try {
          if (process.env.DASH_TEST_TOGGLE === '1') {
            await dashboard.webContents.executeJavaScript(
              "document.getElementById('themeToggle').click()"
            );
            await new Promise((resolve) => setTimeout(resolve, 1200));
          }
          const image = await dashboard.capturePage();
          require('fs').writeFileSync(process.env.DASH_SNAPSHOT, image.toPNG());
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

  // Auto-hidden bar: it keeps its height but slides down, leaving a sliver.
  // The readout lives *in* the taskbar, so it goes away with the bar rather than
  // floating over whatever window is underneath.
  const barHidden = geo.top > screenHeightPx - 20;
  if (barHidden) {
    if (win.isVisible()) win.hide();
    return;
  }

  // Fullscreen apps suppress the bar without moving it, so geometry alone is not enough.
  if (shouldHideForFullscreen()) {
    if (win.isVisible()) win.hide();
    return;
  }

  const widthPx = Math.round(WIDGET_WIDTH * scale);
  const heightPx = Math.round(WIDGET_HEIGHT * scale);
  const notifyLeft = geo.notifyLeft !== null ? geo.notifyLeft : geo.right - Math.round(120 * scale);

  // Prefer the empty band to the left of a centred Start button: the icon row is drawn
  // by XAML and its real extent is not measurable, so sitting left of the clock overlaps
  // icons as soon as enough apps are open. Fall back to the clock side when there is no
  // Start anchor or no room.
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

  // The taskbar is itself topmost and re-raises after notifications, tray changes and
  // clock ticks, which puts it above us. Re-assert our place in the topmost band.
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

function onRate(rate) {
  latest = {
    down: formatRate(rate.down),
    up: formatRate(rate.up)
  };

  if (paused) return;

  for (const target of [win, dashboard]) {
    if (target && !target.isDestroyed()) target.webContents.send('sample', latest);
  }

  if (tray) {
    tray.setToolTip(`↓ ${latest.down.text} ${latest.down.unit}   ↑ ${latest.up.text} ${latest.up.unit}`);
  }
}

function logError(message) {
  if (message) console.error('[sampler]', message);
}

ipcMain.on('open-dashboard', () => createDashboard());

ipcMain.on('request-usage', async (event, options) => {
  const data = await readUsage(options || {});
  if (!event.sender.isDestroyed()) {
    event.sender.send('usage', data);
  }
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
});

app.on('window-all-closed', () => {
  // Tray app: keep running with no widget window. Not calling app.quit() is the point.
});

app.on('before-quit', () => {
  if (repositionTimer) clearInterval(repositionTimer);
  if (sampler) sampler.stop();
});
