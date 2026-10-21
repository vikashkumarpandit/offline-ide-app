/* pdf-course.js — replaces the 18 lessons with a scrollable PDF course (course.pdf) shown above the editor.
   Text in the PDF can be selected and copied. Loaded after ide-runtime.js. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const LIB = "libs/pdfjs/";
  let courseName = "Python Course (PDF)";
  const titleText = () => "📖 " + courseName;
  const POS_KEY = "py_acad_pdf_pos_v1", ZOOM_KEY = "py_acad_pdf_zoom_v1";
  let pdf = null, pages = [], zoom = 1, io = null, base = null, posTimer = null;

  try { zoom = parseFloat(localStorage.getItem(ZOOM_KEY)) || 1; } catch (e) {}

  /* ---------- styles ---------- */
  const st = document.createElement("style");
  st.textContent = `
    #lesson-panel:not(.collapsed){height:55%;max-height:70%}
    #lesson-panel.tall:not(.collapsed){height:82%;max-height:88%}
    #lesson-panel .lesson-nav-btns,#lesson-panel .lesson-title-area>span:last-child{display:none}
    #stab-lessons,#lesson-search-wrap{display:none!important}
    #lesson-panel .lesson-body{padding:0;display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
    #lesson-explanation,#lesson-panel .lesson-grid{display:none}
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
    .pdf-msg.err{color:#f48771}`;
  document.head.appendChild(st);

  /* ---------- UI ---------- */
  function buildUI() {
    const body = document.querySelector("#lesson-panel .lesson-body");
    const bar = document.createElement("div");
    bar.className = "pdf-bar";
    bar.innerHTML =
      '<button class="btn btn-primary" id="pdf-open" style="padding:2px 8px" title="Choose your PDF">📂 PDF</button>' +
      '<input id="pdf-file" type="file" accept="application/pdf,.pdf" style="display:none">' +
      '<button class="btn" id="pdf-zout" style="padding:2px 8px">A−</button>' +
      '<button class="btn" id="pdf-zin" style="padding:2px 8px">A+</button>' +
      '<span>Page</span><input id="pdf-page" type="number" min="1" value="1"><span>/ <b id="pdf-total">…</b></span>' +
      '<button class="btn" id="pdf-tall" style="padding:2px 8px" title="Taller / shorter panel">⤢</button>' +
      '<button class="btn btn-primary" id="pdf-insert" style="padding:2px 8px" title="Put the selected PDF text into the editor">📋 → Editor</button>';
    const scroll = document.createElement("div");
    scroll.id = "pdf-scroll";
    scroll.innerHTML = '<div id="pdf-inner"><div class="pdf-msg">Loading course PDF…</div></div>';
    body.appendChild(bar);
    body.appendChild(scroll);

    $("pdf-open").onclick = pick;
    $("pdf-file").onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f) return;
      try { await saveCourse(f); } catch (err) { alert("Could not store the PDF on this phone: " + err); }
      try { localStorage.setItem(POS_KEY, "0"); } catch (err) {}
      openBlob({ blob: f, name: f.name });
    };
    $("pdf-zin").onclick = () => setZoom(zoom * 1.2);
    $("pdf-zout").onclick = () => setZoom(zoom / 1.2);
    $("pdf-tall").onclick = () => { $("lesson-panel").classList.toggle("tall"); settle(); };
    $("pdf-page").onchange = () => {
      if (!pdf) return;
      const n = Math.min(pdf.numPages, Math.max(1, parseInt($("pdf-page").value, 10) || 1));
      scroll.scrollTop = pages[n - 1].el.offsetTop - 6;
    };
    $("pdf-insert").addEventListener("mousedown", (e) => e.preventDefault()); // keep the text selection
    $("pdf-insert").onclick = () => {
      const t = String(window.getSelection() || "").replace(/\u00a0/g, " ");
      if (!t.trim()) { alert("First select some text in the PDF (long-press a word, drag the handles)."); return; }
      editor.replaceSelection(t); editor.focus();
    };
    scroll.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", () => { clearTimeout(posTimer); posTimer = setTimeout(settle, 300); });
  }

  function settle() { layout(); editor.refresh(); }

  function setZoom(z) {
    zoom = Math.min(3, Math.max(0.6, z));
    try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch (e) {}
    layout();
  }

  /* ---------- pages ---------- */
  function layout() {
    if (!pdf || !base) return;
    const scroll = $("pdf-scroll");
    const ratio = scroll.scrollHeight ? scroll.scrollTop / scroll.scrollHeight : 0;
    const w = Math.max(200, scroll.clientWidth - 16) * zoom;
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
    const tok = p.tok;
    try {
      const page = await pdf.getPage(p.n);
      const w = parseFloat(p.el.style.width);
      const vp = page.getViewport({ scale: w / page.getViewport({ scale: 1 }).width });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cv = document.createElement("canvas");
      cv.width = Math.floor(vp.width * dpr); cv.height = Math.floor(vp.height * dpr);
      p.el.style.height = vp.height + "px";
      await page.render({ canvasContext: cv.getContext("2d"), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
      if (tok !== p.tok) return;
      const tl = document.createElement("div");
      tl.className = "textLayer";
      p.el.appendChild(cv); p.el.appendChild(tl);
      const tc = await page.getTextContent();
      if (tok !== p.tok) return;
      await pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: [] }).promise;
      p.done = true;
    } catch (e) { /* page stays blank; scrolling away and back retries */ }
    finally {
      p.busy = false;
      if (tok !== p.tok && p.vis && !p.done) render(p);
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
    clearTimeout(posTimer);
    posTimer = setTimeout(() => {
      try { localStorage.setItem(POS_KEY, String(scroll.scrollTop / Math.max(1, scroll.scrollHeight))); } catch (e) {}
    }, 400);
  }

  /* ---------- load ---------- */
  let libReady = null;
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = () => rej(new Error("could not load " + src));
      document.head.appendChild(s);
    });
  }
  function loadLib() {
    if (!libReady) libReady = loadScript(LIB + "pdf.min.js").then(() => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + "pdf.worker.min.js";
    });
    return libReady;
  }

  // The PDF is stored on the phone (IndexedDB): any size works, it survives app restarts, no internet needed.
  function idb(fn) {
    return new Promise((res, rej) => {
      const r = indexedDB.open("py_acad_pdf", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("files");
      r.onerror = () => rej(r.error);
      r.onsuccess = () => {
        const db = r.result, tx = db.transaction("files", "readwrite");
        const req = fn(tx.objectStore("files"));
        tx.oncomplete = () => { db.close(); res(req && req.result); };
        tx.onerror = () => rej(tx.error);
      };
    });
  }
  const saveCourse = (f) => idb((s) => s.put({ blob: f, name: f.name }, "course"));
  const loadCourse = () => idb((s) => s.get("course"));

  function pick() { $("pdf-file").click(); }

  function showPick(text) {
    const inner = $("pdf-inner");
    inner.innerHTML = "";
    const d = document.createElement("div");
    d.className = "pdf-msg";
    d.textContent = text;
    const b = document.createElement("button");
    b.className = "btn btn-primary";
    b.style.cssText = "display:block;margin-top:10px";
    b.textContent = "📂 Choose your PDF";
    b.onclick = pick;
    d.appendChild(b);
    inner.appendChild(d);
  }

  async function openBlob(rec) {
    const inner = $("pdf-inner"), scroll = $("pdf-scroll");
    inner.innerHTML = '<div class="pdf-msg">Opening PDF…</div>';
    try {
      await loadLib();
      if (pdf) { try { pdf.destroy(); } catch (e) {} }
      if (io) io.disconnect();
      pages = []; pdf = null;
      const data = new Uint8Array(await rec.blob.arrayBuffer());
      pdf = await pdfjsLib.getDocument({
        data: data, standardFontDataUrl: LIB + "standard_fonts/", cMapUrl: LIB + "cmaps/", cMapPacked: true
      }).promise;
      base = (await pdf.getPage(1)).getViewport({ scale: 1 });
    } catch (e) {
      pdf = null;
      showPick("This PDF could not be opened (" + (e && e.message ? e.message : e) + "). Choose another file.");
      return;
    }
    courseName = String(rec.name || "Python Course").replace(/\.pdf$/i, "");
    $("lesson-title").innerText = titleText();
    $("pdf-total").textContent = pdf.numPages;
    $("pdf-page").max = pdf.numPages;
    inner.innerHTML = "";
    io = new IntersectionObserver((es) => es.forEach((e) => {
      const p = pages[parseInt(e.target.dataset.n, 10) - 1];
      p.vis = e.isIntersecting;
      if (p.vis) render(p); else unrender(p);
    }), { root: scroll, rootMargin: "900px 0px" });
    for (let i = 1; i <= pdf.numPages; i++) {
      const el = document.createElement("div");
      el.className = "pdf-page"; el.dataset.n = i;
      inner.appendChild(el);
      pages.push({ n: i, el: el, tok: 0, busy: false, done: false, vis: false });
    }
    layout();
    let r = 0;
    try { r = parseFloat(localStorage.getItem(POS_KEY)) || 0; } catch (e) {}
    scroll.scrollTop = r * scroll.scrollHeight;
  }

  async function init() {
    buildUI();
    try {
      const rec = await loadCourse();
      if (rec && rec.blob) { await openBlob(rec); return; }
    } catch (e) { /* fall through to the picker */ }
    showPick("Choose your Python course PDF once. It is stored on this phone, so there is no size limit and no internet is needed.");
  }

  /* ---------- replace lessons by the PDF ---------- */
  const prevOpen = window.openItem;
  window.openItem = function () {
    const r = prevOpen.apply(this, arguments);
    $("lesson-panel").style.display = "flex"; // the PDF stays visible for every file
    $("lesson-title").innerText = titleText();
    return r;
  };

  $("lesson-panel").classList.remove("collapsed");
  $("guide-toggle-icon").innerText = "▼";
  $("lesson-title").innerText = titleText();

  // start with a scratch file instead of "Lesson 1"
  if (!userFiles.length) {
    userFiles.push({ id: "uf_main", title: "main.py", code: 'print("Hello, Python!")\n', updatedAt: Date.now() });
    try { localStorage.setItem(STORAGE_KEYS.USER_FILES, JSON.stringify(userFiles)); } catch (e) {}
  }
  switchSidebarTab("projects");
  openItem(userFiles.find((f) => f.id === prefs.lastId) || userFiles[0], "project");

  init();
})();
