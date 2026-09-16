/* global HHA_REPORT_CONFIG, chrome */
(() => {
  if (window.__HHA_REPORT_AUTOMATION_LOADED__) return;
  window.__HHA_REPORT_AUTOMATION_LOADED__ = true;

  let port = null;
  function ensurePort() {
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: "hha-automation" });
      port.onDisconnect.addListener(() => { port = null; });
    } catch (_) {
      port = null;
    }
    return port;
  }
  ensurePort();

  function sleep(ms) {
    ensurePort();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        chrome.runtime.sendMessage({ type: "HHA_SLEEP", ms }, () => {
          if (chrome.runtime.lastError) {
            setTimeout(done, ms);
            return;
          }
          done();
        });
      } catch (_) {
        setTimeout(done, ms);
      }
      setTimeout(done, Math.max(ms * 8, 2500));
    });
  }

  async function pageEval(op, args) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "HHA_PAGE_EVAL", op, args });
      return res?.result || { ok: false };
    } catch (_) {
      return { ok: false };
    }
  }

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/[\u2010-\u2015]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function waitFor(fn, timeoutMs = 10000, intervalMs = 50) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let done = false;
      let observer = null;

      const finish = (err, value) => {
        if (done) return;
        done = true;
        try { observer?.disconnect(); } catch (_) {}
        if (err) reject(err);
        else resolve(value);
      };

      const check = async () => {
        if (done) return;
        try {
          const result = await fn();
          if (result) return finish(null, result);
        } catch (_) {}
        if (Date.now() - started >= timeoutMs) {
          return finish(new Error("Timed out waiting for the HHAeXchange page element."));
        }
      };

      try {
        observer = new MutationObserver(() => { check(); });
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      } catch (_) {}

      const poll = async () => {
        await check();
        if (done) return;
        await sleep(intervalMs);
        if (!done) poll();
      };
      poll();
    });
  }

  function elementText(el) {
    return normalizeText(el.innerText || el.textContent || el.value || el.getAttribute?.("aria-label") || "");
  }

  function candidateElements() {
    return Array.from(document.querySelectorAll(
      "a, button, [role='menuitem'], [role='button'], input, label, li, td"
    ));
  }

  function findByExactText(text, { visibleOnly = true } = {}) {
    const wanted = normalizeText(text);
    const matches = candidateElements().filter((el) => {
      if (visibleOnly && !isVisible(el)) return false;
      return elementText(el) === wanted;
    });

    const score = (el) => {
      let s = 0;
      const tag = el.tagName;
      if (tag === "A" || tag === "BUTTON") s += 10;
      if (tag === "INPUT") s += 9;
      if (el.onclick) s += 5;
      if (el.getAttribute?.("role") === "menuitem") s += 4;
      if (isVisible(el)) s += 3;
      s -= Math.min(el.children?.length || 0, 5);
      return s;
    };

    matches.sort((a, b) => score(b) - score(a));
    return matches[0] || null;
  }

  function clickSmart(el) {
    if (!el) throw new Error("Cannot click a missing element.");
    try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch (_) {}
    for (const type of ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
      try {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch (_) {}
    }
    if (typeof el.click === "function") el.click();
    else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }

  function hoverSmart(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch (_) {}
    for (const type of ["pointerover", "mouseover", "mouseenter", "mousemove"]) {
      try {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch (_) {}
    }
  }

  function notify(type, payload = {}) {
    chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => {
      if (ch === "&") return "&#38;";
      if (ch === "<") return "&#60;";
      if (ch === ">") return "&#62;";
      if (ch === '"') return "&#34;";
      return "&#39;";
    });
  }

  let hudTimer = null;
  let hudHideTimer = null;
  let exportInFlight = false;
  let exportLocked = false;

  function stopHudTimer() {
    if (hudTimer) {
      clearInterval(hudTimer);
      hudTimer = null;
    }
    if (hudHideTimer) {
      clearTimeout(hudHideTimer);
      hudHideTimer = null;
    }
  }

  function hideHud() {
    stopHudTimer();
    const hud = document.getElementById("hha-md-hud");
    if (hud) hud.remove();
  }

  function showHud(title, detail, { tone = "running", sticky = true } = {}) {
    let hud = document.getElementById("hha-md-hud");
    if (!hud) {
      hud = document.createElement("div");
      hud.id = "hha-md-hud";
      hud.setAttribute("role", "status");
      (document.body || document.documentElement).appendChild(hud);
    }
    if (!document.getElementById("hha-md-hud-style")) {
      const st = document.createElement("style");
      st.id = "hha-md-hud-style";
      st.textContent = [
        "@keyframes hhaPulse{0%{box-shadow:0 0 0 0 rgba(197,227,207,.7)}70%{box-shadow:0 0 0 10px rgba(197,227,207,0)}100%{box-shadow:0 0 0 0 rgba(197,227,207,0)}}",
        "#hha-md-hud{position:fixed;z-index:2147483647;left:16px;right:16px;bottom:16px;max-width:540px;margin:0 auto;color:#f4f1ea;border-radius:12px;padding:14px 16px;box-shadow:0 12px 40px rgba(28,27,22,.28);font:650 13px/1.35 'Segoe UI',system-ui,sans-serif}",
        "#hha-md-hud-x{appearance:none;border:0;background:transparent;color:#d7e4db;font:700 18px/1 'Segoe UI',system-ui,sans-serif;cursor:pointer;padding:0 2px;margin-left:8px}"
      ].join("");
      (document.head || document.documentElement).appendChild(st);
    }
    const bg = tone === "error" ? "#8b3a2d" : "#2f4a3c";
    hud.style.background = bg;
    hud.style.pointerEvents = "auto";
    const pulse = tone === "running"
      ? 'animation:hhaPulse 1.4s infinite'
      : "animation:none";
    const dot = tone === "success" ? "#9fe7b4" : "#c5e3cf";
    hud.innerHTML =
      '<div style="display:flex;gap:10px;align-items:flex-start">' +
      '<span style="width:10px;height:10px;border-radius:50%;background:' + dot + ";margin-top:4px;flex:0 0 auto;" + pulse + '"></span>' +
      '<div style="flex:1;min-width:0"><div>' + escapeHtml(title) + "</div>" +
      (detail
        ? '<div style="margin-top:4px;font-weight:500;font-size:12px;color:#d7e4db">' + escapeHtml(detail) + "</div>"
        : "") +
      "</div>" +
      '<button type="button" id="hha-md-hud-x" aria-label="Dismiss">×</button>' +
      "</div>";
    const closeBtn = document.getElementById("hha-md-hud-x");
    if (closeBtn) {
      closeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideHud();
      });
    }
    if (hudHideTimer) {
      clearTimeout(hudHideTimer);
      hudHideTimer = null;
    }
    if (!sticky) {
      hudHideTimer = setTimeout(hideHud, 2200);
    }
  }

  function startHudTimer(title, detailBase) {
    stopHudTimer();
    const t0 = Date.now();
    const tick = () => {
      const s = Math.round((Date.now() - t0) / 1000);
      showHud(title, `${detailBase} (${s}s)`);
    };
    tick();
    hudTimer = setInterval(tick, 1000);
  }

  function todayParts(date = new Date()) {
    return {
      month: date.getMonth() + 1,
      day: date.getDate(),
      year: date.getFullYear(),
      date
    };
  }

  function formatHhaDate(date = new Date()) {
    const { month, day, year } = todayParts(date);
    return `${month}/${day}/${year}`;
  }

  function formatHhaDatePadded(date = new Date()) {
    const { month, day, year } = todayParts(date);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(month)}/${p(day)}/${year}`;
  }

  function parseDateValue(value) {
    const raw = String(value ?? "").trim();
    const m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (!m) return null;
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    return { month: Number(m[1]), day: Number(m[2]), year };
  }

  function valueIsToday(value, date = new Date()) {
    const parsed = parseDateValue(value);
    if (!parsed) return false;
    const t = todayParts(date);
    return parsed.month === t.month && parsed.day === t.day && parsed.year === t.year;
  }

  function looksLikeLoginPage() {
    if (document.querySelector("input[type='password']")) return true;
    const t = normalizeText(document.body?.innerText || "");
    return t.includes("forgot password") || (t.includes("sign in") && t.includes("password"));
  }

  function findReferralStatusHref() {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const hit = anchors.find((a) => /ReferralsByStatus/i.test(a.getAttribute("href") || "") || /ReferralsByStatus/i.test(a.href || ""));
    return hit?.href || null;
  }

  async function navigateToReferralStatusReport() {
    if (looksLikeLoginPage()) {
      throw new Error("Please log in to HHAeXchange first. You can stay on another tab after you’re in.");
    }

    notify("HHA_LOG", { message: "Opening Referral Patients By Status…" });
    showHud("Opening the report page", "Referral Patients By Status — then View Report, then Excel.");

    const href = findReferralStatusHref();
    if (href) {
      notify("HHA_LOG", { message: "Found the report link — opening it directly." });
      notify("HHA_ACTION_RESULT", { action: "NAVIGATE", success: true });
      window.location.href = href;
      return;
    }

    let finalItem = findByExactText("Referral Patients By Status", { visibleOnly: false });
    if (finalItem) {
      const itemHref = finalItem.getAttribute?.("href") || finalItem.href;
      notify("HHA_ACTION_RESULT", { action: "NAVIGATE", success: true });
      if (itemHref && /ReferralsByStatus/i.test(itemHref)) window.location.href = finalItem.href || itemHref;
      else clickSmart(finalItem);
      return;
    }

    const reportMenu = await waitFor(() => findByExactText("Report", { visibleOnly: true }), 8000, 40);
    clickSmart(reportMenu);

    const referralMenu = await waitFor(
      () => findByExactText("Referral Patient Reports", { visibleOnly: true }) ||
            findByExactText("Referral Patient Reports", { visibleOnly: false }),
      6000,
      40
    );
    hoverSmart(referralMenu);
    try { clickSmart(referralMenu); } catch (_) {}

    finalItem = await waitFor(
      () => findByExactText("Referral Patients By Status", { visibleOnly: true }) ||
            findByExactText("Referral Patients By Status", { visibleOnly: false }) ||
            document.querySelector("a[href*='ReferralsByStatus' i]"),
      6000,
      40
    );
    notify("HHA_ACTION_RESULT", { action: "NAVIGATE", success: true });
    const itemHref = finalItem.getAttribute?.("href") || finalItem.href;
    if (itemHref && /ReferralsByStatus/i.test(itemHref)) window.location.href = finalItem.href || itemHref;
    else clickSmart(finalItem);
  }

  function normalizeFieldLabel(value) {
    return normalizeText(value).replace(/:\s*$/, "");
  }

  function findFieldLabel(text) {
    const wanted = normalizeFieldLabel(text);
    const candidates = Array.from(document.querySelectorAll("label, span, td, th, div"))
      .filter((el) => isVisible(el) && normalizeFieldLabel(el.innerText || el.textContent || "") === wanted);

    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const areaA = ar.width * ar.height;
      const areaB = br.width * br.height;
      if (areaA !== areaB) return areaA - areaB;
      return (a.children?.length || 0) - (b.children?.length || 0);
    });
    return candidates[0] || null;
  }

  function dateInputCandidates() {
    return Array.from(document.querySelectorAll(
      "input.riTextBox, input[id*='date' i], input[name*='date' i], input[class*='date' i], input[type='text'], input:not([type])"
    )).filter((el) => {
      if (!isVisible(el)) return false;
      if (el.type && ["checkbox", "hidden", "button", "submit", "radio", "file"].includes(el.type)) return false;
      return true;
    });
  }

  function findDateInputNearLabel(labelText) {
    const aliases = [
      labelText,
      labelText.replace(/ Date$/i, ""),
      labelText.replace(/^Received /i, "")
    ];
    let label = null;
    for (const alias of aliases) {
      label = findFieldLabel(alias);
      if (label) break;
    }
    if (!label) return null;

    const labelRect = label.getBoundingClientRect();
    const row = label.closest("tr") || label.parentElement || document;
    const scoped = Array.from(row.querySelectorAll?.("input") || []).filter(isVisible);
    const pool = scoped.length ? scoped : dateInputCandidates();

    const ranked = pool
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => {
        const centerDelta = Math.abs((rect.top + rect.bottom) / 2 - (labelRect.top + labelRect.bottom) / 2);
        return rect.left >= labelRect.left - 4 && centerDelta <= Math.max(24, labelRect.height * 1.8);
      })
      .sort((a, b) => {
        const aRight = a.rect.left >= labelRect.right - 8 ? 0 : 1;
        const bRight = b.rect.left >= labelRect.right - 8 ? 0 : 1;
        if (aRight !== bRight) return aRight - bRight;
        return a.rect.left - b.rect.left;
      });

    return ranked[0]?.el || null;
  }

  function findDateInputByMeta(needles) {
    const wanted = needles.map(normalizeText);
    for (const input of dateInputCandidates()) {
      const meta = normalizeText(`${input.id} ${input.name} ${input.getAttribute("aria-label") || ""} ${input.title || ""}`);
      if (wanted.every((n) => meta.includes(n))) return input;
    }
    return null;
  }

  function locateReceivedDateInput(which) {
    const label = which === "from" ? "Received From Date" : "Received To Date";
    return (
      findDateInputNearLabel(label) ||
      findDateInputByMeta(which === "from" ? ["received", "from"] : ["received", "to"]) ||
      findDateInputByMeta(which === "from" ? ["fromdate"] : ["todate"])
    );
  }

  function pickerIdFor(input) {
    const picker = input.closest?.(".RadPicker, .RadDatePicker, [class*='RadPicker']");
    return picker?.id || input.id || null;
  }

  function dispatchDateEvents(input, formatted) {
    try { input.focus(); } catch (_) {}
    try { input.select?.(); } catch (_) {}
    try {
      const proto = window.HTMLInputElement?.prototype;
      const nativeSet = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (nativeSet) nativeSet.call(input, formatted);
      else input.value = formatted;
    } catch (_) {
      input.value = formatted;
    }
    for (const type of ["input", "change"]) {
      try { input.dispatchEvent(new Event(type, { bubbles: true })); } catch (_) {}
    }
    try {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    } catch (_) {}
    try { input.blur(); } catch (_) {}
    try { input.dispatchEvent(new Event("blur", { bubbles: true })); } catch (_) {}
  }

  async function pickTodayInCalendar(input) {
    const picker = input.closest(".RadPicker, .RadDatePicker, [class*='RadPicker']") || input.parentElement;
    const calBtn = picker?.querySelector?.(
      ".rcCalPopup, a.rcCalPopup, [class*='CalPopup'], a[title*='Open the calendar' i], button[aria-label*='calendar' i]"
    );
    if (!calBtn) return false;
    clickSmart(calBtn);
    const todayCell = await waitFor(() => (
      document.querySelector(".rcToday a, td.rcToday a, .rcToday, [class*='rcToday'] a") ||
      Array.from(document.querySelectorAll("td a, td")).find((el) => {
        if (!isVisible(el)) return false;
        const cls = normalizeText(el.className + " " + (el.parentElement?.className || ""));
        return cls.includes("today");
      })
    ), 1500, 40).catch(() => null);
    if (!todayCell || !isVisible(todayCell)) return false;
    clickSmart(todayCell);
    return true;
  }

  async function setReceivedDate(which, date = new Date()) {
    const label = which === "from" ? "Received From Date" : "Received To Date";
    const input = await waitFor(() => locateReceivedDateInput(which), 8000, 40);
    if (valueIsToday(input.value, date)) return input;

    const unpadded = formatHhaDate(date);
    const padded = formatHhaDatePadded(date);
    const id = pickerIdFor(input);

    if (id) {
      const api = await pageEval("telerikSetDate", { id, timestamp: date.getTime() });
      if (api?.ok) {
        await sleep(80);
        if (valueIsToday(input.value, date)) return input;
      }
    }

    dispatchDateEvents(input, unpadded);
    await sleep(50);
    if (valueIsToday(input.value, date)) return input;

    dispatchDateEvents(input, padded);
    await sleep(50);
    if (valueIsToday(input.value, date)) return input;

    const picked = await pickTodayInCalendar(input);
    await sleep(50);
    if (picked && valueIsToday(input.value, date)) return input;

    throw new Error(
      `Could not set ${label} to ${unpadded}. The field currently shows "${input.value || "(empty)"}".`
    );
  }

  function findActionButton(label) {
    const wanted = normalizeText(label);
    return (
      findByExactText(label, { visibleOnly: true }) ||
      Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button, a'))
        .find((el) => isVisible(el) && normalizeText(el.value || el.innerText || el.textContent) === wanted) ||
      null
    );
  }

  function isFilterPage() {
    return Boolean(findActionButton("Generate Report") || findActionButton("View Report"));
  }

  function reportViewerPresent() {
    return Boolean(document.querySelector(
      "iframe[src*='ReportViewer' i], iframe[id*='ReportViewer' i], [id*='ReportViewerControl' i], [id*='ReportViewer' i] table, [id*='ReportViewer'] iframe"
    ));
  }

  function findViewTab() {
    const nodes = Array.from(document.querySelectorAll(
      "a, li, span, [role='tab'], .rtsLink, .rtsTxt, .rtsLevel a, .ajax__tab_tab, .ajax__tab_inner, .ajax__tab_outer"
    )).filter(isVisible);

    let best = null;
    let bestScore = 0;
    for (const el of nodes) {
      const t = elementText(el);
      if (!t || t.length > 20) continue;
      if (t === "view report" || t === "generate report") continue;
      let s = 0;
      if (t === "view") s = 100;
      else if (t === "report view") s = 80;
      if (!s) continue;
      const cls = normalizeText(`${el.className || ""} ${el.getAttribute?.("role") || ""}`);
      if (cls.includes("tab") || cls.includes("rts") || el.getAttribute?.("role") === "tab") s += 16;
      if (s > bestScore) {
        bestScore = s;
        best = el.closest("a, li, [role='tab']") || el;
      }
    }
    return best;
  }

  async function applyTodayDates(date = new Date()) {
    const display = formatHhaDate(date);
    const api = await pageEval("setReceivedDatesToday", { timestamp: date.getTime() });
    notify("HHA_LOG", {
      message: `Setting Received From/To to ${display}. HHAeXchange returned From="${api.from || "?"}" To="${api.to || "?"}".`
    });
    await sleep(120);

    const fromInput = await setReceivedDate("from", date);
    const toInput = await setReceivedDate("to", date);

    if (!valueIsToday(fromInput.value, date) || !valueIsToday(toInput.value, date)) {
      throw new Error(
        `Dates did not stick before View Report. From="${fromInput.value}" To="${toInput.value}". Need ${display}.`
      );
    }

    notify("HHA_LOG", {
      message: `Received From Date: ${fromInput.value} · Received To Date: ${toInput.value}. Other filters stay All.`
    });
    showHud("Dates set to today", `${fromInput.value} → ${toInput.value}. Next: View Report (Generate is skipped).`);
    return { fromInput, toInput };
  }

  async function clickViewReport() {
    if (findActionButton("Generate Report") && !findActionButton("View Report")) {
      throw new Error("This page only has Generate Report. Need the View Report button on Referrals By Status.");
    }

    const viewReport = await waitFor(
      () => findActionButton("View Report"),
      8000,
      40
    ).catch(() => null);

    if (!viewReport) {
      const viewTab = findViewTab();
      if (viewTab) {
        window.__HHA_VIEW_CLICKED__ = true;
        notify("HHA_ACTION_RESULT", { action: "CONFIGURE_AND_VIEW", success: true });
        showHud("Opening the View tab", "Skipping Generate Report. Excel downloads from this view.");
        clickSmart(viewTab);
        return "same-page-viewer";
      }
      throw new Error("Could not find View Report on the Referrals By Status page.");
    }

    window.__HHA_VIEW_CLICKED__ = true;
    startHudTimer(
      "Opening View Report",
      "Generate Report is not used. Watch for the View window"
    );
    notify("HHA_ACTION_RESULT", { action: "CONFIGURE_AND_VIEW", success: true });
    notify("HHA_LOG", { message: "Clicking View Report. Generate Report will not be clicked." });
    await sleep(60);

    const api = await pageEval("clickViewReport");
    if (!api?.ok) clickSmart(viewReport);

    const started = Date.now();
    while (Date.now() - started < 2200) {
      if (reportViewerPresent() || findExportControl() || reportLooksRendered()) {
        stopHudTimer();
        return "same-page-viewer";
      }
      if (!isFilterPage()) {
        stopHudTimer();
        return "same-page-viewer";
      }
      await sleep(150);
    }

    startHudTimer(
      "Waiting for the View window",
      "View Report was clicked. Excel saves after that window finishes drawing the report"
    );
    notify("HHA_LOG", {
      message: "View Report was clicked. Waiting for the report window. Generate Report was not used."
    });
    return "new-tab-viewer";
  }

  async function configureReport(stateKey) {
    const cfg = HHA_REPORT_CONFIG[stateKey];
    if (!cfg) throw new Error(`Unknown state configuration: ${stateKey}`);

    const today = new Date();
    showHud(`Configuring ${cfg.label}`, `Received From/To = ${formatHhaDate(today)}. Then View Report → Excel.`);
    notify("HHA_LOG", {
      message: `Configuring ${cfg.label}: Received From/To = ${formatHhaDate(today)}. Clicking View Report, not Generate.`
    });

    await waitFor(() => document.body && normalizeText(document.body.innerText).includes("referrals by status"), 12000, 50);

    await applyTodayDates(today);
    await sleep(220);

    const mode = await clickViewReport().catch((error) => {
      notify("HHA_LOG", { message: `View Report is opening (${error?.message || "page is navigating"})…` });
      return "navigating";
    });

    if (mode === "same-page-viewer") {
      notify("HHA_LOG", { message: "Report is visible on this page. Downloading Excel from the viewer…" });
      await exportExcel();
    }
  }

  async function afterView({ allowClickView = false } = {}) {
    if (exportLocked) return;
    const viewTab = findViewTab();
    if (viewTab && !reportViewerPresent() && !findExportControl()) {
      showHud("Selecting the View tab", "Opening the report view, then Excel.");
      clickSmart(viewTab);
      await sleep(500);
    }

    if (reportViewerPresent() || findExportControl() || reportLooksRendered()) {
      await exportExcel();
      return;
    }

    const today = new Date();
    if (isFilterPage()) {
      const from = locateReceivedDateInput("from");
      const to = locateReceivedDateInput("to");
      if (from && to && (!valueIsToday(from.value, today) || !valueIsToday(to.value, today))) {
        await applyTodayDates(today);
      }
      if (allowClickView && findActionButton("View Report") && !window.__HHA_VIEW_CLICKED__) {
        await clickViewReport();
        return;
      }
      startHudTimer(
        "Waiting for the View window",
        "View Report was clicked. Excel downloads from that report view — Generate Report is not used"
      );
      notify("HHA_LOG", { message: "Filter page still open. Waiting for the View Report window…" });
      return;
    }

    await exportExcel();
  }

  function findExportControl() {
    const selectors = [
      '[title*="Export" i]',
      '[aria-label*="Export" i]',
      'img[alt*="Export" i]',
      'img[src*="export" i]',
      'img[src*="Save.gif" i]',
      'img[src*="Icons.Save" i]',
      'input[type="image"][alt*="Export" i]',
      'input[type="image"][title*="Export" i]',
      'a[id*="Export" i]',
      'button[id*="Export" i]',
      '[title="Export drop down menu" i]'
    ];
    for (const selector of selectors) {
      const el = Array.from(document.querySelectorAll(selector)).find(isVisible);
      if (el) return el.closest("a,button,input") || el;
    }

    const imgs = Array.from(document.querySelectorAll("img")).filter(isVisible);
    for (const img of imgs) {
      const meta = normalizeText(`${img.title} ${img.alt} ${img.src}`);
      if (meta.includes("export") || meta.includes("save.gif") || (meta.includes("save") && meta.includes("icon"))) {
        return img.closest("a,button,td,div") || img;
      }
    }
    return null;
  }

  function exportControlIsEnabled(el) {
    if (!el || !isVisible(el)) return false;
    const clickable = el.closest?.("a,button,input,td") || el;
    if (clickable.disabled) return false;
    if (normalizeText(clickable.getAttribute?.("aria-disabled")) === "true") return false;
    const cls = normalizeText(clickable.className || "");
    if (cls.includes("disabled")) return false;
    return true;
  }

  function reportLooksRendered() {
    if (isFilterPage() && !reportViewerPresent()) return false;
    if (!document.body) return false;
    const text = normalizeText(document.body.innerText || "");
    const hasReportTitle = text.includes("referrals by status");
    const hasPageCount =
      /\bpage\s+\d+\s+of\s+\d+\b/i.test(document.body.innerText || "") ||
      /\b\d+\s+of\s+\d+\b/i.test(document.body.innerText || "");
    const hasReportDate = text.includes("report date");
    return hasReportTitle && (hasPageCount || hasReportDate);
  }

  function reportViewerIsWaiting() {
    const wait = document.querySelector("[id$='AsyncWait_Wait'], [id*='AsyncWait'], .WaitControl");
    return Boolean(wait && isVisible(wait));
  }

  async function waitForExportReady(timeoutMs = 360000) {
    const started = Date.now();
    let lastProgressAt = 0;
    let stableSince = 0;

    while (Date.now() - started < timeoutMs) {
      if (isFilterPage() && !reportViewerPresent() && !findExportControl()) {
        stableSince = 0;
        await sleep(250);
        continue;
      }

      const state = await pageEval("reportViewerState");
      const loading = reportViewerIsWaiting() || Boolean(state?.loading);
      const exportControl = findExportControl();
      const pages = Number(state?.totalPages || 0);
      const rendered = Boolean(state?.rendered) || reportLooksRendered() || pages > 0;
      const hasViewer = Boolean(state?.hasViewer) || Boolean(state?.hasExport) || reportViewerPresent() || Boolean(exportControl);
      const toolbarReady = Boolean(exportControl && exportControlIsEnabled(exportControl)) || Boolean(state?.exportEnabled);
      const ready = hasViewer && !loading && rendered;

      if (ready) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 1100) {
          return { exportControl, apiReady: Boolean(state?.hasViewer), state };
        }
      } else {
        stableSince = 0;
      }

      if (!loading && toolbarReady && Date.now() - started >= 45000 && !rendered) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 1600) {
          return { exportControl, apiReady: Boolean(state?.hasViewer), state, fallback: true };
        }
      }

      if (Date.now() - lastProgressAt >= 3000) {
        const elapsed = Math.round((Date.now() - started) / 1000);
        const msg = loading || (hasViewer && !rendered)
          ? `Report is still drawing (${elapsed}s). Excel waits until pages are on screen so you don’t get a zip.`
          : !hasViewer
            ? `Waiting for the View window toolbar (${elapsed}s)…`
            : `View window is open. Confirming the report finished (${elapsed}s)…`;
        showHud("Waiting for the report to finish", msg);
        notify("HHA_LOG", { message: msg });
        lastProgressAt = Date.now();
      }

      await sleep(200);
    }

    throw new Error(
      "The View window did not finish drawing the report. Leave that window open until you see page numbers, then retry."
    );
  }

  function findExcelOption() {
    const nodes = candidateElements().filter(isVisible);
    const scored = [];
    for (const el of nodes) {
      const t = elementText(el);
      if (!t || t.length > 48) continue;
      if (/\b(pdf|word|csv|tiff|mhtml|xml file|web archive)\b/.test(t) && !t.includes("excel")) continue;
      if (t === "xml" || t === "zip") continue;
      let s = 0;
      if (t === "excel open xml" || t === "excel (open xml)" || t === "excelopenxml") s = 110;
      else if (t === "excel" || t === "excel worksheet") s = 100;
      else if (t.includes("xlsx")) s = 95;
      else if (t === "excel 97-2003" || t.includes("excel 97") || t.includes("excel 2003")) s = 20;
      else if (t.startsWith("excel")) s = 70;
      if (s) {
        const tag = el.tagName;
        if (tag === "A" || tag === "BUTTON" || tag === "TD" || el.getAttribute?.("role") === "menuitem") s += 8;
        scored.push({ el, s });
      }
    }
    scored.sort((a, b) => b.s - a.s);
    return scored[0]?.el || null;
  }

  async function triggerExcelOnce() {
    const api = await pageEval("exportExcel");
    if (api?.ok) return { ok: true, via: "api", format: api.format };
    if (api?.error && /being updated|no report loaded|loading/i.test(String(api.error))) {
      return { ok: false, error: api.error, retry: true };
    }

    await pageEval("clickExportExcel", { step: "export" });
    await sleep(500);
    const menu = await pageEval("clickExportExcel", { step: "excel" });
    if (menu?.ok) return { ok: true, via: menu.via || "menu", format: menu.format };

    const exportControl = findExportControl();
    if (exportControl && exportControlIsEnabled(exportControl)) {
      clickSmart(exportControl);
      let excel = null;
      try {
        excel = await waitFor(() => findExcelOption(), 6000, 40);
      } catch (_) {
        const retryControl = findExportControl();
        if (retryControl) clickSmart(retryControl);
        excel = await waitFor(() => findExcelOption(), 8000, 50);
      }
      if (!excel) return { ok: false, error: "Excel was not in the Export menu." };
      clickSmart(excel);
      return { ok: true, via: "dom" };
    }
    return { ok: false, error: api?.error || "Export control was not ready." };
  }

  async function exportExcel({ force = false } = {}) {
    if (exportInFlight) return;
    if (exportLocked && !force) return;
    if (isFilterPage() && !reportViewerPresent() && !findExportControl()) {
      notify("HHA_LOG", { message: "Still on the filter page — waiting for the View window before Excel." });
      return;
    }

    exportInFlight = true;
    try {
      notify("HHA_LOG", {
        message: "View window is open. Waiting until the report finishes drawing, then saving Excel (not zip)…"
      });
      startHudTimer("Waiting for the report to finish", "Excel starts only after pages are visible — that stops the empty zip");

      await waitFor(() => document.body, 30000, 50);
      const ready = await waitForExportReady(360000);
      stopHudTimer();

      if (ready?.fallback) {
        notify("HHA_LOG", { message: "Toolbar is ready. Exporting Excel now…" });
      }

      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (exportLocked && !force) return;
        showHud(
          "Saving Excel from the View window",
          attempt === 1 ? "Exporting Excel Open XML (.xlsx)." : `Retry ${attempt} of 3 — still saving Excel, not zip.`
        );
        try {
          const result = await triggerExcelOnce();
          if (result.ok) {
            exportLocked = true;
            notify("HHA_LOG", { message: `Excel export started (${result.format || "xlsx"} via ${result.via}).` });
            notify("HHA_ACTION_RESULT", { action: "EXPORT_EXCEL", success: true });
            showHud(
              "Saving one Excel file",
              "This bar closes when the download finishes."
            );
            return;
          }
          lastErr = result.error || "export did not take";
          if (result.retry) await sleep(1600);
        } catch (e) {
          lastErr = e?.message || String(e);
        }
        await sleep(1600);
      }
      throw new Error(lastErr || "Could not start Excel from the View window toolbar.");
    } finally {
      exportInFlight = false;
    }
  }

  function resetExportLocks() {
    exportInFlight = false;
    exportLocked = false;
    window.__HHA_VIEW_CLICKED__ = false;
  }

  function onRunFinished(message = {}) {
    resetExportLocks();
    if (message.success) {
      const detail = message.savedAs
        ? `${message.savedAs} is in Downloads.`
        : (message.message || "Excel is in your Downloads folder.");
      showHud("Report saved", detail, { tone: "success", sticky: false });
    } else {
      hideHud();
    }
  }

  async function handle(message) {
    try {
      if (message.type === "HHA_NAVIGATE") {
        await navigateToReferralStatusReport();
      } else if (message.type === "HHA_CONFIGURE_REPORT") {
        await configureReport(message.state);
      } else if (message.type === "HHA_AFTER_VIEW" || message.type === "HHA_AFTER_GENERATE") {
        if (exportLocked) return;
        await afterView({ allowClickView: false });
      } else if (message.type === "HHA_EXPORT_EXCEL" || message.type === "HHA_EXPORT_CSV") {
        await exportExcel({ force: Boolean(message.force) });
      }
    } catch (error) {
      notify("HHA_ACTION_RESULT", {
        action: message.type,
        success: false,
        error: error?.message || String(error)
      });
    }
  }

  let handleChain = Promise.resolve();
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type?.startsWith("HHA_")) return;
    if (message.type === "HHA_PING") {
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "HHA_RUN_FINISHED") {
      onRunFinished(message);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "HHA_RUN_START") {
      resetExportLocks();
      sendResponse({ ok: true });
      return;
    }
    handleChain = handleChain.then(() => handle(message)).catch(() => {});
  });

  try {
    chrome.storage.onChanged.addListener((changes) => {
      if (!changes.hhaActiveRun) return;
      const prev = changes.hhaActiveRun.oldValue;
      const next = changes.hhaActiveRun.newValue;
      if (prev && !next) {
        resetExportLocks();
        const hud = document.getElementById("hha-md-hud");
        if (!hud) return;
        chrome.storage.local.get("hhaLastRun", (stored) => {
          const last = stored.hhaLastRun;
          if (last?.success) {
            onRunFinished({
              success: true,
              savedAs: last.savedAs,
              message: last.statusMessage
            });
          } else {
            hideHud();
          }
        });
      }
    });
  } catch (_) {}
})();
