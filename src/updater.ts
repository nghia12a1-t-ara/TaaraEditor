// Automatic updates from GitHub Releases (tauri-plugin-updater).
//
// The release workflow publishes `latest.json` + a signed NSIS installer; the
// app checks it a few seconds after startup (unless disabled) and on demand
// from Help > Check for Updates. Installing saves the session, stops child
// processes, then runs the installer in passive mode, which restarts the app.
import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { saveSettings, settings } from "./settings";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "installing"; version: string };

const RELEASES_URL = "https://github.com/nghia12a1-t-ara/TaaraEditor/releases";

let state: UpdateState = { kind: "idle" };
let pending: Update | null = null;
const listeners: ((s: UpdateState) => void)[] = [];

export function onUpdateState(l: (s: UpdateState) => void) {
  listeners.push(l);
}

function set(s: UpdateState) {
  state = s;
  listeners.forEach((l) => l(s));
}

export interface UpdateHooks {
  /** Ask to save dirty editors and persist the session; false cancels the install. */
  beforeInstall: () => Promise<boolean>;
}

let hooks: UpdateHooks = { beforeInstall: async () => true };

export function initUpdater(h: UpdateHooks) {
  hooks = h;
  // Dev builds are always "older" than the last release: don't nag.
  if (settings.update.checkOnStartup && !import.meta.env.DEV) {
    window.setTimeout(() => checkForUpdates(false), 5000);
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Check the release feed. `manual` (Help menu) reports "up to date" and errors;
 * the startup check stays silent and only lights up the status bar item.
 */
export async function checkForUpdates(manual: boolean): Promise<void> {
  if (state.kind === "downloading" || state.kind === "installing" || state.kind === "checking") return;
  set({ kind: "checking" });
  let update: Update | null = null;
  try {
    update = await check({ timeout: 30000 });
  } catch (e) {
    set({ kind: "idle" });
    if (manual) {
      const text = errorText(e);
      // The feed is the latest *published* GitHub release: none yet (or offline) gives this error.
      const detail = /valid release JSON/i.test(text) ? `No published release was found at ${RELEASES_URL}, or GitHub could not be reached.` : text;
      message(`Could not check for updates.\n\n${detail}`, { title: "Check for Updates", kind: "warning" });
    }
    return;
  }
  if (!update) {
    set({ kind: "idle" });
    if (manual) message("You are using the latest version of Taara Editor.", { title: "Check for Updates", kind: "info" });
    return;
  }
  await pending?.close().catch(() => {});
  pending = update;
  if (!manual && update.version === settings.update.skipVersion) {
    set({ kind: "idle" });
    return;
  }
  set({ kind: "available", version: update.version });
  if (manual) await promptInstall();
}

/** Show what's new and offer to install (status bar click or manual check). */
export async function promptInstall(): Promise<void> {
  const update = pending;
  if (!update) return checkForUpdates(true);
  const notes = (update.body ?? "").trim();
  const shown = notes.length > 1200 ? `${notes.slice(0, 1200)}…` : notes;
  const INSTALL = "Install and Restart";
  const SKIP = "Skip This Version";
  const answer = await message(
    `Taara Editor ${update.version} is available — you have ${update.currentVersion}.${shown ? `\n\nWhat's new:\n${shown}` : ""}`,
    { title: "Update Available", kind: "info", buttons: { yes: INSTALL, no: SKIP, cancel: "Later" } },
  );
  if (answer === "Yes" || answer === INSTALL) {
    await install(update);
  } else if (answer === "No" || answer === SKIP) {
    settings.update.skipVersion = update.version;
    saveSettings();
    set({ kind: "idle" });
  }
}

async function install(update: Update) {
  if (!(await hooks.beforeInstall())) return;
  const version = update.version;
  let total = 0;
  let done = 0;
  set({ kind: "downloading", version, percent: null });
  try {
    await update.download((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        done += ev.data.chunkLength;
        set({ kind: "downloading", version, percent: total ? Math.min(100, Math.round((done / total) * 100)) : null });
      }
    });
    set({ kind: "installing", version });
    await invoke("stop_child_processes").catch(() => {});
    // Windows: launches the installer (passive mode, restarts the app) and exits.
    await update.install();
  } catch (e) {
    set({ kind: "available", version });
    message(`The update could not be installed:\n\n${errorText(e)}`, { title: "Update Failed", kind: "error" });
  }
}
