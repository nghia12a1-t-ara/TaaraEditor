// Minimal Language Server Protocol client over the Rust stdio bridge
// (src-tauri/src/lsp.rs). Transport only; features live in clangd.ts.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type Handler = (params: any) => void;

export class LspClient {
  private id = 0;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; method: string }>();
  private notifications = new Map<string, Handler>();
  private unlisten: UnlistenFn[] = [];
  private exitHandlers: ((code: number | null) => void)[] = [];
  private logHandler: (line: string) => void = () => {};
  running = false;

  static async start(command: string, args: string[], cwd?: string): Promise<LspClient> {
    const c = new LspClient();
    // Listen before starting so no early message is lost.
    c.unlisten.push(
      await listen<{ id: number; message: string }>("lsp://message", (e) => {
        if (e.payload.id === c.id) c.dispatch(e.payload.message);
      }),
      await listen<{ id: number; code: number | null }>("lsp://exit", (e) => {
        if (e.payload.id !== c.id) return;
        c.running = false;
        for (const p of c.pending.values()) p.reject(new Error("Language server exited"));
        c.pending.clear();
        c.exitHandlers.forEach((h) => h(e.payload.code));
        c.dispose();
      }),
      await listen<{ id: number; line: string }>("lsp://log", (e) => {
        if (e.payload.id === c.id) c.logHandler(e.payload.line);
      }),
    );
    try {
      c.id = await invoke<number>("lsp_start", { command, args, cwd });
    } catch (e) {
      c.dispose();
      throw e;
    }
    c.running = true;
    return c;
  }

  onNotification(method: string, h: Handler) {
    this.notifications.set(method, h);
  }

  onExit(h: (code: number | null) => void) {
    this.exitHandlers.push(h);
  }

  onLog(h: (line: string) => void) {
    this.logHandler = h;
  }

  request<T = any>(method: string, params: unknown, token?: { isCancellationRequested: boolean; onCancellationRequested?: (cb: () => void) => unknown }): Promise<T> {
    if (!this.running) return Promise.reject(new Error("Language server is not running"));
    const id = ++this.seq;
    const p = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
    this.send({ jsonrpc: "2.0", id, method, params });
    token?.onCancellationRequested?.(() => {
      if (this.pending.has(id)) this.notify("$/cancelRequest", { id });
    });
    return p;
  }

  notify(method: string, params: unknown) {
    if (this.running) this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: unknown) {
    invoke("lsp_send", { id: this.id, message: JSON.stringify(msg) }).catch(() => {});
  }

  private dispatch(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      // Response to one of our requests.
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined) {
      // Server -> client request: we support none beyond trivial ones.
      const result = msg.method === "workspace/configuration" ? (msg.params?.items ?? []).map(() => null) : null;
      this.send({ jsonrpc: "2.0", id: msg.id, result });
    } else if (msg.method) {
      this.notifications.get(msg.method)?.(msg.params);
    }
  }

  async stop() {
    if (!this.running) return;
    try {
      await Promise.race([this.request("shutdown", null), new Promise((r) => setTimeout(r, 1500))]);
      this.notify("exit", null);
    } catch {
      /* ignore */
    }
    await invoke("lsp_stop", { id: this.id }).catch(() => {});
    this.running = false;
    this.dispose();
  }

  private dispose() {
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
  }
}
