// Context menus and the menu bar.
import { h } from "./dom";

export type MenuItem =
  | "-"
  | {
      label: string;
      shortcut?: string;
      action?: () => void;
      disabled?: boolean;
      checked?: boolean;
      submenu?: MenuItem[] | (() => MenuItem[]);
    };

let openMenus: HTMLElement[] = [];
let onCloseAll: (() => void) | null = null;

export function closeMenus() {
  openMenus.forEach((m) => m.remove());
  openMenus = [];
  const cb = onCloseAll;
  onCloseAll = null;
  cb?.();
}

function closeFrom(level: number) {
  openMenus.slice(level).forEach((m) => m.remove());
  openMenus = openMenus.slice(0, level);
}

function renderMenu(items: MenuItem[], x: number, y: number, level: number): HTMLElement {
  closeFrom(level);
  const menu = h("div", { class: "menu", role: "menu", tabindex: "-1" });
  const rows: HTMLElement[] = [];
  for (const item of items) {
    if (item === "-") {
      menu.append(h("div", { class: "menu-sep" }));
      continue;
    }
    const hasSub = !!item.submenu;
    const row = h(
      "div",
      { class: `menu-item${item.disabled ? " disabled" : ""}`, role: "menuitem" },
      h("span", { class: "menu-check", text: item.checked ? "✓" : "" }),
      h("span", { class: "menu-label", text: item.label }),
      h("span", { class: "menu-shortcut", text: hasSub ? "›" : item.shortcut ?? "" }),
    );
    const openSub = () => {
      const sub = typeof item.submenu === "function" ? item.submenu() : item.submenu!;
      const r = row.getBoundingClientRect();
      renderMenu(sub, r.right - 2, r.top - 4, level + 1);
    };
    row.addEventListener("mouseenter", () => {
      rows.forEach((r) => r.classList.remove("focused"));
      row.classList.add("focused");
      if (hasSub && !item.disabled) openSub();
      else closeFrom(level + 1);
    });
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (item.disabled) return;
      if (hasSub) return openSub();
      closeMenus();
      item.action?.();
    });
    (row as any)._activate = () => row.click();
    rows.push(row);
    menu.append(row);
  }
  document.body.append(menu);
  // Keep inside the window.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - r.height - 4))}px`;
  openMenus.push(menu);
  return menu;
}

export function showMenu(items: MenuItem[], x: number, y: number, onClose?: () => void) {
  closeMenus();
  onCloseAll = onClose ?? null;
  const menu = renderMenu(items, x, y, 0);
  menu.focus();
}

// Close on outside click / Escape; arrow-key navigation in the top-most menu.
window.addEventListener("pointerdown", (e) => {
  if (openMenus.length && !openMenus.some((m) => m.contains(e.target as Node))) {
    if (!(e.target as HTMLElement).closest?.(".menubar-item")) closeMenus();
  }
}, true);
window.addEventListener("blur", () => closeMenus());
window.addEventListener("keydown", (e) => {
  if (!openMenus.length) return;
  const menu = openMenus[openMenus.length - 1];
  const rows = [...menu.querySelectorAll<HTMLElement>(".menu-item:not(.disabled)")];
  const cur = rows.findIndex((r) => r.classList.contains("focused"));
  const focus = (i: number) => {
    rows.forEach((r) => r.classList.remove("focused"));
    rows[(i + rows.length) % rows.length]?.classList.add("focused");
  };
  if (e.key === "Escape") closeMenus();
  else if (e.key === "ArrowDown") focus(cur + 1);
  else if (e.key === "ArrowUp") focus(cur < 0 ? rows.length - 1 : cur - 1);
  else if (e.key === "Enter" && cur >= 0) (rows[cur] as any)._activate();
  else return;
  e.preventDefault();
  e.stopPropagation();
}, true);

/** Menu bar with VS Code-like hover switching between open menus. */
export function createMenuBar(host: HTMLElement, menus: { label: string; items: () => MenuItem[] }[]) {
  let active: HTMLElement | null = null;
  const open = (btn: HTMLElement, items: () => MenuItem[]) => {
    const r = btn.getBoundingClientRect();
    active?.classList.remove("open");
    active = btn;
    btn.classList.add("open");
    showMenu(items(), r.left, r.bottom, () => {
      btn.classList.remove("open");
      if (active === btn) active = null;
    });
  };
  for (const m of menus) {
    const btn = h("div", { class: "menubar-item", text: m.label });
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (active === btn) closeMenus();
      else open(btn, m.items);
    });
    btn.addEventListener("mouseenter", () => {
      if (active && active !== btn) open(btn, m.items);
    });
    host.append(btn);
  }
}
