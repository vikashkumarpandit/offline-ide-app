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
  let activeTarget = null;

  function setStatus(t) {
    $("exec-status").innerText = t;
  }

  function updateConnectivityStatus() {
    const b = $("offline-badge");
    if (!b) return;
    if (failed) b.innerText = "🔴 Python Error";
    else if (!ready) b.innerText = "🟡 Loading Python…";
    else b.innerText = navigator.onLine
      ? "🟢 Offline Ready"
      : "🟢 Offline Active";
  }

  window.updateConnectivityStatus = updateConnectivityStatus;
  window.addEventListener("online", updateConnectivityStatus);
  window.addEventListener("offline", updateConnectivityStatus);

  function startWorker() {
    ready = false;
    failed = false;
    setStatus("Loading Python…");
    updateConnectivityStatus();

    try {
      worker = new Worker("py-worker.js");
      worker.onmessage = onWorkerMessage;

      worker.onerror = (ev) => {
        failed = true;
        appendOutput(
          "\n[Python runtime failed to start" +
          (ev && ev.message ? ": " + ev.message : "") +
          "]\n",
          "log-stderr"
        );
        setStatus("Runtime error");
        updateConnectivityStatus();
        endActive();
      };
    } catch (err) {
      failed = true;
      setStatus("Runtime error");
      appendOutput(
        "\n[Could not create Python Worker: " +
        String(err && err.message ? err.message : err) +
        "]\n",
        "log-stderr"
      );
      updateConnectivityStatus();
    }
  }

  function restartWorker() {
    try {
      if (worker) worker.terminate();
    } catch (e) {}

    queue = [];
    awaitingInput = false;
    pendingInputId = null;

    $("stdin-bar").style.display = "none";

    if (replCommandHistory.length) {
      replMore = false;
      updateReplPrefix();
      appendReplLine(
        "[Python restarted: console variables were reset]",
        "log-info"
      );
    }

    startWorker();
  }

  function send(m) {
    if (ready && worker) {
      worker.postMessage(m);
    } else {
      queue.push(m);
    }
  }

  /* ================= runtime initialization ================= */

  async function initRuntime() {
    updateConnectivityStatus();

    if (!("serviceWorker" in navigator)) {
      setStatus("Input service unsupported");
      appendOutput(
        "\n[This browser does not support Service Workers. " +
        "Python input() may not work here.]\n",
        "log-stderr"
      );
      startWorker();
      return;
    }

    try {
      await navigator.serviceWorker.register("./sw.js");
      await navigator.serviceWorker.ready;

      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          let settled = false;
          let timer;

          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            navigator.serviceWorker.removeEventListener(
              "controllerchange",
              finish
            );
            resolve();
          };

          timer = setTimeout(finish, 5000);

          navigator.serviceWorker.addEventListener(
            "controllerchange",
            finish,
            { once: true }
          );
        });
      }

      if (!navigator.serviceWorker.controller) {
        let alreadyReloaded = false;

        try {
          alreadyReloaded =
            sessionStorage.getItem("offlineide-sw-reload-once") === "1";
        } catch (e) {}

        if (!alreadyReloaded) {
          try {
            sessionStorage.setItem("offlineide-sw-reload-once", "1");
          } catch (e) {}

          location.reload();
          return;
        }

        setStatus("Input service unavailable");

        appendOutput(
          "\n[Service Worker is not controlling this page. " +
          "input() may fail in this environment.]\n",
          "log-stderr"
        );
      } else {
        try {
          sessionStorage.removeItem("offlineide-sw-reload-once");
        } catch (e) {}
      }
    } catch (err) {
      setStatus("Input service initialization failed");

      appendOutput(
        "\n[Could not initialize input service: " +
        String(err && err.message ? err.message : err) +
        "]\n",
        "log-stderr"
      );
    }

    startWorker();
  }

  /* ================= worker messages ================= */

  function onWorkerMessage(ev) {
    const m = ev.data;

    switch (m.type) {
      case "ready": {
        ready = true;
        swOK = !!m.input;

        if (activeTarget === null) {
          setStatus(swOK ? "Idle" : "Input service unavailable");
        }

        updateConnectivityStatus();

        if (!swOK) {
          appendOutput(
            "\n[Python loaded, but input() is unavailable. " +
            "Check sw.js and Service Worker support.]\n",
            "log-stderr"
          );
        }

        const q = queue;
        queue = [];

        q.forEach((x) => worker.postMessage(x));
        break;
      }

      case "out":
        if (m.target === "repl") {
          appendRepl(
            m.text,
            m.err ? "repl-err-line" : "repl-out-line"
          );
        } else {
          appendOutput(
            m.text,
            m.err ? "log-stderr" : "log-stdout"
          );
        }
        break;

      case "gfx":
        drawGfx(m.cmds);
        break;

      case "input":
        handleInputRequest(m);
        break;

      case "done":
        onDone(m);
        break;

      case "fatal":
        failed = true;
        updateConnectivityStatus();
        appendOutput(
          "\n[Python worker reported a fatal error.]\n",
          "log-stderr"
        );
        endActive();
        break;
    }
  }

  /* ================= timeout handling ================= */

  function startWatchdog() {
    stopWatchdog();
    usedMs = 0;

    watchdog = setInterval(() => {
      if (!ready || awaitingInput) return;

      usedMs += 250;

      const limit = parseInt(
        $("timeout-select").value || "120000",
        10
      );

      if (usedMs >= limit) onTimeout(limit);
    }, 250);
  }

  function stopWatchdog() {
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
  }

  function onTimeout(limit) {
    const msg =
      "\n[Time limit reached (" +
      Math.round(limit / 1000) +
      "s). Raise it in settings if needed.]\n";

    const t = activeTarget;

    restartWorker();

    if (t === "repl") {
      appendRepl(msg, "repl-err-line");
    } else {
      appendOutput(msg, "log-stderr");
    }

    setStatus("Timed out");
    endActive();
  }

  function endActive() {
    stopWatchdog();

    if (activeTarget === "repl" || replBusy) {
      replBusy = false;
      replMore = false;
      updateReplPrefix();
    }

    isRunning = false;
    activeTarget = null;

    $("run-btn").disabled = false;
    $("stop-btn").style.display = "none";
    $("stdin-bar").style.display = "none";

    awaitingInput = false;
    pendingInputId = null;
  }

  function onDone(m) {
    if (m.target === "repl") {
      stopWatchdog();

      replBusy = false;
      activeTarget = null;
      replMore = !!m.more;

      replEnsureNewline();
      updateReplPrefix();

      $("stop-btn").style.display = "none";
      setStatus("Idle");
      $("repl-input").focus();

      return;
    }

    const el = ((performance.now() - runStart) / 1000).toFixed(2);

    if (m.ok) {
      appendOutput(
        "\n[Program exited with code 0 in " + el + "s]",
        "log-meta"
      );
      setStatus("Done (" + el + "s)");
    } else {
      appendOutput(
        "\n[Program stopped because of an error after " + el + "s]",
        "log-meta"
      );
      setStatus("Error");

      if (m.line && m.line > 0 && m.line <= editor.lineCount()) {
        activeErrorLine = m.line - 1;
        editor.addLineClass(
          activeErrorLine,
          "background",
          "error-line-highlight"
        );
        editor.scrollIntoView(
          { line: activeErrorLine, ch: 0 },
          80
        );
      }

      openExecutionSheet("output");
    }

    endActive();
  }

  /* ================= output log ================= */

  const OUT_MAX = 400000;
  let outBuf = [];
  let outRaf = 0;
  let outChars = 0;

  function appendOutput(text, cls) {
    outBuf.push([text, cls || "log-stdout"]);

    if (!outRaf) {
      outRaf = requestAnimationFrame(flushOutput);
    }
  }

  function flushOutput() {
    outRaf = 0;

    const log = $("output-log");

    if (!log.firstChild) outChars = 0;

    const items = outBuf;
    outBuf = [];

    const frag = document.createDocumentFragment();

    for (let i = 0; i < items.length;) {
      let t = items[i][0];
      const c = items[i][1];
      i++;

      while (i < items.length && items[i][1] === c) {
        t += items[i][0];
        i++;
      }

      const s = document.createElement("span");
      s.className = c;
      s.textContent = t;

      frag.appendChild(s);
      outChars += t.length;
    }

    log.appendChild(frag);

    while (outChars > OUT_MAX && log.childNodes.length > 1) {
      const n = log.firstChild;
      outChars -= n.textContent.length;
      log.removeChild(n);
    }

    log.scrollTop = log.scrollHeight;
  }

  /* ================= run / stop ================= */

  function runPythonCode() {
    if (isRunning) {
      openExecutionSheet();
      return;
    }

    if (replBusy) {
      restartWorker();
      replBusy = false;
    }

    clearErrorHighlight();
    saveCurrentWork(false);

    const code = editor.getValue();
    const graphical = usesTurtleGraphics(code);

    isRunning = true;
    stopRequested = false;
    activeTarget = "run";

    $("run-btn").disabled = true;
    $("stop-btn").style.display = "inline-flex";
    $("stdin-bar").style.display = "none";

    outBuf = [];
    outChars = 0;
    $("output-log").innerHTML = "";

    setStatus(ready ? "Running..." : "Loading Python…");

    if (!ready) {
      appendOutput(
        "[Loading the Python runtime — please wait…]\n",
        "log-info"
      );
    }

    if (graphical) {
      setupGfx();
      $("rtab-graphics").classList.remove("hidden-tab");
      openExecutionSheet("graphics");
    } else {
      $("rtab-graphics").classList.add("hidden-tab");
      openExecutionSheet("output");
    }

    runStart = performance.now();
    startWatchdog();

    send({ type: "run", code: code });
  }

  function stopPythonExecution() {
    if (activeTarget === null) return;

    stopRequested = true;
    const t = activeTarget;

    restartWorker();

    if (t === "repl") {
      appendRepl("\n[Stopped]\n", "repl-err-line");
    } else {
      appendOutput("\n[Execution stopped by user]", "log-stderr");
    }

    setStatus("Stopped");
    endActive();
  }

  /* ================= input() ================= */

  function replyInput(id, value) {
    awaitingInput = false;

    const sw =
      navigator.serviceWorker &&
      navigator.serviceWorker.controller;

    if (sw) {
      sw.postMessage({
        type: "input-reply",
        id: id,
        value: value
      });
    } else {
      appendOutput(
        "\n[Input response could not be sent: Service Worker unavailable.]\n",
        "log-stderr"
      );
      setStatus("Input service unavailable");
    }
  }

  function handleInputRequest(m) {
    awaitingInput = true;

    if (m.target === "repl") {
      const v = window.prompt(m.prompt || "input:");

      appendRepl(
        (v === null ? "" : v) + "\n",
        "repl-cmd-line"
      );

      replyInput(m.id, v);
      return;
    }

    pendingInputId = m.id;

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
    replyInput(id, v);
  }

  /* Remove old Skulpt-era listeners and attach the current input handlers. */
  (function bindStdin() {
    const oldInput = $("stdin-input");
    const oldBtn = $("stdin-submit");

    if (!oldInput || !oldBtn) return;

    const inp = oldInput.cloneNode(true);
    const btn = oldBtn.cloneNode(true);

    oldInput.parentNode.replaceChild(inp, oldInput);
    oldBtn.parentNode.replaceChild(btn, oldBtn);

    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitStdin();
      }
    });

    btn.addEventListener("click", submitStdin);
  })();

  /* ================= Python console (REPL) ================= */

  function appendReplLine(text, cls) {
    const h = $("repl-history");
    const d = document.createElement("div");

    d.className = cls;
    d.textContent = text;

    h.appendChild(d);
    h.scrollTop = h.scrollHeight;
  }

  let replLastChar = "\n";

  function appendRepl(text, cls) {
    if (!text) return;

    const h = $("repl-history");
    const s = document.createElement("span");

    s.className = cls;
    s.textContent = text;

    h.appendChild(s);
    h.scrollTop = h.scrollHeight;

    replLastChar = text.charAt(text.length - 1);
  }

  function replEnsureNewline() {
    if (replLastChar !== "\n") {
      appendRepl("\n", "repl-out-line");
    }
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

    if (cmd) {
      replCommandHistory.push(raw);
      replHistoryIndex = replCommandHistory.length;
    }

    if (!replMore && (cmd === "clear" || cmd === "cls")) {
      $("repl-history").innerHTML = "";
      replLastChar = "\n";
      return;
    }

    appendReplLine(
      (replMore ? "... " : ">>> ") + raw,
      "repl-cmd-line"
    );

    replLastChar = "\n";

    if (!replMore && /^(pip|sudo|apt|pkg|ls|dir|bash|sh)\b/.test(cmd)) {
      appendReplLine(
        "[Note] '" + cmd.split(" ")[0] +
        "' is an OS shell command. This is a Python console.",
        "repl-err-line"
      );
      return;
    }

    replBusy = true;
    activeTarget = "repl";

    $("stop-btn").style.display = "inline-flex";
    setStatus(ready ? "Running..." : "Loading Python…");

    startWatchdog();
    send({ type: "repl", line: raw });
  }

  /* ================= turtle graphics canvas ================= */

  const GW = 600;
  const GH = 440;

  const PPS = [
    Infinity, 40, 80, 150, 250, 400,
    600, 900, 1400, 2200, 3500
  ];

  let gfx = null;
  let gfxMult = 1;

  function addSpeedPicker() {
    const tb = document.querySelector(".gfx-toolbar");

    if (!tb || $("gfx-speed")) return;

    const sel = document.createElement("select");
    sel.id = "gfx-speed";
    sel.style.cssText =
      "background:#141414;color:#fff;border:1px solid #444;" +
      "border-radius:3px;font-size:10.5px;padding:1px 3px";

    [
      ["1", "Speed: as in code"],
      ["3", "Faster ×3"],
      ["10", "Faster ×10"],
      ["inf", "Instant"]
    ].forEach((o) => {
      const op = document.createElement("option");
      op.value = o[0];
      op.textContent = o[1];
      sel.appendChild(op);
    });

    sel.onchange = () => {
      gfxMult = sel.value === "inf"
        ? Infinity
        : parseFloat(sel.value);

      if (gfx && !gfx.raf && gfx.queue.length) {
        gfx.raf = requestAnimationFrame(playGfx);
      }
    };

    tb.insertBefore(sel, tb.lastElementChild);
  }

  function setupGfx() {
    if (gfx && gfx.raf) {
      cancelAnimationFrame(gfx.raf);
    }

    const host = $("turtle-canvas");
    host.innerHTML = "";

    const cv = document.createElement("canvas");
    cv.width = GW;
    cv.height = GH;
    cv.style.cssText = "display:block;max-width:100%;height:auto;";
    host.appendChild(cv);

    const layer = document.createElement("canvas");
    layer.width = GW;
    layer.height = GH;

    gfx = {
      cv: cv,
      ctx: cv.getContext("2d"),
      layer: layer,
      lctx: layer.getContext("2d"),
      sprites: {},
      bg: "#ffffff",
      queue: [],
      raf: 0,
      prog: 0,
      last: 0
    };

    addSpeedPicker();
    renderGfx();
  }

  function drawGfx(cmds) {
    if (!gfx) {
      setupGfx();
      $("rtab-graphics").classList.remove("hidden-tab");
    }

    for (let i = 0; i < cmds.length; i++) {
      gfx.queue.push(cmds[i]);
    }

    if (!gfx.raf) {
      gfx.raf = requestAnimationFrame(playGfx);
    }
  }

  const lerp = (a, b, t) => a + (b - a) * t;

  function stroke(c, p0, p1) {
    if (c[0] !== "L") return;

    const L = gfx.lctx;
    L.strokeStyle = c[5];
    L.lineWidth = c[6];
    L.lineCap = "round";

    L.beginPath();

    L.moveTo(
      GW / 2 + lerp(c[1], c[3], p0),
      GH / 2 - lerp(c[2], c[4], p0)
    );

    L.lineTo(
      GW / 2 + lerp(c[1], c[3], p1),
      GH / 2 - lerp(c[2], c[4], p1)
    );

    L.stroke();
  }

  function moveSprite(c, p, ang) {
    const old = gfx.sprites[c[8]] || { vis: true };

    gfx.sprites[c[8]] = {
      x: lerp(c[1], c[3], p),
      y: lerp(c[2], c[4], p),
      h: ang,
      color: c[5],
      vis: old.vis
    };
  }

  function playGfx(ts) {
    const g = gfx;
    if (!g) return;

    g.raf = 0;

    const dt = g.last
      ? Math.min(0.1, (ts - g.last) / 1000)
      : 0.016;

    g.last = ts;

    let budget = dt;
    let guard = 0;

    while (g.queue.length && guard++ < 5000) {
      const c = g.queue[0];

      if (c[0] === "L" || c[0] === "M") {
        const len = Math.hypot(
          c[3] - c[1],
          c[4] - c[2]
        );

        const spd = Math.max(0, Math.min(10, c[7] | 0));

        const pps =
          (spd === 0 || gfxMult === Infinity)
            ? Infinity
            : PPS[spd] * gfxMult;

        const ang =
          Math.atan2(c[4] - c[2], c[3] - c[1]) *
          180 / Math.PI;

        if (len === 0 || pps === Infinity) {
          stroke(c, 0, 1);
          moveSprite(c, 1, ang);
          g.queue.shift();
          g.prog = 0;
          continue;
        }

        const need = len / pps;
        const remaining = (1 - g.prog) * need;

        if (budget >= remaining) {
          stroke(c, g.prog, 1);
          moveSprite(c, 1, ang);

          budget -= remaining;
          g.queue.shift();
          g.prog = 0;
          continue;
        }

        const next = g.prog + budget / need;

        stroke(c, g.prog, next);
        moveSprite(c, next, ang);

        g.prog = next;
        budget = 0;
        break;
      }

      drawCmd(g.queue.shift());
    }

    renderGfx();

    if (g.queue.length) {
      g.raf = requestAnimationFrame(playGfx);
    } else {
      g.last = 0;
    }
  }

  function drawCmd(c) {
    const L = gfx.lctx;
    const X = (x) => GW / 2 + x;
    const Y = (y) => GH / 2 - y;

    switch (c[0]) {
      case "F":
        L.fillStyle = c[2];
        L.beginPath();

        c[1].forEach((p, i) => {
          if (i) L.lineTo(X(p[0]), Y(p[1]));
          else L.moveTo(X(p[0]), Y(p[1]));
        });

        L.closePath();
        L.fill();
        break;

      case "D":
        L.fillStyle = c[4];
        L.beginPath();
        L.arc(X(c[1]), Y(c[2]), c[3] / 2, 0, 7);
        L.fill();
        break;

      case "T":
        L.fillStyle = c[4];
        L.font = c[5];
        L.textAlign =
          c[6] === "center"
            ? "center"
            : c[6] === "right"
              ? "right"
              : "left";

        L.fillText(c[3], X(c[1]), Y(c[2]));
        break;

      case "C":
        L.clearRect(0, 0, GW, GH);
        break;

      case "B":
        gfx.bg = c[1];
        break;

      case "S":
        gfx.sprites[c[1]] = {
          x: c[2],
          y: c[3],
          h: c[4],
          color: c[5],
          vis: c[6]
        };
        break;
    }
  }

  function renderGfx() {
    const g = gfx;
    const ctx = g.ctx;

    ctx.fillStyle = g.bg;
    ctx.fillRect(0, 0, GW, GH);
    ctx.drawImage(g.layer, 0, 0);

    Object.keys(g.sprites).forEach((k) => {
      const s = g.sprites[k];
      if (!s.vis) return;

      ctx.save();
      ctx.translate(GW / 2 + s.x, GH / 2 - s.y);
      ctx.rotate(-s.h * Math.PI / 180);
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.moveTo(12, 0);
      ctx.lineTo(-8, 6);
      ctx.lineTo(-5, 0);
      ctx.lineTo(-8, -6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
  }

  /* ================= editor fixes ================= */

  editor.setOption("dragDrop", false);
  editor.setOption("spellcheck", false);
  editor.setOption("autocorrect", false);
  editor.setOption("autocapitalize", false);

  const origRefresh = editor.refresh.bind(editor);
  let lastWidth = window.innerWidth;

  editor.refresh = function () {
    if (
      editor.hasFocus() &&
      Math.abs(window.innerWidth - lastWidth) < 2
    ) {
      return;
    }

    lastWidth = window.innerWidth;
    origRefresh();
  };

  editor.setOption("autoCloseBrackets", false);

  const PAIRS = {
    "(": ")",
    "[": "]",
    "{": "}",
    '"': '"',
    "'": "'"
  };

  const CLOSERS = {
    ")": 1,
    "]": 1,
    "}": 1,
    '"': 1,
    "'": 1
  };

  const WORD = /[A-Za-z0-9_]/;

  const SKIP = {
    undo: 1,
    redo: 1,
    setValue: 1,
    cut: 1,
    drag: 1,
    paste: 1,
    "+move": 1,
    complete: 1,
    "+autoclose": 1
  };

  function autoPair(cm, ch, c) {
    const cur = cm.getCursor();

    if (
      cur.line !== ch.from.line ||
      cur.ch !== ch.from.ch + 1
    ) return;

    const line = cm.getLine(cur.line);
    const next = line.charAt(cur.ch);
    const prev = cur.ch >= 2
      ? line.charAt(cur.ch - 2)
      : "";

    const isQuote = c === '"' || c === "'";

    if (CLOSERS[c] && next === c) {
      cm.replaceRange(
        "",
        { line: cur.line, ch: cur.ch - 1 },
        cur,
        "+autoclose"
      );

      cm.setCursor({ line: cur.line, ch: cur.ch });
      return;
    }

    if (!PAIRS[c]) return;

    if (isQuote) {
      if (
        prev === c &&
        cur.ch >= 3 &&
        line.charAt(cur.ch - 3) === c
      ) return;

      if (
        WORD.test(prev) &&
        !/(^|[^A-Za-z0-9_])[rRbBuUfF]{1,2}$/.test(
          line.slice(0, cur.ch - 1)
        )
      ) return;
    }

    if (WORD.test(next)) return;

    cm.replaceRange(PAIRS[c], cur, cur, "+autoclose");
    cm.setCursor(cur);
  }

  function autoUnpair(cm, ch, removed) {
    const closer = PAIRS[removed];

    if (
      closer &&
      cm.getLine(ch.from.line).charAt(ch.from.ch) === closer
    ) {
      cm.replaceRange(
        "",
        ch.from,
        { line: ch.from.line, ch: ch.from.ch + 1 },
        "+autoclose"
      );
    }
  }

  editor.on("changes", (cm, changes) => {
    if (changes.length !== 1) return;

    const ch = changes[0];

    if (
      SKIP[ch.origin] ||
      cm.somethingSelected() ||
      cm.listSelections().length !== 1
    ) return;

    const ins = ch.text.length === 1 ? ch.text[0] : null;
    const rem = ch.removed.length === 1 ? ch.removed[0] : null;

    if (ins !== null && ins.length === 1 && rem === "") {
      autoPair(cm, ch, ins);
    } else if (ins === "" && rem !== null && rem.length === 1) {
      autoUnpair(cm, ch, rem);
    }
  });

  /* Extra keyboard row for mobile */
  (function keyRow() {
    const wrap = $("editor-wrap");
    const bar = document.createElement("div");

    bar.style.cssText =
      "display:flex;gap:4px;padding:4px 6px;" +
      "background:#1b1d22;border-top:1px solid #333;" +
      "overflow-x:auto;flex-shrink:0";

    const keys = [
      ["Tab", "tab"],
      ["( )", "()"],
      ["[ ]", "[]"],
      ["{ }", "{}"],
      ['" "', '""'],
      ["' '", "''"],
      [":", ":"],
      ["=", "="],
      ["_", "_"],
      ["#", "#"],
      [".", "."],
      [",", ","],
      ["◀", "left"],
      ["▶", "right"]
    ];

    keys.forEach((k) => {
      const b = document.createElement("button");

      b.className = "btn";
      b.textContent = k[0];
      b.style.cssText =
        "min-width:38px;justify-content:center;padding:5px 8px";

      b.addEventListener("mousedown", (e) => e.preventDefault());

      b.onclick = () => {
        const v = k[1];

        if (v === "tab") {
          if (editor.somethingSelected()) {
            editor.indentSelection("add");
          } else {
            editor.replaceSelection("    ", "end", "+autoclose");
          }
        } else if (v === "left") {
          editor.execCommand("goCharLeft");
        } else if (v === "right") {
          editor.execCommand("goCharRight");
        } else if (v.length === 2 && PAIRS[v[0]] === v[1]) {
          if (editor.somethingSelected()) {
            editor.replaceSelection(
              v[0] + editor.getSelection() + v[1],
              "end",
              "+autoclose"
            );
          } else {
            editor.replaceSelection(v, "end", "+autoclose");
            editor.execCommand("goCharLeft");
          }
        } else {
          editor.replaceSelection(v, "end", "+autoclose");
        }

        editor.focus();
      };

      bar.appendChild(b);
    });

    wrap.parentNode.insertBefore(bar, wrap.nextSibling);
    setTimeout(() => editor.refresh(), 50);
  })();

  editor.addKeyMap({
    "Ctrl-H": (cm) => cm.execCommand("replace")
  });

  /* Save the old file before switching lessons */
  const origOpenItem = window.openItem;

  window.openItem = function () {
    if (isDirty && currentItem) saveCurrentWork(false);

    try {
      return origOpenItem.apply(this, arguments);
    } finally {
      clearTimeout(autoSaveTimer);
    }
  };

  /* Download / share current file */
  window.downloadCurrentFile = async function () {
    const name = (
      $("active-filename").innerText || "script.py"
    ).replace(/[^\w.\-]/g, "_");

    const code = editor.getValue();

    const P = window.Capacitor && window.Capacitor.Plugins;

    if (P && P.Filesystem && P.Share) {
      try {
        const r = await P.Filesystem.writeFile({
          path: name,
          data: code,
          directory: "CACHE",
          encoding: "utf8"
        });

        await P.Share.share({
          title: name,
          url: r.uri,
          dialogTitle: "Save or share " + name
        });

        return;
      } catch (e) {
        if (/cancel/i.test(String((e && e.message) || e))) {
          return;
        }
      }
    }

    const a = document.createElement("a");

    a.href = URL.createObjectURL(
      new Blob([code], {
        type: "text/x-python;charset=utf-8"
      })
    );

    a.download = name;
    a.click();
  };

  /* ================= wire up ================= */

  window.runPythonCode = runPythonCode;
  window.stopPythonExecution = stopPythonExecution;
  window.evaluateReplInput = evaluateReplInput;
  window.appendOutput = appendOutput;

  $("timeout-select").value = "120000";

  initRuntime();
})();