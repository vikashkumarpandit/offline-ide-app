/* pdf-course.js (v2) — the PDF course lives in a "📖 PDF" tab beside Output / Console / Graphics.
   Landscape: editor on the left, this panel on the right. PDFs are stored inside the app (IndexedDB):
   add as many as you like, open any, delete any. Loaded after ide-runtime.js. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const LIB = "libs/pdfjs/";
  const CUR_KEY = "py_acad_pdf_cur_v2", POS_KEY = "py_acad_pdf_pos_v2:", ZOOM_KEY = "py_acad_pdf_zoom_v1";
  let pdf = null, pages = [], io = null, base = null, curId = null, zoom = 1, lastW = 0, timer = null;
  try { zoom = parseFloat(localStorage.getItem(ZOOM_KEY)) || 1; } catch (e) {}

  /* ---------- styles ---------- */
  const st = document.createElement("style");
  st.textContent = `
    #lesson-panel{display:none!important}
    #stab-lessons,#lesson-search-wrap{display:none!important}
    #view-pdf{position:relative}
    .pdf-bar{display:flex;gap:4px;align-items:center;padding:4px 6px;background:#1b1d22;border-bottom:1px solid #333;flex-shrink:0;flex-wrap:wrap}
    .pdf-bar input{width:54px;background:#141414;color:#fff;border:1px solid #444;border-radius:3px;padding:3px 4px;font-size:12px}
    .pdf-bar span{color:#aaa;font-size:11.5px}
    #pdf-scroll{flex:1;overflow:auto;background:#3a3a3d;min-height:0;position:relative;-webkit-overflow-scrolling:touch}
    #pdf-inner{display:flex;flex-direction:column;align-items:center;width:max-content;min-width:100%;padding:6px 0}
    .pdf-page{position:relative;margin:6px 8px;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.5);flex-shrink:0}
    .pdf-page canvas{display:block;width:100%;height:100%}
    .textLayer{position:absolute;inset:0;overflow:hidden;line-height:1;-webkit-user-select:text;user-select:text}
    .textLayer span{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0}
    .textLayer ::selection{background:rgba(0,120,215,.4)}
    .pdf-msg{padding:14px;color:#ddd;font-size:12.5px;line-height:1.5}
    #pdf-lib{position:absolute;inset:0;background:#1c1c1e;display:none;flex-direction:column;z-index:5}
    #pdf-lib .lib-head{display:flex;align-items:center;gap:6px;padding:8px;border-bottom:1px solid #333;color:#4fc1ff;font-weight:700}
    #pdf-lib .lib-list{flex:1;overflow:auto}
    #pdf-lib .lib-row{display:flex;align-items:center;gap:8px;padding:10px;border-bottom:1px solid #2b2b2c}
    #pdf-lib .lib-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#eee}
    #pdf-lib .lib-size{color:#888;font-size:11px;flex-shrink:0}`;
  document.head.appendChild(st);

  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt) e.textContent = txt; return e; };

  /* ---------- storage: PDFs stay inside the app ---------- */
  function idb(mode, fn) {
    return new Promise((res, rej) => {
      const r = indexedDB.open("py_acad_pdf", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("files");
      r.onerror = () => rej(r.error);
      r.onsuccess = () => {
        const db = r.result, tx = db.transaction("files", mode);
        const req = fn(tx.objectStore("files"));
        tx.oncomplete = () => { db.close(); res(req && req.result); };
        tx.onerror = () => rej(tx.error);
      };
    });
  }
  const listPdfs = async () => {
    const all = (await idb("readonly", (s) => s.getAll())) || [];
    all.forEach((x) => { if (!x.id) x.id = "course"; }); // PDFs saved by the first version
    return all.sort((a, b) => (b.added || 0) - (a.added || 0));
  };
  const savePdf = (rec) => idb("readwrite", (s) => s.put(rec, rec.id));
  const deletePdf = (id) => idb("readwrite", (s) => s.delete(id));

  /* ---------- UI: a tab inside the Output / Console panel ---------- */
  function buildUI() {
    const tab = mk("button", "r-tab", "📖 PDF");
    tab.id = "rtab-pdf";
    tab.onclick = () => switchRightTab("pdf");
    $("exec-sheet").querySelector(".r-tab-group").insertBefore(tab, $("rtab-graphics"));

    const view = mk("div", "r-view");
    view.id = "view-pdf";
    view.innerHTML =
      '<div class="pdf-bar">' +
      '<button class="btn btn-primary" id="pdf-libbtn" style="padding:2px 8px" title="My PDFs: add, open, delete">📚 PDFs</button>' +
      '<button class="btn" id="pdf-zout" style="padding:2px 8px">A−</button>' +
      '<button class="btn" id="pdf-zin" style="padding:2px 8px">A+</button>' +
      '<span>Page</span><input id="pdf-page" type="number" min="1" value="1"><span>/ <b id="pdf-total">…</b></span>' +
      '<button class="btn" id="pdf-insert" style="padding:2px 8px" title="Put the selected PDF text into the editor">📋 → Editor</button>' +
      '</div>' +
      '<div id="pdf-scroll"><div id="pdf-inner"></div></div>' +
      '<div id="pdf-lib"></div>' +
      '<input id="pdf-file" type="file" accept="application/pdf,.pdf" style="display:none">';
    $("exec-sheet").appendChild(view);

    // quick button in the top bar
    const top = document.querySelector(".top-right");
    const tb = mk("button", "btn", "📖 PDF");
    tb.title = "Show / hide the PDF course";
    tb.onclick = () => {
      if (execSheet.classList.contains("open") && view.classList.contains("active")) closeExecutionSheet();
      else openExecutionSheet("pdf");
    };
    top.insertBefore(tb, top.firstChild);

    window.switchRightTab = function (name) {
      ["output", "terminal", "graphics", "pdf"].forEach((t) => {
        const a = $("rtab-" + t), v = $("view-" + t);
        if (a) a.classList.toggle("active", t === name);
        if (v) v.classList.toggle("active", t === name);
      });
      if (name === "terminal") setTimeout(() => $("repl-input").focus(), 40);
      if (name === "pdf") setTimeout(layout, 60);
    };

    $("pdf-libbtn").onclick = showLibrary;
    $("pdf-zin").onclick = () => setZoom(zoom * 1.2);
    $("pdf-zout").onclick = () => setZoom(zoom / 1.2);
    $("pdf-page").onchange = () => {
      if (!pdf) return;
      const n = Math.min(pdf.numPages, Math.max(1, parseInt($("pdf-page").value, 10) || 1));
      $("pdf-scroll").scrollTop = pages[n - 1].el.offsetTop - 6;
    };
    $("pdf-insert").addEventListener("mousedown", (e) => e.preventDefault()); // keep the text selection
    $("pdf-insert").onclick = () => {
      const t = String(window.getSelection() || "").replace(/\u00a0/g, " ");
      if (!t.trim()) { alert("First select some text in the PDF (long-press a word, then drag the handles)."); return; }
      editor.replaceSelection(t); editor.focus();
    };
    $("pdf-file").onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f) return;
      const rec = { id: "p" + Date.now(), name: f.name, size: f.size, added: Date.now(), blob: f };
      try { await savePdf(rec); } catch (err) { alert("Could not store the PDF on this phone: " + err); return; }
      openRec(rec);
    };
    $("pdf-scroll").addEventListener("scroll", onScroll, { passive: true });
    new ResizeObserver(() => {
      const w = $("pdf-scroll").clientWidth;
      if (w && Math.abs(w - lastW) > 2) { clearTimeout(timer); timer = setTimeout(layout, 250); }
    }).observe($("pdf-scroll"));
  }

  /* ---------- library ---------- */
  async function showLibrary() {
    const box = $("pdf-lib");
    box.innerHTML = "";
    const head = mk("div", "lib-head");
    head.appendChild(mk("span", "", "📚 My PDFs"));
    head.lastChild.style.flex = "1";
    const add = mk("button", "btn btn-primary", "➕ Add PDF");
    add.onclick = () => $("pdf-file").click();
    const close = mk("button", "btn", "✕");
    close.onclick = () => { box.style.display = "none"; };
    head.appendChild(add);
    if (pdf) head.appendChild(close);
    box.appendChild(head);
    const list = mk("div", "lib-list");
    box.appendChild(list);
    let items = [];
    try { items = await listPdfs(); } catch (e) {}
    if (!items.length) {
      list.appendChild(mk("div", "pdf-msg", "No PDF yet. Tap “Add PDF” and pick your course file. It is saved inside this app (any size), so you pick it only once."));
    }
    items.forEach((rec) => {
      const row = mk("div", "lib-row");
      row.appendChild(mk("div", "lib-name", (rec.id === curId ? "▶ " : "") + rec.name));
      row.appendChild(mk("div", "lib-size", ((rec.size || (rec.blob && rec.blob.size) || 0) / 1048576).toFixed(1) + " MB"));
      const open = mk("button", "btn", "Open");
      open.onclick = () => openRec(rec);
      const del = mk("button", "btn", "🗑");
      del.style.background = "#3a2020";
      del.onclick = async () => {
        if (!confirm("Delete “" + rec.name + "” from this app?")) return;
        try { await deletePdf(rec.id); } catch (e) {}
        if (rec.id === curId) { closeDoc(); curId = null; try { localStorage.removeItem(CUR_KEY); } catch (e) {} }
        showLibrary();
      };
      row.appendChild(open); row.appendChild(del);
      list.appendChild(row);
    });
    box.style.display = "flex";
  }

  /* ---------- rendering ---------- */
  function setZoom(z) {
    zoom = Math.min(3, Math.max(0.6, z));
    try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch (e) {}
    layout();
  }

  function closeDoc() {
    if (io) io.disconnect();
    if (pdf) { try { pdf.destroy(); } catch (e) {} }
    pdf = null; pages = [];
    $("pdf-inner").innerHTML = "";
    $("pdf-total").textContent = "…";
  }

  function layout() {
    const scroll = $("pdf-scroll");
    const cw = scroll.clientWidth;
    lastW = cw;
    if (!pdf || !base || !cw) return;
    const ratio = scroll.scrollHeight ? scroll.scrollTop / scroll.scrollHeight : 0;
    const w = Math.max(200, cw - 16) * zoom;
    pages.forEach((p) => {
      p.el.style.width = w + "px";
      p.el.style.height = (w * base.height / base.width) + "px";
      unrender(p);
      io.unobserve(p.el); io.observe(p.el);
    });
    scroll.scrollTop = ratio * scroll.scrollHeight;
  }

  async function render(p) {
    if (p.busy || p.done) return;
    p.busy = true;
    const tok = p.tok, doc = pdf;
    try {
      const page = await doc.getPage(p.n);
      const w = parseFloat(p.el.style.width);
      const vp = page.getViewport({ scale: w / page.getViewport({ scale: 1 }).width });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cv = document.createElement("canvas");
      cv.width = Math.floor(vp.width * dpr); cv.height = Math.floor(vp.height * dpr);
      p.el.style.height = vp.height + "px";
      await page.render({ canvasContext: cv.getContext("2d"), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
      if (tok !== p.tok) return;
      const tl = mk("div", "textLayer");
      p.el.appendChild(cv); p.el.appendChild(tl);
      const tc = await page.getTextContent();
      if (tok !== p.tok) return;
      await pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: [] }).promise;
      p.done = true;
    } catch (e) { /* page stays blank; scrolling away and back retries */ }
    finally {
      p.busy = false;
      if (tok !== p.tok && p.vis && !p.done && doc === pdf) render(p);
    }
  }

  function unrender(p) {
    p.tok++; p.done = false;
    while (p.el.firstChild) p.el.removeChild(p.el.firstChild);
  }

  function onScroll() {
    const scroll = $("pdf-scroll");
    const y = scroll.scrollTop + scroll.clientHeight / 3;
    let cur = 1;
    for (let i = 0; i < pages.length; i++) { if (pages[i].el.offsetTop <= y) cur = i + 1; else break; }
    if (document.activeElement !== $("pdf-page")) $("pdf-page").value = cur;
    clearTimeout(onScroll.t);
    onScroll.t = setTimeout(() => {
      if (!curId) return;
      try { localStorage.setItem(POS_KEY + curId, String(scroll.scrollTop / Math.max(1, scroll.scrollHeight))); } catch (e) {}
    }, 400);
  }

  /* ---------- open ---------- */
  let libReady = null;
  function loadLib() {
    if (!libReady) libReady = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = LIB + "pdf.min.js";
      s.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + "pdf.worker.min.js"; res(); };
      s.onerror = () => rej(new Error("could not load the PDF engine"));
      document.head.appendChild(s);
    });
    return libReady;
  }

  async function openRec(rec) {
    $("pdf-lib").style.display = "none";
    closeDoc();
    curId = rec.id;
    try { localStorage.setItem(CUR_KEY, rec.id); } catch (e) {}
    const inner = $("pdf-inner");
    inner.appendChild(mk("div", "pdf-msg", "Opening “" + rec.name + "”…"));
    try {
      await loadLib();
      const data = new Uint8Array(await rec.blob.arrayBuffer());
      pdf = await pdfjsLib.getDocument({
        data: data, standardFontDataUrl: LIB + "standard_fonts/", cMapUrl: LIB + "cmaps/", cMapPacked: true
      }).promise;
      base = (await pdf.getPage(1)).getViewport({ scale: 1 });
    } catch (e) {
      pdf = null;
      inner.innerHTML = "";
      inner.appendChild(mk("div", "pdf-msg", "This PDF could not be opened (" + (e && e.message ? e.message : e) + "). Tap “📚 PDFs” to choose another."));
      return;
    }
    inner.innerHTML = "";
    $("pdf-total").textContent = pdf.numPages;
    $("pdf-page").max = pdf.numPages;
    const scroll = $("pdf-scroll");
    io = new IntersectionObserver((es) => es.forEach((e) => {
      const p = pages[parseInt(e.target.dataset.n, 10) - 1];
      if (!p) return;
      p.vis = e.isIntersecting;
      if (p.vis) render(p); else unrender(p);
    }), { root: scroll, rootMargin: "900px 0px" });
    for (let i = 1; i <= pdf.numPages; i++) {
      const el = mk("div", "pdf-page");
      el.dataset.n = i;
      inner.appendChild(el);
      pages.push({ n: i, el: el, tok: 0, busy: false, done: false, vis: false });
    }
    layout();
    let r = 0;
    try { r = parseFloat(localStorage.getItem(POS_KEY + rec.id)) || 0; } catch (e) {}
    scroll.scrollTop = r * scroll.scrollHeight;
  }

  async function init() {
    buildUI();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    let items = [];
    try { items = await listPdfs(); } catch (e) {}
    let want = null;
    try { want = localStorage.getItem(CUR_KEY); } catch (e) {}
    const rec = items.find((x) => x.id === want) || items[0];
    if (rec) openRec(rec); else showLibrary();
  }

  /* ---------- start with a scratch file; landscape shows the PDF at the right ---------- */
  if (!userFiles.length) {
    userFiles.push({ id: "uf_main", title: "main.py", code: 'print("Hello, Python!")\n', updatedAt: Date.now() });
    try { localStorage.setItem(STORAGE_KEYS.USER_FILES, JSON.stringify(userFiles)); } catch (e) {}
  }
  switchSidebarTab("projects");
  openItem(userFiles.find((f) => f.id === prefs.lastId) || userFiles[0], "project");

  init();
  if (isLandscapeMode()) openExecutionSheet("pdf");
})();
