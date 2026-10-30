/* py-worker.js — runs real Python (Pyodide) in a Web Worker so the UI never freezes.
   input(): the program is rewritten so that input() becomes "await _ainput()" and the worker simply
   waits for a message from the page. No service worker / SharedArrayBuffer is needed for this. */
"use strict";

const BASE = new URL("libs/pyodide/", self.location.href).href;
const STDIN_URL = new URL("__stdin__", self.location.href).href;
importScripts(BASE + "pyodide.js");

let py = null;
let swOK = false;
let target = "run"; // "run" | "repl": where output / input requests belong
let buf = "", bufErr = false, lastFlush = 0, seq = 0;
const queue = [];
const pend = new Map();
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

// Python's print() / errors arrive here (sys.stdout / sys.stderr are replaced in HELPERS, so nothing is held back in a hidden buffer)
self._emit = (text, err) => emit(String(text), !!err);

// Normal input(): the page shows the input bar, we wait for its answer without blocking the worker.
self._ainput = (promptText) => {
  emit(String(promptText), false);
  flush();
  const id = "a" + (++seq) + "_" + Date.now();
  post({ type: "input", id, prompt: String(promptText), target, sync: false });
  return new Promise((res) => pend.set(id, res));
};

// Fallback for the few spots where await is impossible (__init__, lambda, generator): needs sw.js.
self._input = (promptText) => {
  if (!swOK) return undefined;
  emit(String(promptText), false);
  flush();
  const id = "i" + (++seq) + "_" + Date.now();
  post({ type: "input", id, prompt: String(promptText), target, sync: true });
  try {
    const x = new XMLHttpRequest();
    x.open("GET", STDIN_URL + "?id=" + encodeURIComponent(id), false); // blocks until the user answers
    x.send(null);
    if (x.status !== 200) return undefined;
    const v = JSON.parse(x.responseText).value;
    return typeof v === "string" ? v : undefined;
  } catch (e) {
    return undefined;
  }
};

/* ---------- Python helpers ---------- */
const HELPERS = String.raw`
import sys, builtins, traceback, codeop, ast, inspect, json, time, re, difflib, keyword, js

sys.displayhook = sys.__displayhook__

class _Out:
    """stdout / stderr that go straight to the page. Text is only held back for a moment (speed) and is ALWAYS
    handed over at the end of a run and before input(), so a print(..., end=' ') can never show up in the next run."""
    encoding = "utf-8"
    errors = "strict"
    def __init__(self, err):
        self.err = err
        self.parts = []
        self.n = 0
        self.t = 0.0
    def write(self, s):
        if not isinstance(s, str):
            s = str(s)
        if self.err:
            _sout.flush()          # normal output first, then the error text: the order you would see in a terminal
        self.parts.append(s)
        self.n += len(s)
        if self.err or self.n >= 4096 or time.monotonic() - self.t >= 0.05:
            self.flush()
        return len(s)
    def flush(self):
        if self.parts:
            text = "".join(self.parts)
            self.parts = []
            self.n = 0
            js._emit(text, self.err)
        self.t = time.monotonic()
    def isatty(self):
        return False
    def writable(self):
        return True
    def readable(self):
        return False
    def fileno(self):
        raise OSError("this stream is not a real file")

_sout = _Out(False)
_serr = _Out(True)
sys.stdout = _sout
sys.stderr = _serr

def _flush_all():
    _sout.flush()
    _serr.flush()

def _input(prompt=""):  # fallback used only where input() could not be made async
    _flush_all()
    r = js._input(str(prompt))
    if not isinstance(r, str):
        raise EOFError("input() cannot be used at this spot. Call input() at the top level of your program or inside a normal function (not inside __init__, a lambda or a generator).")
    return r
builtins.input = _input

async def _ainput(prompt=""):
    _flush_all()
    r = await js._ainput(str(prompt))
    if not isinstance(r, str):
        raise EOFError("EOF when reading a line")
    return r

async def _aw(v):
    return (await v) if inspect.isawaitable(v) else v

class _Marks:
    def __init__(self):
        self.funcs = set()
        self.methods = set()

_DEFS = (ast.FunctionDef, ast.AsyncFunctionDef)

def _own(fn):
    """nodes of a function's own body (not inside nested defs, lambdas or classes)"""
    stack = list(fn.body)
    while stack:
        n = stack.pop()
        yield n
        if isinstance(n, _DEFS + (ast.Lambda, ast.ClassDef)):
            continue
        stack.extend(ast.iter_child_nodes(n))

def _defs(node, in_class, out):
    for ch in ast.iter_child_nodes(node):
        if isinstance(ch, _DEFS):
            out.append((ch, in_class))
            _defs(ch, False, out)
        elif isinstance(ch, ast.ClassDef):
            _defs(ch, True, out)
        else:
            _defs(ch, in_class, out)

def _mark(tree, m):
    defs = []
    _defs(tree, False, defs)
    changed = True
    while changed:
        changed = False
        for fn, in_class in defs:
            if isinstance(fn, ast.AsyncFunctionDef):
                continue
            bucket = m.methods if in_class else m.funcs
            if fn.name in bucket or (fn.name.startswith("__") and fn.name.endswith("__")):
                continue
            nodes = list(_own(fn))
            if any(isinstance(n, (ast.Yield, ast.YieldFrom)) for n in nodes):
                continue
            for n in nodes:
                if isinstance(n, ast.Call):
                    f = n.func
                    if (isinstance(f, ast.Name) and (f.id == "input" or f.id in m.funcs)) or \
                       (isinstance(f, ast.Attribute) and f.attr in m.methods):
                        bucket.add(fn.name)
                        changed = True
                        break

class _T(ast.NodeTransformer):
    def __init__(self, m):
        self.m = m
        self.ctx = [True]       # True = await is allowed here (module level / async function)
        self.scope = ["mod"]

    def visit_ClassDef(self, node):
        self.scope.append("class"); self.ctx.append(False)
        self.generic_visit(node)
        self.ctx.pop(); self.scope.pop()
        return node

    def visit_Lambda(self, node):
        self.ctx.append(False)
        self.generic_visit(node)
        self.ctx.pop()
        return node

    def visit_FunctionDef(self, node):
        bucket = self.m.methods if self.scope[-1] == "class" else self.m.funcs
        marked = node.name in bucket
        self.scope.append("func"); self.ctx.append(marked)
        self.generic_visit(node)
        self.ctx.pop(); self.scope.pop()
        if marked:
            new = ast.AsyncFunctionDef()
            new.__dict__.update(node.__dict__)
            return ast.copy_location(new, node)
        return node

    def visit_Call(self, node):
        self.generic_visit(node)
        if not self.ctx[-1]:
            return node
        f = node.func
        if isinstance(f, ast.Name) and f.id == "input":
            call = ast.Call(func=ast.Name(id="_ainput", ctx=ast.Load()), args=node.args, keywords=node.keywords)
            return ast.copy_location(ast.Await(value=ast.copy_location(call, node)), node)
        if (isinstance(f, ast.Name) and f.id in self.m.funcs) or (isinstance(f, ast.Attribute) and f.attr in self.m.methods):
            call = ast.Call(func=ast.Name(id="_aw", ctx=ast.Load()), args=[node], keywords=[])
            return ast.copy_location(ast.Await(value=ast.copy_location(call, node)), node)
        return node

def _transform(tree, m):
    _mark(tree, m)
    tree = _T(m).visit(tree)
    return ast.fix_missing_locations(tree)

_HINTS = {
    "IndentationError": "Indentation is wrong. Use 4 spaces for every level inside if / for / while / def.",
    "SyntaxError": "Python could not understand this line. Check colons ':', brackets, quotes and spelling.",
    "NameError": "A name is used before it is created, or it is misspelled. Create it above this line and check the spelling.",
    "ZeroDivisionError": "You divided by zero. Check the divisor before dividing.",
    "TypeError": "A value of the wrong kind is used here (for example text + number). Convert with int(), float() or str().",
    "ValueError": "The value has the right type but wrong content, for example int('abc').",
    "IndexError": "The index is outside the list. Valid indexes are 0 to len(list) - 1.",
    "KeyError": "This key is not in the dictionary. Use dict.get(key) or check 'key in dict' first.",
    "AttributeError": "This object has no such attribute or method. Check the spelling and the type of the object.",
    "ModuleNotFoundError": "This module is not available offline. Only Python's standard library is included.",
    "RecursionError": "A function keeps calling itself. Add a base case that stops the recursion.",
    "EOFError": "input() did not receive any text.",
}
_last_problem = None
_ctx = {"lines": []}   # the source lines of the program being checked / run

def _hint_for(e):
    for cls in type(e).__mro__:
        h = _HINTS.get(cls.__name__)
        if h:
            return h
    return ""

# ---------- small text helpers ----------
def _indent_of(s):
    return s[:len(s) - len(s.lstrip(" \t"))]

def _code_end(line):
    """index just after the last code character (ignores trailing spaces and a trailing # comment)"""
    quote = None
    i = 0
    while i < len(line):
        c = line[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "\"'":
            quote = c
        elif c == "#":
            return len(line[:i].rstrip())
        i += 1
    return len(line.rstrip())

def _unclosed(line):
    """closing brackets still needed at the end of this line, e.g. 'print(len(x' needs '))'"""
    stack = []
    quote = None
    i = 0
    pair = {"(": ")", "[": "]", "{": "}"}
    while i < len(line):
        c = line[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "\"'":
            quote = c
        elif c == "#":
            break
        elif c in pair:
            stack.append(pair[c])
        elif c in ")]}" and stack and stack[-1] == c:
            stack.pop()
        i += 1
    return "".join(reversed(stack))

def _find_assign(line, start):
    """index of a lone '=' (not ==, <=, >=, !=, :=) at or after start, or -1"""
    for i in range(max(start, 0), len(line)):
        if line[i] == "=":
            prev = line[i - 1] if i > 0 else ""
            nxt = line[i + 1] if i + 1 < len(line) else ""
            if nxt != "=" and prev not in "=<>!:":
                return i
    return -1

def _prev_indent(lines, ln):
    for k in range(ln - 2, -1, -1):
        if lines[k].strip():
            return _indent_of(lines[k])
    return ""

_ASCII = {"\u201c": '"', "\u201d": '"', "\u2018": "'", "\u2019": "'", "\u2013": "-", "\u2014": "-", "\u2026": "...",
          "\u00d7": "*", "\u00f7": "/", "\u00a0": " ", "\u200b": "", "\u2212": "-", "\u00ab": '"', "\u00bb": '"'}

def _fixd(label, line, c0, c1, text):
    return {"label": label, "line": line, "col": c0, "end_col": c1, "text": text}

# ---------- syntax errors: what happened, why, and how to fix ----------
def _syntax_info(e, lines):
    msg = e.msg or str(e)
    ln = e.lineno or 1
    line = lines[ln - 1] if 0 < ln <= len(lines) else ""
    col = max((e.offset or 1) - 1, 0)
    end = (e.end_offset - 1) if (getattr(e, "end_offset", None) and e.end_offset > 0) else col + 1
    why, fix = "", None

    if msg.startswith("expected ':'"):
        pos = _code_end(line)
        why = "Python needs a ':' at the end of a line that starts a block (if, elif, else, for, while, def, class, try, except, with)."
        fix = _fixd("Add ':' at the end of line %d" % ln, ln, pos, pos, ":")
    elif re.match(r"'.' was never closed", msg):
        op = msg[1]
        need = _unclosed(line) or {"(": ")", "[": "]", "{": "}"}.get(op, "")
        pos = _code_end(line)
        why = "A '%s' was opened here but never closed. Every ( [ { needs its closing ) ] }." % op
        fix = _fixd("Add '%s' at the end of line %d" % (need, ln), ln, pos, pos, need)
    elif msg.startswith("unterminated triple-quoted string"):
        why = "A triple-quoted string was opened but never closed. End it with the same three quotes."
    elif msg.startswith("unterminated string literal"):
        q = ""
        for ch in line[col:col + 3]:
            if ch in "\"'":
                q = ch
                break
        pos = len(line.rstrip())
        why = "A string was started with a quote but the closing quote is missing on this line."
        if q:
            fix = _fixd("Add the closing %s at the end of line %d" % (q, ln), ln, pos, pos, q)
    elif msg.startswith("unmatched '"):
        ch = line[col] if col < len(line) else msg[11:12]
        why = "There is a closing '%s' with no matching opening bracket before it." % ch
        fix = _fixd("Remove the extra '%s'" % ch, ln, col, col + 1, "")
    elif msg.startswith("closing parenthesis"):
        m = re.match(r"closing parenthesis '(.)' does not match opening parenthesis '(.)'", msg)
        if m:
            right = {"(": ")", "[": "]", "{": "}"}[m.group(2)]
            why = "The bracket opened with '%s' must be closed with '%s', not '%s'." % (m.group(2), right, m.group(1))
            fix = _fixd("Replace '%s' with '%s'" % (m.group(1), right), ln, col, col + 1, right)
    elif msg.startswith("Missing parentheses in call to 'print'"):
        rest = line[col + 5:end].strip()
        why = "In Python 3, print is a function: its values go inside brackets."
        fix = _fixd("Write print(%s)" % rest, ln, col, end, "print(%s)" % rest)
    elif "instead of '='" in msg:
        i = _find_assign(line, col if msg.startswith("invalid syntax") else end)
        why = "A single '=' stores a value in a variable. To COMPARE two values use '=='."
        if i >= 0:
            fix = _fixd("Use '==' to compare", ln, i, i + 1, "==")
    elif "forgot a comma" in msg:
        span = line[col:end]
        depth, cut = 0, -1
        for k, ch in enumerate(span):
            if ch in "([{":
                depth += 1
            elif ch in ")]}":
                depth -= 1
            elif ch in " \t" and depth == 0 and k > 0:
                cut = k
                break
        why = "Two values are written next to each other. Separate items with a comma."
        if cut > 0:
            fix = _fixd("Add a ',' between the two values", ln, col + cut, col + cut, ",")
    elif msg.startswith("expected an indented block"):
        m = re.search(r"on line (\d+)", msg)
        head = int(m.group(1)) if m else ln - 1
        base = _indent_of(lines[head - 1]) if 0 < head <= len(lines) else ""
        why = "The line before ends with ':' so the next line must be indented (4 spaces) to belong to it."
        if 0 < ln <= len(lines):
            fix = _fixd("Indent line %d by 4 spaces" % ln, ln, 0, len(_indent_of(line)), base + "    ")
    elif msg == "unexpected indent":
        why = "This line is indented more than the code above, and nothing opens a block here."
        fix = _fixd("Remove the extra indentation on line %d" % ln, ln, 0, len(_indent_of(line)), _prev_indent(lines, ln))
    elif msg.startswith("unindent does not match"):
        cur = len(_indent_of(line).expandtabs(4))
        levels = sorted({len(_indent_of(l).expandtabs(4)) for l in lines[:ln - 1] if l.strip()})
        smaller = [v for v in levels if v < cur]
        target = " " * (smaller[-1] if smaller else 0)
        why = "This line is dedented to a level that no earlier block uses. Match the indentation of the block you are leaving."
        fix = _fixd("Align line %d with the block above" % ln, ln, 0, len(_indent_of(line)), target)
    elif msg.startswith("invalid character") or msg.startswith("invalid non-printable character"):
        ch = line[col] if col < len(line) else ""
        rep = _ASCII.get(ch)
        why = "This looks like a normal character but Python does not accept it (usually from copy-paste from a PDF or chat). Use the plain keyboard character."
        if rep is not None:
            fix = _fixd("Replace it with %s" % (repr(rep) if rep else "nothing"), ln, col, col + 1, rep)
    elif msg.startswith("'return' outside function"):
        why = "return can only be used inside a def (function)."
    elif msg.startswith("'break' outside loop") or msg.startswith("'continue'"):
        why = "break and continue only work inside a for or while loop."
    elif msg.startswith("positional argument follows keyword argument"):
        why = "In a call, plain values must come first and name=value pairs after them: f(1, 2, a=3)."
    elif msg.startswith("expected 'except' or 'finally'"):
        why = "A try block needs at least one except (or finally) block after it, at the same indentation as try."
    elif msg.startswith("invalid decimal literal"):
        why = "A number cannot be followed directly by letters, and a name cannot start with a digit (1st is not valid, first is)."
    elif msg.startswith("f-string"):
        why = "Something inside the { } of the f-string is not valid Python. Check quotes and brackets inside the braces."
    elif msg.startswith("unexpected character after line continuation"):
        why = "After a backslash \\ the line must end immediately. Remove anything written after it."
    else:
        word = line.strip().split(" ")[0].split("(")[0] if line.strip() else ""
        if word in ("else", "elif", "except", "finally"):
            why = "'%s' needs an earlier if / try block at the same indentation level." % word
        elif line.rstrip()[-1:] in "+-*/%=,.<>&|^" and line.strip():
            why = "The line ends with an operator but nothing follows it. Finish the expression."
        else:
            bit = line[col:end].strip() or line.strip()
            why = "Python could not understand this part: %s. Check spelling, a missing operator, comma or bracket near it." % repr(bit[:30])
        first = re.match(r"\s*([A-Za-z_]+)", line)
        if first and first.group(1) not in keyword.kwlist:
            near = difflib.get_close_matches(first.group(1), keyword.kwlist, 1, 0.78)
            if near and near[0] != first.group(1):
                why += " Did you mean '%s'?" % near[0]
                fix = _fixd("Change '%s' to '%s'" % (first.group(1), near[0]), ln, first.start(1), first.end(1), near[0])
    return {"why": why, "fix": fix, "col": col, "end": end, "line": ln, "text": line}

def _syntax_problem(e, lines):
    info = _syntax_info(e, lines)
    return {"kind": "syntax", "type": type(e).__name__, "msg": e.msg or str(e), "line": info["line"], "col": info["col"] + 1,
            "end_col": max(info["end"], info["col"]) + 1, "text": info["text"], "hint": info["why"] or _hint_for(e),
            "why": info["why"], "fix": info["fix"], "frames": []}

# ---------- run-time errors ----------
def _col_chars(text, byte_off):
    if byte_off is None:
        return None
    return len(text.encode("utf-8")[:byte_off].decode("utf-8", "ignore"))

def _names_in_source():
    names = set()
    for l in _ctx["lines"]:
        names.update(re.findall(r"[A-Za-z_]\w*", l))
    return names

def _runtime_problem(e):
    frames = []
    last = None
    for fs in traceback.extract_tb(e.__traceback__):
        if fs.filename == "main.py":
            frames.append({"line": fs.lineno, "func": "" if fs.name == "<module>" else fs.name, "text": (fs.line or "").strip()})
            last = fs
    line = last.lineno if last else None
    text = _ctx["lines"][line - 1] if (line and 0 < line <= len(_ctx["lines"])) else ((last.line or "") if last else "")
    c0 = _col_chars(text, getattr(last, "colno", None)) if last else None
    c1 = _col_chars(text, getattr(last, "end_colno", None)) if last else None
    kind = type(e).__name__
    msg = str(e)
    why, fix = "", None

    def locate(word, lo=None, hi=None):
        seg_start = lo if lo is not None else 0
        seg_end = hi if hi is not None else len(text)
        m = re.search(r"\b%s\b" % re.escape(word), text[seg_start:seg_end]) or re.search(r"\b%s\b" % re.escape(word), text)
        if not m:
            return None
        base = seg_start if text[seg_start:seg_end] and re.search(r"\b%s\b" % re.escape(word), text[seg_start:seg_end]) else 0
        return base + m.start(), base + m.end()

    if isinstance(e, NameError) and getattr(e, "name", None):
        n = e.name
        pool = (_names_in_source() | set(dir(builtins)) | set(keyword.kwlist)) - {n}
        near = difflib.get_close_matches(n, sorted(pool), 1, 0.72)
        why = "The name '%s' is used here but was never created (or it is written differently where it was created)." % n
        pos = locate(n, c0, c1)
        if near and pos:
            why += " Did you mean '%s'?" % near[0]
            fix = _fixd("Rename '%s' to '%s'" % (n, near[0]), line, pos[0], pos[1], near[0])
    elif isinstance(e, AttributeError) and getattr(e, "name", None) is not None and getattr(e, "obj", None) is not None:
        n = e.name
        near = difflib.get_close_matches(n, [a for a in dir(e.obj) if not a.startswith("_")], 1, 0.6)
        why = "This object (%s) has no attribute or method called '%s'." % (type(e.obj).__name__, n)
        pos = locate(n, c0, c1)
        if near and pos:
            why += " Did you mean '%s'?" % near[0]
            fix = _fixd("Rename '%s' to '%s'" % (n, near[0]), line, pos[0], pos[1], near[0])
    elif isinstance(e, ModuleNotFoundError) and getattr(e, "name", None):
        n = e.name.split(".")[0]
        pool = set(getattr(sys, "stdlib_module_names", [])) | {"turtle"}
        near = difflib.get_close_matches(n, sorted(pool), 1, 0.7)
        why = "There is no module called '%s' in this offline Python. Only the standard library is included." % n
        pos = locate(n)
        if near and pos:
            why += " Did you mean '%s'?" % near[0]
            fix = _fixd("Change '%s' to '%s'" % (n, near[0]), line, pos[0], pos[1], near[0])
    elif isinstance(e, ZeroDivisionError):
        why = "The number you divide by (the right side of / // or %) is 0. Check it before dividing, for example with an if."
    elif isinstance(e, IndexError):
        why = "You asked for a position that does not exist. A list of length n has valid indexes 0 to n-1 (and -1 for the last)."
    elif isinstance(e, KeyError):
        why = "The key %s is not in the dictionary. Use d.get(key) for a safe lookup, or check 'key in d' first." % (repr(e.args[0]) if e.args else "")
    elif isinstance(e, ValueError) and "invalid literal for int()" in msg:
        why = "int() was given text that is not a whole number (%s). Check the input before converting." % msg.split(": ", 1)[-1]
    elif isinstance(e, TypeError) and ("concatenate" in msg or "unsupported operand" in msg):
        why = "Two values of different kinds were combined (for example text + number). Convert the number with str(...), or use an f-string."
    elif isinstance(e, TypeError) and "not callable" in msg:
        why = "A value is being called like a function with ( ). Probably a variable has the same name as a function, or a * is missing."
    elif isinstance(e, TypeError) and "positional argument" in msg:
        why = "The function was called with the wrong number of values. Compare the call with the def line."
    elif isinstance(e, UnboundLocalError):
        why = "A variable is used inside a function before it gets a value there. Assign it first, or declare it with global."
    elif isinstance(e, RecursionError):
        why = _HINTS["RecursionError"]
    if not why:
        why = _hint_for(e)
    return {"kind": "runtime", "type": kind, "msg": msg, "line": line, "col": (c0 + 1) if c0 is not None else None,
            "end_col": (c1 + 1) if c1 is not None else None, "text": text, "hint": why, "why": why, "fix": fix, "frames": frames}

def _make_problem(e, kind):
    if isinstance(e, SyntaxError):
        return _syntax_problem(e, _ctx["lines"])
    return _runtime_problem(e)

def _problem_json():
    return json.dumps(_last_problem) if _last_problem else ""

def _diagnose(code, limit=8):
    """all syntax mistakes we can find. Python itself stops at the first one, so after each one we pretend the
    suggested fix was applied (or, without a fix, neutralise that line) and look again. This avoids follow-up errors."""
    lines = code.split("\n")
    work = list(lines)
    out, seen = [], set()
    for _ in range(limit):
        try:
            compile("\n".join(work), "main.py", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT, dont_inherit=True)
            break
        except SyntaxError as e:
            ln = e.lineno or 1
            p = _syntax_problem(e, lines)
            if ln not in seen:
                seen.add(ln)
                out.append(p)
            msg = e.msg or ""
            if msg.endswith("was never closed") or "triple-quoted" in msg:
                break   # the later errors are only consequences of this one
            if not (0 < ln <= len(work)):
                break
            f = p["fix"]
            if f and work[ln - 1] == lines[ln - 1]:
                l = work[ln - 1]
                work[ln - 1] = l[:f["col"]] + f["text"] + l[f["end_col"]:]
            elif "indent" in msg:
                work[ln - 1] = _prev_indent(work, ln) + "pass"
            else:
                work[ln - 1] = _indent_of(lines[ln - 1]) + "pass"
        except Exception:
            break
    return out

def _check(code):
    """Syntax check without running the program. Returns JSON text (a list of problems), or '' when the code is fine."""
    _ctx["lines"] = code.split("\n")
    try:
        found = _diagnose(code)
        return json.dumps(found) if found else ""
    except Exception:
        return ""

def _report(e):
    global _last_problem
    _last_problem = _make_problem(e, "syntax" if isinstance(e, SyntaxError) else "runtime")
    if isinstance(e, SyntaxError) and e.filename in ("main.py", "<console>"):
        sys.stderr.write("".join(traceback.format_exception_only(type(e), e)))
        return
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

async def _run_user(code):
    global _last_problem
    _last_problem = None
    _ctx["lines"] = code.split("\n")
    sys.modules.pop("turtle", None)  # fresh turtle state for every run
    ns = {"__name__": "__main__", "_ainput": _ainput, "_aw": _aw}
    try:
        tree = _transform(ast.parse(code, "main.py"), _Marks())
        co = compile(tree, "main.py", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        r = eval(co, ns)
        if inspect.iscoroutine(r):
            await r
        return 0
    except SystemExit:
        return 0
    except BaseException as e:
        _report(e)
        return _last_line(e)
    finally:
        _turtle_flush()
        _flush_all()

_repl_ns = {"__name__": "__main__", "_ainput": _ainput, "_aw": _aw}
_repl_buf = []
_repl_marks = _Marks()

def _repl_reset():
    global _repl_marks
    _repl_buf.clear()
    _repl_ns.clear()
    _repl_ns.update({"__name__": "__main__", "_ainput": _ainput, "_aw": _aw})
    _repl_marks = _Marks()

async def _repl_push(line):
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
    _ctx["lines"] = src.split("\n")
    try:
        tree = _transform(ast.parse(src, "<console>", "single"), _repl_marks)
        co = compile(tree, "<console>", "single", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        r = eval(co, _repl_ns)
        if inspect.iscoroutine(r):
            await r
    except SystemExit:
        pass
    except BaseException as e:
        _report(e)
    finally:
        _turtle_flush()
        _flush_all()
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
    try { // is sw.js really answering? (Capacitor answers unknown URLs with index.html + status 200, so check the body)
      const x = new XMLHttpRequest();
      x.open("GET", STDIN_URL + "?id=probe", false);
      x.send(null);
      swOK = x.status === 200 && JSON.parse(x.responseText).value === "ok";
    } catch (e) { swOK = false; }
    post({ type: "ready", input: true });
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
      const res = await fn(m.code);
      fn.destroy();
      flush();
      const pj = py.runPython("_problem_json()");
      post({ type: "done", target: "run", ok: res === 0, line: res > 0 ? res : null, problem: pj ? JSON.parse(pj) : null });
    } else if (m.type === "repl") {
      target = "repl";
      const fn = py.globals.get("_repl_push");
      const more = await fn(m.line);
      fn.destroy();
      flush();
      post({ type: "done", target: "repl", more: !!more });
    } else if (m.type === "check") { // live syntax check while typing (does not run the program)
      const fn = py.globals.get("_check");
      const out = fn(m.code);
      fn.destroy();
      post({ type: "problems", list: out ? JSON.parse(out) : [] });
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
  const m = e.data;
  if (m.type === "input-reply") { // answer for an awaiting _ainput()
    const r = pend.get(m.id);
    if (r) { pend.delete(m.id); r(typeof m.value === "string" ? m.value : undefined); }
    return;
  }
  if (!py) queue.push(m);
  else handle(m);
};

boot();
