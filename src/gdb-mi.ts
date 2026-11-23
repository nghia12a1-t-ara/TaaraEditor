// GDB/MI client: runs `gdb --interpreter=mi3` through the Rust process bridge
// (src-tauri/src/debug.rs) and parses its output records.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type MiValue = string | MiTuple | MiValue[];
export interface MiTuple {
  [key: string]: MiValue;
}

export interface MiRecord {
  token?: number;
  /** "^" result, "*" exec async, "+" status async, "=" notify async */
  kind: "^" | "*" | "+" | "=";
  cls: string;
  data: MiTuple;
}

// ------------------------------------------------------------------ parser

/** Parse an MI C string starting at s[i] (which must be '"'). */
function parseCString(s: string, i: number): [string, number] {
  let out = "";
  i++; // opening quote
  while (i < s.length && s[i] !== '"') {
    if (s[i] === "\\" && i + 1 < s.length) {
      const c = s[++i];
      if (c === "n") out += "\n";
      else if (c === "t") out += "\t";
      else if (c === "r") out += "\r";
      else if (/[0-7]/.test(c)) {
        // Octal escape (\302\240 ...): collect bytes, decode as UTF-8 below.
        let oct = c;
        while (oct.length < 3 && /[0-7]/.test(s[i + 1])) oct += s[++i];
        out += String.fromCharCode(parseInt(oct, 8));
      } else out += c;
    } else out += s[i];
    i++;
  }
  // Re-decode octal-escaped UTF-8 bytes.
  if (/[\x80-\xff]/.test(out)) {
    try {
      out = new TextDecoder().decode(Uint8Array.from(out, (ch) => ch.charCodeAt(0) & 0xff));
    } catch {
      /* keep as is */
    }
  }
  return [out, i + 1];
}

function parseValue(s: string, i: number): [MiValue, number] {
  const c = s[i];
  if (c === '"') return parseCString(s, i);
  if (c === "{") {
    const [t, j] = parseResults(s, i + 1, "}");
    return [t, j + 1];
  }
  if (c === "[") {
    i++;
    const list: MiValue[] = [];
    while (i < s.length && s[i] !== "]") {
      // A list holds either values or results (name=value).
      if (s[i] === '"' || s[i] === "{" || s[i] === "[") {
        const [v, j] = parseValue(s, i);
        list.push(v);
        i = j;
      } else {
        const eq = s.indexOf("=", i);
        const key = s.slice(i, eq);
        const [v, j] = parseValue(s, eq + 1);
        list.push({ [key]: v });
        i = j;
      }
      if (s[i] === ",") i++;
    }
    return [list, i + 1];
  }
  // Bare word (should not happen in valid MI, be lenient).
  let j = i;
  while (j < s.length && !",}]".includes(s[j])) j++;
  return [s.slice(i, j), j];
}

/** Parse `a=1,b={...},c=[...]` until `end` (or end of string). */
export function parseResults(s: string, i = 0, end = ""): [MiTuple, number] {
  const out: MiTuple = {};
  while (i < s.length && s[i] !== end) {
    const eq = s.indexOf("=", i);
    if (eq < 0) break;
    const key = s.slice(i, eq);
    const [v, j] = parseValue(s, eq + 1);
    // Repeated keys (e.g. frame=..., frame=...) become arrays.
    if (key in out) out[key] = ([] as MiValue[]).concat(out[key] as never, v as never);
    else out[key] = v;
    i = j;
    if (s[i] === ",") i++;
  }
  return [out, i];
}

/** Parse one line of MI output. */
export function parseLine(line: string): { record?: MiRecord; stream?: { kind: "~" | "@" | "&"; text: string } } | null {
  if (!line || line.startsWith("(gdb)")) return null;
  const m = /^(\d*)([\^*+=])([a-zA-Z-]+)(?:,(.*))?$/.exec(line);
  if (m) {
    return { record: { token: m[1] ? Number(m[1]) : undefined, kind: m[2] as MiRecord["kind"], cls: m[3], data: m[4] ? parseResults(m[4])[0] : {} } };
  }
  if (/^[~@&]"/.test(line)) return { stream: { kind: line[0] as "~" | "@" | "&", text: parseCString(line, 1)[0] } };
  // Plain text (target output on some servers, or program output).
  return { stream: { kind: "@", text: line + "\n" } };
}

/** Quote a string as an MI C string. */
export function cstr(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

// ------------------------------------------------------------------ process

export class Gdb {
  private procId = 0;
  private token = 0;
  private pending = new Map<number, { resolve: (r: MiRecord) => void; reject: (e: Error) => void; cmd: string }>();
  private unlisten: UnlistenFn[] = [];
  onAsync: (r: MiRecord) => void = () => {};
  onStream: (kind: "~" | "@" | "&", text: string) => void = () => {};
  onExit: (code: number | null) => void = () => {};
  running = false;

  static async start(gdbPath: string, args: string[], cwd?: string): Promise<Gdb> {
    const g = new Gdb();
    g.unlisten.push(
      await listen<{ id: number; stream: string; line: string }>("proc://line", (e) => {
        if (e.payload.id === g.procId) g.handle(e.payload.line);
      }),
      await listen<{ id: number; code: number | null }>("proc://exit", (e) => {
        if (e.payload.id !== g.procId) return;
        g.running = false;
        for (const p of g.pending.values()) p.reject(new Error("GDB exited"));
        g.pending.clear();
        g.onExit(e.payload.code);
        g.dispose();
      }),
    );
    try {
      g.procId = await invoke<number>("proc_start", { command: gdbPath, args: ["--interpreter=mi3", "--nx", "-q", ...args], cwd });
    } catch (e) {
      g.dispose();
      throw e;
    }
    g.running = true;
    return g;
  }

  private handle(line: string) {
    const p = parseLine(line);
    if (!p) return;
    if (p.stream) return this.onStream(p.stream.kind, p.stream.text);
    const r = p.record!;
    if (r.kind === "^" && r.token !== undefined && this.pending.has(r.token)) {
      const w = this.pending.get(r.token)!;
      this.pending.delete(r.token);
      if (r.cls === "error") w.reject(new Error(String(r.data.msg ?? "error")));
      else w.resolve(r);
      return;
    }
    this.onAsync(r);
  }

  /** Send an MI command; resolves with the ^done/^running/... record. */
  send(cmd: string, timeoutMs = 30000): Promise<MiRecord> {
    if (!this.running) return Promise.reject(new Error("GDB is not running"));
    const token = ++this.token;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(token)) reject(new Error(`GDB did not answer: ${cmd}`));
      }, timeoutMs);
      this.pending.set(token, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        cmd,
      });
      invoke("proc_write", { id: this.procId, text: `${token}${cmd}\n` }).catch((e) => {
        this.pending.delete(token);
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  /** Run a CLI command (e.g. "monitor reset halt"). */
  console(cmd: string, timeoutMs?: number) {
    return this.send(`-interpreter-exec console ${cstr(cmd)}`, timeoutMs);
  }

  async kill() {
    if (this.running) {
      await Promise.race([this.send("-gdb-exit", 2000).catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
      await invoke("proc_kill", { id: this.procId }).catch(() => {});
    }
    this.running = false;
    this.dispose();
  }

  private dispose() {
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
  }
}
