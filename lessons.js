/* lessons.js — the text course (data: lessons-data.js).
   - Sidebar "📚 Lessons": 30 lessons grouped by part, ✓ marks and a progress bar (existing sidebar elements are reused).
   - "📚 Lesson" tab in the right panel: the lesson as real, selectable text.
   - "Mark lesson complete" saves progress and celebrates with falling paper confetti. */
(function () {
  "use strict";
  const C = window.COURSE;
  if (!C) return;
  const $ = (id) => document.getElementById(id);
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt) e.textContent = txt; return e; };

  /* ---------- text helpers (also used for detailed lesson text added later) ---------- */
  function inline(el, s) { // `code` and **bold**
    const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) el.appendChild(document.createTextNode(s.slice(last, m.index)));
      const tok = m[0];
      const node = mk(tok[0] === "`" ? "code" : "b");
      node.textContent = tok[0] === "`" ? tok.slice(1, -1) : tok.slice(2, -2);
      el.appendChild(node);
      last = m.index + tok.length;
    }
    if (last < s.length) el.appendChild(document.createTextNode(s.slice(last)));
  }

  function codeBlock(host, code) {
    const box = mk("div", "ls-code");
    const pre = mk("pre"); const c = mk("code", "", code);
    pre.appendChild(c); box.appendChild(pre);
    const bar = mk("div", "ls-code-bar");
    const copy = mk("button", "btn", "Copy");
    copy.onclick = () => { try { navigator.clipboard.writeText(code); copy.textContent = "Copied ✓"; setTimeout(() => { copy.textContent = "Copy"; }, 1200); } catch (e) {} };
    const ins = mk("button", "btn btn-primary", "→ Editor");
    ins.onclick = () => { if (window.editor) { editor.replaceSelection(code + "\n"); editor.focus(); } };
    bar.appendChild(copy); bar.appendChild(ins); box.appendChild(bar);
    host.appendChild(box);
  }

  function renderBlocks(text, host) {
    const lines = String(text).replace(/\r/g, "").split("\n");
    let para = [], ul = null, code = null;
    const flushPara = () => { if (para.length) { const p = mk("p"); inline(p, para.join(" ")); host.appendChild(p); para = []; } };
    lines.forEach((line) => {
      if (/^```/.test(line)) {
        if (code === null) { flushPara(); ul = null; code = []; } else { codeBlock(host, code.join("\n")); code = null; }
        return;
      }
      if (code !== null) { code.push(line); return; }
      let m;
      if (!line.trim()) { flushPara(); ul = null; return; }
      if ((m = /^##\s+(.*)$/.exec(line))) { flushPara(); ul = null; host.appendChild(mk("h4", "", m[1])); return; }
      if ((m = /^#\s+(.*)$/.exec(line))) { flushPara(); ul = null; host.appendChild(mk("h3", "", m[1])); return; }
      if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); ul = null; const n = mk("div", "ls-note"); inline(n, m[1]); host.appendChild(n); return; }
      if ((m = /^[-*]\s+(.*)$/.exec(line))) {
        flushPara();
        if (!ul) { ul = mk("ul"); host.appendChild(ul); }
        const li = mk("li"); inline(li, m[1]); ul.appendChild(li);
        return;
      }
      ul = null; para.push(line.trim());
    });
    flushPara();
    if (code !== null) codeBlock(host, code.join("\n"));
  }
  window.CourseText = { inline: inline, renderBlocks: renderBlocks };

  if (!$("exec-sheet")) return; // (no page: only the helpers above are wanted, e.g. in tests)

  /* ---------- progress ---------- */
  const KEY = "py_acad_course_v1";
  const S = { done: {}, last: 0 };
  try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} };
  const total = C.lessons.length;
  const isDone = (n) => !!S.done[n];
  const doneCount = () => C.lessons.filter((l) => isDone(l.n)).length;
  const pct = () => Math.round(doneCount() / total * 100);
  const partLessons = (p) => C.lessons.filter((l) => l.part === p);

  /* ---------- styles ---------- */
  const st = document.createElement("style");
  st.textContent = `
    .ls-part{padding:8px 12px 4px;background:#1e1f22;color:#9aa;font-size:10.5px;font-weight:700;letter-spacing:.3px;position:sticky;top:0;z-index:1}
    .ls-part .bar{height:3px;background:#141414;border-radius:2px;margin-top:4px;overflow:hidden}
    .ls-part .bar i{display:block;height:100%;background:#4ec9b0}
    .ls-num{display:inline-block;min-width:22px;color:#7a869a;font-weight:700;margin-right:6px}
    .ls-reset{margin:12px;padding:6px 10px;font-size:11px}
    .ls-bar{display:flex;align-items:center;gap:6px;padding:6px 8px;background:#1b1d22;border-bottom:1px solid #333;flex-shrink:0}
    #ls-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#4fc1ff;font-weight:700;font-size:12.5px}
    #lesson-body{flex:1;min-height:0;overflow:auto;padding:12px 14px;font-size:14px;line-height:1.6;color:#dcdcdc;-webkit-user-select:text;user-select:text;-webkit-overflow-scrolling:touch}
    #lesson-body h2{font-size:1.25em;color:#fff;margin:6px 0 10px}
    #lesson-body h3{font-size:1.05em;color:#ffc66d;margin:16px 0 6px}
    #lesson-body h4{font-size:1em;color:#6897bb;margin:12px 0 4px}
    #lesson-body p{margin:8px 0}
    #lesson-body ul{margin:6px 0 10px 20px}
    #lesson-body li{margin:5px 0}
    #lesson-body code{background:#2b2b2b;color:#e8bf6a;padding:1px 5px;border-radius:3px;font-family:'JetBrains Mono','Roboto Mono','Droid Sans Mono',monospace;font-size:.9em}
    .ls-chip{display:inline-block;background:#26303a;color:#7ec3f7;border-radius:10px;padding:2px 10px;font-size:11px;margin-bottom:4px}
    .ls-note{background:#2c2518;border-left:3px solid #ffca28;color:#f0e6d2;padding:8px 10px;margin:12px 0;font-size:.92em;border-radius:3px}
    .ls-step{margin:6px 0}
    .ls-code{margin:10px 0;background:#232323;border:1px solid #3a3a3a;border-radius:5px;overflow:hidden}
    .ls-code pre{margin:0;padding:10px;overflow:auto;font-size:.9em}
    .ls-code code{background:none;padding:0;color:#a9b7c6;white-space:pre}
    .ls-code-bar{display:flex;gap:6px;justify-content:flex-end;padding:4px 6px;background:#1b1d22}
    .ls-foot{flex-shrink:0;background:#1b1d22;border-top:1px solid #333;padding:6px 10px}
    .ls-prog{height:6px;background:#141414;border-radius:3px;overflow:hidden}
    #ls-prog-fill{height:100%;background:linear-gradient(90deg,#4ec9b0,#7ee08a);width:0;transition:width .5s}
    .ls-foot-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px;color:#aab;font-size:11.5px}
    #ls-done.is-done{background:#16825d;border-color:#1e9e73}
    .ls-toast{position:fixed;left:50%;top:64px;transform:translate(-50%,-20px);background:#1f2a24;border:1px solid #4ec9b0;color:#fff;padding:12px 18px;border-radius:12px;z-index:5001;text-align:center;font-size:14px;line-height:1.4;opacity:0;transition:all .35s;box-shadow:0 8px 24px rgba(0,0,0,.5);max-width:86vw}
    .ls-toast.on{opacity:1;transform:translate(-50%,0)}
    .ls-toast b{display:block;font-size:17px}`;
  document.head.appendChild(st);

  /* ---------- confetti: small pieces of coloured paper ---------- */
  function confetti(count) {
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const cv = document.createElement("canvas");
    cv.style.cssText = "position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:5000";
    const W = window.innerWidth, H = window.innerHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = W * dpr; cv.height = H * dpr;
    document.body.appendChild(cv);
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr);
    const colors = ["#f94144", "#f3722c", "#f9c74f", "#90be6d", "#43aa8b", "#4d9de0", "#b388eb", "#ff70a6", "#ffffff"];
    const bits = [];
    for (let i = 0; i < count; i++) {
      const cannon = i % 5 < 3; // 3 of 5 shoot up from the bottom corners, the rest rain from the top
      const left = Math.random() < 0.5;
      bits.push({
        x: cannon ? (left ? W * 0.05 : W * 0.95) : Math.random() * W,
        y: cannon ? H * 0.9 : -20 - Math.random() * H * 0.3,
        vx: cannon ? (left ? 1 : -1) * (180 + Math.random() * 520) : (Math.random() - 0.5) * 120,
        vy: cannon ? -(520 + Math.random() * 620) : 80 + Math.random() * 160,
        w: 6 + Math.random() * 7, h: 10 + Math.random() * 9,
        rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 12,
        flip: Math.random() * 6.28, vf: 4 + Math.random() * 8,
        c: colors[(Math.random() * colors.length) | 0]
      });
    }
    const DURATION = 3600;
    let t0 = 0, last = 0;
    function frame(t) {
      if (!t0) { t0 = t; last = t; }
      const dt = Math.min(0.05, (t - last) / 1000); last = t;
      const age = t - t0;
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = age > DURATION - 900 ? Math.max(0, (DURATION - age) / 900) : 1;
      bits.forEach((b) => {
        b.vy += 620 * dt;               // gravity
        b.vx *= 1 - 0.9 * dt;           // air drag
        b.vy = Math.min(b.vy, 330 + b.h * 4); // paper flutters down slowly
        b.x += b.vx * dt; b.y += b.vy * dt; b.rot += b.vr * dt; b.flip += b.vf * dt;
        ctx.save();
        ctx.translate(b.x, b.y); ctx.rotate(b.rot); ctx.scale(1, Math.cos(b.flip));
        ctx.fillStyle = b.c; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
        ctx.restore();
      });
      if (age < DURATION) requestAnimationFrame(frame); else cv.remove();
    }
    requestAnimationFrame(frame);
  }

  function toast(title, sub) {
    const t = mk("div", "ls-toast");
    const b = mk("b", "", title);
    t.appendChild(b); t.appendChild(document.createTextNode(sub));
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("on"));
    setTimeout(() => { t.classList.remove("on"); setTimeout(() => t.remove(), 400); }, 3800);
  }

  function celebrate(n) {
    const l = C.lessons[n - 1];
    const partDone = partLessons(l.part).every((x) => isDone(x.n));
    if (doneCount() === total) { confetti(320); toast("🎓 Course complete!", "You finished all " + total + " lessons. Amazing work!"); }
    else if (partDone) { confetti(240); toast("🏆 " + C.parts[l.part - 1].split(" — ")[0] + " complete!", pct() + "% of the course is done"); }
    else { confetti(150); toast("🎉 Lesson " + n + " complete!", "Well done — " + pct() + "% of the course is done"); }
  }

  /* ---------- sidebar list (reuses the existing search box and progress bar) ---------- */
  $("stab-lessons").textContent = "📚 Lessons";
  $("lesson-search").placeholder = "Search lessons...";

  function listRow(n, mark, title, meta) {
    const li = mk("li", "list-item" + (S.last === n ? " active" : ""));
    const box = mk("div");
    const t = mk("div");
    t.appendChild(mk("span", "ls-num", mark)); t.appendChild(document.createTextNode(title));
    box.appendChild(t); box.appendChild(mk("span", "item-meta", meta));
    li.appendChild(box);
    if (n > 0 && isDone(n)) li.appendChild(mk("span", "check-done", "✓"));
    li.onclick = () => openLesson(n);
    return li;
  }

  function renderCourseList() {
    const list = $("item-list");
    list.innerHTML = "";
    const q = ($("lesson-search").value || "").toLowerCase().trim();
    $("progress-text").textContent = doneCount() + " / " + total + " lessons • " + pct() + "%";
    $("progress-fill").style.width = pct() + "%";
    if (!q || "how to use this course start here".indexOf(q) >= 0) list.appendChild(listRow(0, "📌", "How to Use This Course", "Start here"));
    let lastPart = 0;
    C.lessons.forEach((l) => {
      if (q && (l.title + " " + l.topics.join(" ")).toLowerCase().indexOf(q) < 0) return;
      if (l.part !== lastPart) {
        lastPart = l.part;
        const pl = partLessons(l.part), d = pl.filter((x) => isDone(x.n)).length;
        const h = mk("li", "ls-part", C.parts[l.part - 1] + "  •  " + d + "/" + pl.length);
        const bar = mk("div", "bar"), fill = mk("i");
        fill.style.width = Math.round(d / pl.length * 100) + "%";
        bar.appendChild(fill); h.appendChild(bar);
        list.appendChild(h);
      }
      list.appendChild(listRow(l.n, isDone(l.n) ? "✓" : String(l.n), l.title, "Lesson " + l.n + " • " + C.parts[l.part - 1].split(" — ")[0]));
    });
    if (!q && doneCount() > 0) {
      const li = mk("li");
      const b = mk("button", "btn ls-reset", "↺ Reset progress");
      b.onclick = () => { if (confirm("Clear all lesson progress?")) { S.done = {}; save(); refresh(); } };
      li.appendChild(b); list.appendChild(li);
    }
  }
  const origRender = window.renderSidebarList;
  window.renderSidebarList = function () {
    if (prefs.sidebarMode === "lessons") renderCourseList(); else origRender();
  };

  /* ---------- reader tab ---------- */
  const tab = mk("button", "r-tab", "📚 Lesson");
  tab.id = "rtab-lesson";
  tab.onclick = () => switchRightTab("lesson");
  $("exec-sheet").querySelector(".r-tab-group").insertBefore(tab, $("rtab-pdf") || $("rtab-graphics"));

  const view = mk("div", "r-view");
  view.id = "view-lesson";
  view.innerHTML =
    '<div class="ls-bar"><button class="btn" id="ls-prev">◀</button><div id="ls-title"></div><button class="btn" id="ls-next">▶</button></div>' +
    '<div id="lesson-body"></div>' +
    '<div class="ls-foot"><div class="ls-prog"><div id="ls-prog-fill"></div></div>' +
    '<div class="ls-foot-row"><span id="ls-prog-text"></span><button class="btn btn-primary" id="ls-done"></button></div></div>';
  $("exec-sheet").appendChild(view);

  const prevSwitch = window.switchRightTab;
  window.switchRightTab = function (name) {
    prevSwitch(name);
    tab.classList.toggle("active", name === "lesson");
    view.classList.toggle("active", name === "lesson");
  };

  function renderReader() {
    const n = S.last, body = $("lesson-body");
    body.innerHTML = "";
    if (n === 0) {
      $("ls-title").textContent = "How to Use This Course";
      body.appendChild(mk("h2", "", "How to Use This Course"));
      const p = mk("p"); inline(p, C.howTo.intro); body.appendChild(p);
      C.howTo.steps.forEach((s) => {
        const d = mk("div", "ls-step");
        d.appendChild(mk("b", "", s[0] + ": ")); d.appendChild(document.createTextNode(s[1]));
        body.appendChild(d);
      });
      body.appendChild(mk("h3", "", "Course Overview"));
      const o = mk("p"); inline(o, C.howTo.overview); body.appendChild(o);
      const go = mk("button", "btn btn-primary", "Start Lesson 1 ▶");
      go.style.marginTop = "10px"; go.onclick = () => openLesson(1);
      body.appendChild(go);
    } else {
      const l = C.lessons[n - 1];
      $("ls-title").textContent = "Lesson " + n + " · " + l.title;
      body.appendChild(mk("span", "ls-chip", C.parts[l.part - 1] + "  ·  Lesson " + n + " of " + total));
      body.appendChild(mk("h2", "", l.title));
      if (l.content) renderBlocks(l.content, body);
      body.appendChild(mk("h3", "", l.content ? "Roadmap topics" : "What you will learn"));
      const ul = mk("ul");
      l.topics.forEach((t) => { const li = mk("li"); inline(li, t); ul.appendChild(li); });
      body.appendChild(ul);
      if (!l.content) body.appendChild(mk("div", "ls-note", "📝 This lesson shows its roadmap topics for now. The detailed explanation and examples are added here lesson by lesson."));
    }
    body.scrollTop = 0;
    renderFoot();
  }

  function renderFoot() {
    const n = S.last, btn = $("ls-done");
    $("ls-prog-fill").style.width = pct() + "%";
    $("ls-prog-text").textContent = "Knowledge: " + doneCount() + " / " + total + " lessons • " + pct() + "%";
    btn.style.display = n === 0 ? "none" : "";
    btn.classList.toggle("is-done", n > 0 && isDone(n));
    btn.textContent = n > 0 && isDone(n) ? "✓ Completed (tap to undo)" : "✓ Mark lesson complete";
    $("ls-prev").disabled = n <= 0;
    $("ls-next").disabled = n >= total;
  }

  function refresh() { renderCourseList(); renderFoot(); }

  function openLesson(n) {
    S.last = Math.max(0, Math.min(total, n));
    save();
    renderReader();
    if (prefs.sidebarMode === "lessons") renderCourseList();
    openExecutionSheet("lesson");
    closeSidebar();
  }

  $("ls-prev").onclick = () => openLesson(S.last - 1);
  $("ls-next").onclick = () => openLesson(S.last + 1);
  $("ls-done").onclick = () => {
    const n = S.last;
    if (n < 1) return;
    if (isDone(n)) { delete S.done[n]; save(); refresh(); return; }
    S.done[n] = Date.now();
    save(); refresh();
    celebrate(n);
  };

  /* ---------- start ---------- */
  switchSidebarTab("lessons");
  renderReader();
  if (isLandscapeMode()) openExecutionSheet("lesson");
})();
