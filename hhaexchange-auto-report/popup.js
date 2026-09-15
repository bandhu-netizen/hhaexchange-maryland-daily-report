/* global chrome */
const runButton = document.getElementById("runButton");
const stopButton = document.getElementById("stopButton");
const statusTitle = document.getElementById("statusTitle");
const statusMessage = document.getElementById("statusMessage");
const fileChip = document.getElementById("fileChip");
const scheduleToggle = document.getElementById("scheduleToggle");
const hourSelect = document.getElementById("hourSelect");
const minuteSelect = document.getElementById("minuteSelect");
const meridiemSelect = document.getElementById("meridiemSelect");
const nextRun = document.getElementById("nextRun");
const stepList = document.getElementById("stepList");

let saving = false;

function pad(n) {
  return String(n).padStart(2, "0");
}

function todayFilename() {
  const d = new Date();
  return `Report of ${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${d.getFullYear()}.xlsx`;
}

function hour24(hour12, meridiem) {
  let h = Number(hour12);
  if (meridiem === "am") return h === 12 ? 0 : h;
  return h === 12 ? 12 : h + 12;
}

function setBusy(busy) {
  runButton.disabled = busy;
  stopButton.hidden = !busy;
}

function stepFromStage(stage) {
  if (!stage) return 0;
  if (stage === "navigating" || stage === "waitingSetup") return 1;
  if (stage === "configuring") return 2;
  if (stage === "waitingViewer" || stage === "waitingGenerate") return 3;
  if (stage === "exporting" || stage === "waitingDownload") return 4;
  if (stage === "complete") return 5;
  return 0;
}

function paintSteps(current) {
  if (!stepList) return;
  stepList.querySelectorAll("li").forEach((li) => {
    const n = Number(li.getAttribute("data-step"));
    li.classList.toggle("is-current", n === current);
    li.classList.toggle("is-done", current > 0 && n < current);
  });
}

async function send(message) {
  return chrome.runtime.sendMessage(message);
}

function fillTimeSelects() {
  if (hourSelect.options.length) return;
  for (let h = 1; h <= 12; h += 1) {
    const opt = document.createElement("option");
    opt.value = String(h);
    opt.textContent = String(h);
    hourSelect.appendChild(opt);
  }
  for (let m = 0; m < 60; m += 1) {
    const opt = document.createElement("option");
    opt.value = String(m);
    opt.textContent = pad(m);
    minuteSelect.appendChild(opt);
  }
}

function applySettings(settings, schedule) {
  if (!settings) return;
  saving = true;
  scheduleToggle.checked = Boolean(settings.scheduleEnabled);
  const hour = Number(settings.hour ?? 16);
  const minute = Number(settings.minute ?? 50);
  meridiemSelect.value = hour >= 12 ? "pm" : "am";
  const hour12 = ((hour + 11) % 12) + 1;
  hourSelect.value = String(hour12);
  minuteSelect.value = String(minute);
  const disabled = !settings.scheduleEnabled;
  hourSelect.disabled = disabled;
  minuteSelect.disabled = disabled;
  meridiemSelect.disabled = disabled;
  nextRun.textContent = settings.scheduleEnabled
    ? `Next run ${schedule?.label || "—"} · Mon–Fri`
    : "Auto-pull is off";
  saving = false;
}

async function persistSettings() {
  if (saving) return;
  const settings = {
    scheduleEnabled: scheduleToggle.checked,
    hour: hour24(hourSelect.value, meridiemSelect.value),
    minute: Number(minuteSelect.value),
    weekdaysOnly: true
  };
  const res = await send({ type: "SET_HHA_SETTINGS", settings });
  applySettings(res?.settings || settings, res?.schedule);
}

async function refresh() {
  fileChip.textContent = todayFilename();
  fillTimeSelects();

  try {
    const res = await send({ type: "GET_HHA_STATUS" });
    if (!res?.ok) return;
    applySettings(res.settings, res.schedule);

    if (res.active) {
      setBusy(true);
      paintSteps(stepFromStage(res.active.stage));
      statusTitle.textContent = `${res.active.stateLabel} — ${res.active.trigger === "schedule" ? "scheduled run" : "running"}`;
      statusMessage.textContent = res.active.statusMessage || "Working in the background…";
      return;
    }

    setBusy(false);
    if (res.last?.success) paintSteps(5);
    else paintSteps(0);

    if (res.last) {
      statusTitle.textContent = res.last.success ? "Last run completed" : "Last run stopped / failed";
      statusMessage.textContent = res.last.statusMessage || "Ready.";
    } else {
      statusTitle.textContent = "Ready";
      statusMessage.textContent = "You can start a pull from any tab. Chrome just needs a logged-in HHAeXchange session.";
    }
  } catch (error) {
    setBusy(false);
    paintSteps(0);
    statusTitle.textContent = "Extension error";
    statusMessage.textContent = error.message;
  }
}

runButton.addEventListener("click", async () => {
  setBusy(true);
  paintSteps(1);
  statusTitle.textContent = "Starting…";
  statusMessage.textContent = "Finding your HHAeXchange tab. Then View Report → wait for pages → Excel.";

  try {
    const res = await send({ type: "START_HHA_RUN", state: "maryland" });
    if (!res?.ok) {
      setBusy(false);
      paintSteps(0);
      statusTitle.textContent = "Cannot start";
      statusMessage.textContent = res?.error || "Unknown error.";
      return;
    }
    await refresh();
  } catch (error) {
    setBusy(false);
    paintSteps(0);
    statusTitle.textContent = "Cannot start";
    statusMessage.textContent = error.message;
  }
});

stopButton.addEventListener("click", async () => {
  await send({ type: "STOP_HHA_RUN" });
  await refresh();
});

scheduleToggle.addEventListener("change", persistSettings);
hourSelect.addEventListener("change", persistSettings);
minuteSelect.addEventListener("change", persistSettings);
meridiemSelect.addEventListener("change", persistSettings);

fileChip.textContent = todayFilename();
fillTimeSelects();
hourSelect.value = "4";
minuteSelect.value = "50";
meridiemSelect.value = "pm";
refresh();
setInterval(refresh, 800);
