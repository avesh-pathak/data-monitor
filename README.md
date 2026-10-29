# Data Monitor

A local-only network monitor for Windows that lives in your taskbar. It shows live
throughput in bits per second, and answers the question Task Manager never quite does:
**where did today's data go?**

![The readout in the taskbar](docs/images/taskbar-readout.png)

No account. No sync. No telemetry. The app talks to Windows, and to nothing else.

---

## Features

**Live readout, in the taskbar**
- `↓ 240 Kbps  ↑ 36.9 Mbps` pinned into the taskbar — no window to open, no click required
- Adaptive units: Kbps below 1 Mbps, Mbps above, one decimal below 100
- Smooths over two samples so the number doesn't flicker at the 1 Hz sampling floor
- Hides with the taskbar when auto-hide is on, and hides over fullscreen apps — it never floats over your work

**Dashboard, one click away**
- Four ranges: **Last 7 days**, **This week**, **Last 30 days**, or a specific **month** from a picker
- Daily usage chart with a hover tooltip showing date, total, and the down/up split
- **Apps in range** — ranked by bytes, with an explicit `unattributed` row rather than hiding the remainder
- **App drill-down** — click any app for its own daily chart
- **Hourly pattern** — a weekday × hour heatmap, so "I burn data every evening at nine" is visible at a glance
- **Forecast** — "at this rate: 621 GB by 31 Oct"
- **Monthly cap** — optional progress bar, no alerts
- **Search, rename and hide apps** — double-click to alias, `×` to hide
- **Connection dot** — green while online, red when the connection drops
- **Busiest day**, **average per day**, and **peak hour** in a single strip

**Hover summary**
- Hover the readout for today's total, the down/up split, and the top three apps

**Themes**
- Dark and light, both first class
- Sun/moon toggle in the dashboard, plus tray menu → Theme → Match Windows / Dark / Light
- The choice persists and applies to the dashboard, the widget and the popover together

**Controls**
- Tray icon: open dashboard, readout mode, theme, pause, quit
- Right-click the readout for the same readout options
- Readout modes: **live speed** or **today's total**, plus **compact** and **colour by speed**
- `Ctrl+Alt+D` opens the dashboard from anywhere
- Starts at login
- Never steals focus, never shows a taskbar button

| Dark | Light |
|---|---|
| ![Dashboard, dark](docs/images/dashboard-dark.png) | ![Dashboard, light](docs/images/dashboard-light.png) |

---

## Requirements

| | |
|---|---|
| OS | Windows 11 (tested on build 10.0.26300, 26H2) |
| Runtime | Node.js 18+ (tested on 24.14) |
| Shell | PowerShell 5.1 (included with Windows) |
| Network | Any active adapter — Wi-Fi or Ethernet |
| Admin | **Not required** to run |

---

## Install

The app is not packaged as an installer yet (see [Status](#status)), so it runs from source.

```powershell
cd app
npm install
npm start
```

That's it. The readout appears in your taskbar immediately.

### Start at login

Create a shortcut in your Startup folder pointing at Electron with the app as its argument:

1. Press `Win + R`, type `shell:startup`, press Enter.
2. Right-click → **New → Shortcut**.
3. Target:

   ```text
   "C:\path\to\app\node_modules\electron\dist\electron.exe" .
   ```

4. Set **Start in** to the `app` folder, name it *Data Monitor*, save.

### Uninstall

Quit from the tray, delete the Startup shortcut, delete the `app` folder. Nothing is
written to the registry, and the only file outside the folder is
`%APPDATA%\taskbar-data-monitor\settings.json`.

---

## Using it

| Action | Result |
|---|---|
| Look at the taskbar | Live `↓ down ↑ up` speed |
| Click the readout | Opens the dashboard |
| Hover the readout | Today's total and top three apps |
| Right-click the tray icon | Open dashboard · Theme · Pause collection · Quit |
| Drag the dashboard edge | Resizes; layout reflows down to 560 px wide |
| Theme toggle (☀/☾) | Switches dark ↔ light, remembered across restarts |

If the taskbar is set to auto-hide, move your mouse to the bottom edge — the readout is
part of the bar, so it appears with it.

---

## How it works

```text
taskbar  →  topmost overlay (widget)  →  click  →  dashboard window
                                   ↘  hover  →  popover
                                                   │
                        Electron main process  ←──┘
                          ├── sampler.ps1   Get-NetAdapterStatistics, 1 Hz
                          └── usage.ps1     WinRT network-usage API
```

- **Live speed** comes from the physical adapter's byte counters, sampled once a second.
- **History** comes from the same store behind Settings → Data usage, read unelevated
  through WinRT: per-day buckets, per-hour buckets for today, and per-app totals for the
  visible range.
- The Windows 11 taskbar is a XAML island, so a child window placed inside it does not
  paint. The readout is therefore a topmost overlay positioned over the bar and re-raised
  above it every 500 ms.

Full detail, including the measurement that settled the overlay decision, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). There is also a spoken walkthrough:
[docs/narration.wav](docs/narration.wav).

---

## Privacy

- No network calls of any kind. No account, no analytics, no crash reporting.
- Reads only: adapter counters, and Windows' own usage store for this connection profile.
- Writes only: `%APPDATA%\taskbar-data-monitor\settings.json`.
- The per-app view names executables from device paths — for example
  `\device\harddiskvolume3\program files\...\brave.exe` becomes **Brave**.

---

## Troubleshooting

**The readout isn't visible.**
Your taskbar is auto-hiding, or a fullscreen app owns the display. Move the mouse to the
bottom edge. The widget deliberately hides rather than floating over the desktop.

**The numbers don't match Settings → Data usage exactly.**
They measure different layers. The dashboard total is the adapter's byte counter; Settings
shows Windows' own estimate. Agreement within a few percent is expected, and the Apps view
is explicitly not the same number as the total.

**An app shows as "unattributed".**
Some traffic has no process behind it — kernel, driver-level, or short-lived processes that
exited before they could be named. It is shown as its own row rather than spread across
apps.

**Per-app numbers don't update live.**
Correct, for now. Per-app figures are Windows' daily aggregates. Live per-app attribution
needs the elevated ETW collector described in [Status](#status).

**Nothing appears at all, and the tray icon is missing.**
Start it from a terminal with `npm start` and read the error. The most common cause is a
missing `npm install`.

---

## Status

**v0.1 — working, used daily.** What is real today: the taskbar readout, the dashboard with
ranges and per-app ranking, hover summary, both themes, tray controls, auto-start.

What is deliberately not built yet:

| Gap | Why it matters | Next step |
|---|---|---|
| Sampler is a PowerShell stand-in | ~128 MB RSS, no per-app live data | Elevated C# helper with an ETW session |
| No database | History is re-read from Windows and cached 30 s | SQLite with 90-day detail, permanent daily/monthly rollups |
| No installer | Manual `npm install` and a Startup shortcut | Per-user NSIS installer, scheduled task for the collector |
| Primary display only | Second monitor has no readout | Multi-monitor placement |

The design decisions and the route to each of these are kept in local planning notes
under `.scratch/`, which are not published to the repository.

---

## Development

```text
app/
  main.js        window lifecycle, geometry loop, theme, IPC
  taskbar.js     Win32 geometry + fullscreen state (koffi)
  sampler.js     adapter counter stream → smoothed bytes/s
  sampler.ps1    Get-NetAdapterStatistics, once a second
  usage.js       runs usage.ps1, caches results for 30 s
  usage.ps1      WinRT per-day / per-hour / per-app query
  format.js      bytes/s → Kbps / Mbps display
  preload.js     the only bridge between main and the renderers
  widget.html    the taskbar readout
  dashboard.html the full window
  popover.html   the hover summary
  assets/        tray icon
```

Built with Electron 45 and `koffi` for the Win32 calls. No bundler, no framework — the
renderers are plain HTML and CSS so the widget stays a few kilobytes.

Debug flags, for development only:

| Variable | Effect |
|---|---|
| `WIDGET_PREVIEW=1` | Pins the widget at a fixed screen position instead of the taskbar |
| `DASH_SNAPSHOT=<path>` | Captures the dashboard to a PNG after it opens |
| `DASH_SNAPSHOT_DELAY=<ms>` | Changes that capture delay (default 4000) |
| `DASH_TEST_TOGGLE=1` | Clicks the theme toggle before that capture, to test the real path |
| `DASH_TEST_DRILL=1` | Opens the first app's drill-down before that capture |

---

## License

Not yet licensed. Treat it as a personal project until a licence is chosen.
