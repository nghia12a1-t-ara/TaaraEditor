import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getVersion } from "@tauri-apps/api/app";
import { ask, message, open as openDialog } from "@tauri-apps/plugin-dialog";
import { monaco } from "./monaco-setup";
import { api, basename, errorMessage, relativePath } from "./api";
import { addRecentFolder, loadSettings, saveSettings, settings } from "./settings";
import { allThemes, applyTheme, onThemeScopes } from "./themes";
import { BUILTIN_ICON_THEME, NO_ICON_THEME, allIconThemes, applyIconTheme, refreshFileIcons } from "./file-icons";
import { loadExtensions } from "./extension-host";
import { editors } from "./editor-manager";
import { type SymbolKind } from "./symbols";
import { clangdDetails, clangdState, installClangd, onClangdStatus, registerClangdProviders, startClangd } from "./clangd";
import { goToWorkspaceSymbol, indexWorkspace, initIndexing, onIndexStatus, registerNavigation } from "./navigation";
import { h, icon, makeSash } from "./ui/dom";
import { createMenuBar, type MenuItem } from "./ui/menu";
import { showInputBox, showQuickPick } from "./ui/quickpick";
import { connect, connections, disconnect, isRemote, listHosts, onRemoteChange, remoteError, remotePath, splitRemote } from "./remote";
import { Explorer } from "./ui/explorer";
import { SearchView } from "./ui/search-view";
import { ExtensionsView } from "./ui/extensions-view";
import { Outline } from "./ui/outline";
import { StatusBar } from "./ui/statusbar";
import { TerminalPanel } from "./ui/terminal-panel";
import { DebugView, createDebugToolbar } from "./ui/debug-view";
import * as dbg from "./debug";
import { ScmView, closeDiff } from "./ui/scm-view";
import * as git from "./git";
import { refreshGit } from "./git";
import { buildAndFlash, configureTasks, describeConfig, onBuildStatus, runTask, taskConfig } from "./build-tasks";
import { installEolMarkers } from "./eol-markers";
import { checkForUpdates, initUpdater, onUpdateState, promptInstall, type UpdateState } from "./updater";
import { showOnboarding } from "./ui/onboarding";
import wordWrapIcon from "./icons/word-wrap.svg?url";
import showAllIcon from "./icons/show_all_char.svg?url";
import functionListIcon from "./icons/function-list.svg?url";
import newIcon from "./icons/new.svg?url";
import openIcon from "./icons/open.svg?url";
import openFolderIcon from "./icons/open_folder.svg?url";
import saveIcon from "./icons/save.svg?url";

const $ = (id: string) => document.getElementById(id)!;
const appWindow = getCurrentWindow();

// ------------------------------------------------------------------ commands

interface Command {
  id: string;
  label: string;
  key?: string; // display + matching, e.g. "Ctrl+Shift+O"
  run: () => unknown;
}

const commands = new Map<string, Command>();
function command(id: string, label: string, key: string | undefined, run: () => unknown) {
  commands.set(id, { id, label, key, run });
}
const exec = (id: string) => commands.get(id)?.run();
const keyOf = (id: string) => commands.get(id)?.key;

/** Run a Monaco editor action on the active editor. */
function editorAction(id: string) {
  if (!editors.active) return;
  editors.editor.focus();
  editors.editor.trigger("menu", id, null);
}

// ------------------------------------------------------------------ views

const explorer = new Explorer({ openFolder: () => exec("file.openFolder") });
const searchView = new SearchView();
const extensionsView = new ExtensionsView({ reload: () => reloadWindow(), pickTheme: () => pickTheme(), pickIconTheme: () => pickIconTheme() });
const debugActions = {
  start: () => startDebug(),
  stop: () => dbg.stopDebugging(),
  restart: () => dbg.restartDebugging(buildBeforeDebug),
  configure: () => configureDebug(),
};
const debugView = new DebugView(debugActions);
const scmView = new ScmView();
const views: Record<string, { title: string; icon: Parameters<typeof icon>[0]; el: HTMLElement; key: string }> = {
  explorer: { title: "Explorer", icon: "files", el: explorer.el, key: "Ctrl+Shift+E" },
  search: { title: "Search", icon: "search", el: searchView.el, key: "Ctrl+Shift+F" },
  scm: { title: "Source Control", icon: "sourceControl", el: scmView.el, key: "Ctrl+Shift+G" },
  debug: { title: "Run and Debug", icon: "bug", el: debugView.el, key: "Ctrl+Shift+D" },
  extensions: { title: "Extensions", icon: "extensions", el: extensionsView.el, key: "Ctrl+Shift+X" },
};

// ------------------------------------------------------------------ debugging

async function buildBeforeDebug(): Promise<boolean> {
  const r = await runTask("build", terminal);
  return r?.code === 0;
}

function startDebug() {
  terminal.clearDebugConsole();
  terminal.showView("debug");
  showView("debug");
  return dbg.startDebugging(buildBeforeDebug);
}

/** F5: start, or continue when paused. */
function debugContinueOrStart() {
  const st = dbg.debugState();
  if (st === "inactive") startDebug();
  else if (st === "stopped") dbg.continueExecution();
}

async function configureDebug() {
  await configureTasks();
  message(
    'Debug settings live in the "debug" section of .taara/tasks.json:\n\n' +
      '"debug": {\n  "server": "auto",          // auto | stlink | openocd | none\n  "target": "127.0.0.1:3333", // GDB server address when server is "none"\n  "stopAtMain": true,\n  "load": true,\n  "buildFirst": true,\n  "initCommands": []\n}\n\n' +
      'Use "server": "none" to attach to a GDB server you start yourself (J-Link, pyOCD, QEMU, Renode, a remote probe…).',
    { title: "Configure debugging", kind: "info" },
  );
}

function showView(name: string, toggle = false) {
  if (toggle && settings.sidebarVisible && settings.sidebarView === name) {
    setSidebarVisible(false);
    return;
  }
  settings.sidebarView = views[name] ? name : "explorer";
  setSidebarVisible(true);
  $("sidebar-content").replaceChildren(views[settings.sidebarView].el);
  document.querySelectorAll(".activity").forEach((a) => a.classList.toggle("active", (a as HTMLElement).dataset.view === settings.sidebarView));
  if (settings.sidebarView === "extensions") extensionsView.render();
  saveSettings();
}

function setSidebarVisible(v: boolean) {
  settings.sidebarVisible = v;
  $("sidebar").style.display = v ? "" : "none";
  $("sidebar-sash").style.display = v ? "" : "none";
  document.querySelectorAll(".activity").forEach((a) => a.classList.toggle("active", v && (a as HTMLElement).dataset.view === settings.sidebarView));
  saveSettings();
}

let outline: Outline;
let terminal: TerminalPanel;
let terminalShells: { name: string; path: string; args: string[] }[] = [];
function setOutlineVisible(v: boolean) {
  settings.outlineVisible = v;
  $("outline").style.display = v ? "" : "none";
  $("outline-sash").style.display = v ? "" : "none";
  if (v) outline.refresh();
  syncToolbar();
  saveSettings();
}

// Notepad++-style toggle buttons, placed in the menu bar row to save vertical space.
const toolbarButtons: { el: HTMLElement; isOn?: () => boolean; isEnabled?: () => boolean }[] = [];
let refreshEolMarkers = () => {};

function buildToolbar() {
  const button = (id: string, title: string, iconUrl: string, opts: { colored?: boolean; isOn?: () => boolean; isEnabled?: () => boolean } = {}) => {
    // Colored SVGs (new/save/open folder) keep their own colors, like Notepad++;
    // monochrome ones are drawn as a mask so they follow the theme.
    const img = opts.colored
      ? h("img", { class: "tool-img", src: iconUrl, alt: "", draggable: "false" })
      : h("span", { class: "tool-icon", style: { maskImage: `url("${iconUrl}")`, webkitMaskImage: `url("${iconUrl}")` } });
    const el = h("button", { class: "tool-button", title: `${title}${keyOf(id) ? ` (${keyOf(id)})` : ""}`, onclick: () => exec(id) }, img);
    el.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the editor
    toolbarButtons.push({ el, isOn: opts.isOn, isEnabled: opts.isEnabled });
    return el;
  };
  const sep = () => h("div", { class: "toolbar-sep" });
  // Build / Flash, like the Compile / Flash Programming buttons of the Python version.
  const svgButton = (id: string, title: string, name: Parameters<typeof icon>[0]) => {
    const el = h("button", { class: "tool-button tool-svg", title: `${title}${keyOf(id) ? ` (${keyOf(id)})` : ""}`, onclick: () => exec(id) }, icon(name));
    el.addEventListener("mousedown", (e) => e.preventDefault());
    toolbarButtons.push({ el, isEnabled: () => !!settings.session.folder });
    return el;
  };
  $("menubar").append(
    sep(),
    h(
      "div",
      { class: "toolbar" },
      button("file.new", "New File", newIcon, { colored: true }),
      button("file.open", "Open File", openIcon),
      button("file.openFolder", "Open Folder", openFolderIcon, { colored: true }),
      button("file.save", "Save", saveIcon, { colored: true, isEnabled: () => !!editors.active && (editors.isDirty(editors.active) || !editors.active.path) }),
    ),
    sep(),
    h(
      "div",
      { class: "toolbar" },
      button("view.wordWrap", "Word Wrap", wordWrapIcon, { isOn: () => settings.wordWrap }),
      button("view.whitespace", "Show All Characters", showAllIcon, { isOn: () => settings.renderWhitespace }),
      button("view.outline", "Function List", functionListIcon, { isOn: () => settings.outlineVisible }),
    ),
    sep(),
    h(
      "div",
      { class: "toolbar" },
      svgButton("build.build", "Build", "build"),
      svgButton("build.flash", "Flash Programming", "flash"),
      svgButton("debug.start", "Start Debugging", "bug"),
      svgButton("debug.stop", "Stop Debugging", "stop"),
    ),
  );
  editors.on("active", syncToolbar);
  editors.on("content", syncToolbar);
  syncToolbar();
}

function syncToolbar() {
  for (const b of toolbarButtons) {
    if (b.isOn) {
      b.el.classList.toggle("checked", b.isOn());
      b.el.setAttribute("aria-pressed", String(b.isOn()));
    }
    if (b.isEnabled) (b.el as HTMLButtonElement).disabled = !b.isEnabled();
  }
}

function buildActivityBar() {
  const bar = $("activitybar");
  for (const [name, v] of Object.entries(views)) {
    const btn = h("button", { class: "activity", title: `${v.title} (${v.key})`, dataset: { view: name } }, icon(v.icon));
    btn.addEventListener("click", () => showView(name, true));
    bar.append(btn);
  }
  bar.append(h("div", { class: "activity-spacer" }));
  const outlineBtn = h("button", { class: "activity", title: "Function List" }, icon("outline"));
  outlineBtn.addEventListener("click", () => setOutlineVisible(!settings.outlineVisible));
  bar.append(outlineBtn);
}

function renderWelcome() {
  const recent = settings.recentFolders.slice(0, 6);
  $("welcome").replaceChildren(
    h(
      "div",
      { class: "welcome" },
      h("h1", { text: "Taara Editor" }),
      h("p", { class: "muted", text: "Lightweight code editor for embedded developers" }),
      h(
        "div",
        { class: "welcome-cols" },
        h(
          "div",
          {},
          h("h3", { text: "Start" }),
          h("a", { text: "New File", title: keyOf("file.new"), onclick: () => exec("file.new") }),
          h("a", { text: "Open File...", title: keyOf("file.open"), onclick: () => exec("file.open") }),
          h("a", { text: "Open Folder...", title: keyOf("file.openFolder"), onclick: () => exec("file.openFolder") }),
          h("a", { text: "Connect to SSH Host...", onclick: () => remoteConnect() }),
          h("a", { text: "Install Extension from VSIX...", onclick: () => extensionsView.pickAndInstall() }),
          h("a", { text: "Welcome Tour", onclick: () => startOnboarding() }),
        ),
        h(
          "div",
          {},
          h("h3", { text: "Recent" }),
          recent.length
            ? recent.map((p) => h("a", { text: basename(p), title: p, onclick: () => openFolder(p) }))
            : h("span", { class: "muted", text: "No recent folders" }),
        ),
      ),
      h(
        "div",
        { class: "welcome-keys muted" },
        ...[
          ["Quick Open", "file.quickOpen"],
          ["Command Palette", "view.commandPalette"],
          ["Search in Files", "view.search"],
          ["Toggle Sidebar", "view.toggleSidebar"],
        ].map(([label, id]) => h("div", {}, h("span", { text: label }), h("kbd", { text: keyOf(id) ?? "" }))),
      ),
    ),
  );
}

// ------------------------------------------------------------------ file actions

// ------------------------------------------------------------------ git

async function gitAction(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    message(errorMessage(e), { title: "Git", kind: "error" });
  }
}

async function createBranchPrompt() {
  // git check-ref-format rules (the common ones).
  const invalid = (v: string) => /\s/.test(v) || [..."~^:?*[\\"].some((c) => v.includes(c)) || v.includes("..") || v.includes("@{") || v.startsWith("-") || v.endsWith(".lock") || v.endsWith("/");
  const name = await showInputBox({ prompt: "New branch name", validate: (v) => (v && invalid(v) ? "Invalid branch name" : null) });
  if (name) gitAction(() => git.createBranch(name));
}

async function branchPicker() {
  if (!git.gitStatus()?.is_repo) return;
  const list = await git.branches().catch(() => []);
  const pick = await showQuickPick(
    [
      { label: "+ Create new branch…", description: "", value: "__new__" },
      ...list.filter((b) => !b.current).map((b) => ({ label: b.name, description: b.remote ? "remote branch" : "", value: b.name })),
    ],
    { placeholder: `Select a branch to checkout (current: ${git.gitStatus()?.branch ?? "detached"})` },
  );
  if (!pick) return;
  if (pick === "__new__") return createBranchPrompt();
  await editors.saveAll();
  // origin/feature -> local tracking branch "feature"
  const remote = list.find((b) => b.name === pick)?.remote;
  gitAction(() => (remote ? git.git(["checkout", "--track", pick], `Checking out ${pick}…`) : git.checkout(pick)));
}

function updateGitStatus() {
  const st = git.gitStatus();
  // Badge with the number of changes on the Source Control activity icon.
  const n = st?.files.length ?? 0;
  const btn = document.querySelector<HTMLElement>('.activity[data-view="scm"]');
  if (btn) btn.dataset.badge = n ? String(n > 99 ? "99+" : n) : "";
  if (!st?.is_repo) return statusBar.setGit("", "", "", "");
  const dirty = st.files.length ? "*" : "";
  const branch = st.detached ? "(detached)" : st.branch ?? "";
  const sync = st.upstream ? `↓${st.behind} ↑${st.ahead}` : "☁ Publish";
  statusBar.setGit(
    `⎇ ${branch}${dirty}`,
    `${st.root} (Git) — ${branch}${st.upstream ? ` → ${st.upstream}` : ""}. Click to checkout a branch.`,
    git.gitBusy() ? "⟳" : sync,
    st.upstream ? `Synchronize changes: ${st.behind} incoming, ${st.ahead} outgoing` : "Publish branch to origin",
  );
}

// ------------------------------------------------------------------ remote SSH

/** Pick a host from ~/.ssh/config (or type user@host), connect, open a folder on it. */
async function remoteConnect() {
  const hosts = await listHosts().catch(() => []);
  const items = [
    ...hosts.map((h) => ({ label: h.alias, description: `${h.user ? h.user + "@" : ""}${h.hostname}${h.port !== 22 ? ":" + h.port : ""}`, value: h.alias })),
    { label: "+ Add New SSH Host...", description: "user@host or user@host:port", value: "__new__" },
  ];
  let target = await showQuickPick(items, { placeholder: "Select an SSH host from ~/.ssh/config, or add a new one" });
  if (!target) return;
  if (target === "__new__") {
    target = await showInputBox({
      prompt: "SSH connection, e.g. pi@192.168.1.50 or user@server:2222",
      validate: (v) => (!v.trim() || /^[^\s@]+@[^\s@]+$/.test(v.trim()) ? null : "Format: user@host or user@host:port"),
    });
    if (!target) return;
  }
  statusBar.setRemote(`⇄ SSH: ${target}…`, `Connecting to ${target}`, "remote-active");
  let conn;
  try {
    conn = await connect(target);
  } catch (e) {
    updateRemoteStatus();
    if (!/Cancelled|not accepted/.test(errorMessage(e))) remoteError(e);
    return;
  }
  updateRemoteStatus();
  const folder = await showInputBox({ prompt: `Folder to open on ${target} (connected as ${conn.user}, signed in with ${conn.auth})`, value: conn.home });
  if (!folder) return;
  if (!(await editors.closeAll())) return;
  await openFolder(remotePath(target, folder.startsWith("/") ? folder : `${conn.home.replace(/\/$/, "")}/${folder}`));
}

async function remoteClose() {
  const folder = settings.session.folder;
  if (!isRemote(folder)) return;
  if (!(await editors.closeAll())) return;
  await closeFolder();
  await disconnect(splitRemote(folder).label);
  updateRemoteStatus();
}

function remoteMenu() {
  const remote = isRemote(settings.session.folder);
  showQuickPick(
    [
      { label: "Connect to Host...", description: "Remote-SSH: open a folder on an SSH host", value: "connect" },
      ...(remote ? [{ label: "Close Remote Connection", description: splitRemote(settings.session.folder!).label, value: "close" }] : []),
      ...(remote ? [{ label: "New Terminal on Host", description: "", value: "terminal" }] : []),
    ],
    { placeholder: "Remote SSH" },
  ).then((v) => {
    if (v === "connect") remoteConnect();
    else if (v === "close") remoteClose();
    else if (v === "terminal") terminal.create();
  });
}

function updateRemoteStatus() {
  const folder = settings.session.folder;
  if (isRemote(folder)) {
    const { label } = splitRemote(folder);
    const c = connections().find((x) => x.label === label);
    statusBar.setRemote(`⇄ SSH: ${label}`, c ? `Connected to ${c.user}@${c.host} (${c.auth})` : `Remote folder on ${label}`, "remote-active");
  } else {
    statusBar.setRemote("⇄", "Open a Remote Window (SSH)", "");
  }
}

async function openFolder(path?: string, reveal = true) {
  const folder = path ?? ((await openDialog({ directory: true, title: "Open Folder" })) as string | null);
  if (!folder) return;
  try {
    await api.readDir(folder);
  } catch (e) {
    message(`Cannot open folder ${folder}\n\n${errorMessage(e)}`, { title: "Taara Editor", kind: "error" });
    // A remote host may just be offline: keep it in the recent list.
    if (!isRemote(folder)) settings.recentFolders = settings.recentFolders.filter((p) => p !== folder);
    updateRemoteStatus();
    return;
  }
  settings.session.folder = folder;
  addRecentFolder(folder);
  saveSettings();
  updateRemoteStatus();
  await explorer.setRoot(folder);
  indexWorkspace();
  startClangd();
  refreshGit();
  if (reveal) showView("explorer");
  updateTitle();
  renderWelcome();
  statusBar.render();
}

async function closeFolder() {
  if (!(await editors.closeAll())) return;
  settings.session.folder = null;
  saveSettings();
  await explorer.setRoot(null);
  indexWorkspace();
  startClangd();
  refreshGit();
  updateTitle();
  statusBar.render();
}

async function openFiles() {
  const picked = await openDialog({ multiple: true, title: "Open File", defaultPath: settings.session.folder ?? undefined });
  if (!picked) return;
  for (const p of Array.isArray(picked) ? picked : [picked]) await editors.open(p);
}

/** Open whatever was dropped / passed on the command line. */
async function openPaths(paths: string[]) {
  for (const p of paths) {
    if (p.toLowerCase().endsWith(".vsix")) {
      showView("extensions");
      await extensionsView.install(p);
      continue;
    }
    const isDir = await api.readDir(p).then(
      () => true,
      () => false,
    );
    if (isDir) await openFolder(p);
    else await editors.open(p);
  }
}

async function quickOpen() {
  const root = settings.session.folder;
  if (!root) {
    const recent = settings.recentFolders.map((p) => ({ label: basename(p), description: p, value: p }));
    const folder = await showQuickPick(recent, { placeholder: "Open a recent folder" });
    if (folder) openFolder(folder);
    return;
  }
  const file = await showQuickPick(
    async () =>
      (await api.listFiles(root)).map((p) => {
        const rel = relativePath(root, p);
        return { label: basename(p), description: rel.slice(0, Math.max(0, rel.length - basename(p).length - 1)), value: p };
      }),
    { placeholder: "Search files by name", matchOn: (i) => i.label },
  );
  if (file) editors.open(file);
}

async function pickTheme() {
  const themes = allThemes();
  const original = settings.theme;
  const items = themes.map((t) => ({ label: t.label, description: t.source === "Built-in" ? "" : t.source, value: t.id }));
  let previewTimer: number | undefined;
  const id = await showQuickPick(items, {
    placeholder: "Select Color Theme (Up/Down to preview)",
    activeIndex: Math.max(0, themes.findIndex((t) => t.id === original)),
    onHighlight: (item) => {
      window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => applyTheme(item.value), 120);
    },
  });
  window.clearTimeout(previewTimer);
  settings.theme = await applyTheme(id ?? original);
  saveSettings();
}

async function pickIconTheme() {
  const original = settings.iconTheme;
  const items = [
    { label: "None", description: "Disable file icons", value: NO_ICON_THEME },
    { label: "Taara (built-in)", description: "", value: BUILTIN_ICON_THEME },
    ...allIconThemes().map((t) => ({ label: t.label, description: t.source, value: t.id })),
  ];
  let previewTimer: number | undefined;
  const id = await showQuickPick(items, {
    placeholder: "Select File Icon Theme (Up/Down to preview)",
    activeIndex: Math.max(0, items.findIndex((i) => i.value === original)),
    onHighlight: (item) => {
      window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => applyIconTheme(item.value), 120);
    },
  });
  window.clearTimeout(previewTimer);
  settings.iconTheme = await applyIconTheme(id ?? original);
  saveSettings();
}

/** Status bar click on the clangd item. */
async function clangdMenu() {
  const st = clangdState();
  if (st === "missing") {
    const ok = await ask("C/C++ IntelliSense (completion, errors as you type, precise go to definition) uses clangd, which is not installed.\n\nDownload the official clangd release (about 30 MB) from github.com/clangd/clangd?", {
      title: "Install clangd",
      kind: "info",
      okLabel: "Install",
      cancelLabel: "Not now",
    });
    if (ok) await installClangd().then((i) => message(`clangd ${i.version} installed.`, { title: "clangd", kind: "info" })).catch((e) => message(`clangd could not be installed:

${errorMessage(e)}`, { title: "clangd", kind: "error" }));
    return;
  }
  const action = await showQuickPick(
    [
      { label: "Restart clangd", description: "Re-read compile flags and restart", value: "restart" },
      { label: "Show detected C/C++ configuration", description: "", value: "config" },
      { label: "Set clangd path...", description: settings.clangd.path || "auto-detect", value: "path" },
      { label: settings.clangd.enabled ? "Disable clangd" : "Enable clangd", description: "", value: "toggle" },
      { label: "Install / update clangd", description: "official release from GitHub", value: "install" },
    ],
    { placeholder: "clangd" },
  );
  if (action === "restart") startClangd();
  else if (action === "config") message(clangdDetails(), { title: "C/C++ configuration", kind: "info" });
  else if (action === "toggle") {
    settings.clangd.enabled = !settings.clangd.enabled;
    saveSettings();
    startClangd();
  } else if (action === "install") installClangd().catch((e) => message(errorMessage(e), { title: "clangd", kind: "error" }));
  else if (action === "path") {
    const p = await openDialog({ title: "Select clangd.exe", filters: [{ name: "clangd", extensions: ["exe"] }] });
    if (typeof p === "string") {
      settings.clangd.path = p;
      saveSettings();
      startClangd();
    }
  }
}

function commandPalette() {
  const items = [...commands.values()]
    .filter((c) => c.id !== "view.commandPalette")
    .map((c) => ({ label: c.label, description: c.key ?? "", value: c.id }))
    .sort((a, b) => a.label.localeCompare(b.label));
  showQuickPick(items, { placeholder: "Type the name of a command to run" }).then((id) => id && exec(id));
}

function goToSymbol() {
  const doc = editors.active;
  if (!doc) return;
  const syms = editors.symbols();
  showQuickPick(
    syms.map((s) => ({ label: s.name, description: `${s.kind} · line ${s.line}`, value: s })),
    { placeholder: "Go to symbol in file" },
  ).then((s) => {
    if (s) editors.open(doc.path ?? "", { line: s.line, column: s.column, endColumn: s.column + s.name.length });
  });
}

function setZoom(size: number) {
  settings.fontSize = Math.max(8, Math.min(40, size));
  editors.updateOptions({ fontSize: settings.fontSize });
  terminal?.setFontSize(settings.fontSize);
  saveSettings();
}

async function reloadWindow() {
  if (!(await editors.confirmAll())) return;
  await saveSession();
  location.reload();
}

function updateTitle() {
  const doc = editors.active;
  const parts = [];
  if (doc) parts.push((editors.isDirty(doc) ? "● " : "") + doc.title);
  if (settings.session.folder) parts.push(basename(settings.session.folder));
  parts.push("Taara Editor");
  appWindow.setTitle(parts.join(" - ")).catch(() => {});
}

async function saveSession() {
  settings.session.openFiles = editors.docs.filter((d) => d.path).map((d) => d.path!);
  settings.session.activeFile = editors.active?.path ?? null;
  await saveSettings(true);
}

// ------------------------------------------------------------------ registrations

function registerCommands() {
  command("file.new", "File: New File", "Ctrl+N", () => editors.newUntitled());
  command("file.open", "File: Open File...", "Ctrl+O", openFiles);
  command("file.openFolder", "File: Open Folder...", "Ctrl+Shift+O", () => openFolder());
  command("file.closeFolder", "File: Close Folder", undefined, closeFolder);
  command("remote.connect", "Remote-SSH: Connect to Host...", undefined, remoteConnect);
  command("remote.close", "Remote-SSH: Close Remote Connection", undefined, remoteClose);
  command("remote.menu", "Remote-SSH: Show Remote Menu", undefined, remoteMenu);
  command("file.save", "File: Save", "Ctrl+S", () => editors.save());
  command("file.saveAs", "File: Save As...", "Ctrl+Shift+S", () => editors.saveAs());
  command("file.saveAll", "File: Save All", "Ctrl+Alt+S", () => editors.saveAll());
  command("file.close", "View: Close Editor", "Ctrl+W", () => editors.close());
  command("file.closeAll", "View: Close All Editors", "Ctrl+Shift+W", () => editors.closeAll());
  command("file.quickOpen", "Go to File...", "Ctrl+P", quickOpen);
  command("file.exit", "File: Exit", undefined, () => appWindow.close());
  command("edit.find", "Edit: Find", "Ctrl+F", () => editorAction("actions.find"));
  command("edit.replace", "Edit: Replace", "Ctrl+H", () => editorAction("editor.action.startFindReplaceAction"));
  command("search.replaceInFiles", "Search: Replace in Files", "Ctrl+Shift+H", () => {
    showView("search");
    const sel = editors.active ? editors.active.model.getValueInRange(editors.editor.getSelection()!) : "";
    searchView.focusReplace(sel && !sel.includes("\n") ? sel : undefined);
  });
  command("edit.findInFiles", "Search: Find in Files", "Ctrl+Shift+F", () => {
    showView("search");
    const sel = editors.active ? editors.active.model.getValueInRange(editors.editor.getSelection()!) : "";
    searchView.focus(sel && !sel.includes("\n") ? sel : undefined);
  });
  command("edit.undo", "Edit: Undo", "Ctrl+Z", () => editorAction("undo"));
  command("edit.redo", "Edit: Redo", "Ctrl+Y", () => editorAction("redo"));
  command("edit.cut", "Edit: Cut", "Ctrl+X", () => editorAction("editor.action.clipboardCutAction"));
  command("edit.copy", "Edit: Copy", "Ctrl+C", () => editorAction("editor.action.clipboardCopyAction"));
  command("edit.paste", "Edit: Paste", "Ctrl+V", async () => {
    if (!editors.active) return;
    const text = await navigator.clipboard.readText();
    editors.editor.focus();
    editors.editor.trigger("menu", "type", { text });
  });
  command("edit.selectAll", "Edit: Select All", "Ctrl+A", () => editorAction("editor.action.selectAll"));
  command("edit.comment", "Edit: Toggle Line Comment", "Ctrl+/", () => editorAction("editor.action.commentLine"));
  command("edit.blockComment", "Edit: Toggle Block Comment", "Shift+Alt+A", () => editorAction("editor.action.blockComment"));
  command("edit.format", "Edit: Trim Trailing Whitespace", undefined, () => editorAction("editor.action.trimTrailingWhitespace"));
  command("go.line", "Go to Line...", "Ctrl+G", () => editorAction("editor.action.gotoLine"));
  command("go.symbol", "Go to Symbol in File...", "Ctrl+R", goToSymbol);
  command("go.workspaceSymbol", "Go to Symbol in Workspace...", "Ctrl+T", goToWorkspaceSymbol);
  command("go.references", "Find All References", "Shift+F12", () => editorAction("editor.action.referenceSearch.trigger"));
  command("view.terminal", "View: Toggle Terminal", "Ctrl+`", () => terminal.toggle());
  command("terminal.new", "Terminal: Create New Terminal", "Ctrl+Shift+`", () => terminal.create());
  command("terminal.kill", "Terminal: Kill the Active Terminal Instance", undefined, () => terminal.killActive());
  command("build.build", "Build: Build Project", "F7", () => runTask("build", terminal));
  command("build.rebuild", "Build: Rebuild Project", "Ctrl+Alt+F7", () => runTask("rebuild", terminal));
  command("build.clean", "Build: Clean Project", undefined, () => runTask("clean", terminal));
  command("build.flash", "Build: Flash Programming", "Ctrl+F8", () => runTask("flash", terminal));
  command("build.buildFlash", "Build: Build and Flash", "Ctrl+F9", () => buildAndFlash(terminal));
  command("debug.start", "Debug: Start Debugging / Continue", "F5", debugContinueOrStart);
  command("debug.stop", "Debug: Stop Debugging", "Shift+F5", () => dbg.stopDebugging());
  command("debug.restart", "Debug: Restart", "Ctrl+Shift+F5", () => (dbg.debugState() === "inactive" ? startDebug() : dbg.restartDebugging(buildBeforeDebug)));
  command("debug.pause", "Debug: Pause", "F6", () => dbg.pauseExecution());
  command("debug.stepOver", "Debug: Step Over", "F10", () => dbg.stepOver());
  command("debug.stepInto", "Debug: Step Into", "F11", () => dbg.stepInto());
  command("debug.stepOut", "Debug: Step Out", "Shift+F11", () => dbg.stepOut());
  command("debug.toggleBreakpoint", "Debug: Toggle Breakpoint", "F9", () => dbg.toggleBreakpoint());
  command("debug.removeAll", "Debug: Remove All Breakpoints", undefined, () => dbg.removeAllBreakpoints());
  command("debug.configure", "Debug: Configure Debugger (.taara/tasks.json)", undefined, configureDebug);
  command("view.debug", "View: Show Run and Debug", "Ctrl+Shift+D", () => showView("debug"));
  command("view.scm", "View: Show Source Control", "Ctrl+Shift+G", () => {
    showView("scm");
    scmView.focusMessage();
  });
  command("git.checkout", "Git: Checkout to…", undefined, () => branchPicker());
  command("git.createBranch", "Git: Create Branch…", undefined, () => createBranchPrompt());
  command("git.pull", "Git: Pull", undefined, () => gitAction(() => git.pull()));
  command("git.push", "Git: Push", undefined, () => gitAction(() => git.push()));
  command("git.sync", "Git: Sync", undefined, () => gitAction(() => git.sync()));
  command("git.fetch", "Git: Fetch", undefined, () => gitAction(() => git.fetch()));
  command("git.refresh", "Git: Refresh", undefined, () => git.refreshGit());
  command("git.closeDiff", "Git: Close Diff", undefined, () => closeDiff());
  command("view.debugConsole", "View: Show Debug Console", "Ctrl+Shift+Y", () => terminal.showView("debug"));
  command("build.configure", "Build: Configure Build Tasks (.taara/tasks.json)", undefined, configureTasks);
  command("build.showConfig", "Build: Show Detected Build Configuration", undefined, async () => {
    const c = await taskConfig().catch(() => null);
    message(c ? describeConfig(c) : "Open a project folder first.", { title: "Build configuration", kind: "info" });
  });
  command("view.problems", "View: Show Problems", "Ctrl+Shift+M", () => terminal.showView("problems"));
  command("clangd.menu", "C/C++: clangd Options...", undefined, clangdMenu);
  command("clangd.restart", "C/C++: Restart clangd", undefined, () => startClangd());
  command("edit.formatDocument", "Edit: Format Document", "Shift+Alt+F", () => editorAction("editor.action.formatDocument"));
  command("go.nextProblem", "Go to Next Problem", "F8", () => editorAction("editor.action.marker.nextInFiles"));
  command("index.rebuild", "Developer: Re-index Workspace Symbols", undefined, () => indexWorkspace());
  command("go.definition", "Go to Definition", "F12", () => editorAction("editor.action.revealDefinition"));
  command("go.peekDefinition", "Peek Definition", "Alt+F12", () => editorAction("editor.action.peekDefinition"));
  command("go.nextTab", "View: Next Editor", "Ctrl+Tab", () => editors.cycle(1));
  command("go.prevTab", "View: Previous Editor", "Ctrl+Shift+Tab", () => editors.cycle(-1));
  command("view.explorer", "View: Show Explorer", "Ctrl+Shift+E", () => showView("explorer"));
  command("view.search", "View: Show Search", "Ctrl+Shift+F", () => exec("edit.findInFiles"));
  command("view.extensions", "View: Show Extensions", "Ctrl+Shift+X", () => {
    showView("extensions");
    extensionsView.focusSearch();
  });
  command("view.outline", "View: Toggle Function List", "Ctrl+Alt+O", () => setOutlineVisible(!settings.outlineVisible));
  command("view.toggleSidebar", "View: Toggle Sidebar", "Ctrl+B", () => setSidebarVisible(!settings.sidebarVisible));
  command("view.commandPalette", "Show All Commands", "Ctrl+Shift+P", commandPalette);
  command("view.wordWrap", "View: Toggle Word Wrap", "Alt+Z", () => {
    settings.wordWrap = !settings.wordWrap;
    editors.updateOptions({ wordWrap: settings.wordWrap ? "on" : "off" });
    syncToolbar();
    saveSettings();
  });
  command("view.whitespace", "View: Toggle Show All Characters", undefined, () => {
    settings.renderWhitespace = !settings.renderWhitespace;
    editors.updateOptions({ renderWhitespace: settings.renderWhitespace ? "all" : "selection", renderControlCharacters: true });
    refreshEolMarkers();
    syncToolbar();
    saveSettings();
  });
  command("view.minimap", "View: Toggle Minimap", undefined, () => {
    settings.minimap = !settings.minimap;
    editors.updateOptions({ minimap: { enabled: settings.minimap } });
    saveSettings();
  });
  command("view.zoomIn", "View: Zoom In", "Ctrl+=", () => setZoom(settings.fontSize + 1));
  command("view.zoomOut", "View: Zoom Out", "Ctrl+-", () => setZoom(settings.fontSize - 1));
  command("view.zoomReset", "View: Reset Zoom", "Ctrl+0", () => setZoom(14));
  command("view.theme", "Preferences: Color Theme", "Ctrl+K Ctrl+T", pickTheme);
  command("view.iconTheme", "Preferences: File Icon Theme", undefined, pickIconTheme);
  command("view.language", "Change Language Mode", undefined, () => statusBar.pickLanguage());
  command("ext.install", "Extensions: Install from VSIX...", undefined, () => {
    showView("extensions");
    extensionsView.pickAndInstall();
  });
  command("window.reload", "Developer: Reload Window", undefined, reloadWindow);
  command("help.about", "Help: About", undefined, async () => {
    const version = await getVersion().catch(() => "?");
    message(`Taara Editor ${version}\n\nLightweight code editor for embedded developers.\nBuilt with Rust, Tauri and Monaco.`, { title: "About Taara Editor", kind: "info" });
  });
  command("help.welcome", "Help: Welcome Tour", undefined, startOnboarding);
  command("help.checkUpdates", "Help: Check for Updates...", undefined, () => checkForUpdates(true));
  for (let i = 1; i <= 9; i++) command(`go.tab${i}`, `View: Open Editor ${i}`, `Ctrl+${i}`, () => editors.activateIndex(i === 9 ? editors.docs.length - 1 : i - 1));
}

function buildMenuBar() {
  const item = (id: string, label?: string, extra: Partial<Exclude<MenuItem, "-">> = {}): MenuItem => {
    const c = commands.get(id)!;
    return { label: label ?? c.label.replace(/^[^:]+: /, ""), shortcut: c.key, action: () => c.run(), ...extra };
  };
  createMenuBar($("menubar"), [
    {
      label: "File",
      items: () => [
        item("file.new"),
        item("file.open"),
        item("file.openFolder"),
        item("remote.connect", "Open Remote Folder (SSH)..."),
        {
          label: "Open Recent",
          submenu: () =>
            settings.recentFolders.length
              ? [...settings.recentFolders.map((p) => ({ label: p, action: () => openFolder(p) })), "-", { label: "Clear Recently Opened", action: () => ((settings.recentFolders = []), saveSettings(), renderWelcome()) }]
              : [{ label: "(empty)", disabled: true }],
        },
        "-",
        item("file.save", undefined, { disabled: !editors.active }),
        item("file.saveAs", undefined, { disabled: !editors.active }),
        item("file.saveAll", undefined, { disabled: !editors.dirtyDocs.length }),
        "-",
        { label: "Preferences", submenu: [item("view.theme", "Color Theme..."), item("view.iconTheme", "File Icon Theme..."), item("view.zoomIn"), item("view.zoomOut"), item("view.zoomReset")] },
        "-",
        item("file.close", undefined, { disabled: !editors.active }),
        item("file.closeFolder", undefined, { disabled: !settings.session.folder }),
        "-",
        item("file.exit"),
      ],
    },
    {
      label: "Edit",
      items: () => [
        item("edit.undo", undefined, { disabled: !editors.active }),
        item("edit.redo", undefined, { disabled: !editors.active }),
        "-",
        item("edit.cut", undefined, { disabled: !editors.active }),
        item("edit.copy", undefined, { disabled: !editors.active }),
        item("edit.paste", undefined, { disabled: !editors.active }),
        item("edit.selectAll", undefined, { disabled: !editors.active }),
        "-",
        item("edit.find", undefined, { disabled: !editors.active }),
        item("edit.replace", undefined, { disabled: !editors.active }),
        item("edit.findInFiles", "Find in Files"),
        item("search.replaceInFiles", "Replace in Files"),
        "-",
        item("edit.comment", undefined, { disabled: !editors.active }),
        item("edit.blockComment", undefined, { disabled: !editors.active }),
        item("edit.formatDocument", undefined, { disabled: !editors.active }),
        item("edit.format", undefined, { disabled: !editors.active }),
      ],
    },
    {
      label: "View",
      items: () => [
        item("view.commandPalette", "Command Palette..."),
        "-",
        item("view.explorer", "Explorer"),
        item("view.search", "Search"),
        item("view.extensions", "Extensions"),
        item("view.outline", "Function List", { checked: settings.outlineVisible }),
        item("view.toggleSidebar", "Sidebar", { checked: settings.sidebarVisible }),
        "-",
        item("view.wordWrap", "Word Wrap", { checked: settings.wordWrap }),
        item("view.whitespace", "Show All Characters", { checked: settings.renderWhitespace }),
        item("view.minimap", "Minimap", { checked: settings.minimap }),
        "-",
        item("view.theme", "Color Theme..."),
        item("view.iconTheme", "File Icon Theme..."),
        item("view.language", "Language Mode...", { disabled: !editors.active }),
      ],
    },
    {
      label: "Go",
      items: () => [
        item("file.quickOpen", "Go to File..."),
        item("go.symbol", undefined, { disabled: !editors.active }),
        item("go.workspaceSymbol", undefined, { disabled: !settings.session.folder }),
        item("go.line", undefined, { disabled: !editors.active }),
        "-",
        item("go.definition", undefined, { disabled: !editors.active }),
        item("go.peekDefinition", undefined, { disabled: !editors.active }),
        item("go.references", undefined, { disabled: !editors.active }),
        "-",
        item("go.nextTab", "Next Editor"),
        item("go.prevTab", "Previous Editor"),
      ],
    },
    {
      label: "Build",
      items: () => [
        item("build.build", "Build"),
        item("build.rebuild", "Rebuild"),
        item("build.clean", "Clean"),
        "-",
        item("build.flash", "Flash Programming"),
        item("build.buildFlash", "Build and Flash"),
        "-",
        item("view.problems", "Problems"),
        item("build.showConfig", "Show Build Configuration..."),
        item("build.configure", "Configure Build Tasks..."),
      ],
    },
    {
      label: "Debug",
      items: () => {
        const st = dbg.debugState();
        return [
          item("debug.start", st === "stopped" ? "Continue" : "Start Debugging", { disabled: st === "running" || st === "starting" }),
          item("debug.stop", "Stop Debugging", { disabled: st === "inactive" }),
          item("debug.restart", "Restart Debugging", { disabled: st === "inactive" }),
          "-",
          item("debug.pause", "Pause", { disabled: st !== "running" }),
          item("debug.stepOver", "Step Over", { disabled: st !== "stopped" }),
          item("debug.stepInto", "Step Into", { disabled: st !== "stopped" }),
          item("debug.stepOut", "Step Out", { disabled: st !== "stopped" }),
          "-",
          item("debug.toggleBreakpoint", "Toggle Breakpoint", { disabled: !editors.active }),
          item("debug.removeAll", "Remove All Breakpoints"),
          "-",
          item("view.debug", "Run and Debug"),
          item("view.debugConsole", "Debug Console"),
          item("debug.configure", "Configure Debugger..."),
        ];
      },
    },
    {
      label: "Terminal",
      items: () => [
        item("terminal.new", "New Terminal"),
        {
          label: "New Terminal With Profile",
          submenu: () => (terminalShells.length ? terminalShells.map((s) => ({ label: s.name, action: () => terminal.create(s) })) : [{ label: "(loading…)", disabled: true }]),
        },
        "-",
        item("view.terminal", "Toggle Terminal", { checked: settings.panelVisible }),
        item("terminal.kill", "Kill Active Terminal"),
      ],
    },
    {
      label: "Extensions",
      items: () => [item("ext.install", "Install from VSIX..."), item("view.extensions", "Show Installed Extensions"), "-", item("window.reload", "Reload Window")],
    },
    {
      label: "Help",
      items: () => [item("help.welcome", "Welcome Tour"), item("view.commandPalette", "Show All Commands"), "-", item("help.checkUpdates", "Check for Updates..."), item("help.about", "About")],
    },
  ]);
}

/** App-level shortcuts, handled in the capture phase so they win over Monaco and WebView2 defaults. */
/** App commands that still work while the terminal has focus. */
const TERMINAL_PASSTHROUGH = new Set([
  "view.terminal", "terminal.new", "file.quickOpen", "view.commandPalette", "edit.findInFiles", "view.explorer",
  "build.build", "build.rebuild", "build.flash", "build.buildFlash", "view.problems",
  "view.scm", "debug.start", "debug.stop", "debug.restart", "debug.pause", "debug.stepOver", "debug.stepInto", "debug.stepOut", "view.debug", "view.debugConsole",
  "view.search", "view.extensions", "view.toggleSidebar", "go.nextTab", "go.prevTab", "go.workspaceSymbol",
  ...Array.from({ length: 9 }, (_, i) => `go.tab${i + 1}`),
]);

function installKeybindings() {
  const byKey = new Map<string, string>();
  for (const c of commands.values()) {
    // Editor-native shortcuts are handled by Monaco itself when it has focus.
    if (!c.key || c.key.includes(" ") || c.id.startsWith("edit.") || ["go.line", "go.definition", "go.peekDefinition", "go.references", "go.nextProblem"].includes(c.id)) continue;
    byKey.set(c.key.toLowerCase(), c.id);
  }
  byKey.set("ctrl+shift+f", "edit.findInFiles");
  byKey.set("ctrl+shift+b", "build.build"); // VS Code's build shortcut
  byKey.set("ctrl+shift+=", "view.zoomIn");
  let chord: string | null = null;

  window.addEventListener(
    "keydown",
    (e) => {
      if (document.querySelector(".quickpick-backdrop, .menu")) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
      if (["control", "shift", "alt", "meta"].includes(k)) return;
      // Ctrl+Shift+` arrives as "~" on US layouts.
      const key = k === "+" ? "=" : k === "~" && e.ctrlKey ? "`" : k;
      const combo = [e.ctrlKey && "ctrl", e.shiftKey && "shift", e.altKey && "alt", key].filter(Boolean).join("+");
      // Inside the terminal, keys go to the shell except a few app shortcuts (like VS Code).
      if ((e.target as HTMLElement)?.closest?.("#panel .xterm")) {
        const id = byKey.get(combo);
        if (id && TERMINAL_PASSTHROUGH.has(id)) {
          e.preventDefault();
          e.stopPropagation();
          exec(id);
        }
        return;
      }
      if (chord === "ctrl+k") {
        chord = null;
        if (combo === "ctrl+t") {
          e.preventDefault();
          e.stopPropagation();
          pickTheme();
          return;
        }
      }
      if (combo === "ctrl+k") {
        chord = combo; // Monaco also uses Ctrl+K chords, so don't swallow it
        return;
      }
      const id = byKey.get(combo);
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        exec(id);
        return;
      }
      // Swallow browser shortcuts that make no sense in an editor (reload, print, history...).
      if (["f5", "ctrl+r", "ctrl+shift+r", "ctrl+j", "ctrl+u", "f7", "ctrl+shift+i"].includes(combo) || (combo === "ctrl+h" && !editors.active)) {
        e.preventDefault();
      }
    },
    true,
  );
}

function registerLanguageFeatures() {
  const kindMap: Record<SymbolKind, monaco.languages.SymbolKind> = {
    function: monaco.languages.SymbolKind.Function,
    method: monaco.languages.SymbolKind.Method,
    class: monaco.languages.SymbolKind.Class,
    struct: monaco.languages.SymbolKind.Struct,
    enum: monaco.languages.SymbolKind.Enum,
    union: monaco.languages.SymbolKind.Struct,
    typedef: monaco.languages.SymbolKind.TypeParameter,
    macro: monaco.languages.SymbolKind.Constant,
    namespace: monaco.languages.SymbolKind.Namespace,
    label: monaco.languages.SymbolKind.Key,
    trait: monaco.languages.SymbolKind.Interface,
    module: monaco.languages.SymbolKind.Module,
  };

  monaco.languages.registerDocumentSymbolProvider("*", {
    provideDocumentSymbols: (model) =>
      editors.symbols(model).map((s) => {
        const range = new monaco.Range(s.line, s.column, s.endLine ?? s.line, s.endLine ? model.getLineMaxColumn(s.endLine) : s.column + s.name.length);
        return {
          name: s.name,
          detail: "",
          kind: kindMap[s.kind],
          tags: [],
          range,
          selectionRange: new monaco.Range(s.line, s.column, s.line, s.column + s.name.length),
        };
      }),
  });

  registerNavigation();
}

// ------------------------------------------------------------------ updates & onboarding

function startOnboarding() {
  showOnboarding({ exec, keyOf, remoteConnect });
}

function updateStatus(s: UpdateState) {
  switch (s.kind) {
    case "available":
      return statusBar.setUpdateStatus(`⇧ Update ${s.version}`, `Taara Editor ${s.version} is available — click to install`, "update-available", () => promptInstall());
    case "downloading":
      return statusBar.setUpdateStatus(`⇣ Downloading update${s.percent === null ? "…" : ` ${s.percent}%`}`, `Downloading Taara Editor ${s.version}`, "");
    case "installing":
      return statusBar.setUpdateStatus("⟳ Installing update…", `Installing Taara Editor ${s.version}; the editor restarts when done`, "");
    default:
      return statusBar.setUpdateStatus("", "", "");
  }
}

// ------------------------------------------------------------------ startup

const statusBar = new StatusBar($("statusbar"), $("breadcrumb"));

async function main() {
  await loadSettings();
  searchView.restoreState();
  await loadExtensions(); // registers extension themes before applying one
  settings.theme = await applyTheme(settings.theme);
  settings.iconTheme = await applyIconTheme(settings.iconTheme);
  onThemeScopes(() => refreshFileIcons()); // light/dark icon variants

  editors.init($("editor-host"), $("tabs"), $("welcome"));
  registerCommands();
  registerLanguageFeatures();
  initIndexing();
  onIndexStatus((text, detail) => statusBar.setIndexStatus(text, detail, () => indexWorkspace()));
  registerClangdProviders();
  statusBar.onRemoteClick(remoteMenu);
  onRemoteChange(updateRemoteStatus);
  updateRemoteStatus();
  onClangdStatus((state, text, detail) => {
    const icon = { off: "", missing: "⚠", starting: "⟳", indexing: "⟳", installing: "⇣", ready: "✓", error: "✗" }[state];
    statusBar.setClangdStatus(text ? `${icon} ${text}` : "", detail, `clangd-${state}`, clangdMenu);
  });
  statusBar.onProblemsClick(() => terminal.showView("problems"));
  onBuildStatus((text, detail, cls) => statusBar.setBuildStatus(text, detail, cls, () => terminal.showView(cls === "build-failed" ? "problems" : "terminal")));
  buildMenuBar();
  buildToolbar();
  refreshEolMarkers = installEolMarkers(editors.editor, () => settings.renderWhitespace);
  buildActivityBar();
  installKeybindings();

  outline = new Outline($("outline"), () => setOutlineVisible(false));
  dbg.initDebugEditor();
  git.initGitEditor();
  git.onGitChange(updateGitStatus);
  statusBar.onGitClick(() => branchPicker(), () => gitAction(() => git.sync()));
  createDebugToolbar($("editor-area"), debugActions);
  terminal = new TerminalPanel($("panel"), $("panel-sash"));
  terminal.onDebugCommand = (cmd) => dbg.consoleCommand(cmd);
  dbg.onDebugConsole((text, kind) => terminal.debugLog(text, kind));
  terminal.listShells().then((s) => (terminalShells = s));
  if (settings.panelVisible) terminal.show(false);
  $("sidebar").style.width = `${settings.sidebarWidth}px`;
  $("outline").style.width = `${settings.outlineWidth}px`;
  makeSash($("sidebar-sash"), () => settings.sidebarWidth, (w) => {
    settings.sidebarWidth = w;
    $("sidebar").style.width = `${w}px`;
    saveSettings();
  });
  makeSash($("outline-sash"), () => settings.outlineWidth, (w) => {
    settings.outlineWidth = w;
    $("outline").style.width = `${w}px`;
    saveSettings();
  }, true);
  showView(settings.sidebarView);
  setSidebarVisible(settings.sidebarVisible);
  setOutlineVisible(settings.outlineVisible);
  renderWelcome();

  editors.on("active", updateTitle);
  editors.on("content", updateTitle);
  editors.on("docs", () => saveSession());

  // Restore the previous session.
  const { folder, openFiles, activeFile } = settings.session;
  if (folder) await openFolder(folder, false).catch(() => {});
  else explorer.render();
  for (const f of openFiles) await editors.open(f, { focus: false }).catch(() => {});
  if (activeFile) {
    const d = editors.findByPath(activeFile);
    if (d) editors.activate(d);
  }

  if (!folder) startClangd(); // openFolder() already started it otherwise

  // Files passed on the command line / "Open with".
  const startup = await api.startupPaths().catch(() => []);
  if (startup.length) await openPaths(startup);

  statusBar.render();
  updateTitle();

  onUpdateState(updateStatus);
  initUpdater({
    beforeInstall: async () => {
      if (!(await editors.confirmAll())) return false;
      await saveSession();
      await saveSettings(true);
      return true;
    },
  });
  if (!settings.onboarded && !startup.length) startOnboarding();

  getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") openPaths(event.payload.paths);
  });

  await appWindow.onCloseRequested(async (event) => {
    if (!(await editors.confirmAll())) {
      event.preventDefault();
      return;
    }
    await saveSession();
  });

  // No browser context menu outside inputs (Monaco has its own).
  window.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest("input, textarea, .monaco-editor")) e.preventDefault();
  });
}

// Monaco rejects superseded operations (peek, hover...) with "Canceled"; not an error.
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason as Error | undefined;
  if (r?.name === "Canceled" || r?.message === "Canceled") e.preventDefault();
});

// Handle for automated UI tests over the DevTools protocol. Only in dev builds
// or builds made with VITE_TAARA_TEST=1; release builds don't contain it.
if (import.meta.env.DEV || import.meta.env.VITE_TAARA_TEST === "1") {
  (window as any).__taaraDebug = {
    editors,
    monaco,
    get terminal() {
      return terminal;
    },
  };
}

main().catch((e) => {
  console.error(e);
  message(`Taara Editor failed to start:\n\n${errorMessage(e)}`, { title: "Taara Editor", kind: "error" });
});
