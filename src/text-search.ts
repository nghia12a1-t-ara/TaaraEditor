// Search / replace inside Monaco models (open editors, including unsaved
// changes). Mirrors the Rust implementation in src-tauri/src/search.rs.
import { monaco } from "./monaco-setup";
import type { LineMatch, QueryOptions } from "./api";

const PREVIEW_CHARS = 240;

export function buildRegExp(o: QueryOptions): RegExp | null {
  try {
    let src = o.isRegex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (o.wholeWord) src = `\\b(?:${src})\\b`;
    return new RegExp(src, o.caseSensitive ? "gu" : "giu");
  } catch {
    return null;
  }
}

export function searchModel(model: monaco.editor.ITextModel, o: QueryOptions, budget = 10_000): LineMatch[] {
  const re = buildRegExp(o);
  if (!re || !o.query) return [];
  const out: LineMatch[] = [];
  const lines = model.getLineCount();
  for (let ln = 1; ln <= lines; ln++) {
    const text = model.getLineContent(ln);
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue;
      const trimmed = text.trimStart();
      const cut = text.length - trimmed.length;
      const preview = trimmed.slice(0, PREVIEW_CHARS);
      const ps = Math.max(0, m.index! - cut);
      out.push({
        line: ln,
        start_col: m.index! + 1,
        end_col: m.index! + 1 + m[0].length,
        preview,
        preview_start: Math.min(ps, preview.length),
        preview_end: Math.min(ps + m[0].length, preview.length),
      });
      if (out.length >= budget) return out;
    }
  }
  return out;
}

/** Apply the case pattern of `matched` to `replacement` (VS Code "Preserve Case"). */
export function preserveCase(matched: string, replacement: string): string {
  const letters = [...matched].filter((c) => c.toLowerCase() !== c.toUpperCase());
  if (!letters.length) return replacement;
  const isUpper = (c: string) => c === c.toUpperCase() && c !== c.toLowerCase();
  const isLower = (c: string) => c === c.toLowerCase() && c !== c.toUpperCase();
  if (letters.length > 1 && letters.every(isUpper)) return replacement.toUpperCase();
  if (letters.every(isLower)) return replacement.toLowerCase();
  if (isUpper(letters[0]) && letters.slice(1).every(isLower)) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
  }
  return replacement;
}

/** Replacement text for one match: `$1`, `${name}`, `$&`/`$0`, `$$` in regex mode. */
export function expandReplacement(m: RegExpMatchArray, replace: string, isRegex: boolean, keepCase: boolean): string {
  let out = replace;
  if (isRegex) {
    out = replace.replace(/\$(\$|&|\d+|\{(\w+)\})/g, (all, tok: string, name?: string) => {
      if (tok === "$") return "$";
      if (tok === "&" || tok === "0") return m[0];
      if (name !== undefined) return (/^\d+$/.test(name) ? m[Number(name)] : m.groups?.[name]) ?? "";
      const n = Number(tok);
      return n < m.length ? (m[n] ?? "") : all;
    });
  }
  return keepCase ? preserveCase(m[0], out) : out;
}

/**
 * Replace matches in a model as one undoable edit. `only` limits it to
 * matches starting at (line, column). Returns the number of replacements.
 */
export function replaceInModel(
  model: monaco.editor.ITextModel,
  o: QueryOptions,
  replace: string,
  keepCase: boolean,
  only?: [number, number][],
): number {
  const re = buildRegExp(o);
  if (!re || !o.query) return 0;
  const wanted = only ? new Set(only.map(([l, c]) => `${l}:${c}`)) : null;
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
  for (let ln = 1; ln <= model.getLineCount(); ln++) {
    const text = model.getLineContent(ln);
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue;
      const col = m.index! + 1;
      if (wanted && !wanted.has(`${ln}:${col}`)) continue;
      edits.push({ range: new monaco.Range(ln, col, ln, col + m[0].length), text: expandReplacement(m, replace, o.isRegex, keepCase) });
    }
  }
  if (edits.length) {
    model.pushStackElement();
    model.pushEditOperations(null, edits, () => null);
    model.pushStackElement();
  }
  return edits.length;
}
