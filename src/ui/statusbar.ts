// Status bar + breadcrumb.
import { monaco, languageName } from "../monaco-setup";
import { relativePath } from "../api";
import { editors } from "../editor-manager";
import { saveSettings, settings } from "../settings";
import { symbolAt } from "../symbols";
import { h } from "./dom";
import { onProblemsChanged, problemCounts } from "../problems";
import { showQuickPick } from "./quickpick";

const ENCODINGS: [string, string][] = [
  ["utf-8", "UTF-8"],
  ["utf-8-bom", "UTF-8 with BOM"],
  ["utf-16le", "UTF-16 LE"],
  ["utf-16be", "UTF-16 BE"],
  ["windows-1252", "Western (Windows 1252)"],
];

export class StatusBar {
  private left = h("div", { class: "status-left" });
  private index: { text: string; title: string; onClick?: () => void } = { text: "", title: "" };

  private clangd: { text: string; title: string; onClick?: () => void; cls: string } = { text: "", title: "", cls: "" };
  private problemsClick: () => void = () => {};

  setIndexStatus(text: string, title: string, onClick?: () => void) {
    this.index = { text, title, onClick };
    this.render();
  }

  setClangdStatus(text: string, title: string, cls: string, onClick?: () => void) {
    this.clangd = { text, title, onClick, cls };
    this.render();
  }

  private build: { text: string; title: string; cls: string; onClick?: () => void } = { text: "", title: "", cls: "" };

  private remote: { text: string; title: string; cls: string; onClick?: () => void } = { text: "", title: "", cls: "" };
  private remoteClick: () => void = () => {};

  setRemote(text: string, title: string, cls: string) {
    this.remote = { text, title, cls, onClick: () => this.remoteClick() };
    this.render();
  }

  onRemoteClick(fn: () => void) {
    this.remoteClick = fn;
  }

  private gitInfo = { branch: "", title: "", sync: "", syncTitle: "" };
  private gitBranchClick: () => void = () => {};
  private gitSyncClick: () => void = () => {};

  setGit(branch: string, title: string, sync: string, syncTitle: string) {
    this.gitInfo = { branch, title, sync, syncTitle };
    this.render();
  }

  onGitClick(branch: () => void, sync: () => void) {
    this.gitBranchClick = branch;
    this.gitSyncClick = sync;
  }

  private update: { text: string; title: string; cls: string; onClick?: () => void } = { text: "", title: "", cls: "" };

  setUpdateStatus(text: string, title: string, cls: string, onClick?: () => void) {
    this.update = { text, title, cls, onClick };
    this.render();
  }

  setBuildStatus(text: string, title: string, cls: string, onClick?: () => void) {
    this.build = { text, title, cls, onClick };
    this.render();
  }

  onProblemsClick(fn: () => void) {
    this.problemsClick = fn;
  }

  private problems() {
    const { errors, warnings } = problemCounts();
    const b = this.item(`⊗ ${errors}  ⚠ ${warnings}`, "Problems: click to show the Problems panel", () => this.problemsClick());
    b.classList.toggle("has-errors", errors > 0);
    return b;
  }
  private right = h("div", { class: "status-right" });

  constructor(host: HTMLElement, private breadcrumb: HTMLElement) {
    host.append(this.left, this.right);
    const update = () => this.render();
    editors.on("active", update);
    editors.on("cursor", update);
    editors.on("content", update);
    onProblemsChanged(update);
  }

  private item(text: string, title: string, onClick?: () => void) {
    return h("button", { class: `status-item${onClick ? " clickable" : ""}`, title, text, onclick: onClick });
  }

  render() {
    const doc = editors.active;
    const folder = settings.session.folder;
    this.left.replaceChildren(
      // VS Code-style remote indicator at the far left.
      ...(this.remote.text ? [Object.assign(this.item(this.remote.text, this.remote.title, this.remote.onClick), { className: `status-item clickable remote-indicator ${this.remote.cls}` })] : []),
      folder ? this.item(`📁 ${folder.split(/[\\/]/).filter(Boolean).pop()}`, folder) : this.item("No folder", ""),
      ...(this.gitInfo.branch ? [this.item(this.gitInfo.branch, this.gitInfo.title, () => this.gitBranchClick()), this.item(this.gitInfo.sync, this.gitInfo.syncTitle, () => this.gitSyncClick())] : []),
      ...(this.index.text ? [this.item(`⚡ ${this.index.text}`, this.index.title, this.index.onClick)] : []),
      ...(this.clangd.text ? [Object.assign(this.item(this.clangd.text, this.clangd.title, this.clangd.onClick), { className: `status-item clickable ${this.clangd.cls}` })] : []),
      this.problems(),
      ...(this.build.text ? [Object.assign(this.item(this.build.text, this.build.title, this.build.onClick), { className: `status-item clickable ${this.build.cls}` })] : []),
      ...(this.update.text ? [Object.assign(this.item(this.update.text, this.update.title, this.update.onClick), { className: `status-item${this.update.onClick ? " clickable" : ""} ${this.update.cls}` })] : []),
    );
    if (!doc) {
      this.right.replaceChildren();
      this.breadcrumb.replaceChildren();
      return;
    }
    const ed = editors.editor;
    const pos = ed.getPosition();
    const sel = ed.getSelection();
    const selLen = sel && !sel.isEmpty() ? doc.model.getValueLengthInRange(sel) : 0;
    const opts = doc.model.getOptions();
    const eol = doc.model.getEOL() === "\r\n" ? "CRLF" : "LF";
    this.right.replaceChildren(
      this.item(`Ln ${pos?.lineNumber ?? 1}, Col ${pos?.column ?? 1}${selLen ? ` (${selLen} selected)` : ""}`, "Go to Line (Ctrl+G)", () => {
        ed.focus();
        ed.trigger("statusbar", "editor.action.gotoLine", null);
      }),
      this.item(opts.insertSpaces ? `Spaces: ${opts.tabSize}` : `Tab Size: ${opts.tabSize}`, "Select Indentation", () => this.pickIndent()),
      this.item(ENCODINGS.find((e) => e[0] === doc.encoding)?.[1] ?? doc.encoding, "Select Encoding (used when saving)", () => this.pickEncoding()),
      this.item(eol, "Select End of Line Sequence", () => {
        doc.model.pushEOL(eol === "CRLF" ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF);
        this.render();
      }),
      this.item(languageName(doc.model.getLanguageId()), "Select Language Mode", () => this.pickLanguage()),
    );
    this.renderBreadcrumb();
  }

  private renderBreadcrumb() {
    const doc = editors.active;
    if (!doc) return;
    const rel = doc.path ? relativePath(settings.session.folder, doc.path) : doc.title;
    const parts = rel.split(/[\\/]/);
    const line = editors.editor.getPosition()?.lineNumber ?? 1;
    const sym = symbolAt(editors.symbols(), line);
    const crumbs: HTMLElement[] = [];
    parts.forEach((p, i) => {
      if (i) crumbs.push(h("span", { class: "crumb-sep", text: "›" }));
      crumbs.push(h("span", { class: i === parts.length - 1 ? "crumb file" : "crumb", text: p }));
    });
    if (sym) {
      crumbs.push(h("span", { class: "crumb-sep", text: "›" }));
      const c = h("span", { class: "crumb symbol", text: sym.name, title: "Go to symbol" });
      c.addEventListener("click", () => {
        editors.editor.revealLineInCenter(sym.line);
        editors.editor.setPosition({ lineNumber: sym.line, column: sym.column });
        editors.editor.focus();
      });
      crumbs.push(c);
    }
    this.breadcrumb.replaceChildren(...crumbs);
  }

  async pickLanguage() {
    const doc = editors.active;
    if (!doc) return;
    const langs = monaco.languages.getLanguages().map((l) => ({
      label: l.aliases?.[0] ?? l.id,
      description: `(${l.id})`,
      value: l.id,
    }));
    langs.sort((a, b) => a.label.localeCompare(b.label));
    const id = await showQuickPick(langs, { placeholder: "Select Language Mode" });
    if (id) {
      monaco.editor.setModelLanguage(doc.model, id);
      this.render();
    }
  }

  private async pickEncoding() {
    const doc = editors.active;
    if (!doc) return;
    const enc = await showQuickPick(
      ENCODINGS.map(([value, label]) => ({ label, description: value === doc.encoding ? "current" : "", value })),
      { placeholder: "Select encoding to use when saving" },
    );
    if (enc && enc !== doc.encoding) {
      doc.encoding = enc;
      doc.savedVersion = -1; // must be saved to take effect
      editors.renderTabs();
      this.render();
    }
  }

  private async pickIndent() {
    const doc = editors.active;
    if (!doc) return;
    const items = [
      ...[2, 4, 8].map((n) => ({ label: `Indent Using Spaces: ${n}`, value: `s${n}` })),
      ...[2, 4, 8].map((n) => ({ label: `Indent Using Tabs: ${n}`, value: `t${n}` })),
      { label: "Convert Indentation to Spaces", value: "toSpaces" },
      { label: "Convert Indentation to Tabs", value: "toTabs" },
    ];
    const v = await showQuickPick(items, { placeholder: "Select indentation" });
    if (!v) return;
    if (v === "toSpaces") editors.editor.trigger("statusbar", "editor.action.indentationToSpaces", null);
    else if (v === "toTabs") editors.editor.trigger("statusbar", "editor.action.indentationToTabs", null);
    else {
      const insertSpaces = v[0] === "s";
      const tabSize = Number(v.slice(1));
      doc.model.updateOptions({ insertSpaces, tabSize });
      settings.insertSpaces = insertSpaces;
      settings.tabSize = tabSize;
      saveSettings();
    }
    this.render();
  }
}
