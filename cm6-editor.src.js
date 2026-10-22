/* cm6-editor.src.js — bundled into libs/cm6.js by the workflow (esbuild).
   CodeMirror 6 handles Android keyboards (backspace, selection handles) properly. This file makes it look like the
   CodeMirror 5 object the rest of the app already uses, so index.html does not change.
   If anything fails, the classic CodeMirror 5 editor is used instead. */
import { EditorState, Compartment, StateEffect, StateField, Prec, Transaction, Annotation, RangeSetBuilder } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, Decoration, ViewPlugin, MatchDecorator } from "@codemirror/view";
import { history, historyKeymap, defaultKeymap, indentMore, indentLess, undo, redo, selectAll,
         cursorCharLeft, cursorCharRight, deleteCharBackward, toggleComment } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { indentUnit, bracketMatching, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";

/* ---- colours: Darcula-like ---- */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.null, t.bool, t.atom], color: "#cc7832" },
  { tag: t.self, color: "#94558d" },
  { tag: [t.string, t.special(t.string)], color: "#6a8759" },
  { tag: t.number, color: "#6897bb" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#808080" },
  { tag: [t.function(t.definition(t.variableName)), t.definition(t.className)], color: "#ffc66d" },
  { tag: t.meta, color: "#bbb529" }
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "#a9b7c6", backgroundColor: "#2b2b2b" },
  ".cm-scroller": { overflow: "auto", fontFamily: "'JetBrains Mono','Roboto Mono','Droid Sans Mono',monospace", lineHeight: "1.45" },
  ".cm-content": { caretColor: "#bbbbbb" },
  ".cm-cursor": { borderLeftColor: "#bbbbbb", borderLeftWidth: "2px" },
  ".cm-gutters": { backgroundColor: "#2b2b2b", color: "#606366", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 8px", minWidth: "24px" },
  ".cm-activeLine": { backgroundColor: "#323232" },
  ".cm-activeLineGutter": { backgroundColor: "#323232", color: "#a4a3a3" },
  "& ::selection": { backgroundColor: "#2f5ea8" },
  ".cm-matchingBracket": { backgroundColor: "#3b514d", outline: "1px solid #5a7a75" },
  ".cm-bi": { color: "#cc7832" },
  ".cm-ig": { backgroundImage: "repeating-linear-gradient(to right,#4a4a4a 0,#4a4a4a 1px,transparent 1px,transparent 4ch)", backgroundRepeat: "no-repeat", backgroundOrigin: "content-box" },
  ".cm-panels": { backgroundColor: "#1b1d22", color: "#ddd" },
  ".cm-panel input, .cm-panel button": { fontSize: "13px" }
}, { dark: true });

/* ---- built-in names (print, range, ...) in orange, like the reference app ---- */
const builtinDeco = new MatchDecorator({
  regexp: /\b(print|range|len|int|float|str|input|list|dict|set|tuple|bool|abs|sum|min|max|sorted|enumerate|zip|map|filter|open|type|isinstance|round|reversed|any|all|chr|ord|pow|divmod|super)(?=\()/g,
  decoration: Decoration.mark({ class: "cm-bi" })
});
const builtinPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.d = builtinDeco.createDeco(view); }
  update(u) { this.d = builtinDeco.updateDeco(u, this.d); }
}, { decorations: (v) => v.d });

/* ---- thin vertical indent guides ---- */
function guides(view) {
  const b = new RangeSetBuilder();
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos);
      const m = /^ +/.exec(line.text);
      if (m && m[0].length >= 4 && line.from > last) {
        b.add(line.from, line.from, Decoration.line({ attributes: { class: "cm-ig", style: "background-size:" + (Math.floor(m[0].length / 4) * 4) + "ch 100%" } }));
        last = line.from;
      }
      pos = line.to + 1;
    }
  }
  return b.finish();
}
const guidePlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.d = guides(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.d = guides(u.view); }
}, { decorations: (v) => v.d });

/* ---- line classes (used to paint the line with an error red) ---- */
const setLineCls = StateEffect.define();
const lineClsField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setLineCls)) continue;
      const items = e.value
        .filter((x) => x.line + 1 >= 1 && x.line + 1 <= tr.state.doc.lines)
        .map((x) => Decoration.line({ class: x.cls }).range(tr.state.doc.line(x.line + 1).from));
      deco = Decoration.set(items, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f)
});

const programmatic = Annotation.define();
const KEYMAP_NAMES = { Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" };

function convKey(k) { // "Ctrl-D" -> "Ctrl-d", "Alt-Up" -> "Alt-ArrowUp"
  const parts = k.split("-");
  let last = parts.pop();
  last = KEYMAP_NAMES[last] || (last.length === 1 ? last.toLowerCase() : last);
  return parts.concat(last).join("-");
}

function create(ta, opts) {
  const host = document.createElement("div");
  host.className = "CodeMirror cm-s-dracula"; // the app styles / queries this class
  ta.style.display = "none";
  ta.parentNode.insertBefore(host, ta.nextSibling);
  try {
    const handlers = { change: [], changes: [], cursorActivity: [] };
    const wrapComp = new Compartment();
    let lineClasses = [];
    let cm = null;

    const extra = Object.keys(opts.extraKeys || {}).map((k) => ({
      key: convKey(k), preventDefault: true, run: () => { opts.extraKeys[k](cm); return true; }
    }));

    const fire = (list, arg) => { // deferred: handlers may call view.dispatch, not allowed inside an update
      Promise.resolve().then(() => list.forEach((f) => { try { f(cm, arg); } catch (e) { console.error(e); } }));
    };

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: ta.value,
        extensions: [
          lineNumbers(), history(), indentUnit.of("    "), EditorState.tabSize.of(4), python(),
          syntaxHighlighting(highlight), bracketMatching(), closeBrackets(),
          highlightActiveLine(), highlightActiveLineGutter(), search({ top: true }),
          lineClsField, builtinPlugin, guidePlugin, theme,
          wrapComp.of(opts.lineWrapping ? EditorView.lineWrapping : []),
          EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off", autocomplete: "off" }),
          Prec.highest(keymap.of(extra)),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.updateListener.of((u) => {
            const prog = u.transactions.some((tr) => tr.annotation(programmatic));
            if (u.docChanged && !prog) {
              const ch = [{ origin: "input" }];
              fire(handlers.change, ch[0]); fire(handlers.changes, ch);
            }
            if (u.selectionSet || u.docChanged) fire(handlers.cursorActivity);
          })
        ]
      })
    });

    const doc = () => view.state.doc;
    const toOff = (p) => {
      const l = doc().line(Math.min(Math.max(p.line + 1, 1), doc().lines));
      return l.from + Math.min(Math.max(p.ch, 0), l.length);
    };
    const toPos = (off) => { const l = doc().lineAt(off); return { line: l.number - 1, ch: off - l.from }; };
    const setLines = () => view.dispatch({ effects: setLineCls.of(lineClasses) });
    const commands = {
      find: openSearchPanel, replace: openSearchPanel, undo: undo, redo: redo, selectAll: selectAll,
      goCharLeft: cursorCharLeft, goCharRight: cursorCharRight, delCharBefore: deleteCharBackward
    };

    cm = {
      __cm6: true,
      view: view,
      getValue: () => doc().toString(),
      setValue(v) {
        view.dispatch({
          changes: { from: 0, to: doc().length, insert: v }, selection: { anchor: 0 },
          annotations: [programmatic.of(true), Transaction.addToHistory.of(false)], scrollIntoView: true
        });
      },
      getSelection() { const r = view.state.selection.main; return view.state.sliceDoc(r.from, r.to); },
      somethingSelected: () => view.state.selection.ranges.some((r) => !r.empty),
      replaceSelection(text) {
        view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input" });
      },
      getCursor(which) {
        const r = view.state.selection.main;
        return toPos(which === "from" ? r.from : which === "to" ? r.to : r.head);
      },
      setCursor(a, b) {
        const p = typeof a === "number" ? { line: a, ch: b || 0 } : a;
        view.dispatch({ selection: { anchor: toOff(p) }, scrollIntoView: true });
      },
      getLine(n) { return n >= 0 && n < doc().lines ? doc().line(n + 1).text : undefined; },
      lineCount: () => doc().lines,
      replaceRange(text, from, to) {
        view.dispatch({ changes: { from: toOff(from), to: toOff(to || from), insert: text } });
      },
      listSelections: () => view.state.selection.ranges.map((r) => ({ anchor: toPos(r.anchor), head: toPos(r.head) })),
      operation: (fn) => fn(),
      scrollIntoView(p) {
        const off = p && p.line !== undefined ? toOff(p) : view.state.selection.main.head;
        view.dispatch({ effects: EditorView.scrollIntoView(off, { y: "center" }) });
      },
      focus: () => view.focus(),
      hasFocus: () => view.hasFocus,
      refresh: () => view.requestMeasure(),
      on(ev, fn) { if (handlers[ev]) handlers[ev].push(fn); }, // "inputRead" is not needed: brackets close natively
      setOption(k, v) {
        if (k === "lineWrapping") view.dispatch({ effects: wrapComp.reconfigure(v ? EditorView.lineWrapping : []) });
      },
      getOption: (k) => (k === "tabSize" ? 4 : undefined),
      addKeyMap(map) {
        const arr = Object.keys(map).map((k) => ({ key: convKey(k), preventDefault: true, run: () => { map[k](cm); return true; } }));
        view.dispatch({ effects: StateEffect.appendConfig.of(Prec.highest(keymap.of(arr))) });
      },
      indentSelection(dir) { return dir === "add" ? indentMore(view) : indentLess(view); },
      toggleComment() { return toggleComment(view); },
      execCommand(name) { return commands[name] ? commands[name](view) : false; },
      addLineClass(line, where, cls) { lineClasses = lineClasses.concat([{ line: line, cls: cls }]); setLines(); },
      removeLineClass(line, where, cls) { lineClasses = lineClasses.filter((x) => !(x.line === line && x.cls === cls)); setLines(); }
    };
    return cm;
  } catch (err) {
    host.remove();
    throw err;
  }
}

/* ---- install: replace CodeMirror.fromTextArea, keep the classic one as a fallback ---- */
const CM = (window.CodeMirror = window.CodeMirror || {});
const classic = CM.fromTextArea;
CM.fromTextArea = function (ta, opts) {
  let pref = null;
  try { pref = localStorage.getItem("py_acad_engine"); } catch (e) {}
  if (pref === "cm5" && classic) return classic.apply(this, arguments);
  try {
    return create(ta, opts || {});
  } catch (err) {
    console.error("New editor failed, using the classic editor:", err);
    if (classic) { ta.style.display = ""; return classic.apply(this, arguments); }
    throw err;
  }
};
