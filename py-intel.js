/* py-intel.js — offline Python knowledge used by the editor for suggestions and parameter hints.
   Pure functions on plain text, so they work without internet and can be tested without a browser. */

// "name(params);name2;..." -> { name: "(params)", name2: "" }   ("" = constant / no call)
const parse = (s) => {
  const o = {};
  s.split(";").forEach((x) => {
    x = x.trim();
    if (!x) return;
    const i = x.indexOf("(");
    if (i < 0) o[x] = ""; else o[x.slice(0, i)] = x.slice(i);
  });
  return o;
};

export const KEYWORDS = ("False None True and as assert async await break class continue def del elif else except " +
  "finally for from global if import in is lambda nonlocal not or pass raise return try while with yield").split(" ");

export const BUILTINS = parse(
  "print(*values, sep=' ', end='\\n');input(prompt='');len(obj);range(start, stop, step);int(x=0, base=10);float(x=0.0);" +
  "str(obj='');list(iterable=());dict(**kwargs);set(iterable=());tuple(iterable=());bool(x=False);abs(x);" +
  "sum(iterable, start=0);min(a, b, key=None);max(a, b, key=None);sorted(iterable, key=None, reverse=False);" +
  "enumerate(iterable, start=0);zip(*iterables);map(function, iterable);filter(function, iterable);" +
  "open(file, mode='r');type(obj);isinstance(obj, classinfo);round(number, ndigits=None);reversed(seq);any(iterable);" +
  "all(iterable);chr(i);ord(c);pow(base, exp);divmod(a, b);help(obj);id(obj);hex(x);bin(x);oct(x);callable(obj);" +
  "dir(obj);repr(obj);format(value, spec);super();hasattr(obj, name);getattr(obj, name, default);setattr(obj, name, value)");

const TURTLE_ALL =
  "forward(distance);backward(distance);left(angle);right(angle);goto(x, y);penup();pendown();pensize(width);" +
  "pencolor(color);fillcolor(color);color(pencolor, fillcolor);begin_fill();end_fill();circle(radius, extent=None);" +
  "dot(size=None, color=None);write(arg, move=False, align='left', font=('Arial', 8, 'normal'));speed(speed=None);" +
  "hideturtle();showturtle();setheading(angle);home();clear();reset();xcor();ycor();heading();pos();setx(x);sety(y);" +
  "distance(x, y);towards(x, y);isdown();stamp()";
const SCREEN_ALL =
  "bgcolor(color);title(text);setup(width, height);tracer(n);update();colormode(mode);exitonclick();mainloop();" +
  "done();listen();onkey(fun, key);ontimer(fun, t);bye()";

export const MODULES = {
  math: parse("sqrt(x);pow(x, y);sin(x);cos(x);tan(x);asin(x);acos(x);atan(x);atan2(y, x);radians(x);degrees(x);floor(x);" +
    "ceil(x);fabs(x);factorial(n);gcd(a, b);hypot(x, y);log(x, base);log10(x);log2(x);exp(x);isqrt(n);pi;e;tau;inf"),
  random: parse("randint(a, b);random();choice(seq);choices(seq, k);shuffle(x);seed(a);uniform(a, b);" +
    "randrange(start, stop, step);sample(population, k)"),
  time: parse("time();sleep(seconds);perf_counter();strftime(format);localtime();ctime()"),
  datetime: parse("datetime;date;time;timedelta"),
  json: parse("loads(s);dumps(obj, indent=None);load(fp);dump(obj, fp)"),
  os: parse("listdir(path='.');getcwd();path;remove(path);mkdir(path);rename(src, dst)"),
  sys: parse("argv;exit(code=0);version;platform;path;modules"),
  re: parse("match(pattern, string);search(pattern, string);findall(pattern, string);sub(pattern, repl, string);" +
    "split(pattern, string);compile(pattern);fullmatch(pattern, string)"),
  collections: parse("Counter(iterable);defaultdict(default_factory);deque(iterable, maxlen);OrderedDict();namedtuple(typename, field_names)"),
  itertools: parse("product(*iterables, repeat=1);permutations(iterable, r);combinations(iterable, r);count(start=0, step=1);" +
    "cycle(iterable);chain(*iterables);accumulate(iterable);groupby(iterable, key=None)"),
  string: parse("ascii_letters;ascii_lowercase;ascii_uppercase;digits;punctuation;whitespace"),
  statistics: parse("mean(data);median(data);mode(data);stdev(data);variance(data)"),
  colorsys: parse("hsv_to_rgb(h, s, v);rgb_to_hsv(r, g, b);hls_to_rgb(h, l, s);rgb_to_hls(r, g, b)"),
  turtle: parse("Turtle();Screen();" + TURTLE_ALL + ";" + SCREEN_ALL),
  functools: parse("reduce(function, iterable);partial(func, *args);lru_cache(maxsize=128)"),
  copy: parse("copy(x);deepcopy(x)"),
  heapq: parse("heappush(heap, item);heappop(heap);heapify(x);nlargest(n, iterable);nsmallest(n, iterable)"),
  bisect: parse("bisect_left(a, x);bisect_right(a, x);insort(a, x)"),
  csv: parse("reader(csvfile);writer(csvfile);DictReader(f);DictWriter(f, fieldnames)"),
  textwrap: parse("wrap(text, width=70);fill(text, width=70);dedent(text)"),
  decimal: parse("Decimal(value);getcontext()"),
  fractions: parse("Fraction(numerator, denominator)"),
  io: parse("StringIO(initial_value='');BytesIO()"),
  typing: parse("List;Dict;Set;Tuple;Optional;Union;Any;Callable"),
  dataclasses: parse("dataclass;field(default=None)"),
  enum: parse("Enum;IntEnum;auto()"),
  operator: parse("add(a, b);mul(a, b);itemgetter(item)"),
  traceback: parse("print_exc();format_exc()"),
  pprint: parse("pprint(object)"),
  abc: parse("ABC;abstractmethod")
};

const STR = parse("upper();lower();strip();lstrip();rstrip();split(sep=None);join(iterable);replace(old, new);find(sub);" +
  "startswith(prefix);endswith(suffix);format(*args);capitalize();title();isdigit();isalpha();count(sub);index(sub);" +
  "center(width);zfill(width);splitlines()");
const LIST = parse("append(x);extend(iterable);insert(i, x);remove(x);pop(i=-1);sort(key=None, reverse=False);reverse();" +
  "index(x);count(x);copy();clear()");
const DICT = parse("keys();values();items();get(key, default=None);pop(key);update(other);setdefault(key, default=None);clear();copy()");
const TURT = parse(TURTLE_ALL);
const SCREEN = parse(SCREEN_ALL);

const NAME = /^[A-Za-z_]\w*$/;

/** import x / import x as y  ->  { y: "x" } */
export function aliasMap(text) {
  const m = {};
  const re = /^[ \t]*import[ \t]+(.+)$/gm;
  let r;
  while ((r = re.exec(text))) {
    r[1].split(",").forEach((p) => {
      const [mod, al] = p.trim().split(/\s+as\s+/);
      if (mod) m[(al || mod).trim().split(".")[0]] = mod.trim();
    });
  }
  return m;
}

/** from x import a, b as c  ->  { a: "x", c: "x" } */
export function fromImports(text) {
  const m = {};
  const re = /^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+(.+)$/gm;
  let r;
  while ((r = re.exec(text))) {
    r[2].replace(/[()]/g, "").split(",").forEach((p) => {
      const [n, al] = p.trim().split(/\s+as\s+/);
      if (n && n !== "*") m[(al || n).trim()] = { mod: r[1], name: n.trim() };
    });
  }
  return m;
}

/** functions and classes defined in the file, with their parameters */
export function docSymbols(text) {
  const out = [];
  let r;
  const fre = /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(([^)]*)\)/gm;
  while ((r = fre.exec(text))) out.push({ name: r[1], sig: "(" + r[2].replace(/\s+/g, " ").trim() + ")", cls: false });
  const cre = /^[ \t]*class[ \t]+([A-Za-z_]\w*)/gm;
  while ((r = cre.exec(text))) {
    const init = new RegExp("class[ \\t]+" + r[1] + "\\b[\\s\\S]*?def[ \\t]+__init__[ \\t]*\\(([^)]*)\\)").exec(text);
    const params = init ? init[1].split(",").map((s) => s.trim()).filter((s) => s && s !== "self").join(", ") : "";
    out.push({ name: r[1], sig: "(" + params + ")", cls: true });
  }
  return out;
}

/** what methods / members does `name.` offer?  (a module, or a variable whose kind we can see in the file) */
export function membersTable(text, name) {
  if (!NAME.test(name)) return null;
  const al = aliasMap(text);
  if (al[name] && MODULES[al[name]]) return MODULES[al[name]];
  if (MODULES[name]) return MODULES[name];
  const re = new RegExp("(?:^|\\n)[ \\t]*" + name + "[ \\t]*=[ \\t]*(.{0,30})", "g");
  let last = null, r;
  while ((r = re.exec(text))) last = r[1];
  if (last === null) return null;
  if (/^(?:turtle\.)?(?:Turtle|Pen|RawTurtle)\s*\(/.test(last)) return TURT;
  if (/^(?:turtle\.)?Screen\s*\(/.test(last)) return SCREEN;
  if (/^(?:[rbfuRBFU]{0,2}["']|input\s*\(|str\s*\()/.test(last)) return STR;
  if (/^(?:\[|list\s*\()/.test(last)) return LIST;
  if (/^(?:\{|dict\s*\()/.test(last)) return DICT;
  return null;
}

/** the call the cursor is inside:  math.pow(2, |  ->  { name: "math.pow", arg: 1 } */
export function findCall(text, pos) {
  let depth = 0, commas = 0;
  for (let i = pos - 1; i >= Math.max(0, pos - 600); i--) {
    const c = text[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth > 0) { depth--; continue; }
      if (c !== "(") return null;
      const before = text.slice(Math.max(0, i - 80), i);
      const m = /([A-Za-z_][\w.]*)\s*$/.exec(before);
      if (!m || KEYWORDS.includes(m[1])) return null;
      if (/\b(?:def|class)\s+\w*$/.test(before)) return null;
      return { name: m[1], open: i, arg: commas };
    } else if (c === "," && depth === 0) commas++;
  }
  return null;
}

/** "(a, b=2)" for a function name (builtin, module function, function of this file, method of a known kind) */
export function lookupSig(text, name) {
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const tab = membersTable(text, name.slice(0, dot));
    const s = tab ? tab[name.slice(dot + 1)] : undefined;
    return s ? s : null;
  }
  const mine = docSymbols(text).filter((d) => d.name === name).pop();
  if (mine) return mine.sig;
  if (BUILTINS[name]) return BUILTINS[name];
  const fi = fromImports(text)[name];
  if (fi && MODULES[fi.mod] && MODULES[fi.mod][fi.name]) return MODULES[fi.mod][fi.name];
  return null;
}

/** "(a, b=2)" -> ["a", "b=2"] */
export function parseParams(sig) {
  const inner = sig.replace(/^\(/, "").replace(/\)[^)]*$/, "");
  const out = []; let depth = 0, cur = "";
  for (const ch of inner) {
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
