// File explorer tree (lazy-loaded directories).
import { message } from "@tauri-apps/plugin-dialog";
import { api, basename, dirname, errorMessage, joinPath, samePath, type DirEntry } from "../api";
import { editors } from "../editor-manager";
import { settings } from "../settings";
import { fileIcon, onIconThemeChange } from "../file-icons";
import { fileDecoration, folderHasChanges, onGitChange } from "../git";
import { h, icon } from "./dom";
import { showMenu } from "./menu";
import { showInputBox } from "./quickpick";

export interface ExplorerHost {
  openFolder: () => void;
}

export class Explorer {
  readonly el = h("div", { class: "view explorer" });
  private tree = h("div", { class: "tree", tabindex: "0" });
  private expanded = new Set<string>();
  private children = new Map<string, DirEntry[]>();
  private selected: string | null = null;

  constructor(private host: ExplorerHost) {
    this.tree.addEventListener("contextmenu", (e) => {
      if (e.target === this.tree && settings.session.folder) {
        e.preventDefault();
        this.showContextMenu(e, { name: basename(settings.session.folder), path: settings.session.folder, is_dir: true });
      }
    });
    editors.on("active", () => this.revealActive());
    onIconThemeChange(() => this.render());
    onGitChange(() => this.render());
  }

  get root() {
    return settings.session.folder;
  }

  async setRoot(folder: string | null) {
    this.expanded.clear();
    this.children.clear();
    if (folder) this.expanded.add(folder.toLowerCase());
    await this.refresh();
  }

  async refresh() {
    // Reload expanded folders, keep expansion state.
    const keep = new Set(this.expanded);
    this.children.clear();
    if (this.root) await this.load(this.root);
    for (const dir of keep) if (this.root && dir !== this.root.toLowerCase()) await this.load(dir).catch(() => this.expanded.delete(dir));
    this.render();
  }

  private async load(dir: string) {
    const entries = await api.readDir(dir);
    this.children.set(dir.toLowerCase(), entries);
    return entries;
  }

  collapseAll() {
    this.expanded.clear();
    if (this.root) this.expanded.add(this.root.toLowerCase());
    this.render();
  }

  render() {
    const root = this.root;
    if (!root) {
      this.el.replaceChildren(
        h("div", { class: "view-header" }, h("span", { class: "view-title", text: "EXPLORER" })),
        h(
          "div",
          { class: "view-empty" },
          h("p", { text: "You have not yet opened a folder." }),
          h("button", { class: "button", text: "Open Folder", onclick: () => this.host.openFolder() }),
        ),
      );
      return;
    }
    const actions = h(
      "div",
      { class: "view-actions" },
      this.action("newFile", "New File", () => this.newEntry(this.targetDir(), false)),
      this.action("newFolder", "New Folder", () => this.newEntry(this.targetDir(), true)),
      this.action("refresh", "Refresh", () => this.refresh()),
      this.action("collapse", "Collapse Folders", () => this.collapseAll()),
    );
    this.el.replaceChildren(
      h("div", { class: "view-header" }, h("span", { class: "view-title", text: basename(root).toUpperCase(), title: root }), actions),
      this.tree,
    );
    this.tree.replaceChildren(...this.renderDir(root, 0));
    this.highlightActive();
  }

  private action(name: Parameters<typeof icon>[0], title: string, fn: () => void) {
    return h("button", { class: "icon-button", title, onclick: fn }, icon(name));
  }

  private targetDir(): string {
    if (this.selected) {
      const entry = this.findEntry(this.selected);
      if (entry) return entry.is_dir ? entry.path : dirname(entry.path);
    }
    return this.root!;
  }

  private findEntry(path: string): DirEntry | undefined {
    for (const list of this.children.values()) {
      const e = list.find((x) => samePath(x.path, path));
      if (e) return e;
    }
  }

  private renderDir(dir: string, depth: number): HTMLElement[] {
    const entries = this.children.get(dir.toLowerCase()) ?? [];
    const rows: HTMLElement[] = [];
    for (const entry of entries) {
      const open = entry.is_dir && this.expanded.has(entry.path.toLowerCase());
      const row = h(
        "div",
        {
          class: `tree-row${entry.is_dir ? " dir" : ""}`,
          style: { paddingLeft: `${8 + depth * 12}px` },
          title: entry.path,
          dataset: { path: entry.path },
        },
        entry.is_dir ? icon(open ? "chevronDown" : "chevronRight", "twistie") : h("span", { class: "twistie" }),
        fileIcon(entry.name, { isDir: entry.is_dir, expanded: open }),
        // Git status colors / letters, like VS Code.
        ...((): HTMLElement[] => {
          const dec = entry.is_dir ? null : fileDecoration(entry.path);
          const dirty = entry.is_dir && folderHasChanges(entry.path);
          return [
            h("span", { class: `tree-label${dec ? " " + dec.cls : dirty ? " git-folder-changed" : ""}`, text: entry.name }),
            dec ? h("span", { class: `git-letter ${dec.cls}`, text: dec.letter }) : dirty ? h("span", { class: "git-dot" }) : null,
          ].filter((x): x is HTMLElement => !!x);
        })(),
      );
      row.addEventListener("click", () => this.onClick(entry));
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.select(entry.path);
        this.showContextMenu(e, entry);
      });
      rows.push(row);
      if (open) rows.push(...this.renderDir(entry.path, depth + 1));
    }
    return rows;
  }

  private select(path: string) {
    this.selected = path;
    this.tree.querySelectorAll(".tree-row.selected").forEach((r) => r.classList.remove("selected"));
    this.rowFor(path)?.classList.add("selected");
  }

  private rowFor(path: string) {
    return [...this.tree.querySelectorAll<HTMLElement>(".tree-row")].find((r) => samePath(r.dataset.path!, path));
  }

  private async onClick(entry: DirEntry) {
    this.select(entry.path);
    if (entry.is_dir) {
      const key = entry.path.toLowerCase();
      if (this.expanded.has(key)) this.expanded.delete(key);
      else {
        this.expanded.add(key);
        if (!this.children.has(key)) {
          try {
            await this.load(entry.path);
          } catch (e) {
            this.expanded.delete(key);
            message(errorMessage(e), { title: "Taara Editor", kind: "error" });
          }
        }
      }
      this.render();
    } else {
      editors.open(entry.path);
    }
  }

  private showContextMenu(e: MouseEvent, entry: DirEntry) {
    const dir = entry.is_dir ? entry.path : dirname(entry.path);
    const isRoot = this.root && samePath(entry.path, this.root);
    showMenu(
      [
        { label: "New File...", action: () => this.newEntry(dir, false) },
        { label: "New Folder...", action: () => this.newEntry(dir, true) },
        "-",
        { label: "Rename...", disabled: !!isRoot, action: () => this.rename(entry) },
        "-",
        { label: "Copy Path", action: () => navigator.clipboard.writeText(entry.path) },
        { label: "Copy Relative Path", action: () => navigator.clipboard.writeText(this.root ? entry.path.slice(this.root.length + 1) : entry.path) },
        "-",
        { label: "Refresh", action: () => this.refresh() },
      ],
      e.clientX,
      e.clientY,
    );
  }

  private async newEntry(dir: string, folder: boolean) {
    const name = await showInputBox({
      prompt: folder ? "Folder name (press Enter to confirm)" : "File name (press Enter to confirm)",
      validate: (v) => (/[<>:"|?*]/.test(v) ? "Name contains invalid characters" : null),
    });
    if (!name) return;
    const path = joinPath(dir, name.replace(/\//g, "\\"));
    try {
      if (folder) await api.createDir(path);
      else {
        await api.createDir(dirname(path));
        await api.createFile(path);
      }
      this.expanded.add(dir.toLowerCase());
      await this.refresh();
      this.select(path);
      if (!folder) editors.open(path);
    } catch (e) {
      message(errorMessage(e), { title: "Taara Editor", kind: "error" });
    }
  }

  private async rename(entry: DirEntry) {
    const name = await showInputBox({ prompt: "New name", value: entry.name, selectBaseName: !entry.is_dir });
    if (!name || name === entry.name) return;
    const target = joinPath(dirname(entry.path), name);
    try {
      await api.rename(entry.path, target);
      if (entry.is_dir) {
        const key = entry.path.toLowerCase();
        if (this.expanded.delete(key)) this.expanded.add(target.toLowerCase());
      }
      await editors.onPathRenamed(entry.path, target);
      await this.refresh();
      this.select(target);
    } catch (e) {
      message(errorMessage(e), { title: "Taara Editor", kind: "error" });
    }
  }

  private highlightActive() {
    const path = editors.active?.path;
    this.tree.querySelectorAll(".tree-row.active").forEach((r) => r.classList.remove("active"));
    if (path) this.rowFor(path)?.classList.add("active");
  }

  /** Expand parents of the active file and scroll it into view. */
  private async revealActive() {
    const path = editors.active?.path;
    const root = this.root;
    const sep = root?.includes("/") && !root.includes("\\") ? "/" : "\\";
    if (!path || !root || !path.toLowerCase().startsWith(root.toLowerCase().replace(/[\\/]$/, "") + sep)) return this.highlightActive();
    const parts = path.slice(root.replace(/[\\/]$/, "").length + 1).split(/[\\/]/).slice(0, -1);
    let dir = root;
    let changed = false;
    for (const p of parts) {
      dir = joinPath(dir, p);
      const key = dir.toLowerCase();
      if (!this.expanded.has(key)) {
        this.expanded.add(key);
        changed = true;
      }
      if (!this.children.has(key)) await this.load(dir).catch(() => {});
    }
    if (changed) this.render();
    else this.highlightActive();
    this.rowFor(path)?.scrollIntoView({ block: "nearest" });
  }
}
