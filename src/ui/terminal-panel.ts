// Integrated terminal panel (Ctrl+`): xterm.js front end, shells run in a
// pseudo terminal on the Rust side (src-tauri/src/pty.rs).
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api, basename, dirname, relativePath, resolvePath } from "../api";
import { fileIcon } from "../file-icons";
import { allProblems, onProblemsChanged } from "../problems";
import { connect, connections, isRemote, remotePath, splitRemote } from "../remote";
import { editors } from "../editor-manager";
import { saveSettings, settings } from "../settings";
import { onThemeScopes, themeColors } from "../themes";
import { h, icon } from "./dom";
import { showMenu } from "./menu";

export interface ShellInfo {
  name: string;
  path: string;
  args: string[];
}

interface Session {
  key: number;
  ptyId: number | null;
  shell: ShellInfo;
  cwd: string | null;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  exited: boolean;
  /** Set for build / flash tasks run with runTask(). */
  task?: { name: string; resolve: (r: TaskResult) => void };
  /** Remote shell over SSH (instead of a local pseudo terminal). */
  remoteId?: number;
}

export interface TaskResult {
  code: number | null;
  /** Output lines (escape sequences already interpreted, wrapped lines joined). */
  lines: string[];
}

const ANSI_DARK = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5"];
const ANSI_LIGHT = ["#000000", "#cd3131", "#00bc00", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555", "#666666", "#cd3131", "#14ce14", "#b5ba00", "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5"];
const ANSI_KEYS = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"];

/** file.c:12:5, Core/Src/main.c(12), C:\path\x.h:7 ... in terminal output */
const FILE_LINK = /((?:[A-Za-z]:)?[\w.\-\\/]*[\w\-]\.(?:cpp|cxx|cc|c|hpp|hh|h|asm|s|S|ld|mk|py|rs|ts|json|js|txt|cmake|ino))(?![\w])(?:[:(](\d+)(?:[:,](\d+))?\)?)?/g;

function terminalTheme(): ITheme {
  const c = themeColors();
  const css = getComputedStyle(document.documentElement);
  const dark = document.documentElement.dataset.theme !== "light";
  const ansi = dark ? ANSI_DARK : ANSI_LIGHT;
  const t: Record<string, string> = {
    background: c["terminal.background"] ?? c["panel.background"] ?? css.getPropertyValue("--bg").trim(),
    foreground: c["terminal.foreground"] ?? css.getPropertyValue("--fg").trim(),
    cursor: c["terminalCursor.foreground"] ?? c["editorCursor.foreground"] ?? (dark ? "#ffffff" : "#000000"),
    selectionBackground: c["terminal.selectionBackground"] ?? c["editor.selectionBackground"] ?? (dark ? "#264f78" : "#add6ff"),
  };
  ANSI_KEYS.forEach((k, i) => {
    t[k.toLowerCase()] = c[`terminal.ansi${k}`] ?? ansi[i];
    t[`bright${k}`] = c[`terminal.ansiBright${k}`] ?? ansi[i + 8];
  });
  return t as ITheme;
}

export class TerminalPanel {
  private sessions: Session[] = [];
  private active: Session | null = null;
  private shells: ShellInfo[] | null = null;
  private nextKey = 0;
  private tabs = h("div", { class: "panel-tabs" });
  private body = h("div", { class: "panel-body" });
  private problemsEl = h("div", { class: "panel-body problems-view", tabindex: "0" });
  private problemsTitle = h("span", { class: "panel-title", text: "PROBLEMS" });
  private terminalTitle = h("span", { class: "panel-title", text: "TERMINAL" });
  private debugTitle = h("span", { class: "panel-title", text: "DEBUG CONSOLE" });
  private debugOut = h("div", { class: "debug-console-output" });
  private debugInput = h("input", { class: "input debug-console-input", placeholder: "GDB command (e.g. info registers, p/x var, monitor reset)", spellcheck: "false" });
  private debugEl = h("div", { class: "panel-body debug-console" }, this.debugOut, h("div", { class: "debug-console-prompt" }, h("span", { text: "›" }), this.debugInput));
  private debugHistory: string[] = [];
  private debugHistoryPos = 0;
  onDebugCommand: (cmd: string) => void = () => {};
  private terminalActions: HTMLElement;
  private view: "terminal" | "problems" | "debug" = "terminal";
  private maximized = false;

  constructor(private el: HTMLElement, private sash: HTMLElement) {
    this.terminalActions = h(
      "div",
      { class: "view-actions" },
      this.action("newFile", "New Terminal (Ctrl+Shift+`)", () => this.create()),
      this.action("chevronDown", "Launch Profile...", (e) => this.shellMenu(e)),
      this.action("close", "Kill Terminal", () => this.active && this.kill(this.active)),
    );
    this.problemsTitle.addEventListener("click", () => this.showView("problems"));
    this.terminalTitle.addEventListener("click", () => this.showView("terminal"));
    this.debugTitle.addEventListener("click", () => this.showView("debug"));
    this.debugInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.debugInput.value.trim()) {
        const cmd = this.debugInput.value.trim();
        this.debugHistory.push(cmd);
        this.debugHistoryPos = this.debugHistory.length;
        this.debugInput.value = "";
        this.onDebugCommand(cmd);
      } else if (e.key === "ArrowUp" && this.debugHistoryPos > 0) {
        this.debugInput.value = this.debugHistory[--this.debugHistoryPos];
        e.preventDefault();
      } else if (e.key === "ArrowDown" && this.debugHistoryPos < this.debugHistory.length) {
        this.debugInput.value = this.debugHistory[++this.debugHistoryPos] ?? "";
        e.preventDefault();
      }
    });
    el.append(
      h(
        "div",
        { class: "panel-header" },
        this.problemsTitle,
        this.terminalTitle,
        this.debugTitle,
        this.tabs,
        this.terminalActions,
        h(
          "div",
          { class: "view-actions" },
          this.action("expandAll", "Maximize Panel Size", () => this.toggleMaximize()),
          this.action("chevronRight", "Hide Panel (Ctrl+`)", () => this.hide()),
        ),
      ),
      this.body,
      this.problemsEl,
      this.debugEl,
    );
    onProblemsChanged(() => this.renderProblems());
    this.renderProblems();
    new ResizeObserver(() => this.fitActive()).observe(this.body);
    this.initSash();
    onThemeScopes(() =>
      this.sessions.forEach((s) => {
        s.term.options.theme = terminalTheme();
        s.el.style.background = s.term.options.theme.background ?? "";
      }),
    );

    listen<{ id: number; data: string }>("ssh://data", (e) => {
      this.sessions.find((s) => s.remoteId === e.payload.id)?.term.write(e.payload.data);
    });
    listen<{ id: number; code: number | null }>("ssh://exit", (e) => {
      const s = this.sessions.find((x) => x.remoteId === e.payload.id);
      if (!s) return;
      s.exited = true;
      s.term.write(`\r\n\x1b[90m[Remote shell closed${e.payload.code !== null ? ` with code ${e.payload.code}` : ""}. Press any key to close the terminal.]\x1b[0m\r\n`);
      this.renderTabs();
    });
    listen<{ id: number; data: string }>("pty://data", (e) => {
      this.sessions.find((s) => s.ptyId === e.payload.id)?.term.write(e.payload.data);
    });
    listen<{ id: number; code: number | null }>("pty://exit", (e) => {
      const s = this.sessions.find((x) => x.ptyId === e.payload.id);
      if (!s) return;
      s.exited = true;
      if (s.task) {
        const ok = e.payload.code === 0;
        const lines = this.bufferLines(s);
        s.term.write(`\r\n\x1b[${ok ? "32" : "31"}m * ${s.task.name} finished with exit code ${e.payload.code ?? "?"}.\x1b[0m\x1b[90m Press any key to close the terminal.\x1b[0m\r\n`);
        s.task.resolve({ code: e.payload.code, lines });
      } else {
        s.term.write(`\r\n\x1b[90m[Process exited with code ${e.payload.code ?? "?"}. Press any key to close the terminal.]\x1b[0m\r\n`);
      }
      this.renderTabs();
    });
    this.applyVisibility();
  }

  private action(name: Parameters<typeof icon>[0], title: string, fn: (e: MouseEvent) => void) {
    return h("button", { class: "icon-button", title, onclick: fn }, icon(name));
  }

  get visible() {
    return settings.panelVisible;
  }

  private applyVisibility() {
    const v = settings.panelVisible;
    this.el.style.display = v ? "" : "none";
    this.sash.style.display = v ? "" : "none";
    this.el.style.height = this.maximized ? "" : `${settings.panelHeight}px`;
    this.el.classList.toggle("maximized", this.maximized);
    document.getElementById("editor-area")!.classList.toggle("panel-maximized", v && this.maximized);
    const term = this.view === "terminal";
    this.body.style.display = term ? "" : "none";
    this.problemsEl.style.display = this.view === "problems" ? "" : "none";
    this.debugEl.style.display = this.view === "debug" ? "" : "none";
    this.tabs.style.display = term ? "" : "none";
    this.terminalActions.style.display = term ? "" : "none";
    this.terminalTitle.classList.toggle("active", term);
    this.problemsTitle.classList.toggle("active", this.view === "problems");
    this.debugTitle.classList.toggle("active", this.view === "debug");
  }

  /** Show the panel; create a terminal if there is none. */
  async show(focus = true) {
    settings.panelVisible = true;
    this.view = "terminal";
    saveSettings();
    this.applyVisibility();
    if (!this.sessions.length) await this.create();
    this.fitActive();
    if (focus) this.active?.term.focus();
  }

  hide() {
    settings.panelVisible = false;
    this.maximized = false;
    saveSettings();
    this.applyVisibility();
    editors.editor.focus();
  }

  toggle() {
    if (this.visible && this.el.contains(document.activeElement)) this.hide();
    else this.show();
  }

  private toggleMaximize() {
    this.maximized = !this.maximized;
    this.applyVisibility();
    this.fitActive();
  }

  async listShells(): Promise<ShellInfo[]> {
    if (!this.shells) this.shells = await invoke<ShellInfo[]>("pty_shells").catch(() => []);
    return this.shells;
  }

  private async defaultShell(): Promise<ShellInfo | undefined> {
    const shells = await this.listShells();
    return shells.find((s) => s.name === settings.terminal.defaultShell) ?? shells[0];
  }

  private async shellMenu(e: MouseEvent) {
    const shells = await this.listShells();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showMenu(
      [
        ...shells.map((s) => ({ label: s.name, action: () => this.create(s) })),
        // Shells on connected SSH hosts.
        ...connections().map((c) => ({ label: `SSH: ${c.label}`, action: () => this.create({ name: `SSH: ${c.label}`, path: remotePath(c.label, c.home), args: [] }) })),
        "-" as const,
        {
          label: "Select Default Profile",
          submenu: shells.map((s) => ({
            label: s.name,
            checked: s.name === (settings.terminal.defaultShell || shells[0]?.name),
            action: () => {
              settings.terminal.defaultShell = s.name;
              saveSettings();
            },
          })),
        },
      ],
      r.left,
      r.bottom,
    );
  }

  /**
   * Run a build/flash command in its own terminal tab (reusing the previous
   * tab of the same task, like VS Code). Resolves when the command exits.
   */
  runTask(name: string, command: string, cwd: string): Promise<TaskResult> {
    for (const old of this.sessions.filter((s) => s.task?.name === name)) {
      if (!old.exited) old.task!.resolve({ code: null, lines: [] }); // superseded
      this.kill(old, false);
    }
    return new Promise((resolve) => {
      this.create(undefined, { name, command, cwd, resolve });
    });
  }

  /** Terminal text as lines (wrapped lines joined). */
  private bufferLines(s: Session): string[] {
    const b = s.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && out.length) out[out.length - 1] += text;
      else out.push(text);
    }
    return out;
  }

  /** Append text to the Debug Console (GDB / server output). */
  debugLog(text: string, kind: "out" | "err" | "info" | "cmd") {
    const atBottom = this.debugOut.scrollTop + this.debugOut.clientHeight >= this.debugOut.scrollHeight - 4;
    this.debugOut.append(h("span", { class: `dc-${kind}`, text }));
    // Keep the console bounded.
    while (this.debugOut.childNodes.length > 5000) this.debugOut.firstChild?.remove();
    if (atBottom) this.debugOut.scrollTop = this.debugOut.scrollHeight;
  }

  clearDebugConsole() {
    this.debugOut.replaceChildren();
  }

  showView(view: "terminal" | "problems" | "debug") {
    this.view = view;
    if (!settings.panelVisible) {
      settings.panelVisible = true;
      saveSettings();
    }
    this.applyVisibility();
    if (view === "terminal" && !this.sessions.length) this.create();
    this.fitActive();
    if (view === "problems") this.problemsEl.focus();
    else if (view === "debug") this.debugInput.focus();
    else this.active?.term.focus();
  }

  private renderProblems() {
    const list = allProblems();
    const counts = { error: 0, warning: 0, info: 0 };
    list.forEach((p) => counts[p.severity]++);
    this.problemsTitle.textContent = list.length ? `PROBLEMS ${list.length}` : "PROBLEMS";
    const rows: HTMLElement[] = [];
    let current = "";
    for (const p of list) {
      if (p.path !== current) {
        current = p.path;
        const n = list.filter((x) => x.path === p.path).length;
        rows.push(
          h(
            "div",
            { class: "tree-row problem-file", title: p.path },
            fileIcon(basename(p.path)),
            h("span", { class: "tree-label", text: basename(p.path) }),
            h("span", { class: "tree-desc", text: settings.session.folder ? relativePath(settings.session.folder, dirname(p.path)) : dirname(p.path) }),
            h("span", { class: "badge", text: String(n) }),
          ),
        );
      }
      const row = h(
        "div",
        { class: `tree-row problem ${p.severity}`, title: `${p.message}\n${p.path}:${p.line}:${p.column}` },
        h("span", { class: `problem-icon ${p.severity}`, text: p.severity === "error" ? "⊗" : p.severity === "warning" ? "⚠" : "ⓘ" }),
        h("span", { class: "problem-msg", text: p.message }),
        h("span", { class: "tree-desc", text: `${p.source} [Ln ${p.line}, Col ${p.column}]` }),
      );
      row.addEventListener("click", () => editors.open(p.path, { line: p.line, column: p.column }));
      rows.push(row);
    }
    if (!rows.length) rows.push(h("div", { class: "view-empty muted", text: "No problems have been detected in the workspace." }));
    this.problemsEl.replaceChildren(...rows);
  }

  /** Open a new terminal in the workspace folder (or run a task in it). */
  async create(shell?: ShellInfo, task?: { name: string; command: string; cwd: string; resolve: (r: TaskResult) => void }) {
    // In a remote (ssh://) folder, new terminals are shells on the host.
    const folder = settings.session.folder;
    const remoteTarget = !task && (shell ? isRemote(shell.path) : isRemote(folder)) ? (shell?.path ?? folder!) : null;
    if (remoteTarget) shell = { name: `SSH: ${splitRemote(remoteTarget).label}`, path: remoteTarget, args: [] };
    if (!task) shell ??= await this.defaultShell();
    if (!shell && !task) return;
    shell ??= { name: task!.name, path: "cmd.exe", args: [] };
    this.view = "terminal";
    if (!settings.panelVisible) settings.panelVisible = true;
    saveSettings();
    this.applyVisibility();
    const theme = terminalTheme();
    const term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: Math.max(10, settings.fontSize - 1),
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
      theme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // The area around the character grid uses the terminal background too.
    const el = h("div", { class: "terminal-instance", style: { background: theme.background ?? "" } });
    this.body.append(el);
    const s: Session = {
      key: ++this.nextKey,
      ptyId: null,
      shell,
      cwd: task?.cwd ?? remoteTarget ?? settings.session.folder,
      term,
      fit,
      el,
      exited: false,
      task: task ? { name: task.name, resolve: task.resolve } : undefined,
    };
    this.sessions.push(s);
    this.activate(s);
    term.open(el);
    fit.fit();

    term.attachCustomKeyEventHandler((ev) => this.handleKey(s, ev));
    term.onData((data) => {
      if (s.exited) return void this.kill(s);
      if (s.remoteId !== undefined) invoke("ssh_shell_write", { id: s.remoteId, data }).catch(() => {});
      else if (s.ptyId !== null) invoke("pty_write", { id: s.ptyId, data }).catch(() => {});
    });
    term.onResize(({ cols, rows }) => {
      if (s.exited) return;
      if (s.remoteId !== undefined) invoke("ssh_shell_resize", { id: s.remoteId, cols, rows }).catch(() => {});
      else if (s.ptyId !== null) invoke("pty_resize", { id: s.ptyId, cols, rows }).catch(() => {});
    });
    this.registerFileLinks(s);

    try {
      if (remoteTarget) {
        const { label, path } = splitRemote(remoteTarget);
        term.write(`\x1b[90mConnecting to ${label}…\x1b[0m\r\n`);
        const conn = await connect(label);
        s.remoteId = await invoke<number>("ssh_shell_open", { id: conn.id, cols: term.cols, rows: term.rows, cwd: path });
      } else if (task) {
        term.write(`\x1b[36m * Executing task: ${task.command}\x1b[0m\r\n\r\n`);
        s.ptyId = await invoke<number>("pty_spawn_task", { command: task.command, cwd: task.cwd, cols: term.cols, rows: term.rows });
      } else {
        s.ptyId = await invoke<number>("pty_spawn", { shell: shell.path, args: shell.args, cwd: s.cwd, cols: term.cols, rows: term.rows });
      }
    } catch (e) {
      term.write(`\x1b[31mCould not start ${shell.name}: ${e}\x1b[0m\r\n`);
      s.exited = true;
      task?.resolve({ code: -1, lines: [String(e)] });
    }
    this.renderTabs();
    if (!task) term.focus();
  }

  /** Copy/paste like VS Code; let app-level shortcuts through. */
  private handleKey(s: Session, ev: KeyboardEvent): boolean {
    if (ev.type !== "keydown") return true;
    const key = ev.key.toLowerCase();
    if (ev.ctrlKey && !ev.altKey && key === "c" && s.term.hasSelection()) {
      navigator.clipboard.writeText(s.term.getSelection());
      s.term.clearSelection();
      ev.preventDefault();
      return false;
    }
    if (ev.ctrlKey && !ev.altKey && key === "v") {
      navigator.clipboard.readText().then((t) => s.term.paste(t));
      ev.preventDefault();
      return false;
    }
    if (ev.ctrlKey && ev.shiftKey && key === "c") {
      navigator.clipboard.writeText(s.term.getSelection());
      return false;
    }
    return true;
  }

  /** Make `file.c:12:5` style paths in the output clickable. */
  private registerFileLinks(s: Session) {
    s.term.registerLinkProvider({
      provideLinks: (y, callback) => {
        const line = s.term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
        const links = [];
        for (const m of line.matchAll(FILE_LINK)) {
          const start = m.index! + 1;
          const [text, file, ln, col] = m;
          links.push({
            text,
            range: { start: { x: start, y }, end: { x: start + text.length - 1, y } },
            decorations: { underline: true, pointerCursor: true },
            activate: async (ev: MouseEvent) => {
              if (!ev.ctrlKey && !ev.metaKey) return; // like VS Code: Ctrl+Click
              const path = /^[A-Za-z]:|^[\\/]/.test(file) ? file : s.cwd ? resolvePath(s.cwd, file) : file;
              const exists = await api.readTextFile(path).then(() => true, () => false);
              if (exists) editors.open(path, { line: ln ? Number(ln) : undefined, column: col ? Number(col) : undefined });
            },
          });
        }
        callback(links);
      },
    });
  }

  private activate(s: Session) {
    this.active = s;
    this.sessions.forEach((x) => (x.el.style.display = x === s ? "" : "none"));
    this.renderTabs();
    requestAnimationFrame(() => this.fitActive());
  }

  killActive() {
    if (this.active) this.kill(this.active);
  }

  kill(s: Session, hideWhenEmpty = true) {
    if (s.remoteId !== undefined && !s.exited) invoke("ssh_shell_close", { id: s.remoteId }).catch(() => {});
    else if (s.ptyId !== null && !s.exited) invoke("pty_kill", { id: s.ptyId }).catch(() => {});
    if (s.task && !s.exited) s.task.resolve({ code: null, lines: this.bufferLines(s) });
    s.term.dispose();
    s.el.remove();
    const i = this.sessions.indexOf(s);
    this.sessions.splice(i, 1);
    if (this.active === s) {
      const next = this.sessions[Math.min(i, this.sessions.length - 1)];
      if (next) {
        this.activate(next);
        next.term.focus();
      } else {
        this.active = null;
        if (hideWhenEmpty) this.hide();
      }
    }
    this.renderTabs();
  }

  private fitActive() {
    if (!this.active || !settings.panelVisible) return;
    try {
      this.active.fit.fit();
    } catch {
      /* not laid out yet */
    }
  }

  /** Font size follows the editor zoom. */
  setFontSize(size: number) {
    for (const s of this.sessions) s.term.options.fontSize = Math.max(10, size - 1);
    this.fitActive();
  }

  private renderTabs() {
    this.tabs.replaceChildren(
      ...this.sessions.map((s, i) => {
        const tab = h(
          "div",
          { class: `panel-tab${s === this.active ? " active" : ""}${s.exited ? " exited" : ""}`, title: `${s.shell.path}${s.cwd ? `\n${s.cwd}` : ""}` },
          h("span", { text: s.task ? `${i + 1}: ${s.task.name}` : `${i + 1}: ${s.shell.name}${s.cwd ? ` — ${basename(s.cwd)}` : ""}` }),
          h(
            "span",
            {
              class: "tab-close",
              title: "Kill Terminal",
              onclick: (e: Event) => {
                e.stopPropagation();
                this.kill(s);
              },
            },
            icon("close"),
          ),
        );
        tab.addEventListener("click", () => {
          this.activate(s);
          s.term.focus();
        });
        return tab;
      }),
    );
  }

  private initSash() {
    this.sash.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = this.el.getBoundingClientRect().height;
      this.sash.setPointerCapture(e.pointerId);
      this.sash.classList.add("active");
      const area = document.getElementById("editor-area")!.getBoundingClientRect().height;
      const move = (ev: PointerEvent) => {
        this.maximized = false;
        settings.panelHeight = Math.round(Math.max(80, Math.min(area - 120, startH - (ev.clientY - startY))));
        this.applyVisibility();
      };
      const up = () => {
        this.sash.classList.remove("active");
        this.sash.removeEventListener("pointermove", move);
        this.sash.removeEventListener("pointerup", up);
        saveSettings();
      };
      this.sash.addEventListener("pointermove", move);
      this.sash.addEventListener("pointerup", up);
    });
  }
}
