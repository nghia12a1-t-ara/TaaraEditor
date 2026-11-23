// Function List panel (right side).
import { editors } from "../editor-manager";
import { symbolAt, type Sym, type SymbolKind } from "../symbols";
import { h, icon } from "./dom";

const kindBadge: Record<SymbolKind, string> = {
  function: "ƒ",
  method: "m",
  class: "C",
  struct: "S",
  enum: "E",
  union: "U",
  typedef: "T",
  macro: "#",
  namespace: "N",
  label: "L",
  trait: "T",
  module: "M",
};

export class Outline {
  readonly el: HTMLElement;
  private list = h("div", { class: "outline-list" });
  private filter = h("input", { class: "input", placeholder: "Filter symbols", spellcheck: "false" });
  private timer: number | undefined;
  private syms: Sym[] = [];

  constructor(host: HTMLElement, private onClose: () => void) {
    this.el = host;
    this.filter.addEventListener("input", () => this.render());
    this.filter.addEventListener("keydown", (e) => {
      if (e.key === "Enter") (this.list.querySelector(".tree-row") as HTMLElement | null)?.click();
      if (e.key === "Escape") editors.editor.focus();
    });
    host.append(
      h(
        "div",
        { class: "view-header" },
        h("span", { class: "view-title", text: "FUNCTION LIST" }),
        h("div", { class: "view-actions" }, h("button", { class: "icon-button", title: "Close", onclick: () => this.onClose() }, icon("close"))),
      ),
      h("div", { class: "search-box" }, this.filter),
      this.list,
    );
    editors.on("active", () => this.refresh());
    editors.on("content", () => this.schedule());
    editors.on("cursor", () => this.markCurrent());
  }

  private schedule() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), 400);
  }

  refresh() {
    if (this.el.style.display === "none") return;
    this.syms = editors.symbols();
    this.render();
  }

  private render() {
    const q = this.filter.value.toLowerCase();
    const shown = this.syms.filter((s) => !q || s.name.toLowerCase().includes(q));
    this.list.replaceChildren(
      ...shown.map((s) => {
        const row = h(
          "div",
          { class: "tree-row", title: `${s.kind} ${s.name} (line ${s.line})`, dataset: { line: String(s.line) } },
          h("span", { class: `sym-badge sym-${s.kind}`, text: kindBadge[s.kind] }),
          h("span", { class: "tree-label", text: s.name }),
          h("span", { class: "tree-desc", text: String(s.line) }),
        );
        row.addEventListener("click", () => {
          const doc = editors.active;
          if (doc?.path) editors.open(doc.path, { line: s.line, column: s.column, endColumn: s.column + s.name.length });
          else if (doc) {
            editors.editor.setSelection({ startLineNumber: s.line, startColumn: s.column, endLineNumber: s.line, endColumn: s.column + s.name.length });
            editors.editor.revealLineInCenter(s.line);
            editors.editor.focus();
          }
        });
        return row;
      }),
    );
    if (!shown.length) this.list.append(h("div", { class: "view-empty muted", text: editors.active ? "No symbols found." : "No file open." }));
    this.markCurrent();
  }

  private markCurrent() {
    if (this.el.style.display === "none") return;
    const line = editors.editor.getPosition()?.lineNumber ?? 0;
    const cur = symbolAt(this.syms, line);
    this.list.querySelectorAll(".tree-row.active").forEach((r) => r.classList.remove("active"));
    if (cur) {
      const row = this.list.querySelector<HTMLElement>(`.tree-row[data-line="${cur.line}"]`);
      row?.classList.add("active");
      row?.scrollIntoView({ block: "nearest" });
    }
  }

  focusFilter() {
    this.filter.focus();
    this.filter.select();
  }
}
