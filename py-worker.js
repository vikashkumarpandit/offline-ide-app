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
  const id = "i" + (++seq) + "_" + Date.now();
  post({ type: "input", id, prompt: String(promptText), target });
  try {
    const x = new XMLHttpRequest();
    x.open("GET", STDIN_URL + "?id=" + encodeURIComponent(id), false); // blocks until the user answers
    x.send(null);
    if (x.status !== 200) return null;
    const v = JSON.parse(x.responseText).value;
    return v === undefined ? null : v;
  } catch (e) {
    return null;
  }
};

/* ---------- Python helpers ---------- */
const HELPERS = String.raw`
import sys, builtins, traceback, codeop, js

sys.displayhook = sys.__displayhook__

def _input(prompt=""):
    r = js._input(str(prompt))
    if r is None:
        raise EOFError("EOF when reading a line")
    return r
builtins.input = _input

def _report(e):
    tb = e.__traceback__
    if tb is not None:
        tb = tb.tb_next  # hide our own helper frame
    sys.stderr.write("".join(traceback.format_exception(type(e), e, tb)))

def _last_line(e):
    ln = None
    tb = e.__traceback__
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == "main.py":
            ln = tb.tb_lineno
        tb = tb.tb_next
    if ln is None and isinstance(e, SyntaxError) and e.filename == "main.py":
        ln = e.lineno
    return ln or -1

def _turtle_flush():
    t = sys.modules.get("turtle")
    if t is not None and hasattr(t, "_flush"):
        t._flush()

def _run_user(code):
    sys.modules.pop("turtle", None)  # fresh turtle state for every run
    ns = {"__name__": "__main__"}
    try:
        exec(compile(code, "main.py", "exec"), ns)
        return 0
    except SystemExit:
        return 0
    except BaseException as e:
        _report(e)
        return _last_line(e)
    finally:
        _turtle_flush()

_repl_ns = {"__name__": "__main__"}
_repl_buf = []

def _repl_reset():
    _repl_buf.clear()
    _repl_ns.clear()
    _repl_ns["__name__"] = "__main__"

def _repl_push(line):
    """Returns True when more input is needed (multi-line block)."""
    _repl_buf.append(line)
    src = "\n".join(_repl_buf)
    try:
        code = codeop.compile_command(src, "<console>", "single")
    except (SyntaxError, OverflowError, ValueError) as e:
        _repl_buf.clear()
        sys.stderr.write("".join(traceback.format_exception_only(type(e), e)))
        return False
    if code is None:
        return True
    _repl_buf.clear()
    try:
        exec(code, _repl_ns)
    except SystemExit:
        pass
    except BaseException as e:
        _report(e)
    finally:
        _turtle_flush()
    return False
`;

/* ---------- Turtle shim: same API as turtle, but draws on the app's canvas ---------- */
const TURTLE_SRC = String.raw`
import json, math, js

_q = []
_turtles = []
_colormode = 1.0
_tr = 1  # tracer: 0 = draw instantly
_SPEEDS = {"fastest": 0, "fast": 10, "normal": 6, "slow": 3, "slowest": 1}

def _flush():
    global _q
    cmds = _q
    for t in _turtles:
        cmds.append(["S", t._id, t._x, t._y, t._h, t._pc, t._vis])
    _q = []
    if cmds:
        js._gfx(json.dumps(cmds))

def _emit(*c):
    _q.append(list(c))
    if len(_q) >= 400:
        _flush()

def _col(*a):
    if len(a) == 1:
        c = a[0]
        if not isinstance(c, (tuple, list)):
            return str(c)
        a = tuple(c)
    k = 255 if _colormode == 1.0 else 1
    return "#%02x%02x%02x" % tuple(max(0, min(255, int(round(v * k)))) for v in a[:3])

class Turtle:
    _count = 0

    def __init__(self, shape="classic", undobuffer=1000, visible=True):
        Turtle._count += 1
        self._id = Turtle._count
        self._x = 0.0
        self._y = 0.0
        self._h = 0.0
        self._down = True
        self._pc = "black"
        self._fc = "black"
        self._w = 1
        self._vis = visible
        self._fill = None
        self._speed = 3
        _turtles.append(self)

    def _move(self, nx, ny):
        spd = 0 if _tr == 0 else self._speed
        _emit("L" if self._down else "M", self._x, self._y, nx, ny, self._pc, self._w, spd, self._id)
        self._x, self._y = round(nx, 10), round(ny, 10)
        if self._fill is not None:
            self._fill.append((nx, ny))

    def forward(self, d):
        r = math.radians(self._h)
        self._move(self._x + d * math.cos(r), self._y + d * math.sin(r))
    def backward(self, d):
        self.forward(-d)
    def left(self, a):
        self._h = (self._h + a) % 360
    def right(self, a):
        self._h = (self._h - a) % 360
    def goto(self, x, y=None):
        if y is None:
            x, y = x
        self._move(float(x), float(y))
    def setx(self, x):
        self.goto(x, self._y)
    def sety(self, y):
        self.goto(self._x, y)
    def setheading(self, a):
        self._h = a % 360
    def home(self):
        self.goto(0, 0)
        self._h = 0.0
    def penup(self):
        self._down = False
    def pendown(self):
        self._down = True
    def isdown(self):
        return self._down
    def pensize(self, w=None):
        if w is None:
            return self._w
        self._w = w
    def pencolor(self, *a):
        if not a:
            return self._pc
        self._pc = _col(*a)
    def fillcolor(self, *a):
        if not a:
            return self._fc
        self._fc = _col(*a)
    def color(self, *a):
        if not a:
            return (self._pc, self._fc)
        if len(a) == 2:
            self._pc, self._fc = _col(a[0]), _col(a[1])
        else:
            self._pc = self._fc = _col(*a)
    def begin_fill(self):
        self._fill = [(self._x, self._y)]
    def end_fill(self):
        if self._fill is not None and len(self._fill) > 2:
            _emit("F", [list(p) for p in self._fill], self._fc)
        self._fill = None
    def filling(self):
        return self._fill is not None
    def circle(self, radius, extent=None, steps=None):
        if extent is None:
            extent = 360
        if steps is None:
            steps = 1 + int(min(11 + abs(radius) / 6.0, 59.0) * abs(extent) / 360.0)
        w = 1.0 * extent / steps
        w2 = 0.5 * w
        l = 2.0 * radius * math.sin(math.radians(w2))
        if radius < 0:
            l, w, w2 = -l, -w, -w2
        self.left(w2)
        for _ in range(steps):
            self.forward(l)
            self.left(w)
        self.left(-w2)
    def dot(self, size=None, *color):
        if size is None:
            size = max(self._w + 4, 2 * self._w)
        _emit("D", self._x, self._y, size, _col(*color) if color else self._pc)
    def write(self, arg, move=False, align="left", font=("Arial", 8, "normal")):
        font = tuple(font) + ("normal",) * (3 - len(font))
        fam, size, style = font[:3]
        f = ("%s %dpx %s" % (style if style != "normal" else "", size, fam)).strip()
        _emit("T", self._x, self._y, str(arg), self._pc, f, align)
    def clear(self):
        _emit("C")
    def reset(self):
        _emit("C")
        self._x = self._y = 0.0
        self._h = 0.0
        self._down = True
        self._pc = self._fc = "black"
        self._w = 1
        self._fill = None
    def hideturtle(self):
        self._vis = False
    def showturtle(self):
        self._vis = True
    def isvisible(self):
        return self._vis
    def speed(self, s=None):
        if s is None:
            return self._speed
        if isinstance(s, str):
            s = _SPEEDS.get(s, 3)
        v = float(s)
        self._speed = 0 if (v > 10.5 or v < 0.5) else int(round(v))
    def shape(self, name=None):
        return "classic"
    def shapesize(self, *a, **k):
        pass
    def stamp(self):
        return 0
    def pos(self):
        return (self._x, self._y)
    def heading(self):
        return self._h
    def xcor(self):
        return self._x
    def ycor(self):
        return self._y
    def towards(self, x, y=None):
        if y is None:
            x, y = x
        return math.degrees(math.atan2(y - self._y, x - self._x)) % 360
    def distance(self, x, y=None):
        if y is None:
            x, y = x
        return math.hypot(x - self._x, y - self._y)

for _a, _b in [("fd", "forward"), ("bk", "backward"), ("back", "backward"), ("lt", "left"), ("rt", "right"),
               ("setpos", "goto"), ("setposition", "goto"), ("seth", "setheading"), ("pu", "penup"),
               ("up", "penup"), ("pd", "pendown"), ("down", "pendown"), ("width", "pensize"),
               ("ht", "hideturtle"), ("st", "showturtle"), ("position", "pos"), ("turtlesize", "shapesize")]:
    setattr(Turtle, _a, getattr(Turtle, _b))

Pen = RawTurtle = Turtle

class _Screen:
    def bgcolor(self, *a):
        if a:
            _emit("B", _col(*a))
    def title(self, t=None): pass
    def setup(self, *a, **k): pass
    def screensize(self, *a, **k): pass
    def tracer(self, n=None, delay=None):
        global _tr
        if n is None:
            return _tr
        _tr = int(n)
    def delay(self, *a, **k): pass
    def listen(self, *a, **k): pass
    def onkey(self, *a, **k): pass
    def onkeypress(self, *a, **k): pass
    def onscreenclick(self, *a, **k): pass
    def ontimer(self, *a, **k): pass
    def colormode(self, v=None):
        global _colormode
        if v is None:
            return _colormode
        _colormode = float(v)
    def update(self):
        _flush()
    def mainloop(self):
        _flush()
    def exitonclick(self):
        _flush()
    def bye(self):
        _flush()
    def window_width(self):
        return 600
    def window_height(self):
        return 440
    done = mainloop

_screen = _Screen()
def Screen():
    return _screen

_default = None
def _t():
    global _default
    if _default is None:
        _default = Turtle()
    return _default

_turtle_funcs = ("forward fd backward back bk left lt right rt goto setpos setposition setx sety setheading seth "
                 "home penup pu up pendown pd down isdown pensize width pencolor fillcolor color begin_fill end_fill "
                 "filling circle dot write clear reset hideturtle ht showturtle st isvisible speed shape shapesize "
                 "turtlesize stamp pos position heading xcor ycor towards distance").split()
_screen_funcs = ("bgcolor title setup screensize tracer delay listen onkey onkeypress onscreenclick ontimer "
                 "colormode update mainloop exitonclick bye window_width window_height done").split()

def _mk(obj_getter, name):
    def f(*a, **k):
        return getattr(obj_getter(), name)(*a, **k)
    f.__name__ = name
    return f

for _n in _turtle_funcs:
    globals()[_n] = _mk(_t, _n)
for _n in _screen_funcs:
    globals()[_n] = _mk(lambda: _screen, _n)

__all__ = _turtle_funcs + _screen_funcs + ["Turtle", "RawTurtle", "Pen", "Screen"]
`;

/* ---------- boot ---------- */
async function boot() {
  try {
    py = await loadPyodide({ indexURL: BASE });
    py.setStdout({ write: (b) => { emit(decOut.decode(b, { stream: true }), false); return b.length; } });
    py.setStderr({ write: (b) => { emit(decErr.decode(b, { stream: true }), true); return b.length; } });
    py.FS.writeFile("/home/pyodide/turtle.py", TURTLE_SRC);
    py.FS.writeFile("/home/pyodide/notes.txt", "Line 1: Welcome to Virtual File System\n");
    py.runPython(HELPERS);
    try { // does the service worker answer? (needed for input())
      const x = new XMLHttpRequest();
      x.open("GET", STDIN_URL + "?id=probe", false);
      x.send(null);
      swOK = x.status === 200;
    } catch (e) { swOK = false; }
    post({ type: "ready", input: swOK });
    while (queue.length) await handle(queue.shift());
  } catch (err) {
    post({ type: "out", target: "run", text: "[Python failed to load: " + err + "]\n", err: true });
    post({ type: "fatal" });
  }
}

async function handle(m) {
  try {
    if (m.type === "run") {
      target = "run";
      const fn = py.globals.get("_run_user");
      const res = fn(m.code);
      fn.destroy();
      flush();
      post({ type: "done", target: "run", ok: res === 0, line: res > 0 ? res : null });
    } else if (m.type === "repl") {
      target = "repl";
      const fn = py.globals.get("_repl_push");
      const more = fn(m.line);
      fn.destroy();
      flush();
      post({ type: "done", target: "repl", more: !!more });
    } else if (m.type === "repl-reset") {
      py.runPython("_repl_reset()");
    }
  } catch (err) {
    emit("\n" + err + "\n", true);
    flush();
    post({ type: "done", target: m.type === "repl" ? "repl" : "run", ok: false, more: false, line: null });
  }
}

self.onmessage = (e) => {
  if (!py) queue.push(e.data);
  else handle(e.data);
};

boot();
