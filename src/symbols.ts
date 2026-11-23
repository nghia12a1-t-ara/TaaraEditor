// Lightweight symbol extraction (no ctags / language server needed). Powers the
// Function List, breadcrumb, "Go to Symbol" and Ctrl+Click go-to-definition.
// Heuristic by design: fast and good enough for C/C++ firmware code.

export type SymbolKind = "function" | "method" | "class" | "struct" | "enum" | "union" | "typedef" | "macro" | "namespace" | "label" | "trait" | "module";

export interface Sym {
  name: string;
  kind: SymbolKind;
  /** 1-based line/column of the name. */
  line: number;
  column: number;
  /** 1-based last line of the body, when known. */
  endLine?: number;
}

export function extractSymbols(text: string, languageId: string): Sym[] {
  const id = languageId.toLowerCase();
  if (["c", "cpp", "objective-c", "cuda-cpp", "arduino"].includes(id)) return extractC(text);
  if (id === "python") return extractPython(text);
  if (id === "rust") return extractRust(text);
  if (["javascript", "typescript", "javascriptreact", "typescriptreact"].includes(id)) return extractJs(text);
  if (id.includes("asm") || id.includes("assembly") || id === "arm" || id === "mips") return extractAsm(text);
  return [];
}

/** Map a string offset to 1-based line/column. */
function positioner(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
  };
}

// ------------------------------------------------------------------ C / C++

/** Blank out comments, string/char literals and preprocessor lines, keeping offsets. */
function stripC(text: string): { code: string; macros: { name: string; offset: number }[] } {
  const out = text.split("");
  const macros: { name: string; offset: number }[] = [];
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const n = text.length;
  let i = 0;
  let lineStart = true;
  while (i < n) {
    const c = text[i];
    if (c === "\n") {
      lineStart = true;
      i++;
      continue;
    }
    if (lineStart && c === "#") {
      // Preprocessor directive (with \ continuations).
      let j = i;
      while (j < n && !(text[j] === "\n" && text[j - 1] !== "\\")) j++;
      const m = /^#\s*define\s+([A-Za-z_]\w*)\(/.exec(text.slice(i, Math.min(j, i + 200)));
      if (m) macros.push({ name: m[1], offset: i + m[0].length - 1 - m[1].length });
      blank(i, j);
      i = j;
      continue;
    }
    if (c !== " " && c !== "\t" && c !== "\r") lineStart = false;
    if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && text[i + 1] === "*") {
      let j = text.indexOf("*/", i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(j, n));
      i = j + 1;
    } else {
      i++;
    }
  }
  return { code: out.join(""), macros };
}

const C_NOT_FUNCTIONS = new Set(["if", "for", "while", "switch", "catch", "return", "sizeof", "defined", "alignas", "decltype", "__attribute__", "__declspec", "do", "else"]);

/** Given the text before a `{`, return the function name if it is a definition. */
function functionHead(head: string): { name: string; index: number } | null {
  let h = head.replace(/\s+$/, "");
  // Trailing qualifiers / trailing return type.
  h = h.replace(/(\s*(const|noexcept|override|final|volatile|mutable)\b)*$/, "").replace(/\s*->\s*[\w:<>,*&\s]+$/, "");
  // C++ constructor initializer list: "Foo::Foo(int a) : m(a), n(b)".
  const init = /\)\s*:(?!:)/.exec(h);
  if (init) h = h.slice(0, init.index + 1);
  if (!h.endsWith(")")) return null;
  let depth = 0;
  let k = h.length - 1;
  for (; k >= 0; k--) {
    if (h[k] === ")") depth++;
    else if (h[k] === "(" && --depth === 0) break;
  }
  if (k <= 0) return null;
  const before = h.slice(0, k);
  const m = /(~?[A-Za-z_]\w*(?:\s*::\s*~?[A-Za-z_]\w*)*|operator\s*\S+)\s*$/.exec(before);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, "");
  const last = name.split("::").pop()!;
  if (C_NOT_FUNCTIONS.has(last)) return null;
  // Reject things like "x = foo(1)" or "return foo(x)" at file scope.
  const prefix = before.slice(0, m.index);
  if (/[=,(]\s*$/.test(prefix) || /\breturn\s*$/.test(prefix)) return null;
  return { name, index: m.index + m[0].indexOf(m[1]) };
}

function extractC(text: string): Sym[] {
  const { code, macros } = stripC(text);
  const pos = positioner(text);
  const syms: Sym[] = macros.map((m) => ({ name: m.name, kind: "macro" as SymbolKind, ...pos(m.offset) }));
  type Block = { kind: "func" | "type" | "typedef" | "other"; sym?: Sym };
  const stack: Block[] = [];
  let stmtStart = 0;

  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === ";") {
      stmtStart = i + 1;
    } else if (c === "{") {
      const inFunc = stack.some((b) => b.kind === "func");
      const head = code.slice(stmtStart, i);
      let block: Block = { kind: "other" };
      if (!inFunc) {
        const type = /\b(typedef\s+)?(struct|class|union|enum|namespace)(?:\s+class)?\s*(?:__attribute__\s*\(\([^)]*\)\)\s*)?([A-Za-z_]\w*)?\s*(?::[^{;]*)?$/.exec(head);
        if (type) {
          const kind = (type[2] === "class" ? "class" : type[2]) as SymbolKind;
          if (type[3]) {
            const sym: Sym = { name: type[3], kind, ...pos(stmtStart + type.index + type[0].lastIndexOf(type[3])) };
            syms.push(sym);
            block = { kind: "type", sym };
          } else {
            block = { kind: type[1] ? "typedef" : "type" };
          }
          if (kind === "namespace") block.kind = "other";
        } else {
          const fn = functionHead(head);
          if (fn) {
            const sym: Sym = { name: fn.name, kind: fn.name.includes("::") || stack.some((b) => b.kind === "type") ? "method" : "function", ...pos(stmtStart + fn.index) };
            syms.push(sym);
            block = { kind: "func", sym };
          }
        }
      }
      stack.push(block);
      stmtStart = i + 1;
    } else if (c === "}") {
      const block = stack.pop();
      if (block?.sym) block.sym.endLine = pos(i).line;
      if (block?.kind === "typedef") {
        // typedef struct { ... } Name_t;
        const m = /^\s*([A-Za-z_]\w*)/.exec(code.slice(i + 1, i + 200));
        if (m) syms.push({ name: m[1], kind: "typedef", ...pos(i + 1 + m[0].length - m[1].length) });
      }
      stmtStart = i + 1;
    }
  }
  return syms.sort((a, b) => a.line - b.line || a.column - b.column);
}

// ------------------------------------------------------------------ others

function byRegex(text: string, re: RegExp, make: (m: RegExpExecArray) => { name: string; kind: SymbolKind; nameOffset: number } | null): Sym[] {
  const pos = positioner(text);
  const syms: Sym[] = [];
  for (const m of text.matchAll(re)) {
    const r = make(m as RegExpExecArray);
    if (r) syms.push({ name: r.name, kind: r.kind, ...pos(m.index! + r.nameOffset) });
  }
  return syms;
}

function extractPython(text: string): Sym[] {
  return byRegex(text, /^([ \t]*)(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_]\w*)/gm, (m) => ({
    name: m[3],
    kind: m[2] === "class" ? "class" : m[1].length ? "method" : "function",
    nameOffset: m[0].length - m[3].length,
  }));
}

function extractRust(text: string): Sym[] {
  return byRegex(
    text,
    /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:(?:const|async|unsafe|extern[ \t]+"[^"]*")[ \t]+)*(fn|struct|enum|trait|mod|union|macro_rules!)[ \t]*([A-Za-z_]\w*)/gm,
    (m) => ({
      name: m[2],
      kind: ({ fn: "function", struct: "struct", enum: "enum", trait: "trait", mod: "module", union: "union", "macro_rules!": "macro" } as Record<string, SymbolKind>)[m[1]],
      nameOffset: m[0].length - m[2].length,
    }),
  );
}

function extractJs(text: string): Sym[] {
  return byRegex(
    text,
    /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:(?:async[ \t]+)?function\*?[ \t]+([A-Za-z_$][\w$]*)|class[ \t]+([A-Za-z_$][\w$]*)|(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)[ \t]*=>)/gm,
    (m) => {
      const name = m[1] ?? m[2] ?? m[3];
      return { name, kind: m[2] ? "class" : "function", nameOffset: m[0].lastIndexOf(name) };
    },
  );
}

function extractAsm(text: string): Sym[] {
  return byRegex(text, /^([A-Za-z_.$][\w.$]*):/gm, (m) =>
    m[1].startsWith(".L") ? null : { name: m[1], kind: "label", nameOffset: 0 },
  );
}

/** The innermost symbol whose body contains `line` (for the breadcrumb). */
export function symbolAt(syms: Sym[], line: number): Sym | undefined {
  let best: Sym | undefined;
  for (const s of syms) {
    if (s.line <= line && (s.endLine ?? s.line) >= line) best = s;
  }
  return best;
}
