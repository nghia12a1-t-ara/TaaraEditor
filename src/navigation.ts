// Code navigation backed by the Rust workspace index (src-tauri/src/index.rs):
//   Go to Definition / Peek (F12, Ctrl+Click), #include navigation,
//   Find All References (Shift+F12), Go to Symbol in Workspace (Ctrl+T).
import { monaco } from "./monaco-setup";
import { api, basename, dirname, relativePath, resolvePath, samePath, type IndexSymbolKind, type SymbolLocation } from "./api";
import { editors } from "./editor-manager";
import { settings } from "./settings";
import { searchModel } from "./text-search";
import { showQuickPick } from "./ui/quickpick";
import { clangdDefinition, clangdReferences, type LspLocation } from "./clangd";

const DECLARATION_KINDS = new Set<IndexSymbolKind>(["prototype", "declaration", "field"]);

// ------------------------------------------------------------------ indexing

type IndexListener = (status: string, detail: string) => void;
let indexListener: IndexListener = () => {};
let indexing: Promise<void> | null = null;
let indexQueued = false;

export function onIndexStatus(l: IndexListener) {
  indexListener = l;
}

/** (Re)index the open folder. Incremental: only changed files are parsed. */
export function indexWorkspace(): Promise<void> {
  const root = settings.session.folder;
  // The symbol index covers local folders only (not ssh:// remote folders).
  if (!root || root.startsWith("ssh://")) {
    indexListener("", "");
    return Promise.resolve();
  }
  if (indexing) {
    indexQueued = true;
    return indexing;
  }
  indexListener("Indexing…", `Indexing symbols in ${root}`);
  indexing = api
    .indexFolder(root)
    .then((s) => {
      const n = s.symbols.toLocaleString();
      indexListener(`${n} symbols`, `${s.files.toLocaleString()} files, ${n} symbols indexed (${s.parsed} parsed in ${s.millis} ms). Click to re-index.`);
    })
    .catch((e) => indexListener("Index failed", String(e)))
    .finally(() => {
      indexing = null;
      if (indexQueued) {
        indexQueued = false;
        indexWorkspace();
      }
    });
  return indexing;
}

export function initIndexing() {
  editors.onSaved((path) => api.indexUpdateFile(path).catch(() => {}));
  // Pick up changes made outside the editor (git checkout, code generators…).
  let timer: number | undefined;
  window.addEventListener("focus", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => indexWorkspace(), 1500);
  });
}

// ------------------------------------------------------------------ helpers

interface Candidate {
  uri: monaco.Uri;
  path: string | null;
  name: string;
  kind: IndexSymbolKind;
  line: number;
  column: number;
}

const symbolCache = new WeakMap<monaco.editor.ITextModel, { version: number; syms: Promise<Omit<SymbolLocation, "path">[]> }>();

/** Symbols of an open model's current (possibly unsaved) text, parsed by Rust. */
function modelSymbols(model: monaco.editor.ITextModel) {
  const version = model.getVersionId();
  const cached = symbolCache.get(model);
  if (cached && cached.version === version) return cached.syms;
  const name = model.uri.scheme === "file" ? basename(model.uri.fsPath) : `untitled.${extForLanguage(model.getLanguageId())}`;
  const syms = api.extractSymbols(model.getValue(), name).catch(() => []);
  symbolCache.set(model, { version, syms });
  return syms;
}

function extForLanguage(lang: string) {
  return ({ c: "c", cpp: "cpp", python: "py", rust: "rs", javascript: "js", typescript: "ts", asm: "s", arm: "s" } as Record<string, string>)[lang] ?? "txt";
}

const docPath = (m: monaco.editor.ITextModel) => (m.uri.scheme === "file" ? m.uri.fsPath : null);

/** Make sure peek widgets can show a preview of every location. */
async function withModels(cands: Candidate[], limit = 30): Promise<monaco.languages.Location[]> {
  const out: monaco.languages.Location[] = [];
  for (const c of cands.slice(0, limit)) {
    let uri = c.uri;
    if (c.path && !monaco.editor.getModel(uri)) {
      const m = await editors.ensureModel(c.path).catch(() => null);
      if (!m) continue;
      uri = m.uri;
    }
    out.push({ uri, range: new monaco.Range(c.line, c.column, c.line, c.column + c.name.split("::").pop()!.length) });
  }
  return out;
}

/** All index + open-editor candidates for `word`. */
async function definitionCandidates(word: string): Promise<Candidate[]> {
  const dirty = editors.docs.filter((d) => editors.isDirty(d) || !d.path);
  const fromIndex = settings.session.folder ? await api.findDefinitions(word).catch(() => []) : [];
  const cands: Candidate[] = fromIndex
    // Unsaved editors are parsed from their current text instead.
    .filter((s) => !dirty.some((d) => d.path && samePath(d.path, s.path)))
    .map((s) => ({ uri: monaco.Uri.file(s.path), path: s.path, name: s.name, kind: s.kind, line: s.line, column: s.column }));
  for (const d of dirty) {
    for (const s of await modelSymbols(d.model)) {
      if (s.name === word || s.name.split("::").pop() === word) {
        cands.push({ uri: d.model.uri, path: d.path, name: s.name, kind: s.kind, line: s.line, column: s.column });
      }
    }
  }
  // Files that are open but outside the indexed folder.
  for (const d of editors.docs) {
    if (!d.path || dirty.includes(d) || (settings.session.folder && relativePath(settings.session.folder, d.path) !== d.path)) continue;
    for (const s of await modelSymbols(d.model)) {
      if (s.name === word || s.name.split("::").pop() === word) cands.push({ uri: d.model.uri, path: d.path, name: s.name, kind: s.kind, line: s.line, column: s.column });
    }
  }
  return cands;
}

/** `#include "x.h"` / `<x.h>` under the cursor -> candidate files. */
async function includeTargets(model: monaco.editor.ITextModel, position: monaco.Position): Promise<monaco.languages.LocationLink[] | null> {
  const line = model.getLineContent(position.lineNumber);
  const m = /^\s*#\s*include\s*([<"])([^>"]+)[>"]/.exec(line);
  if (!m) return null;
  const start = line.indexOf(m[2], m.index + m[0].indexOf(m[1])) + 1;
  if (position.column < start - 1 || position.column > start + m[2].length + 1) return null;
  const here = docPath(model);
  let paths = await api.findIncludeFiles(m[2]).catch(() => [] as string[]);
  // Quoted includes resolve relative to the including file first.
  if (here && m[1] === '"') {
    const local = resolvePath(dirname(here), m[2]);
    paths.sort((a, b) => Number(samePath(b, local)) - Number(samePath(a, local)));
    if (!paths.some((p) => samePath(p, local))) {
      const exists = await api.readTextFile(local).then(() => true, () => false);
      if (exists) paths.unshift(local);
    }
  }
  if (here) paths.sort((a, b) => Number(samePath(dirname(b), dirname(here))) - Number(samePath(dirname(a), dirname(here))));
  paths = paths.slice(0, 10);
  const origin = new monaco.Range(position.lineNumber, start, position.lineNumber, start + m[2].length);
  const links: monaco.languages.LocationLink[] = [];
  for (const p of paths) {
    const model2 = await editors.ensureModel(p).catch(() => null);
    if (model2) links.push({ uri: model2.uri, range: new monaco.Range(1, 1, 1, 1), originSelectionRange: origin });
  }
  return links;
}

async function lspLocations(locs: LspLocation[]): Promise<monaco.languages.Location[]> {
  const out: monaco.languages.Location[] = [];
  const seen = new Map<string, monaco.Uri | null>();
  for (const l of locs.slice(0, 500)) {
    const key = l.path.toLowerCase();
    if (!seen.has(key)) {
      const doc = editors.findByPath(l.path);
      const m = doc?.model ?? (await editors.ensureModel(l.path).catch(() => null));
      seen.set(key, m?.uri ?? null);
    }
    const uri = seen.get(key);
    if (uri) out.push({ uri, range: l.range });
  }
  return out;
}

// ------------------------------------------------------------------ providers

export function registerNavigation() {
  monaco.languages.registerDefinitionProvider("*", {
    async provideDefinition(model, position) {
      // clangd knows the real semantics (macros, overloads, #ifdef); use it first.
      const lsp = await clangdDefinition(model, position);
      if (lsp?.length) return lspLocations(lsp);
      const inc = await includeTargets(model, position);
      if (inc) return inc;
      const wordInfo = model.getWordAtPosition(position);
      if (!wordInfo) return null;
      const word = wordInfo.word;
      if (/^\d/.test(word)) return null;
      const here = docPath(model);
      const isSelf = (c: Candidate) =>
        c.uri.toString() === model.uri.toString() && c.line === position.lineNumber && c.column <= wordInfo.endColumn && c.column + c.name.length >= wordInfo.startColumn;
      const all = (await definitionCandidates(word)).filter((c) => !isSelf(c));
      // Definitions first; if the cursor is on the definition itself, the
      // declaration (e.g. the prototype in the header) is the next best target.
      let best = all.filter((c) => !DECLARATION_KINDS.has(c.kind));
      if (!best.length) best = all;
      // Same file, then same folder, then the rest.
      const score = (c: Candidate) => (c.uri.toString() === model.uri.toString() ? 0 : here && c.path && samePath(dirname(c.path), dirname(here)) ? 1 : 2);
      best.sort((a, b) => score(a) - score(b) || (a.path ?? "").localeCompare(b.path ?? "") || a.line - b.line);
      return withModels(best);
    },
  });

  // Shift+F12: whole-word occurrences across the folder + open editors.
  monaco.languages.registerReferenceProvider("*", {
    async provideReferences(model, position) {
      const word = model.getWordAtPosition(position)?.word;
      if (!word) return [];
      const lsp = await clangdReferences(model, position);
      if (lsp?.length) return lspLocations(lsp);
      const q = { query: word, isRegex: false, caseSensitive: true, wholeWord: true };
      const found = new Map<string, { path: string | null; uri: monaco.Uri; matches: { line: number; start_col: number }[] }>();
      const root = settings.session.folder;
      if (root) {
        const res = await api.search({ root, ...q, maxResults: 2000 }).catch(() => null);
        for (const f of res?.files ?? []) found.set(f.path.toLowerCase(), { path: f.path, uri: monaco.Uri.file(f.path), matches: f.matches });
      }
      for (const d of editors.docs) {
        if (d.path && !editors.isDirty(d) && found.has(d.path.toLowerCase())) continue;
        const matches = searchModel(d.model, q);
        const key = (d.path ?? d.uri.toString()).toLowerCase();
        if (matches.length) found.set(key, { path: d.path, uri: d.model.uri, matches });
        else found.delete(key);
      }
      const out: monaco.languages.Location[] = [];
      let files = 0;
      for (const f of found.values()) {
        if (++files > 150) break;
        let uri = f.uri;
        if (f.path && !monaco.editor.getModel(uri)) {
          const m = await editors.ensureModel(f.path).catch(() => null);
          if (!m) continue;
          uri = m.uri;
        }
        for (const m of f.matches) out.push({ uri, range: new monaco.Range(m.line, m.start_col, m.line, m.start_col + word.length) });
      }
      return out;
    },
  });
}

const KIND_LABEL: Record<IndexSymbolKind, string> = {
  function: "function",
  method: "method",
  prototype: "declaration",
  class: "class",
  struct: "struct",
  enum: "enum",
  union: "union",
  typedef: "typedef",
  macro: "macro",
  enum_member: "enum member",
  variable: "variable",
  field: "field",
  declaration: "extern",
  namespace: "namespace",
  label: "label",
  trait: "trait",
  module: "module",
};

/** Ctrl+T: fuzzy search all symbols in the workspace. */
export async function goToWorkspaceSymbol() {
  const root = settings.session.folder;
  if (!root) return;
  const initial = editors.active ? editors.editor.getModel()?.getWordAtPosition(editors.editor.getPosition()!)?.word ?? "" : "";
  const toItems = (syms: SymbolLocation[]) =>
    syms.map((s) => ({
      label: s.name,
      description: `${KIND_LABEL[s.kind]}${s.container ? ` · ${s.container}` : ""}  ${relativePath(root, s.path)}:${s.line}`,
      value: s,
    }));
  const picked = await showQuickPick(async () => toItems(await api.workspaceSymbols(initial, 200)), {
    placeholder: "Go to symbol in workspace (type a name, e.g. hgi → HAL_GPIO_Init)",
    initialValue: initial,
    query: async (q) => toItems(await api.workspaceSymbols(q, 200)),
  });
  if (picked) editors.open(picked.path, { line: picked.line, column: picked.column, endColumn: picked.column + picked.name.length });
}
