const { spawn } = require('child_process');
const path = require('path');

const cache = new Map();
const CACHE_MS = 30 * 1000;

/**
 * Reads Windows' own per-day, per-hour and per-app usage for this connection profile.
 * Unelevated, no dependencies, ~1 s. `appsStart`/`appsEnd` scope the per-app query to
 * the range the dashboard is showing; days and hours are always the full window.
 */
function readUsage({ appsStart = '', appsEnd = '' } = {}) {
  const key = `${appsStart}|${appsEnd}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.data);

  return new Promise((resolve) => {
    const script = path.join(__dirname, 'usage.ps1');
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
    if (appsStart && appsEnd) args.push('-AppsStart', appsStart, '-AppsEnd', appsEnd);

    const ps = spawn('powershell.exe', args, { windowsHide: true });

    let stdout = '';
    let stderr = '';

    ps.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    ps.stderr.on('data', (chunk) => (stderr += chunk.toString()));

    const timer = setTimeout(() => {
      try {
        ps.kill();
      } catch (_) {
        /* already gone */
      }
      resolve(null);
    }, 30000);

    ps.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });

    ps.on('close', () => {
      clearTimeout(timer);
      const text = stdout.replace(/^\uFEFF/, '').trim();
      if (!text) {
        if (stderr) console.error('[usage]', stderr.trim());
        return resolve(null);
      }
      try {
        const data = JSON.parse(text);
        if (data.error) return resolve(null);
        cache.set(key, { at: Date.now(), data });
        resolve(data);
      } catch (err) {
        console.error('[usage] parse failed:', err.message);
        resolve(null);
      }
    });
  });
}

module.exports = { readUsage };
