# Narration script

Data Monitor is a small Windows app that lives in your taskbar. At a glance it shows how
fast data is moving in and out of your machine — and it answers the question Task Manager
never quite does: where did today's data go?

The readout is the whole point. A narrow strip sits in the taskbar, just left of your app
icons, showing something like down two hundred forty kilobits, up thirty-six megabits. You
don't click it to open it. It is simply there, part of the bar, and it disappears when the
bar hides.

Click it, and the dashboard opens. Four ranges: the last seven days, this week, the last
thirty days, or any month you choose. A daily chart, a ranking of which apps used the data,
and three honest numbers — the busiest day, the daily average, and the peak hour today.
Hover the readout instead, and a small card shows today's total and the top three apps.
That is the should I care answer, without opening anything.

Underneath, it is an Electron shell around Windows' own measurements. Live speed comes from
the Wi-Fi adapter's byte counters, sampled once a second. History comes from the same store
that powers Settings, Data usage — read without administrator rights. There is no account,
no sync, and no telemetry. The app talks to Windows, and to nothing else.

One detail worth knowing. On Windows 11 the taskbar is drawn as a single XAML surface, and
a window placed inside it simply does not paint — we measured that. So the readout is a
topmost overlay, positioned over the bar and re-raised above it. It looks embedded. It is
not. That distinction is the difference between a widget that works and one that silently
disappears.

Dark and light are both first class, following Windows by default, with a toggle in the
dashboard and in the tray.

And the limits are stated plainly. The current sampler is a stand-in. Per-app numbers are
Windows' daily aggregates rather than a live feed. And the installer is still to come. The
next step is a small elevated collector that reads the kernel's network events, so per-app
usage becomes live, and stored locally for ninety days.

That is Data Monitor: a number in the taskbar, and the story behind it.
