// Tiny DOM helpers (no UI framework, to stay light).

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "html") el.innerHTML = String(v);
    else if (k === "text") el.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset" && typeof v === "object") Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

export function icon(name: keyof typeof icons, cls = ""): HTMLSpanElement {
  return h("span", { class: `icon ${cls}`, html: icons[name] });
}

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const icons = {
  files: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  search: svg('<circle cx="10.5" cy="10.5" r="6"/><path d="m20 20-5.2-5.2"/>'),
  extensions: svg('<rect x="3" y="3" width="7.5" height="7.5" rx="1"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1"/><path d="m14.5 4.5 3-1.8 2.8 3-1.8 3-3 1.6-2.6-2.9z"/>'),
  outline: svg('<path d="M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  chevronRight: svg('<path d="m9 6 6 6-6 6"/>'),
  chevronDown: svg('<path d="m6 9 6 6 6-6"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  newFile: svg('<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"/><path d="M13 3v5h5v4"/><path d="M18 15v6M15 18h6"/>'),
  newFolder: svg('<path d="M12 19H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v3"/><path d="M18 14v6M15 17h6"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  collapse: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 12h8"/>'),
  caseSensitive: '<span class="txt-icon">Aa</span>',
  wholeWord: '<span class="txt-icon"><u>ab</u></span>',
  regex: '<span class="txt-icon">.*</span>',
  wrap: svg('<path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4"/><path d="m15 16-2 2 2 2M4 18h5"/>'),
  whitespace: '<span class="txt-icon">¶</span>',
  install: svg('<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>'),
  clearAll: svg('<path d="M4 6h10M4 11h10M4 16h6"/><path d="m15 14 5 5M20 14l-5 5"/>'),
  expandAll: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 12h8M12 8v8"/>'),
  replace: svg('<path d="M4 7h9a3 3 0 0 1 0 6H8"/><path d="m10 10-3 3 3 3"/><path d="M15 17h5"/>'),
  replaceAll: svg('<path d="M4 6h9a3 3 0 0 1 0 6H8"/><path d="m10 9-3 3 3 3"/><path d="M14 16h6M14 20h6"/>'),
  ellipsis: svg('<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>'),
  openEditors: svg('<path d="M4 5h6a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4z"/><path d="M20 5h-6a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h6z"/>'),
  excludeSettings: svg('<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3"/>'),
  preserveCase: '<span class="txt-icon">AB</span>',
  bug: svg('<path d="M8 6.5a4 4 0 0 1 8 0"/><rect x="7" y="7" width="10" height="12" rx="5"/><path d="M12 11v8M3 13h4M17 13h4M4 7l3 2M20 7l-3 2M4 19l3-2M20 19l-3-2"/>'),
  play: svg('<path d="M7 5v14l11-7z" fill="currentColor" stroke="none"/>'),
  pause: svg('<path d="M8 5v14M16 5v14" stroke-width="3"/>'),
  stepOver: svg('<path d="M4 12a8 8 0 0 1 15-3.5"/><path d="M19 4v5h-5"/><circle cx="12" cy="18" r="2" fill="currentColor"/>'),
  stepInto: svg('<path d="M12 3v11"/><path d="m7 9 5 5 5-5"/><circle cx="12" cy="19.5" r="2" fill="currentColor"/>'),
  stepOut: svg('<path d="M12 15V4"/><path d="m7 9 5-5 5 5"/><circle cx="12" cy="19.5" r="2" fill="currentColor"/>'),
  restart: svg('<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v6h-6"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>'),
  add: svg('<path d="M12 5v14M5 12h14"/>'),
  remove: svg('<path d="M5 12h14"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  discard: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  sourceControl: svg('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10"/><path d="M18 11c0 4-6 3-11.2 6.2"/>'),
  build: svg('<path d="m14 6 4 4"/><path d="M15.5 4.5 19.5 8.5 17 11 13 7z"/><path d="M14.5 9.5 5 19a1.4 1.4 0 0 1-2-2l9.5-9.5"/>'),
  flash: svg('<rect x="7" y="9" width="10" height="11" rx="1.5"/><path d="M9.5 9V7M14.5 9V7M5 12h2M5 16h2M17 12h2M17 16h2"/><path d="M12 2v5"/><path d="m10 5 2 2 2-2"/>'),
} as const;

/** Make a vertical sash resize a panel; `onResize` receives the new width. */
export function makeSash(sash: HTMLElement, getWidth: () => number, onResize: (w: number) => void, invert = false) {
  sash.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = getWidth();
    sash.setPointerCapture(e.pointerId);
    sash.classList.add("active");
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * (invert ? -1 : 1);
      onResize(Math.max(160, Math.min(window.innerWidth * 0.6, startW + dx)));
    };
    const up = () => {
      sash.classList.remove("active");
      sash.removeEventListener("pointermove", move);
      sash.removeEventListener("pointerup", up);
    };
    sash.addEventListener("pointermove", move);
    sash.addEventListener("pointerup", up);
  });
}
