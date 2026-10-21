/* py-worker.js — runs real Python (Pyodide) in a Web Worker so the UI never freezes.
   Talks to ide-runtime.js (main thread). input() uses a synchronous XHR that sw.js answers. */
"use strict";

const BASE = new URL("libs/pyodide/", self.location.href).href;
const STDIN_URL = new URL("__stdin__", self.location.href).href;
importScripts(BASE + "pyodide.js");

let py = null;
let swOK = false;
let target = "run"; // "run" | "repl": where output / input requests belong
let buf = "", bufErr = false, lastFlush = 0, seq = 0;
const queue = [];
const decOut = new TextDecoder(), decErr = new TextDecoder();

function post(m) { self.postMessage(m); }

function flush() {
  if (buf) { post({ type: "out", target, text: buf, err: bufErr }); buf = ""; }
  lastFlush = performance.now();
}
// Python blocks this thread, so timers never fire: flush by size/time inside write callbacks.
function emit(text, err) {
  if (err !== bufErr) { flush(); bufErr = err; }
  buf += text;
  if (buf.length > 16384 || performance.now() - lastFlush > 40) flush();
}

self._gfx = (json) => post({ type: "gfx", cmds: JSON.parse(json) });

self._input = (promptText) => {
  if (!swOK) {
    emit("\n[input() is unavailable: close and reopen the app once, then try again]\n", true);
    flush();
    return null;
  }
  emit(String(promptText), false);
  flush();