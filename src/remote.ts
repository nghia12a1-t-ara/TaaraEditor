// Remote SSH (front end). Remote files are addressed as
//   ssh://<host alias>/<absolute path on the host>
// and routed by api.ts to the Rust side (src-tauri/src/remote.rs).
import { invoke } from "@tauri-apps/api/core";
import { ask, message } from "@tauri-apps/plugin-dialog";
import type { DirEntry, FileMatches, SearchOptions, SearchResult, TextFile } from "./api";
import { showInputBox } from "./ui/quickpick";

export interface RemoteConn {
  id: number;
  label: string;
  user: string;
  host: string;
  home: string;
  auth: string;
}

export interface HostConfig {
  alias: string;
  hostname: string;
  user: string | null;
  port: number;
}

const conns = new Map<string, RemoteConn>();
const connecting = new Map<string, Promise<RemoteConn>>();
const listeners: (() => void)[] = [];

export function onRemoteChange(l: () => void) {
  listeners.push(l);
}

export function connections(): RemoteConn[] {
  return [...conns.values()];
}

export const isRemote = (p: string | null | undefined): p is string => !!p && p.startsWith("ssh://");

/** ssh://alias/abs/path -> { label: "alias", path: "/abs/path" } */
export function splitRemote(p: string): { label: string; path: string } {
  const rest = p.slice("ssh://".length);
  const slash = rest.indexOf("/");
  const label = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
  const path = slash < 0 ? "/" : rest.slice(slash) || "/";
  return { label, path };
}

export function remotePath(label: string, path: string): string {
  return `ssh://${encodeURIComponent(label)}${path.startsWith("/") ? path : "/" + path}`;
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ------------------------------------------------------------------ connecting

/**
 * Connect to `target` (alias from ~/.ssh/config or user@host[:port]),
 * asking for host key confirmation / password / passphrase when needed.
 */
export function connect(target: string): Promise<RemoteConn> {
  const existing = conns.get(target);
  if (existing) return Promise.resolve(existing);
  let p = connecting.get(target);
  if (!p) {
    p = doConnect(target).finally(() => connecting.delete(target));
    connecting.set(target, p);
  }
  return p;
}

async function doConnect(target: string): Promise<RemoteConn> {
  let password: string | null = null;
  let passphrase: string | null = null;
  let acceptHostKey = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const c = await invoke<RemoteConn>("ssh_connect", { target, password, passphrase, acceptHostKey });
      conns.set(target, c);
      listeners.forEach((l) => l());
      return c;
    } catch (e) {
      const [kind, ...rest] = String(e).split("|");
      if (kind === "UNKNOWN_HOST") {
        const [algo, fp] = rest;
        const ok = await ask(
          `The authenticity of host '${target}' can't be established.\n\n${algo} key fingerprint is:\n${fp}\n\nAre you sure you want to continue connecting? The key will be added to ~/.ssh/known_hosts.`,
          { title: "Remote SSH", kind: "warning", okLabel: "Continue", cancelLabel: "Cancel" },
        );
        if (!ok) throw new Error("Host key not accepted");
        acceptHostKey = true;
      } else if (kind === "KEY_CHANGED") {
        const [line, fp] = rest;
        await message(
          `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED for '${target}'!\n\nSomeone could be eavesdropping on you right now (man-in-the-middle attack), or the host key has just been changed.\n\nThe new key fingerprint is:\n${fp}\n\nIf the change is expected, remove line ${line} of ~/.ssh/known_hosts and connect again.`,
          { title: "Remote SSH", kind: "error" },
        );
        throw new Error("Host key changed");
      } else if (kind === "NEED_PASSWORD" || kind === "AUTH_FAILED") {
        const pw = await showInputBox({
          prompt: kind === "AUTH_FAILED" ? `Permission denied, please try again. Password for ${target}` : `Password for ${target} (no SSH key was accepted)`,
          password: true,
        });
        if (pw === null) throw new Error("Cancelled");
        password = pw;
      } else if (kind === "NEED_PASSPHRASE") {
        const pp = await showInputBox({ prompt: `Passphrase for key ${rest.join("|")}`, password: true });
        if (pp === null) throw new Error("Cancelled");
        passphrase = pp;
      } else {
        throw new Error(rest.length ? rest.join("|") : String(e));
      }
    }
  }
  throw new Error("Too many attempts");
}

export async function disconnect(label: string) {
  const c = conns.get(label);
  if (!c) return;
  conns.delete(label);
  listeners.forEach((l) => l());
  await invoke("ssh_disconnect", { id: c.id }).catch(() => {});
}

async function connFor(p: string) {
  const { label, path } = splitRemote(p);
  return { conn: await connect(label), path, label };
}

export function listHosts() {
  return invoke<HostConfig[]>("ssh_hosts");
}

// ------------------------------------------------------------------ file system

export const remoteFs = {
  async readTextFile(p: string): Promise<TextFile> {
    const { conn, path } = await connFor(p);
    return invoke<TextFile>("ssh_read_file", { id: conn.id, path });
  },
  async writeTextFile(p: string, content: string, encoding: string) {
    const { conn, path } = await connFor(p);
    return invoke<void>("ssh_write_file", { id: conn.id, path, content, encoding });
  },
  async readDir(p: string): Promise<DirEntry[]> {
    const { conn, path, label } = await connFor(p);
    const list = await invoke<DirEntry[]>("ssh_read_dir", { id: conn.id, path });
    return list.map((e) => ({ ...e, path: remotePath(label, e.path) }));
  },
  async createFile(p: string) {
    const { conn, path } = await connFor(p);
    return invoke<void>("ssh_create_file", { id: conn.id, path });
  },
  async createDir(p: string) {
    const { conn, path } = await connFor(p);
    return invoke<void>("ssh_create_dir", { id: conn.id, path });
  },
  async rename(from: string, to: string) {
    const a = await connFor(from);
    return invoke<void>("ssh_rename", { id: a.conn.id, from: a.path, to: splitRemote(to).path });
  },
  async exec(p: string, command: string) {
    const { conn } = await connFor(p);
    return invoke<{ code: number | null; stdout: string; stderr: string }>("ssh_exec", { id: conn.id, command });
  },

  /** Quick Open: all files under the folder (skips .git / node_modules). */
  async listFiles(root: string, max = 20000): Promise<string[]> {
    const { path, label } = splitRemote(root);
    const cmd = `cd ${shQuote(path)} && find . \\( -name .git -o -name node_modules \\) -prune -o -type f -print 2>/dev/null | head -n ${max}`;
    const r = await this.exec(root, cmd);
    // Some servers send CRLF; never keep a trailing \r in a file name.
    return r.stdout
      .split(/\r?\n/)
      .filter((l) => l.startsWith("./"))
      .map((l) => remotePath(label, `${path.replace(/\/$/, "")}/${l.slice(2)}`));
  },

  /** Search in files with grep on the host. */
  async search(o: SearchOptions): Promise<SearchResult> {
    const { path, label } = splitRemote(o.root);
    const max = o.maxResults ?? 10000;
    const flags = ["-rnI", "--color=never", o.caseSensitive ? "" : "-i", o.wholeWord ? "-w" : "", "--exclude-dir=.git"];
    for (const pat of (o.include ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!pat.includes("/")) flags.push(`--include=${shQuote(pat.replace(/^\*\*\//, ""))}`);
    }
    for (const pat of (o.exclude ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      const name = pat.replace(/^\*\*\//, "").replace(/\/\*\*$/, "");
      flags.push(`--exclude-dir=${shQuote(name)}`, `--exclude=${shQuote(name)}`);
    }
    const run = (mode: string) =>
      this.exec(o.root, `cd ${shQuote(path)} && grep ${flags.filter(Boolean).join(" ")} ${mode} -e ${shQuote(o.query)} . 2>&1 | head -n ${max * 2}`);
    let r = await run(o.isRegex ? "-P" : "-F");
    if (o.isRegex && /invalid option|unrecognized option|support for the -P/i.test(r.stdout)) r = await run("-E");

    let re: RegExp;
    try {
      let src = o.isRegex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (o.wholeWord) src = `\\b(?:${src})\\b`;
      re = new RegExp(src, o.caseSensitive ? "g" : "gi");
    } catch {
      re = new RegExp(o.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), o.caseSensitive ? "g" : "gi");
    }
    const files = new Map<string, FileMatches>();
    let total = 0;
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^\.\/(.+?):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      const full = remotePath(label, `${path.replace(/\/$/, "")}/${m[1]}`);
      const text = m[3];
      const trimmed = text.trimStart();
      const cut = text.length - trimmed.length;
      const preview = trimmed.slice(0, 240);
      re.lastIndex = 0;
      for (const mm of text.matchAll(re)) {
        if (!mm[0]) continue;
        let f = files.get(full);
        if (!f) files.set(full, (f = { path: full, matches: [] }));
        const ps = Math.max(0, mm.index! - cut);
        f.matches.push({ line: Number(m[2]), start_col: mm.index! + 1, end_col: mm.index! + 1 + mm[0].length, preview, preview_start: Math.min(ps, preview.length), preview_end: Math.min(ps + mm[0].length, preview.length) });
        if (++total >= max) break;
      }
      if (total >= max) break;
    }
    return { files: [...files.values()], total, truncated: total >= max, cancelled: false };
  },
};

export async function remoteError(e: unknown) {
  await message(String(e instanceof Error ? e.message : e), { title: "Remote SSH", kind: "error" });
}
