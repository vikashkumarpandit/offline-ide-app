/* ide-extras.js — loaded after ide-runtime.js and pdf-course.js.
   1) Universal zoom (editor, PDF, console, output, graphics): Ctrl+wheel, two-finger pinch, Ctrl + / - / 0.
      Each panel remembers its own zoom. Browser zoom is never used.
   2) Mouse-drag panning in PDF and graphics (text selection and normal clicks are left alone).
   3) Esc closes the Find / Replace panel (and gives the focus back to the editor).
   4) Problems panel: live syntax check, run errors with hints, tap to jump to the line. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  const st = document.createElement("style");
  st.textContent = `
    .pannable{cursor:grab}
    .pannable.panning{cursor:grabbing;user-select:none}
    #turtle-canvas-wrap{align-items:flex-start!important;justify-content:flex-start!important}
    #turtle-canvas{margin:auto;flex-shrink:0}
    #prob-info{padding:6px 10px;color:#9aa;font-size:11.5px;border-bottom:1px solid #2b2b2c;flex-shrink:0}
    #prob-list{flex:1;overflow:auto}
    .prob{display:flex;gap:8px;padding:9px 10px;border-bottom:1px solid #2b2b2c;cursor:pointer}
    .prob:active{background:#2a2d2e}
    .prob .dot{width:9px;height:9px;border-radius:50%;margin-top:5px;flex-shrink:0;background:#f48771}
    .prob .ln{color:#4fc1ff;font-weight:700;margin-right:6px}
    .prob .msg{color:#e6e6e6;word-break:break-word}
    .prob .hint{color:#b9a76a;font-size:11.5px;margin-top:3px;line-height:1.4}
    .prob-empty{padding:16px;color:#6a9955}`;
  document.head.appendChild(st);

  /* ================= 1) universal zoom ================= */
  const KEY = "py_acad_zoom_v1";
  let Z = {};
  try { Z = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) {}
  const saveZ = () => { try { localStorage.setItem(KEY, JSON.stringify(Z)); } catch (e) {} };

  // kind "font": text size in px.  kind "scale": picture size factor.
  const P = {
    editor:   { el: "editor-wrap",        kind: "font",  def: 13, min: 10, max: 28 },
    console:  { el: "repl-history",       kind: "font",  def: 13, min: 8,  max: 32 },
    output:   { el: "output-log",         kind: "font",  def: 13, min: 8,  max: 32 },
    graphics: { el: "turtle-canvas-wrap", kind: "scale", def: 1,  min: 0.5, max: 4 },
    pdf:      { el: "pdf-scroll",         kind: "scale", def: 1,  min: 0.6, max: 3 }
  };
  let active = "editor";

  function getZ(n) {
    if (n === "editor") return prefs.fontSize;
    if (n === "pdf") return window.PdfView ? window.PdfView.get() : 1;
    return Z[n] !== undefined ? Z[n] : P[n].def;
  }

  function applyZ(n) {
    const p = P[n], el = $(p.el);
    if (!el) return;
    const v = getZ(n);
    if (n === "console" || n === "output") {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40; // keep auto-scroll working
      el.style.fontSize = v + "px";
      if (atBottom) el.scrollTop = el.scrollHeight;
    } else if (n === "graphics") {
      const cv = el.querySelector("canvas");
      if (!cv) return;
      const base = Math.min(600, Math.max(120, el.clientWidth - 16));
      cv.style.maxWidth = "none"; cv.style.width = (base * v) + "px"; cv.style.height = "auto"; // never distorted
    }
  }

  function setZ(n, v) {
    const p = P[n];
    v = clamp(v, p.min, p.max);
    if (n === "editor") {
      applyFontSize(Math.round(v));
      (window.__cmRefreshNow || editor.refresh).call(editor);
      return;
    }
    if (n === "pdf") { if (window.PdfView) window.PdfView.set(v); return; }
    Z[n] = p.kind === "font" ? Math.round(v) : Math.round(v * 100) / 100;
    saveZ();
    applyZ(n);
  }

  const stepZ = (n, dir) => setZ(n, P[n].kind === "font" ? getZ(n) + dir : getZ(n) * (dir > 0 ? 1.1 : 1 / 1.1));
  function resetZ(n) {
    setZ(n, P[n].def);
    if (n === "graphics") { const el = $(P.graphics.el); el.scrollLeft = 0; el.scrollTop = 0; }
  }

  Object.keys(P).forEach((n) => {
    const el = $(P[n].el);
    if (!el) return;
    ["pointerdown", "touchstart", "focusin"].forEach((ev) => el.addEventListener(ev, () => { active = n; }, true));

    // Ctrl + mouse wheel (also what a touchpad pinch sends)
    let acc = 0;
    el.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      acc += -e.deltaY;
      if (Math.abs(acc) >= 40) { stepZ(n, acc > 0 ? 1 : -1); acc = 0; }
    }, { passive: false });

    // two-finger pinch. (editor and PDF already have their own pinch handlers in ide-runtime.js / pdf-course.js)
    if (n === "console" || n === "output" || n === "graphics") {
      let d0 = 0, z0 = 1, on = false;
      el.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2) { on = true; d0 = dist(e.touches); z0 = getZ(n); active = n; }
      }, { passive: true });
      el.addEventListener("touchmove", (e) => {
        if (!on || e.touches.length !== 2) return;
        e.preventDefault();
        setZ(n, z0 * dist(e.touches) / d0);
      }, { passive: false });
      el.addEventListener("touchend", (e) => { if (e.touches.length < 2) on = false; }, { passive: true });
    }
  });

  // Ctrl + / - / 0 act on the panel you used last (and never zoom the whole browser page)
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key;
    if (k !== "=" && k !== "+" && k !== "-" && k !== "_" && k !== "0") return;
    e.preventDefault(); e.stopPropagation(); // also stops the older editor-only zoom handler
    if (k === "0") resetZ(active); else stepZ(active, k === "-" || k === "_" ? -1 : 1);
  }, true);

  // a new turtle canvas appears on every run: give it the saved zoom
  const gfxHost = $("turtle-canvas");
  if (gfxHost) new MutationObserver(() => applyZ("graphics")).observe(gfxHost, { childList: true });
  window.addEventListener("resize", () => applyZ("graphics"));
  applyZ("console"); applyZ("output");

  /* ================= 2) mouse-drag panning ================= */
  function enablePan(el, skip) {
    if (!el) return;
    el.classList.add("pannable");
    let s = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse") return; // touch already scrolls natively
      if (!(e.button === 1 || (e.button === 0 && !skip(e.target)))) return;
      s = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
      el.setPointerCapture(e.pointerId);
      el.classList.add("panning");
      e.preventDefault();
    });
    el.addEventListener("pointermove", (e) => {
      if (!s) return;
      el.scrollLeft = s.l - (e.clientX - s.x);
      el.scrollTop = s.t - (e.clientY - s.y);
    });
    const end = () => { s = null; el.classList.remove("panning"); };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }
  // PDF: dragging on a word selects text; dragging anywhere else moves the page. Graphics: always moves.
  enablePan($("pdf-scroll"), (t) => !!(t.closest && t.closest(".textLayer span")));
  enablePan($("turtle-canvas-wrap"), () => false);

  /* ================= 3) Esc closes the Find / Replace panel ================= */
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const t = e.target;
    const open = document.querySelector(".cm-panels .cm-search");
    const inPanel = t && t.closest && t.closest(".cm-panels");
    const inEditor = t && t.closest && t.closest("#editor-wrap");
    if (!open || !(inPanel || inEditor)) return;
    e.preventDefault(); e.stopPropagation(); // do not also close the output panel / sidebar
    editor.execCommand("closeSearch");
    editor.focus();
  }, true);

  /* ================= 4) Problems panel ================= */
  const probs = { syntax: [], runtime: [] };
  let lastRun = null, synLines = [];

  const tab = document.createElement("button");
  tab.className = "r-tab"; tab.id = "rtab-problems"; tab.textContent = "⚠ Problems";
  tab.onclick = () => switchRightTab("problems");
  $("exec-sheet").querySelector(".r-tab-group").insertBefore(tab, $("rtab-graphics"));

  const view = document.createElement("div");
  view.className = "r-view"; view.id = "view-problems";
  view.innerHTML = '<div id="prob-info"></div><div id="prob-list"></div>';
  $("exec-sheet").appendChild(view);

  const prevSwitch = window.switchRightTab;
  window.switchRightTab = function (name) {
    prevSwitch(name);
    tab.classList.toggle("active", name === "problems");
    view.classList.toggle("active", name === "problems");
  };

  function jump(p) {
    if (!p.line) return;
    const l = Math.max(0, Math.min(p.line - 1, editor.lineCount() - 1));
    editor.setCursor({ line: l, ch: Math.max(0, (p.col || 1) - 1) });
    editor.scrollIntoView({ line: l, ch: 0 }, 80);
    editor.focus();
  }

  function render() {
    const all = probs.syntax.concat(probs.runtime);
    tab.textContent = all.length ? "⚠ Problems (" + all.length + ")" : "⚠ Problems";
    $("prob-info").textContent = lastRun
      ? "⏱ Last run: " + lastRun.secs + "s — " + (lastRun.ok ? "finished without errors" : "stopped because of an error")
      : "Errors are checked while you type. Tap a problem to jump to its line.";
    const list = $("prob-list");
    list.innerHTML = "";
    if (!all.length) {
      const d = document.createElement("div");
      d.className = "prob-empty"; d.textContent = "✓ No problems found";
      list.appendChild(d);
      return;
    }
    all.forEach((p) => {
      const row = document.createElement("div");
      row.className = "prob";
      const dot = document.createElement("span"); dot.className = "dot";
      const body = document.createElement("div");
      const head = document.createElement("div");
      if (p.line) { const ln = document.createElement("span"); ln.className = "ln"; ln.textContent = "Line " + p.line; head.appendChild(ln); }
      const msg = document.createElement("span"); msg.className = "msg"; msg.textContent = (p.type || "Error") + ": " + p.msg;
      head.appendChild(msg);
      body.appendChild(head);
      if (p.hint) { const h = document.createElement("div"); h.className = "hint"; h.textContent = "💡 " + p.hint; body.appendChild(h); }
      row.appendChild(dot); row.appendChild(body);
      row.onclick = () => jump(p);
      list.appendChild(row);
    });
  }

  function markSyntaxLines() {
    synLines.forEach((l) => editor.removeLineClass(l, "background", "error-line-highlight"));
    synLines = probs.syntax.filter((p) => p.line && p.line <= editor.lineCount()).map((p) => p.line - 1);
    synLines.forEach((l) => editor.addLineClass(l, "background", "error-line-highlight"));
  }

  // live syntax check (the worker answers with {type:"problems", list:[...]})
  let timer = null;
  function scheduleCheck(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (window.PyIDE && window.PyIDE.ready() && !window.PyIDE.busy()) window.PyIDE.send({ type: "check", code: editor.getValue() });
    }, ms);
  }
  editor.on("change", () => scheduleCheck(700));
  window.PyIDE.on("problems", (m) => {
    probs.syntax = (m.list || []).map((p) => Object.assign({ kind: "syntax" }, p));
    markSyntaxLines();
    render();
  });

  // run results
  window.PyIDE.onRunStart = () => { probs.runtime = []; render(); };
  window.PyIDE.onRunDone = (m, secs) => {
    lastRun = { secs: secs, ok: !!m.ok };
    probs.runtime = m.problem ? [m.problem] : [];
    render();
  };

  // opening another file: its old problems no longer apply
  const prevOpen = window.openItem;
  window.openItem = function () {
    synLines.forEach((l) => editor.removeLineClass(l, "background", "error-line-highlight"));
    clearErrorHighlight();
    const r = prevOpen.apply(this, arguments);
    probs.syntax = []; probs.runtime = []; lastRun = null; synLines = [];
    render(); scheduleCheck(1500);
    return r;
  };
  render();
})();
