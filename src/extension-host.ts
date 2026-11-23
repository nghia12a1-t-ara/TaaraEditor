// Applies the *declarative* contributions of installed VS Code extensions:
//   contributes.themes     -> color themes
//   contributes.languages  -> language ids, file associations, language-configuration.json
//   contributes.grammars   -> TextMate syntax highlighting
//   contributes.snippets   -> snippet completions
// Extension JavaScript (activationEvents/main) is not executed yet; that needs
// a Node.js extension host implementing the `vscode` API (planned).
import { monaco } from "./monaco-setup";
import { api, resolvePath, type ExtensionInfo } from "./api";
import { parseJsonc } from "./jsonc";
import { registerTheme, loadThemeFile, type UiTheme } from "./themes";
import { registerGrammar } from "./textmate";
import { registerIconTheme } from "./file-icons";
import { settings } from "./settings";

export let installedExtensions: ExtensionInfo[] = [];
const applied = new Set<string>();

export async function loadExtensions(): Promise<void> {
  try {
    installedExtensions = await api.listExtensions();
  } catch (e) {
    console.error("Could not list extensions", e);
    installedExtensions = [];
  }
  for (const ext of installedExtensions) {
    if (!settings.disabledExtensions.includes(ext.id)) applyContributions(ext);
  }
}

export function isApplied(id: string) {
  return applied.has(id);
}

export function contributionSummary(ext: ExtensionInfo): string[] {
  return manifestSummary(ext.manifest);
}

/** What Taara can use from an extension manifest (package.json). */
export function manifestSummary(manifest: any): string[] {
  const c = manifest?.contributes ?? {};
  const parts: string[] = [];
  const count = (key: string, label: string) => {
    const n = Array.isArray(c[key]) ? c[key].length : 0;
    if (n) parts.push(`${n} ${label}${n > 1 ? "s" : ""}`);
  };
  count("themes", "theme");
  count("iconThemes", "file icon theme");
  count("languages", "language");
  count("grammars", "grammar");
  count("snippets", "snippet file");
  return parts;
}

/** True when the extension ships JavaScript that Taara cannot run yet. */
export function manifestHasCode(manifest: any): boolean {
  return !!(manifest?.main || manifest?.browser);
}

export function applyContributions(ext: ExtensionInfo) {
  if (applied.has(ext.id)) return;
  applied.add(ext.id);
  const c = ext.manifest?.contributes ?? {};
  const abs = (p: string) => resolvePath(ext.path, p);

  for (const t of asArray(c.themes)) {
    if (!t?.path) continue;
    const label = t.label ?? t.id ?? t.path;
    registerTheme({
      id: `${ext.id}/${t.id ?? label}`,
      label,
      uiTheme: (["vs", "vs-dark", "hc-black", "hc-light"].includes(t.uiTheme) ? t.uiTheme : "vs-dark") as UiTheme,
      source: ext.displayName,
      load: () => loadThemeFile(abs(t.path)),
    });
  }

  for (const t of asArray(c.iconThemes)) {
    if (!t?.path || !t.id) continue;
    registerIconTheme({ id: `${ext.id}/${t.id}`, label: t.label ?? t.id, source: ext.displayName, path: abs(t.path) });
  }

  for (const l of asArray(c.languages)) {
    if (!l?.id) continue;
    try {
      monaco.languages.register({
        id: l.id,
        extensions: l.extensions,
        filenames: l.filenames,
        filenamePatterns: l.filenamePatterns,
        aliases: l.aliases,
        firstLine: l.firstLine,
      });
      if (l.configuration) loadLanguageConfiguration(l.id, abs(l.configuration));
    } catch (e) {
      console.warn(`[${ext.id}] language ${l.id}`, e);
    }
  }

  for (const g of asArray(c.grammars)) {
    if (!g?.scopeName || !g.path) continue;
    registerGrammar({ ...g, path: abs(g.path) });
  }

  for (const s of asArray(c.snippets)) {
    if (s?.language && s.path) registerSnippets(s.language, abs(s.path));
  }
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

// ---------------------------------------------------------------- language-configuration.json

function toRegExp(v: unknown): RegExp | undefined {
  try {
    if (typeof v === "string") return new RegExp(v);
    if (v && typeof v === "object" && "pattern" in v) {
      const o = v as { pattern: string; flags?: string };
      return new RegExp(o.pattern, o.flags);
    }
  } catch {
    /* invalid or Oniguruma-only regex */
  }
  return undefined;
}

async function loadLanguageConfiguration(languageId: string, path: string) {
  try {
    const cfg = parseJsonc<any>((await api.readTextFile(path)).content);
    const conf: monaco.languages.LanguageConfiguration = {};
    if (cfg.comments) conf.comments = cfg.comments;
    if (Array.isArray(cfg.brackets)) conf.brackets = cfg.brackets;
    const pairs = (arr: unknown) =>
      asArray(arr).map((p) => (Array.isArray(p) ? { open: p[0], close: p[1] } : p));
    if (cfg.autoClosingPairs) conf.autoClosingPairs = pairs(cfg.autoClosingPairs);
    if (cfg.surroundingPairs) conf.surroundingPairs = pairs(cfg.surroundingPairs);
    const word = toRegExp(cfg.wordPattern);
    if (word) conf.wordPattern = word;
    if (cfg.indentationRules) {
      const inc = toRegExp(cfg.indentationRules.increaseIndentPattern);
      const dec = toRegExp(cfg.indentationRules.decreaseIndentPattern);
      if (inc && dec) {
        conf.indentationRules = {
          increaseIndentPattern: inc,
          decreaseIndentPattern: dec,
          indentNextLinePattern: toRegExp(cfg.indentationRules.indentNextLinePattern),
          unIndentedLinePattern: toRegExp(cfg.indentationRules.unIndentedLinePattern),
        };
      }
    }
    if (cfg.folding?.markers) {
      const start = toRegExp(cfg.folding.markers.start);
      const end = toRegExp(cfg.folding.markers.end);
      if (start && end) conf.folding = { offSide: cfg.folding.offSide, markers: { start, end } };
    }
    monaco.languages.setLanguageConfiguration(languageId, conf);
  } catch (e) {
    console.warn(`language-configuration for ${languageId}`, e);
  }
}

// ---------------------------------------------------------------- snippets

interface Snippet {
  prefix: string | string[];
  body: string | string[];
  description?: string;
}

const snippetFiles = new Map<string, string[]>(); // language -> files
const snippetCache = new Map<string, Promise<monaco.languages.CompletionItem[]>>();

function registerSnippets(language: string, path: string) {
  const known = snippetFiles.get(language);
  if (known) {
    known.push(path);
    snippetCache.delete(language);
    return;
  }
  snippetFiles.set(language, [path]);
  monaco.languages.registerCompletionItemProvider(language, {
    async provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const items = await loadSnippets(language);
      return { suggestions: items.map((i) => ({ ...i, range })) };
    },
  });
}

function loadSnippets(language: string) {
  let p = snippetCache.get(language);
  if (!p) {
    p = (async () => {
      const items: monaco.languages.CompletionItem[] = [];
      for (const file of snippetFiles.get(language) ?? []) {
        try {
          const data = parseJsonc<Record<string, Snippet>>((await api.readTextFile(file)).content);
          for (const [name, s] of Object.entries(data)) {
            if (!s?.body || !s.prefix) continue;
            const body = Array.isArray(s.body) ? s.body.join("\n") : s.body;
            for (const prefix of Array.isArray(s.prefix) ? s.prefix : [s.prefix]) {
              items.push({
                label: { label: prefix, description: name },
                kind: monaco.languages.CompletionItemKind.Snippet,
                documentation: s.description,
                insertText: body,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                range: undefined as any,
              });
            }
          }
        } catch (e) {
          console.warn(`snippets ${file}`, e);
        }
      }
      return items;
    })();
    snippetCache.set(language, p);
  }
  return p;
}
