// TextMate grammar support (the format VS Code extensions use for syntax
// highlighting), powered by vscode-textmate + the Oniguruma WASM regex engine.
import * as onig from "vscode-oniguruma";
import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import { INITIAL, Registry, parseRawGrammar, type IGrammar, type StateStack } from "vscode-textmate";
import { monaco } from "./monaco-setup";
import { api } from "./api";
import { onThemeScopes, themeScopes } from "./themes";

interface GrammarSource {
  scopeName: string;
  path: string;
  embeddedLanguages?: Record<string, string>;
}

const grammars = new Map<string, GrammarSource>(); // scopeName -> source
const languageScopes = new Map<string, string>(); // languageId -> scopeName
const injections = new Map<string, string[]>(); // target scope -> injected scopes
const activeLanguages = new Set<string>();

let registry: Registry | null = null;

function getRegistry(): Registry {
  if (registry) return registry;
  const onigLib = (async () => {
    const wasm = await fetch(onigWasmUrl).then((r) => r.arrayBuffer());
    await onig.loadWASM(wasm);
    return {
      createOnigScanner: (patterns: string[]) => new onig.OnigScanner(patterns),
      createOnigString: (s: string) => new onig.OnigString(s),
    };
  })();
  registry = new Registry({
    onigLib,
    loadGrammar: async (scopeName) => {
      const src = grammars.get(scopeName);
      if (!src) return null;
      const { content } = await api.readTextFile(src.path);
      return parseRawGrammar(content, src.path);
    },
    getInjections: (scopeName) => injections.get(scopeName),
  });
  return registry;
}

export function registerGrammar(contrib: {
  language?: string;
  scopeName: string;
  path: string;
  embeddedLanguages?: Record<string, string>;
  injectTo?: string[];
}) {
  grammars.set(contrib.scopeName, { scopeName: contrib.scopeName, path: contrib.path, embeddedLanguages: contrib.embeddedLanguages });
  for (const target of contrib.injectTo ?? []) {
    injections.set(target, [...(injections.get(target) ?? []), contrib.scopeName]);
  }
  if (contrib.language) {
    languageScopes.set(contrib.language, contrib.scopeName);
    // Load lazily, the first time a file of this language is opened.
    monaco.languages.onLanguage(contrib.language, () => attach(contrib.language!));
    if (monaco.editor.getModels().some((m) => m.getLanguageId() === contrib.language)) attach(contrib.language);
  }
}

class TMState implements monaco.languages.IState {
  constructor(public readonly stack: StateStack) {}
  clone() {
    return new TMState(this.stack);
  }
  equals(other: monaco.languages.IState) {
    return other instanceof TMState && other.stack.equals(this.stack);
  }
}

// TextMate gives a scope *stack* per token; Monaco wants one token name that
// it matches against theme rules by dot-prefix. Pick the innermost scope that
// the current theme actually colors, like VS Code's selector matching would.
let scopeCache = new Map<string, string>();

function pickScope(scopes: string[]): string {
  const key = scopes.join(" ");
  let hit = scopeCache.get(key);
  if (hit !== undefined) return hit;
  const rules = themeScopes();
  hit = "";
  for (let i = scopes.length - 1; i >= 0 && !hit; i--) {
    const s = scopes[i];
    if (rules.some((r) => s === r || s.startsWith(r + "."))) hit = s;
  }
  if (!hit) hit = scopes[scopes.length - 1] ?? "";
  scopeCache.set(key, hit);
  return hit;
}

async function attach(languageId: string) {
  const scopeName = languageScopes.get(languageId);
  if (!scopeName) return;
  let grammar: IGrammar | null;
  try {
    grammar = await getRegistry().loadGrammar(scopeName);
  } catch (e) {
    console.error(`Failed to load grammar ${scopeName}`, e);
    return;
  }
  if (!grammar) return;
  activeLanguages.add(languageId);
  const g = grammar;
  monaco.languages.setTokensProvider(languageId, {
    getInitialState: () => new TMState(INITIAL),
    tokenize(line, state: monaco.languages.IState) {
      // Guard against pathological lines (minified files) freezing the UI.
      const result = g.tokenizeLine(line.length > 20000 ? line.slice(0, 20000) : line, (state as TMState).stack, 500);
      return {
        endState: new TMState(result.ruleStack),
        tokens: result.tokens.map((t) => ({ startIndex: t.startIndex, scopes: pickScope(t.scopes) })),
      };
    },
  });
}

// Token names depend on the theme, so re-tokenize when it changes.
onThemeScopes(() => {
  scopeCache = new Map();
  for (const lang of activeLanguages) attach(lang);
});
