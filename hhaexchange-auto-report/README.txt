HHAeXchange Maryland Daily Report — v0.6.0
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
  → Export Excel Open XML (.xlsx) from that View window

The downloaded file is renamed to:

  Report of MM-DD-YYYY.xlsx

Example: Report of 09-15-2026.xlsx

It does NOT store or automate your HHAeXchange username, password, or MFA code.
It does NOT upload report data anywhere.

WHAT'S NEW IN v0.6.0
--------------------
v0.5 sometimes exported too early (a zip), sometimes hung, and sometimes
sat on the filter page for extra seconds.

This version:
- Waits until the report pages are actually on screen before Excel.
- Always asks for Excel Open XML (.xlsx). Zip packages from HHAeXchange
  are renamed to .xlsx (xlsx is a zip under the hood).
- Retries if the View window reloads or the download never starts.
- Times out with a clear message instead of hanging forever.
- Drops the extra 9-second wait on the filter page.

WHAT'S NEW IN v0.5.0
--------------------
Generate Report was too slow and it was hard to tell if anything was happening.
Never clicks Generate Report. Clicks View Report and brings that window forward.

INSTALLATION
------------
1. Unzip the extension folder.
2. Open Chrome.
3. Go to chrome://extensions
4. Turn on Developer mode.
5. If an older version is already loaded (V3 / v0.3–v0.5), remove it first.
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
   report draws, then Excel saves.
4. When the file lands in Downloads, a reminder pops up.

If Chrome was closed at 4:50, you'll get a "missed pull" reminder the next
time Chrome opens so you can run it then.

If Chrome blocked the View window, allow popups for hhaexchange.com and retry.
