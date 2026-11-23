// Documents, tabs and the single Monaco editor instance.
import { message, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { monaco, languageForPath } from "./monaco-setup";
import { api, basename, dirname, errorMessage, samePath } from "./api";
import { settings } from "./settings";
import { extractSymbols, type Sym } from "./symbols";
import { isRemote, remotePath } from "./remote";
import { fileIcon, onIconThemeChange } from "./file-icons";
import { h, icon } from "./ui/dom";
import { showMenu } from "./ui/menu";

/** Monaco URI for a local path or an ssh://host/path remote path. */
export function uriFor(path: string): monaco.Uri {
  return isRemote(path) ? monaco.Uri.parse(path) : monaco.Uri.file(path);
}

export interface Doc {
  uri: monaco.Uri;
  path: string | null;
  title: string;
  model: monaco.editor.ITextModel;
  viewState: monaco.editor.ICodeEditorViewState | null;
  encoding: string;
  savedVersion: number;
}

export interface RevealOptions {
  line?: number;
  column?: number;
  endColumn?: number;
  focus?: boolean;
}

type Listener = () => void;

class EditorManager {
  editor!: monaco.editor.IStandaloneCodeEditor;
  docs: Doc[] = [];
  active: Doc | null = null;
  private untitled = 0;
  private listeners: { active: Listener[]; content: Listener[]; cursor: Listener[]; docs: Listener[] } = {
    active: [],
    content: [],
    cursor: [],
    docs: [],
  };
  private tabsEl!: HTMLElement;
  private hostEl!: HTMLElement;
  private welcomeEl!: HTMLElement;
  private symbolCache = new WeakMap<monaco.editor.ITextModel, { version: number; lang: string; syms: Sym[] }>();

  init(host: HTMLElement, tabs: HTMLElement, welcome: HTMLElement) {
    this.hostEl = host;
    this.tabsEl = tabs;
    this.welcomeEl = welcome;
    this.editor = monaco.editor.create(host, {
      model: null,
      automaticLayout: true,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      wordWrap: settings.wordWrap ? "on" : "off",
      renderWhitespace: settings.renderWhitespace ? "all" : "selection",
      renderControlCharacters: true,
      minimap: { enabled: settings.minimap },
      mouseWheelZoom: true,
      smoothScrolling: true,
      cursorSmoothCaretAnimation: "on",
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: "active", indentation: true },
      fixedOverflowWidgets: true,
      stickyScroll: { enabled: true },
      unicodeHighlight: { ambiguousCharacters: false },
      tabSize: settings.tabSize,
      insertSpaces: settings.insertSpaces,
    });
    this.editor.onDidChangeModelContent(() => {
      this.renderTabs();
      this.emit("content");
    });
    this.editor.onDidChangeModelLanguage(() => this.emit("active"));
    this.editor.onDidChangeCursorPosition(() => this.emit("cursor"));
    this.editor.onDidChangeCursorSelection(() => this.emit("cursor"));

    // Open other files from "Go to Definition" / peek results.
    monaco.editor.registerEditorOpener({
      openCodeEditor: (_source, resource, selectionOrPosition) => {
        const doc = this.docs.find((d) => d.uri.toString() === resource.toString());
        const path = doc?.path ?? (resource.scheme === "file" ? resource.fsPath : resource.scheme === "ssh" ? remotePath(resource.authority, resource.path) : null);
        if (!path) return false;
        const pos = selectionOrPosition as any;
        this.open(path, pos ? { line: pos.startLineNumber ?? pos.lineNumber, column: pos.startColumn ?? pos.column } : {});
        return true;
      },
    });
    this.updateVisibility();
    onIconThemeChange(() => this.renderTabs());
  }

  private savedListeners: ((path: string) => void)[] = [];

  /** Called after a file was written to disk. */
  onSaved(l: (path: string) => void) {
    this.savedListeners.push(l);
  }

  on(event: keyof EditorManager["listeners"], l: Listener) {
    this.listeners[event].push(l);
  }

  private emit(event: keyof EditorManager["listeners"]) {
    this.listeners[event].forEach((l) => l());
  }

  isDirty(doc: Doc) {
    return doc.model.getAlternativeVersionId() !== doc.savedVersion;
  }

  get dirtyDocs() {
    return this.docs.filter((d) => this.isDirty(d));
  }

  findByPath(path: string) {
    return this.docs.find((d) => d.path && samePath(d.path, path));
  }

  /** Get (or create) a Monaco model for a file without opening a tab. */
  async ensureModel(path: string): Promise<monaco.editor.ITextModel> {
    const uri = uriFor(path);
    const existing = monaco.editor.getModel(uri);
    if (existing) return existing;
    const file = await api.readTextFile(path);
    return monaco.editor.createModel(file.content, languageForPath(path), uri);
  }

  async open(path: string, reveal: RevealOptions = {}): Promise<Doc | null> {
    let doc = this.findByPath(path);
    if (!doc) {
      let file;
      try {
        file = await api.readTextFile(path);
      } catch (e) {
        await message(`Cannot open ${path}\n\n${errorMessage(e)}`, { title: "Taara Editor", kind: "error" });
        return null;
      }
      // Another await may have opened it meanwhile.
      doc = this.findByPath(path);
      if (!doc) {
        const uri = uriFor(path);
        let model = monaco.editor.getModel(uri);
        if (model) model.setValue(file.content);
        else model = monaco.editor.createModel(file.content, languageForPath(path), uri);
        doc = {
          uri,
          path,
          title: basename(path),
          model,
          viewState: null,
          encoding: file.encoding,
          savedVersion: model.getAlternativeVersionId(),
        };
        this.docs.push(doc);
        this.emit("docs");
      }
    }
    this.activate(doc);
    if (reveal.line) {
      const line = reveal.line;
      const col = reveal.column ?? 1;
      const range = new monaco.Range(line, col, line, reveal.endColumn ?? col);
      this.editor.setSelection(range);
      this.editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Immediate);
    }
    if (reveal.focus !== false) this.editor.focus();
    return doc;
  }

  newUntitled(language = "plaintext") {
    const n = ++this.untitled;
    const uri = monaco.Uri.from({ scheme: "untitled", path: `Untitled-${n}` });
    const model = monaco.editor.createModel("", language, uri);
    const doc: Doc = { uri, path: null, title: `Untitled-${n}`, model, viewState: null, encoding: "utf-8", savedVersion: model.getAlternativeVersionId() };
    this.docs.push(doc);
    this.emit("docs");
    this.activate(doc);
    this.editor.focus();
    return doc;
  }

  activate(doc: Doc) {
    if (this.active === doc) return;
    if (this.active) this.active.viewState = this.editor.saveViewState();
    this.active = doc;
    this.editor.setModel(doc.model);
    if (doc.viewState) this.editor.restoreViewState(doc.viewState);
    this.updateVisibility();
    this.renderTabs();
    this.emit("active");
    this.emit("cursor");
  }

  activateIndex(i: number) {
    const doc = this.docs[i];
    if (doc) this.activate(doc);
  }

  cycle(delta: number) {
    if (!this.active || this.docs.length < 2) return;
    const i = this.docs.indexOf(this.active);
    this.activate(this.docs[(i + delta + this.docs.length) % this.docs.length]);
  }

  /** Ask to save a dirty doc. Returns false if the user cancelled. */
  private async confirmSave(doc: Doc): Promise<boolean> {
    if (!this.isDirty(doc)) return true;
    const answer = await message(`Do you want to save the changes you made to ${doc.title}?\n\nYour changes will be lost if you don't save them.`, {
      title: "Taara Editor",
      kind: "warning",
      buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
    });
    if (answer === "Save" || answer === "Yes") return this.save(doc);
    return answer === "Don't Save" || answer === "No";
  }

  async close(doc: Doc | null = this.active): Promise<boolean> {
    if (!doc) return true;
    if (!(await this.confirmSave(doc))) return false;
    const i = this.docs.indexOf(doc);
    this.docs.splice(i, 1);
    if (this.active === doc) {
      this.active = null;
      const next = this.docs[Math.min(i, this.docs.length - 1)];
      if (next) this.activate(next);
      else {
        this.editor.setModel(null);
        this.updateVisibility();
        this.emit("active");
      }
    }
    doc.model.dispose();
    this.renderTabs();
    this.emit("docs");
    return true;
  }

  async closeOthers(keep: Doc) {
    for (const d of [...this.docs]) if (d !== keep && !(await this.close(d))) return false;
    return true;
  }

  async closeAll(): Promise<boolean> {
    for (const d of [...this.docs]) if (!(await this.close(d))) return false;
    return true;
  }

  /** Confirm all unsaved changes (used before quitting). */
  async confirmAll(): Promise<boolean> {
    for (const d of this.dirtyDocs) {
      this.activate(d);
      if (!(await this.confirmSave(d))) return false;
    }
    return true;
  }

  async save(doc: Doc | null = this.active): Promise<boolean> {
    if (!doc) return false;
    if (!doc.path) return this.saveAs(doc);
    try {
      await api.writeTextFile(doc.path, doc.model.getValue(), doc.encoding);
      doc.savedVersion = doc.model.getAlternativeVersionId();
      const saved = doc.path;
      this.savedListeners.forEach((l) => l(saved));
      this.renderTabs();
      this.emit("content");
      return true;
    } catch (e) {
      await message(`Failed to save ${doc.path}\n\n${errorMessage(e)}`, { title: "Taara Editor", kind: "error" });
      return false;
    }
  }

  async saveAs(doc: Doc | null = this.active): Promise<boolean> {
    if (!doc) return false;
    const target = await saveDialog({
      defaultPath: doc.path ?? (settings.session.folder ? `${settings.session.folder}\\${doc.title}` : doc.title),
    });
    if (!target) return false;
    if (doc.path && samePath(doc.path, target)) return this.save(doc);
    const other = this.findByPath(target);
    if (other && other !== doc) await this.close(other);

    // Re-home the content in a model with the new URI / language.
    const uri = uriFor(target);
    monaco.editor.getModel(uri)?.dispose();
    const model = monaco.editor.createModel(doc.model.getValue(), languageForPath(target), uri);
    const old = doc.model;
    const wasActive = this.active === doc;
    const view = wasActive ? this.editor.saveViewState() : doc.viewState;
    Object.assign(doc, { uri, path: target, title: basename(target), model, viewState: view });
    if (wasActive) {
      this.editor.setModel(model);
      if (view) this.editor.restoreViewState(view);
    }
    old.dispose();
    doc.savedVersion = -1;
    const ok = await this.save(doc);
    this.emit("active");
    this.emit("docs");
    return ok;
  }

  async saveAll() {
    for (const d of this.dirtyDocs) if (!(await this.save(d))) return;
  }

  /** Re-key open docs after a file/folder was renamed in the explorer. */
  async onPathRenamed(from: string, to: string) {
    for (const d of this.docs) {
      if (!d.path) continue;
      const low = d.path.toLowerCase();
      const f = from.toLowerCase();
      if (low === f || low.startsWith(f + "\\") || low.startsWith(f + "/")) {
        const target = to + d.path.slice(from.length);
        const uri = uriFor(target);
        const model = monaco.editor.createModel(d.model.getValue(), languageForPath(target), uri);
        const dirty = this.isDirty(d);
        const old = d.model;
        const view = this.active === d ? this.editor.saveViewState() : d.viewState;
        Object.assign(d, { uri, path: target, title: basename(target), model, viewState: view });
        d.savedVersion = dirty ? -1 : model.getAlternativeVersionId();
        if (this.active === d) {
          this.editor.setModel(model);
          if (view) this.editor.restoreViewState(view);
        }
        old.dispose();
      }
    }
    this.renderTabs();
    this.emit("active");
  }

  symbols(model: monaco.editor.ITextModel | null | undefined = this.active?.model): Sym[] {
    if (!model || model.isDisposed()) return [];
    const version = model.getVersionId();
    const lang = model.getLanguageId();
    const cached = this.symbolCache.get(model);
    if (cached && cached.version === version && cached.lang === lang) return cached.syms;
    const syms = model.getValueLength() > 5_000_000 ? [] : extractSymbols(model.getValue(), lang);
    this.symbolCache.set(model, { version, lang, syms });
    return syms;
  }

  updateOptions(opts: monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions) {
    this.editor.updateOptions(opts);
  }

  private updateVisibility() {
    const empty = !this.active;
    this.hostEl.style.display = empty ? "none" : "";
    this.tabsEl.style.display = empty ? "none" : "";
    this.welcomeEl.style.display = empty ? "" : "none";
    document.getElementById("breadcrumb")!.style.display = empty ? "none" : "";
  }

  renderTabs() {
    // Disambiguate identical file names with their parent folder.
    const counts = new Map<string, number>();
    this.docs.forEach((d) => counts.set(d.title, (counts.get(d.title) ?? 0) + 1));
    this.tabsEl.replaceChildren(
      ...this.docs.map((doc, i) => {
        const dirty = this.isDirty(doc);
        const tab = h(
          "div",
          {
            class: `tab${doc === this.active ? " active" : ""}${dirty ? " dirty" : ""}`,
            title: doc.path ?? doc.title,
            draggable: "true",
          },
          fileIcon(doc.title),
          h("span", { class: "tab-label", text: doc.title }),
          (counts.get(doc.title) ?? 0) > 1 && doc.path ? h("span", { class: "tab-desc", text: basename(dirname(doc.path)) }) : null,
          h(
            "span",
            {
              class: "tab-close",
              title: "Close (Ctrl+W)",
              onclick: (e: Event) => {
                e.stopPropagation();
                this.close(doc);
              },
            },
            icon("close"),
          ),
        );
        tab.addEventListener("mousedown", (e) => {
          if (e.button === 0) this.activate(doc);
        });
        tab.addEventListener("auxclick", (e) => {
          if (e.button === 1) this.close(doc);
        });
        tab.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          showMenu(
            [
              { label: "Close", shortcut: "Ctrl+W", action: () => this.close(doc) },
              { label: "Close Others", action: () => this.closeOthers(doc) },
              { label: "Close All", action: () => this.closeAll() },
              "-",
              { label: "Copy Path", disabled: !doc.path, action: () => navigator.clipboard.writeText(doc.path!) },
            ],
            e.clientX,
            e.clientY,
          );
        });
        // Drag to reorder.
        tab.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/x-taara-tab", String(i)));
        tab.addEventListener("dragover", (e) => e.preventDefault());
        tab.addEventListener("drop", (e) => {
          const from = Number(e.dataTransfer?.getData("text/x-taara-tab"));
          if (Number.isNaN(from) || from === i) return;
          e.preventDefault();
          const [moved] = this.docs.splice(from, 1);
          this.docs.splice(i, 0, moved);
          this.renderTabs();
        });
        return tab;
      }),
    );
    this.tabsEl.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

export const editors = new EditorManager();
