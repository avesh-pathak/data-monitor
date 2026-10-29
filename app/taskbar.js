const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const shell32 = koffi.load('shell32.dll');

const RECT = koffi.struct('RECT', {
  left: 'int32',
  top: 'int32',
  right: 'int32',
  bottom: 'int32'
});

const FindWindowW = user32.func('void *FindWindowW(str16 cls, str16 win)');
const FindWindowExW = user32.func('void *FindWindowExW(void *parent, void *child, str16 cls, str16 win)');
const GetWindowRect = user32.func('bool GetWindowRect(void *hwnd, _Out_ RECT *rect)');
const IsWindow = user32.func('bool IsWindow(void *hwnd)');

const CLASS_TASKBAR = 'Shell_TrayWnd';
const CLASS_TRAY_NOTIFY = 'TrayNotifyWnd';

const SHQueryUserNotificationState = shell32.func(
  'int SHQueryUserNotificationState(_Out_ int *state)'
);

/**
 * True when a fullscreen app, presentation or lock screen owns the display.
 * The taskbar keeps its normal rect in those states, so geometry alone cannot tell us
 * that the bar is not actually on screen — this can.
 */
function shouldHideForFullscreen() {
  const state = [0];
  const hr = SHQueryUserNotificationState(state);
  if (hr !== 0) return false;
  // QUNS_NOT_PRESENT 1, BUSY 2, RUNNING_D3D_FULL_SCREEN 3, PRESENTATION_MODE 4, QUIET_TIME 6
  return state[0] === 1 || state[0] === 2 || state[0] === 3 || state[0] === 4 || state[0] === 6;
}

/**
 * Reads the live taskbar geometry. All coordinates come back in physical pixels,
 * because the Electron main process is per-monitor DPI aware.
 *
 * The taskbar is set to auto-hide on this machine: when hidden, its rect keeps its
 * height but slides down so only a couple of pixels remain on screen.
 */
function getTaskbarGeometry() {
  const tray = FindWindowW(CLASS_TASKBAR, null);
  if (!tray || !IsWindow(tray)) return null;

  const rect = {};
  if (!GetWindowRect(tray, rect)) return null;

  const height = rect.bottom - rect.top;
  const width = rect.right - rect.left;
  if (height <= 0 || width <= 0) return null;

  // The notification area is the ruler for "immediately left of the clock".
  let notifyLeft = null;
  const notify = FindWindowExW(tray, null, CLASS_TRAY_NOTIFY, null);
  if (notify) {
    const n = {};
    if (GetWindowRect(notify, n) && n.left > rect.left) {
      notifyLeft = n.left;
    }
  }

  // The Start button is the anchor for the empty band on the left of a centred icon row.
  let startLeft = null;
  const start = FindWindowExW(tray, null, 'Start', null);
  if (start) {
    const s = {};
    if (GetWindowRect(start, s) && s.left > rect.left) {
      startLeft = s.left;
    }
  }

  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width,
    height,
    notifyLeft,
    startLeft
  };
}

module.exports = { getTaskbarGeometry, shouldHideForFullscreen };
