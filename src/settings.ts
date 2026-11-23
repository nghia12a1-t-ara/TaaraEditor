// User settings + session state, persisted as JSON by the Rust side.
import { api } from "./api";

export interface SearchSettings {
  query: string;
  replace: string;
  include: string;
  exclude: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
  preserveCase: boolean;
  showReplace: boolean;
  showDetails: boolean;
  onlyOpenEditors: boolean;
  useIgnoreFiles: boolean;
}

export interface Settings {
  theme: string;
  iconTheme: string;
  fontFamily: string;
  fontSize: number;
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: boolean;
  renderWhitespace: boolean;
  minimap: boolean;
  sidebarVisible: boolean;
  sidebarWidth: number;
  sidebarView: string;
  outlineVisible: boolean;
  outlineWidth: number;
  disabledExtensions: string[];
  recentFolders: string[];
  search: SearchSettings;
  clangd: { enabled: boolean; path: string };
  panelVisible: boolean;
  panelHeight: number;
  terminal: { defaultShell: string };
  /** Breakpoints by lower-cased file path. */
  breakpoints: Record<string, { path: string; lines: number[] }>;
  /** Debug watch expressions. */
  watch: string[];
  /** Automatic updates from GitHub Releases. */
  update: { checkOnStartup: boolean; skipVersion: string };
  /** First-run welcome tour completed. */
  onboarded: boolean;
  session: {
    folder: string | null;
    openFiles: string[];
    activeFile: string | null;
  };
}

const defaults: Settings = {
  theme: "taara.dark",
  iconTheme: "taara.builtin",
  fontFamily: "Consolas, 'Cascadia Mono', 'Courier New', monospace",
  fontSize: 14,
  tabSize: 4,
  insertSpaces: true,
  wordWrap: false,
  renderWhitespace: false,
  minimap: true,
  sidebarVisible: true,
  sidebarWidth: 260,
  sidebarView: "explorer",
  outlineVisible: false,
  outlineWidth: 240,
  disabledExtensions: [],
  recentFolders: [],
  search: {
    query: "",
    replace: "",
    include: "",
    exclude: "",
    caseSensitive: false,
    wholeWord: false,
    isRegex: false,
    preserveCase: false,
    showReplace: false,
    showDetails: false,
    onlyOpenEditors: false,
    useIgnoreFiles: true,
  },
  clangd: { enabled: true, path: "" },
  panelVisible: false,
  panelHeight: 260,
  terminal: { defaultShell: "" },
  breakpoints: {},
  watch: [],
  update: { checkOnStartup: true, skipVersion: "" },
  onboarded: false,
  session: { folder: null, openFiles: [], activeFile: null },
};

export const settings: Settings = structuredClone(defaults);

export async function loadSettings(): Promise<void> {
  try {
    const stored = (await api.loadSettings()) as Partial<Settings> | null;
    if (stored && typeof stored === "object") {
      Object.assign(settings, stored);
      settings.session = { ...defaults.session, ...(stored.session ?? {}) };
      settings.search = { ...defaults.search, ...(stored.search ?? {}) };
      settings.clangd = { ...defaults.clangd, ...(stored.clangd ?? {}) };
      settings.terminal = { ...defaults.terminal, ...(stored.terminal ?? {}) };
      settings.update = { ...defaults.update, ...(stored.update ?? {}) };
    }
  } catch (e) {
    console.warn("Could not load settings", e);
  }
}

let timer: number | undefined;

/** Persist settings (debounced). */
export function saveSettings(immediate = false): Promise<void> {
  window.clearTimeout(timer);
  if (immediate) return api.saveSettings(settings).catch((e) => console.warn(e));
  return new Promise((resolve) => {
    timer = window.setTimeout(() => api.saveSettings(settings).catch(console.warn).finally(resolve), 400);
  });
}

export function addRecentFolder(path: string) {
  settings.recentFolders = [path, ...settings.recentFolders.filter((p) => p.toLowerCase() !== path.toLowerCase())].slice(0, 10);
}
