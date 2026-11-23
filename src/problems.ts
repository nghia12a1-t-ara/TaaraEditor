// Problems: compiler diagnostics from build tasks (gcc / clang / ld output)
// plus the markers of language servers (clangd). Build problems are shown as
// editor markers, including in files opened after the build.
import { monaco } from "./monaco-setup";
import { resolvePath } from "./api";

export type Severity = "error" | "warning" | "info";

export interface Problem {
  path: string;
  line: number;
  column: number;
  severity: Severity;
  message: string;
  source: string;
}

const OWNER = "build";
let buildProblems: Problem[] = [];
const listeners: (() => void)[] = [];

export function onProblemsChanged(l: () => void) {
  listeners.push(l);
}

function emit() {
  listeners.forEach((l) => l());
}

const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();

// gcc / clang:  path:line:col: error: message   (column optional)
const GCC = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/;
// GNU ld:  path/main.c:(.text.main+0x12): undefined reference to `foo'
const LD = /^(.+?\.(?:c|cc|cpp|cxx|s|S|o)):\(([^)]*)\):\s*(.*)$/;

/**
 * Parse compiler output (already stripped of escape sequences).
 * Relative paths are resolved against `cwd` (and make's "Entering directory").
 */
export function parseCompilerOutput(lines: string[], cwd: string): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  const dirs = [cwd];
  for (const raw of lines) {
    const line = raw.trimEnd();
    const enter = /make(?:\[\d+\])?: Entering directory [`'"](.+)['"]/.exec(line);
    if (enter) {
      dirs.push(enter[1]);
      continue;
    }
    if (/make(?:\[\d+\])?: Leaving directory/.test(line)) {
      if (dirs.length > 1) dirs.pop();
      continue;
    }
    let p: Problem | null = null;
    const g = GCC.exec(line);
    if (g && !/^\s*(In file included|from )/.test(line)) {
      const sev = g[4] === "warning" ? "warning" : g[4] === "note" ? "info" : "error";
      p = { path: g[1].trim(), line: Number(g[2]), column: g[3] ? Number(g[3]) : 1, severity: sev, message: g[5], source: "gcc" };
    } else {
      const l = LD.exec(line);
      if (l && /undefined reference|multiple definition|relocation/.test(l[3])) {
        p = { path: l[1].trim(), line: 1, column: 1, severity: "error", message: `${l[3]} (${l[2]})`, source: "ld" };
      }
    }
    if (!p) continue;
    const dir = dirs[dirs.length - 1];
    if (!/^[A-Za-z]:[\\/]|^[\\/]/.test(p.path)) p.path = resolvePath(dir, p.path);
    p.path = p.path.replace(/\//g, "\\");
    const key = `${norm(p.path)}:${p.line}:${p.column}:${p.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function toMarker(p: Problem): monaco.editor.IMarkerData {
  return {
    startLineNumber: p.line,
    startColumn: p.column,
    endLineNumber: p.line,
    endColumn: p.column + 1,
    message: p.message,
    source: p.source,
    severity: p.severity === "error" ? monaco.MarkerSeverity.Error : p.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
  };
}

function applyToModel(model: monaco.editor.ITextModel) {
  if (model.uri.scheme !== "file") return;
  const key = norm(model.uri.fsPath);
  const mine = buildProblems.filter((p) => norm(p.path) === key);
  monaco.editor.setModelMarkers(
    model,
    OWNER,
    mine.map((p) => {
      const m = toMarker(p);
      // Underline the word at the error position, like VS Code.
      const line = Math.min(p.line, model.getLineCount());
      const word = model.getWordAtPosition({ lineNumber: line, column: Math.max(1, p.column) });
      return word
        ? { ...m, startLineNumber: line, endLineNumber: line, startColumn: word.startColumn, endColumn: word.endColumn }
        : { ...m, startLineNumber: line, endLineNumber: line, startColumn: 1, endColumn: model.getLineMaxColumn(line) };
    }),
  );
}

export function setBuildProblems(list: Problem[]) {
  buildProblems = list;
  monaco.editor.getModels().forEach(applyToModel);
  emit();
}

export function clearBuildProblems() {
  setBuildProblems([]);
}

monaco.editor.onDidCreateModel((m) => {
  if (buildProblems.length) applyToModel(m);
});
monaco.editor.onDidChangeMarkers(() => emit());

/** Everything for the Problems view: markers of open files + build problems of other files. */
export function allProblems(): Problem[] {
  const out: Problem[] = [];
  const open = new Set<string>();
  for (const m of monaco.editor.getModelMarkers({})) {
    if (m.resource.scheme !== "file") continue;
    open.add(norm(m.resource.fsPath));
    out.push({
      path: m.resource.fsPath,
      line: m.startLineNumber,
      column: m.startColumn,
      severity: m.severity === monaco.MarkerSeverity.Error ? "error" : m.severity === monaco.MarkerSeverity.Warning ? "warning" : "info",
      message: m.message,
      source: m.source ?? m.owner,
    });
  }
  const modelsOpen = new Set(monaco.editor.getModels().filter((m) => m.uri.scheme === "file").map((m) => norm(m.uri.fsPath)));
  for (const p of buildProblems) if (!modelsOpen.has(norm(p.path))) out.push(p);
  const rank = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => a.path.localeCompare(b.path) || rank[a.severity] - rank[b.severity] || a.line - b.line);
}

export function problemCounts() {
  let errors = 0;
  let warnings = 0;
  for (const p of allProblems()) {
    if (p.severity === "error") errors++;
    else if (p.severity === "warning") warnings++;
  }
  return { errors, warnings };
}
