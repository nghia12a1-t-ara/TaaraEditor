// Extensions view: installed extensions + the Open VSX marketplace.
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import { api, errorMessage, type ExtensionInfo, type MarketEntry } from "../api";
import { applyContributions, contributionSummary, installedExtensions, isApplied, loadExtensions, manifestHasCode, manifestSummary } from "../extension-host";
import { saveSettings, settings } from "../settings";
import { h, icon } from "./dom";

const CATEGORIES: [label: string, openVsxCategory: string][] = [
  ["Themes", "Themes"],
  ["Languages", "Programming Languages"],
  ["Snippets", "Snippets"],
];

export interface ExtensionsViewHost {
  reload: () => void;
  pickTheme: () => void;
  pickIconTheme: () => void;
}

export class ExtensionsView {
  readonly el = h("div", { class: "view extensions-view" });
  private list = h("div", { class: "ext-list" });
  private search = h("input", { class: "input", placeholder: "Search extensions in Open VSX", spellcheck: "false" });
  private chips = h("div", { class: "ext-chips" });
  private needsReload = false;

  // Marketplace state
  private category: string | null = null;
  private results: MarketEntry[] = [];
  private total = 0;
  private loading = false;
  private error: string | null = null;
  private seq = 0;
  private expanded: string | null = null;
  private manifests = new Map<string, Promise<any>>();
  private busy = new Map<string, string>(); // key -> "Installing…"
  private justInstalled = new Set<string>();

  constructor(private host: ExtensionsViewHost) {
    let timer: number | undefined;
    this.search.addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => this.runSearch(), 400);
      this.render();
    });
    this.search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.runSearch();
      if (e.key === "Escape") {
        this.search.value = "";
        this.category = null;
        this.runSearch();
      }
    });
    this.el.append(
      h(
        "div",
        { class: "view-header" },
        h("span", { class: "view-title", text: "EXTENSIONS" }),
        h("div", { class: "view-actions" }, h("button", { class: "icon-button", title: "Install from VSIX...", onclick: () => this.pickAndInstall() }, icon("install"))),
      ),
      h("div", { class: "search-box" }, this.search, this.chips),
      this.list,
    );
  }

  focusSearch() {
    this.search.focus();
    this.search.select();
  }

  // ------------------------------------------------------------ install / uninstall

  async pickAndInstall() {
    const picked = await open({ multiple: true, filters: [{ name: "VS Code Extension", extensions: ["vsix"] }] });
    if (!picked) return;
    for (const p of Array.isArray(picked) ? picked : [picked]) await this.install(p);
  }

  /** Install a local .vsix file. */
  async install(path: string) {
    try {
      await this.afterInstall(await api.installVsix(path), true);
    } catch (e) {
      await message(`Failed to install ${path}\n\n${errorMessage(e)}`, { title: "Taara Editor", kind: "error" });
    }
  }

  private async afterInstall(info: ExtensionInfo, notify: boolean) {
    const wasApplied = isApplied(info.id);
    await loadExtensions();
    if (wasApplied) this.needsReload = true; // upgrade: old contributions are still registered
    else applyContributions(info);
    this.justInstalled.add(info.id);
    this.render();
    const summary = contributionSummary(info);
    if (notify || (info.hasCode && summary.length)) {
      const notes = [
        `${info.displayName} ${info.version} was installed.`,
        summary.length ? `Taara uses: ${summary.join(", ")}.` : "",
        info.hasCode ? "This extension also contains JavaScript code, which Taara Editor cannot run yet." : "",
      ];
      await message(notes.filter(Boolean).join("\n\n"), { title: "Extension installed", kind: "info" });
    }
  }

  private async installFromMarket(entry: MarketEntry) {
    const key = marketKey(entry);
    if (this.busy.has(key)) return;
    this.busy.set(key, "Checking…");
    this.render();
    try {
      const manifest = await this.manifest(entry).catch(() => null);
      if (manifest && !manifestSummary(manifest).length) {
        const ok = await ask(
          `${entry.displayName ?? entry.name} has no themes, grammars, languages or snippets. It only contains code${manifestHasCode(manifest) ? " (JavaScript)" : ""}, which Taara Editor cannot run yet.\n\nInstall it anyway?`,
          { title: "Extension not supported yet", kind: "warning", okLabel: "Install Anyway", cancelLabel: "Cancel" },
        );
        if (!ok) return;
      }
      this.busy.set(key, "Installing…");
      this.render();
      const info = await api.marketInstall(entry.namespace, entry.name);
      await this.afterInstall(info, false);
    } catch (e) {
      await message(`Failed to install ${entry.namespace}.${entry.name}\n\n${errorMessage(e)}`, { title: "Taara Editor", kind: "error" });
    } finally {
      this.busy.delete(key);
      this.render();
    }
  }

  private toggle(ext: ExtensionInfo) {
    const disabled = settings.disabledExtensions.includes(ext.id);
    if (disabled) {
      settings.disabledExtensions = settings.disabledExtensions.filter((id) => id !== ext.id);
      if (isApplied(ext.id)) this.needsReload = true;
      else applyContributions(ext);
    } else {
      settings.disabledExtensions = [...settings.disabledExtensions, ext.id];
      this.needsReload = true;
    }
    saveSettings();
    this.render();
  }

  private async uninstall(ext: ExtensionInfo) {
    try {
      await api.uninstallExtension(ext.id);
      settings.disabledExtensions = settings.disabledExtensions.filter((id) => id !== ext.id);
      saveSettings();
      if (isApplied(ext.id)) this.needsReload = true;
      this.justInstalled.delete(ext.id);
      await loadExtensions();
      this.render();
    } catch (e) {
      message(errorMessage(e), { title: "Taara Editor", kind: "error" });
    }
  }

  // ------------------------------------------------------------ marketplace

  private manifest(entry: MarketEntry) {
    const key = marketKey(entry) + "@" + entry.version;
    let p = this.manifests.get(key);
    if (!p) {
      p = api.marketManifest(entry.namespace, entry.name);
      p.catch(() => this.manifests.delete(key));
      this.manifests.set(key, p);
    }
    return p;
  }

  private get marketActive() {
    return !!this.search.value.trim() || !!this.category;
  }

  private async runSearch(append = false) {
    const seq = ++this.seq;
    if (!this.marketActive) {
      this.results = [];
      this.error = null;
      this.loading = false;
      this.render();
      return;
    }
    this.loading = true;
    this.error = null;
    if (!append) {
      this.results = [];
      this.expanded = null;
    }
    this.render();
    try {
      const res = await api.marketSearch(this.search.value.trim(), this.category, append ? this.results.length : 0);
      if (seq !== this.seq) return;
      this.results = append ? [...this.results, ...res.extensions] : res.extensions;
      this.total = res.totalSize;
    } catch (e) {
      if (seq === this.seq) this.error = errorMessage(e);
    } finally {
      if (seq === this.seq) {
        this.loading = false;
        this.render();
      }
    }
  }

  // ------------------------------------------------------------ rendering

  render() {
    this.renderChips();
    const q = this.search.value.trim().toLowerCase();
    const installed = installedExtensions.filter((e) => !q || `${e.displayName} ${e.id} ${e.description}`.toLowerCase().includes(q));
    const rows: (HTMLElement | null)[] = [];

    if (this.needsReload) {
      rows.push(
        h(
          "div",
          { class: "ext-reload" },
          h("span", { text: "Reload the window to apply extension changes." }),
          h("button", { class: "button", text: "Reload", onclick: () => this.host.reload() }),
        ),
      );
    }

    if (!this.category) {
      rows.push(h("div", { class: "ext-section", text: `INSTALLED${installedExtensions.length ? ` (${installed.length})` : ""}` }));
      if (!installedExtensions.length) rows.push(h("div", { class: "view-empty muted", text: "No extensions installed yet." }));
      else if (!installed.length) rows.push(h("div", { class: "view-empty muted", text: "No installed extension matches." }));
      for (const ext of installed) rows.push(this.installedCard(ext));
    }

    rows.push(h("div", { class: "ext-section", text: this.category ? `OPEN VSX · ${this.category.toUpperCase()}` : "OPEN VSX" }));
    if (!this.marketActive) {
      rows.push(
        h(
          "div",
          { class: "view-empty muted" },
          "Type to search open-vsx.org, or browse a category above. Taara uses the color themes, file icon themes, syntax highlighting (grammars), language settings and snippets of an extension.",
        ),
      );
    } else {
      for (const entry of this.results) rows.push(this.marketCard(entry));
      if (this.loading) rows.push(h("div", { class: "view-empty muted", text: "Searching Open VSX…" }));
      else if (this.error)
        rows.push(
          h("div", { class: "view-empty" }, h("p", { class: "error-text", text: this.error }), h("button", { class: "button secondary", text: "Retry", onclick: () => this.runSearch() })),
        );
      else if (!this.results.length) rows.push(h("div", { class: "view-empty muted", text: "No extensions found." }));
      else if (this.results.length < this.total)
        rows.push(h("div", { class: "ext-more" }, h("button", { class: "button secondary", text: `Load more (${this.total - this.results.length} left)`, onclick: () => this.runSearch(true) })));
    }

    const scroll = this.list.scrollTop;
    this.list.replaceChildren(...rows.filter((r): r is HTMLElement => !!r));
    this.list.scrollTop = scroll;
  }

  private renderChips() {
    this.chips.replaceChildren(
      ...CATEGORIES.map(([label, cat]) =>
        h("button", {
          class: `chip${this.category === cat ? " on" : ""}`,
          text: label,
          onclick: () => {
            this.category = this.category === cat ? null : cat;
            this.runSearch();
          },
        }),
      ),
    );
  }

  private installedCard(ext: ExtensionInfo) {
    const disabled = settings.disabledExtensions.includes(ext.id);
    const summary = contributionSummary(ext);
    const hasThemes = (ext.manifest?.contributes?.themes ?? []).length > 0;
    const hasIconThemes = (ext.manifest?.contributes?.iconThemes ?? []).length > 0;
    return h(
      "div",
      { class: `ext-card${disabled ? " disabled" : ""}` },
      h("div", { class: "ext-title" }, h("span", { class: "ext-name", text: ext.displayName }), h("span", { class: "ext-version", text: ext.version })),
      h("div", { class: "ext-desc", text: ext.description || ext.id }),
      h(
        "div",
        { class: "ext-meta" },
        h("span", { class: "muted", text: ext.publisher }),
        summary.length ? h("span", { class: "ext-tag", text: summary.join(" · ") }) : null,
        ext.hasCode ? h("span", { class: "ext-tag warn", title: "Extension JavaScript is not executed yet", text: "code not supported" }) : null,
      ),
      h(
        "div",
        { class: "ext-actions" },
        hasThemes && !disabled ? h("button", { class: "button secondary", text: "Set Color Theme", onclick: () => this.host.pickTheme() }) : null,
        hasIconThemes && !disabled ? h("button", { class: "button secondary", text: "Set File Icon Theme", onclick: () => this.host.pickIconTheme() }) : null,
        h("button", { class: "button secondary", text: disabled ? "Enable" : "Disable", onclick: () => this.toggle(ext) }),
        h("button", { class: "button secondary", text: "Uninstall", onclick: () => this.uninstall(ext) }),
      ),
    );
  }

  private marketCard(entry: MarketEntry) {
    const key = marketKey(entry);
    const installed = installedExtensions.find((e) => e.id === key);
    const busy = this.busy.get(key);
    const isOpen = this.expanded === key;

    let action: HTMLElement;
    if (busy) action = h("button", { class: "button", text: busy, disabled: true });
    else if (installed && installed.version === entry.version) action = h("span", { class: "ext-installed", text: this.justInstalled.has(key) ? "✓ Installed" : "Installed" });
    else
      action = h("button", {
        class: "button",
        text: installed ? `Update to ${entry.version}` : "Install",
        onclick: (e: Event) => {
          e.stopPropagation();
          this.installFromMarket(entry);
        },
      });

    const iconEl = entry.files?.icon
      ? h("img", { class: "ext-icon", src: entry.files.icon, alt: "", loading: "lazy", draggable: "false" })
      : h("div", { class: "ext-icon placeholder", text: (entry.displayName ?? entry.name).charAt(0).toUpperCase() });
    iconEl.addEventListener("error", () => iconEl.replaceWith(h("div", { class: "ext-icon placeholder", text: (entry.displayName ?? entry.name).charAt(0).toUpperCase() })));

    const card = h(
      "div",
      { class: `ext-card market${isOpen ? " open" : ""}`, title: `${key} ${entry.version}` },
      h(
        "div",
        { class: "ext-row" },
        iconEl,
        h(
          "div",
          { class: "ext-body" },
          h(
            "div",
            { class: "ext-title" },
            h("span", { class: "ext-name", text: entry.displayName ?? entry.name }),
            h("span", { class: "ext-version", text: entry.version }),
            entry.deprecated ? h("span", { class: "ext-tag warn", text: "deprecated" }) : null,
          ),
          h("div", { class: "ext-desc clamp", text: entry.description ?? "" }),
          h(
            "div",
            { class: "ext-meta" },
            h("span", { class: "muted", text: `${entry.namespace}${entry.verified ? " ✓" : ""}` }),
            entry.downloadCount !== undefined ? h("span", { class: "muted", text: `↓ ${formatCount(entry.downloadCount)}` }) : null,
            h("span", { class: "ext-spacer" }),
            action,
          ),
          isOpen ? this.details(entry) : null,
        ),
      ),
    );
    card.addEventListener("click", () => {
      this.expanded = isOpen ? null : key;
      this.render();
    });
    return card;
  }

  /** Expanded part of a marketplace card: what Taara can use from it. */
  private details(entry: MarketEntry) {
    const box = h("div", { class: "ext-details muted", text: "Checking what Taara can use…" });
    this.manifest(entry).then(
      (manifest) => {
        const summary = manifestSummary(manifest);
        const code = manifestHasCode(manifest);
        const lines: HTMLElement[] = [];
        if (summary.length) lines.push(h("div", { class: "ext-compat ok", text: `✓ Taara uses: ${summary.join(", ")}` }));
        if (code)
          lines.push(
            h("div", { class: `ext-compat ${summary.length ? "partial" : "no"}`, text: summary.length ? "• Its JavaScript features (commands, IntelliSense, debugging…) won't run yet" : "✗ Code-only extension: Taara cannot run it yet" }),
          );
        if (!summary.length && !code) lines.push(h("div", { class: "ext-compat no", text: "✗ Nothing Taara can use (these contributions are not supported yet)" }));
        const langs = (manifest?.contributes?.languages ?? []).map((l: any) => l.aliases?.[0] ?? l.id).filter(Boolean);
        if (langs.length) lines.push(h("div", { text: `Languages: ${langs.slice(0, 8).join(", ")}${langs.length > 8 ? "…" : ""}` }));
        const iconThemes = (manifest?.contributes?.iconThemes ?? []).map((t: any) => t.label ?? t.id).filter(Boolean);
        if (iconThemes.length) lines.push(h("div", { text: `File icon themes: ${iconThemes.join(", ")}` }));
        const themes = (manifest?.contributes?.themes ?? []).map((t: any) => t.label ?? t.id).filter(Boolean);
        if (themes.length) lines.push(h("div", { text: `Themes: ${themes.slice(0, 8).join(", ")}${themes.length > 8 ? "…" : ""}` }));
        box.replaceChildren(...lines);
      },
      (e) => (box.textContent = `Could not load details: ${errorMessage(e)}`),
    );
    box.addEventListener("click", (e) => e.stopPropagation());
    return box;
  }
}

function marketKey(e: MarketEntry) {
  return `${e.namespace}.${e.name}`.toLowerCase();
}

function formatCount(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}
