// clangd integration: C/C++ IntelliSense through the Language Server Protocol.
// Completion, hover, signature help, diagnostics, formatting, and precise
// go-to-definition / references (navigation.ts falls back to the symbol index
// when clangd is unavailable or has no answer).
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./monaco-setup";
import { LspClient } from "./lsp-client";
import { editors } from "./editor-manager";
import { settings } from "./settings";

const LANGS = new Set(["c", "cpp"]);

export interface ClangdInfo {
  path: string;
  version: string;
  source: string;
}

export interface CppProjectConfig {
  compile_commands_dir: string | null;
  fallback_flags: string[];
  summary: string[];
}

export const clangdApi = {
  find: (custom: string) => invoke<ClangdInfo | null>("clangd_find", { custom }),
  install: () => invoke<ClangdInfo>("clangd_install"),
  projectConfig: (root: string) => invoke<CppProjectConfig>("cpp_project_config", { root }),
};

export type ClangdState = "off" | "missing" | "starting" | "ready" | "indexing" | "installing" | "error";
type StatusListener = (state: ClangdState, text: string, detail: string) => void;

let client: LspClient | null = null;
let info: ClangdInfo | null = null;
let config: CppProjectConfig | null = null;
let state: ClangdState = "off";
let statusListener: StatusListener = () => {};
let startSeq = 0;
const opened = new Map<string, { model: monaco.editor.ITextModel; version: number; sub: monaco.IDisposable }>();

function setStatus(s: ClangdState, text: string, detail = "") {
  state = s;
  statusListener(s, text, detail);
}

export function onClangdStatus(l: StatusListener) {
  statusListener = l;
}

export function clangdState() {
  return state;
}

export function clangdDetails(): string {
  const lines = [info ? `clangd ${info.version} (${info.source})\n${info.path}` : "clangd is not running"];
  if (config) lines.push("", ...config.summary);
  return lines.join("\n");
}

// ------------------------------------------------------------------ URIs / positions

export function toLspUri(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return "file:///" + parts.map((p, i) => (i === 0 && /^[A-Za-z]:$/.test(p) ? p : encodeURIComponent(p))).join("/");
}

export function fromLspUri(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\/\/?/, "")).replace(/\//g, "\\");
}

const toPos = (p: monaco.IPosition) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const toRange = (r: any) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);

function modelPath(model: monaco.editor.ITextModel): string | null {
  return model.uri.scheme === "file" ? model.uri.fsPath : null;
}

function isTracked(model: monaco.editor.ITextModel) {
  const p = modelPath(model);
  return !!p && opened.has(p.toLowerCase());
}

function ready(model?: monaco.editor.ITextModel) {
  return !!client?.running && (state === "ready" || state === "indexing") && (!model || isTracked(model));
}

// ------------------------------------------------------------------ lifecycle

export async function stopClangd() {
  startSeq++;
  const c = client;
  client = null;
  for (const [, d] of opened) d.sub.dispose();
  opened.clear();
  monaco.editor.getModels().forEach((m) => monaco.editor.setModelMarkers(m, "clangd", []));
  if (c) await c.stop();
}

/** (Re)start clangd for the current folder. */
export async function startClangd() {
  await stopClangd();
  const seq = startSeq;
  if (!settings.clangd.enabled) return setStatus("off", "", "");
  // clangd runs locally; it cannot see files of a remote (SSH) folder.
  if (settings.session.folder?.startsWith("ssh://")) return setStatus("off", "", "");
  setStatus("starting", "clangd…", "Looking for clangd");
  info = await clangdApi.find(settings.clangd.path).catch(() => null);
  if (seq !== startSeq) return;
  if (!info) return setStatus("missing", "clangd: not installed", "C/C++ IntelliSense needs clangd. Click to install it.");

  const root = settings.session.folder;
  config = root ? await clangdApi.projectConfig(root).catch(() => null) : null;
  if (seq !== startSeq) return;
  const args = [
    "--background-index",
    "--header-insertion=never",
    "--completion-style=detailed",
    "--function-arg-placeholders",
    "--pch-storage=memory",
    "--log=error",
    // Ask the ARM GCC toolchain for its system headers when a compilation database uses it.
    "--query-driver=**/*arm-none-eabi*,**/*gcc*,**/*g++*",
  ];
  if (config?.compile_commands_dir) args.push(`--compile-commands-dir=${config.compile_commands_dir}`);

  let c: LspClient;
  try {
    c = await LspClient.start(info.path, args, root ?? undefined);
  } catch (e) {
    return setStatus("error", "clangd: failed", String(e));
  }
  if (seq !== startSeq) return void c.stop();
  client = c;
  c.onExit(() => {
    if (client !== c) return;
    client = null;
    opened.forEach((d) => d.sub.dispose());
    opened.clear();
    setStatus("error", "clangd: stopped", "clangd exited unexpectedly. Click to restart.");
  });
  c.onNotification("textDocument/publishDiagnostics", publishDiagnostics);
  c.onNotification("$/progress", (p) => {
    const v = p?.value;
    if (!v || !String(p.token).includes("backgroundIndex")) return;
    if (v.kind === "end") setStatus("ready", `clangd ${info!.version}`, clangdDetails());
    else if (v.percentage !== undefined) setStatus("indexing", `clangd: indexing ${v.percentage}%`, v.message ?? "");
  });

  try {
    await c.request("initialize", {
      processId: null,
      clientInfo: { name: "Taara Editor" },
      rootUri: root ? toLspUri(root) : null,
      workspaceFolders: root ? [{ uri: toLspUri(root), name: root.split(/[\\/]/).pop() }] : null,
      initializationOptions: { fallbackFlags: config?.fallback_flags ?? [] },
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        window: { workDoneProgress: true },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          completion: {
            completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"], insertReplaceSupport: false, labelDetailsSupport: true },
            contextSupport: true,
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true } },
          definition: { linkSupport: true },
          declaration: { linkSupport: true },
          references: {},
          formatting: {},
          rangeFormatting: {},
          publishDiagnostics: { relatedInformation: false, codeDescriptionSupport: true },
        },
      },
    });
  } catch (e) {
    if (client === c) setStatus("error", "clangd: failed", String(e));
    return;
  }
  if (seq !== startSeq) return;
  c.notify("initialized", {});
  setStatus("ready", `clangd ${info.version}`, clangdDetails());
  syncDocuments();
}

export async function installClangd(): Promise<ClangdInfo> {
  setStatus("installing", "clangd: downloading…", "Downloading clangd from github.com/clangd/clangd");
  try {
    const i = await clangdApi.install();
    await startClangd();
    return i;
  } catch (e) {
    setStatus("missing", "clangd: not installed", String(e));
    throw e;
  }
}

// ------------------------------------------------------------------ document sync

/** Open/close documents in clangd to match the open C/C++ editors. */
export function syncDocuments() {
  if (!client?.running) return;
  const wanted = new Map<string, monaco.editor.ITextModel>();
  for (const d of editors.docs) {
    if (d.path && LANGS.has(d.model.getLanguageId()) && !d.model.isDisposed()) wanted.set(d.path.toLowerCase(), d.model);
  }
  for (const [key, entry] of opened) {
    if (wanted.get(key) !== entry.model) {
      entry.sub.dispose();
      opened.delete(key);
      client.notify("textDocument/didClose", { textDocument: { uri: toLspUri(modelPath(entry.model) ?? key) } });
      if (!entry.model.isDisposed()) monaco.editor.setModelMarkers(entry.model, "clangd", []);
    }
  }
  for (const [key, model] of wanted) {
    if (opened.has(key)) continue;
    const path = modelPath(model)!;
    const uri = toLspUri(path);
    const entry = { model, version: 1, sub: null as unknown as monaco.IDisposable };
    entry.sub = model.onDidChangeContent((e) => {
      if (!client?.running) return;
      entry.version++;
      // Several edits at once (multi-cursor): send the full text, it is always correct.
      const contentChanges =
        e.changes.length === 1
          ? [{ range: { start: { line: e.changes[0].range.startLineNumber - 1, character: e.changes[0].range.startColumn - 1 }, end: { line: e.changes[0].range.endLineNumber - 1, character: e.changes[0].range.endColumn - 1 } }, text: e.changes[0].text }]
          : [{ text: model.getValue() }];
      client.notify("textDocument/didChange", { textDocument: { uri, version: entry.version }, contentChanges });
    });
    opened.set(key, entry);
    client.notify("textDocument/didOpen", { textDocument: { uri, languageId: model.getLanguageId() === "cpp" ? "cpp" : "c", version: 1, text: model.getValue() } });
  }
}

function publishDiagnostics(p: { uri: string; diagnostics: any[] }) {
  const entry = opened.get(fromLspUri(p.uri).toLowerCase());
  if (!entry || entry.model.isDisposed()) return;
  const severity = [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint];
  monaco.editor.setModelMarkers(
    entry.model,
    "clangd",
    p.diagnostics.map((d) => ({
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      message: d.message,
      severity: severity[d.severity ?? 1],
      source: d.source ?? "clangd",
      code: typeof d.code === "object" ? String(d.code?.value) : d.code !== undefined ? String(d.code) : undefined,
    })),
  );
}

// ------------------------------------------------------------------ navigation (used by navigation.ts)

export interface LspLocation {
  path: string;
  range: monaco.Range;
}

function locations(res: any): LspLocation[] {
  if (!res) return [];
  const list = Array.isArray(res) ? res : [res];
  return list
    .map((l: any) => ({ uri: l.targetUri ?? l.uri, range: l.targetSelectionRange ?? l.range }))
    .filter((l: any) => typeof l.uri === "string" && l.uri.startsWith("file:"))
    .map((l: any) => ({ path: fromLspUri(l.uri), range: toRange(l.range) }));
}

/** Definitions from clangd, or null when clangd can't answer for this model. */
export async function clangdDefinition(model: monaco.editor.ITextModel, position: monaco.Position): Promise<LspLocation[] | null> {
  if (!ready(model)) return null;
  const res = await client!.request("textDocument/definition", { textDocument: { uri: toLspUri(modelPath(model)!) }, position: toPos(position) }).catch(() => null);
  return locations(res);
}

export async function clangdReferences(model: monaco.editor.ITextModel, position: monaco.Position): Promise<LspLocation[] | null> {
  if (!ready(model)) return null;
  const res = await client!
    .request("textDocument/references", { textDocument: { uri: toLspUri(modelPath(model)!) }, position: toPos(position), context: { includeDeclaration: true } })
    .catch(() => null);
  return locations(res);
}

// ------------------------------------------------------------------ Monaco providers

const COMPLETION_KIND: Record<number, monaco.languages.CompletionItemKind> = (() => {
  const K = monaco.languages.CompletionItemKind;
  return {
    1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field, 6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module,
    10: K.Property, 11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet, 16: K.Color, 17: K.File, 18: K.Reference,
    19: K.Folder, 20: K.EnumMember, 21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator, 25: K.TypeParameter,
  };
})();

function markdown(doc: any): monaco.IMarkdownString | string | undefined {
  if (!doc) return undefined;
  if (typeof doc === "string") return doc;
  if (doc.kind === "markdown") return { value: doc.value };
  return doc.value;
}

function textEdit(e: any): monaco.languages.TextEdit {
  return { range: toRange(e.range), text: e.newText };
}

export function registerClangdProviders() {
  for (const lang of LANGS) {
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: [".", ">", ":", "<", '"', "/", "#"],
      async provideCompletionItems(model, position, context, token) {
        if (!ready(model)) return undefined;
        const res: any = await client!
          .request(
            "textDocument/completion",
            {
              textDocument: { uri: toLspUri(modelPath(model)!) },
              position: toPos(position),
              context: { triggerKind: context.triggerKind === 1 ? 2 : context.triggerKind === 2 ? 3 : 1, triggerCharacter: context.triggerCharacter },
            },
            token as any,
          )
          .catch(() => null);
        if (!res || token.isCancellationRequested) return undefined;
        const items: any[] = Array.isArray(res) ? res : res.items ?? [];
        const word = model.getWordUntilPosition(position);
        const defaultRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column);
        return {
          incomplete: !!res.isIncomplete,
          suggestions: items.map((it) => {
            const edit = it.textEdit;
            const range = edit ? toRange(edit.range ?? edit.insert) : defaultRange;
            const label = String(it.label).replace(/^[\s•]+/, "");
            return {
              label: it.labelDetails ? { label, detail: it.labelDetails.detail, description: it.labelDetails.description } : label,
              kind: COMPLETION_KIND[it.kind] ?? monaco.languages.CompletionItemKind.Text,
              detail: it.detail,
              documentation: markdown(it.documentation),
              insertText: edit?.newText ?? it.insertText ?? label,
              insertTextRules: it.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              range,
              sortText: it.sortText,
              filterText: it.filterText,
              preselect: it.preselect,
              additionalTextEdits: it.additionalTextEdits?.map(textEdit),
            } as monaco.languages.CompletionItem;
          }),
        };
      },
    });

    monaco.languages.registerHoverProvider(lang, {
      async provideHover(model, position, token) {
        if (!ready(model)) return null;
        const res: any = await client!.request("textDocument/hover", { textDocument: { uri: toLspUri(modelPath(model)!) }, position: toPos(position) }, token as any).catch(() => null);
        if (!res?.contents) return null;
        const contents = (Array.isArray(res.contents) ? res.contents : [res.contents]).map((c: any) => (typeof c === "string" ? { value: c } : c.language ? { value: "```" + c.language + "\n" + c.value + "\n```" } : { value: c.value }));
        return { contents, range: res.range ? toRange(res.range) : undefined };
      },
    });

    monaco.languages.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: ["(", ","],
      signatureHelpRetriggerCharacters: [")"],
      async provideSignatureHelp(model, position, token) {
        if (!ready(model)) return null;
        const res: any = await client!.request("textDocument/signatureHelp", { textDocument: { uri: toLspUri(modelPath(model)!) }, position: toPos(position) }, token as any).catch(() => null);
        if (!res?.signatures?.length) return null;
        return {
          value: {
            activeSignature: res.activeSignature ?? 0,
            activeParameter: res.activeParameter ?? 0,
            signatures: res.signatures.map((s: any) => ({
              label: s.label,
              documentation: markdown(s.documentation),
              parameters: (s.parameters ?? []).map((p: any) => ({ label: p.label, documentation: markdown(p.documentation) })),
              activeParameter: s.activeParameter,
            })),
          },
          dispose() {},
        };
      },
    });

    const formatOptions = (o: monaco.languages.FormattingOptions) => ({ tabSize: o.tabSize, insertSpaces: o.insertSpaces });
    monaco.languages.registerDocumentFormattingEditProvider(lang, {
      async provideDocumentFormattingEdits(model, options) {
        if (!ready(model)) return [];
        const res: any[] = await client!.request("textDocument/formatting", { textDocument: { uri: toLspUri(modelPath(model)!) }, options: formatOptions(options) }).catch(() => []);
        return (res ?? []).map(textEdit);
      },
    });
    monaco.languages.registerDocumentRangeFormattingEditProvider(lang, {
      async provideDocumentRangeFormattingEdits(model, range, options) {
        if (!ready(model)) return [];
        const res: any[] = await client!
          .request("textDocument/rangeFormatting", {
            textDocument: { uri: toLspUri(modelPath(model)!) },
            range: { start: toPos({ lineNumber: range.startLineNumber, column: range.startColumn }), end: toPos({ lineNumber: range.endLineNumber, column: range.endColumn }) },
            options: formatOptions(options),
          })
          .catch(() => []);
        return (res ?? []).map(textEdit);
      },
    });
  }

  // Keep clangd's view of open documents in sync with the editor.
  editors.on("docs", syncDocuments);
  editors.on("active", syncDocuments); // also fires on language mode changes
  editors.onSaved((path) => {
    if (client?.running && opened.has(path.toLowerCase())) client.notify("textDocument/didSave", { textDocument: { uri: toLspUri(path) } });
  });
}
