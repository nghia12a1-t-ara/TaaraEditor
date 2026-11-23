// Debugger: GDB (MI) + a GDB server (ST-LINK_gdbserver / OpenOCD, or an
// already running server such as Renode / QEMU / a remote probe).
// Breakpoints in the editor gutter, step controls, variables, watch,
// call stack, hover evaluation and a debug console.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { message } from "@tauri-apps/plugin-dialog";
import { monaco } from "./monaco-setup";
import { api, errorMessage, joinPath } from "./api";
import { cstr, Gdb, type MiRecord, type MiTuple, type MiValue } from "./gdb-mi";
import { editors } from "./editor-manager";
import { parseJsonc } from "./jsonc";
import { saveSettings, settings } from "./settings";

// ------------------------------------------------------------------ types

export type DebugState = "inactive" | "starting" | "running" | "stopped";

export interface DebugConfig {
  /** "auto" (ST-LINK, then OpenOCD), "stlink", "openocd" or "none" (connect to `target`). */
  server: string;
  /** host:port of the GDB server. */
  target: string;
  gdb?: string;
  elf?: string;
  load: boolean;
  stopAtMain: boolean;
  buildFirst: boolean;
  /** Extra GDB commands after connecting (e.g. "monitor reset halt"). */
  initCommands: string[];
  serverArgs?: string[];
}

export interface Frame {
  level: number;
  func: string;
  file?: string;
  line?: number;
  addr?: string;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  /** GDB var-object name, when the variable can be expanded. */
  varobj?: string;
  /** Expression to create a var-object from (expandable locals). */
  expr?: string;
  expandable: boolean;
}

interface DebugTools {
  gdb: string | null;
  stlink_server: string | null;
  cube_programmer_dir: string | null;
  openocd: string | null;
}

type Listener = () => void;

// ------------------------------------------------------------------ state

let state: DebugState = "inactive";
let gdb: Gdb | null = null;
let serverId: number | null = null;
let frames: Frame[] = [];
let selectedFrame = 0;
let variables: Variable[] = [];
let watchValues = new Map<string, string>();
let varobjs: string[] = [];
let stopReason = "";
const listeners: Listener[] = [];
let consoleSink: (text: string, kind: "out" | "err" | "info" | "cmd") => void = () => {};

export const debugState = () => state;
export const callStack = () => frames;
export const currentFrame = () => selectedFrame;
export const localVariables = () => variables;
export const watchResults = () => watchValues;
export const lastStopReason = () => stopReason;

export function onDebugChange(l: Listener) {
  listeners.push(l);
}

export function onDebugConsole(sink: typeof consoleSink) {
  consoleSink = sink;
}

function emit() {
  listeners.forEach((l) => l());
}

function setState(s: DebugState) {
  state = s;
  document.documentElement.classList.toggle("debugging", s !== "inactive");
  emit();
}

const log = (text: string, kind: "out" | "err" | "info" | "cmd" = "info") => consoleSink(text, kind);
const str = (v: MiValue | undefined) => (typeof v === "string" ? v : "");

// ------------------------------------------------------------------ configuration

// 127.0.0.1, not "localhost": on Windows localhost may resolve to IPv6 (::1)
// while GDB servers usually listen on IPv4 only.
const DEFAULTS: DebugConfig = { server: "auto", target: "127.0.0.1:3333", load: true, stopAtMain: true, buildFirst: true, initCommands: [] };

export async function debugConfig(): Promise<DebugConfig> {
  const root = settings.session.folder;
  if (!root) return { ...DEFAULTS };
  try {
    const text = (await api.readTextFile(joinPath(joinPath(root, ".taara"), "tasks.json"))).content;
    const d = parseJsonc<{ debug?: Partial<DebugConfig> }>(text).debug ?? {};
    return { ...DEFAULTS, ...d, initCommands: d.initCommands ?? [] };
  } catch {
    return { ...DEFAULTS };
  }
}

// ------------------------------------------------------------------ breakpoints

/** Breakpoints are model decorations, so they stay with their file and move with edits. */
const bpDecorations = new Map<monaco.editor.ITextModel, string[]>();
/** gdb breakpoint number by "path|line" while debugging. */
const gdbBreakpoints = new Map<string, string>();

const bpKey = (path: string) => path.toLowerCase();

function storedLines(path: string): number[] {
  return settings.breakpoints[bpKey(path)]?.lines ?? [];
}

function setModelBreakpoints(model: monaco.editor.ITextModel, lines: number[]) {
  if (!bpDecorations.has(model)) model.onWillDispose(() => bpDecorations.delete(model));
  bpDecorations.set(model, model.deltaDecorations(bpDecorations.get(model) ?? [], lines.map((l) => bpDecoration(l))));
}

function bpDecoration(line: number, verified = true): monaco.editor.IModelDeltaDecoration {
  return {
    range: new monaco.Range(line, 1, line, 1),
    options: {
      glyphMarginClassName: verified ? "debug-bp" : "debug-bp unverified",
      glyphMarginHoverMessage: { value: verified ? "Breakpoint" : "Breakpoint (not bound yet)" },
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  };
}

/** Current breakpoint lines of a model (follows edits). */
function modelLines(model: monaco.editor.ITextModel): number[] {
  const ids = bpDecorations.get(model) ?? [];
  const lines = ids.map((id) => model.getDecorationRange(id)?.startLineNumber).filter((l): l is number => !!l);
  return [...new Set(lines)].sort((a, b) => a - b);
}

function persist(path: string, lines: number[]) {
  if (lines.length) settings.breakpoints[bpKey(path)] = { path, lines };
  else delete settings.breakpoints[bpKey(path)];
  saveSettings();
  emit();
}

/** Show stored breakpoints on a freshly opened model. */
function restoreDecorations(model: monaco.editor.ITextModel) {
  const path = modelPath(model);
  if (!path) return;
  const lines = storedLines(path);
  if (lines.length) setModelBreakpoints(model, lines);
}

function modelPath(model: monaco.editor.ITextModel): string | null {
  return editors.docs.find((d) => d.model === model)?.path ?? (model.uri.scheme === "file" ? model.uri.fsPath : null);
}

export async function toggleBreakpoint(model = editors.active?.model, line = editors.editor.getPosition()?.lineNumber) {
  if (!model || !line) return;
  const path = modelPath(model);
  if (!path) return;
  const lines = modelLines(model);
  const has = lines.includes(line);
  const next = has ? lines.filter((l) => l !== line) : [...lines, line].sort((a, b) => a - b);
  setModelBreakpoints(model, next);
  persist(path, next);
  if (gdb && state !== "inactive") {
    const key = `${bpKey(path)}|${line}`;
    if (has) {
      const num = gdbBreakpoints.get(key);
      if (num) {
        gdbBreakpoints.delete(key);
        await withTargetPaused(() => gdb!.send(`-break-delete ${num}`)).catch(() => {});
      }
    } else {
      await withTargetPaused(() => insertBreakpoint(path, line)).catch(() => {});
    }
  }
}

export function allBreakpoints(): { path: string; line: number }[] {
  const out: { path: string; line: number }[] = [];
  for (const { path, lines } of Object.values(settings.breakpoints)) for (const line of lines) out.push({ path, line });
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

export async function removeBreakpoint(path: string, line: number) {
  const doc = editors.findByPath(path);
  if (doc) return toggleBreakpoint(doc.model, line);
  persist(path, storedLines(path).filter((l) => l !== line));
}

export function removeAllBreakpoints() {
  for (const model of [...bpDecorations.keys()]) setModelBreakpoints(model, []);
  settings.breakpoints = {};
  saveSettings();
  if (gdb && state !== "inactive") {
    withTargetPaused(() => gdb!.send("-break-delete")).catch(() => {});
    gdbBreakpoints.clear();
  }
  emit();
}

async function insertBreakpoint(path: string, line: number) {
  const loc = `${path.replace(/\\/g, "/")}:${line}`;
  try {
    const r = await gdb!.send(`-break-insert -f ${cstr(loc)}`);
    const bkpt = r.data.bkpt as MiTuple;
    gdbBreakpoints.set(`${bpKey(path)}|${line}`, str(bkpt?.number));
  } catch (e) {
    log(`Breakpoint ${loc}: ${errorMessage(e)}\n`, "err");
  }
}

/** Breakpoints can only be changed while the target is halted (no mi-async on all servers). */
async function withTargetPaused<T>(fn: () => Promise<T>): Promise<T> {
  if (state !== "running") return fn();
  await gdb!.send("-exec-interrupt").catch(() => {});
  await waitFor(() => state === "stopped", 3000);
  const r = await fn();
  await gdb!.send("-exec-continue").catch(() => {});
  return r;
}

function waitFor(cond: () => boolean, ms: number) {
  return new Promise<void>((resolve) => {
    const t0 = Date.now();
    const tick = () => (cond() || Date.now() - t0 > ms ? resolve() : setTimeout(tick, 50));
    tick();
  });
}

// ------------------------------------------------------------------ current line

let currentLine: { model: monaco.editor.ITextModel; ids: string[] } | null = null;

function clearCurrentLine() {
  if (currentLine && !currentLine.model.isDisposed()) currentLine.model.deltaDecorations(currentLine.ids, []);
  currentLine = null;
}

async function showLocation(file: string | undefined, line: number | undefined) {
  clearCurrentLine();
  if (!file || !line) return;
  const doc = await editors.open(file, { line, focus: false });
  if (!doc) return;
  const ids = doc.model.deltaDecorations(
    [],
    [
      {
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: "debug-current-line", glyphMarginClassName: "debug-current-arrow", stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      },
    ],
  );
  currentLine = { model: doc.model, ids };
  editors.editor.revealLineInCenterIfOutsideViewport(line);
}

// ------------------------------------------------------------------ session

async function startServer(cfg: DebugConfig, tools: DebugTools, device: string | null): Promise<{ target: string; init: string[] }> {
  let kind = cfg.server;
  if (kind === "auto") kind = tools.stlink_server && tools.cube_programmer_dir ? "stlink" : tools.openocd ? "openocd" : "none";
  if (kind === "none") return { target: cfg.target, init: cfg.initCommands };

  let command: string;
  let args: string[];
  let ready: RegExp;
  let target: string;
  let init: string[];
  if (kind === "stlink") {
    if (!tools.stlink_server || !tools.cube_programmer_dir) throw new Error("ST-LINK_gdbserver was not found (install STM32CubeIDE or STM32CubeProgrammer).");
    command = tools.stlink_server;
    args = cfg.serverArgs ?? ["-p", "61234", "-l", "1", "-d", "-s", "-cp", tools.cube_programmer_dir, "-m", "0", "-k"];
    ready = /Waiting for debugger connection|Listening at/i;
    target = "127.0.0.1:61234";
    init = ["monitor reset", ...cfg.initCommands];
  } else if (kind === "openocd") {
    if (!tools.openocd) throw new Error("OpenOCD was not found in PATH.");
    const fam = (device ?? "STM32F4").slice(5, 7).toLowerCase();
    command = tools.openocd;
    args = cfg.serverArgs ?? ["-f", "interface/stlink.cfg", "-f", `target/stm32${fam}${fam === "l0" || fam === "l1" ? "" : "x"}.cfg`];
    ready = /Listening on port \d+ for gdb/i;
    target = "127.0.0.1:3333";
    init = ["monitor reset halt", ...cfg.initCommands];
  } else {
    throw new Error(`Unknown debug server "${kind}" (use auto, stlink, openocd or none).`);
  }

  log(`> ${command} ${args.join(" ")}\n`, "cmd");
  let readyHit = false;
  let exited: number | null | undefined;
  const un1 = await listen<{ id: number; line: string }>("proc://line", (e) => {
    if (e.payload.id !== serverId) return;
    log(e.payload.line + "\n", "out");
    if (ready.test(e.payload.line)) readyHit = true;
  });
  const un2 = await listen<{ id: number; code: number | null }>("proc://exit", (e) => {
    if (e.payload.id !== serverId) return;
    exited = e.payload.code;
    log(`GDB server exited (${e.payload.code}).\n`, "err");
    if (state !== "inactive") stopDebugging();
  });
  serverListeners = [un1, un2];
  serverId = await invoke<number>("proc_start", { command, args, cwd: settings.session.folder });
  await waitFor(() => readyHit || exited !== undefined, 15000);
  if (exited !== undefined) throw new Error("The GDB server stopped. Is the board connected and powered? See the Debug Console.");
  return { target, init };
}

let serverListeners: (() => void)[] = [];

export async function startDebugging(buildFirstFn?: () => Promise<boolean>) {
  if (state !== "inactive") return;
  const root = settings.session.folder;
  if (!root) return void message("Open a project folder first.", { title: "Debug", kind: "info" });
  if (root.startsWith("ssh://")) return void message("Debugging is available for local folders only.", { title: "Debug", kind: "info" });
  setState("starting");
  frames = [];
  variables = [];
  try {
    const cfg = await debugConfig();
    if (cfg.buildFirst && buildFirstFn && !(await buildFirstFn())) {
      setState("inactive");
      return;
    }
    const tools = await invoke<DebugTools>("debug_tools");
    const gdbPath = cfg.gdb || tools.gdb;
    if (!gdbPath) throw new Error("arm-none-eabi-gdb was not found (install the Arm GNU toolchain, STM32CubeIDE or EIDE).");
    const elf = cfg.elf ? joinPath(root, cfg.elf) : await invoke<string | null>("task_find_artifact", { root, ext: "elf" });
    if (!elf) throw new Error("No .elf file was found. Build the project first.");
    const taskCfg = await invoke<{ device: string | null }>("task_config", { root }).catch(() => ({ device: null }));

    const { target, init } = await startServer(cfg, tools, taskCfg.device);
    log(`> ${gdbPath} ${elf}\n`, "cmd");
    gdb = await Gdb.start(gdbPath, [], root);
    gdb.onStream = (kind, text) => {
      // Harmless noise from Windows GDB builds without iconv (values are still correct).
      if (/could not convert '.*' from the host encoding|This normally should not happen, please file a bug report/.test(text)) return;
      log(text, kind === "&" ? "err" : "out");
    };
    gdb.onAsync = onAsync;
    gdb.onExit = () => {
      if (state !== "inactive") {
        log("GDB exited.\n", "err");
        stopDebugging();
      }
    };
    await gdb.send("-gdb-set confirm off");
    await gdb.send("-gdb-set pagination off");
    await gdb.send(`-file-exec-and-symbols ${cstr(elf.replace(/\\/g, "/"))}`);
    log(`Connecting to ${target}…\n`, "info");
    await gdb.send(`-target-select remote ${target}`, 20000);
    for (const c of init) await gdb.console(c).catch((e) => log(`${c}: ${errorMessage(e)}\n`, "err"));
    if (cfg.load) {
      log("Loading program…\n", "info");
      await gdb.send("-target-download", 120000);
    }
    gdbBreakpoints.clear();
    for (const bp of allBreakpoints()) await insertBreakpoint(bp.path, bp.line);
    if (cfg.stopAtMain) await gdb.send("-break-insert -t main").catch(() => {});
    setState("running");
    await gdb.send("-exec-continue");
  } catch (e) {
    log(`${errorMessage(e)}\n`, "err");
    await stopDebugging();
    await message(`Could not start debugging:\n\n${errorMessage(e)}`, { title: "Debug", kind: "error" });
  }
}

export async function stopDebugging() {
  if (state === "inactive" && !gdb && serverId === null) return;
  const g = gdb;
  gdb = null;
  setState("inactive");
  clearCurrentLine();
  frames = [];
  variables = [];
  watchValues = new Map();
  varobjs = [];
  if (g) await g.kill();
  if (serverId !== null) await invoke("proc_kill", { id: serverId }).catch(() => {});
  serverId = null;
  serverListeners.forEach((u) => u());
  serverListeners = [];
  emit();
}

export async function restartDebugging(buildFirstFn?: () => Promise<boolean>) {
  await stopDebugging();
  await startDebugging(buildFirstFn);
}

async function exec(cmd: string) {
  if (!gdb || state !== "stopped") return;
  clearCurrentLine();
  setState("running");
  try {
    await gdb.send(cmd);
  } catch (e) {
    log(`${errorMessage(e)}\n`, "err");
    setState("stopped");
  }
}

export const continueExecution = () => exec("-exec-continue");
export const stepOver = () => exec("-exec-next");
export const stepInto = () => exec("-exec-step");
export const stepOut = () => exec("-exec-finish");
export async function pauseExecution() {
  if (gdb && state === "running") await gdb.send("-exec-interrupt").catch((e) => log(`${errorMessage(e)}\n`, "err"));
}

// ------------------------------------------------------------------ stops

function onAsync(r: MiRecord) {
  if (r.kind === "*" && r.cls === "running") {
    if (state !== "inactive") setState("running");
  } else if (r.kind === "*" && r.cls === "stopped") {
    const reason = str(r.data.reason);
    if (reason.startsWith("exited")) {
      log(`Program exited (${reason}).\n`, "info");
      stopDebugging();
      return;
    }
    stopReason = reason.replace(/-/g, " ") || "paused";
    onStopped(r.data.frame as MiTuple | undefined);
  }
}

async function onStopped(frame?: MiTuple) {
  setState("stopped");
  selectedFrame = 0;
  await refreshStack();
  const f = frames[0] ?? (frame ? toFrame(frame) : undefined);
  await showLocation(f?.file, f?.line);
  await refreshScopes();
}

function toFrame(t: MiTuple): Frame {
  const full = str(t.fullname) || str(t.file);
  return {
    level: Number(str(t.level) || 0),
    func: str(t.func) || "??",
    file: full ? full.replace(/\//g, "\\") : undefined,
    line: t.line ? Number(str(t.line)) : undefined,
    addr: str(t.addr),
  };
}

async function refreshStack() {
  if (!gdb) return;
  try {
    const r = await gdb.send("-stack-list-frames 0 50");
    frames = ((r.data.stack as MiValue[]) ?? []).map((x) => toFrame((x as MiTuple).frame as MiTuple));
  } catch {
    frames = [];
  }
}

async function deleteVarobjs() {
  const old = varobjs;
  varobjs = [];
  for (const v of old) await gdb?.send(`-var-delete ${v}`).catch(() => {});
}

async function refreshScopes() {
  if (!gdb) return;
  await deleteVarobjs();
  try {
    const r = await gdb.send(`-stack-list-variables --thread 1 --frame ${selectedFrame} --simple-values`);
    variables = ((r.data.variables as MiValue[]) ?? []).map((x) => {
      const v = x as MiTuple;
      const hasValue = v.value !== undefined;
      return { name: str(v.name), value: hasValue ? str(v.value) : "{…}", type: str(v.type), expr: str(v.name), expandable: !hasValue || /\*\s*$/.test(str(v.type)) };
    });
  } catch {
    variables = [];
  }
  const values = new Map<string, string>();
  for (const w of settings.watch) values.set(w, await evaluate(w));
  watchValues = values;
  emit();
}

export async function selectFrame(level: number) {
  if (!gdb || state !== "stopped") return;
  selectedFrame = level;
  await gdb.send(`-stack-select-frame ${level}`).catch(() => {});
  const f = frames.find((x) => x.level === level);
  await showLocation(f?.file, f?.line);
  await refreshScopes();
}

/** Children of an expandable variable (creates a GDB var-object on demand). */
export async function expandVariable(v: Variable): Promise<Variable[]> {
  if (!gdb || state !== "stopped") return [];
  try {
    let name = v.varobj;
    if (!name) {
      const r = await gdb.send(`-var-create - * ${cstr(v.expr ?? v.name)}`);
      name = str(r.data.name);
      varobjs.push(name);
      v.varobj = name;
    }
    const r = await gdb.send(`-var-list-children --all-values ${name} 0 500`);
    const kids = ((r.data.children as MiValue[]) ?? []).map((x) => (x as MiTuple).child as MiTuple);
    const out: Variable[] = [];
    for (const c of kids) {
      const exp = str(c.exp);
      // public / private / protected pseudo-children of C++ classes: flatten.
      if (["public", "private", "protected"].includes(exp)) {
        out.push(...(await expandVariable({ name: exp, value: "", varobj: str(c.name), expandable: true })));
        continue;
      }
      out.push({ name: exp, value: str(c.value) || (Number(str(c.numchild)) > 0 ? "{…}" : ""), type: str(c.type), varobj: str(c.name), expandable: Number(str(c.numchild)) > 0 });
    }
    return out;
  } catch (e) {
    return [{ name: "error", value: errorMessage(e), expandable: false }];
  }
}

export async function evaluate(expr: string): Promise<string> {
  if (!gdb || state !== "stopped") return "";
  try {
    const r = await gdb.send(`-data-evaluate-expression --frame ${selectedFrame} --thread 1 ${cstr(expr)}`);
    return str(r.data.value);
  } catch (e) {
    return `<${errorMessage(e)}>`;
  }
}

export async function setVariable(v: Variable, value: string) {
  if (!gdb || state !== "stopped") return;
  try {
    if (v.varobj) await gdb.send(`-var-assign ${v.varobj} ${cstr(value)}`);
    else await gdb.send(`-data-evaluate-expression ${cstr(`${v.expr ?? v.name}=${value}`)}`);
  } catch (e) {
    log(`${errorMessage(e)}\n`, "err");
  }
  await refreshScopes();
}

export function addWatch(expr: string) {
  if (!expr.trim() || settings.watch.includes(expr.trim())) return;
  settings.watch = [...settings.watch, expr.trim()];
  saveSettings();
  if (state === "stopped") evaluate(expr.trim()).then((v) => (watchValues.set(expr.trim(), v), emit()));
  else emit();
}

export function removeWatch(expr: string) {
  settings.watch = settings.watch.filter((w) => w !== expr);
  saveSettings();
  emit();
}

/** Run a command typed in the Debug Console (GDB CLI syntax). */
export async function consoleCommand(cmd: string) {
  log(`> ${cmd}\n`, "cmd");
  if (!gdb) return log("No debug session.\n", "err");
  try {
    await gdb.console(cmd);
    if (state === "stopped") await refreshScopes();
  } catch (e) {
    log(`${errorMessage(e)}\n`, "err");
  }
}

// ------------------------------------------------------------------ editor integration

export function initDebugEditor() {
  editors.updateOptions({ glyphMargin: true });
  // Click in the glyph margin (or line numbers) toggles a breakpoint.
  editors.editor.onMouseDown((e) => {
    const t = e.target.type;
    if ((t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || t === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) && e.target.position) {
      toggleBreakpoint(editors.active?.model, e.target.position.lineNumber);
    }
  });
  // Persist moved breakpoints when the file is saved.
  editors.onSaved((path) => {
    const doc = editors.findByPath(path);
    if (doc && bpDecorations.has(doc.model)) persist(path, modelLines(doc.model));
  });
  monaco.editor.onDidCreateModel((m) => setTimeout(() => restoreDecorations(m), 0));
  monaco.editor.getModels().forEach(restoreDecorations);

  // Hover shows values while stopped.
  for (const lang of ["c", "cpp", "asm", "arm"]) {
    monaco.languages.registerHoverProvider(lang, {
      async provideHover(model, position) {
        if (state !== "stopped") return null;
        const w = model.getWordAtPosition(position);
        if (!w) return null;
        // Include member access chains like led.state / p->x.
        const line = model.getLineContent(position.lineNumber);
        let start = w.startColumn - 1;
        while (start > 0 && /[\w.>\-[\]]/.test(line[start - 1]) && !(line[start - 1] === "-" && line[start] !== ">")) start--;
        const expr = line.slice(start, w.endColumn - 1).replace(/^[.\->]+/, "");
        const value = await evaluate(expr);
        if (!value || value.startsWith("<")) return null;
        return { range: new monaco.Range(position.lineNumber, start + 1, position.lineNumber, w.endColumn), contents: [{ value: "```c\n" + `${expr} = ${value}` + "\n```" }] };
      },
    });
  }
}

