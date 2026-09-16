# HHAeXchange Maryland Daily Report

Chrome extension (Manifest V3) for the Maryland HHAeXchange portal.

**Latest download:** [v0.7.0 zip](https://github.com/bandhu-netizen/hhaexchange-maryland-daily-report/releases/download/v0.7.0/hhaexchange-daily-report-v0.7.0.zip)

## What it does

1. Sets **Received From Date** and **Received To Date** to today.
2. Leaves every other filter as **All**.
3. Clicks **View Report** (never Generate Report).
4. Waits until the View window finishes drawing.
5. Downloads **one** Excel Open XML (`.xlsx`) file named `Report of MM-DD-YYYY.xlsx`.
6. Clears the green on-page overlay when the file is saved.

It does not store your HHAeXchange password or MFA code.

## v0.7.0

- Stops duplicate Excel downloads (v0.6 could click Export several times).
- Extra files that still start are cancelled.
- Green status bar on the report page dismisses when the download finishes (or via ×).
- One retry only if Chrome never started a download.

## Install

1. Unzip the release.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Remove any older Maryland Daily Report (v0.3–v0.6).
4. **Load unpacked** → select the `hhaexchange-auto-report` folder.
5. Log in to Maryland HHAeXchange, then click **Pull today’s report** (or wait for the weekday 4:50 PM auto-pull).
