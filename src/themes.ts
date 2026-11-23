// Color themes. Every theme (built-in or from a .vsix) is a VS Code color
// theme JSON: `colors` drive the workbench CSS variables, `tokenColors` are
// converted to Monaco token rules.
import { monaco } from "./monaco-setup";
import { api, dirname, resolvePath } from "./api";
import { parseJsonc } from "./jsonc";
import khaki from "./themes/khaki.json";

export type UiTheme = "vs" | "vs-dark" | "hc-black" | "hc-light";

export interface VsTheme {
  name?: string;
  type?: string;
  colors?: Record<string, string>;
  tokenColors?: TokenColor[] | string;
  include?: string;
}

interface TokenColor {
  name?: string;
  scope?: string | string[];
  settings: { foreground?: string; background?: string; fontStyle?: string };
}

export interface ThemeEntry {
  id: string;
  label: string;
  uiTheme: UiTheme;
  source: string; // "Built-in" or extension display name
  load: () => Promise<VsTheme>;
}

// ---------------------------------------------------------------- built-ins

const darkPlus: VsTheme = {
  type: "dark",
  colors: {
    "editor.background": "#1E1E1E",
    "editor.foreground": "#D4D4D4",
  },
  tokenColors: [
    { scope: "comment", settings: { foreground: "#6A9955" } },
    { scope: "string", settings: { foreground: "#CE9178" } },
    { scope: "string.regexp", settings: { foreground: "#D16969" } },
    { scope: "constant.character.escape", settings: { foreground: "#D7BA7D" } },
    { scope: ["constant.numeric", "constant.other.number"], settings: { foreground: "#B5CEA8" } },
    { scope: ["constant.language", "variable.language"], settings: { foreground: "#569CD6" } },
    { scope: ["variable.other.constant", "variable.other.enummember", "support.constant"], settings: { foreground: "#4FC1FF" } },
    { scope: ["keyword", "storage", "storage.type", "storage.modifier"], settings: { foreground: "#569CD6" } },
    { scope: ["keyword.control", "keyword.control.directive", "keyword.other.using"], settings: { foreground: "#C586C0" } },
    { scope: ["keyword.operator"], settings: { foreground: "#D4D4D4" } },
    { scope: ["meta.preprocessor"], settings: { foreground: "#569CD6" } },
    { scope: ["entity.name.function", "support.function"], settings: { foreground: "#DCDCAA" } },
    { scope: ["entity.name.type", "entity.name.class", "entity.name.namespace", "support.class", "support.type"], settings: { foreground: "#4EC9B0" } },
    { scope: ["variable", "variable.parameter", "entity.name.variable", "meta.definition.variable.name"], settings: { foreground: "#9CDCFE" } },
    { scope: "entity.name.tag", settings: { foreground: "#569CD6" } },
    { scope: "entity.other.attribute-name", settings: { foreground: "#9CDCFE" } },
    { scope: "entity.name.label", settings: { foreground: "#C8C8C8" } },
    { scope: "markup.heading", settings: { foreground: "#569CD6", fontStyle: "bold" } },
    { scope: "markup.bold", settings: { fontStyle: "bold" } },
    { scope: "markup.italic", settings: { fontStyle: "italic" } },
    { scope: "invalid", settings: { foreground: "#F44747" } },
  ],
};

const lightPlus: VsTheme = {
  type: "light",
  colors: {
    "editor.background": "#FFFFFF",
    "editor.foreground": "#000000",
  },
  tokenColors: [
    { scope: "comment", settings: { foreground: "#008000" } },
    { scope: "string", settings: { foreground: "#A31515" } },
    { scope: "string.regexp", settings: { foreground: "#811F3F" } },
    { scope: "constant.character.escape", settings: { foreground: "#EE0000" } },
    { scope: ["constant.numeric", "constant.other.number"], settings: { foreground: "#098658" } },
    { scope: ["constant.language", "variable.language"], settings: { foreground: "#0000FF" } },
    { scope: ["variable.other.constant", "variable.other.enummember", "support.constant"], settings: { foreground: "#0070C1" } },
    { scope: ["keyword", "storage", "storage.type", "storage.modifier"], settings: { foreground: "#0000FF" } },
    { scope: ["keyword.control", "keyword.control.directive", "keyword.other.using"], settings: { foreground: "#AF00DB" } },
    { scope: ["keyword.operator"], settings: { foreground: "#000000" } },
    { scope: ["meta.preprocessor"], settings: { foreground: "#0000FF" } },
    { scope: ["entity.name.function", "support.function"], settings: { foreground: "#795E26" } },
    { scope: ["entity.name.type", "entity.name.class", "entity.name.namespace", "support.class", "support.type"], settings: { foreground: "#267F99" } },
    { scope: ["variable", "variable.parameter", "entity.name.variable", "meta.definition.variable.name"], settings: { foreground: "#001080" } },
    { scope: "entity.name.tag", settings: { foreground: "#800000" } },
    { scope: "entity.other.attribute-name", settings: { foreground: "#E50000" } },
    { scope: "markup.heading", settings: { foreground: "#800000", fontStyle: "bold" } },
    { scope: "markup.bold", settings: { fontStyle: "bold" } },
    { scope: "markup.italic", settings: { fontStyle: "italic" } },
    { scope: "invalid", settings: { foreground: "#CD3131" } },
  ],
};

const monokai: VsTheme = {
  type: "dark",
  colors: {
    "editor.background": "#272822",
    "editor.foreground": "#F8F8F2",
    "editor.selectionBackground": "#878B9180",
    "editor.lineHighlightBackground": "#3E3D32",
    "editorCursor.foreground": "#F8F8F0",
    "editorLineNumber.foreground": "#90908A",
    "editorWhitespace.foreground": "#464741",
    "editorIndentGuide.background": "#464741",
    "sideBar.background": "#1E1F1C",
    "activityBar.background": "#272822",
    "statusBar.background": "#414339",
    "titleBar.activeBackground": "#1E1F1C",
    "menu.background": "#1E1F1C",
    "editorGroupHeader.tabsBackground": "#1E1F1C",
    "tab.inactiveBackground": "#34352F",
    "tab.activeBackground": "#272822",
    "list.activeSelectionBackground": "#75715E",
    "list.hoverBackground": "#3E3D32",
    "input.background": "#414339",
    "button.background": "#75715E",
    "focusBorder": "#99947C",
  },
  tokenColors: [
    { scope: "comment", settings: { foreground: "#88846F" } },
    { scope: "string", settings: { foreground: "#E6DB74" } },
    { scope: ["constant.numeric", "constant.language", "constant.character", "constant.other"], settings: { foreground: "#AE81FF" } },
    { scope: ["keyword", "storage", "keyword.control.directive", "meta.preprocessor"], settings: { foreground: "#F92672" } },
    { scope: ["storage.type", "support.type"], settings: { foreground: "#66D9EF", fontStyle: "italic" } },
    { scope: ["entity.name.function", "support.function", "entity.other.attribute-name"], settings: { foreground: "#A6E22E" } },
    { scope: ["entity.name.type", "entity.name.class", "support.class"], settings: { foreground: "#A6E22E" } },
    { scope: "variable.parameter", settings: { foreground: "#FD971F", fontStyle: "italic" } },
    { scope: ["support.constant", "variable.other.constant"], settings: { foreground: "#66D9EF" } },
    { scope: "entity.name.tag", settings: { foreground: "#F92672" } },
    { scope: "invalid", settings: { foreground: "#F8F8F0" } },
  ],
};

const builtins: ThemeEntry[] = [
  { id: "taara.dark", label: "Dark", uiTheme: "vs-dark", source: "Built-in", load: async () => darkPlus },
  { id: "taara.light", label: "Light", uiTheme: "vs", source: "Built-in", load: async () => lightPlus },
  { id: "taara.monokai", label: "Monokai", uiTheme: "vs-dark", source: "Built-in", load: async () => monokai },
  { id: "taara.khaki", label: "Khaki", uiTheme: "vs", source: "Built-in", load: async () => khaki as VsTheme },
];

const registry = new Map<string, ThemeEntry>(builtins.map((t) => [t.id, t]));

export function allThemes(): ThemeEntry[] {
  return [...registry.values()];
}

export function registerTheme(entry: ThemeEntry) {
  registry.set(entry.id, entry);
}

/** Load a theme JSON file from disk, following `include` chains. */
export async function loadThemeFile(path: string, depth = 0): Promise<VsTheme> {
  const theme = parseJsonc<VsTheme>((await api.readTextFile(path)).content);
  if (typeof theme.tokenColors === "string") {
    console.warn(`Theme ${path}: .tmTheme tokenColors are not supported yet`);
    theme.tokenColors = [];
  }
  if (theme.include && depth < 5) {
    const base = await loadThemeFile(resolvePath(dirname(path), theme.include), depth + 1);
    return {
      ...base,
      ...theme,
      colors: { ...base.colors, ...theme.colors },
      tokenColors: [...((base.tokenColors as TokenColor[]) ?? []), ...((theme.tokenColors as TokenColor[]) ?? [])],
    };
  }
  return theme;
}

// ---------------------------------------------------------------- conversion

function hex6(color: string | undefined): string | undefined {
  if (!color || !/^#[0-9a-f]+$/i.test(color)) return undefined;
  let c = color.slice(1);
  if (c.length === 3 || c.length === 4) c = [...c.slice(0, 3)].map((x) => x + x).join("");
  return c.length >= 6 ? c.slice(0, 6) : undefined;
}

const isColor = (c: unknown): c is string => typeof c === "string" && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c);

/** Monarch tokens (Monaco's built-in highlighters) mapped to TextMate scopes. */
const monarchAliases: Record<string, string[]> = {
  number: ["constant.numeric"],
  type: ["entity.name.type", "support.type", "storage.type"],
  "type.identifier": ["entity.name.type", "entity.name.class"],
  "string.escape": ["constant.character.escape"],
  regexp: ["string.regexp"],
  tag: ["entity.name.tag"],
  "attribute.name": ["entity.other.attribute-name"],
  "attribute.value": ["string"],
  "keyword.directive": ["keyword.control.directive", "meta.preprocessor"],
  predefined: ["support.function"],
  "variable.predefined": ["variable.language"],
  constant: ["constant.language"],
  annotation: ["meta.preprocessor", "storage.type.annotation"],
};

type Rule = monaco.editor.ITokenThemeRule;

function scopeMatches(scope: string, selector: string) {
  return scope === selector || scope.startsWith(selector + ".");
}

function convert(entry: ThemeEntry, theme: VsTheme): { data: monaco.editor.IStandaloneThemeData; scopes: string[] } {
  const colors: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme.colors ?? {})) if (isColor(v)) colors[k] = v;

  const rules: Rule[] = [];
  for (const tc of (theme.tokenColors as TokenColor[]) ?? []) {
    const s = tc.settings ?? {};
    const rule = {
      foreground: hex6(s.foreground),
      background: hex6(s.background),
      fontStyle: s.fontStyle?.split(/\s+/).filter((w) => ["italic", "bold", "underline", "strikethrough"].includes(w)).join(" "),
    };
    if (!tc.scope) {
      // Global settings entry (old-style themes).
      if (s.foreground && !colors["editor.foreground"]) colors["editor.foreground"] = s.foreground;
      if (s.background && !colors["editor.background"]) colors["editor.background"] = s.background;
      continue;
    }
    const scopes = Array.isArray(tc.scope) ? tc.scope : tc.scope.split(",");
    for (let sel of scopes) {
      // Descendant selectors ("meta.function string"): use the last segment.
      sel = sel.trim().split(/\s+/).pop() ?? "";
      if (sel && !sel.startsWith("-")) rules.push({ token: sel, ...rule });
    }
  }

  // Map Monarch token names onto the closest TextMate rule.
  const resolve = (scope: string) => {
    let best: Rule | undefined;
    for (const r of rules) if (scopeMatches(scope, r.token) && (!best || r.token.length >= best.token.length)) best = r;
    return best;
  };
  for (const [token, candidates] of Object.entries(monarchAliases)) {
    if (rules.some((r) => r.token === token)) continue;
    for (const c of candidates) {
      const r = resolve(c);
      if (r) {
        rules.push({ ...r, token });
        break;
      }
    }
  }

  const fg = colors["editor.foreground"] ?? colors["foreground"];
  const bg = colors["editor.background"];
  rules.unshift({ token: "", foreground: hex6(fg), background: hex6(bg) });

  return {
    data: { base: entry.uiTheme, inherit: true, rules, colors },
    scopes: [...new Set(rules.map((r) => r.token).filter(Boolean))],
  };
}

// ---------------------------------------------------------------- workbench CSS

const uiDefaults: Record<"dark" | "light", Record<string, string>> = {
  dark: {
    bg: "#1E1E1E", fg: "#CCCCCC", "fg-muted": "#CCCCCC99", "sidebar-bg": "#252526", "sidebar-fg": "#CCCCCC",
    "activitybar-bg": "#333333", "activitybar-fg": "#FFFFFF", "activitybar-inactive": "#FFFFFF66",
    "statusbar-bg": "#007ACC", "statusbar-fg": "#FFFFFF", "tabs-bg": "#252526", "tab-bg": "#2D2D2D",
    "tab-active-bg": "#1E1E1E", "tab-fg": "#FFFFFF80", "tab-active-fg": "#FFFFFF", border: "#3C3C3C",
    "list-hover": "#2A2D2E", "list-active": "#04395E", "list-active-fg": "#FFFFFF", "input-bg": "#3C3C3C",
    "input-fg": "#CCCCCC", "input-border": "#3C3C3C", focus: "#007FD4", "menu-bg": "#252526", "menu-fg": "#CCCCCC",
    "menu-selection": "#04395E", "menu-selection-fg": "#FFFFFF", "button-bg": "#0E639C", "button-fg": "#FFFFFF",
    "titlebar-bg": "#3C3C3C", "titlebar-fg": "#CCCCCC", "badge-bg": "#4D4D4D", "badge-fg": "#FFFFFF",
    highlight: "#EA5C0055", "scrollbar": "#79797966", link: "#3794FF", error: "#F48771",
  },
  light: {
    bg: "#FFFFFF", fg: "#616161", "fg-muted": "#61616199", "sidebar-bg": "#F3F3F3", "sidebar-fg": "#616161",
    "activitybar-bg": "#2C2C2C", "activitybar-fg": "#FFFFFF", "activitybar-inactive": "#FFFFFF66",
    "statusbar-bg": "#007ACC", "statusbar-fg": "#FFFFFF", "tabs-bg": "#F3F3F3", "tab-bg": "#ECECEC",
    "tab-active-bg": "#FFFFFF", "tab-fg": "#333333B3", "tab-active-fg": "#333333", border: "#E5E5E5",
    "list-hover": "#E8E8E8", "list-active": "#0060C0", "list-active-fg": "#FFFFFF", "input-bg": "#FFFFFF",
    "input-fg": "#616161", "input-border": "#CECECE", focus: "#0090F1", "menu-bg": "#FFFFFF", "menu-fg": "#616161",
    "menu-selection": "#0060C0", "menu-selection-fg": "#FFFFFF", "button-bg": "#007ACC", "button-fg": "#FFFFFF",
    "titlebar-bg": "#DDDDDD", "titlebar-fg": "#333333", "badge-bg": "#C4C4C4", "badge-fg": "#333333",
    highlight: "#EA5C0055", "scrollbar": "#64646466", link: "#006AB1", error: "#E51400",
  },
};

/** CSS variable -> VS Code color keys (first defined wins). */
const uiMapping: Record<string, string[]> = {
  bg: ["editor.background"],
  fg: ["foreground", "editor.foreground"],
  "fg-muted": ["descriptionForeground"],
  "sidebar-bg": ["sideBar.background"],
  "sidebar-fg": ["sideBar.foreground", "foreground"],
  "activitybar-bg": ["activityBar.background"],
  "activitybar-fg": ["activityBar.foreground"],
  "activitybar-inactive": ["activityBar.inactiveForeground"],
  "statusbar-bg": ["statusBar.background"],
  "statusbar-fg": ["statusBar.foreground"],
  "tabs-bg": ["editorGroupHeader.tabsBackground", "sideBar.background"],
  "tab-bg": ["tab.inactiveBackground"],
  "tab-active-bg": ["tab.activeBackground", "editor.background"],
  "tab-fg": ["tab.inactiveForeground"],
  "tab-active-fg": ["tab.activeForeground"],
  border: ["sideBar.border", "panel.border", "editorGroup.border", "contrastBorder"],
  "list-hover": ["list.hoverBackground"],
  "list-active": ["list.activeSelectionBackground"],
  "list-active-fg": ["list.activeSelectionForeground"],
  "input-bg": ["input.background"],
  "input-fg": ["input.foreground"],
  "input-border": ["input.border", "dropdown.border"],
  focus: ["focusBorder"],
  "menu-bg": ["menu.background", "dropdown.background", "editorWidget.background"],
  "menu-fg": ["menu.foreground", "dropdown.foreground"],
  "menu-selection": ["menu.selectionBackground", "list.activeSelectionBackground"],
  "menu-selection-fg": ["menu.selectionForeground", "list.activeSelectionForeground"],
  "button-bg": ["button.background"],
  "button-fg": ["button.foreground"],
  "titlebar-bg": ["titleBar.activeBackground"],
  "titlebar-fg": ["titleBar.activeForeground"],
  "badge-bg": ["badge.background"],
  "badge-fg": ["badge.foreground"],
  highlight: ["editor.findMatchHighlightBackground"],
  scrollbar: ["scrollbarSlider.background"],
  link: ["textLink.foreground"],
  error: ["errorForeground"],
};

function applyCss(uiTheme: UiTheme, colors: Record<string, string>) {
  const dark = uiTheme === "vs-dark" || uiTheme === "hc-black";
  const vars = { ...uiDefaults[dark ? "dark" : "light"] };
  // Themes that only define the editor colors still get a coherent workbench.
  if (colors["editor.background"]) {
    vars["tab-active-bg"] = colors["editor.background"];
    if (!colors["sideBar.background"]) vars["sidebar-bg"] = shade(colors["editor.background"], dark ? 0.04 : -0.04);
    if (!colors["editorGroupHeader.tabsBackground"]) vars["tabs-bg"] = vars["sidebar-bg"];
    if (!colors["tab.inactiveBackground"]) vars["tab-bg"] = shade(colors["editor.background"], dark ? 0.07 : -0.07);
  }
  for (const [cssVar, keys] of Object.entries(uiMapping)) {
    const key = keys.find((k) => colors[k]);
    if (key) vars[cssVar] = colors[key];
  }
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(vars)) root.setProperty(`--${k}`, v);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

/** Lighten (amount>0) or darken (amount<0) a hex color. */
function shade(color: string, amount: number): string {
  const c = hex6(color);
  if (!c) return color;
  const n = parseInt(c, 16);
  const ch = (shift: number) => {
    const v = (n >> shift) & 255;
    const t = amount > 0 ? v + (255 - v) * amount : v * (1 + amount);
    return Math.round(t).toString(16).padStart(2, "0");
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

// ---------------------------------------------------------------- apply

type Listener = (scopes: string[]) => void;
const listeners: Listener[] = [];
let currentScopes: string[] = [];
let currentColors: Record<string, string> = {};

/** VS Code color keys of the active theme (e.g. "terminal.ansiRed"). */
export function themeColors(): Record<string, string> {
  return currentColors;
}

export function onThemeScopes(l: Listener) {
  listeners.push(l);
}

export function themeScopes() {
  return currentScopes;
}

export async function applyTheme(id: string): Promise<string> {
  const entry = registry.get(id) ?? registry.get("taara.dark")!;
  let theme: VsTheme;
  try {
    theme = await entry.load();
  } catch (e) {
    console.error(`Failed to load theme ${entry.id}`, e);
    if (entry.id === "taara.dark") throw e;
    return applyTheme("taara.dark");
  }
  const { data, scopes } = convert(entry, theme);
  const monacoName = "t-" + entry.id.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  monaco.editor.defineTheme(monacoName, data);
  monaco.editor.setTheme(monacoName);
  applyCss(entry.uiTheme, data.colors);
  currentColors = data.colors;
  currentScopes = scopes;
  listeners.forEach((l) => l(scopes));
  return entry.id;
}
