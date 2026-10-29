# Glossary

**Widget** — the always-visible readout embedded in the Windows taskbar. Shows integer MB/s down/up and nothing else.

**Dashboard** — the window opened by clicking the widget. Holds the Today, History, Apps and Monthly views.

**Collector** — the elevated background process that samples network counters and per-process attribution, and writes them to local storage. Never visible.

**Detail tier** — per-app and per-hour records. Retained 90 days, then pruned.

**Rollup** — a daily or monthly total. Retained indefinitely.

**Day** — local calendar midnight to midnight.

**Peak hour** — the 60-minute window within a day that moved the most bytes.

**Top speed** — the single highest instantaneous throughput reading in a day, with its timestamp.

**Attributed traffic** — bytes the collector can assign to a specific process.

**Unattributed traffic** — bytes counted by the adapter that no process was charged for (kernel, system, driver-level). Always part of the total; never invented into an app.

**Imported data** — history read once from Windows' SRUM database at install. Labelled as such; never treated as authoritative once the collector has its own records.
