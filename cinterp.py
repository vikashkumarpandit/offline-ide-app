"""cinterp.py - CodeNova's teaching C interpreter (a large part of C99).
Parsing: pycparser.  Execution: closures over ONE byte array with real C layout (sizeof, pointers, structs, unions),
so pointer arithmetic, casts, strings and malloc behave like in C - and mistakes are reported with a line number
instead of a silent crash."""
import re, sys, math, struct, bisect, difflib, functools, time as _time
from pycparser import c_parser, c_ast


# ============================================================== errors
class CompileError(Exception):
    def __init__(self, msg, line=None, col=None, kind="CompileError", why="", fix=None, end_col=None):
        Exception.__init__(self, msg)
        self.msg, self.line, self.col, self.kind, self.why, self.fix, self.end_col = msg, line, col, kind, why, fix, end_col


class RunError(Exception):
    def __init__(self, msg, kind="RuntimeError", why=""):
        Exception.__init__(self, msg)
        self.msg, self.kind, self.why = msg, kind, why


class ExitProgram(Exception):
    def __init__(self, code):
        Exception.__init__(self, "exit")
        self.code = code


class NeedInput(Exception):
    pass


# ============================================================== types (x86-64 / LP64 like gcc on Linux)
class Ty(object):
    __slots__ = ("k", "size", "align", "signed", "to", "n", "name", "fields", "ret", "params", "var", "done", "fmt", "lo", "hi", "mask", "_dimnode")

    def __init__(self, k, size=0, align=1, signed=False, to=None, n=None, name=None):
        self.k, self.size, self.align, self.signed, self.to, self.n, self.name = k, size, align, signed, to, n, name
        self.fields = None; self.ret = None; self.params = None; self.var = False; self.done = True; self.fmt = None
        self.lo = self.hi = self.mask = None
        self._dimnode = None


def _mkint(name, size, signed, f):
    t = Ty("int", size, size, signed, name=name)
    t.fmt = struct.Struct("<" + f)
    bits = size * 8
    t.mask = (1 << bits) - 1
    t.lo, t.hi = (-(1 << (bits - 1)), (1 << (bits - 1)) - 1) if signed else (0, (1 << bits) - 1)
    return t


CHAR = _mkint("char", 1, True, "b"); UCHAR = _mkint("unsigned char", 1, False, "B")
SHORT = _mkint("short", 2, True, "h"); USHORT = _mkint("unsigned short", 2, False, "H")
INT = _mkint("int", 4, True, "i"); UINT = _mkint("unsigned int", 4, False, "I")
LONG = _mkint("long", 8, True, "q"); ULONG = _mkint("unsigned long", 8, False, "Q")
LLONG = _mkint("long long", 8, True, "q"); ULLONG = _mkint("unsigned long long", 8, False, "Q")
BOOL = _mkint("_Bool", 1, False, "B")
FLOAT = Ty("float", 4, 4, True, name="float"); FLOAT.fmt = struct.Struct("<f")
DOUBLE = Ty("float", 8, 8, True, name="double"); DOUBLE.fmt = struct.Struct("<d")
VOID = Ty("void", 1, 1, name="void")
_PTRS = {}
M64 = (1 << 64) - 1


def ptr(t):
    p = _PTRS.get(id(t))
    if p is None:
        p = Ty("ptr", 8, 8, False, to=t, name="ptr")
        p.fmt = struct.Struct("<Q")
        p.mask = M64
        _PTRS[id(t)] = p
        p.var = t  # keep t alive (id() key)
    return p


def arr(t, n):
    a = Ty("arr", t.size * (n or 0), t.align, to=t, n=n, name="array")
    return a


def func_t(ret, params, variadic=False):
    f = Ty("func", 1, 1, name="function")
    f.ret, f.params, f.var = ret, params, variadic
    return f


def wrap(v, t):
    v &= t.mask
    if t.signed and v > t.hi:
        v -= t.mask + 1
    return v


def is_int(t): return t.k == "int"
def is_flt(t): return t.k == "float"
def is_ptr(t): return t.k == "ptr"
def is_arith(t): return t.k == "int" or t.k == "float"
def is_scalar(t): return t.k == "int" or t.k == "float" or t.k == "ptr"
def promote(t): return INT if (t.k == "int" and t.size < 4) else t


def arith_conv(a, b):
    if a.k == "float" or b.k == "float":
        if (a.k == "float" and a.size == 8) or (b.k == "float" and b.size == 8):
            return DOUBLE
        return FLOAT if (a.k == "float" and b.k == "float") else (a if a.k == "float" else b)
    a, b = promote(a), promote(b)
    if a.size != b.size:
        return a if a.size > b.size else b
    if not a.signed:
        return a
    if not b.signed:
        return b
    return a


def type_name(t):
    if t.k == "ptr": return type_name(t.to) + " *"
    if t.k == "arr": return "%s[%s]" % (type_name(t.to), "" if t.n is None else t.n)
    if t.k == "struct": return ("union " if t.var else "struct ") + (t.name or "<anonymous>")
    if t.k == "func": return type_name(t.ret) + "(...)"
    return t.name or t.k


def layout_struct(t, fields, union):
    """fields: list of (name, type). Fills t.fields = {name: (offset, type)}, t.size, t.align (C rules)."""
    off = size = 0
    al = 1
    out = {}
    order = []
    for name, ft in fields:
        a = ft.align or 1
        if union:
            o = 0
            size = max(size, ft.size)
        else:
            off = (off + a - 1) // a * a
            o = off
            off += ft.size
        if name:
            out[name] = (o, ft)
            order.append(name)
        al = max(al, a)
    total = size if union else off
    total = (total + al - 1) // al * al
    t.fields, t.size, t.align, t.done = out, max(total, 1) if total == 0 else total, al, True
    t.n = order


def rnd32(v):
    try:
        return struct.unpack("<f", struct.pack("<f", v))[0]
    except OverflowError:
        return math.inf if v > 0 else -math.inf


# ============================================================== memory (one byte array with the usual regions)
LIT0, LIT1 = 0x1000, 0x41000         # string literals (read-only)
GLB0, GLB1 = 0x41000, 0x141000       # global / static variables
STK0, STK1 = 0x142000, 0x242000      # the call stack (grows upwards here)
HEAP0 = 0x243000                     # malloc'ed memory
FUNC0 = 0x10000000                   # "addresses" of functions (never dereferenced)
FILE0 = 0x7F000000                   # FILE* handles


class Memory(object):
    def __init__(self):
        self.buf = bytearray(HEAP0 + 0x10000)
        self.lit = LIT0
        self.glb = GLB0
        self.sp = STK0
        self.heap_top = HEAP0
        self.hs, self.he, self.ha = [], [], []   # heap blocks: start, end, alive
        self.heap_bytes = 0
        self.max_heap = 64 << 20
        self.lits = {}
        self.line = 0

    # ---- allocation
    def literal(self, b):
        a = self.lits.get(b)
        if a is None:
            a = self.lit
            if a + len(b) > LIT1:
                raise RunError("Too many string literals", "OutOfMemory")
            self.buf[a:a + len(b)] = b
            self.lit += (len(b) + 7) // 8 * 8
            self.lits[b] = a
        return a

    def static(self, size, align=8):
        a = (self.glb + align - 1) // align * align
        if a + size > GLB1:
            raise RunError("Too many / too big global variables", "OutOfMemory")
        self.glb = a + size
        return a

    def malloc(self, size):
        if size < 0 or size > self.max_heap:
            return 0
        size = max(size, 1)
        a = (self.heap_top + 15) // 16 * 16
        end = a + size
        if self.heap_bytes + size > self.max_heap:
            return 0
        need = end + 16 - len(self.buf)
        if need > 0:
            self.buf.extend(b"\0" * max(need, 0x10000))
        self.buf[a:end] = b"\xcd" * size           # fresh memory is NOT zero: it holds garbage
        self.heap_top = end + 16                   # small gap: an overflow lands outside every block
        self.hs.append(a); self.he.append(end); self.ha.append(True)
        self.heap_bytes += size
        return a

    def free(self, a):
        if a == 0:
            return
        i = bisect.bisect_right(self.hs, a) - 1
        if i < 0 or self.hs[i] != a:
            raise RunError("free() was given a pointer that malloc never returned (or the middle of a block)", "InvalidFree",
                           "Only pass free() exactly the pointer you got from malloc/calloc/realloc.")
        if not self.ha[i]:
            raise RunError("This memory was already freed (double free)", "DoubleFree",
                           "Call free() only once for every malloc(). Set the pointer to NULL after freeing.")
        self.ha[i] = False
        self.heap_bytes -= self.he[i] - a
        self.buf[a:self.he[i]] = b"\xdd" * (self.he[i] - a)

    def block_size(self, a):
        i = bisect.bisect_right(self.hs, a) - 1
        if i < 0 or self.hs[i] != a or not self.ha[i]:
            return None
        return self.he[i] - a

    # ---- checks (raise RunError with a teaching message)
    def chk(self, a, n, write=False):
        if STK0 <= a:
            if a < STK1:
                if a + n > self.sp:
                    raise RunError("Reading/writing stack memory that no longer belongs to any variable", "DanglingPointer",
                                   "A pointer to a local variable is used after its function returned. Do not return the address of a local variable.")
                return
            if a >= HEAP0:
                i = bisect.bisect_right(self.hs, a) - 1
                if i < 0 or a + n > self.he[i]:
                    raise RunError("Memory access outside of every malloc'ed block (buffer overflow)", "BufferOverflow",
                                   "You read or wrote beyond the size you asked malloc for. Check your index / loop limit.")
                if not self.ha[i]:
                    raise RunError("Using memory after free()", "UseAfterFree",
                                   "This memory was already freed. Do not use a pointer after free(); set it to NULL instead.")
                return
            raise RunError("Invalid memory address 0x%x" % a, "SegmentationFault")
        if a < 0x1000:
            raise RunError("NULL pointer dereference (address 0x%x)" % a, "NullPointer",
                           "A pointer that is NULL / not set was used with * or [ ]. Check it with if (p != NULL) first.")
        if a < LIT1:
            if a + n > self.lit:
                raise RunError("Invalid memory address 0x%x" % a, "SegmentationFault")
            if write:
                raise RunError("Cannot change a string literal", "SegmentationFault",
                               "Text written in quotes (\"abc\") is read-only. Copy it into a char array first: char s[] = \"abc\";")
            return
        if a < GLB1:
            if a + n > self.glb:
                raise RunError("Invalid memory address 0x%x" % a, "SegmentationFault")
            return
        raise RunError("Invalid memory address 0x%x" % a, "SegmentationFault")

    def cstr(self, a, limit=1 << 20):
        """bytes of the C string at address a (without the NUL)."""
        self.chk(a, 1)
        i = self.buf.find(b"\0", a)
        if i < 0:
            raise RunError("String is not terminated by '\\0'", "BufferOverflow")
        # make sure the whole string lies inside one valid region
        self.chk(a, max(i - a, 0) + 1)
        return bytes(self.buf[a:i])

    def put(self, a, data):
        self.chk(a, len(data), True)
        self.buf[a:a + len(data)] = data


# ============================================================== preprocessor
HEADERS = {"stdio.h", "stdlib.h", "string.h", "math.h", "ctype.h", "time.h", "limits.h", "float.h", "stdbool.h", "stdint.h",
           "stddef.h", "assert.h", "errno.h", "stdarg.h", "unistd.h", "inttypes.h", "locale.h", "signal.h", "setjmp.h"}

BASE_MACROS = {
    "NULL": "((void*)0)", "EOF": "(-1)", "BUFSIZ": "8192", "RAND_MAX": "2147483647", "EXIT_SUCCESS": "0", "EXIT_FAILURE": "1",
    "CHAR_BIT": "8", "SCHAR_MIN": "(-128)", "SCHAR_MAX": "127", "UCHAR_MAX": "255", "CHAR_MIN": "(-128)", "CHAR_MAX": "127",
    "SHRT_MIN": "(-32768)", "SHRT_MAX": "32767", "USHRT_MAX": "65535", "INT_MAX": "2147483647", "INT_MIN": "(-2147483647-1)",
    "UINT_MAX": "4294967295U", "LONG_MAX": "9223372036854775807L", "LONG_MIN": "(-9223372036854775807L-1)",
    "ULONG_MAX": "18446744073709551615UL", "LLONG_MAX": "9223372036854775807LL", "LLONG_MIN": "(-9223372036854775807LL-1)",
    "ULLONG_MAX": "18446744073709551615ULL", "SIZE_MAX": "18446744073709551615UL",
    "INT8_MAX": "127", "INT8_MIN": "(-128)", "UINT8_MAX": "255", "INT16_MAX": "32767", "INT16_MIN": "(-32768)", "UINT16_MAX": "65535",
    "INT32_MAX": "2147483647", "INT32_MIN": "(-2147483647-1)", "UINT32_MAX": "4294967295U",
    "INT64_MAX": "9223372036854775807L", "INT64_MIN": "(-9223372036854775807L-1)", "UINT64_MAX": "18446744073709551615UL",
    "FLT_MAX": "3.40282346638528859812e+38F", "FLT_MIN": "1.17549435082228750797e-38F", "FLT_EPSILON": "1.19209289550781250000e-7F",
    "DBL_MAX": "1.79769313486231570815e+308", "DBL_MIN": "2.22507385850720138309e-308", "DBL_EPSILON": "2.22044604925031308085e-16",
    "FLT_DIG": "6", "DBL_DIG": "15",
    "M_PI": "3.14159265358979323846", "M_E": "2.7182818284590452354", "M_SQRT2": "1.41421356237309504880", "M_PI_2": "1.57079632679489661923",
    "M_LN2": "0.69314718055994530942", "CLOCKS_PER_SEC": "1000000L", "RAND_MAX_": "2147483647",
    "SEEK_SET": "0", "SEEK_CUR": "1", "SEEK_END": "2", "ERANGE": "34", "EDOM": "33", "ENOENT": "2",
    "__STDC__": "1", "__STDC_VERSION__": "199901L",
}
STDBOOL_MACROS = {"bool": "_Bool", "true": "1", "false": "0", "__bool_true_false_are_defined": "1"}
PRELUDE = ("typedef unsigned long size_t; typedef long ssize_t; typedef long ptrdiff_t; typedef long time_t; typedef long clock_t; "
           "typedef int wchar_t; typedef signed char int8_t; typedef unsigned char uint8_t; typedef short int16_t; "
           "typedef unsigned short uint16_t; typedef int int32_t; typedef unsigned int uint32_t; typedef long int64_t; "
           "typedef unsigned long uint64_t; typedef long intptr_t; typedef unsigned long uintptr_t; typedef long intmax_t; "
           "typedef unsigned long uintmax_t; typedef struct __FILE FILE; typedef long off_t; ")

_TOKEN = re.compile(r'"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'|[A-Za-z_]\w*|\d[\w.]*|\s+|.', re.S)
_IDENT = re.compile(r"[A-Za-z_]\w*$")


def strip_comments(src):
    """replace comments by a space (keeping newlines), leave strings and chars alone."""
    out = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == '"' or c == "'":
            j = i + 1
            while j < n and src[j] != c and src[j] != "\n":
                j += 2 if src[j] == "\\" else 1
            out.append(src[i:j + 1])
            i = j + 1
        elif c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
        elif c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append(" " + "\n" * src.count("\n", i, j))
            i = j
        else:
            out.append(c)
            i += 1
    return "".join(out)


class Macro(object):
    def __init__(self, params, body):
        self.params, self.body = params, body   # params None = object-like


def _split_args(text, i):
    """text[i] is just after '('. returns (args, index after ')') or None."""
    depth, args, cur, n = 0, [], [], len(text)
    while i < n:
        c = text[i]
        if c in "\"'":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            cur.append(text[i:j + 1]); i = j + 1; continue
        if c == "(":
            depth += 1
        elif c == ")":
            if depth == 0:
                args.append("".join(cur).strip())
                return args, i + 1
            depth -= 1
        elif c == "," and depth == 0:
            args.append("".join(cur).strip()); cur = []; i += 1; continue
        cur.append(c)
        i += 1
    return None


def expand(text, macros, line, hide=()):
    out = []
    pos = 0
    toks = _TOKEN.findall(text)
    i = 0
    while i < len(toks):
        t = toks[i]
        if _IDENT.match(t) and t not in hide:
            if t == "__LINE__":
                out.append(str(line)); i += 1; continue
            if t == "__FILE__":
                out.append('"main.c"'); i += 1; continue
            m = macros.get(t)
            if m is not None:
                if m.params is None:
                    out.append(expand(m.body, macros, line, hide + (t,)))
                    i += 1
                    continue
                j = i + 1
                while j < len(toks) and toks[j].isspace():
                    j += 1
                if j < len(toks) and toks[j] == "(":
                    rest = "".join(toks[j + 1:])
                    got = _split_args(rest, 0)
                    if got is not None:
                        args, used = got
                        # how many tokens did the arguments use?
                        consumed, k = 0, j + 1
                        acc = ""
                        while k < len(toks) and len(acc) < used:
                            acc += toks[k]; k += 1
                        if len(m.params) == 1 and args == [""]:
                            args = [""]
                        body = m.body
                        mp = {p: expand(a, macros, line, hide) for p, a in zip(m.params, args)}
                        raw = dict(zip(m.params, args))
                        def sub(mo):
                            nm = mo.group(0)
                            return mp.get(nm, nm)
                        def stringify(mo):
                            return '"' + raw.get(mo.group(1), "").replace("\\", "\\\\").replace('"', '\\"') + '"'
                        body = re.sub(r"#\s*([A-Za-z_]\w*)", stringify, body)
                        body = re.sub(r"[A-Za-z_]\w*", sub, body)
                        body = re.sub(r"\s*##\s*", "", body)
                        out.append(expand(body, macros, line, hide + (t,)))
                        i = k
                        continue
        out.append(t)
        i += 1
    return "".join(out)


def _eval_if(expr, macros, line):
    expr = re.sub(r"defined\s*\(\s*(\w+)\s*\)|defined\s+(\w+)", lambda m: "1" if (m.group(1) or m.group(2)) in macros else "0", expr)
    expr = expand(expr, macros, line)
    expr = re.sub(r"\b0[xX][0-9a-fA-F]+[uUlL]*|\b\d+[uUlL]*", lambda m: str(int(re.sub(r"[uUlL]+$", "", m.group(0)), 0)) if not re.match(r"0\d", m.group(0)) else str(int(re.sub(r"[uUlL]+$", "", m.group(0)), 8)), expr)
    expr = re.sub(r"[A-Za-z_]\w*", "0", expr)
    expr = expr.replace("&&", " and ").replace("||", " or ")
    expr = re.sub(r"!(?!=)", " not ", expr)
    expr = re.sub(r"/(?!/)", "//", expr)
    try:
        return bool(eval(expr, {"__builtins__": {}}, {}))
    except Exception:
        return False


def preprocess(src, read_header=None, depth=0):
    """returns (text, included_headers). Line numbers are preserved (directive lines become empty lines)."""
    macros = {k: Macro(None, v) for k, v in BASE_MACROS.items()}
    macros["assert"] = Macro(["e"], '__cc_assert((e), #e, __LINE__)')
    included = set()
    text = strip_comments(src.replace("\r\n", "\n").replace("\r", "\n"))
    lines = text.split("\n")
    out = []
    stack = []   # (active_now, taken_before, parent_active)
    active = True
    i = 0
    while i < len(lines):
        ln = lines[i]
        lineno = i + 1
        extra = 0
        while ln.endswith("\\") and i + 1 < len(lines):
            i += 1; extra += 1
            ln = ln[:-1] + lines[i]
        i += 1
        s = ln.strip()
        if s.startswith("#"):
            d = s[1:].strip()
            m = re.match(r"(\w+)\s*(.*)$", d, re.S)
            name, rest = (m.group(1), m.group(2)) if m else ("", "")
            if name in ("ifdef", "ifndef", "if"):
                if not active:
                    stack.append((False, True, False))
                else:
                    cond = (rest.split()[0] in macros) if name == "ifdef" else ((rest.split()[0] not in macros) if name == "ifndef" else _eval_if(rest, macros, lineno)) if rest.strip() else False
                    stack.append((cond, cond, True)); active = cond
            elif name in ("elif", "else"):
                if stack:
                    cur, taken, parent = stack.pop()
                    if not parent:
                        stack.append((False, True, False)); active = False
                    else:
                        cond = (not taken) if name == "else" else ((not taken) and _eval_if(rest, macros, lineno))
                        stack.append((cond, taken or cond, True)); active = cond
            elif name == "endif":
                if stack:
                    stack.pop()
                active = all(a for a, _, _ in stack) if stack else True
                if stack and not stack[-1][2]:
                    active = False
            elif active and name == "include":
                mm = re.match(r'[<"]([^>"]+)[>"]', rest.strip())
                if not mm:
                    raise CompileError("#include expects <file.h> or \"file.h\"", lineno, 1)
                h = mm.group(1)
                if h in HEADERS:
                    included.add(h)
                    if h == "stdbool.h":
                        for k, v in STDBOOL_MACROS.items():
                            macros[k] = Macro(None, v)
                else:
                    body = read_header(h) if (read_header and depth < 5) else None
                    if body is None:
                        near = difflib.get_close_matches(h, sorted(HEADERS), 1, 0.6)
                        raise CompileError("Cannot find the header '%s'" % h, lineno, 1, "IncludeError",
                                           "This offline C only has the standard headers%s." % ((" - did you mean <%s>?" % near[0]) if near else ""))
                    sub, inc2 = preprocess(body, read_header, depth + 1)
                    included |= inc2
                    out.append(" ".join(x for x in sub.split("\n")) + "\n" * extra)
                    out.append("\n") if False else None
                    continue_marker = True
                    out[-1] = out[-1]
                    out.append("")
                    out.pop()
                    out.append("")
                    # the included text sits on this line
                    out[-2] = out[-2]
                    out.pop(-1)
                    out[-1] = out[-1]
                    continue
            elif active and name == "define":
                mm = re.match(r"([A-Za-z_]\w*)(\(([^)]*)\))?\s*(.*)$", rest, re.S)
                if mm:
                    params = None
                    if mm.group(2) is not None:
                        params = [p.strip() for p in mm.group(3).split(",") if p.strip()]
                    macros[mm.group(1)] = Macro(params, mm.group(4).strip())
            elif active and name == "undef":
                macros.pop(rest.strip(), None)
            elif active and name == "error":
                raise CompileError("#error " + rest, lineno, 1)
            out.append("" + "\n" * extra)
            continue
        out.append((expand(ln, macros, lineno) if active else "") + "\n" * extra)
    return "\n".join(x.rstrip("\n") if False else x for x in out) if False else "\n".join(_join_lines(out)), included


def _join_lines(parts):
    # every element is one logical line followed by its own extra newlines; rebuild without double counting
    res = []
    for p in parts:
        res.append(p)
    return [x.replace("\n", "\n") for x in res]


# ============================================================== type-building from pycparser nodes
class TypeEnv(object):
    def __init__(self):
        self.tags = {}      # "struct Foo" / "union Foo" / "enum Foo" -> Ty
        self.typedefs = {}  # name -> Ty
        self.anon = 0

    def tagname(self, kind, name):
        return "%s %s" % (kind, name) if name else None

    def base_from_specs(self, names, node, line):
        names = list(names)
        uns = "unsigned" in names
        sig = "signed" in names
        names = [n for n in names if n not in ("unsigned", "signed", "const", "volatile", "restrict", "_Thread_local", "static", "extern", "inline", "auto", "register")]
        key = " ".join(sorted(set(names))) if names else "int"
        table = {
            "void": VOID, "char": UCHAR if uns else CHAR, "_Bool": BOOL, "float": FLOAT, "double": DOUBLE,
            "long double": DOUBLE, "int": UINT if uns else INT, "short": USHORT if uns else SHORT,
            "short int": USHORT if uns else SHORT, "long": ULONG if uns else LONG, "long int": ULONG if uns else LONG,
            "long long": ULLONG if uns else LLONG, "long long int": ULLONG if uns else LLONG,
            "": UINT if uns else INT,
        }
        if key in table:
            return table[key]
        if len(names) == 1 and names[0] in self.typedefs:
            return self.typedefs[names[0]]
        raise CompileError("Unknown type '%s'" % (" ".join(names) or "int"), line, 1, "TypeError")

    def resolve_decl_type(self, decl, line, allow_incomplete=False):
        """decl: pycparser TypeDecl/PtrDecl/ArrayDecl/FuncDecl chain. Returns Ty."""
        return self._walk(decl, line, allow_incomplete)

    def _walk(self, node, line, allow_incomplete):
        if isinstance(node, c_ast.PtrDecl):
            return ptr(self._walk(node.type, line, True))
        if isinstance(node, c_ast.ArrayDecl):
            inner = self._walk(node.type, line, allow_incomplete)
            if node.dim is not None:
                # resolve NOW (not deferred): a nested array (int m[2][3]) needs every dimension sized
                # before the outer one can compute its own size, since size = inner.size * n.
                n = self.const_int(node.dim)
                t = arr(inner, n)
            else:
                # size is not written here: either "int a[]" (comes from an initializer - caller resolves
                # it) or an incomplete type used only behind a pointer/param. t._dimnode stays None,
                # and do_decl()/const_eval() fall back to the initializer-length path for this case.
                t = arr(inner, None)
            return t
        if isinstance(node, c_ast.FuncDecl):
            ret = self._walk(node.type, line, True)
            params, var = [], False
            plist = node.args.params if node.args else []
            for p in plist:
                if isinstance(p, c_ast.EllipsisParam):
                    var = True
                    continue
                if isinstance(p, c_ast.ID):
                    continue
                pt = self._walk(p.type, line, True)
                if pt.k == "arr":
                    pt = ptr(pt.to)
                params.append((p.name, pt))
            if len(plist) == 1 and isinstance(plist[0], c_ast.Typename):
                nm = " ".join(plist[0].type.type.names) if hasattr(plist[0].type, "type") else ""
                if nm == "void":
                    params = []
            return func_t(ret, params, var)
        if isinstance(node, c_ast.TypeDecl):
            return self._walk(node.type, line, allow_incomplete)
        if isinstance(node, c_ast.IdentifierType):
            return self.base_from_specs(node.names, node, line)
        if isinstance(node, (c_ast.Struct, c_ast.Union)):
            return self.struct_type(node, line, allow_incomplete)
        if isinstance(node, c_ast.Enum):
            return self.enum_type(node, line)
        raise CompileError("Unsupported type", line, 1, "TypeError")

    def struct_type(self, node, line, allow_incomplete):
        kind = "union" if isinstance(node, c_ast.Union) else "struct"
        key = self.tagname(kind, node.name) if node.name else None
        t = self.tags.get(key) if key else None
        if t is None:
            t = Ty("struct", name=node.name or ("<anon:%d>" % self._next_anon()))
            t.var = isinstance(node, c_ast.Union)
            t.done = False
            if key:
                self.tags[key] = t
        if node.decls is not None:
            fields = []
            for d in node.decls:
                if d.bitsize is not None:
                    raise CompileError("Bit-fields are not supported in this C interpreter", line, 1, "Unsupported")
                ft = self.resolve_decl_type(d.type, line)
                if getattr(ft, "_dimnode", None) is not None:
                    ft = arr(ft.to, self.const_int(ft._dimnode))
                fields.append((d.name, ft))
            layout_struct(t, fields, isinstance(node, c_ast.Union))
        elif not allow_incomplete and not t.done:
            raise CompileError("'%s' has an incomplete type here" % type_name(t), line, 1, "TypeError")
        return t

    def enum_type(self, node, line):
        key = self.tagname("enum", node.name) if node.name else None
        t = self.tags.get(key) if key else None
        if t is None:
            t = Ty("int", 4, 4, True, name="int")
            t.fmt, t.mask, t.lo, t.hi = INT.fmt, INT.mask, INT.lo, INT.hi   # an enum behaves exactly like int
            if key:
                self.tags[key] = t
        if node.values is not None:
            t.fields = {}
            cur = 0
            for e in node.values.enumerators:
                if e.value is not None:
                    cur = self.const_int(e.value)
                t.fields[e.name] = cur
                cur += 1
        return t

    def const_int(self, node):
        v = const_eval(node, self)
        if v is None:
            raise CompileError("Array size / enum value must be a constant", getattr(node, "coord", None) and node.coord.line or 0, 1)
        return int(v)

    def _next_anon(self):
        self.anon += 1
        return self.anon


def const_eval(node, env):
    """best-effort constant folding for array sizes and enum values (no variables)."""
    if isinstance(node, c_ast.Constant):
        return _const_value(node)
    if isinstance(node, c_ast.BinaryOp):
        a, b = const_eval(node.left, env), const_eval(node.right, env)
        if a is None or b is None:
            return None
        ops = {"+": lambda x, y: x + y, "-": lambda x, y: x - y, "*": lambda x, y: x * y,
               "/": lambda x, y: x // y if isinstance(x, int) else x / y, "%": lambda x, y: x % y,
               "<<": lambda x, y: x << y, ">>": lambda x, y: x >> y, "&": lambda x, y: x & y,
               "|": lambda x, y: x | y, "^": lambda x, y: x ^ y}
        return ops.get(node.op, lambda x, y: None)(a, b)
    if isinstance(node, c_ast.UnaryOp):
        v = const_eval(node.expr, env)
        if v is None:
            return None
        return {"-": lambda x: -x, "+": lambda x: x, "~": lambda x: ~x, "!": lambda x: int(not x), "sizeof": None}.get(node.op, lambda x: None)(v)
    if isinstance(node, c_ast.Cast):
        return const_eval(node.expr, env)
    if isinstance(node, c_ast.ID) and env is not None and env.typedefs.get("__enum__" + node.name) is not None:
        return env.typedefs["__enum__" + node.name]
    return None


def _const_value(node):
    s = node.value
    if node.type in ("int", "unsigned int", "long", "unsigned long", "long long", "unsigned long long"):
        s2 = re.sub(r"[uUlL]+$", "", s)
        return int(s2, 0)
    if node.type in ("float", "double"):
        return float(s.rstrip("fFlL"))
    if node.type == "char":
        return ord(unescape_char(s[1:-1]))
    if node.type == "string":
        return None
    return None


_ESC = {"n": "\n", "t": "\t", "r": "\r", "0": "\0", "\\": "\\", "'": "'", '"': '"', "a": "\a", "b": "\b", "f": "\f", "v": "\v", "?": "?"}


def unescape_char(s):
    if not s.startswith("\\"):
        return s
    c = s[1]
    if c == "x":
        return chr(int(s[2:], 16) & 0xFF)
    if c.isdigit():
        return chr(int(s[1:], 8) & 0xFF)
    return _ESC.get(c, c)


def unescape_str(s):
    out, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c == "\\" and i + 1 < n:
            d = s[i + 1]
            if d == "x":
                j = i + 2
                while j < n and s[j] in "0123456789abcdefABCDEF":
                    j += 1
                out.append(chr(int(s[i + 2:j], 16) & 0xFF)); i = j; continue
            if d.isdigit():
                j = i + 1
                while j < n and j < i + 4 and s[j].isdigit():
                    j += 1
                out.append(chr(int(s[i + 1:j], 8) & 0xFF)); i = j; continue
            out.append(_ESC.get(d, d)); i += 2; continue
        out.append(c); i += 1
    return "".join(out)
class Val(object):
    """an rvalue: a Python number/0-or-address together with its C type.
    For a struct value, `v` is normally an address in Memory; `raw` (bytes), when set, means the struct's
    content is NOT yet anywhere in Memory (used only while a struct is being returned from a function)."""
    __slots__ = ("v", "t", "raw")
    def __init__(self, v, t, raw=None):
        self.v, self.t, self.raw = v, t, raw


class LVal(object):
    """an lvalue: an address together with the type stored there."""
    __slots__ = ("a", "t")
    def __init__(self, a, t):
        self.a, self.t = a, t


class BreakSig(Exception): pass
class ContinueSig(Exception): pass
class ReturnSig(Exception):
    def __init__(self, v): self.v = v
class GotoSig(Exception):
    def __init__(self, label): self.label = label


def line_of(node):
    c = getattr(node, "coord", None)
    return c.line if c else 0


class Func(object):
    def __init__(self, name, ty, node, is_def):
        self.name, self.ty, self.node, self.is_def = name, ty, node, is_def


class Interp(object):
    MAX_STEPS = 60_000_000
    MAX_CALL_DEPTH = 2000

    def __init__(self, io):
        self.mem = Memory()
        self.env = TypeEnv()
        self.globals = {}      # name -> LVal | Func | int(enum const)
        self.funcs = {}
        self.io = io            # object with .write(s), .input(prompt)->str, .gfx(cmds)
        self.steps = 0
        self.depth = 0
        self.scopes = []        # list of dict name-> LVal (call stack, innermost last)
        self.cur_line = 0
        self.files = {}         # FILE* int -> file-like
        self.next_fileno = FILE0
        self.strtok_save = {}
        self.errno_addr = None
        self.statics = {}   # id(decl_node) -> LVal   (a "static" local keeps ONE address for the whole program)

    # ---------------- scope helpers
    def push_scope(self):
        self.scopes.append({})

    def pop_scope(self):
        self.scopes.pop()

    def declare_local(self, name, ty, node=None):
        if ty.k == "arr" and ty.n is None and getattr(ty, "_dimnode", None) is None:
            raise CompileError("Array '%s' needs a size" % name, line_of(node) if node else self.cur_line, 1, "TypeError")
        a = self.mem.sp
        a = (a + ty.align - 1) // ty.align * ty.align
        self.mem.sp = a + max(ty.size, 1)
        if self.mem.sp > STK1:
            raise RunError("Stack overflow (too much recursion, or variables too large)", "StackOverflow",
                           "A function calls itself without ever stopping, or a local array is too big.")
        lv = LVal(a, ty)
        self.scopes[-1][name] = lv
        return lv

    def lookup(self, name, line):
        for sc in reversed(self.scopes):
            if name in sc:
                return sc[name]
        if name in self.globals:
            return self.globals[name]
        raise RunError("'%s' is not defined" % name, "NameError",
                       self._suggest(name))

    def _suggest(self, name):
        pool = set(self.globals) | set(self.funcs)
        for sc in self.scopes:
            pool |= set(sc)
        near = difflib.get_close_matches(name, sorted(pool), 1, 0.7)
        return ("Did you mean '%s'?" % near[0]) if near else "Check the spelling, and that it was declared before this line."

    def step(self):
        self.steps += 1
        if self.steps > self.MAX_STEPS:
            raise RunError("The program did not finish in time (an infinite loop?)", "Timeout",
                           "Check that every loop's condition eventually becomes false.")

    # ---------------- values <-> memory
    def load(self, lv):
        if lv.t.k == "arr":
            return Val(lv.a, ptr(lv.t.to))        # array value = pointer to its first element (decay)
        if lv.t.k == "struct":
            return Val(lv.a, lv.t)                 # struct "value" kept as its address; copy happens on assignment
        self.mem.chk(lv.a, lv.t.size)
        raw = bytes(self.mem.buf[lv.a:lv.a + lv.t.size])
        if lv.t.k == "float":
            v = lv.t.fmt.unpack(raw)[0]
        else:
            v = lv.t.fmt.unpack(raw)[0]
        return Val(v, lv.t)

    def store(self, lv, val):
        val = self.convert(val, lv.t)
        if lv.t.k == "struct":
            self.mem.chk(lv.a, lv.t.size, True)
            self.mem.chk(val.v, lv.t.size)
            self.mem.buf[lv.a:lv.a + lv.t.size] = self.mem.buf[val.v:val.v + lv.t.size]
            return
        data = lv.t.fmt.pack(wrap(int(val.v), lv.t) if lv.t.k != "float" else val.v)
        self.mem.put(lv.a, data)

    def convert(self, val, t, line=None):
        v, src = val.v, val.t
        if t.k == "void":
            return Val(0, t)
        if t.k == "struct":
            if src.k != "struct" or src is not t:
                raise RunError("Cannot convert %s to %s" % (type_name(src), type_name(t)), "TypeError")
            return val
        if t.k == "ptr":
            if src.k == "arr":
                return Val(v, t)
            if src.k == "ptr" or src.k == "func":
                return Val(v & M64, t)
            if src.k == "int":
                return Val(v & M64, t)
            raise RunError("Cannot convert %s to a pointer" % type_name(src), "TypeError")
        if t.k == "int":
            if src.k == "float":
                if v != v or v in (math.inf, -math.inf):
                    return Val(0, t)
                return Val(wrap(int(v), t), t)
            if src.k == "ptr" or src.k == "arr":
                return Val(wrap(v, t), t)
            return Val(wrap(int(v), t), t)
        if t.k == "float":
            fv = float(v)
            return Val(rnd32(fv) if t.size == 4 else fv, t)
        return val

    # ---------------- sizeof / type helpers
    def type_of_typename(self, node, line):
        ty = self.env.resolve_decl_type(node.type, line, True)
        if getattr(ty, "_dimnode", None) is not None:
            ty = arr(ty.to, self.env.const_int(ty._dimnode))
        return ty

    # ================= expressions =================
    def eval(self, node):
        self.step()
        m = getattr(self, "e_" + type(node).__name__, None)
        if m is None:
            raise RunError("This C feature is not supported yet: %s" % type(node).__name__, "Unsupported")
        return m(node)

    def addr(self, node):
        """evaluate to an LVal (fails if node is not an lvalue expression)."""
        self.step()
        m = getattr(self, "a_" + type(node).__name__, None)
        if m is None:
            raise RunError("Expression is not assignable (not an lvalue)", "TypeError")
        return m(node)

    # ---- literals / names
    def e_Constant(self, n):
        t = n.type
        if t in ("int", "long", "long long"):
            s2 = n.value.rstrip("uUlL")
            ty = ULONG if "u" in n.value.lower() and "l" in n.value.lower() else (UINT if "u" in n.value.lower() else (LONG if "l" in n.value.lower() else INT))
            return Val(wrap(int(s2, 0), ty), ty)
        if t in ("unsigned int", "unsigned long", "unsigned long long"):
            return Val(wrap(int(re.sub(r"[uUlL]+$", "", n.value), 0), ULONG), ULONG)
        if t == "float":
            return Val(rnd32(float(n.value.rstrip("fF"))), FLOAT)
        if t == "double":
            return Val(float(n.value.rstrip("lL")), DOUBLE)
        if t == "char":
            return Val(ord(unescape_char(n.value[1:-1])), CHAR)
        if t == "string":
            b = unescape_str(n.value[1:-1]).encode("latin-1", "replace") + b"\0"
            return Val(self.mem.literal(b), ptr(CHAR))
        raise RunError("Unsupported literal", "Unsupported")

    def e_ID(self, n):
        x = self.lookup(n.name, line_of(n))
        if isinstance(x, LVal):
            return self.load(x)
        if isinstance(x, Func):
            return Val(FUNC0 + (id(x) % 0xFFFF), x.ty)
        if isinstance(x, int):
            return Val(x, INT)
        raise RunError("'%s' cannot be used as a value" % n.name, "TypeError")

    def a_ID(self, n):
        x = self.lookup(n.name, line_of(n))
        if not isinstance(x, LVal):
            raise RunError("'%s' is not a variable" % n.name, "TypeError")
        return x

    def a_UnaryOp(self, n):
        if n.op == "*":
            v = self.eval(n.expr)
            if v.t.k not in ("ptr",):
                raise RunError("Only a pointer can be dereferenced with *", "TypeError")
            return LVal(v.v, v.t.to)
        raise RunError("Expression is not assignable", "TypeError")

    def a_ArrayRef(self, n):
        base = self.eval(n.name)
        idx = self.eval(n.subscript)
        if base.t.k != "ptr":
            raise RunError("Only an array or pointer can be indexed with [ ]", "TypeError")
        off = int(idx.v) * base.t.to.size
        return LVal((base.v + off) & M64, base.t.to)

    def a_StructRef(self, n):
        if n.type == "->":
            base = self.eval(n.name)
            if base.t.k != "ptr" or base.t.to.k != "struct":
                raise RunError("-> used on something that is not a struct pointer", "TypeError")
            st, a = base.t.to, base.v
        else:
            lv = self.addr(n.name)
            if lv.t.k != "struct":
                raise RunError(". used on something that is not a struct", "TypeError")
            st, a = lv.t, lv.a
        if n.field.name not in st.fields:
            near = difflib.get_close_matches(n.field.name, list(st.fields), 1, 0.6)
            raise RunError("%s has no member called '%s'%s" % (type_name(st), n.field.name,
                           (" (did you mean '%s'?)" % near[0]) if near else ""), "TypeError")
        off, ft = st.fields[n.field.name]
        return LVal((a + off) & M64, ft)

    def a_Cast(self, n):
        raise RunError("A cast expression is not assignable", "TypeError")

    # ---- arrays / struct access as rvalues
    def e_ArrayRef(self, n):
        return self.load(self.a_ArrayRef(n))

    def e_StructRef(self, n):
        return self.load(self.a_StructRef(n))

    def e_UnaryOp(self, n):
        op = n.op
        if op == "&":
            lv = self.addr(n.expr)
            return Val(lv.a, ptr(lv.t))
        if op == "*":
            v = self.eval(n.expr)
            if v.t.k != "ptr":
                raise RunError("Only a pointer can be dereferenced with *", "TypeError")
            return self.load(LVal(v.v, v.t.to))
        if op in ("p++", "p--", "++", "--"):
            lv = self.addr(n.expr)
            old = self.load(lv)
            step = lv.t.to.size if lv.t.k == "ptr" else 1
            delta = step if "++" in op else -step
            newv = Val(old.v + delta, old.t) if old.t.k != "float" else Val(old.v + (1 if "++" in op else -1), old.t)
            self.store(lv, newv)
            return old if op.startswith("p") else self.load(lv)
        if op == "sizeof":
            return Val(self._sizeof_expr(n.expr), ULONG)
        v = self.eval(n.expr)
        if op == "-":
            t = promote(v.t) if v.t.k == "int" else v.t
            return Val(wrap(-v.v, t) if t.k == "int" else -v.v, t)
        if op == "+":
            return Val(v.v, promote(v.t) if v.t.k == "int" else v.t)
        if op == "!":
            return Val(0 if v.v else 1, INT)
        if op == "~":
            t = promote(v.t)
            return Val(wrap(~int(v.v), t), t)
        raise RunError("Unsupported operator '%s'" % op, "Unsupported")

    def _sizeof_expr(self, node):
        if isinstance(node, c_ast.Typename):
            return self.type_of_typename(node, line_of(node)).size
        try:
            # sizeof does NOT decay an array to a pointer (unlike every other use of the expression),
            # so for anything that is an lvalue, use its real type, not eval()'s decayed one.
            return self.addr(node).t.size
        except RunError:
            return self.eval(node).t.size

    def e_Cast(self, n):
        v = self.eval(n.expr)
        t = self.type_of_typename(n.to_type, line_of(n))
        return self.convert(v, t)

    BINOPS_ARITH = {"+", "-", "*", "/", "%"}
    BINOPS_BIT = {"&", "|", "^", "<<", ">>"}
    BINOPS_CMP = {"<", ">", "<=", ">=", "==", "!="}

    def e_BinaryOp(self, n):
        if n.op == "&&":
            return Val(1 if (self.eval(n.left).v and self.eval(n.right).v) else 0, INT)
        if n.op == "||":
            return Val(1 if (self.eval(n.left).v or self.eval(n.right).v) else 0, INT)
        l, r = self.eval(n.left), self.eval(n.right)
        return self._binop(n.op, l, r)

    def _binop(self, op, l, r):
        if op in ("+", "-") and (l.t.k == "ptr" or r.t.k == "ptr"):
            return self._ptr_arith(op, l, r)
        if op in self.BINOPS_CMP:
            if l.t.k == "ptr" or r.t.k == "ptr":
                a = l.v if l.t.k in ("ptr",) else int(l.v)
                b = r.v if r.t.k in ("ptr",) else int(r.v)
            else:
                a, b = l.v, r.v
            res = {"<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b, "==": a == b, "!=": a != b}[op]
            return Val(1 if res else 0, INT)
        t = arith_conv(l.t, r.t)
        a, b = self.convert(l, t).v, self.convert(r, t).v
        if op in self.BINOPS_BIT:
            ti = promote(t) if t.k == "int" else INT
            a, b = int(a), int(b)
            if op == "&": v = a & b
            elif op == "|": v = a | b
            elif op == "^": v = a ^ b
            elif op == "<<": v = a << (b & 63)
            else: v = (a & ti.mask) >> (b & 63) if not ti.signed else a >> (b & 63)
            return Val(wrap(v, ti), ti)
        if op == "/":
            if t.k == "int":
                if b == 0:
                    raise RunError("Division by zero", "ZeroDivisionError", "Check the divisor before dividing.")
                q = abs(a) // abs(b)
                if (a < 0) != (b < 0):
                    q = -q
                return Val(wrap(q, t), t)
            if b == 0:
                return Val(math.inf if a > 0 else (-math.inf if a < 0 else math.nan), t)
            return Val(a / b, t)
        if op == "%":
            if b == 0:
                raise RunError("Division by zero (%)", "ZeroDivisionError", "Check the divisor before using %.")
            r2 = abs(a) % abs(b)
            if a < 0:
                r2 = -r2
            return Val(wrap(r2, t) if t.k == "int" else math.fmod(a, b), t)
        if op == "+":
            return Val(wrap(a + b, t) if t.k == "int" else (rnd32(a + b) if t.size == 4 else a + b), t)
        if op == "-":
            return Val(wrap(a - b, t) if t.k == "int" else (rnd32(a - b) if t.size == 4 else a - b), t)
        if op == "*":
            return Val(wrap(a * b, t) if t.k == "int" else (rnd32(a * b) if t.size == 4 else a * b), t)
        raise RunError("Unsupported operator '%s'" % op, "Unsupported")

    def _ptr_arith(self, op, l, r):
        if l.t.k == "ptr" and r.t.k == "ptr":
            if op != "-" or l.t.to.size != r.t.to.size:
                raise RunError("Cannot combine two pointers with +", "TypeError")
            return Val((int(l.v) - int(r.v)) // max(l.t.to.size, 1), LONG)
        p, n = (l, r) if l.t.k == "ptr" else (r, l)
        delta = int(n.v) * p.t.to.size
        a = (p.v + delta) if op == "+" else (p.v - delta)
        return Val(a & M64, p.t)

    def e_TernaryOp(self, n):
        return self.eval(n.iftrue if self.eval(n.cond).v else n.iffalse)

    def e_Assignment(self, n):
        lv = self.addr(n.lvalue)
        if n.op == "=":
            v = self.eval(n.rvalue)
        else:
            cur = self.load(lv)
            v = self._binop(n.op[:-1], cur, self.eval(n.rvalue))
        self.store(lv, v)
        return self.load(lv)

    def e_Comma_(self, n):
        pass

    def e_ExprList(self, n):
        v = None
        for e in n.exprs:
            v = self.eval(e)
        return v

    def e_FuncCall(self, n):
        name = n.name.name if isinstance(n.name, c_ast.ID) else None
        args = [self.eval(a) for a in (n.args.exprs if n.args else [])]
        if name and name in LIBC:
            return LIBC[name](self, args, line_of(n))
        if name and name in self.funcs:
            return self.call_user(self.funcs[name], args, line_of(n))
        if name:
            near = difflib.get_close_matches(name, list(self.funcs) + list(LIBC), 1, 0.7)
            raise RunError("'%s' is not declared" % name, "NameError",
                           ("Did you mean '%s'?" % near[0]) if near else "This function is not defined and is not part of the supported standard library.")
        fv = self.eval(n.name)
        raise RunError("Calling through a function pointer is not supported yet", "Unsupported")

    def e_SizeofT(self, n):
        return Val(self.type_of_typename(n.type, line_of(n)).size, ULONG)

    def call_user(self, func, args, line):
        self.depth += 1
        if self.depth > self.MAX_CALL_DEPTH:
            self.depth -= 1
            raise RunError("Too much recursion (stack overflow)", "StackOverflow",
                           "A function keeps calling itself without a base case that stops it.")
        save_sp = self.mem.sp
        self.push_scope()
        try:
            params = func.ty.params
            if not func.ty.var and len(args) != len(params):
                raise RunError("'%s' expects %d argument(s) but got %d" % (func.name, len(params), len(args)), "TypeError")
            for (pname, pty), a in zip(params, args):
                lv = self.declare_local(pname or "_", pty)
                self.store(lv, a)
            raw_ret = None
            try:
                self.exec_stmt(func.node.body)
                ret = Val(0, func.ty.ret) if func.ty.ret.k != "void" else Val(0, VOID)
            except ReturnSig as r:
                if r.v.raw is not None:
                    raw_ret = r.v.raw   # struct bytes: materialise AFTER this frame is popped (see below)
                    ret = None
                else:
                    ret = self.convert(r.v, func.ty.ret) if func.ty.ret.k != "void" else Val(0, VOID)
        finally:
            self.pop_scope()
            self.mem.sp = save_sp     # back to the CALLER's frame
            self.depth -= 1
        if raw_ret is not None:
            t = func.ty.ret
            a = (self.mem.sp + t.align - 1) // t.align * t.align
            self.mem.sp = a + t.size             # now allocated in the CALLER's frame: survives
            self.mem.buf[a:a + t.size] = raw_ret
            ret = Val(a, t)
        return ret

    # ================= statements =================
    def exec_stmt(self, node):
        if node is None:
            return
        c = getattr(node, "coord", None)
        if c:
            self.cur_line = c.line
            self.mem.line = c.line
        self.step()
        m = getattr(self, "s_" + type(node).__name__, None)
        if m is None:
            raise RunError("This C statement is not supported yet: %s" % type(node).__name__, "Unsupported")
        m(node)

    def s_Compound(self, n):
        self.push_scope()
        try:
            self._run_block(n.block_items or [])
        finally:
            self.pop_scope()

    def _run_block(self, items, start=0):
        i = start
        while i < len(items):
            it = items[i]
            try:
                if isinstance(it, c_ast.Decl):
                    self.do_decl(it)
                else:
                    self.exec_stmt(it)
            except GotoSig as g:
                j = self._find_label(items, g.label)
                if j is None:
                    raise
                i = j
                continue
            i += 1

    def _find_label(self, items, label):
        for i, it in enumerate(items):
            if isinstance(it, c_ast.Label) and it.name == label:
                return i
        return None

    def s_Decl(self, n):
        self.do_decl(n)

    def s_FuncCall(self, n):
        self.eval(n)

    def s_Assignment(self, n):
        self.eval(n)

    def s_UnaryOp(self, n):
        self.eval(n)

    def s_ExprList(self, n):
        self.eval(n)

    def s_If(self, n):
        if self.eval(n.cond).v:
            self.exec_stmt(n.iftrue)
        elif n.iffalse is not None:
            self.exec_stmt(n.iffalse)

    def s_While(self, n):
        while self.eval(n.cond).v:
            try:
                self.exec_stmt(n.stmt)
            except BreakSig:
                break
            except ContinueSig:
                continue

    def s_DoWhile(self, n):
        while True:
            try:
                self.exec_stmt(n.stmt)
            except BreakSig:
                break
            except ContinueSig:
                pass
            if not self.eval(n.cond).v:
                break

    def s_For(self, n):
        self.push_scope()
        try:
            if n.init is not None:
                if isinstance(n.init, c_ast.DeclList):
                    for d in n.init.decls:
                        self.do_decl(d)
                elif isinstance(n.init, c_ast.Decl):
                    self.do_decl(n.init)
                else:
                    self.eval(n.init)
            while n.cond is None or self.eval(n.cond).v:
                try:
                    self.exec_stmt(n.stmt)
                except BreakSig:
                    break
                except ContinueSig:
                    pass
                if n.next is not None:
                    self.eval(n.next)
        finally:
            self.pop_scope()

    def s_Break(self, n):
        raise BreakSig()

    def s_Continue(self, n):
        raise ContinueSig()

    def s_Return(self, n):
        if n.expr is None:
            raise ReturnSig(Val(0, INT))
        v = self.eval(n.expr)
        if v.t.k == "struct":
            # the struct's bytes live in the callee's stack frame, which call_user is about to pop:
            # pull them into a plain Python bytes object now, while they are still valid.
            v = Val(0, v.t, raw=bytes(self.mem.buf[v.v:v.v + v.t.size]))
        raise ReturnSig(v)

    def s_Goto(self, n):
        raise GotoSig(n.name)

    def s_Label(self, n):
        self.exec_stmt(n.stmt)

    def s_EmptyStatement(self, n):
        pass

    def s_Switch(self, n):
        v = self.eval(n.cond)
        items = n.stmt.block_items or []
        flat = self._flatten_switch(items)   # one list: a marker, then that case's own statements, for every case/default
        target = default = None
        pos = 0
        for it in items:
            if isinstance(it, c_ast.Case):
                cv = const_eval(it.expr, self.env)
                if cv is None:
                    cv = self.eval(it.expr).v
                if target is None and cv == v.v:
                    target = pos          # index INTO flat, not into items
                pos += 1 + len(it.stmts or [])
            elif isinstance(it, c_ast.Default):
                default = pos
                pos += 1 + len(it.stmts or [])
            else:
                pos += 1
        start = target if target is not None else default
        if start is None:
            return
        self.push_scope()
        try:
            try:
                self._run_block(flat, start)
            except BreakSig:
                pass
        finally:
            self.pop_scope()

    def _flatten_switch(self, items):
        out = []
        for it in items:
            if isinstance(it, c_ast.Case):
                out.append(c_ast.EmptyStatement(coord=it.coord))
                if it.stmts:
                    out.extend(it.stmts)
            elif isinstance(it, c_ast.Default):
                out.append(c_ast.EmptyStatement(coord=it.coord))
                if it.stmts:
                    out.extend(it.stmts)
            else:
                out.append(it)
        return out

    # ================= declarations & initializers =================
    def do_decl(self, n):
        if isinstance(n.type, (c_ast.Struct, c_ast.Union)) and n.name is None:
            self.env.struct_type(n.type, line_of(n), True)
            return
        if isinstance(n.type, c_ast.Enum) and n.name is None:
            et = self.env.enum_type(n.type, line_of(n))
            if n.type.values is not None:   # a LOCAL "enum Color { RED, GREEN, ... };": its names are local too
                for name, value in et.fields.items():
                    self.scopes[-1][name] = value
            return
        ty = self.env.resolve_decl_type(n.type, line_of(n))
        if "typedef" in (n.storage or []):
            if getattr(ty, "_dimnode", None) is not None:
                ty = arr(ty.to, self.env.const_int(ty._dimnode))
            self.env.typedefs[n.name] = ty
            return
        if ty.k == "func":
            self.funcs.setdefault(n.name, Func(n.name, ty, n, False))
            return
        if getattr(ty, "_dimnode", None) is not None:
            ty = arr(ty.to, self.env.const_int(ty._dimnode))
        if ty.k == "arr" and ty.n is None and n.init is not None:
            ty = arr(ty.to, self._init_array_len(n.init))
        if "static" in (n.storage or []):
            lv = self.statics.get(id(n))
            if lv is None:
                a = self.mem.static(max(ty.size, 1), ty.align)
                self.mem.buf[a:a + ty.size] = b"\0" * ty.size
                lv = LVal(a, ty)
                self.statics[id(n)] = lv
                if n.init is not None:
                    self.init_lvalue(lv, n.init)       # runs only the FIRST time this declaration is reached
            self.scopes[-1][n.name] = lv               # the name is still local; its storage is not
            return
        lv = self.declare_local(n.name, ty, n)
        if n.init is not None:
            self.mem.buf[lv.a:lv.a + ty.size] = b"\0" * ty.size   # elements the initializer skips become 0
            self.init_lvalue(lv, n.init)
        else:
            self.mem.buf[lv.a:lv.a + ty.size] = b"\xcd" * ty.size  # no initializer at all: garbage, like real C

    def _init_array_len(self, init):
        if isinstance(init, c_ast.InitList):
            return len(init.exprs)
        if isinstance(init, c_ast.Constant) and init.type == "string":
            return len(unescape_str(init.value[1:-1])) + 1
        return 1

    def init_lvalue(self, lv, node):
        if isinstance(node, c_ast.InitList):
            self._init_list(lv, node)
            return
        if lv.t.k == "arr" and lv.t.to in (CHAR, UCHAR) and isinstance(node, c_ast.Constant) and node.type == "string":
            data = unescape_str(node.value[1:-1]).encode("latin-1", "replace") + b"\0"
            data = data[:lv.t.n] + b"\0" * max(0, lv.t.n - len(data))
            self.mem.put(lv.a, data)
            return
        self.store(lv, self.eval(node))

    def _leaf_slots(self, t, base):
        """every scalar/pointer leaf of an aggregate type, as (address, type), in C's storage order."""
        if t.k == "arr":
            for i in range(t.n or 0):
                for s in self._leaf_slots(t.to, base + i * t.to.size):
                    yield s
        elif t.k == "struct":
            for name in (t.n or list(t.fields)):
                off, ft = t.fields[name]
                for s in self._leaf_slots(ft, base + off):
                    yield s
                if t.var:
                    break   # a union initializer only ever fills its first member
        else:
            yield (base, t)

    def _is_flat_scalar_list(self, node):
        return bool(node.exprs) and all(not isinstance(e, (c_ast.InitList, c_ast.NamedInitializer)) for e in node.exprs)

    def _init_list(self, lv, node):
        t = lv.t
        # "int c[2][2] = {1,2,3,4};" or "struct P pts[2] = {1,2,3,4};" : one flat list, no braces for the
        # inner rows at all. Spread the values across every leaf, in order (brace elision).
        # "int c[2][2] = {1,2,3,4};" style brace elision: ONLY for an array of arrays/structs, and only
        # when the item count does not already match one-item-per-row (that normal, more common case is
        # handled correctly below, including things like a char[]/struct whose own fields differ in type).
        if t.k == "arr" and t.to.k in ("arr", "struct") and self._is_flat_scalar_list(node) and len(node.exprs) != (t.n or 0):
            leaves = list(self._leaf_slots(t, lv.a))
            for (addr, lt), item in zip(leaves, node.exprs):
                self.init_lvalue(LVal(addr, lt), item)
            return
        if t.k == "arr":
            elt = t.to
            i = 0
            for item in node.exprs:
                if isinstance(item, c_ast.NamedInitializer):
                    for d in item.name:
                        if isinstance(d, c_ast.ID):
                            i = int(d.name)
                    item = item.expr
                if i >= (t.n or 0):
                    break
                self._init_one(LVal(lv.a + i * elt.size, elt), item)
                i += 1
            return
        if t.k == "struct":
            names = t.n or list(t.fields)
            idx = 0
            for item in node.exprs:
                if isinstance(item, c_ast.NamedInitializer):
                    fname = item.name[0].name
                    item = item.expr
                else:
                    fname = names[idx] if idx < len(names) else None
                    idx += 1
                if fname is None or fname not in t.fields:
                    continue
                off, ft = t.fields[fname]
                self._init_one(LVal(lv.a + off, ft), item)
                if not t.var:
                    idx = names.index(fname) + 1 if fname in names else idx
            return
        if node.exprs:
            self.init_lvalue(lv, node.exprs[0])

    def _init_one(self, lv, item):
        """one element/field of an array or struct initializer: InitList as usual; a plain string for a
        char array ("Amit" for char name[20]) fills the WHOLE array, as always; any other bare scalar
        where an aggregate is expected (e.g. the "0" in "int c[2][2] = {0};") sets just that aggregate's
        first leaf - everything else in it was already zeroed by do_decl."""
        is_char_array_string = (lv.t.k == "arr" and lv.t.to in (CHAR, UCHAR) and
                                isinstance(item, c_ast.Constant) and item.type == "string")
        if not isinstance(item, c_ast.InitList) and lv.t.k in ("arr", "struct") and not is_char_array_string:
            for addr, lt in self._leaf_slots(lv.t, lv.a):
                self.init_lvalue(LVal(addr, lt), item)
                break
            return
        self.init_lvalue(lv, item)
# ============================================================== printf / scanf style formatting
_FMT = re.compile(r"%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?(hh|h|ll|l|L|z|j|t)?([diouxXeEfFgGaAcspn%])")


def c_vprintf(it, fmt, args):
    out = []
    ai = 0
    i = 0
    while i < len(fmt):
        c = fmt[i]
        if c != "%":
            out.append(c); i += 1; continue
        m = _FMT.match(fmt, i)
        if not m:
            out.append(c); i += 1; continue
        flags, width, prec, lenmod, conv = m.groups()
        i = m.end()
        if conv == "%":
            out.append("%"); continue
        if width == "*":
            width = str(int(args[ai].v)); ai += 1
        if prec == "*":
            prec = str(int(args[ai].v)); ai += 1
        a = args[ai] if ai < len(args) else Val(0, INT); ai += 1
        out.append(_fmt_one(it, flags or "", width, prec, conv, a))
    return "".join(out)


def _fmt_one(it, flags, width, prec, conv, a):
    left = "-" in flags
    zero = "0" in flags and not left
    plus = "+" in flags
    space = " " in flags
    w = int(width) if width else 0
    if conv in "di":
        v = int(a.v)
        s = str(abs(v))
        if prec is not None:
            s = s.rjust(int(prec), "0")
        sign = "-" if v < 0 else ("+" if plus else (" " if space else ""))
        body = sign + s
    elif conv == "u":
        v = int(a.v) & (a.t.mask if a.t.k == "int" else M64)
        body = str(v)
    elif conv in "oxX":
        v = int(a.v) & (a.t.mask if a.t.k == "int" else M64)
        s = {"o": "%o", "x": "%x", "X": "%X"}[conv] % v
        if "#" in flags and v != 0:
            s = ("0" if conv == "o" else ("0x" if conv == "x" else "0X")) + s
        if prec is not None:
            s = s.rjust(int(prec), "0")
        body = s
    elif conv == "c":
        body = chr(int(a.v) & 0xFF)
    elif conv == "s":
        if a.t.k == "ptr":
            b = it.mem.cstr(a.v)
        else:
            b = b""
        s = b.decode("latin-1", "replace")
        if prec is not None:
            s = s[:int(prec)]
        body = s
    elif conv == "p":
        body = "0x%x" % (int(a.v) & M64) if a.v else "(nil)"
    elif conv in "eEfFgGaA":
        v = float(a.v)
        p = int(prec) if prec is not None else 6
        if conv in "fF":
            body = "%.*f" % (p, v)
        elif conv in "eE":
            body = ("%.*e" % (p, v)).replace("e", "e" + ("+" if v >= 0 else ""))
            if conv == "E":
                body = body.upper()
        else:
            body = "%.*g" % (p or 1, v)
            if conv == "G":
                body = body.upper()
        if v >= 0 and (plus or space):
            body = ("+" if plus else " ") + body
    else:
        body = ""
    if w:
        if zero and conv not in "cs" and not left:
            if body[:1] in "+-":
                body = body[0] + body[1:].rjust(w - 1, "0")
            else:
                body = body.rjust(w, "0")
        else:
            body = body.ljust(w) if left else body.rjust(w)
    return body


_SCANF_INT = re.compile(r"\s*[+-]?\d+")
_SCANF_FLT = re.compile(r"\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?")
_SCANF_WORD = re.compile(r"\s*(\S+)")


def c_scanf_into(it, fmt, ptrs, text):
    pos, done, pi = 0, 0, 0
    for m in re.finditer(r"%([*]?)(\d*)([dioxufgeEcs%])", fmt):
        star, width, conv = m.groups()
        if conv == "%":
            continue
        if conv == "c":
            if pos >= len(text):
                break
            ch = text[pos]; pos += 1
        else:
            mm = (_SCANF_INT if conv in "dioxu" else _SCANF_FLT if conv in "fge" else _SCANF_WORD).match(text, pos)
            if not mm:
                break
            pos = mm.end()
        if star:
            continue
        if pi >= len(ptrs):
            break
        p = ptrs[pi]; pi += 1
        if conv == "c":
            it.mem.put(p.v, bytes([ord(ch)]))
        elif conv in "dio u":
            it.mem.put(p.v, p.t.to.fmt.pack(wrap(int(mm.group(0)), p.t.to)))
        elif conv == "x":
            it.mem.put(p.v, p.t.to.fmt.pack(wrap(int(mm.group(0), 16) if mm.group(0).strip() else 0, p.t.to)))
        elif conv in "fge":
            it.mem.put(p.v, p.t.to.fmt.pack(float(mm.group(0))))
        else:
            b = (mm.group(1) if conv == "s" else mm.group(0)).encode("latin-1", "replace") + b"\0"
            it.mem.put(p.v, b)
        done += 1
    return done


# ============================================================== libc (function name -> python)
LIBC = {}


def libc(*names, **kw):
    def deco(f):
        for n in names:
            LIBC[n] = f
        return f
    return deco


@libc("printf")
def _printf(it, args, line):
    s = c_vprintf(it, it.mem.cstr(args[0].v).decode("latin-1", "replace"), args[1:])
    it.io.write(s)
    return Val(len(s), INT)


@libc("sprintf")
def _sprintf(it, args, line):
    s = c_vprintf(it, it.mem.cstr(args[1].v).decode("latin-1", "replace"), args[2:])
    it.mem.put(args[0].v, s.encode("latin-1", "replace") + b"\0")
    return Val(len(s), INT)


@libc("snprintf")
def _snprintf(it, args, line):
    n = int(args[1].v)
    s = c_vprintf(it, it.mem.cstr(args[2].v).decode("latin-1", "replace"), args[3:])
    b = s.encode("latin-1", "replace")
    if n > 0:
        it.mem.put(args[0].v, b[:n - 1] + b"\0")
    return Val(len(s), INT)


@libc("scanf")
def _scanf(it, args, line):
    fmt = it.mem.cstr(args[0].v).decode("latin-1", "replace")
    text = it.io.input("")
    if text is None:
        return Val(-1, INT)   # EOF: no crash - this is how "while (scanf(...) == 1)" is meant to end
    return Val(c_scanf_into(it, fmt, args[1:], text), INT)


@libc("gets")
def _gets(it, args, line):
    text = it.io.input("")
    if text is None:
        return Val(0, args[0].t)
    it.mem.put(args[0].v, text.encode("latin-1", "replace") + b"\0")
    return args[0]


@libc("puts")
def _puts(it, args, line):
    it.io.write(it.mem.cstr(args[0].v).decode("latin-1", "replace") + "\n")
    return Val(0, INT)


@libc("putchar")
def _putchar(it, args, line):
    it.io.write(chr(int(args[0].v) & 0xFF))
    return args[0]


@libc("getchar")
def _getchar(it, args, line):
    text = it.io.input("")
    if not text:
        return Val(-1, INT)
    it.io.pending = text[1:]
    return Val(ord(text[0]), INT)


@libc("fgets")
def _fgets(it, args, line):
    n = int(args[1].v)
    text = it.io.input("")
    if text is None:
        return Val(0, args[0].t)
    text = text[:max(n - 1, 0)]
    it.mem.put(args[0].v, (text + "\n").encode("latin-1", "replace") + b"\0")
    return args[0]


@libc("fprintf")
def _fprintf(it, args, line):
    s = c_vprintf(it, it.mem.cstr(args[1].v).decode("latin-1", "replace"), args[2:])
    if int(args[0].v) == FILE0 + 1:
        it.io.write(s, True)
    else:
        it.io.write(s)
    return Val(len(s), INT)


@libc("malloc")
def _malloc(it, args, line):
    return Val(it.mem.malloc(int(args[0].v)), ptr(VOID))


@libc("calloc")
def _calloc(it, args, line):
    n, sz = int(args[0].v), int(args[1].v)
    a = it.mem.malloc(n * sz)
    if a:
        it.mem.buf[a:a + n * sz] = b"\0" * (n * sz)
    return Val(a, ptr(VOID))


@libc("realloc")
def _realloc(it, args, line):
    old, size = int(args[0].v), int(args[1].v)
    if old == 0:
        return Val(it.mem.malloc(size), ptr(VOID))
    oldsz = it.mem.block_size(old)
    if oldsz is None:
        raise RunError("realloc() was given a pointer that malloc never returned", "InvalidFree")
    na = it.mem.malloc(size)
    if na:
        it.mem.buf[na:na + min(oldsz, size)] = it.mem.buf[old:old + min(oldsz, size)]
        it.mem.free(old)
    return Val(na, ptr(VOID))


@libc("free")
def _free(it, args, line):
    it.mem.free(int(args[0].v))
    return Val(0, VOID)


@libc("exit", "_Exit")
def _exit(it, args, line):
    raise ExitProgram(int(args[0].v) if args else 0)


@libc("abort")
def _abort(it, args, line):
    raise RunError("abort() was called", "Abort")


@libc("system")
def _system(it, args, line):
    return Val(-1, INT)


@libc("assert", "__cc_assert")
def _assert(it, args, line):
    if not args[0].v:
        msg = it.mem.cstr(args[1].v).decode("latin-1", "replace") if len(args) > 1 and args[1].t.k == "ptr" else ""
        raise RunError("Assertion failed: %s" % msg, "AssertionError",
                       "assert() checks that something must always be true; it was false here.")
    return Val(0, VOID)


@libc("strlen")
def _strlen(it, args, line):
    return Val(len(it.mem.cstr(args[0].v)), ULONG)


@libc("strcpy")
def _strcpy(it, args, line):
    s = it.mem.cstr(args[1].v)
    it.mem.put(args[0].v, s + b"\0")
    return args[0]


@libc("strncpy")
def _strncpy(it, args, line):
    n = int(args[2].v)
    s = it.mem.cstr(args[1].v)[:n]
    it.mem.put(args[0].v, s + b"\0" * (n - len(s)))
    return args[0]


@libc("strcat")
def _strcat(it, args, line):
    a = it.mem.cstr(args[0].v)
    b = it.mem.cstr(args[1].v)
    it.mem.put(args[0].v + len(a), b + b"\0")
    return args[0]


@libc("strncat")
def _strncat(it, args, line):
    n = int(args[2].v)
    a = it.mem.cstr(args[0].v)
    b = it.mem.cstr(args[1].v)[:n]
    it.mem.put(args[0].v + len(a), b + b"\0")
    return args[0]


@libc("strcmp")
def _strcmp(it, args, line):
    a, b = it.mem.cstr(args[0].v), it.mem.cstr(args[1].v)
    return Val(-1 if a < b else (1 if a > b else 0), INT)


@libc("strncmp")
def _strncmp(it, args, line):
    n = int(args[2].v)
    a, b = it.mem.cstr(args[0].v)[:n], it.mem.cstr(args[1].v)[:n]
    return Val(-1 if a < b else (1 if a > b else 0), INT)


@libc("strchr")
def _strchr(it, args, line):
    s = it.mem.cstr(args[0].v)
    c = int(args[1].v) & 0xFF
    i = s.find(bytes([c]))
    return Val((args[0].v + i) if i >= 0 else 0, ptr(CHAR))


@libc("strrchr")
def _strrchr(it, args, line):
    s = it.mem.cstr(args[0].v)
    c = int(args[1].v) & 0xFF
    i = s.rfind(bytes([c]))
    return Val((args[0].v + i) if i >= 0 else 0, ptr(CHAR))


@libc("strstr")
def _strstr(it, args, line):
    s, sub = it.mem.cstr(args[0].v), it.mem.cstr(args[1].v)
    i = s.find(sub)
    return Val((args[0].v + i) if i >= 0 else 0, ptr(CHAR))


@libc("strdup")
def _strdup(it, args, line):
    s = it.mem.cstr(args[0].v) + b"\0"
    a = it.mem.malloc(len(s))
    it.mem.buf[a:a + len(s)] = s
    return Val(a, ptr(CHAR))


@libc("strtok")
def _strtok(it, args, line):
    key = id(it)
    if int(args[0].v) != 0:
        it.strtok_save[key] = it.mem.cstr(args[0].v)
    s = it.strtok_save.get(key, b"")
    seps = set(it.mem.cstr(args[1].v))
    i = 0
    while i < len(s) and s[i] in seps:
        i += 1
    if i >= len(s):
        it.strtok_save[key] = b""
        return Val(0, ptr(CHAR))
    j = i
    while j < len(s) and s[j] not in seps:
        j += 1
    tok = s[i:j]
    it.strtok_save[key] = s[j:]
    b = tok + b"\0"
    a = it.mem.malloc(len(b))
    it.mem.buf[a:a + len(b)] = b
    return Val(a, ptr(CHAR))


@libc("memcpy", "memmove")
def _memcpy(it, args, line):
    n = int(args[2].v)
    it.mem.chk(args[1].v, n); it.mem.chk(args[0].v, n, True)
    it.mem.buf[args[0].v:args[0].v + n] = it.mem.buf[args[1].v:args[1].v + n]
    return args[0]


@libc("memset")
def _memset(it, args, line):
    n = int(args[2].v)
    it.mem.chk(args[0].v, n, True)
    it.mem.buf[args[0].v:args[0].v + n] = bytes([int(args[1].v) & 0xFF]) * n
    return args[0]


@libc("memcmp")
def _memcmp(it, args, line):
    n = int(args[2].v)
    a = bytes(it.mem.buf[args[0].v:args[0].v + n])
    b = bytes(it.mem.buf[args[1].v:args[1].v + n])
    return Val(-1 if a < b else (1 if a > b else 0), INT)


_CTYPE = {
    "isdigit": lambda c: c.isdigit(), "isalpha": lambda c: c.isalpha(), "isalnum": lambda c: c.isalnum(),
    "isspace": lambda c: c in " \t\n\r\v\f", "isupper": lambda c: c.isupper(), "islower": lambda c: c.islower(),
    "ispunct": lambda c: c.isprintable() and not c.isalnum() and c != " ", "isprint": lambda c: c.isprintable(),
    "iscntrl": lambda c: ord(c) < 32 or ord(c) == 127, "isxdigit": lambda c: c in "0123456789abcdefABCDEF",
}
for _n, _f in _CTYPE.items():
    LIBC[_n] = (lambda f: (lambda it, args, line: Val(1 if f(chr(int(args[0].v) & 0xFF)) else 0, INT)))(_f)
LIBC["toupper"] = lambda it, args, line: Val(ord(chr(int(args[0].v) & 0xFF).upper()), INT)
LIBC["tolower"] = lambda it, args, line: Val(ord(chr(int(args[0].v) & 0xFF).lower()), INT)


@libc("atoi")
def _atoi(it, args, line):
    s = it.mem.cstr(args[0].v).decode("latin-1", "replace").strip()
    m = re.match(r"[+-]?\d+", s)
    return Val(wrap(int(m.group(0)), INT) if m else 0, INT)


@libc("atol", "atoll")
def _atol(it, args, line):
    s = it.mem.cstr(args[0].v).decode("latin-1", "replace").strip()
    m = re.match(r"[+-]?\d+", s)
    return Val(int(m.group(0)) if m else 0, LONG)


@libc("atof")
def _atof(it, args, line):
    s = it.mem.cstr(args[0].v).decode("latin-1", "replace").strip()
    m = re.match(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?", s)
    return Val(float(m.group(0)) if m else 0.0, DOUBLE)


@libc("strtol")
def _strtol(it, args, line):
    s = it.mem.cstr(args[0].v).decode("latin-1", "replace").strip()
    base = int(args[2].v) if len(args) > 2 else 10
    m = re.match(r"[+-]?(0[xX][0-9a-fA-F]+|\d+)", s)
    try:
        return Val(int(m.group(0), base if base else 0), LONG)
    except Exception:
        return Val(0, LONG)


@libc("strtod")
def _strtod(it, args, line):
    return _atof(it, args, line)


@libc("rand")
def _rand(it, args, line):
    import random
    return Val(random.randint(0, 2147483647), INT)


@libc("srand")
def _srand(it, args, line):
    import random
    random.seed(int(args[0].v))
    return Val(0, VOID)


@libc("time")
def _time_(it, args, line):
    t = int(_time.time())
    if args and args[0].v:
        it.mem.put(args[0].v, LONG.fmt.pack(t))
    return Val(t, LONG)


@libc("clock")
def _clock(it, args, line):
    return Val(int(_time.process_time() * 1_000_000), LONG)


_MATH1 = {"sqrt": math.sqrt, "fabs": abs, "sin": math.sin, "cos": math.cos, "tan": math.tan, "asin": math.asin,
          "acos": math.acos, "atan": math.atan, "exp": math.exp, "log": math.log, "log10": math.log10,
          "log2": math.log2, "floor": math.floor, "ceil": math.ceil, "round": round, "cbrt": lambda x: math.copysign(abs(x) ** (1 / 3), x),
          "sinh": math.sinh, "cosh": math.cosh, "tanh": math.tanh, "trunc": math.trunc}


def _safe1(f):
    def g(it, args, line):
        try:
            return Val(float(f(float(args[0].v))), DOUBLE)
        except ValueError:
            return Val(math.nan, DOUBLE)
        except OverflowError:
            return Val(math.inf, DOUBLE)
    return g


for _n, _f in _MATH1.items():
    LIBC[_n] = _safe1(_f)


@libc("pow")
def _pow(it, args, line):
    try:
        return Val(float(math.pow(args[0].v, args[1].v)), DOUBLE)
    except ValueError:
        return Val(math.nan, DOUBLE)


@libc("fmod")
def _fmod(it, args, line):
    b = float(args[1].v)
    return Val(math.fmod(float(args[0].v), b) if b else math.nan, DOUBLE)


@libc("atan2")
def _atan2(it, args, line):
    return Val(math.atan2(float(args[0].v), float(args[1].v)), DOUBLE)


@libc("abs")
def _abs(it, args, line):
    return Val(abs(int(args[0].v)), INT)


@libc("labs", "llabs")
def _labs(it, args, line):
    return Val(abs(int(args[0].v)), LONG)


@libc("fmin")
def _fmin(it, args, line):
    return Val(min(float(args[0].v), float(args[1].v)), DOUBLE)


@libc("fmax")
def _fmax(it, args, line):
    return Val(max(float(args[0].v), float(args[1].v)), DOUBLE)


@libc("isnan")
def _isnan(it, args, line):
    return Val(1 if (isinstance(args[0].v, float) and args[0].v != args[0].v) else 0, INT)


@libc("isinf")
def _isinf(it, args, line):
    return Val(1 if args[0].v in (math.inf, -math.inf) else 0, INT)


# very small file-system emulation (student programs almost always just read/write text files)
@libc("fopen")
def _fopen(it, args, line):
    name = it.mem.cstr(args[0].v).decode("latin-1", "replace")
    mode = it.mem.cstr(args[1].v).decode("latin-1", "replace")
    fh = it.io.fopen(name, mode)
    if fh is None:
        return Val(0, ptr(VOID))
    fno = it.next_fileno; it.next_fileno += 8
    it.files[fno] = fh
    return Val(fno, ptr(VOID))


@libc("fclose")
def _fclose(it, args, line):
    it.files.pop(int(args[0].v), None)
    return Val(0, INT)


@libc("fwrite")
def _fwrite(it, args, line):
    n = int(args[1].v) * int(args[2].v)
    data = bytes(it.mem.buf[args[0].v:args[0].v + n])
    fh = it.files.get(int(args[3].v))
    if fh is not None:
        fh.write(data.decode("latin-1", "replace"))
    return Val(int(args[2].v), ULONG)


@libc("fread")
def _fread(it, args, line):
    fh = it.files.get(int(args[3].v))
    if fh is None:
        return Val(0, ULONG)
    n = int(args[1].v) * int(args[2].v)
    data = fh.read(n).encode("latin-1", "replace")
    it.mem.put(args[0].v, data)
    return Val(len(data) // max(int(args[1].v), 1), ULONG)


@libc("fputs")
def _fputs(it, args, line):
    s = it.mem.cstr(args[0].v).decode("latin-1", "replace")
    if int(args[1].v) == FILE0 + 1:
        it.io.write(s, True)
    else:
        fh = it.files.get(int(args[1].v))
        if fh is not None:
            fh.write(s)
    return Val(0, INT)


@libc("feof")
def _feof(it, args, line):
    fh = it.files.get(int(args[0].v))
    return Val(1 if (fh is not None and fh.eof()) else 0, INT)
import re as _re


def _line_from_pycparser_error(msg):
    m = _re.match(r"[^:]*:(\d+):(\d+):\s*(.*)$", msg)
    if m:
        return int(m.group(1)), int(m.group(2)), m.group(3)
    m = _re.match(r"[^:]*:(\d+):\s*(.*)$", msg)
    if m:
        return int(m.group(1)), 1, m.group(2)
    return None, None, msg


_KEYWORDS_C = set("auto break case char const continue default do double else enum extern float for goto if int long "
                   "register return short signed sizeof static struct switch typedef union unsigned void volatile while "
                   "_Bool inline restrict".split())


def _syntax_hint(msg, text):
    low = msg.lower()
    if "before:" in low and low.strip().endswith("before: }"):
        return "A ';' is probably missing before this '}', or one bracket was opened one too many times."
    if "before: {" in low:
        return "Check the line above: a ')' or ';' may be missing before this '{'."
    if "before: ;" in low:
        return "There is an extra ';', or something is missing just before it on this line."
    if "no file" in low or "syntax error" in low and "before:" in low:
        return "Python could not understand this line. Check ';', '{ }', '( )' and spelling of keywords."
    return "Check ';' at the end of the statement, and that every '{ ( \"' has its match."


def build_diagnose(code, header_read=None):
    """returns a list of {line,col,msg,hint} without running the program (best-effort: stops at the first real error)."""
    try:
        text, _ = preprocess(code, header_read)
    except CompileError as e:
        return [{"line": e.line, "col": e.col or 1, "end_col": (e.col or 1) + 1, "msg": e.msg, "type": e.kind, "hint": e.why or ""}]
    try:
        c_parser.CParser().parse(text, "main.c")
        return []
    except Exception as e:
        ln, col, msg = _line_from_pycparser_error(str(e))
        lines = code.split("\n")
        bad = lines[ln - 1] if ln and 0 < ln <= len(lines) else ""
        return [{"line": ln or 1, "col": col or 1, "end_col": (col or 1) + 1, "msg": msg, "type": "SyntaxError",
                 "hint": _syntax_hint(msg, bad), "text": bad}]


class IOBridge(object):
    """talks to the page the same way the Python runner does (see py-worker.js)."""
    def __init__(self, emit, ainput, files):
        self._emit, self._ainput, self._vfs = emit, ainput, files
        self.pending = ""

    def write(self, s, err=False):
        self._emit(s, err)

    def input(self, prompt):
        if self.pending:
            s, self.pending = self.pending, ""
            return s
        return self._ainput(prompt)

    def fopen(self, name, mode):
        return VFile(self._vfs, name, mode)


class VFile(object):
    def __init__(self, vfs, name, mode):
        self.vfs, self.name = vfs, name
        self._eof = False
        if "r" in mode:
            if name not in vfs:
                raise RunError("fopen() could not find the file '%s'" % name, "FileNotFoundError")
            self.pos = 0
        else:
            if "a" not in mode or name not in vfs:
                vfs[name] = ""
            self.pos = len(vfs.get(name, ""))

    def read(self, n):
        data = self.vfs.get(self.name, "")
        chunk = data[self.pos:self.pos + n]
        self.pos += len(chunk)
        if not chunk:
            self._eof = True
        return chunk

    def write(self, s):
        self.vfs[self.name] = self.vfs.get(self.name, "")[:self.pos] + s
        self.pos += len(s)

    def eof(self):
        return self._eof


def run_c(code, emit, ainput, files, header_read=None, time_budget=10.0):
    """emit(text, is_err) ; ainput(prompt)->str|None ; files: dict used as a tiny virtual filesystem.
    Returns 0 on success, or a positive 1-based line number of the failure (consistent with the Python runner)."""
    import time as _t
    try:
        text, included = preprocess(PRELUDE + "\n" + code, header_read)
        text = text[text.index("\n") + 1:]  # drop the prelude's own (single) line so numbering matches the user's code... (prelude has no newline issues: it's one line)
    except CompileError as e:
        emit("%s: %s\n" % (e.kind, e.msg), True)
        return e.line or 1
    try:
        ast = c_parser.CParser().parse(text, "main.c")
    except Exception as e:
        ln, col, msg = _line_from_pycparser_error(str(e))
        emit("SyntaxError: %s (line %s)\n" % (msg, ln or "?"), True)
        return ln or 1

    it = Interp(IOBridge(emit, ainput, files))
    it.push_scope()  # a dummy frame so declare_local-free globals still have `scopes` well-formed; globals use .globals directly
    it.scopes.pop()
    deferred_init = []
    try:
        for ext in ast.ext:
            if isinstance(ext, c_ast.Decl):
                if isinstance(ext.type, (c_ast.Struct, c_ast.Union)) and ext.name is None:
                    it.env.struct_type(ext.type, line_of(ext), True); continue
                if isinstance(ext.type, c_ast.Enum) and ext.name is None:
                    et = it.env.enum_type(ext.type, line_of(ext))
                    if ext.type.values is not None:   # "enum Color { RED, GREEN, ... };" defines these names everywhere
                        for name, value in et.fields.items():
                            it.globals[name] = value
                    continue
                ty = it.env.resolve_decl_type(ext.type, line_of(ext))
                if "typedef" in (ext.storage or []):
                    if getattr(ty, "_dimnode", None) is not None:
                        ty = arr(ty.to, it.env.const_int(ty._dimnode))
                    it.env.typedefs[ext.name] = ty
                    continue
                if ty.k == "func":
                    it.funcs.setdefault(ext.name, Func(ext.name, ty, ext, False))
                    continue
                if getattr(ty, "_dimnode", None) is not None:
                    ty = arr(ty.to, it.env.const_int(ty._dimnode))
                if ty.k == "arr" and ty.n is None and ext.init is not None:
                    ty = arr(ty.to, it._init_array_len(ext.init))
                a = it.mem.static(max(ty.size, 1), ty.align)
                it.mem.buf[a:a + ty.size] = b"\0" * ty.size
                it.globals[ext.name] = LVal(a, ty)
                if ext.init is not None:
                    deferred_init.append((ext.name, ext.init))
            elif isinstance(ext, c_ast.FuncDef):
                ty = it.env.resolve_decl_type(ext.decl.type, line_of(ext))
                it.funcs[ext.decl.name] = Func(ext.decl.name, ty, ext, True)
            elif isinstance(ext, c_ast.Typedef):
                ty = it.env.resolve_decl_type(ext.type, line_of(ext))
                it.env.typedefs[ext.name] = ty
        for name, init in deferred_init:
            it.init_lvalue(it.globals[name], init)
        if "main" not in it.funcs or not it.funcs["main"].is_def:
            emit("Linker error: 'main' function is not defined\n", True)
            return 1
        start = _t.time()
        _old_step = it.step
        def step_with_budget():
            _old_step()
            if _t.time() - start > time_budget:
                raise RunError("The program did not finish in time (an infinite loop?)", "Timeout",
                               "Check that every loop's condition eventually becomes false.")
        it.step = step_with_budget
        try:
            ret = it.call_user(it.funcs["main"], [], 0)
            code_ = int(ret.v) if ret.t.k != "void" else 0
        except ReturnSig as r:
            code_ = int(r.v.v)
        return 0
    except ExitProgram:
        return 0
    except RunError as e:
        emit("\n%s: %s (near line %d)\n" % (e.kind, e.msg, it.cur_line), True)
        if e.why:
            emit("Hint: %s\n" % e.why, True)
        return it.cur_line or 1
    except CompileError as e:
        emit("%s: %s\n" % (e.kind, e.msg), True)
        return e.line or 1
    except RecursionError:
        emit("\nStackOverflow: too much recursion (Python's own recursion limit was hit)\n", True)
        return it.cur_line or 1
