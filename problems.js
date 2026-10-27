/* problems.js — loaded after ide-extras.js. Takes over the "⚠ Problems" tab with a richer, VS Code style view:
   every problem is a card with the error name, line and column, the source line with a ^^^ marker, a plain explanation,
   the call path (for errors while running) and a one-tap "✨ fix" button. While the code is not valid, the problems keep
   being shown (live check while typing). The same problems are drawn in the editor (red underline + marker). */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const listEl = $("prob-list"), infoEl = $("prob-info"), tab = $("rtab-problems");
  if (!listEl || !infoEl || !tab || !window.PyIDE || typeof editor === "undefined") return;

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt) e.textContent = txt; return e; };

  const css = document.createElement("style");
  css.textContent = `
    .pc{padding:10px 12px;border-bottom:1px solid #2b2b2c;cursor:pointer}
    .pc:active{background:#26282b}
    .pc-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .pc-dot{width:9px;height:9px;border-radius:50%;background:#f48771;flex-shrink:0}
    .pc-head b{color:#f48771}
    .pc-loc{color:#4fc1ff;font-weight:700;font-size:12px}
    .pc-kind{color:#7a869a;font-size:10.5px;border:1px solid #3a3f47;border-radius:8px;padding:0 6px}
    .pc-msg{color:#eaeaea;margin:5px 0;word-break:break-word}
    .pc-code{margin:6px 0;padding:7px 9px;background:#1b1b1b;border-left:3px solid #f48771;border-radius:3px;overflow-x:auto;
             font-family:'JetBrains Mono','Roboto Mono','Droid Sans Mono',monospace;font-size:12px;line-height:1.35;color:#c9d1d9;white-space:pre}
    .pc-why{color:#e3cf8f;font-size:12px;line-height:1.5;margin:6px 0}
    .pc-path{color:#8fb4d9;font-size:11.5px;margin:4px 0}
    .pc-fix{margin-top:6px;white-space:normal;text-align:left}
    .pc-bar{display:flex;gap:8px;align-items:center;padding:6px 10px;border-bottom:1px solid #2b2b2c;background:#1b1d22}
    .pc-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#2b2b2b;color:#fff;border:1px solid #555;border-radius:8px;padding:8px 14px;z-index:5002;font-size:12.5px}`;
  document.head.appendChild(css);

  let syn = [], run = [], lastRun = null, marked = [], checkTimer = null;

  const all = () => {
    const key = (p) => p.line + "|" + p.msg;
    const have = new Set(syn.map(key));
    return syn.concat(run.filter((p) => !have.has(key(p))));
  };

  const toast = (t) => {
    const d = el("div", "pc-toast", t);
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 2600);
  };

  function recheck(ms) {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      if (window.PyIDE.ready() && !window.PyIDE.busy()) window.PyIDE.send({ type: "check", code: editor.getValue() });
    }, ms);
  }

  function jump(p) {
    if (!p.line) return;
    const l = Math.max(0, Math.min(p.line - 1, editor.lineCount() - 1));
    editor.setCursor({ line: l, ch: Math.max(0, (p.col || 1) - 1) });
    editor.scrollIntoView({ line: l, ch: 0 }, 80);
    editor.focus();
  }

  function applyOne(p) {
    const f = p.fix;
    if (!f) return false;
    const li = f.line - 1;
    if (li < 0 || li >= editor.lineCount() || editor.getLine(li) !== p.text) return false; // the code changed after the check
    editor.replaceRange(f.text, { line: li, ch: f.col }, { line: li, ch: f.end_col });
    editor.setCursor({ line: li, ch: f.col + f.text.length });
    syn = syn.filter((x) => x !== p);
    run = run.filter((x) => x !== p);
    return true;
  }

  function applyFix(p) {
    if (!applyOne(p)) { toast("The code changed after this check. Checking again…"); recheck(0); return; }
    update(); recheck(150); editor.focus();
  }

  function fixAll() {
    let n = 0;
    syn.filter((p) => p.fix).sort((a, b) => b.line - a.line).forEach((p) => { if (applyOne(p)) n++; });
    toast(n ? "Applied " + n + " fix" + (n > 1 ? "es" : "") : "Nothing could be fixed automatically");
    update(); recheck(150); editor.focus();
  }

  function caretLine(p) {
    const c0 = Math.max(0, (p.col || 1) - 1);
    const len = Math.max(1, (p.end_col || p.col || 1) - 1 - c0);
    return " ".repeat(Math.min(c0, 200)) + "^".repeat(Math.min(len, 80));
  }

  function card(p) {
    const c = el("div", "pc");
    const head = el("div", "pc-head");
    head.appendChild(el("span", "pc-dot"));
    head.appendChild(el("b", "", p.type || "Error"));
    if (p.line) head.appendChild(el("span", "pc-loc", "Line " + p.line + (p.col ? ", Col " + p.col : "")));
    head.appendChild(el("span", "pc-kind", p.kind === "syntax" ? "syntax" : "while running"));
    c.appendChild(head);
    c.appendChild(el("div", "pc-msg", p.msg || ""));
    if (p.text && p.line) {
      const pre = el("pre", "pc-code");
      const gutter = String(p.line) + " | ";
      pre.textContent = gutter + p.text + "\n" + " ".repeat(gutter.length) + caretLine(p);
      c.appendChild(pre);
    }
    if (p.why) c.appendChild(el("div", "pc-why", "💡 " + p.why));
    if (p.frames && p.frames.length > 1) {
      c.appendChild(el("div", "pc-path", "📍 " + p.frames.map((f) => "line " + f.line + (f.func ? " in " + f.func + "()" : "")).join("  →  ")));
    }
    if (p.fix) {
      const b = el("button", "btn btn-primary pc-fix", "✨ " + p.fix.label);
      b.onclick = (ev) => { ev.stopPropagation(); applyFix(p); };
      c.appendChild(b);
    }
    c.onclick = () => jump(p);
    return c;
  }

  function markEditor(items) {
    const diags = items.filter((p) => p.line).map((p) => ({
      line: p.line, col: p.col, end_col: p.end_col, severity: "error",
      message: (p.type || "Error") + ": " + p.msg + (p.why ? "\n" + p.why : ""),
      actions: p.fix ? [{ name: p.fix.label, run: () => applyFix(p) }] : []
    }));
    if (typeof editor.setDiagnostics === "function") { editor.setDiagnostics(diags); return; }
    // classic editor: colour the lines only
    marked.forEach((l) => { if (l < editor.lineCount()) editor.removeLineClass(l, "background", "error-line-highlight"); });
    marked = diags.map((d) => d.line - 1).filter((l, i, a) => a.indexOf(l) === i && l >= 0 && l < editor.lineCount());
    marked.forEach((l) => editor.addLineClass(l, "background", "error-line-highlight"));
  }

  function update() {
    const items = all();
    tab.textContent = items.length ? "⚠ Problems (" + items.length + ")" : "⚠ Problems";
    tab.style.color = items.length ? "#f48771" : "";
    infoEl.textContent = lastRun
      ? "⏱ Last run: " + lastRun.secs + "s — " + (lastRun.ok ? "finished without errors" : "stopped because of an error")
      : "Mistakes are shown here while you type. Tap a card to jump to the line.";
    listEl.innerHTML = "";
    const fixable = syn.filter((p) => p.fix).length;
    if (fixable > 1) {
      const bar = el("div", "pc-bar");
      const b = el("button", "btn btn-primary", "✨ Fix all (" + fixable + ")");
      b.onclick = fixAll;
      bar.appendChild(b);
      bar.appendChild(el("span", "", items.length + " problems in this file"));
      listEl.appendChild(bar);
    }
    if (!items.length) {
      const d = el("div", "prob-empty", "✓ No problems found");
      d.style.cssText = "padding:16px;color:#6a9955";
      listEl.appendChild(d);
    } else {
      items.forEach((p) => listEl.appendChild(card(p)));
    }
    markEditor(items);
  }

  // answers of the live check (worker: {type:"problems", list:[...]})
  window.PyIDE.on("problems", (m) => {
    syn = (m.list || []).map((p) => Object.assign({ kind: "syntax" }, p));
    update();
  });
  window.PyIDE.onRunStart = () => { run = []; update(); };
  window.PyIDE.onRunDone = (m, secs) => {
    lastRun = { secs: secs, ok: !!m.ok };
    run = m.problem ? [m.problem] : [];
    if (m.problem && !m.ok && window.appendOutput) window.appendOutput("\n💡 Problems tab: explanation and a one-tap fix\n", "log-info");
    update();
  };

  // another file: its old problems no longer apply
  const prevOpen = window.openItem;
  window.openItem = function () {
    const r = prevOpen.apply(this, arguments);
    syn = []; run = []; lastRun = null;
    update(); recheck(1500);
    return r;
  };

  update();
})();
