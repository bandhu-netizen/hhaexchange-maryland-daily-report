/* global chrome */
importScripts("config.js");

const RUN_KEY = "hhaActiveRun";
const LAST_KEY = "hhaLastRun";
const RENAME_KEY = "hhaPendingRename";
const SETTINGS_KEY = "hhaSettings";
const PORTAL_KEY = "hhaLastPortalUrl";
const ALARM_NAME = "hhaDailyPull";
const WATCH_ALARM = "hhaRunWatch";
const DEFAULT_PORTAL = "https://app.hhaexchange.com/";

const DEFAULT_SETTINGS = {
  scheduleEnabled: true,
  hour: 16,
  minute: 50,
  weekdaysOnly: true
};

let activeRun = null;
const watchedDownloads = new Map();
const ports = new Set();
let downloadWatchdog = null;
let heartbeatTimer = null;
let renameState = { enabled: false, base: "", startedAt: 0 };
let exportRetryCount = 0;
let acceptedDownloadId = null;
const exportSentTabs = new Set();
let runSucceeded = false;

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (!activeRun) {
      stopHeartbeat();
      return;
    }
    const elapsed = Math.round((Date.now() - activeRun.startedAt) / 1000);
    if (activeRun.stage === "waitingViewer") {
      await log(`View Report window is open — you should see the report loading (${elapsed}s). Excel downloads from there, not Generate Report.`);
    } else if (activeRun.stage === "exporting") {
      await log(`Report view is on screen. Exporting Excel (${elapsed}s)…`);
    }
  }, 5000);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function filenameDate(date = new Date()) {
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${date.getFullYear()}`;
}

function reportFilename(ext = "xlsx") {
  return `Report of ${filenameDate()}.${ext}`;
}

function isHhaUrl(url = "") {
  try {
    const u = new URL(url);
    return u.hostname === "hhaexchange.com" || u.hostname.endsWith(".hhaexchange.com");
  } catch (_) {
    return false;
  }
}

function looksLikeLoginUrl(url = "") {
  return /login|signin|sign-in|sso|auth/i.test(url);
}

function looksLikeViewerUrl(url = "") {
  if (/UserDataXML=/i.test(url)) return true;
  if (/ReportViewerWebControl|Reserved\.ReportViewer/i.test(url)) return true;
  if (/\/ReportViewer/i.test(url)) return true;
  if (/ViewReport|ShowReport|ReportRender|Reserved\.Report/i.test(url)) return true;
  if (/\/Reports\.aspx/i.test(url) && !/ReferralsByStatus/i.test(url)) return true;
  return false;
}

function pageKind(url = "") {
  if (/\/ReferralsByStatus_[^/]*\.aspx/i.test(url) || /\/ReferralsByStatus[^/]*\.aspx/i.test(url)) return "setup";
  if (looksLikeViewerUrl(url)) return "viewer";
  if (looksLikeLoginUrl(url)) return "login";
  return "portal";
}

function downloadLooksLikeReport(item = {}) {
  const url = item.url || "";
  const filename = item.filename || item.finalUrl || "";
  const mime = item.mime || "";
  if (isHhaUrl(url) || isHhaUrl(item.referrer || "")) return true;
  if (/ReportViewerWebControl|Reserved\.ReportViewer|ReferralsByStatus/i.test(url)) return true;
  if (/ReferralsByStatus|Referrals By Status|Report of /i.test(filename)) return true;
  if (/\.(xlsx|xls|zip)$/i.test(filename) && /report|excel|spreadsheet/i.test(filename + " " + mime)) return true;
  return false;
}

function extensionFromDownload(item = {}) {
  const name = item.filename || "";
  const mime = item.mime || "";
  if (/\.zip$/i.test(name) && (isHhaUrl(item.url || "") || isHhaUrl(item.referrer || "") || /ReportViewer/i.test(item.url || ""))) {
    return "xlsx";
  }
  if (/\.xlsx$/i.test(name) || /spreadsheetml|openxmlformats/i.test(mime)) return "xlsx";
  if (/\.xls$/i.test(name) || /application\/vnd\.ms-excel/i.test(mime)) return "xls";
  if (/\.csv$/i.test(name) || /text\/csv/i.test(mime)) return "csv";
  if (/\.pdf$/i.test(name)) return "pdf";
  if (/zip/i.test(mime) && isHhaUrl(item.url || "")) return "xlsx";
  return "xlsx";
}

function sameLocalDay(ts, date = new Date()) {
  if (!ts) return false;
  const d = new Date(ts);
  return d.getFullYear() === date.getFullYear() && d.getMonth() === date.getMonth() && d.getDate() === date.getDate();
}

function formatClock(hour, minute) {
  const h = ((hour + 11) % 12) + 1;
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${h}:${pad(minute)} ${suffix}`;
}

function weekdayName(date) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
}

function nextWeekdayFire(hour, minute, weekdaysOnly = true, from = new Date()) {
  const next = new Date(from.getTime());
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime() + 15000) {
    next.setDate(next.getDate() + 1);
  }
  if (weekdaysOnly) {
    while (next.getDay() === 0 || next.getDay() === 6) {
      next.setDate(next.getDate() + 1);
    }
  }
  return next;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  await scheduleNextAlarm();
  return next;
}

async function saveRun() {
  if (activeRun) await chrome.storage.local.set({ [RUN_KEY]: activeRun });
  else await chrome.storage.local.remove(RUN_KEY);
}

async function setPendingRename(enabled) {
  if (enabled) {
    renameState = {
      enabled: true,
      startedAt: Date.now(),
      base: `Report of ${filenameDate()}`
    };
    await chrome.storage.local.set({ [RENAME_KEY]: renameState });
  } else {
    renameState = { enabled: false, base: "", startedAt: 0 };
    await chrome.storage.local.remove(RENAME_KEY);
  }
}

async function pendingRename() {
  if (renameState?.enabled && Date.now() - renameState.startedAt <= 20 * 60 * 1000) {
    return renameState;
  }
  const stored = await chrome.storage.local.get(RENAME_KEY);
  const pending = stored[RENAME_KEY];
  if (!pending?.enabled) return null;
  if (Date.now() - pending.startedAt > 20 * 60 * 1000) {
    await setPendingRename(false);
    return null;
  }
  renameState = pending;
  return pending;
}

async function rememberPortal(url) {
  if (!isHhaUrl(url) || looksLikeLoginUrl(url)) return;
  try {
    const origin = new URL(url).origin + "/";
    await chrome.storage.local.set({ [PORTAL_KEY]: origin });
  } catch (_) {}
}

async function lastPortalUrl() {
  const stored = await chrome.storage.local.get(PORTAL_KEY);
  return stored[PORTAL_KEY] || DEFAULT_PORTAL;
}

async function log(message, level = "info") {
  if (!activeRun) return;
  activeRun.logs = activeRun.logs || [];
  activeRun.logs.push({ at: new Date().toISOString(), level, message });
  activeRun.logs = activeRun.logs.slice(-40);
  activeRun.statusMessage = message;
  await saveRun();
}

async function setBadge(text, color = "#2f4a3c") {
  try {
    await chrome.action.setBadgeText({ text: text || "" });
    if (text) await chrome.action.setBadgeBackgroundColor({ color });
  } catch (_) {}
}

async function notifyUser({ id, title, message, buttons }) {
  const opts = {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
    priority: 2,
    requireInteraction: true,
    silent: false
  };
  if (buttons?.length) opts.buttons = buttons;
  try {
    await chrome.notifications.create(id || `hha-${Date.now()}`, opts);
  } catch (_) {
    try {
      delete opts.buttons;
      await chrome.notifications.create(id || `hha-${Date.now()}`, opts);
    } catch (__) {}
  }
}

async function finish(success, message) {
  if (!activeRun) return;
  const trackedIds = Array.from(activeRun.trackedTabIds || []);
  const savedAs = activeRun.savedAs;
  stopHeartbeat();
  exportRetryCount = 0;
  try { await chrome.alarms.clear(WATCH_ALARM); } catch (_) {}
  if (downloadWatchdog) {
    clearTimeout(downloadWatchdog);
    downloadWatchdog = null;
  }
  const completed = {
    ...activeRun,
    success,
    status: success ? "complete" : "error",
    statusMessage: message,
    completedAt: Date.now()
  };
  await chrome.storage.local.set({ [LAST_KEY]: completed });
  activeRun = null;
  await saveRun();
  await broadcastRunFinished({
    success,
    message,
    savedAs,
    tabIds: trackedIds
  });
  if (!success) {
    await setPendingRename(false);
    await setBadge("!", "#8b3a2d");
  } else {
    await setBadge("✓", "#2f4a3c");
  }
}

async function broadcastRunFinished({ success, message, savedAs, tabIds = [] }) {
  const payload = {
    type: "HHA_RUN_FINISHED",
    success: Boolean(success),
    message: message || "",
    savedAs: savedAs || ""
  };
  const tabs = await chrome.tabs.query({ url: ["*://*.hhaexchange.com/*", "*://hhaexchange.com/*"] }).catch(() => []);
  const ids = new Set([
    ...tabIds.filter(Boolean),
    ...tabs.map((t) => t.id).filter(Boolean)
  ]);
  for (const id of ids) {
    try { await chrome.tabs.sendMessage(id, payload); } catch (_) {}
  }
}

function pageEvalMain(op, args) {
  const $find = window.$find;
  const pad = (n) => String(n).padStart(2, "0");

  function dateParts(d) {
    return {
      display: `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`,
      padded: `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`,
      validationText: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-00-00-00`
    };
  }

  function applyClientState(el, d) {
    if (!el || el.type !== "hidden") return;
    const { display, validationText } = dateParts(d);
    try {
      const json = el.value ? JSON.parse(el.value) : {};
      json.validationText = validationText;
      json.valueAsString = validationText;
      json.lastSetTextBoxValue = display;
      el.value = JSON.stringify(json);
    } catch (_) {
      el.value = JSON.stringify({
        enabled: true,
        emptyMessage: "",
        validationText,
        valueAsString: validationText,
        lastSetTextBoxValue: display
      });
    }
  }

  function applyWidget(widget, d) {
    if (!widget) return false;
    const { display } = dateParts(d);
    try {
      if (widget.set_selectedDate) widget.set_selectedDate(d);
      const di = widget.get_dateInput && widget.get_dateInput();
      if (di) {
        if (di.set_selectedDate) di.set_selectedDate(d);
        if (di.set_value) di.set_value(display);
        if (di.set_text) di.set_text(display);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function setInputDate(input, d) {
    if (!input) return { ok: false };
    const { display } = dateParts(d);
    let widgetOk = false;
    const picker = input.closest && input.closest(".RadPicker, .RadDatePicker, [class*='RadPicker']");
    if ($find) {
      widgetOk = applyWidget($find(input.id), d) || widgetOk;
      if (picker && picker.id) widgetOk = applyWidget($find(picker.id), d) || widgetOk;
    }
    const scope = picker || input.parentElement || document;
    const hiddens = scope.querySelectorAll
      ? scope.querySelectorAll("input[type='hidden']")
      : [];
    for (let i = 0; i < hiddens.length; i += 1) {
      const hid = hiddens[i];
      if (/ClientState|dateInput|Date/i.test(hid.id || hid.name || "")) applyClientState(hid, d);
    }
    try {
      const proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
      const nativeSet = proto && Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
      if (nativeSet) nativeSet.call(input, display);
      else input.value = display;
    } catch (_) {
      input.value = display;
    }
    try { input.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) {}
    try { input.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}
    return { ok: true, widgetOk, value: input.value };
  }

  function labelText(el) {
    return String(el.innerText || el.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/:\s*$/, "")
      .toLowerCase();
  }

  function findLabeledDateInput(wanted) {
    const nodes = Array.from(document.querySelectorAll("label, td, th, span, div"));
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i];
      if (labelText(n) !== wanted) continue;
      const row = n.closest("tr") || n.parentElement;
      if (!row) continue;
      const inputs = Array.from(row.querySelectorAll("input.riTextBox, input[type='text'], input:not([type])"))
        .filter((el) => el.type !== "hidden" && el.type !== "checkbox" && el.type !== "button" && el.type !== "submit");
      if (!inputs.length) continue;
      const nRect = n.getBoundingClientRect ? n.getBoundingClientRect() : { left: 0 };
      inputs.sort((a, b) => {
        const ar = a.getBoundingClientRect ? a.getBoundingClientRect().left : 0;
        const br = b.getBoundingClientRect ? b.getBoundingClientRect().left : 0;
        return Math.abs(ar - nRect.left) - Math.abs(br - nRect.left);
      });
      return inputs[0];
    }
    return null;
  }

  if (op === "telerikSetDate") {
    const id = args && args.id;
    const d = new Date(args && args.timestamp);
    const input = (id && document.getElementById(id)) || null;
    if (!input) return { ok: false, error: "no input" };
    return setInputDate(input, d);
  }

  if (op === "setReceivedDatesToday") {
    const d = new Date(args && args.timestamp);
    const fromInput =
      findLabeledDateInput("received from date") ||
      findLabeledDateInput("received from");
    const toInput =
      findLabeledDateInput("received to date") ||
      findLabeledDateInput("received to");
    const from = setInputDate(fromInput, d);
    const to = setInputDate(toInput, d);
    return {
      ok: Boolean(from.ok && to.ok),
      from: from.value || (fromInput && fromInput.value) || "",
      to: to.value || (toInput && toInput.value) || "",
      fromFound: Boolean(fromInput),
      toFound: Boolean(toInput)
    };
  }

  if (op === "exportExcel") {
    const formats = ["EXCELOPENXML", "ExcelOpenXml"];
    const fallback = ["Excel", "EXCEL"];
    function isLoadingViewer(c) {
      try { if (typeof c.get_isLoading === "function" && c.get_isLoading()) return true; } catch (_) {}
      try { if (typeof c.get_isLoadingClient === "function" && c.get_isLoadingClient()) return true; } catch (_) {}
      try { if (c.isLoading === true) return true; } catch (_) {}
      return false;
    }
    const tryExport = (c) => {
      if (!c || typeof c.exportReport !== "function") return null;
      if (isLoadingViewer(c)) return { blocked: "loading" };
      try {
        if (typeof c.get_reportAreaContentType === "function") {
          const ct = c.get_reportAreaContentType();
          if (ct === 0 || ct === "None") return { blocked: "no-report" };
        }
      } catch (_) {}
      const all = formats.concat(fallback);
      for (let i = 0; i < all.length; i += 1) {
        try {
          c.exportReport(all[i]);
          return { format: all[i] };
        } catch (e) {
          const msg = String((e && e.message) || e);
          if (/being updated|no report loaded/i.test(msg)) return { blocked: msg };
        }
      }
      return null;
    };
    try {
      const getComponents = window.Sys && window.Sys.Application && window.Sys.Application.get_components;
      const list = getComponents ? window.Sys.Application.get_components() : [];
      let blocked = null;
      for (let i = 0; i < list.length; i += 1) {
        const result = tryExport(list[i]);
        if (result && result.format) return { ok: true, format: result.format };
        if (result && result.blocked) blocked = result.blocked;
      }
      const dict = window.Sys && window.Sys.Application && window.Sys.Application._components;
      if (dict && $find) {
        const ids = Object.keys(dict);
        for (let i = 0; i < ids.length; i += 1) {
          const result = tryExport($find(ids[i]));
          if (result && result.format) return { ok: true, format: result.format, id: ids[i] };
          if (result && result.blocked) blocked = result.blocked;
        }
      }
      if (blocked) return { ok: false, error: blocked };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
    return { ok: false };
  }

  if (op === "reportViewerState") {
    function vis(el) {
      if (!el) return false;
      try {
        const s = window.getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch (_) {
        return false;
      }
    }
    try {
      let loading = false;
      let hasViewer = false;
      let totalPages = 0;
      let rendered = false;
      let hasExport = false;
      let exportEnabled = false;
      let contentType = null;

      const wait = document.querySelector("[id$='AsyncWait_Wait'], [id$='AsyncWait'], [id*='AsyncWait'], .WaitControl");
      if (wait && vis(wait)) loading = true;

      const visContent = document.querySelector("[id*='VisibleReportContent'], [id$='ReportArea'], [id*='ReportViewer'] table");
      if (visContent && visContent.offsetHeight > 40) rendered = true;

      const bodyText = String((document.body && (document.body.innerText || document.body.textContent)) || "");
      const pageMatch = bodyText.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
      if (pageMatch && Number(pageMatch[2]) > 0) {
        rendered = true;
        totalPages = Number(pageMatch[2]);
      }

      const exportSel = [
        '[title*="Export" i]',
        '[aria-label*="Export" i]',
        'img[alt*="Export" i]',
        'img[src*="Save.gif" i]',
        'img[src*="Icons.Save" i]',
        'input[type="image"][title*="Export" i]',
        'a[id*="Export" i]',
        'button[id*="Export" i]'
      ];
      for (let i = 0; i < exportSel.length; i += 1) {
        const nodes = Array.from(document.querySelectorAll(exportSel[i]));
        const hit = nodes.find(vis);
        if (hit) {
          hasExport = true;
          const clickable = hit.closest("a,button,input") || hit;
          exportEnabled = !clickable.disabled && String(clickable.getAttribute && clickable.getAttribute("aria-disabled") || "").toLowerCase() !== "true";
          break;
        }
      }

      const getComponents = window.Sys && window.Sys.Application && window.Sys.Application.get_components;
      const list = getComponents ? window.Sys.Application.get_components() : [];
      for (let i = 0; i < list.length; i += 1) {
        const c = list[i];
        if (!c) continue;
        if (typeof c.exportReport === "function" || typeof c.get_isLoading === "function") {
          hasViewer = true;
          try { if (typeof c.get_isLoading === "function" && c.get_isLoading()) loading = true; } catch (_) {}
          try { if (typeof c.get_isLoadingClient === "function" && c.get_isLoadingClient()) loading = true; } catch (_) {}
          try { if (c.isLoading === true) loading = true; } catch (_) {}
          try {
            if (typeof c.get_totalPages === "function") {
              const n = Number(c.get_totalPages());
              if (n > totalPages) totalPages = n;
              if (n > 0) rendered = true;
            }
          } catch (_) {}
          try {
            if (typeof c.get_reportAreaContentType === "function") {
              contentType = c.get_reportAreaContentType();
              if (contentType === 1 || contentType === 2 || contentType === "ReportPage") rendered = true;
            }
          } catch (_) {}
        }
      }
      return {
        ok: true,
        loading,
        hasViewer,
        totalPages,
        rendered,
        hasExport,
        exportEnabled,
        contentType,
        frame: window !== window.top
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  if (op === "clickViewReport") {
    function vis(el) {
      if (!el) return false;
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    const nodes = Array.from(document.querySelectorAll("input, button, a"));
    const btn = nodes.find((el) => {
      const t = String(el.value || el.innerText || el.textContent || el.title || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      return t === "view report" && vis(el);
    });
    if (!btn) return { ok: false, error: "no View Report button" };
    try { btn.click(); } catch (e) { return { ok: false, error: String(e) }; }
    const form = btn.form || (btn.closest && btn.closest("form")) || document.forms[0];
    return { ok: true, tag: btn.tagName, name: btn.name || "", target: (form && form.target) || "" };
  }

  if (op === "clickExportExcel") {
    function vis(el) {
      if (!el) return false;
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function txt(el) {
      return String(el.value || el.innerText || el.textContent || el.title || el.alt || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }
    const step = (args && args.step) || "excel";
    if (step === "export" || step === "both") {
      const exportSel = [
        '[title*="Export" i]',
        '[aria-label*="Export" i]',
        'img[alt*="Export" i]',
        'img[src*="Save.gif" i]',
        'img[src*="Icons.Save" i]',
        'input[type="image"][title*="Export" i]',
        'a[id*="Export" i]',
        'button[id*="Export" i]'
      ];
      let exportBtn = null;
      for (let i = 0; i < exportSel.length; i += 1) {
        const nodes = Array.from(document.querySelectorAll(exportSel[i]));
        exportBtn = nodes.find(vis) || exportBtn;
        if (exportBtn) break;
      }
      if (!exportBtn) {
        const imgs = Array.from(document.querySelectorAll("img")).filter(vis);
        for (let i = 0; i < imgs.length; i += 1) {
          const meta = txt(imgs[i]) + " " + String(imgs[i].src || "").toLowerCase();
          if (meta.indexOf("export") !== -1 || meta.indexOf("save.gif") !== -1) {
            exportBtn = imgs[i].closest("a,button,td") || imgs[i];
            break;
          }
        }
      }
      if (exportBtn) {
        try { (exportBtn.closest("a,button") || exportBtn).click(); } catch (_) {}
        if (step === "export") return { ok: true, via: "export-icon" };
      } else if (step === "export") {
        return { ok: false, error: "no export icon" };
      }
    }
    const candidates = Array.from(document.querySelectorAll("a, button, td, li, [role='menuitem']")).filter(vis);
    let excel = null;
    let score = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      const t = txt(candidates[i]);
      if (!t || t.length > 48) continue;
      if (/\b(pdf|word|csv|tiff|mhtml|xml file|web archive)\b/.test(t) && t.indexOf("excel") === -1) continue;
      if (t === "xml" || t === "zip") continue;
      let s = 0;
      if (t === "excel open xml" || t === "excel (open xml)" || t === "excelopenxml") s = 110;
      else if (t === "excel" || t === "excel worksheet") s = 100;
      else if (t.indexOf("xlsx") !== -1) s = 95;
      else if (t.indexOf("excel") === 0) s = 70;
      if (s > score) {
        score = s;
        excel = candidates[i];
      }
    }
    if (!excel) return { ok: false, error: "no Excel option" };
    try { excel.click(); } catch (e) { return { ok: false, error: String(e) }; }
    return { ok: true, via: "menu", format: txt(excel) };
  }

  return { ok: false, error: "unknown op" };
}

function scoreViewerState(r) {
  if (!r || r.ok === false) return -1;
  let s = 0;
  if (r.hasViewer) s += 50;
  if (r.rendered) s += 40;
  if (r.hasExport) s += 20;
  if (r.exportEnabled) s += 15;
  if ((r.totalPages || 0) > 0) s += 15;
  if (r.frame) s += 8;
  if (r.loading) s -= 4;
  return s;
}

function pickPageEvalResult(op, injections) {
  const results = (injections || []).map((i) => i?.result).filter(Boolean);
  if (!results.length) return { ok: false };

  if (op === "reportViewerState") {
    const merged = {
      ok: true,
      loading: false,
      hasViewer: false,
      totalPages: 0,
      rendered: false,
      hasExport: false,
      exportEnabled: false,
      frames: results.length
    };
    for (const r of results) {
      if (r.loading) merged.loading = true;
      if (r.hasViewer) merged.hasViewer = true;
      if (r.rendered) merged.rendered = true;
      if (r.hasExport) merged.hasExport = true;
      if (r.exportEnabled) merged.exportEnabled = true;
      if ((r.totalPages || 0) > merged.totalPages) merged.totalPages = r.totalPages;
      if (r.contentType != null && merged.contentType == null) merged.contentType = r.contentType;
    }
    return merged;
  }

  const success = results.find((r) => r.ok);
  if (success) return success;
  const withViewer = results.find((r) => r.hasViewer);
  if (withViewer) return withViewer;
  const blocked = results.find((r) => r.error);
  if (blocked) return blocked;
  return results[results.length - 1] || { ok: false };
}

async function pageEval(tabId, op, args) {
  const allFrames = op === "exportExcel" || op === "reportViewerState" || op === "clickExportExcel";
  try {
    if (op === "exportExcel" || op === "clickExportExcel") {
      const states = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: pageEvalMain,
        args: ["reportViewerState", {}]
      });
      const ranked = (states || [])
        .map((row) => ({
          frameId: row.frameId,
          score: scoreViewerState(row.result),
          result: row.result
        }))
        .sort((a, b) => b.score - a.score);
      const best = ranked.find((row) => row.score > 0) || ranked[0];
      if (!best || best.frameId == null) return { ok: false, error: "no viewer frame" };
      const injections = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [best.frameId] },
        world: "MAIN",
        func: pageEvalMain,
        args: [op, args || {}]
      });
      return injections?.[0]?.result || { ok: false };
    }

    const injections = await chrome.scripting.executeScript({
      target: { tabId, allFrames },
      world: "MAIN",
      func: pageEvalMain,
      args: [op, args || {}]
    });
    if (allFrames) return pickPageEvalResult(op, injections);
    return injections?.[0]?.result || { ok: false };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "HHA_PING" });
    return true;
  } catch (_) {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["config.js", "automation.js"]
    });
    await chrome.tabs.sendMessage(tabId, { type: "HHA_PING" });
    return true;
  } catch (_) {
    return false;
  }
}

async function send(tabId, message) {
  const ready = await ensureContentScript(tabId);
  if (!ready) throw new Error("HHAeXchange tab is not ready yet. Stay logged in and try again.");
  return chrome.tabs.sendMessage(tabId, message);
}

async function findHhaTab() {
  const tabs = await chrome.tabs.query({ url: ["*://*.hhaexchange.com/*", "*://hhaexchange.com/*"] });
  if (!tabs.length) return null;
  const scored = tabs.map((tab) => {
    const url = tab.url || "";
    let s = 0;
    if (/ReferralsByStatus/i.test(url)) s += 50;
    if (/Reports\.aspx/i.test(url)) s += 30;
    if (pageKind(url) === "portal") s += 20;
    if (looksLikeLoginUrl(url)) s -= 80;
    if (tab.active) s += 4;
    if (tab.status === "complete") s += 2;
    return { tab, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored[0].tab;
}

function waitTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("HHAeXchange tab took too long to load."));
    }, timeoutMs);

    function onUpdated(id, info, tab) {
      if (id !== tabId) return;
      if (info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(tab);
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(tab);
      }
    }).catch(() => {});
  });
}

async function findOrOpenHhaTab() {
  const existing = await findHhaTab();
  if (existing?.id) {
    try {
      await chrome.tabs.update(existing.id, { autoDiscardable: false });
    } catch (_) {}
    return existing;
  }

  const url = await lastPortalUrl();
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
  } catch (_) {}
  const loaded = await waitTabComplete(tab.id);
  return loaded || tab;
}

async function keepWindowInBackground(win) {
  if (!activeRun?.keepInBackground || !win?.id) return;
  if (activeRun.stage === "waitingViewer" || activeRun.stage === "exporting") return;
  try {
    const tabs = await chrome.tabs.query({ windowId: win.id });
    const isHha = tabs.some((t) => isHhaUrl(t.url || t.pendingUrl || ""));
    if (isHha) await chrome.windows.update(win.id, { focused: false });
  } catch (_) {}
}

async function startDownloadWatchdog() {
  if (!activeRun) return;
  if (downloadWatchdog) clearTimeout(downloadWatchdog);
  const delay = activeRun.stage === "waitingDownload"
    ? 180000
    : (activeRun.exportClickedAt ? 50000 : 20000);
  downloadWatchdog = setTimeout(async () => {
    if (!activeRun) return;
    if (activeRun.stage === "waitingDownload") {
      await finish(
        false,
        "The Excel file started downloading but did not finish. Check Chrome’s download shelf and retry."
      );
      return;
    }
    if (activeRun.exportClickedAt && !acceptedDownloadId) {
      if (exportRetryCount < 1) {
        exportRetryCount += 1;
        await log("Excel file did not start. Trying export one more time…");
        await kickExcelOnViewerTabs({ force: true });
        await startDownloadWatchdog();
        return;
      }
      await finish(
        false,
        "Excel export was clicked, but Chrome never reported a finished download. Check your Downloads folder or retry."
      );
    }
  }, delay);
}

async function kickExcelOnViewerTabs({ force = false } = {}) {
  if (!activeRun || activeRun.stage === "waitingDownload") return;
  if (!force && activeRun.exportClickedAt) return;
  const tabs = await chrome.tabs.query({ url: ["*://*.hhaexchange.com/*", "*://hhaexchange.com/*"] });
  for (const tab of tabs) {
    const url = tab.url || "";
    const kind = pageKind(url);
    const tracked = activeRun.trackedTabIds?.includes(tab.id);
    const isViewer = kind === "viewer" || (tracked && tab.id !== activeRun.rootTabId && kind !== "setup" && kind !== "login");
    if (!isViewer && !(tracked && kind === "setup")) continue;
    try {
      if (kind === "setup") {
        if (activeRun.stage === "configuring") continue;
        if (activeRun.exportClickedAt && !force) continue;
        await send(tab.id, { type: "HHA_AFTER_VIEW" });
      } else {
        if (!force && exportSentTabs.has(tab.id)) continue;
        exportSentTabs.add(tab.id);
        await send(tab.id, { type: "HHA_EXPORT_EXCEL", force: Boolean(force) });
      }
    } catch (_) {}
  }
}

async function onReportDownloaded(item = {}) {
  if (runSucceeded) return;
  if (acceptedDownloadId && item.id && item.id !== acceptedDownloadId) return;
  runSucceeded = true;
  const ext = extensionFromDownload(item);
  const pending = await pendingRename();
  const name = (item.filename || "").split(/[/\\]/).pop() || (pending?.base ? `${pending.base}.${ext}` : reportFilename(ext));
  if (activeRun) {
    activeRun.savedAs = name;
    await log(`Download finished: ${name}`);
    await finish(true, `${activeRun.stateLabel} report saved as ${name}.`);
  } else {
    await chrome.storage.local.set({
      [LAST_KEY]: {
        success: true,
        status: "complete",
        statusMessage: `Report saved as ${name}.`,
        completedAt: Date.now(),
        savedAs: name,
        stateLabel: "Maryland"
      }
    });
    await setBadge("✓", "#2f4a3c");
    await broadcastRunFinished({
      success: true,
      message: `Report saved as ${name}.`,
      savedAs: name
    });
  }
  await setPendingRename(false);
  await notifyUser({
    id: "hha-report-ready",
    title: "Maryland daily report is ready",
    message: `${name} is in your Downloads folder.`,
    buttons: [{ title: "Open Downloads" }]
  });
}

async function startRun({ trigger = "manual", state = "maryland" } = {}) {
  const cfg = globalThis.HHA_REPORT_CONFIG?.[state];
  if (!cfg) return { ok: false, error: "Unknown state." };
  if (activeRun) return { ok: false, error: "A report pull is already running." };

  acceptedDownloadId = null;
  exportSentTabs.clear();
  exportRetryCount = 0;
  runSucceeded = false;

  await setBadge("…", "#6e6b62");
  const tab = await findOrOpenHhaTab();
  if (!tab?.id) {
    await setBadge("", "#2f4a3c");
    return { ok: false, error: "Could not open an HHAeXchange tab." };
  }

  const url = tab.url || "";
  if (looksLikeLoginUrl(url) || pageKind(url) === "login") {
    await setBadge("!", "#8b3a2d");
    await notifyUser({
      id: "hha-need-login",
      title: "Log in to pull today’s report",
      message: "The 4:50 weekday pull is waiting. Sign in to Maryland HHAeXchange, then click Pull today’s report.",
      buttons: [{ title: "Show portal tab" }]
    });
    try { await chrome.tabs.update(tab.id, { active: true }); } catch (_) {}
    return { ok: false, error: "Open the logged-in Maryland HHAeXchange portal, then try again." };
  }

  if (!isHhaUrl(url) && trigger === "manual") {
    await setBadge("", "#2f4a3c");
    return { ok: false, error: "Open the logged-in Maryland HHAeXchange portal first. You can stay on another tab after that — the pull runs in the background." };
  }

  activeRun = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    state,
    stateLabel: cfg.label,
    startedAt: Date.now(),
    rootTabId: tab.id,
    trackedTabIds: [tab.id],
    stage: "navigating",
    status: "running",
    statusMessage: `Starting ${cfg.label} daily report…`,
    logs: [],
    targetFilename: reportFilename("xlsx"),
    trigger,
    keepInBackground: false,
    exportClickedAt: 0
  };
  await saveRun();
  await setPendingRename(true);
  exportRetryCount = 0;
  await rememberPortal(url);
  try {
    const tabs = await chrome.tabs.query({ url: ["*://*.hhaexchange.com/*", "*://hhaexchange.com/*"] });
    for (const t of tabs) {
      try { await chrome.tabs.sendMessage(t.id, { type: "HHA_RUN_START" }); } catch (_) {}
    }
  } catch (_) {}
  await log(
    trigger === "schedule"
      ? `Scheduled 4:50 pull — ${cfg.label} Referral Patients By Status. Running in the background.`
      : `Starting ${cfg.label} Referral Patients By Status in the background. You can switch tabs.`
  );
  await armRunWatch();

  try {
    const kind = pageKind(url);
    if (kind === "setup") {
      activeRun.stage = "configuring";
      await saveRun();
      await send(tab.id, { type: "HHA_CONFIGURE_REPORT", state });
    } else if (kind === "viewer") {
      activeRun.stage = "exporting";
      await saveRun();
      await send(tab.id, { type: "HHA_EXPORT_EXCEL" });
    } else {
      await send(tab.id, { type: "HHA_NAVIGATE" });
    }
    return { ok: true };
  } catch (error) {
    await finish(false, `Could not start automation on the HHAeXchange tab: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

async function routeTab(tabId, url) {
  if (!activeRun || !isHhaUrl(url)) return;

  const kind = pageKind(url);
  if (kind === "login") {
    await finish(false, "HHAeXchange asked you to sign in. Log in, then pull the report again.");
    await notifyUser({
      id: "hha-need-login",
      title: "HHAeXchange session expired",
      message: "Log in and I’ll pull the Maryland daily report.",
      buttons: [{ title: "Show portal tab" }]
    });
    return;
  }

  if (kind === "setup" && (activeRun.stage === "waitingGenerate" || activeRun.stage === "waitingViewer")) {
    activeRun.trackedTabIds = Array.from(new Set([...(activeRun.trackedTabIds || []), tabId]));
    await log("Filter page reloaded after View Report. Checking for the report view, then Excel…");
    try {
      await send(tabId, { type: "HHA_AFTER_VIEW" });
    } catch (error) {
      await finish(false, `Could not finish after View Report: ${error.message}`);
    }
    return;
  }

  if (kind === "setup" && activeRun.stage !== "configuring" && activeRun.stage !== "exporting" && activeRun.stage !== "waitingDownload") {
    activeRun.stage = "configuring";
    activeRun.trackedTabIds = Array.from(new Set([...(activeRun.trackedTabIds || []), tabId]));
    await log("Report setup opened. Setting Received dates to today…");
    try {
      await send(tabId, { type: "HHA_CONFIGURE_REPORT", state: activeRun.state });
    } catch (error) {
      await finish(false, `Could not automate the report setup page: ${error.message}`);
    }
    return;
  }

  if (kind === "viewer" && activeRun.stage !== "waitingDownload") {
    if (activeRun.exportClickedAt) return;
    activeRun.stage = "exporting";
    activeRun.trackedTabIds = Array.from(new Set([...(activeRun.trackedTabIds || []), tabId]));
    await log("View window opened. Waiting for the report to finish drawing, then Excel…");
    startHeartbeat();
    try {
      if (!exportSentTabs.has(tabId) && !activeRun.exportClickedAt) {
        exportSentTabs.add(tabId);
        await send(tabId, { type: "HHA_EXPORT_EXCEL" });
      }
    } catch (error) {
      await log(`Viewer tab not ready yet (${error.message}). Will retry.`);
    }
  }
}

async function focusTab(tab) {
  if (!tab?.id) return;
  try { await chrome.tabs.update(tab.id, { active: true, autoDiscardable: false }); } catch (_) {}
  if (tab.windowId) {
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
  }
}

async function watchForViewerTab(timeoutMs = 60000) {
  const started = Date.now();
  const known = new Set(activeRun?.trackedTabIds || []);
  while (
    activeRun &&
    (activeRun.stage === "waitingViewer" || activeRun.stage === "configuring" || activeRun.stage === "exporting") &&
    Date.now() - started < timeoutMs
  ) {
    if (activeRun.stage === "waitingDownload") return null;
    const tabs = await chrome.tabs.query({ url: ["*://*.hhaexchange.com/*", "*://hhaexchange.com/*"] });
    for (const tab of tabs) {
      const url = tab.url || tab.pendingUrl || "";
      const isNew = !known.has(tab.id);
      const kind = pageKind(url);
      const reportLike =
        kind === "viewer" ||
        (isNew && looksLikeViewerUrl(url));
      if (!reportLike) continue;

      activeRun.trackedTabIds = Array.from(new Set([...(activeRun.trackedTabIds || []), tab.id]));
      await saveRun();
      await focusTab(tab);
      if (tab.status === "complete" && kind !== "setup" && activeRun.stage !== "waitingDownload") {
        if (activeRun.exportClickedAt || exportSentTabs.has(tab.id)) continue;
        exportSentTabs.add(tab.id);
        activeRun.stage = "exporting";
        await log("View window is on screen. Waiting for the report to finish drawing, then Excel…");
        startHeartbeat();
        try {
          await send(tab.id, { type: "HHA_EXPORT_EXCEL" });
        } catch (error) {
          await log(`Could not reach the report viewer yet (${error.message}). Will retry.`);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (activeRun && (activeRun.stage === "waitingViewer" || activeRun.stage === "configuring")) {
    const tabs = await chrome.tabs.query({ url: ["*://*.hhaexchange.com/*", "*://hhaexchange.com/*"] });
    const viewer = tabs.find((t) => pageKind(t.url || "") === "viewer") ||
      tabs.find((t) => activeRun.trackedTabIds?.includes(t.id) && t.id !== activeRun.rootTabId);
    if (viewer?.id) {
      if (!activeRun.exportClickedAt && !exportSentTabs.has(viewer.id)) {
        exportSentTabs.add(viewer.id);
        activeRun.stage = "exporting";
        await saveRun();
        try { await send(viewer.id, { type: "HHA_EXPORT_EXCEL" }); } catch (_) {}
      }
      return viewer;
    }
    await finish(
      false,
      "The View Report window did not open. If Chrome blocked a popup, allow popups for hhaexchange.com and retry."
    );
  }
  return null;
}

async function scheduleNextAlarm() {
  const settings = await getSettings();
  try { await chrome.alarms.clear(ALARM_NAME); } catch (_) {}
  if (!settings.scheduleEnabled) return null;
  const next = nextWeekdayFire(settings.hour, settings.minute, settings.weekdaysOnly);
  await chrome.alarms.create(ALARM_NAME, { when: next.getTime() });
  return next;
}

async function armRunWatch() {
  if (!activeRun) return;
  try {
    await chrome.alarms.create(WATCH_ALARM, { when: Date.now() + 8000 });
  } catch (_) {}
}

async function onRunWatch() {
  if (!activeRun) {
    try { await chrome.alarms.clear(WATCH_ALARM); } catch (_) {}
    return;
  }
  const elapsed = Date.now() - (activeRun.startedAt || Date.now());
  if (elapsed > 8 * 60 * 1000) {
    await finish(false, "The pull timed out after 8 minutes. Open the View window and retry.");
    return;
  }
  await armRunWatch();
  if (activeRun.stage === "waitingDownload") return;
  if (activeRun.exportClickedAt) return;
  if (activeRun.stage === "waitingViewer" || activeRun.stage === "exporting" || activeRun.stage === "configuring") {
    await kickExcelOnViewerTabs();
  }
}

async function nextAlarmInfo() {
  const settings = await getSettings();
  if (!settings.scheduleEnabled) return { enabled: false, nextAt: null, label: "Off" };
  const alarm = await chrome.alarms.get(ALARM_NAME);
  const next = alarm?.scheduledTime ? new Date(alarm.scheduledTime) : nextWeekdayFire(settings.hour, settings.minute, settings.weekdaysOnly);
  const label = `${weekdayName(next)} ${formatClock(next.getHours(), next.getMinutes())}`;
  return { enabled: true, nextAt: next.getTime(), label, settings };
}

async function maybeNotifyMissedPull() {
  const settings = await getSettings();
  if (!settings.scheduleEnabled) return;
  const now = new Date();
  if (settings.weekdaysOnly && (now.getDay() === 0 || now.getDay() === 6)) return;
  const scheduled = new Date(now);
  scheduled.setHours(settings.hour, settings.minute, 0, 0);
  if (now.getTime() < scheduled.getTime() + 60000) return;
  const stored = await chrome.storage.local.get(LAST_KEY);
  const last = stored[LAST_KEY];
  if (last?.success && sameLocalDay(last.completedAt, now)) return;
  if (activeRun) return;
  await notifyUser({
    id: "hha-missed-pull",
    title: "Missed the weekday report pull",
    message: `Chrome wasn’t ready at ${formatClock(settings.hour, settings.minute)}. Click to pull today’s Maryland report now.`,
    buttons: [{ title: "Pull now" }]
  });
}

function statusPayload(extra = {}) {
  return chrome.storage.local.get([RUN_KEY, LAST_KEY]).then(async (stored) => {
    const alarm = await nextAlarmInfo();
    return {
      ok: true,
      active: stored[RUN_KEY] || activeRun || null,
      last: stored[LAST_KEY] || null,
      settings: alarm.settings || await getSettings(),
      schedule: alarm,
      ...extra
    };
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "hha-automation") return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "HHA_SLEEP") {
      const ms = Math.max(0, Math.min(Number(message.ms) || 0, 60000));
      await new Promise((resolve) => setTimeout(resolve, ms));
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "HHA_PAGE_EVAL") {
      const tabId = sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, error: "No tab." });
        return;
      }
      const result = await pageEval(tabId, message.op, message.args);
      sendResponse({ ok: true, result });
      return;
    }

    if (message?.type === "START_HHA_RUN") {
      const result = await startRun({ trigger: "manual", state: message.state || "maryland" });
      sendResponse(result);
      return;
    }

    if (message?.type === "STOP_HHA_RUN") {
      if (activeRun) await finish(false, "Automation stopped by user.");
      await setBadge("");
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "HHA_LOG") {
      if (activeRun) await log(message.message || "Working…");
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "HHA_ACTION_RESULT") {
      if (!activeRun) {
        sendResponse({ ok: true });
        return;
      }
      if (!message.success) {
        await finish(false, message.error || `Automation failed during ${message.action}.`);
        sendResponse({ ok: true });
        return;
      }
      if (message.action === "NAVIGATE") {
        activeRun.stage = "waitingSetup";
        await log("Waiting for the HHA Report Center…");
      } else if (message.action === "GENERATE_REPORT") {
        activeRun.stage = "waitingViewer";
        await log("Ignoring Generate Report. Using View Report instead, then Excel from that tab.");
        startHeartbeat();
      } else if (message.action === "CONFIGURE_AND_VIEW") {
        activeRun.stage = "waitingViewer";
        await log("Dates set to today. Clicked View Report — watching for the report window, then Excel.");
        startHeartbeat();
        watchForViewerTab().catch(() => {});
      } else if (message.action === "EXPORT_EXCEL") {
        if (!activeRun.exportClickedAt) activeRun.exportClickedAt = Date.now();
        if (activeRun.stage !== "waitingDownload") activeRun.stage = "exporting";
        await log("Excel export clicked in the View window. Waiting for one .xlsx file…");
        await startDownloadWatchdog();
      }
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "GET_HHA_STATUS") {
      sendResponse(await statusPayload());
      return;
    }

    if (message?.type === "GET_HHA_SETTINGS") {
      sendResponse({ ok: true, settings: await getSettings(), schedule: await nextAlarmInfo() });
      return;
    }

    if (message?.type === "SET_HHA_SETTINGS") {
      const settings = await saveSettings(message.settings || {});
      sendResponse({ ok: true, settings, schedule: await nextAlarmInfo() });
      return;
    }

    if (message?.type === "HHA_PING") {
      sendResponse({ ok: true });
      return;
    }
  })().catch((error) => {
    try { sendResponse({ ok: false, error: error.message }); } catch (_) {}
  });
  return true;
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  try {
    const pending = (renameState.enabled && Date.now() - renameState.startedAt < 20 * 60 * 1000)
      ? renameState
      : null;
    const running = Boolean(activeRun) || Boolean(pending);
    if (!running || !downloadLooksLikeReport(item)) {
      suggest();
      return true;
    }
    const ext = extensionFromDownload(item);
    const filename = `${(pending && pending.base) || `Report of ${filenameDate()}`}.${ext}`;
    suggest({ filename, conflictAction: "uniquify" });
    watchedDownloads.set(item.id, { ...item, filename });
    if (!acceptedDownloadId) acceptedDownloadId = item.id;
    if (activeRun) {
      activeRun.savedAs = filename;
      log(`Renaming download to ${filename}`).catch(() => {});
    }
  } catch (_) {
    try { suggest(); } catch (__) {}
  }
  return true;
});

chrome.downloads.onCreated.addListener(async (item) => {
  const pending = await pendingRename();
  if (!activeRun && !pending) return;
  if (!downloadLooksLikeReport(item)) return;
  if (runSucceeded) {
    try { await chrome.downloads.cancel(item.id); } catch (_) {}
    try { await chrome.downloads.erase({ id: item.id }); } catch (_) {}
    return;
  }
  if (acceptedDownloadId && acceptedDownloadId !== item.id) {
    try { await chrome.downloads.cancel(item.id); } catch (_) {}
    try { await chrome.downloads.erase({ id: item.id }); } catch (_) {}
    if (activeRun) await log("Ignored an extra download — the first Excel file is already saving.");
    return;
  }
  acceptedDownloadId = item.id;
  watchedDownloads.set(item.id, item);
  if (activeRun) {
    activeRun.stage = "waitingDownload";
    activeRun.downloadId = item.id;
    stopHeartbeat();
    await log("Chrome started the Excel download…");
    await startDownloadWatchdog();
  }
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!watchedDownloads.has(delta.id) && !(activeRun || await pendingRename())) return;
  if (delta.filename?.current) {
    const prev = watchedDownloads.get(delta.id) || { id: delta.id };
    watchedDownloads.set(delta.id, { ...prev, filename: delta.filename.current });
  }
  if (delta.state?.current === "complete") {
    const item = watchedDownloads.get(delta.id) || { id: delta.id, filename: delta.filename?.current };
    watchedDownloads.delete(delta.id);
    if (acceptedDownloadId && delta.id !== acceptedDownloadId) return;
    await onReportDownloaded(item);
  } else if (delta.state?.current === "interrupted") {
    watchedDownloads.delete(delta.id);
    if (acceptedDownloadId && delta.id !== acceptedDownloadId) return;
    if (activeRun) {
      acceptedDownloadId = null;
      await finish(false, "The Excel download was interrupted. Check Chrome’s download shelf and retry.");
    }
  }
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!activeRun) return;
  const openerTracked = tab.openerTabId && activeRun.trackedTabIds?.includes(tab.openerTabId);
  const recentHhaPopup = isHhaUrl(tab.pendingUrl || tab.url || "") && Date.now() - activeRun.startedAt < 120000;
  if (openerTracked || recentHhaPopup) {
    activeRun.trackedTabIds = Array.from(new Set([...(activeRun.trackedTabIds || []), tab.id]));
    await saveRun();
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (_) {}
    if (activeRun.stage === "waitingViewer" || activeRun.stage === "configuring" || activeRun.stage === "exporting") {
      await focusTab(tab);
      await log("View Report window opened. You should see the report loading there.");
    }
  }
});

chrome.windows.onCreated.addListener((win) => {
  if (!activeRun?.keepInBackground) return;
  setTimeout(() => keepWindowInBackground(win), 80);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = tab.url || changeInfo.url || "";
  if (url) await rememberPortal(url);

  if (!activeRun) return;
  if (changeInfo.status !== "complete" && !changeInfo.url) return;

  const tracked = activeRun.trackedTabIds?.includes(tabId);
  const recentReportTab = isHhaUrl(url) && /report/i.test(url) && Date.now() - activeRun.startedAt < 900000;
  if (!tracked && !recentReportTab) return;

  if (recentReportTab && !tracked) {
    activeRun.trackedTabIds = Array.from(new Set([...(activeRun.trackedTabIds || []), tabId]));
    await saveRun();
  }

  if (pageKind(url) === "viewer" && changeInfo.status !== "complete") return;
  await routeTab(tabId, url);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!activeRun) return;
  if (activeRun.trackedTabIds?.includes(tabId)) {
    activeRun.trackedTabIds = activeRun.trackedTabIds.filter((id) => id !== tabId);
    await saveRun();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === WATCH_ALARM) {
    await onRunWatch();
    return;
  }
  if (alarm.name !== ALARM_NAME) return;
  await scheduleNextAlarm();
  const settings = await getSettings();
  const now = new Date();
  if (!settings.scheduleEnabled) return;
  if (settings.weekdaysOnly && (now.getDay() === 0 || now.getDay() === 6)) return;
  if (activeRun) {
    await log("Scheduled 4:50 pull skipped — a run is already in progress.");
    return;
  }
  const stored = await chrome.storage.local.get(LAST_KEY);
  const last = stored[LAST_KEY];
  if (last?.success && sameLocalDay(last.completedAt, now) && now.getTime() - last.completedAt < 10 * 60 * 1000) {
    return;
  }
  const result = await startRun({ trigger: "schedule", state: "maryland" });
  if (!result.ok) {
    await notifyUser({
      id: "hha-schedule-failed",
      title: "Couldn’t auto-pull the 4:50 report",
      message: result.error || "Open HHAeXchange, stay logged in, and I’ll retry from the popup.",
      buttons: [{ title: "Open popup help" }]
    });
  }
});

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (notificationId === "hha-report-ready") {
    try { await chrome.downloads.showDefaultFolder(); } catch (_) {}
    return;
  }
  if (notificationId === "hha-need-login" || notificationId === "hha-schedule-failed") {
    const tab = await findHhaTab();
    if (tab?.id) {
      try {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
      } catch (_) {}
    }
    return;
  }
  if (notificationId === "hha-missed-pull" && buttonIndex === 0) {
    await startRun({ trigger: "manual", state: "maryland" });
  }
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId === "hha-report-ready") {
    try { await chrome.downloads.showDefaultFolder(); } catch (_) {}
    return;
  }
  const tab = await findHhaTab();
  if (tab?.id) {
    try {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    } catch (_) {}
  }
});

async function boot() {
  try {
    const stored = await chrome.storage.local.get([RUN_KEY, RENAME_KEY]);
    activeRun = stored[RUN_KEY] || null;
    if (stored[RENAME_KEY]?.enabled) renameState = stored[RENAME_KEY];
    if (activeRun && Date.now() - (activeRun.startedAt || 0) > 20 * 60 * 1000) {
      await finish(false, "Previous pull was interrupted (Chrome restarted). Try again.");
    } else if (activeRun) {
      await armRunWatch();
      startHeartbeat();
      if (!activeRun.exportClickedAt && (activeRun.stage === "waitingViewer" || activeRun.stage === "exporting" || activeRun.stage === "configuring")) {
        kickExcelOnViewerTabs().catch(() => {});
      }
    }
    await getSettings();
    await scheduleNextAlarm();
  } catch (_) {}
}

chrome.runtime.onInstalled.addListener(async () => {
  await saveSettings(await getSettings());
  await setBadge("");
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleNextAlarm();
  await maybeNotifyMissedPull();
});

boot();
