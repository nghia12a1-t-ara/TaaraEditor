// Git integration (front end): repository status, operations, and the
// editor gutter showing added / modified / deleted lines against HEAD.
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./monaco-setup";
import { editors } from "./editor-manager";
import { gutterMarks } from "./line-diff";
import { settings } from "./settings";

export interface GitFile {
  path: string;
  orig_path: string | null;
  /** Staged status: ' ', M, A, D, R, C, U, ? */
  index: string;
  /** Working tree status: ' ', M, A, D, U, ? */
  worktree: string;
  conflict: boolean;
}

export interface GitStatus {
  is_repo: boolean;
  root: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

let status: GitStatus | null = null;
let refreshing: Promise<void> | null = null;
let again = false;
let busy: string | null = null;
const listeners: (() => void)[] = [];

export const gitStatus = () => status;
export const gitBusy = () => busy;

export function onGitChange(l: () => void) {
  listeners.push(l);
}

function emit() {
  listeners.forEach((l) => l());
}

const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();

export function isLocalRepoFolder() {
  const f = settings.session.folder;
  return !!f && !f.startsWith("ssh://");
}

/** Re-read `git status` (coalesces concurrent calls). */
export function refreshGit(): Promise<void> {
  if (refreshing) {
    again = true;
    return refreshing;
  }
  const folder = settings.session.folder;
  if (!folder || folder.startsWith("ssh://")) {
    status = null;
    emit();
    return Promise.resolve();
  }
  refreshing = invoke<GitStatus>("git_status", { folder })
    .then((s) => {
      status = s.is_repo ? s : { ...s, files: [] };
    })
    .catch(() => {
      status = null;
    })
    .finally(() => {
      refreshing = null;
      originals.clear();
      emit();
      updateGutter();
      if (again) {
        again = false;
        refreshGit();
      }
    });
  return refreshing;
}

// ------------------------------------------------------------------ queries

export function stagedFiles(): GitFile[] {
  return (status?.files ?? []).filter((f) => !f.conflict && f.index !== " " && f.index !== "?");
}

export function changedFiles(): GitFile[] {
  return (status?.files ?? []).filter((f) => !f.conflict && (f.worktree !== " " || f.index === "?"));
}

export function conflictFiles(): GitFile[] {
  return (status?.files ?? []).filter((f) => f.conflict);
}

/** Decoration for the explorer / tabs: letter + css class, or null. */
export function fileDecoration(path: string): { letter: string; cls: string } | null {
  if (!status) return null;
  const key = norm(path);
  const f = status.files.find((x) => norm(x.path) === key);
  if (!f) return null;
  if (f.conflict) return { letter: "!", cls: "git-conflict" };
  if (f.index === "?") return { letter: "U", cls: "git-untracked" };
  const c = f.worktree !== " " ? f.worktree : f.index;
  if (c === "D") return { letter: "D", cls: "git-deleted" };
  if (c === "A") return { letter: "A", cls: "git-added" };
  if (c === "R") return { letter: "R", cls: "git-renamed" };
  return { letter: "M", cls: "git-modified" };
}

/** True if a folder contains changed files (tints the folder in the explorer). */
export function folderHasChanges(dir: string): boolean {
  if (!status) return false;
  const key = norm(dir).replace(/\\$/, "") + "\\";
  return status.files.some((f) => norm(f.path).startsWith(key));
}

// ------------------------------------------------------------------ commands

export interface GitOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run git in the repository root; throws with git's message on failure. */
export async function git(args: string[], label?: string): Promise<GitOutput> {
  const root = status?.root ?? settings.session.folder;
  if (!root) throw new Error("No folder is open");
  busy = label ?? null;
  if (label) emit();
  try {
    const r = await invoke<GitOutput>("git_run", { root, args });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
    return r;
  } finally {
    busy = null;
    await refreshGit();
  }
}

const rel = (p: string) => {
  const root = status?.root ?? "";
  return p.toLowerCase().startsWith(root.toLowerCase()) ? p.slice(root.length).replace(/^[\\/]/, "").replace(/\\/g, "/") : p;
};

export const stage = (paths: string[]) => git(["add", "-A", "--", ...paths.map(rel)]);
export const unstage = (paths: string[]) => git(["reset", "-q", "HEAD", "--", ...paths.map(rel)]).catch(() => git(["rm", "--cached", "-q", "--", ...paths.map(rel)]));

/** Discard working tree changes (tracked files) or delete untracked files. */
export async function discard(files: GitFile[]) {
  const untracked = files.filter((f) => f.index === "?").map((f) => rel(f.path));
  const tracked = files.filter((f) => f.index !== "?").map((f) => rel(f.path));
  if (tracked.length) await git(["checkout", "--", ...tracked]);
  if (untracked.length) await git(["clean", "-f", "-q", "--", ...untracked]);
  // Reload open editors whose file changed on disk.
  for (const f of files) {
    const doc = editors.findByPath(f.path);
    if (doc && !editors.isDirty(doc)) {
      const text = await invoke<{ content: string }>("read_text_file", { path: f.path }).catch(() => null);
      if (text) {
        doc.model.setValue(text.content);
        doc.savedVersion = doc.model.getAlternativeVersionId();
      }
    }
  }
  editors.renderTabs();
}

export const commit = (message: string, amend = false) => git(["commit", ...(amend ? ["--amend"] : []), "-m", message], "Committing…");
export const checkout = (branch: string) => git(["checkout", branch], `Checking out ${branch}…`);
export const createBranch = (name: string) => git(["checkout", "-b", name], `Creating ${name}…`);
export const fetch = () => git(["fetch", "--prune"], "Fetching…");
export const pull = () => git(["pull", "--no-edit"], "Pulling…");

export async function push() {
  if (!status?.upstream && status?.branch) return git(["push", "-u", "origin", status.branch], "Publishing branch…");
  return git(["push"], "Pushing…");
}

export async function sync() {
  if (status?.upstream) await pull();
  await push();
}

export const initRepo = () => git(["init"], "Initializing…");

export async function branches(): Promise<{ name: string; current: boolean; remote: boolean }[]> {
  const r = await invoke<GitOutput>("git_run", { root: status?.root ?? settings.session.folder, args: ["branch", "-a", "--format=%(HEAD)|%(refname:short)"] });
  return r.stdout
    .split(/\r?\n/)
    .filter((l) => l && !l.endsWith("/HEAD"))
    .map((l) => {
      const [head, name] = l.split("|");
      return { name, current: head === "*", remote: name.includes("/") && !name.startsWith("heads/") };
    });
}

// ------------------------------------------------------------------ editor gutter

const originals = new Map<string, Promise<string | null>>();
const gutterIds = new Map<monaco.editor.ITextModel, string[]>();
let gutterTimer: number | undefined;

/** Original (HEAD) text of a file, or null if the file is new / untracked. */
export function originalText(path: string, rev = "HEAD"): Promise<string | null> {
  const key = `${rev}|${norm(path)}`;
  let p = originals.get(key);
  if (!p) {
    p = status?.root ? invoke<string | null>("git_show", { root: status.root, rev, path }).catch(() => null) : Promise.resolve(null);
    originals.set(key, p);
  }
  return p;
}

export function scheduleGutter() {
  window.clearTimeout(gutterTimer);
  gutterTimer = window.setTimeout(updateGutter, 250);
}

async function updateGutter() {
  const doc = editors.active;
  if (!doc) return;
  const model = doc.model;
  const old = gutterIds.get(model) ?? [];
  const dec = doc.path ? fileDecoration(doc.path) : null;
  const inRepo = !!status?.root && !!doc.path && norm(doc.path).startsWith(norm(status.root).replace(/\\$/, "") + "\\");
  // Clean tracked files are not in `git status` but still get a gutter as soon
  // as they are edited (even before saving), like VS Code.
  if (!inRepo || dec?.cls === "git-untracked") {
    if (old.length) gutterIds.set(model, model.deltaDecorations(old, []));
    return;
  }
  const orig = await originalText(doc.path!);
  if (model.isDisposed() || editors.active?.model !== model) return;
  // No HEAD version: a newly added file is all "added"; ignored files get nothing.
  if (orig === null && dec?.letter !== "A") {
    if (old.length) gutterIds.set(model, model.deltaDecorations(old, []));
    return;
  }
  const marks = orig === null ? [{ line: 1, endLine: model.getLineCount(), kind: "added" as const }] : gutterMarks(orig, model.getValue());
  gutterIds.set(
    model,
    model.deltaDecorations(
      old,
      marks.map((m) => ({
        range: new monaco.Range(m.line, 1, m.endLine, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `git-gutter-${m.kind}`,
          overviewRuler: { color: m.kind === "added" ? "#587c0c" : m.kind === "deleted" ? "#94151b" : "#0c7d9d", position: monaco.editor.OverviewRulerLane.Left },
        },
      })),
    ),
  );
}

export function initGitEditor() {
  editors.on("active", scheduleGutter);
  editors.on("content", scheduleGutter);
  editors.onSaved(() => refreshGit());
  window.addEventListener("focus", () => refreshGit());
  // Cheap periodic refresh (catches commits made in the terminal).
  window.setInterval(() => {
    if (document.hasFocus() && isLocalRepoFolder()) refreshGit();
  }, 15000);
}
