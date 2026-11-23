// "Run and Debug" side bar view + floating debug toolbar.
import { basename } from "../api";
import * as dbg from "../debug";
import { editors } from "../editor-manager";
import { settings } from "../settings";
import { h, icon } from "./dom";
import { showInputBox } from "./quickpick";

export interface DebugActions {
  start: () => void;
  stop: () => void;
  restart: () => void;
  configure: () => void;
}

export class DebugView {
  readonly el = h("div", { class: "view debug-view" });
  private body = h("div", { class: "debug-sections" });
  private expanded = new Map<string, dbg.Variable[]>();
  private collapsedSections = new Set<string>();

  constructor(private actions: DebugActions) {
    this.el.append(
      h(
        "div",
        { class: "view-header" },
        h("span", { class: "view-title", text: "RUN AND DEBUG" }),
        h("div", { class: "view-actions" }, h("button", { class: "icon-button", title: "Configure (.taara/tasks.json)", onclick: () => actions.configure() }, icon("excludeSettings"))),
      ),
      this.body,
    );
    dbg.onDebugChange(() => {
      if (dbg.debugState() !== "stopped") this.expanded.clear();
      this.render();
    });
    this.render();
  }

  render() {
    const st = dbg.debugState();
    const parts: HTMLElement[] = [];
    if (st === "inactive") {
      parts.push(
        h(
          "div",
          { class: "debug-start" },
          h("button", { class: "button debug-start-button", onclick: () => this.actions.start() }, icon("play"), " Start Debugging"),
          h("p", { class: "muted", text: "F5 builds the project, starts the GDB server (ST-LINK or OpenOCD), loads the program and stops at main()." }),
          h("a", { class: "link", text: "Configure the debugger…", onclick: () => this.actions.configure() }),
        ),
      );
    } else {
      parts.push(h("div", { class: "debug-status", text: st === "starting" ? "Starting…" : st === "running" ? "Running" : `Paused on ${dbg.lastStopReason()}` }));
    }
    parts.push(this.section("VARIABLES", () => this.variablesSection()));
    parts.push(this.section("WATCH", () => this.watchSection(), h("button", { class: "icon-button", title: "Add Expression", onclick: (e: Event) => (e.stopPropagation(), this.addWatch()) }, icon("add"))));
    parts.push(this.section("CALL STACK", () => this.stackSection()));
    parts.push(
      this.section(
        "BREAKPOINTS",
        () => this.breakpointsSection(),
        h("button", { class: "icon-button", title: "Remove All Breakpoints", onclick: (e: Event) => (e.stopPropagation(), dbg.removeAllBreakpoints()) }, icon("clearAll")),
      ),
    );
    this.body.replaceChildren(...parts);
  }

  private section(title: string, content: () => HTMLElement[], action?: HTMLElement) {
    const closed = this.collapsedSections.has(title);
    const head = h("div", { class: "debug-section-head" }, icon(closed ? "chevronRight" : "chevronDown", "twistie"), h("span", { text: title }), h("span", { class: "spacer" }), action ?? null);
    head.addEventListener("click", () => {
      if (closed) this.collapsedSections.delete(title);
      else this.collapsedSections.add(title);
      this.render();
    });
    return h("div", { class: "debug-section" }, head, closed ? null : h("div", { class: "debug-section-body" }, ...content()));
  }

  private empty(text: string) {
    return [h("div", { class: "debug-empty muted", text })];
  }

  private variablesSection(): HTMLElement[] {
    if (dbg.debugState() !== "stopped") return this.empty(dbg.debugState() === "running" ? "Running…" : "Not paused.");
    const vars = dbg.localVariables();
    if (!vars.length) return this.empty("No local variables.");
    return vars.flatMap((v) => this.variableRows(v, 0, v.name));
  }

  private variableRows(v: dbg.Variable, depth: number, key: string): HTMLElement[] {
    const open = this.expanded.get(key);
    const row = h(
      "div",
      { class: "tree-row var-row", style: { paddingLeft: `${8 + depth * 12}px` }, title: `${v.type ?? ""} ${v.name} = ${v.value}` },
      v.expandable ? icon(open ? "chevronDown" : "chevronRight", "twistie") : h("span", { class: "twistie" }),
      h("span", { class: "var-name", text: v.name }),
      h("span", { class: "var-sep", text: ": " }),
      h("span", { class: "var-value", text: v.value }),
    );
    row.addEventListener("click", async () => {
      if (!v.expandable) return;
      if (open) this.expanded.delete(key);
      else this.expanded.set(key, await dbg.expandVariable(v));
      this.render();
    });
    row.addEventListener("dblclick", async (e) => {
      if (v.expandable) return;
      e.stopPropagation();
      const value = await showInputBox({ prompt: `Set value of ${v.name}`, value: v.value });
      if (value !== null) await dbg.setVariable(v, value);
    });
    const rows: HTMLElement[] = [row];
    if (open) for (const c of open) rows.push(...this.variableRows(c, depth + 1, `${key}.${c.name}`));
    return rows;
  }

  private watchSection(): HTMLElement[] {
    if (!settings.watch.length) return this.empty("No watch expressions. Click + to add one.");
    const values = dbg.watchResults();
    return settings.watch.map((w) =>
      h(
        "div",
        { class: "tree-row var-row", title: w },
        h("span", { class: "twistie" }),
        h("span", { class: "var-name", text: w }),
        h("span", { class: "var-sep", text: ": " }),
        h("span", { class: `var-value${(values.get(w) ?? "").startsWith("<") ? " error" : ""}`, text: dbg.debugState() === "stopped" ? (values.get(w) ?? "") : "not available" }),
        h("span", { class: "row-actions" }, h("button", { class: "icon-button", title: "Remove Expression", onclick: (e: Event) => (e.stopPropagation(), dbg.removeWatch(w)) }, icon("close"))),
      ),
    );
  }

  private stackSection(): HTMLElement[] {
    const frames = dbg.callStack();
    if (!frames.length) return this.empty(dbg.debugState() === "inactive" ? "Not debugging." : dbg.debugState() === "running" ? "Running…" : "No stack.");
    return frames.map((f) => {
      const row = h(
        "div",
        { class: `tree-row frame-row${f.level === dbg.currentFrame() ? " active" : ""}`, title: `${f.func} ${f.file ?? f.addr ?? ""}:${f.line ?? ""}` },
        h("span", { class: "frame-func", text: f.func }),
        h("span", { class: "tree-desc", text: f.file ? `${basename(f.file)}:${f.line}` : (f.addr ?? "") }),
      );
      row.addEventListener("click", () => dbg.selectFrame(f.level));
      return row;
    });
  }

  private breakpointsSection(): HTMLElement[] {
    const bps = dbg.allBreakpoints();
    if (!bps.length) return this.empty("Click in the editor margin (or press F9) to add a breakpoint.");
    return bps.map((b) => {
      const line = editors.findByPath(b.path)?.model.getLineContent(b.line)?.trim() ?? "";
      const row = h(
        "div",
        { class: "tree-row bp-row", title: `${b.path}:${b.line}` },
        h("span", { class: "bp-dot" }),
        h("span", { class: "tree-label", text: basename(b.path) }),
        h("span", { class: "tree-desc", text: `${b.line}${line ? "  " + line.slice(0, 40) : ""}` }),
        h("span", { class: "row-actions" }, h("button", { class: "icon-button", title: "Remove Breakpoint", onclick: (e: Event) => (e.stopPropagation(), dbg.removeBreakpoint(b.path, b.line)) }, icon("close"))),
      );
      row.addEventListener("click", () => editors.open(b.path, { line: b.line }));
      return row;
    });
  }

  private async addWatch() {
    const expr = await showInputBox({ prompt: "Expression to watch (e.g. counter, led.state, buf[0], *p)" });
    if (expr) dbg.addWatch(expr);
  }
}

/** VS Code-style floating toolbar shown while debugging. */
export function createDebugToolbar(host: HTMLElement, actions: DebugActions) {
  const bar = h("div", { class: "debug-toolbar" });
  host.append(bar);
  const button = (name: Parameters<typeof icon>[0], title: string, fn: () => void, cls = "") =>
    h("button", { class: `icon-button ${cls}`, title, onmousedown: (e: Event) => e.preventDefault(), onclick: fn }, icon(name));
  const render = () => {
    const st = dbg.debugState();
    bar.style.display = st === "inactive" ? "none" : "";
    const stopped = st === "stopped";
    bar.replaceChildren(
      h("span", { class: "debug-grip", text: "⋮⋮" }),
      stopped ? button("play", "Continue (F5)", () => dbg.continueExecution(), "dbg-continue") : button("pause", "Pause (F6)", () => dbg.pauseExecution(), "dbg-pause"),
      button("stepOver", "Step Over (F10)", () => dbg.stepOver()),
      button("stepInto", "Step Into (F11)", () => dbg.stepInto()),
      button("stepOut", "Step Out (Shift+F11)", () => dbg.stepOut()),
      button("restart", "Restart (Ctrl+Shift+F5)", () => actions.restart(), "dbg-restart"),
      button("stop", "Stop (Shift+F5)", () => actions.stop(), "dbg-stop"),
    );
    bar.querySelectorAll<HTMLButtonElement>(".icon-button").forEach((b, i) => {
      if (i >= 1 && i <= 3) b.disabled = !stopped;
    });
  };
  dbg.onDebugChange(render);
  render();
}
