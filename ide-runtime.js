/* ide-runtime.js — loaded AFTER the inline script in index.html.
   Replaces the old Skulpt-based run / stop / console / input code with a Pyodide Web Worker,
   and fixes editor issues (bracket auto-close on phone keyboards, draft saving, shortcuts, download). */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  /* ================= worker client ================= */
  let worker = null, ready = false, failed = false, swOK = false;
  let queue = [];
  let awaitingInput = false, pendingInputId = null, pendingInputTarget = "run";
  let replBusy = false, replMore = false;
  let watchdog = null, usedMs = 0, runStart = 0;
  let activeTarget = null; // "run" | "repl" | null

  function setStatus(t) { $("exec-status").innerText = t; }

  function updateConnectivityStatus() {
    const b = $("offline-badge");
    if (failed) b.innerText = "🔴 Python Error";
    else if (!ready) b.innerText = "🟡 Loading Python…";
    else b.innerText = navigator.onLine ? "🟢 Offline Ready" : "🟢 Offline Active";
  }
  window.updateConnectivityStatus = updateConnectivityStatus;
  window.addEventListener("online", updateConnectivityStatus);
  window.addEventListener("offline", updateConnectivityStatus);

  function startWorker() {
    ready = false; failed = false;
    setStatus("Loading Python…");
    updateConnectivityStatus();
    worker = new Worker("py-worker.js");
    worker.onmessage = onWorkerMessage;
    worker.onerror = (ev) => {
      failed = true;
      appendOutput("\n[Python runtime failed to start" + (ev && ev.message ? ": " + ev.message : "") + "]\n", "log-stderr");
      setStatus("Runtime error");
      updateConnectivityStatus();