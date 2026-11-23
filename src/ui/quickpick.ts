// Quick pick (filterable list, like VS Code's Ctrl+P) and a simple input box.
import { h } from "./dom";

export interface PickItem<T> {
  label: string;
  description?: string;
  detail?: string;
  value: T;
}

let current: { close: (v: any) => void } | null = null;

/** Fuzzy match: all query chars appear in order. Returns a score (higher = better) or null. */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx - t.length * 0.01;
  let ti = 0;
  let score = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    score -= found - ti;
    ti = found + 1;
  }
  return score;
}

export function showQuickPick<T>(
  items: PickItem<T>[] | (() => Promise<PickItem<T>[]>),
  opts: {
    placeholder?: string;
    activeIndex?: number;
    onHighlight?: (item: PickItem<T>) => void;
    matchOn?: (i: PickItem<T>) => string;
    initialValue?: string;
    /** Dynamic mode: results come from this function (already ranked), not fuzzy filtering. */
    query?: (q: string) => Promise<PickItem<T>[]>;
  } = {},
): Promise<T | null> {
  current?.close(null);
  return new Promise((resolve) => {
    let all: PickItem<T>[] = Array.isArray(items) ? items : [];
    let shown: PickItem<T>[] = [];
    let sel = opts.activeIndex ?? 0;
    const input = h("input", { class: "quickpick-input", placeholder: opts.placeholder ?? "", spellcheck: "false", value: opts.initialValue ?? "" });
    const list = h("div", { class: "quickpick-list" });
    const box = h("div", { class: "quickpick" }, input, list);
    const backdrop = h("div", { class: "quickpick-backdrop" }, box);
    const prevFocus = document.activeElement as HTMLElement | null;

    const close = (v: T | null) => {
      backdrop.remove();
      current = null;
      prevFocus?.focus?.();
      resolve(v);
    };
    current = { close };

    const render = () => {
      const q = opts.query ? "" : input.value.trim();
      const match = opts.matchOn ?? ((i: PickItem<T>) => i.label + " " + (i.description ?? ""));
      shown = q
        ? all
            .map((i) => ({ i, s: fuzzyScore(q, match(i)) }))
            .filter((x): x is { i: PickItem<T>; s: number } => x.s !== null)
            .sort((a, b) => b.s - a.s)
            .slice(0, 200)
            .map((x) => x.i)
        : all.slice(0, 200);
      sel = Math.max(0, Math.min(sel, shown.length - 1));
      list.replaceChildren(
        ...shown.map((item, i) =>
          h(
            "div",
            {
              class: `quickpick-item${i === sel ? " selected" : ""}`,
              onmousedown: (e: Event) => {
                e.preventDefault();
                close(item.value);
              },
            },
            h("span", { class: "qp-label", text: item.label }),
            item.description ? h("span", { class: "qp-desc", text: item.description }) : null,
            item.detail ? h("div", { class: "qp-detail", text: item.detail }) : null,
          ),
        ),
      );
      if (!shown.length) list.append(h("div", { class: "quickpick-empty", text: "No matching results" }));
      list.children[sel]?.scrollIntoView({ block: "nearest" });
      if (shown[sel]) opts.onHighlight?.(shown[sel]);
    };

    let querySeq = 0;
    let queryTimer: number | undefined;
    input.addEventListener("input", () => {
      sel = 0;
      if (!opts.query) return render();
      window.clearTimeout(queryTimer);
      queryTimer = window.setTimeout(async () => {
        const seq = ++querySeq;
        const items = await opts.query!(input.value.trim()).catch(() => []);
        if (seq !== querySeq || current?.close !== close) return;
        all = items;
        render();
      }, 80);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") sel = Math.min(sel + 1, shown.length - 1);
      else if (e.key === "ArrowUp") sel = Math.max(sel - 1, 0);
      else if (e.key === "PageDown") sel = Math.min(sel + 10, shown.length - 1);
      else if (e.key === "PageUp") sel = Math.max(sel - 10, 0);
      else if (e.key === "Enter") return close(shown[sel]?.value ?? null);
      else if (e.key === "Escape") return close(null);
      else return;
      e.preventDefault();
      render();
    });
    input.addEventListener("blur", () => setTimeout(() => current?.close === close && close(null), 100));
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) close(null);
    });

    document.body.append(backdrop);
    input.focus();
    input.select();
    if (Array.isArray(items)) render();
    else {
      list.append(h("div", { class: "quickpick-empty", text: "Loading…" }));
      items().then((loaded) => {
        all = loaded;
        if (current?.close === close) render();
      });
    }
  });
}

/** Single-line input box. Resolves to null when cancelled. */
export function showInputBox(opts: { prompt: string; value?: string; selectBaseName?: boolean; password?: boolean; validate?: (v: string) => string | null }): Promise<string | null> {
  current?.close(null);
  return new Promise((resolve) => {
    const input = h("input", { class: "quickpick-input", value: opts.value ?? "", spellcheck: "false", type: opts.password ? "password" : "text", autocomplete: "off" });
    const msg = h("div", { class: "inputbox-message", text: opts.prompt });
    const box = h("div", { class: "quickpick" }, input, msg);
    const backdrop = h("div", { class: "quickpick-backdrop" }, box);
    const close = (v: string | null) => {
      backdrop.remove();
      current = null;
      resolve(v);
    };
    current = { close };
    const check = () => {
      const err = opts.validate?.(input.value) ?? null;
      msg.textContent = err ?? opts.prompt;
      msg.classList.toggle("error", !!err);
      return !err;
    };
    input.addEventListener("input", check);
    input.addEventListener("keydown", (e) => {
      // Passwords are taken verbatim (spaces are significant).
      if (e.key === "Enter" && check() && input.value.trim()) close(opts.password ? input.value : input.value.trim());
      else if (e.key === "Escape") close(null);
    });
    input.addEventListener("blur", () => setTimeout(() => current?.close === close && close(null), 100));
    document.body.append(backdrop);
    input.focus();
    const v = input.value;
    const dot = v.lastIndexOf(".");
    if (opts.selectBaseName && dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  });
}
