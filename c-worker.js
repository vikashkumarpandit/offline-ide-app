/* c-worker.js — runs C programs (via cinterp.py, a teaching C interpreter written in Python) inside Pyodide,
   in its own Web Worker. Speaks the SAME message protocol as py-worker.js (ready/out/input/done/problems),
   so ide-runtime.js, problems.js etc. work for C exactly as they do for Python, once the language is switched.
   cinterp.py is fetched as a plain text file (not embedded as a JS string), so there is nothing here that can
   be broken by quotes, backslashes or backticks appearing in that file. */
"use strict";

const BASE = new URL("libs/pyodide/", self.location.href).href;
const STDIN_URL = new URL("__stdin__", self.location.href).href;
const CINTERP_URL = new URL("cinterp.py", self.location.href).href;
importScripts(BASE + "pyodide.js");

let py = null;
let swOK = false;
let target = "run";
let buf = "", bufErr = false, lastFlush = 0, seq = 0;
const queue = [];

function post(m) { self.postMessage(m); }

function flush() {
  if (buf) { post({ type: "out", target, text: buf, err: bufErr }); buf = ""; }
  lastFlush = performance.now();
}
function emit(text, err) {
  if (err !== bufErr) { flush(); bufErr = err; }
  buf += text;
  if (buf.length > 16384 || performance.now() - lastFlush > 40) flush();
}

self._emit = (text, err) => emit(String(text), !!err);

// C's input (scanf/gets/getchar) is rare and always blocking in student code, so it reuses the
// sw.js-based synchronous channel already built for the Python runtime's blocking-input fallback.
self._c_input = (promptText) => {
  if (!swOK) return null;
  if (promptText) emit(String(promptText), false);
  flush();
  const id = "c" + (++seq) + "_" + Date.now();
  post({ type: "input", id, prompt: String(promptText || ""), target, sync: true });
  try {
    const x = new XMLHttpRequest();
    x.open("GET", STDIN_URL + "?id=" + encodeURIComponent(id), false);
    x.send(null);
    if (x.status !== 200) return null;
    const v = JSON.parse(x.responseText).value;
    return typeof v === "string" ? v : null;
  } catch (e) {
    return null;
  }
};

const GLUE_PY = [
  "import js as _js",
  "",
  "def _bridge_emit(s, err):",
  "    _js._emit(s, bool(err))",
  "",
  "def _bridge_input(prompt):",
  "    r = _js._c_input(prompt)",
  "    return r if isinstance(r, str) else None",
  "",
  "_c_files = {}",
  "",
  "def _run_c_now(code):",
  "    return run_c(code, _bridge_emit, _bridge_input, _c_files)",
  "",
  "def _check_c_now(code):",
  "    import json as _json",
  "    try:",
  "        return _json.dumps(build_diagnose(code))",
  "    except Exception:",
  "        return \"[]\"",
  ""
].join("\n");

async function boot() {
  try {
    py = await loadPyodide({ indexURL: BASE });
    const res = await fetch(CINTERP_URL);
    if (!res.ok) throw new Error("could not fetch cinterp.py (HTTP " + res.status + ")");
    const cinterpSrc = await res.text();
    py.runPython(cinterpSrc);
    py.runPython(GLUE_PY);
    try {
      const x = new XMLHttpRequest();
      x.open("GET", STDIN_URL + "?id=probe", false);
      x.send(null);
      swOK = x.status === 200 && JSON.parse(x.responseText).value === "ok";
    } catch (e) { swOK = false; }
    post({ type: "ready", input: swOK });
    while (queue.length) await handle(queue.shift());
  } catch (err) {
    post({ type: "out", target: "run", text: "[C runtime failed to load: " + err + "]\n", err: true });
    post({ type: "fatal" });
  }
}

async function handle(m) {
  try {
    if (m.type === "run") {
      target = "run";
      const fn = py.globals.get("_run_c_now");
      const res = fn(m.code);
      fn.destroy();
      flush();
      post({ type: "done", target: "run", ok: res === 0, line: res > 0 ? res : null });
    } else if (m.type === "check") {
      const fn = py.globals.get("_check_c_now");
      const txt = fn(m.code);
      fn.destroy();
      let list = [];
      try { list = JSON.parse(txt); } catch (e) {}
      post({ type: "problems", list: list });
    } else if (m.type === "repl") {
      target = "repl";
      post({ type: "out", target: "repl", text: "The Console (REPL) is only available for Python right now.\n", err: true });
      post({ type: "done", target: "repl", more: false });
    }
  } catch (err) {
    emit("\n" + err + "\n", true);
    flush();
    post({ type: "done", target: m.type === "repl" ? "repl" : "run", ok: false, more: false, line: null });
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "input-reply") return;
  if (!py) queue.push(m);
  else handle(m);
};

boot();
