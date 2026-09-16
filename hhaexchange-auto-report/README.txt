HHAeXchange Maryland Daily Report — v0.7.0
==========================================

PURPOSE
-------
After YOU log in to the Maryland HHAeXchange portal, the extension automates:

  Report
  → Referral Patient Reports
  → Referral Patients By Status
  → Received From Date = today
  → Received To Date = today
  → All other filters left as All (status, office, source, etc.)
  → View Report   (does NOT click Generate Report)
  → Waits until the View window actually finishes drawing
  → Export Excel Open XML (.xlsx) from that View window — once

The downloaded file is renamed to:

  Report of MM-DD-YYYY.xlsx

Example: Report of 09-16-2026.xlsx

It does NOT store or automate your HHAeXchange username, password, or MFA code.
It does NOT upload report data anywhere.

WHAT'S NEW IN v0.7.0
--------------------
v0.6 could click Export more than once (watchdog + 8-second watcher +
every frame of the View window), so Chrome saved Report of … (1).xlsx,
(2).xlsx, etc. The green status bar also stayed on the report page
after the file was already in Downloads.

This version:
- Clicks Excel export once. Extra files are cancelled.
- Retries export only if Chrome never started a download (one retry).
- Exports from a single report frame, not every iframe at once.
- Removes the green overlay as soon as the download finishes.
  You can also click × on the overlay to dismiss it.
- Queues page commands so two “export” messages cannot overlap.

WHAT'S NEW IN v0.6.0
--------------------
Waits until the report pages are actually on screen before Excel.
Always asks for Excel Open XML (.xlsx).

WHAT'S NEW IN v0.5.0
--------------------
Never clicks Generate Report. Clicks View Report.

INSTALLATION
------------
1. Unzip the extension folder.
2. Open Chrome.
3. Go to chrome://extensions
4. Turn on Developer mode.
5. If an older version is already loaded (V3 / v0.3–v0.6), remove it first.
6. Click Load unpacked.
7. Select the folder named: hhaexchange-auto-report
8. Pin the extension if you want quick access.
9. Allow notifications if Chrome asks — that's how the download reminder appears.

HOW TO USE
----------
1. Log in manually to the Maryland HHAeXchange account (once per session).
2. Click the extension icon → "Pull today’s report".
   Or do nothing: on weekdays it starts itself at 4:50 PM.
3. Watch the View window open. The green bar counts seconds while the
   report draws, then Excel saves and the bar disappears.
4. When the file lands in Downloads, a reminder pops up.

If Chrome was closed at 4:50, you'll get a "missed pull" reminder the next
time Chrome opens so you can run it then.

If Chrome blocked the View window, allow popups for hhaexchange.com and retry.
