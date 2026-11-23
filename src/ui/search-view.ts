// Search view (Ctrl+Shift+F), modeled on VS Code: search + replace,
// files to include / exclude, open-editors-only, .gitignore toggle,
// replace preview, per-match / per-file / all replace, dismiss.
import { ask, message } from "@tauri-apps/plugin-dialog";
import { api, basename, dirname, errorMessage, relativePath, samePath, type FileMatches, type LineMatch, type QueryOptions } from "../api";
import { editors } from "../editor-manager";
import { fileIcon, onIconThemeChange } from "../file-icons";
import { saveSettings, settings } from "../settings";
import { buildRegExp, expandReplacement, replaceInModel, searchModel } from "../text-search";
import { h, icon, icons } from "./dom";

const MAX_RESULTS = 10_000;

type ToggleKey = "caseSensitive" | "wholeWord" | "isRegex" | "preserveCase" | "onlyOpenEditors" | "useIgnoreFiles";

export class SearchView {
  readonly el = h("div", { class: "view search-view" });
  private query = h("input", { class: "input", placeholder: "Search", spellcheck: "false" });
  private replace = h("input", { class: "input", placeholder: "Replace", spellcheck: "false" });
  private include = h("input", { class: "input", placeholder: "e.g. *.c, src/**/include", spellcheck: "false" });
  private exclude = h("input", { class: "input", placeholder: "e.g. *.o, Drivers", spellcheck: "false" });
  private results = h("div", { class: "search-results", tabindex: "0" });
  private summary = h("div", { class: "search-summary" });
  private replaceRow = h("div", { class: "search-row replace-row" });
  private details = h("div", { class: "search-details" });
  private toggleReplaceBtn = h("button", { class: "search-toggle-replace", title: "Toggle Replace" });
  private collapseBtn = h("button", { class: "icon-button", title: "Collapse All" });

  private files: FileMatches[] = [];
  private total = 0;
  private truncated = false;
  private collapsed = new Set<string>();
  private seq = 0;
  private searching = false;
  private error: string | null = null;
  private toggles = new Map<ToggleKey, HTMLElement>();

  // Note: this view is created before settings are loaded, so it must always
  // read `settings.search` at the time of use (see restoreState()).
  constructor() {
    const toggle = (key: ToggleKey, iconName: keyof typeof icons, title: string, rerun = true) => {
      const btn = h("button", { class: "toggle", title, html: icons[iconName] });
      this.toggles.set(key, btn);
      btn.addEventListener("click", () => {
        const s = settings.search;
        s[key] = !s[key];
        btn.classList.toggle("on", s[key]);
        saveSettings();
        if (rerun) this.run();
        else this.render();
      });
      return btn;
    };

    let timer: number | undefined;
    const debounced = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => this.run(), 300);
    };
    for (const input of [this.query, this.include, this.exclude]) {
      input.addEventListener("input", debounced);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          window.clearTimeout(timer);
          this.run();
        }
      });
    }
    this.replace.addEventListener("input", () => {
      settings.search.replace = this.replace.value;
      saveSettings();
      this.render(); // live replace preview
    });
    this.replace.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.ctrlKey && e.altKey) this.replaceAll();
    });

    this.toggleReplaceBtn.addEventListener("click", () => {
      const s = settings.search;
      s.showReplace = !s.showReplace;
      saveSettings();
      this.layout();
      this.render();
      if (s.showReplace) this.replace.focus();
    });
    this.collapseBtn.addEventListener("click", () => this.toggleCollapseAll());

    this.replaceRow.append(
      h("div", { class: "input-wrap" }, this.replace, toggle("preserveCase", "preserveCase", "Preserve Case", false)),
      h("button", { class: "icon-button", title: "Replace All (Ctrl+Alt+Enter)", onclick: () => this.replaceAll() }, icon("replaceAll")),
    );
    this.details.append(
      h("div", { class: "search-label", text: "files to include" }),
      h("div", { class: "input-wrap" }, this.include, toggle("onlyOpenEditors", "openEditors", "Search Only in Open Editors")),
      h("div", { class: "search-label", text: "files to exclude" }),
      h("div", { class: "input-wrap" }, this.exclude, toggle("useIgnoreFiles", "excludeSettings", "Use Exclude Settings and Ignore Files (.gitignore)")),
    );

    this.el.append(
      h(
        "div",
        { class: "view-header" },
        h("span", { class: "view-title", text: "SEARCH" }),
        h(
          "div",
          { class: "view-actions" },
          h("button", { class: "icon-button", title: "Refresh", onclick: () => this.run() }, icon("refresh")),
          h("button", { class: "icon-button", title: "Clear Search Results", onclick: () => this.clear() }, icon("clearAll")),
          this.collapseBtn,
        ),
      ),
      h(
        "div",
        { class: "search-form" },
        this.toggleReplaceBtn,
        h(
          "div",
          { class: "search-fields" },
          h(
            "div",
            { class: "search-row" },
            h("div", { class: "input-wrap" }, this.query, toggle("caseSensitive", "caseSensitive", "Match Case"), toggle("wholeWord", "wholeWord", "Match Whole Word"), toggle("isRegex", "regex", "Use Regular Expression")),
          ),
          this.replaceRow,
          h(
            "div",
            { class: "search-more" },
            h(
              "button",
              {
                class: "icon-button",
                title: "Toggle Search Details",
                onclick: () => {
                  const s = settings.search;
                  s.showDetails = !s.showDetails;
                  saveSettings();
                  this.layout();
                },
              },
              icon("ellipsis"),
            ),
          ),
          this.details,
        ),
      ),
      this.summary,
      this.results,
    );
    this.layout();
    this.render();
    onIconThemeChange(() => this.render());
    // Keep "open editors only" results in sync with the open tabs.
    editors.on("docs", () => {
      if (settings.search.onlyOpenEditors && this.query.value) this.run();
    });
  }

  /** Apply the persisted search state (call after settings are loaded). */
  restoreState() {
    const s = settings.search;
    this.query.value = s.query;
    this.replace.value = s.replace;
    this.include.value = s.include;
    this.exclude.value = s.exclude;
    for (const [key, btn] of this.toggles) btn.classList.toggle("on", !!s[key]);
    this.layout();
    this.render();
  }

  private layout() {
    const s = settings.search;
    this.replaceRow.style.display = s.showReplace ? "" : "none";
    this.details.style.display = s.showDetails ? "" : "none";
    this.toggleReplaceBtn.replaceChildren(icon(s.showReplace ? "chevronDown" : "chevronRight"));
  }

  focus(initial?: string) {
    if (initial) this.query.value = initial;
    this.query.focus();
    this.query.select();
    if (initial || (this.query.value && !this.files.length)) this.run();
  }

  focusReplace(initial?: string) {
    settings.search.showReplace = true;
    this.layout();
    this.focus(initial);
    this.replace.focus();
    this.replace.select();
  }

  private get opts(): QueryOptions {
    const s = settings.search;
    return { query: this.query.value, isRegex: s.isRegex, caseSensitive: s.caseSensitive, wholeWord: s.wholeWord };
  }

  private clear() {
    this.seq++;
    this.query.value = "";
    this.files = [];
    this.total = 0;
    this.error = null;
    this.searching = false;
    settings.search.query = "";
    saveSettings();
    this.render();
    this.query.focus();
  }

  async run() {
    const s = settings.search;
    s.query = this.query.value;
    s.include = this.include.value;
    s.exclude = this.exclude.value;
    saveSettings();
    const seq = ++this.seq;
    const opts = this.opts;
    this.error = null;
    if (!opts.query) {
      this.files = [];
      this.total = 0;
      this.searching = false;
      this.render();
      return;
    }
    if (opts.isRegex && !buildRegExp(opts)) {
      this.error = "Invalid regular expression";
      this.files = [];
      this.total = 0;
      this.render();
      return;
    }
    const root = settings.session.folder;
    this.searching = true;
    this.renderSummary();
    try {
      let files: FileMatches[] = [];
      let truncated = false;
      if (s.onlyOpenEditors || !root) {
        // Open editors only (includes unsaved changes and untitled files).
        for (const doc of editors.docs) {
          const matches = searchModel(doc.model, opts);
          if (matches.length) files.push({ path: doc.path ?? doc.title, matches });
        }
      } else {
        const res = await api.search({ root, ...opts, include: s.include, exclude: s.exclude, useIgnoreFiles: s.useIgnoreFiles, maxResults: MAX_RESULTS });
        if (seq !== this.seq || res.cancelled) return;
        files = res.files;
        truncated = res.truncated;
        // Unsaved editor content wins over the file on disk.
        for (const doc of editors.dirtyDocs) {
          if (!doc.path) continue;
          const i = files.findIndex((f) => samePath(f.path, doc.path!));
          const underRoot = relativePath(root, doc.path) !== doc.path;
          // A dirty file that had no match on disk: add it only when no globs
          // filter the search (globs are evaluated on the Rust side).
          if (i < 0 && (!underRoot || s.include.trim() || s.exclude.trim())) continue;
          const matches = searchModel(doc.model, opts);
          if (i >= 0) {
            if (matches.length) files[i] = { path: files[i].path, matches };
            else files.splice(i, 1);
          } else if (matches.length) {
            files.push({ path: doc.path, matches });
          }
        }
      }
      if (seq !== this.seq) return;
      this.files = files;
      this.total = files.reduce((n, f) => n + f.matches.length, 0);
      this.truncated = truncated;
    } catch (e) {
      if (seq !== this.seq) return;
      this.error = errorMessage(e);
      this.files = [];
      this.total = 0;
    } finally {
      if (seq === this.seq) {
        this.searching = false;
        this.render();
      }
    }
  }

  // ------------------------------------------------------------ replace

  private async replaceTargets(targets: { path: string; matches?: [number, number][] }[]) {
    const o = this.opts;
    const keepCase = settings.search.preserveCase;
    const replaceText = this.replace.value;
    const onDisk: typeof targets = [];
    for (const t of targets) {
      // Files open in the editor are edited there (undoable, left unsaved).
      const doc = editors.findByPath(t.path) ?? editors.docs.find((d) => !d.path && d.title === t.path);
      if (doc) replaceInModel(doc.model, o, replaceText, keepCase, t.matches);
      else onDisk.push(t);
    }
    if (onDisk.length) {
      try {
        const res = await api.replaceInFiles({ ...o, replace: replaceText, preserveCase: keepCase, targets: onDisk });
        for (const t of onDisk) api.indexUpdateFile(t.path).catch(() => {});
        if (res.errors.length) await message(`Some files could not be changed:\n\n${res.errors.join("\n")}`, { title: "Replace", kind: "error" });
      } catch (e) {
        await message(errorMessage(e), { title: "Replace", kind: "error" });
      }
    }
    await this.run();
  }

  async replaceAll() {
    if (!this.files.length) return;
    const n = this.total;
    const m = this.files.length;
    const ok = await ask(
      `Replace ${n} occurrence${n > 1 ? "s" : ""} across ${m} file${m > 1 ? "s" : ""} with '${this.replace.value}'?\n\nFiles open in the editor are changed there (Ctrl+Z to undo); other files are saved directly.`,
      { title: "Replace All", kind: "warning", okLabel: "Replace", cancelLabel: "Cancel" },
    );
    if (!ok) return;
    // Exactly the matches shown (dismissed results are skipped).
    await this.replaceTargets(this.files.map((f) => ({ path: f.path, matches: f.matches.map((x) => [x.line, x.start_col] as [number, number]) })));
  }

  // ------------------------------------------------------------ rendering

  private toggleCollapseAll() {
    const allCollapsed = this.files.length > 0 && this.files.every((f) => this.collapsed.has(f.path));
    if (allCollapsed) this.collapsed.clear();
    else this.files.forEach((f) => this.collapsed.add(f.path));
    this.render();
  }

  private renderSummary() {
    let text = "";
    if (this.searching) text = "Searching…";
    else if (this.error) text = this.error;
    else if (!this.query.value) text = settings.session.folder || settings.search.onlyOpenEditors ? "" : "Open a folder to search in files.";
    else if (!this.total) text = "No results found. Review the files to include/exclude and your .gitignore files.";
    else {
      const t = this.total;
      const f = this.files.length;
      text = `${t}${this.truncated ? "+" : ""} result${t > 1 ? "s" : ""} in ${f} file${f > 1 ? "s" : ""}${this.truncated ? " — result limit reached, narrow your search" : ""}`;
    }
    this.summary.textContent = text;
    this.summary.style.display = text ? "" : "none";
    this.summary.classList.toggle("error", !!this.error);
  }

  render() {
    this.renderSummary();
    const allCollapsed = this.files.length > 0 && this.files.every((f) => this.collapsed.has(f.path));
    this.collapseBtn.title = allCollapsed ? "Expand All" : "Collapse All";
    this.collapseBtn.replaceChildren(icon(allCollapsed ? "expandAll" : "collapse"));

    const root = settings.session.folder;
    const showReplace = settings.search.showReplace;
    const re = showReplace ? buildRegExp(this.opts) : null;
    const rows: HTMLElement[] = [];
    for (const file of this.files) {
      const closed = this.collapsed.has(file.path);
      const dir = dirname(file.path);
      const head = h(
        "div",
        { class: "tree-row search-file", title: file.path },
        icon(closed ? "chevronRight" : "chevronDown", "twistie"),
        fileIcon(basename(file.path)),
        h("span", { class: "tree-label", text: basename(file.path) }),
        h("span", { class: "tree-desc", text: root && samePath(dir, root) ? "" : relativePath(root, dir) }),
        h(
          "span",
          { class: "row-actions" },
          showReplace ? this.rowAction("replaceAll", "Replace All in File", () => this.replaceTargets([{ path: file.path, matches: file.matches.map((x) => [x.line, x.start_col]) }])) : null,
          this.rowAction("close", "Dismiss", () => this.dismiss(file)),
        ),
        h("span", { class: "badge", text: String(file.matches.length) }),
      );
      head.addEventListener("click", () => {
        if (closed) this.collapsed.delete(file.path);
        else this.collapsed.add(file.path);
        this.render();
      });
      rows.push(head);
      if (!closed) for (const m of file.matches) rows.push(this.matchRow(file, m, re));
    }
    const scroll = this.results.scrollTop;
    this.results.replaceChildren(...rows);
    this.results.scrollTop = scroll;
  }

  private rowAction(name: keyof typeof icons, title: string, fn: () => void) {
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

  private matchRow(file: FileMatches, m: LineMatch, re: RegExp | null) {
    const p = m.preview;
    const before = p.slice(0, m.preview_start);
    const matched = p.slice(m.preview_start, m.preview_end);
    const after = p.slice(m.preview_end);
    // Keep the match visible: shorten long text before it.
    const parts: (Node | string)[] = [before.length > 30 ? "…" + before.slice(-30) : before];
    if (re) {
      re.lastIndex = 0;
      const mm = re.exec(matched) ?? (Object.assign([matched], { index: 0, input: matched }) as unknown as RegExpExecArray);
      const replacement = expandReplacement(mm, this.replace.value, settings.search.isRegex, settings.search.preserveCase);
      parts.push(h("del", { text: matched }), h("ins", { text: replacement }));
    } else {
      parts.push(h("mark", { text: matched }));
    }
    parts.push(after);
    const row = h(
      "div",
      { class: "tree-row search-match", title: `Line ${m.line}: ${p}` },
      h("span", { class: "match-text" }, ...parts),
      h(
        "span",
        { class: "row-actions" },
        re ? this.rowAction("replace", "Replace", () => this.replaceTargets([{ path: file.path, matches: [[m.line, m.start_col]] }])) : null,
        this.rowAction("close", "Dismiss", () => this.dismiss(file, m)),
      ),
    );
    row.addEventListener("click", () => {
      const untitled = editors.docs.find((d) => !d.path && d.title === file.path);
      if (untitled) {
        editors.activate(untitled);
        editors.editor.setSelection({ startLineNumber: m.line, startColumn: m.start_col, endLineNumber: m.line, endColumn: m.end_col });
        editors.editor.revealLineInCenterIfOutsideViewport(m.line);
        editors.editor.focus();
      } else {
        editors.open(file.path, { line: m.line, column: m.start_col, endColumn: m.end_col });
      }
    });
    return row;
  }

  /** Remove a file (or a single match) from the results without re-searching. */
  private dismiss(file: FileMatches, m?: LineMatch) {
    if (m) file.matches = file.matches.filter((x) => x !== m);
    if (!m || !file.matches.length) this.files = this.files.filter((f) => f !== file);
    this.total = this.files.reduce((n, f) => n + f.matches.length, 0);
    this.render();
  }
}
