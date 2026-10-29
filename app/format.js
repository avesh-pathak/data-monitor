/**
 * Splits a byte-per-second rate into a compact bits-per-second display.
 * Bits, not bytes: this is what speed tests, task managers and ISPs report.
 * One decimal below 100 so small rates stay honest; whole numbers above.
 */
function formatRate(bytesPerSecond) {
  const bits = Math.max(0, bytesPerSecond || 0) * 8;

  let value;
  let unit;

  if (bits >= 1e6) {
    value = bits / 1e6;
    unit = 'Mbps';
  } else if (bits >= 1e3) {
    value = bits / 1e3;
    unit = 'Kbps';
  } else {
    value = 0;
    unit = 'Kbps';
  }

  const decimals = value >= 100 ? 0 : 1;
  return { text: value.toFixed(decimals), unit };
}

module.exports = { formatRate };
