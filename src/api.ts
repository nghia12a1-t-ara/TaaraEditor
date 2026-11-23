// Typed wrappers around the Rust commands in src-tauri/src.
import { invoke } from "@tauri-apps/api/core";
import { isRemote, remoteFs } from "./remote";

export interface TextFile {
  content: string;
  encoding: string;
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface LineMatch {
  line: number;
  start_col: number;
  end_col: number;
  /** Line text trimmed at the start, and the match range inside it (UTF-16). */
  preview: string;
  preview_start: number;
  preview_end: number;
}

export interface FileMatches {
  path: string;
  matches: LineMatch[];
}

export interface SearchResult {
  files: FileMatches[];
  total: number;
  truncated: boolean;
  cancelled: boolean;
}

export interface QueryOptions {
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface SearchOptions extends QueryOptions {
  root: string;
  maxResults?: number;
  include?: string;
  exclude?: string;
  useIgnoreFiles?: boolean;
}

export interface ReplaceRequest extends QueryOptions {
  replace: string;
  preserveCase: boolean;
  targets: { path: string; matches?: [number, number][] }[];
}

export type IndexSymbolKind =
  | "function" | "method" | "prototype" | "class" | "struct" | "enum" | "union" | "typedef" | "macro"
  | "enum_member" | "variable" | "field" | "declaration" | "namespace" | "label" | "trait" | "module";

export interface SymbolLocation {
  path: string;
  name: string;
  kind: IndexSymbolKind;
  line: number;
  column: number;
  container?: string;
}

export interface ExtensionInfo {
  id: string;
  name: string;
  publisher: string;
  version: string;
  displayName: string;
  description: string;
  path: string;
  hasCode: boolean;
  manifest: any;
}

/** One entry of an Open VSX search result. */
export interface MarketEntry {
  namespace: string;
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  downloadCount?: number;
  verified?: boolean;
  deprecated?: boolean;
  files?: { icon?: string };
}

export interface MarketSearch {
  extensions: MarketEntry[];
  offset: number;
  totalSize: number;
}

export const api = {
  startupPaths: () => invoke<string[]>("get_startup_paths"),
  // File operations: ssh://host/path goes to the SSH connection (remote.ts).
  readTextFile: (path: string) => (isRemote(path) ? remoteFs.readTextFile(path) : invoke<TextFile>("read_text_file", { path })),
  writeTextFile: (path: string, content: string, encoding: string) =>
    isRemote(path) ? remoteFs.writeTextFile(path, content, encoding) : invoke<void>("write_text_file", { path, content, encoding }),
  readDir: (path: string) => (isRemote(path) ? remoteFs.readDir(path) : invoke<DirEntry[]>("read_dir", { path })),
  createFile: (path: string) => (isRemote(path) ? remoteFs.createFile(path) : invoke<void>("create_file", { path })),
  createDir: (path: string) => (isRemote(path) ? remoteFs.createDir(path) : invoke<void>("create_dir", { path })),
  listFiles: (root: string, max?: number) => (isRemote(root) ? remoteFs.listFiles(root, max) : invoke<string[]>("list_files", { root, max })),
  rename: (from: string, to: string) => (isRemote(from) ? remoteFs.rename(from, to) : invoke<void>("rename_path", { from, to })),
  search: (options: SearchOptions) => (isRemote(options.root) ? remoteFs.search(options) : invoke<SearchResult>("search_in_files", { options })),
  replaceInFiles: (request: ReplaceRequest) => invoke<{ replaced: number; files: number; errors: string[] }>("replace_in_files", { request }),
  // The symbol index covers local folders only.
  indexFolder: (root: string) =>
    isRemote(root) ? Promise.resolve({ files: 0, symbols: 0, parsed: 0, millis: 0 }) : invoke<{ files: number; symbols: number; parsed: number; millis: number }>("index_folder", { root }),
  indexUpdateFile: (path: string) => (isRemote(path) ? Promise.resolve() : invoke<void>("index_update_file", { path })),
  findDefinitions: (name: string) => invoke<SymbolLocation[]>("index_find_definitions", { name }),
  workspaceSymbols: (query: string, max = 200) => invoke<SymbolLocation[]>("index_workspace_symbols", { query, max }),
  findIncludeFiles: (include: string) => invoke<string[]>("index_find_files", { include }),
  extractSymbols: (text: string, fileName: string) => invoke<Omit<SymbolLocation, "path">[]>("extract_symbols", { text, fileName }),
  loadSettings: () => invoke<unknown>("load_settings"),
  saveSettings: (settings: unknown) => invoke<void>("save_settings", { settings }),
  listExtensions: () => invoke<ExtensionInfo[]>("list_extensions"),
  installVsix: (path: string) => invoke<ExtensionInfo>("install_vsix", { path }),
  uninstallExtension: (id: string) => invoke<void>("uninstall_extension", { id }),
  extensionsDir: () => invoke<string>("extensions_dir"),
  marketSearch: (query: string, category: string | null, offset: number, size = 30) =>
    invoke<MarketSearch>("marketplace_search", { query, category, offset, size }),
  marketManifest: (namespace: string, name: string) => invoke<any>("marketplace_manifest", { namespace, name }),
  marketInstall: (namespace: string, name: string) => invoke<ExtensionInfo>("marketplace_install", { namespace, name }),
};

// ---- path helpers (Windows + POSIX separators) ----

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : p;
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") || !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

/** Resolve `rel` (which may contain ./ and ../) against directory `dir`. */
export function resolvePath(dir: string, rel: string): string {
  if (dir.startsWith("ssh://")) {
    // Remote (POSIX) path: keep "/" separators and the ssh://host prefix.
    const host = dir.slice(0, dir.indexOf("/", 6) < 0 ? dir.length : dir.indexOf("/", 6));
    const parts = dir.slice(host.length).split("/");
    for (const seg of rel.split(/[\\/]/)) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") parts.length > 1 && parts.pop();
      else parts.push(seg);
    }
    return host + (parts.join("/") || "/");
  }
  const parts = dir.split(/[\\/]/);
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("\\");
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export function relativePath(root: string | null, p: string): string {
  if (!root) return p;
  const r = root.replace(/[\\/]+$/, "");
  if (p.toLowerCase().startsWith(r.toLowerCase() + "\\") || p.toLowerCase().startsWith(r.toLowerCase() + "/")) {
    return p.slice(r.length + 1);
  }
  return p;
}

export function errorMessage(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
