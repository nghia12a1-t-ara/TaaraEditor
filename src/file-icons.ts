// File icon themes (VS Code `contributes.iconThemes`), e.g. Material Icon Theme,
// vscode-icons, Seti. Supports SVG/PNG icons and icon fonts, light overrides,
// and resolves icons the same way VS Code does:
//   file:   fileNames -> fileExtensions (longest first) -> languageIds -> file
//   folder: folderNames(Expanded) -> folder(Expanded)
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, dirname, resolvePath } from "./api";
import { parseJsonc } from "./jsonc";
import { languageForPath } from "./monaco-setup";
import { h } from "./ui/dom";

export const BUILTIN_ICON_THEME = "taara.builtin";
export const NO_ICON_THEME = "none";

export interface IconThemeEntry {
  id: string;
  label: string;
  source: string;
  path: string; // absolute path of the icon theme JSON
}

interface IconDefinition {
  iconPath?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontSize?: string;
  fontId?: string;
}

interface Associations {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  languageIds?: Record<string, string>;
}

interface IconThemeJson extends Associations {
  iconDefinitions?: Record<string, IconDefinition>;
  fonts?: { id: string; src: { path: string; format?: string }[]; weight?: string; style?: string; size?: string }[];
  hidesExplorerArrows?: boolean;
  light?: Associations;
  highContrast?: Associations;
}

const registry = new Map<string, IconThemeEntry>();
let active: { id: string; json: IconThemeJson; dir: string; lower: { dark: Associations; light?: Associations } } | null = null;
let activeId = BUILTIN_ICON_THEME;
const listeners: (() => void)[] = [];

export function registerIconTheme(entry: IconThemeEntry) {
  registry.set(entry.id, entry);
}

export function allIconThemes(): IconThemeEntry[] {
  return [...registry.values()];
}

export function onIconThemeChange(l: () => void) {
  listeners.push(l);
}

/** Re-render icons, e.g. after switching between a light and dark color theme. */
export function refreshFileIcons() {
  if (active?.json.light) listeners.forEach((l) => l());
}

/** VS Code matches file/folder names case-insensitively; pre-lowercase the keys once. */
function lowerKeys(a: Associations | undefined): Associations | undefined {
  if (!a) return undefined;
  const low = (m?: Record<string, string>) => (m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k.toLowerCase(), v])) : undefined);
  return { ...a, fileNames: low(a.fileNames), fileExtensions: low(a.fileExtensions), folderNames: low(a.folderNames), folderNamesExpanded: low(a.folderNamesExpanded) };
}

let fontStyle: HTMLStyleElement | null = null;

export async function applyIconTheme(id: string): Promise<string> {
  const entry = registry.get(id);
  if (!entry) {
    active = null;
    activeId = id === NO_ICON_THEME ? NO_ICON_THEME : BUILTIN_ICON_THEME;
  } else {
    try {
      const json = parseJsonc<IconThemeJson>((await api.readTextFile(entry.path)).content);
      const dir = dirname(entry.path);
      active = { id, json, dir, lower: { dark: lowerKeys(json)!, light: lowerKeys(json.light) } };
      activeId = id;
      // Icon fonts (Seti-style themes).
      fontStyle?.remove();
      fontStyle = null;
      if (json.fonts?.length) {
        fontStyle = document.createElement("style");
        fontStyle.textContent = json.fonts
          .map((f) => {
            const src = f.src.map((s) => `url("${convertFileSrc(resolvePath(dir, s.path))}")${s.format ? ` format("${s.format}")` : ""}`).join(", ");
            return `@font-face { font-family: "ti-${cssId(f.id)}"; src: ${src}; font-weight: ${f.weight ?? "normal"}; font-style: ${f.style ?? "normal"}; }`;
          })
          .join("\n");
        document.head.append(fontStyle);
      }
    } catch (e) {
      console.error(`Failed to load icon theme ${id}`, e);
      active = null;
      activeId = BUILTIN_ICON_THEME;
    }
  }
  document.documentElement.classList.toggle("hide-explorer-arrows", !!active?.json.hidesExplorerArrows);
  listeners.forEach((l) => l());
  return activeId;
}

function cssId(s: string) {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Light-theme overrides take precedence when the workbench is light. */
function lookup(field: keyof Associations, key?: string): string | undefined {
  if (!active) return undefined;
  const light = document.documentElement.dataset.theme === "light" ? active.lower.light : undefined;
  for (const a of light ? [light, active.lower.dark] : [active.lower.dark]) {
    const v = a[field] as any;
    const hit = key === undefined ? v : v?.[key];
    if (typeof hit === "string") return hit;
  }
  return undefined;
}

function resolveFile(name: string): string | undefined {
  const lower = name.toLowerCase();
  const byName = lookup("fileNames", lower);
  if (byName) return byName;
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const hit = lookup("fileExtensions", parts.slice(i).join("."));
    if (hit) return hit;
  }
  const lang = languageForPath(name);
  return lookup("languageIds", lang) ?? lookup("file");
}

function resolveFolder(name: string, expanded: boolean): string | undefined {
  const lower = name.toLowerCase();
  return (expanded ? lookup("folderNamesExpanded", lower) : undefined) ?? lookup("folderNames", lower) ?? lookup(expanded ? "folderExpanded" : "folder") ?? lookup("folder");
}

const urlCache = new Map<string, string>();

function render(defId: string | undefined): HTMLElement | null {
  if (!active || !defId) return null;
  const def = active.json.iconDefinitions?.[defId];
  if (!def) return null;
  if (def.iconPath) {
    const key = `${active.id}|${defId}`;
    let url = urlCache.get(key);
    if (!url) {
      url = convertFileSrc(resolvePath(active.dir, def.iconPath));
      urlCache.set(key, url);
    }
    return h("img", { class: "file-icon themed", src: url, alt: "", draggable: "false" });
  }
  if (def.fontCharacter) {
    const fontId = def.fontId ?? active.json.fonts?.[0]?.id;
    const ch = def.fontCharacter.replace(/^\\/, "");
    const text = /^[0-9a-f]{2,6}$/i.test(ch) ? String.fromCodePoint(parseInt(ch, 16)) : def.fontCharacter;
    return h("span", {
      class: "file-icon themed font",
      text,
      style: { fontFamily: fontId ? `"ti-${cssId(fontId)}"` : "", color: def.fontColor ?? "", fontSize: def.fontSize ?? "" },
    });
  }
  return null;
}

/** Icon element for a file or folder, using the active icon theme. */
export function fileIcon(name: string, opts: { isDir?: boolean; expanded?: boolean } = {}): HTMLElement {
  if (activeId === NO_ICON_THEME) return h("span", { class: "file-icon none" });
  const themed = render(opts.isDir ? resolveFolder(name, !!opts.expanded) : resolveFile(name));
  if (themed) return themed;
  return h("span", { class: `file-icon ${builtinClass(name, !!opts.isDir)}` });
}

/** Built-in icons: small colored letter badges, no assets needed. */
function builtinClass(name: string, isDir: boolean): string {
  if (isDir) return "fi-folder";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "c") return "fi-c";
  if (["h", "hpp", "hh", "hxx"].includes(ext)) return "fi-h";
  if (["cpp", "cc", "cxx"].includes(ext)) return "fi-cpp";
  if (["s", "asm", "inc"].includes(ext)) return "fi-asm";
  if (["ld", "lds"].includes(ext)) return "fi-ld";
  if (ext === "py") return "fi-py";
  if (ext === "rs") return "fi-rs";
  if (["json", "jsonc"].includes(ext)) return "fi-json";
  if (["md", "txt", "log"].includes(ext)) return "fi-text";
  if (["mk", "cmake"].includes(ext) || /^makefile$|^cmakelists\.txt$/i.test(name)) return "fi-make";
  return "fi-file";
}
