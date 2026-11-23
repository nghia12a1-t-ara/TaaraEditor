// Build / Rebuild / Clean / Flash for the open folder. Commands come from the
// Rust side (src-tauri/src/tasks.rs: .taara/tasks.json or auto-detected) and
// run in the terminal panel; compiler errors become Problems.
import { invoke } from "@tauri-apps/api/core";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { errorMessage } from "./api";
import { editors } from "./editor-manager";
import { clearBuildProblems, parseCompilerOutput, setBuildProblems } from "./problems";
import { settings } from "./settings";
import type { TaskResult, TerminalPanel } from "./ui/terminal-panel";

export interface TaskConfig {
  system: string;
  cwd: string;
  build: string | null;
  rebuild: string | null;
  clean: string | null;
  flash: string | null;
  flash_tool: string | null;
  device: string | null;
  notes: string[];
}

export type TaskKind = "build" | "rebuild" | "clean" | "flash";
const LABEL: Record<TaskKind, string> = { build: "Build", rebuild: "Rebuild", clean: "Clean", flash: "Flash" };

type StatusListener = (text: string, detail: string, cls: string) => void;
let statusListener: StatusListener = () => {};
let running: TaskKind | null = null;

export function onBuildStatus(l: StatusListener) {
  statusListener = l;
}

export function taskConfig(): Promise<TaskConfig | null> {
  const root = settings.session.folder;
  return root ? invoke<TaskConfig>("task_config", { root }) : Promise.resolve(null);
}

export function describeConfig(c: TaskConfig): string {
  const line = (k: string, v: string | null) => `${k}: ${v ?? "(not available)"}`;
  return [
    `Detected from: ${c.system}`,
    c.device ? `Device: ${c.device}` : "",
    `Working folder: ${c.cwd}`,
    "",
    line("Build", c.build),
    line("Rebuild", c.rebuild),
    line("Clean", c.clean),
    line("Flash", c.flash),
    c.flash_tool ? `Flash tool: ${c.flash_tool}` : "",
    "",
    ...c.notes,
  ]
    .filter((l, i, a) => l || (a[i - 1] && a[i - 1] !== ""))
    .join("\n");
}

/** Replace ${elf} / ${bin} / ${hex} with the newest build output. */
async function resolveArtifacts(cmd: string, root: string): Promise<string | null> {
  let out = cmd;
  for (const ext of ["elf", "bin", "hex"]) {
    const token = "${" + ext + "}";
    if (!out.includes(token)) continue;
    const file = await invoke<string | null>("task_find_artifact", { root, ext });
    if (!file) {
      await message(`No .${ext} file was found in the project. Build the project first.`, { title: "Flash", kind: "warning" });
      return null;
    }
    out = out.split(token).join(file);
  }
  return out;
}

export async function configureTasks() {
  const root = settings.session.folder;
  if (!root) return;
  try {
    const path = await invoke<string>("task_init_config", { root });
    await editors.open(path);
  } catch (e) {
    message(errorMessage(e), { title: "Build tasks", kind: "error" });
  }
}

/** Run a task. Returns the result, or null if it did not start. */
export async function runTask(kind: TaskKind, terminal: TerminalPanel): Promise<TaskResult | null> {
  const root = settings.session.folder;
  if (!root) {
    await message("Open a project folder first (File > Open Folder).", { title: LABEL[kind], kind: "info" });
    return null;
  }
  if (running) {
    await message(`${LABEL[running]} is already running.`, { title: LABEL[kind], kind: "info" });
    return null;
  }
  if (root.startsWith("ssh://")) {
    await message(`${LABEL[kind]} runs on this PC and is not available for remote (SSH) folders yet.\n\nRun your build command in the terminal instead (Ctrl+\`): it opens a shell on the remote host.`, { title: LABEL[kind], kind: "info" });
    return null;
  }
  const cfg = await taskConfig().catch(() => null);
  let cmd = cfg?.[kind] ?? null;
  if (!cfg || !cmd) {
    const why = cfg ? describeConfig(cfg) : "";
    const ok = await ask(
      `Taara does not know how to ${LABEL[kind].toLowerCase()} this project.\n\n${why}\n\nCreate .taara/tasks.json to set the commands?`,
      { title: LABEL[kind], kind: "warning", okLabel: "Configure", cancelLabel: "Cancel" },
    );
    if (ok) configureTasks();
    return null;
  }
  if (kind !== "flash") await editors.saveAll(); // like Keil / CubeIDE
  if (kind === "flash") {
    const resolved = await resolveArtifacts(cmd, root);
    if (!resolved) return null;
    cmd = resolved;
  }

  running = kind;
  statusListener(`⚙ ${LABEL[kind]}…`, cmd, "build-running");
  if (kind !== "flash") clearBuildProblems();
  const started = performance.now();
  let result: TaskResult;
  try {
    result = await terminal.runTask(LABEL[kind], cmd, cfg.cwd);
  } finally {
    running = null;
  }
  const secs = ((performance.now() - started) / 1000).toFixed(1);

  if (kind === "build" || kind === "rebuild") {
    const problems = parseCompilerOutput(result.lines, cfg.cwd);
    setBuildProblems(problems);
    const errors = problems.filter((p) => p.severity === "error").length;
    const warnings = problems.filter((p) => p.severity === "warning").length;
    if (result.code === 0) {
      statusListener(`✓ Build OK${warnings ? ` (${warnings} warning${warnings > 1 ? "s" : ""})` : ""}`, `${LABEL[kind]} succeeded in ${secs} s`, "build-ok");
    } else if (result.code === null) {
      statusListener("Build stopped", "The build was cancelled", "");
    } else {
      statusListener(`✗ Build failed${errors ? ` (${errors} error${errors > 1 ? "s" : ""})` : ""}`, `${LABEL[kind]} failed with exit code ${result.code}. Click to show problems.`, "build-failed");
    }
  } else if (kind === "flash") {
    statusListener(result.code === 0 ? "✓ Flashed" : "✗ Flash failed", result.code === 0 ? `Flashed in ${secs} s` : `Flash failed with exit code ${result.code}`, result.code === 0 ? "build-ok" : "build-failed");
  } else {
    statusListener(result.code === 0 ? "✓ Cleaned" : "✗ Clean failed", "", result.code === 0 ? "" : "build-failed");
  }
  return result;
}

/** Build, then flash when the build succeeded. */
export async function buildAndFlash(terminal: TerminalPanel) {
  const r = await runTask("build", terminal);
  if (r?.code === 0) await runTask("flash", terminal);
}
