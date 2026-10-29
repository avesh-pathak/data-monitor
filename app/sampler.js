const { spawn } = require('child_process');
const path = require('path');

/**
 * Streams adapter byte counters once a second from a single long-lived PowerShell
 * process. Per-call cost of Get-NetAdapterStatistics is ~41 ms, so this stays cheap.
 *
 * Emits { down, up } in bytes per second, lightly smoothed so the display does not
 * flicker between neighbouring values at the 1 Hz sampling floor.
 */
function startSampler(onRate, onError) {
  const script = path.join(__dirname, 'sampler.ps1');
  const ps = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { windowsHide: true }
  );

  let buffer = '';
  let last = null;
  let emaDown = null;
  let emaUp = null;

  ps.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      handleLine(line);
    }
  });

  ps.stderr.on('data', (chunk) => {
    if (onError) onError(chunk.toString().trim());
  });

  ps.on('error', (err) => {
    if (onError) onError(err.message);
  });

  function handleLine(line) {
    const parts = line.split(/\s+/);
    if (parts.length !== 3) return;

    const ms = Number(parts[0]);
    const rx = Number(parts[1]);
    const tx = Number(parts[2]);
    if (!Number.isFinite(ms) || !Number.isFinite(rx) || !Number.isFinite(tx)) return;

    if (last) {
      const seconds = (ms - last.ms) / 1000;
      if (seconds > 0.2) {
        // A counter that goes backwards means the adapter reset or reconnected.
        const reset = rx < last.rx || tx < last.tx;
        const downRate = reset ? 0 : (rx - last.rx) / seconds;
        const upRate = reset ? 0 : (tx - last.tx) / seconds;

        emaDown = emaDown === null ? downRate : emaDown * 0.45 + downRate * 0.55;
        emaUp = emaUp === null ? upRate : emaUp * 0.45 + upRate * 0.55;

        onRate({
          down: Math.max(0, emaDown),
          up: Math.max(0, emaUp)
        });
      }
    }

    last = { ms, rx, tx };
  }

  return {
    stop() {
      try {
        ps.kill();
      } catch (_) {
        /* already gone */
      }
    }
  };
}

module.exports = { startSampler };
