// Source Control view (Ctrl+Shift+G) and the side-by-side diff viewer.
import { ask, message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { basename, dirname, errorMessage, relativePath } from "../api";
import { editors } from "../editor-manager";
import { fileIcon } from "../file-icons";
import * as g from "../git";
import { languageForPath, monaco } from "../monaco-setup";
import { h, icon } from "./dom";
import { showMenu } from "./menu";

const STATUS_TEXT: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", U: "Untracked", "!": "Conflict" };

export class ScmView {
  readonly el = h("div", { class: "view scm-view" });
  private message = h("textarea", { class: "input scm-message", rows: "3", placeholder: "Message (Ctrl+Enter to commit)", spellcheck: "false" });
  private body = h("div", { class: "scm-body" });
  private commitBtn = h("button", { class: "button scm-commit" });
  private collapsed = new Set<string>();

  constructor() {
    this.message.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.ctrlKey) {
        e.preventDefault();
        this.commit();
      }
    });
    this.commitBtn.addEventListener("click", () => this.commit());
    this.el.append(
      h(
        "div",
        { class: "view-header" },
        h("span", { class: "view-title", text: "SOURCE CONTROL" }),
        h(
          "div",
          { class: "view-actions" },
          h("button", { class: "icon-button", title: "Commit (Ctrl+Enter)", onclick: () => this.commit() }, icon("check")),
          h("button", { class: "icon-button", title: "Refresh", onclick: () => g.refreshGit() }, icon("refresh")),
          h("button", { class: "icon-button", title: "More Actions…", onclick: (e: MouseEvent) => this.moreMenu(e) }, icon("ellipsis")),
        ),
      ),
      this.body,
    );
    g.onGitChange(() => this.render());
    this.render();
  }

  focusMessage() {
    this.message.focus();
  }

  render() {
    const st = g.gitStatus();
    if (!g.isLocalRepoFolder()) {
      this.body.replaceChildren(h("div", { class: "view-empty muted", text: "Open a local folder to use source control." }));
      return;
    }
    if (!st?.is_repo) {
      this.body.replaceChildren(
        h(
          "div",
          { class: "view-empty" },
          h("p", { text: "The folder currently open doesn't have a git repository." }),
          h("button", { class: "button", text: "Initialize Repository", onclick: () => g.initRepo().catch((e) => message(errorMessage(e), { title: "Git", kind: "error" })) }),
        ),
      );
      return;
    }
    const staged = g.stagedFiles();
    const changes = g.changedFiles();
    const conflicts = g.conflictFiles();
    const branch = st.detached ? "detached HEAD" : st.branch ?? "";
    this.message.placeholder = `Message (Ctrl+Enter to commit on '${branch}')`;
    this.commitBtn.replaceChildren(icon("check"), staged.length || !changes.length ? " Commit" : " Commit All");
    this.commitBtn.disabled = !!g.gitBusy();

    const parts: HTMLElement[] = [h("div", { class: "scm-input" }, this.message, this.commitBtn)];
    if (g.gitBusy()) parts.push(h("div", { class: "scm-busy muted", text: g.gitBusy()! }));
    if (conflicts.length) parts.push(...this.section("MERGE CHANGES", conflicts, "conflict"));
    if (staged.length) parts.push(...this.section("STAGED CHANGES", staged, "staged"));
    parts.push(...this.section("CHANGES", changes, "changes"));
    if (!staged.length && !changes.length && !conflicts.length) parts.push(h("div", { class: "view-empty muted", text: "No changes." }));
    this.body.replaceChildren(...parts);
  }

  private section(title: string, files: g.GitFile[], kind: "staged" | "changes" | "conflict"): HTMLElement[] {
    if (!files.length && kind !== "changes") return [];
    const closed = this.collapsed.has(title);
    const actions =
      kind === "staged"
        ? [this.action("remove", "Unstage All Changes", () => this.run(() => g.unstage(files.map((f) => f.path))))]
        : [
            this.action("discard", "Discard All Changes", () => this.discard(files)),
            this.action("add", "Stage All Changes", () => this.run(() => g.stage(files.map((f) => f.path)))),
          ];
    const head = h(
      "div",
      { class: "debug-section-head scm-section-head" },
      icon(closed ? "chevronRight" : "chevronDown", "twistie"),
      h("span", { text: title }),
      h("span", { class: "spacer" }),
      h("span", { class: "row-actions" }, ...(files.length ? actions : [])),
      h("span", { class: "badge", text: String(files.length) }),
    );
    head.addEventListener("click", () => {
      if (closed) this.collapsed.delete(title);
      else this.collapsed.add(title);
      this.render();
    });
    if (closed) return [head];
    return [head, ...files.map((f) => this.fileRow(f, kind))];
  }

  private action(name: Parameters<typeof icon>[0], title: string, fn: () => void) {
    return h(
      "button",
      {
        class: "icon-button",
        title,
        onclick: (e: Event) => {
          e.stopPropagation();
          fn();
        },
      },
      icon(name),
    );
  }

  private fileRow(f: g.GitFile, kind: "staged" | "changes" | "conflict") {
    const root = g.gitStatus()?.root ?? null;
    const letter = kind === "conflict" ? "!" : kind === "staged" ? (f.index === "?" ? "U" : f.index) : f.index === "?" ? "U" : f.worktree;
    const cls = { M: "git-modified", A: "git-added", D: "git-deleted", R: "git-renamed", U: "git-untracked", "!": "git-conflict" }[letter] ?? "git-modified";
    const dir = relativePath(root, dirname(f.path));
    const row = h(
      "div",
      { class: `tree-row scm-file ${cls}`, title: `${f.path} • ${STATUS_TEXT[letter] ?? letter}${f.orig_path ? ` (from ${basename(f.orig_path)})` : ""}` },
      fileIcon(basename(f.path)),
      h("span", { class: `tree-label${letter === "D" ? " struck" : ""}`, text: basename(f.path) }),
      h("span", { class: "tree-desc", text: dir === dirname(f.path) ? "" : dir }),
      h(
        "span",
        { class: "row-actions" },
        this.action("file", "Open File", () => editors.open(f.path)),
        kind === "staged"
          ? this.action("remove", "Unstage Changes", () => this.run(() => g.unstage([f.path])))
          : this.action("discard", "Discard Changes", () => this.discard([f])),
        kind !== "staged" ? this.action("add", "Stage Changes", () => this.run(() => g.stage([f.path]))) : null,
      ),
      h("span", { class: `scm-letter ${cls}`, text: letter }),
    );
    row.addEventListener("click", () => {
      if (letter === "D") return;
      openDiff(f, kind === "staged");
    });
    return row;
  }

  private async run(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      await message(errorMessage(e), { title: "Git", kind: "error" });
    }
  }

  private async discard(files: g.GitFile[]) {
    const untracked = files.filter((f) => f.index === "?").length;
    const what = files.length === 1 ? `'${basename(files[0].path)}'` : `${files.length} files`;
    const ok = await ask(
      untracked
        ? `Are you sure you want to DELETE ${untracked === files.length ? what : `${untracked} untracked file(s)`} and discard the changes in the others?\n\nThis is IRREVERSIBLE!`
        : `Are you sure you want to discard the changes in ${what}?\n\nThis is IRREVERSIBLE!`,
      { title: "Discard Changes", kind: "warning", okLabel: untracked ? "Delete / Discard" : "Discard", cancelLabel: "Cancel" },
    );
    if (ok) await this.run(() => g.discard(files));
  }

  async commit() {
    const msg = this.message.value.trim();
    if (!msg) {
      this.message.focus();
      this.message.classList.add("scm-message-error");
      setTimeout(() => this.message.classList.remove("scm-message-error"), 1200);
      return;
    }
    await editors.saveAll();
    try {
      if (!g.stagedFiles().length) {
        const changes = g.changedFiles();
        if (!changes.length) return void message("There are no changes to commit.", { title: "Git", kind: "info" });
        // VS Code's "smart commit": offer to stage everything.
        const ok = await ask("There are no staged changes to commit.\n\nWould you like to stage all your changes and commit them directly?", {
          title: "Commit",
          kind: "info",
          okLabel: "Stage All & Commit",
          cancelLabel: "Cancel",
        });
        if (!ok) return;
        await g.stage(changes.map((f) => f.path));
      }
      await g.commit(msg);
      this.message.value = "";
    } catch (e) {
      await message(errorMessage(e), { title: "Commit failed", kind: "error" });
    }
  }

  private moreMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const run = (fn: () => Promise<unknown>) => () => this.run(fn);
    showMenu(
      [
        { label: "Pull", action: run(() => g.pull()) },
        { label: "Push", action: run(() => g.push()) },
        { label: "Sync (Pull, then Push)", action: run(() => g.sync()) },
        { label: "Fetch", action: run(() => g.fetch()) },
        "-",
        { label: "Commit Staged (Amend)", action: run(async () => this.message.value.trim() && (await g.commit(this.message.value.trim(), true), (this.message.value = ""))) },
        "-",
        { label: "Stage All Changes", action: run(() => g.stage(g.changedFiles().map((f) => f.path))) },
        { label: "Unstage All Changes", action: run(() => g.unstage(g.stagedFiles().map((f) => f.path))) },
        { label: "Discard All Changes", action: () => this.discard(g.changedFiles()) },
      ],
      r.left,
      r.bottom,
    );
  }
}

// ------------------------------------------------------------------ diff viewer

let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
let diffHost: HTMLElement | null = null;
let diffModels: monaco.editor.ITextModel[] = [];

export function closeDiff() {
  if (!diffHost) return;
  diffHost.style.display = "none";
  diffEditor?.setModel(null);
  diffModels.forEach((m) => m.dispose());
  diffModels = [];
}

/**
 * Show changes of a file side by side: working tree vs index (unstaged),
 * or index vs HEAD (staged), like VS Code.
 */
export async function openDiff(f: g.GitFile, staged: boolean) {
  const area = document.getElementById("editor-area")!;
  if (!diffHost) {
    const editorEl = h("div", { class: "diff-editor" });
    const title = h("span", { class: "diff-title" });
    const inline = h("button", { class: "icon-button", title: "Toggle Inline View", text: "⇄" });
    diffHost = h(
      "div",
      { class: "diff-overlay" },
      h(
        "div",
        { class: "diff-header" },
        title,
        h("span", { class: "spacer" }),
        inline,
        h("button", { class: "icon-button diff-open", title: "Open File" }, icon("file")),
        h("button", { class: "icon-button", title: "Close (Esc)", onclick: () => closeDiff() }, icon("close")),
      ),
      editorEl,
    );
    area.append(diffHost);
    diffEditor = monaco.editor.createDiffEditor(editorEl, { automaticLayout: true, readOnly: false, originalEditable: false, renderSideBySide: true, fontSize: 13, ignoreTrimWhitespace: false });
    let sideBySide = true;
    inline.addEventListener("click", () => {
      sideBySide = !sideBySide;
      diffEditor!.updateOptions({ renderSideBySide: sideBySide });
    });
    diffHost.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDiff();
    });
  }
  closeDiff();
  const root = g.gitStatus()?.root ?? "";
  const lang = languageForPath(f.path);
  // Left side: HEAD for staged changes, the index for unstaged ones.
  const left = (await invoke<string | null>("git_show", { root, rev: staged ? "HEAD" : "", path: f.path })) ?? "";
  let right: monaco.editor.ITextModel;
  if (staged) {
    right = monaco.editor.createModel((await invoke<string | null>("git_show", { root, rev: "", path: f.path })) ?? "", lang);
    diffModels.push(right);
  } else {
    // Working tree: the open editor model (live, editable) or the file on disk.
    const doc = editors.findByPath(f.path);
    if (doc) right = doc.model;
    else {
      const text = await invoke<{ content: string }>("read_text_file", { path: f.path }).catch(() => ({ content: "" }));
      right = monaco.editor.createModel(text.content, lang);
      diffModels.push(right);
    }
  }
  const original = monaco.editor.createModel(left, lang);
  diffModels.push(original);
  diffEditor!.setModel({ original, modified: right });
  diffEditor!.updateOptions({ readOnly: staged || !editors.findByPath(f.path) });
  diffHost!.querySelector<HTMLElement>(".diff-title")!.textContent = `${basename(f.path)} (${staged ? "Index ↔ HEAD" : "Working Tree ↔ Index"})`;
  diffHost!.querySelector<HTMLElement>(".diff-open")!.onclick = () => {
    closeDiff();
    editors.open(f.path);
  };
  diffHost!.style.display = "";
  setTimeout(() => diffEditor!.getModifiedEditor().focus(), 50);
}
