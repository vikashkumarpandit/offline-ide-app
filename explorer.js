/* explorer.js — the "📁 My Files" list becomes a File Explorer with folders.
   A file's name is its path ("utils/helpers.py"), so no other part of the app has to change.
   Empty folders are remembered in their own list. On every run all files are copied into Python's file system
   (see ide-runtime.js / py-worker.js), so  import helpers  and  open("data/notes.txt")  work between your files. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt) e.textContent = txt; return e; };

  /* ---------- pure helpers (also used by the tests) ---------- */
  function cleanPath(s) {
    s = String(s == null ? "" : s).trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
    if (!s || /(^|\/)\.\.?(\/|$)/.test(s) || /[:*?"<>|\u0000-\u001f]/.test(s)) return null;
    return s;
  }
  const curLang = () => (window.getCodeNovaLang ? window.getCodeNovaLang() : "python");
  const defaultExt = () => (curLang() === "c" ? ".c" : ".py");
  const withExt = (p) => (p.split("/").pop().indexOf(".") > 0 ? p : p + defaultExt());
  const dirOf = (p) => (p.lastIndexOf("/") < 0 ? "" : p.slice(0, p.lastIndexOf("/")));
  const cmp = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());

  function buildTree(files, folderList) {
    const root = { name: "", path: "", dirs: {}, files: [] };
    const dir = (path) => {
      let node = root;
      if (!path) return node;
      path.split("/").forEach((part) => {
        const p = node.path ? node.path + "/" + part : part;
        if (!node.dirs[part]) node.dirs[part] = { name: part, path: p, dirs: {}, files: [] };
        node = node.dirs[part];
      });
      return node;
    };
    folderList.forEach((f) => dir(f));
    files.forEach((f) => dir(dirOf(f.title)).files.push({ file: f, name: f.title.slice(f.title.lastIndexOf("/") + 1) }));
    return root;
  }
  const countFiles = (node) => node.files.length + Object.keys(node.dirs).reduce((n, k) => n + countFiles(node.dirs[k]), 0);

  window.ExplorerLogic = { cleanPath: cleanPath, withExt: withExt, buildTree: buildTree, dirOf: dirOf };

  if (typeof userFiles === "undefined" || typeof STORAGE_KEYS === "undefined" || typeof prefs === "undefined" || !$("item-list")) return;

  /* ---------- state ---------- */
  const FKEY = "py_acad_folders_v1", SKEY = "py_acad_explorer_v1";
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  let folders = load(FKEY, []);
  const st = Object.assign({ expanded: {}, selected: "" }, load(SKEY, {}));
  const persist = () => {
    try {
      localStorage.setItem(STORAGE_KEYS.USER_FILES, JSON.stringify(userFiles));
      localStorage.setItem(FKEY, JSON.stringify(folders));
      localStorage.setItem(SKEY, JSON.stringify(st));
    } catch (e) {}
  };

  const css = document.createElement("style");
  css.textContent = `
    .ex-row{padding:7px 8px!important;gap:4px!important}
    .ex-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ex-btns{display:flex;gap:3px;flex-shrink:0}
    .ex-btn{padding:1px 6px!important;font-size:11px!important;background:#33363a!important}
    .ex-btn.del{background:#3a2020!important}
    .ex-root{color:#9aa;font-size:11px;padding:6px 10px;border-bottom:1px solid #2b2b2c;cursor:pointer}
    .ex-root.on{color:#4fc1ff}
    .ex-empty{padding:14px;color:#888;font-size:12px}`;
  document.head.appendChild(css);

  const norm = (s) => String(s);
  const fileAt = (path) => userFiles.find((f) => norm(f.title) === path);
  const folderExists = (p) => folders.indexOf(p) >= 0 || userFiles.some((f) => norm(f.title).indexOf(p + "/") === 0);
  const exists = (p) => !!fileAt(p) || folderExists(p);

  function addFolderChain(path) { // "a/b/c" -> a, a/b, a/b/c
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (folders.indexOf(p) < 0) folders.push(p);
    }
  }

  function openFallback() {
    if (userFiles.length) { openItem(userFiles[0], "project"); return; }
    const f = { id: "uf_" + Date.now(), title: "main.py", code: 'print("Hello, Python!")\n', updatedAt: Date.now() };
    userFiles.push(f); persist(); openItem(f, "project");
  }

  function currentIs(pred) { return typeof currentItem !== "undefined" && currentItem && currentItem.itemType === "project" && pred(currentItem); }

  /* ---------- actions ---------- */
  function newFile(defaultName, initialCode, inFolder) {
    const base = inFolder !== undefined ? inFolder : st.selected;
    const name = prompt("New file name" + (base ? " (inside " + base + "/)" : "") + ":", defaultName || ("script" + defaultExt()));
    if (name === null) return;
    const rel = cleanPath(name);
    if (!rel) { alert("Please use a simple name like notes.py or folder/notes.py"); return; }
    const full = withExt(base ? base + "/" + rel : rel);
    if (exists(full)) { alert("A file or folder with this name already exists."); return; }
    const f = { id: "uf_" + Date.now(), title: full, code: initialCode !== undefined ? initialCode : "# " + full + "\n\nprint(\"Running " + full + "\")\n", updatedAt: Date.now() };
    userFiles.unshift(f);
    if (dirOf(full)) { addFolderChain(dirOf(full)); st.expanded[dirOf(full)] = true; }
    persist();
    switchSidebarTab("projects");
    openItem(f, "project");
  }

  function newFolder(inFolder) {
    const base = inFolder !== undefined ? inFolder : st.selected;
    const name = prompt("New folder name" + (base ? " (inside " + base + "/)" : "") + ":", "folder");
    if (name === null) return;
    const rel = cleanPath(name);
    if (!rel) { alert("Please use a simple folder name."); return; }
    const full = base ? base + "/" + rel : rel;
    if (exists(full)) { alert("A file or folder with this name already exists."); return; }
    addFolderChain(full);
    st.expanded[full] = true; st.selected = full;
    if (base) st.expanded[base] = true;
    persist(); renderExplorer();
  }

  function renameFile(f) {
    const input = prompt("Rename / move file (use folder/name.py to move it):", norm(f.title));
    if (input === null) return;
    const rel = cleanPath(input);
    if (!rel) { alert("That name is not allowed."); return; }
    const np = withExt(rel);
    if (np !== norm(f.title) && exists(np)) { alert("A file or folder with this name already exists."); return; }
    f.title = np;
    if (dirOf(np)) addFolderChain(dirOf(np));
    persist();
    if (currentIs((c) => c.id === f.id)) { currentItem.title = np; $("active-filename").innerText = np; }
    renderExplorer();
  }

  function renameFolder(path) {
    const input = prompt("Rename / move folder:", path);
    if (input === null) return;
    const np = cleanPath(input);
    if (!np) { alert("That name is not allowed."); return; }
    if (np === path) return;
    if (np.indexOf(path + "/") === 0) { alert("A folder cannot be moved into itself."); return; }
    if (exists(np)) { alert("A file or folder with this name already exists."); return; }
    const re = (p) => (p === path ? np : p.indexOf(path + "/") === 0 ? np + p.slice(path.length) : p);
    userFiles.forEach((f) => { f.title = re(norm(f.title)); });
    folders = folders.map(re);
    addFolderChain(np);
    const ex = {};
    Object.keys(st.expanded).forEach((k) => { ex[re(k)] = st.expanded[k]; });
    st.expanded = ex; st.expanded[np] = true;
    st.selected = re(st.selected);
    persist();
    if (currentIs(() => true)) { const cur = fileAt(norm(currentItem.title)) || userFiles.find((f) => f.id === currentItem.id); if (cur) { currentItem.title = norm(cur.title); $("active-filename").innerText = norm(cur.title); } }
    renderExplorer();
  }

  function deleteFile(f) {
    if (!confirm("Delete '" + norm(f.title) + "' permanently?")) return;
    const wasOpen = currentIs((c) => c.id === f.id);
    userFiles.splice(userFiles.indexOf(f), 1);
    persist();
    if (wasOpen) openFallback(); else renderExplorer();
  }

  function deleteFolder(path) {
    const inside = userFiles.filter((f) => norm(f.title).indexOf(path + "/") === 0);
    if (!confirm("Delete folder '" + path + "' and the " + inside.length + " file(s) inside it?")) return;
    const wasOpen = currentIs((c) => inside.some((f) => f.id === c.id));
    inside.forEach((f) => userFiles.splice(userFiles.indexOf(f), 1));
    folders = folders.filter((p) => p !== path && p.indexOf(path + "/") !== 0);
    if (st.selected === path || st.selected.indexOf(path + "/") === 0) st.selected = dirOf(path);
    persist();
    if (wasOpen) openFallback(); else renderExplorer();
  }

  /* ---------- drawing ---------- */
  const icon = (name) => (/\.py$/i.test(name) ? "🐍" : /\.json$/i.test(name) ? "🧾" : /\.csv$/i.test(name) ? "📊" : "📄");

  function smallBtn(label, title, fn, extra) {
    const b = mk("button", "btn ex-btn" + (extra ? " " + extra : ""), label);
    b.title = title;
    b.onclick = (ev) => { ev.stopPropagation(); fn(); };
    return b;
  }

  function folderRow(d, depth) {
    const li = mk("li", "list-item ex-row" + (st.selected === d.path ? " active" : ""));
    li.style.paddingLeft = (8 + depth * 14) + "px";
    const open = !!st.expanded[d.path];
    li.appendChild(mk("span", "ex-name", (open ? "▾ 📂 " : "▸ 📁 ") + d.name + "  (" + countFiles(d) + ")"));
    const bt = mk("div", "ex-btns");
    bt.appendChild(smallBtn("＋", "New file in this folder", () => newFile(undefined, undefined, d.path)));
    bt.appendChild(smallBtn("✏️", "Rename / move", () => renameFolder(d.path)));
    bt.appendChild(smallBtn("🗑", "Delete folder", () => deleteFolder(d.path), "del"));
    li.appendChild(bt);
    li.onclick = () => { st.expanded[d.path] = !open; st.selected = d.path; persist(); renderExplorer(); };
    return li;
  }

  function fileRow(x, depth) {
    const f = x.file;
    const li = mk("li", "list-item ex-row" + (currentIs((c) => c.id === f.id) ? " active" : ""));
    li.style.paddingLeft = (8 + depth * 14) + "px";
    li.appendChild(mk("span", "ex-name", icon(x.name) + " " + x.name));
    const bt = mk("div", "ex-btns");
    bt.appendChild(smallBtn("✏️", "Rename / move", () => renameFile(f)));
    bt.appendChild(smallBtn("🗑", "Delete file", () => deleteFile(f), "del"));
    li.appendChild(bt);
    li.onclick = () => { st.selected = dirOf(norm(f.title)); persist(); openItem(f, "project"); };
    return li;
  }

  function renderExplorer() {
    const list = $("item-list");
    list.innerHTML = "";
    const root = mk("li", "ex-root" + (st.selected === "" ? " on" : ""), "📦 Project root" + (st.selected ? "   (new files go into: " + st.selected + "/ — tap here for the root)" : "   — new files go here"));
    root.onclick = () => { st.selected = ""; persist(); renderExplorer(); };
    list.appendChild(root);
    const tree = buildTree(userFiles, folders);
    const walk = (node, depth) => {
      Object.keys(node.dirs).sort(cmp).forEach((k) => {
        const d = node.dirs[k];
        list.appendChild(folderRow(d, depth));
        if (st.expanded[d.path]) walk(d, depth + 1);
      });
      node.files.sort((a, b) => cmp(a.name, b.name)).forEach((x) => list.appendChild(fileRow(x, depth)));
    };
    walk(tree, 0);
    if (!userFiles.length && !folders.length) list.appendChild(mk("li", "ex-empty", "No files yet. Tap '+ New " + defaultExt() + " File' or the folder button above."));
  }

  /* ---------- hook into the existing sidebar ---------- */
  const prevRender = window.renderSidebarList;
  window.renderSidebarList = function () {
    if (prefs.sidebarMode === "projects") renderExplorer(); else prevRender();
  };
  window.createNewUserFile = newFile;                 // used by the "+ New .py File" button and by "save a copy"
  window.deleteUserFile = function (id, ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); const f = userFiles.find((x) => x.id === id); if (f) deleteFile(f); };

  const bar = $("project-actions-wrap");
  if (bar) {
    const b = mk("button", "btn", "📁＋");
    b.title = "New folder";
    b.onclick = () => newFolder();
    bar.insertBefore(b, bar.lastElementChild);
  }

  // keep the "+ New .py File" button's label matching the current language (without touching index.html)
  function updateNewFileLabel() {
    const bar = $("project-actions-wrap");
    if (!bar || !bar.firstElementChild) return;
    bar.firstElementChild.textContent = "+ New " + defaultExt() + " File";
  }
  updateNewFileLabel();
  if (window.switchLanguage) {
    const prevSwitchLanguage = window.switchLanguage;
    window.switchLanguage = function () {
      const r = prevSwitchLanguage.apply(this, arguments);
      updateNewFileLabel();
      if (prefs.sidebarMode === "projects") renderExplorer();
      return r;
    };
  }

  if (prefs.sidebarMode === "projects") renderExplorer();
})();
