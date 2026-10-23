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

  // Small public API for ide-extras.js (problems panel etc.)
  const ext = {};
  window.PyIDE = {
    send: (m) => send(m),
    on: (type, fn) => { ext[type] = fn; },
    ready: () => ready,
    busy: () => activeTarget !== null,
    onRunStart: null, // () => void
    onRunDone: null   // (message, seconds) => void
  };

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
      endActive();
    };
  }

  function restartWorker() {
    try { worker.terminate(); } catch (e) {}
    queue = [];
    awaitingInput = false; pendingInputId = null;
    $("stdin-bar").style.display = "none";
    if (replCommandHistory.length) {
      replMore = false; updateReplPrefix();
      appendReplLine("[Python restarted: console variables were reset]", "log-info");
    }
    startWorker();
  }

  function send(m) {
    if (ready) worker.postMessage(m); else queue.push(m);
  }

  async function initRuntime() {
    updateConnectivityStatus(); // badge changes to "Loading Python…" right away
    if ("serviceWorker" in navigator) {
      const setup = (async () => {
        try {
          await navigator.serviceWorker.register("sw.js");
          await navigator.serviceWorker.ready;
          if (!navigator.serviceWorker.controller) {
            await Promise.race([
              new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true })),
              new Promise((r) => setTimeout(r, 2500))
            ]);
          }
        } catch (e) { /* input() will report that it is unavailable */ }
      })();
      // never wait more than 4 s for the helper: Python must start regardless
      await Promise.race([setup, new Promise((r) => setTimeout(r, 4000))]);
    }
    startWorker();
  }

  function onWorkerMessage(ev) {
    const m = ev.data;
    switch (m.type) {
      case "ready": {
        ready = true; swOK = !!m.input;
        if (activeTarget === null) setStatus("Idle");
        updateConnectivityStatus();
        const q = queue; queue = [];
        q.forEach((x) => worker.postMessage(x));
        break;
      }
      case "out":
        if (m.target === "repl") appendRepl(m.text, m.err ? "repl-err-line" : "repl-out-line");
        else appendOutput(m.text, m.err ? "log-stderr" : "log-stdout");
        break;
      case "gfx": drawGfx(m.cmds); break;
      case "input": handleInputRequest(m); break;
      case "done": onDone(m); break;
      case "fatal": failed = true; updateConnectivityStatus(); endActive(); break;
      default: if (ext[m.type]) ext[m.type](m);
    }
  }

  /* ---- time limit (does not count the time spent waiting for typed input) ---- */
  function startWatchdog() {
    stopWatchdog(); usedMs = 0;
    watchdog = setInterval(() => {
      if (!ready || awaitingInput) return;
      usedMs += 250;
      const limit = parseInt($("timeout-select").value || "120000", 10);
      if (usedMs >= limit) onTimeout(limit);
    }, 250);
  }
  function stopWatchdog() { if (watchdog) { clearInterval(watchdog); watchdog = null; } }

  function onTimeout(limit) {
    const msg = "\n[Time limit reached (" + Math.round(limit / 1000) + "s). Raise it in ⌨️ settings if your program needs longer.]\n";
    const t = activeTarget;
    restartWorker();
    if (t === "repl") appendRepl(msg, "repl-err-line"); else appendOutput(msg, "log-stderr");
    setStatus("Timed out");
    endActive();
  }

  function endActive() {
    stopWatchdog();
    if (activeTarget === "repl" || replBusy) { replBusy = false; replMore = false; updateReplPrefix(); }
    isRunning = false; activeTarget = null;
    $("run-btn").disabled = false;
    $("stop-btn").style.display = "none";
    $("stdin-bar").style.display = "none";
    awaitingInput = false; pendingInputId = null;
  }

  function onDone(m) {
    if (m.target === "repl") {
      stopWatchdog();
      replBusy = false; activeTarget = null; replMore = !!m.more;
      replEnsureNewline();
      updateReplPrefix();
      $("stop-btn").style.display = "none";
      setStatus("Idle");
      $("repl-input").focus();
      return;
    }
    const el = ((performance.now() - runStart) / 1000).toFixed(2);
    if (window.PyIDE.onRunDone) window.PyIDE.onRunDone(m, el);
    if (m.ok) {
      appendOutput("\n[Program exited with code 0 in " + el + "s]", "log-meta");
      setStatus("Done (" + el + "s)");
    } else {
      appendOutput("\n[Program stopped because of an error after " + el + "s]", "log-meta");
      setStatus("Error");
      if (m.line && m.line > 0 && m.line <= editor.lineCount()) {
        activeErrorLine = m.line - 1;
        editor.addLineClass(activeErrorLine, "background", "error-line-highlight");
        editor.scrollIntoView({ line: activeErrorLine, ch: 0 }, 80);
      }
      openExecutionSheet("output");
    }
    endActive();
  }

  /* ================= output log (batched, so huge loops stay fast) ================= */
  const OUT_MAX = 400000; // characters kept on screen; older output is trimmed
  let outBuf = [], outRaf = 0, outChars = 0;

  function appendOutput(text, cls) {
    outBuf.push([text, cls || "log-stdout"]);
    if (!outRaf) outRaf = requestAnimationFrame(flushOutput);
  }
  function flushOutput() {
    outRaf = 0;
    const log = $("output-log");
    if (!log.firstChild) outChars = 0;
    const items = outBuf; outBuf = [];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < items.length;) {
      let t = items[i][0]; const c = items[i][1]; i++;
      while (i < items.length && items[i][1] === c) { t += items[i][0]; i++; }
      const s = document.createElement("span");
      s.className = c; s.textContent = t;
      frag.appendChild(s); outChars += t.length;
    }
    log.appendChild(frag);
    while (outChars > OUT_MAX && log.childNodes.length > 1) {
      const n = log.firstChild; outChars -= n.textContent.length; log.removeChild(n);
    }
    log.scrollTop = log.scrollHeight;
  }

  /* ================= run / stop ================= */
  function runPythonCode() {
    if (isRunning) { openExecutionSheet(); return; }
    if (replBusy) { restartWorker(); replBusy = false; }
    clearErrorHighlight();
    saveCurrentWork(false);

    const code = editor.getValue();
    const graphical = usesTurtleGraphics(code);

    isRunning = true; stopRequested = false; activeTarget = "run";
    $("run-btn").disabled = true;
    $("stop-btn").style.display = "inline-flex";
    $("stdin-bar").style.display = "none";
    outBuf = []; outChars = 0;
    $("output-log").innerHTML = "";
    setStatus(ready ? "Running..." : "Loading Python…");
    if (!ready) appendOutput("[Loading the Python runtime — this takes a few seconds on first start…]\n", "log-info");

    if (graphical) {
      setupGfx();
      $("rtab-graphics").classList.remove("hidden-tab");
      openExecutionSheet("graphics");
    } else {
      $("rtab-graphics").classList.add("hidden-tab");
      openExecutionSheet("output");
    }
    runStart = performance.now();
    if (window.PyIDE.onRunStart) window.PyIDE.onRunStart();
    startWatchdog();
    send({ type: "run", code: code });
  }

  function stopPythonExecution() {
    if (activeTarget === null) return;
    stopRequested = true;
    const t = activeTarget;
    restartWorker();
    if (t === "repl") appendRepl("\n[Stopped]\n", "repl-err-line");
    else appendOutput("\n[Execution stopped by user]", "log-stderr");
    setStatus("Stopped");
    endActive();
  }

  /* ================= input() ================= */
  let pendingInputSync = false;
  function replyInput(id, value, sync) {
    awaitingInput = false;
    if (worker) worker.postMessage({ type: "input-reply", id: id, value: value });
    if (sync) { // only the rare input() inside __init__ / lambda / generator needs the service worker
      const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (sw) sw.postMessage({ type: "input-reply", id: id, value: value });
    }
  }

  function handleInputRequest(m) {
    awaitingInput = true;
    if (m.target === "repl") {
      const v = window.prompt(m.prompt || "input:");
      appendRepl((v === null ? "" : v) + "\n", "repl-cmd-line");
      replyInput(m.id, v, m.sync);
      return;
    }
    pendingInputId = m.id; pendingInputSync = !!m.sync;
    openExecutionSheet("output");
    $("stdin-bar").style.display = "flex";
    $("stdin-input").value = "";
    $("stdin-input").focus();
  }

  function submitStdin() {
    if (pendingInputId === null) return;
    const v = $("stdin-input").value;
    const id = pendingInputId;
    pendingInputId = null;
    $("stdin-bar").style.display = "none";
    appendOutput(v + "\n", "log-info");
    replyInput(id, v, pendingInputSync);
  }
  // Replace the elements so the old (Skulpt-era) listeners are gone
  (function bindStdin() {
    const oldInput = $("stdin-input"), oldBtn = $("stdin-submit");
    const inp = oldInput.cloneNode(true), btn = oldBtn.cloneNode(true);
    oldInput.parentNode.replaceChild(inp, oldInput);
    oldBtn.parentNode.replaceChild(btn, oldBtn);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitStdin(); } });
    btn.addEventListener("click", submitStdin);
  })();

  /* ================= Python console (REPL) ================= */
  function appendReplLine(text, cls) {
    const h = $("repl-history");
    const d = document.createElement("div");
    d.className = cls; d.textContent = text;
    h.appendChild(d); h.scrollTop = h.scrollHeight;
  }
  let replLastChar = "\n";
  function appendRepl(text, cls) {
    if (!text) return;
    const h = $("repl-history");
    const s = document.createElement("span");
    s.className = cls; s.textContent = text;
    h.appendChild(s); h.scrollTop = h.scrollHeight;
    replLastChar = text.charAt(text.length - 1);
  }
  function replEnsureNewline() {
    if (replLastChar !== "\n") appendRepl("\n", "repl-out-line");
  }
  function updateReplPrefix() {
    const p = document.querySelector(".repl-prefix");
    if (p) p.textContent = replMore ? "..." : ">>>";
  }

  function evaluateReplInput() {
    const inputEl = $("repl-input");
    const raw = inputEl.value;
    const cmd = raw.trim();
    if (replBusy || isRunning) return;
    if (!cmd && !replMore) return;

    inputEl.value = "";
    if (cmd) { replCommandHistory.push(raw); replHistoryIndex = replCommandHistory.length; }

    if (!replMore && (cmd === "clear" || cmd === "cls")) {
      $("repl-history").innerHTML = ""; replLastChar = "\n";
      return;
    }
    appendReplLine((replMore ? "... " : ">>> ") + raw, "repl-cmd-line");
    replLastChar = "\n";

    if (!replMore && /^(pip|sudo|apt|pkg|ls|dir|bash|sh)\b/.test(cmd)) {
      appendReplLine("[Note] '" + cmd.split(" ")[0] + "' is an OS shell command. This is an interactive Python console.", "repl-err-line");
      return;
    }
    replBusy = true; activeTarget = "repl";
    $("stop-btn").style.display = "inline-flex";
    setStatus(ready ? "Running..." : "Loading Python…");
    startWatchdog();
    send({ type: "repl", line: raw });
  }

  /* ================= turtle graphics canvas (animated like real turtle) ================= */
  const GW = 600, GH = 440;
  // how fast the pen moves (pixels per second) for turtle speed 0..10 (0 = instant, like real turtle)
  const PPS = [Infinity, 40, 80, 150, 250, 400, 600, 900, 1400, 2200, 3500];
  let gfx = null, gfxMult = 1;

  function addSpeedPicker() {
    const tb = document.querySelector(".gfx-toolbar");
    if (!tb || $("gfx-speed")) return;
    const sel = document.createElement("select");
    sel.id = "gfx-speed";
    sel.style.cssText = "background:#141414;color:#fff;border:1px solid #444;border-radius:3px;font-size:10.5px;padding:1px 3px";
    [["1", "Speed: as in code"], ["3", "Faster ×3"], ["10", "Faster ×10"], ["inf", "Instant"]].forEach((o) => {
      const op = document.createElement("option"); op.value = o[0]; op.textContent = o[1]; sel.appendChild(op);
    });
    sel.onchange = () => {
      gfxMult = sel.value === "inf" ? Infinity : parseFloat(sel.value);
      if (gfx && !gfx.raf && gfx.queue.length) gfx.raf = requestAnimationFrame(playGfx);
    };
    tb.insertBefore(sel, tb.lastElementChild);
  }

  function setupGfx() {
    if (gfx && gfx.raf) cancelAnimationFrame(gfx.raf);
    const host = $("turtle-canvas");
    host.innerHTML = "";
    const cv = document.createElement("canvas");
    cv.width = GW; cv.height = GH;
    cv.style.cssText = "display:block;max-width:100%;height:auto;";
    host.appendChild(cv);
    const layer = document.createElement("canvas");
    layer.width = GW; layer.height = GH;
    gfx = { cv: cv, ctx: cv.getContext("2d"), layer: layer, lctx: layer.getContext("2d"),
            sprites: {}, bg: "#ffffff", queue: [], raf: 0, prog: 0, last: 0 };
    addSpeedPicker();
    renderGfx();
  }

  function drawGfx(cmds) {
    if (!gfx) { setupGfx(); $("rtab-graphics").classList.remove("hidden-tab"); }
    for (let i = 0; i < cmds.length; i++) gfx.queue.push(cmds[i]);
    if (!gfx.raf) gfx.raf = requestAnimationFrame(playGfx);
  }

  const lerp = (a, b, t) => a + (b - a) * t;

  function stroke(c, p0, p1) { // draw part p0..p1 (0..1) of a pen move
    if (c[0] !== "L") return;
    const L = gfx.lctx;
    L.strokeStyle = c[5]; L.lineWidth = c[6]; L.lineCap = "round";
    L.beginPath();
    L.moveTo(GW / 2 + lerp(c[1], c[3], p0), GH / 2 - lerp(c[2], c[4], p0));
    L.lineTo(GW / 2 + lerp(c[1], c[3], p1), GH / 2 - lerp(c[2], c[4], p1));
    L.stroke();
  }

  function moveSprite(c, p, ang) { // the little turtle arrow follows the pen
    const old = gfx.sprites[c[8]] || { vis: true };
    gfx.sprites[c[8]] = { x: lerp(c[1], c[3], p), y: lerp(c[2], c[4], p), h: ang, color: c[5], vis: old.vis };
  }

  function playGfx(ts) {
    const g = gfx; if (!g) return;
    g.raf = 0;
    const dt = g.last ? Math.min(0.1, (ts - g.last) / 1000) : 0.016;
    g.last = ts;
    let budget = dt, guard = 0;
    while (g.queue.length && guard++ < 5000) {
      const c = g.queue[0];
      if (c[0] === "L" || c[0] === "M") {
        const len = Math.hypot(c[3] - c[1], c[4] - c[2]);
        const spd = Math.max(0, Math.min(10, c[7] | 0));
        const pps = (spd === 0 || gfxMult === Infinity) ? Infinity : PPS[spd] * gfxMult;
        const ang = Math.atan2(c[4] - c[2], c[3] - c[1]) * 180 / Math.PI;
        if (len === 0 || pps === Infinity) { // instant
          stroke(c, 0, 1); moveSprite(c, 1, ang); g.queue.shift(); g.prog = 0; continue;
        }
        const need = len / pps, remaining = (1 - g.prog) * need;
        if (budget >= remaining) { // finish this line in this frame
          stroke(c, g.prog, 1); moveSprite(c, 1, ang);
          budget -= remaining; g.queue.shift(); g.prog = 0; continue;
        }
        const next = g.prog + budget / need; // only part of the line this frame
        stroke(c, g.prog, next); moveSprite(c, next, ang);
        g.prog = next; budget = 0;
        break;
      }
      drawCmd(g.queue.shift()); // fills, dots, text, colours: instant
    }
    renderGfx();
    if (g.queue.length) g.raf = requestAnimationFrame(playGfx); else g.last = 0;
  }

  function drawCmd(c) {
    const L = gfx.lctx, X = (x) => GW / 2 + x, Y = (y) => GH / 2 - y;
    switch (c[0]) {
      case "F":
        L.fillStyle = c[2]; L.beginPath();
        c[1].forEach((p, i) => { if (i) L.lineTo(X(p[0]), Y(p[1])); else L.moveTo(X(p[0]), Y(p[1])); });
        L.closePath(); L.fill(); break;
      case "D":
        L.fillStyle = c[4]; L.beginPath(); L.arc(X(c[1]), Y(c[2]), c[3] / 2, 0, 7); L.fill(); break;
      case "T":
        L.fillStyle = c[4]; L.font = c[5]; L.textAlign = c[6] === "center" ? "center" : (c[6] === "right" ? "right" : "left");
        L.fillText(c[3], X(c[1]), Y(c[2])); break;
      case "C": L.clearRect(0, 0, GW, GH); break;
      case "B": gfx.bg = c[1]; break;
      case "S": gfx.sprites[c[1]] = { x: c[2], y: c[3], h: c[4], color: c[5], vis: c[6] }; break;
    }
  }

  function renderGfx() {
    const g = gfx, ctx = g.ctx;
    ctx.fillStyle = g.bg; ctx.fillRect(0, 0, GW, GH);
    ctx.drawImage(g.layer, 0, 0);
    Object.keys(g.sprites).forEach((k) => {
      const s = g.sprites[k]; if (!s.vis) return;
      ctx.save();
      ctx.translate(GW / 2 + s.x, GH / 2 - s.y);
      ctx.rotate(-s.h * Math.PI / 180);
      ctx.fillStyle = s.color; ctx.beginPath();
      ctx.moveTo(12, 0); ctx.lineTo(-8, 6); ctx.lineTo(-5, 0); ctx.lineTo(-8, -6); ctx.closePath(); ctx.fill();
      ctx.restore();
    });
  }

  /* ================= editor fixes ================= */
  // 0) Phone-keyboard reliability.
  //    - dragDrop off: long-press on selected text must move the selection handles, not start a "drag".
  //    - The keyboard opening/closing resizes the window; the old code refreshed the editor on every such
  //      resize, which made the keyboard flicker or close while typing / pressing backspace.
  editor.setOption("dragDrop", false);
  editor.setOption("spellcheck", false);
  editor.setOption("autocorrect", false);
  editor.setOption("autocapitalize", false);
  const origRefresh = editor.refresh.bind(editor);
  window.__cmRefreshNow = origRefresh; // used when the font size really changes
  let lastWidth = window.innerWidth;
  editor.refresh = function () {
    if (editor.hasFocus() && Math.abs(window.innerWidth - lastWidth) < 2) return; // keyboard only: skip
    lastWidth = window.innerWidth;
    origRefresh();
  };

  // Look of the editor (Darcula-like colours, small monospace font, no heavy borders)
  (function editorLook() {
    const st = document.createElement("style");
    st.textContent = `
      html body .CodeMirror{background:#2b2b2b!important;color:#a9b7c6!important;font-family:'JetBrains Mono','Roboto Mono','Droid Sans Mono',monospace!important;line-height:1.45}
      html body .CodeMirror-scroll{background:#2b2b2b!important}
      html body .CodeMirror-gutters{background:#2b2b2b!important;border-right:none!important}
      html body .CodeMirror-linenumber{color:#606366!important}
      html body .CodeMirror-activeline-background{background:#323232!important}
      html body .CodeMirror-selected{background:#214283!important}
      html body .CodeMirror-cursor{border-left:2px solid #bbbbbb!important}
      html body .cm-s-dracula .cm-keyword,html body .cm-s-dracula .cm-builtin,html body .cm-s-dracula .cm-atom{color:#cc7832!important;font-weight:normal!important}
      html body .cm-s-dracula .cm-def{color:#ffc66d!important;font-weight:normal!important}
      html body .cm-s-dracula .cm-variable,html body .cm-s-dracula .cm-operator{color:#a9b7c6!important}
      html body .cm-s-dracula .cm-variable-2{color:#94558d!important}
      html body .cm-s-dracula .cm-string,html body .cm-s-dracula .cm-string-2{color:#6a8759!important}
      html body .cm-s-dracula .cm-number{color:#6897bb!important}
      html body .cm-s-dracula .cm-comment{color:#808080!important;font-style:normal!important}
      html body .cm-s-dracula .cm-meta{color:#bbb529!important}`;
    document.head.appendChild(st);
    try { // smaller default text (13px) once; later you choose the size yourself
      if (!localStorage.getItem("py_acad_style_v2")) { localStorage.setItem("py_acad_style_v2", "1"); applyFontSize(13); }
    } catch (e) {}
  })();

  // Pinch with two fingers on the editor to make the text bigger / smaller
  (function pinchEditor() {
    const wrap = $("editor-wrap");
    let d0 = 0, f0 = 15, on = false;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    wrap.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) { on = true; d0 = dist(e.touches); f0 = prefs.fontSize; }
    }, { passive: true, capture: true });
    wrap.addEventListener("touchmove", (e) => {
      if (!on || e.touches.length !== 2) return;
      e.preventDefault();
      const size = Math.round(f0 * dist(e.touches) / d0);
      if (size !== prefs.fontSize) { applyFontSize(size); origRefresh(); }
    }, { passive: false, capture: true });
    wrap.addEventListener("touchend", (e) => { if (e.touches.length < 2) on = false; }, { passive: true, capture: true });
  })();

  // Settings: choose the editor engine (the new one is better on phones; "Classic" is the old one)
  (function engineRow() {
    const box = document.querySelector("#shortcuts-modal .modal-content");
    if (!box) return;
    const row = document.createElement("div");
    row.style.cssText = "margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;background:#191b1f;padding:8px 10px;border-radius:4px";
    row.innerHTML = "<span>✏️ Editor engine:</span>";
    const sel = document.createElement("select");
    sel.style.cssText = "background:#141414;color:#fff;border:1px solid #444;padding:4px 8px;border-radius:3px";
    [["cm6", "New (recommended)"], ["cm5", "Classic"]].forEach((o) => {
      const op = document.createElement("option"); op.value = o[0]; op.textContent = o[1]; sel.appendChild(op);
    });
    let cur = "cm6";
    try { cur = localStorage.getItem("py_acad_engine") || "cm6"; } catch (e) {}
    sel.value = cur;
    sel.onchange = () => { try { localStorage.setItem("py_acad_engine", sel.value); } catch (e) {} location.reload(); };
    row.appendChild(sel);
    box.insertBefore(row, box.firstChild);
  })();

  // 1) Bracket / quote auto-close. It reacts to the text CHANGE itself (not to key presses, which
  //    Android keyboards do not send), so it works with Gboard, Samsung keyboard etc.
  editor.setOption("autoCloseBrackets", false);
  const PAIRS = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'" };
  const CLOSERS = { ")": 1, "]": 1, "}": 1, '"': 1, "'": 1 };
  const WORD = /[A-Za-z0-9_]/;
  const SKIP = { undo: 1, redo: 1, setValue: 1, cut: 1, drag: 1, paste: 1, "+move": 1, complete: 1, "+autoclose": 1 };

  function autoPair(cm, ch, c) {
    const cur = cm.getCursor();
    if (cur.line !== ch.from.line || cur.ch !== ch.from.ch + 1) return;
    const line = cm.getLine(cur.line);
    const next = line.charAt(cur.ch);
    const prev = cur.ch >= 2 ? line.charAt(cur.ch - 2) : "";
    const isQuote = c === '"' || c === "'";
    if (CLOSERS[c] && next === c) { // typing the closing char: step over the existing one
      cm.replaceRange("", { line: cur.line, ch: cur.ch - 1 }, cur, "+autoclose");
      cm.setCursor({ line: cur.line, ch: cur.ch });
      return;
    }
    if (!PAIRS[c]) return;
    if (isQuote) {
      if (prev === c && cur.ch >= 3 && line.charAt(cur.ch - 3) === c) return; // triple quote
      if (WORD.test(prev) && !/(^|[^A-Za-z0-9_])[rRbBuUfF]{1,2}$/.test(line.slice(0, cur.ch - 1))) return; // don't, it's
    }
    if (WORD.test(next)) return;
    cm.replaceRange(PAIRS[c], cur, cur, "+autoclose");
    cm.setCursor(cur); // cursor stays between the pair
  }

  function autoUnpair(cm, ch, removed) { // backspace on an empty pair "()" removes both
    const closer = PAIRS[removed];
    if (closer && cm.getLine(ch.from.line).charAt(ch.from.ch) === closer) {
      cm.replaceRange("", ch.from, { line: ch.from.line, ch: ch.from.ch + 1 }, "+autoclose");
    }
  }

  editor.on("changes", (cm, changes) => {
    if (cm.__cm6 || changes.length !== 1) return; // the new editor closes brackets itself
    const ch = changes[0];
    if (SKIP[ch.origin] || cm.somethingSelected() || cm.listSelections().length !== 1) return;
    const ins = ch.text.length === 1 ? ch.text[0] : null;
    const rem = ch.removed.length === 1 ? ch.removed[0] : null;
    if (ins !== null && ins.length === 1 && rem === "") autoPair(cm, ch, ins);
    else if (ins === "" && rem !== null && rem.length === 1) autoUnpair(cm, ch, rem);
  });

  // Extra key row above the keyboard: always works, whatever keyboard you use
  (function keyRow() {
    const wrap = $("editor-wrap");
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:4px;padding:4px 6px;background:#1b1d22;border-top:1px solid #333;overflow-x:auto;flex-shrink:0";
    const keys = [["Tab", "tab"], ["↶", "undo"], ["↷", "redo"], ["( )", "()"], ["[ ]", "[]"], ["{ }", "{}"], ['" "', '""'], ["' '", "''"],
                  [":", ":"], ["=", "="], ["_", "_"], ["#", "#"], [".", "."], [",", ","], ["◀", "left"], ["▶", "right"]];
    keys.forEach((k) => {
      const b = document.createElement("button");
      b.className = "btn"; b.textContent = k[0]; b.style.cssText = "min-width:38px;justify-content:center;padding:5px 8px";
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.onclick = () => {
        const v = k[1];
        if (v === "tab") { if (editor.somethingSelected()) editor.indentSelection("add"); else editor.replaceSelection("    ", "end", "+autoclose"); }
        else if (v === "undo" || v === "redo") editor.execCommand(v);
        else if (v === "left") editor.execCommand("goCharLeft");
        else if (v === "right") editor.execCommand("goCharRight");
        else if (v.length === 2 && PAIRS[v[0]] === v[1]) {
          if (editor.somethingSelected()) editor.replaceSelection(v[0] + editor.getSelection() + v[1], "end", "+autoclose");
          else { editor.replaceSelection(v, "end", "+autoclose"); editor.execCommand("goCharLeft"); }
        } else editor.replaceSelection(v, "end", "+autoclose");
        editor.focus();
      };
      bar.appendChild(b);
    });
    wrap.parentNode.insertBefore(bar, wrap.nextSibling);
    setTimeout(() => editor.refresh(), 50);
  })();

  // 2) Shortcuts that were listed in the menu but did nothing
  editor.addKeyMap({ "Ctrl-H": (cm) => cm.execCommand("replace") });

  // 3) Opening a lesson must not auto-save its default code as a "draft";
  //    and unsaved typing must be saved to the OLD file before switching.
  const origOpenItem = window.openItem;
  window.openItem = function () {
    if (isDirty && currentItem) saveCurrentWork(false);
    try { return origOpenItem.apply(this, arguments); }
    finally { clearTimeout(autoSaveTimer); }
  };

  // 4) Download / share the current file (works inside the Android app too)
  window.downloadCurrentFile = async function () {
    const name = ($("active-filename").innerText || "script.py").replace(/[^\w.\-]/g, "_");
    const code = editor.getValue();
    const P = window.Capacitor && window.Capacitor.Plugins;
    if (P && P.Filesystem && P.Share) {
      try {
        const r = await P.Filesystem.writeFile({ path: name, data: code, directory: "CACHE", encoding: "utf8" });
        await P.Share.share({ title: name, url: r.uri, dialogTitle: "Save or share " + name });
        return;
      } catch (e) {
        if (/cancel/i.test(String((e && e.message) || e))) return;
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([code], { type: "text/x-python;charset=utf-8" }));
    a.download = name; a.click();
  };

  /* ================= wire up ================= */
  window.runPythonCode = runPythonCode;
  window.stopPythonExecution = stopPythonExecution;
  window.evaluateReplInput = evaluateReplInput;
  window.appendOutput = appendOutput;

  $("timeout-select").value = "120000"; // default: 120 s (Stop button always works)
  initRuntime();
})();
