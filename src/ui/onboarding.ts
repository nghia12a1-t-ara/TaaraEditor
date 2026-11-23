// First-run welcome tour: appearance, tool check, and where to start.
// Shown once (settings.onboarded); reopen from Help > Welcome Tour.
import { invoke } from "@tauri-apps/api/core";
import { allThemes, applyTheme } from "../themes";
import { clangdApi, clangdState, installClangd } from "../clangd";
import { saveSettings, settings } from "../settings";
import { h } from "./dom";

export interface OnboardingActions {
  exec: (command: string) => void;
  keyOf: (command: string) => string | undefined;
  remoteConnect: () => void;
}

interface Toolchain {
  git: string | null;
  arm_gcc: string | null;
  make: string | null;
  cmake: string | null;
  ninja: string | null;
  cube_programmer: string | null;
}

interface DebugTools {
  gdb: string | null;
  stlink_server: string | null;
  openocd: string | null;
  jlink_server: string | null;
}

let open = false;

export function showOnboarding(actions: OnboardingActions) {
  if (open) return;
  open = true;
  const STEPS = ["Appearance", "Tools", "Get Started"];
  let step = 0;

  const body = h("div", { class: "onb-body" });
  const dots = h("div", { class: "onb-steps" });
  const back = h("button", { class: "onb-btn", text: "Back" });
  const next = h("button", { class: "onb-btn primary", text: "Next" });
  const skip = h("button", { class: "onb-link", text: "Skip tour" });
  const dialog = h(
    "div",
    { class: "onb", role: "dialog", "aria-modal": "true", "aria-label": "Welcome to Taara Editor" },
    h("div", { class: "onb-head" }, h("h1", { text: "Welcome to Taara Editor" }), dots),
    body,
    h("div", { class: "onb-foot" }, skip, h("div", { class: "spacer" }), back, next),
  );
  const backdrop = h("div", { class: "onb-backdrop" }, dialog);
  document.body.append(backdrop);

  const close = () => {
    settings.onboarded = true;
    saveSettings();
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
    open = false;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);

  const render = () => {
    dots.replaceChildren(...STEPS.map((s, i) => h("span", { class: `onb-dot${i === step ? " active" : ""}${i < step ? " done" : ""}`, text: `${i + 1}. ${s}` })));
    back.style.visibility = step ? "visible" : "hidden";
    next.textContent = step === STEPS.length - 1 ? "Finish" : "Next";
    body.replaceChildren(...[appearance, tools, start][step]());
    next.focus();
  };
  back.addEventListener("click", () => {
    step = Math.max(0, step - 1);
    render();
  });
  next.addEventListener("click", () => {
    if (step === STEPS.length - 1) close();
    else {
      step++;
      render();
    }
  });
  skip.addEventListener("click", close);

  // ---------------------------------------------------------------- step 1
  function appearance(): HTMLElement[] {
    const cards = h("div", { class: "onb-themes" });
    const renderCards = () =>
      cards.replaceChildren(
        ...allThemes()
          .filter((t) => t.source === "Built-in")
          .map((t) => {
            const dark = t.uiTheme === "vs-dark" || t.uiTheme === "hc-black";
            const card = h(
              "button",
              { class: `onb-theme${settings.theme === t.id ? " selected" : ""}`, title: t.label },
              h("span", { class: `onb-swatch ${t.id.replace(".", "-")}${dark ? " dark" : ""}` }, h("i"), h("i"), h("i")),
              h("span", { text: t.label }),
            );
            card.addEventListener("click", async () => {
              settings.theme = await applyTheme(t.id);
              saveSettings();
              renderCards();
            });
            return card;
          }),
      );
    renderCards();
    const toggle = (label: string, hint: string, get: () => boolean, cmd: string) => {
      const input = h("input", { type: "checkbox" }) as HTMLInputElement;
      input.checked = get();
      input.addEventListener("change", () => {
        if (input.checked !== get()) actions.exec(cmd);
      });
      return h("label", { class: "onb-check" }, input, h("span", {}, h("b", { text: label }), h("small", { class: "muted", text: hint })));
    };
    const updates = h("input", { type: "checkbox" }) as HTMLInputElement;
    updates.checked = settings.update.checkOnStartup;
    updates.addEventListener("change", () => {
      settings.update.checkOnStartup = updates.checked;
      saveSettings();
    });
    return [
      h("p", { class: "muted", text: "A lightweight editor for STM32 and other embedded projects. Pick a look — you can change everything later from the View menu." }),
      h("h3", { text: "Color theme" }),
      cards,
      h("p", { class: "muted small", text: "More themes: Extensions view (Ctrl+Shift+X) → search “theme”." }),
      h("h3", { text: "Editor" }),
      h(
        "div",
        { class: "onb-checks" },
        toggle("Word Wrap", "Wrap long lines to the window width (Alt+Z)", () => settings.wordWrap, "view.wordWrap"),
        toggle("Show All Characters", "Spaces, tabs and line endings, like Notepad++", () => settings.renderWhitespace, "view.whitespace"),
        toggle("Minimap", "Code overview on the right", () => settings.minimap, "view.minimap"),
        h("label", { class: "onb-check" }, updates, h("span", {}, h("b", { text: "Check for updates automatically" }), h("small", { class: "muted", text: "From GitHub Releases, a few seconds after startup" }))),
      ),
    ];
  }

  // ---------------------------------------------------------------- step 2
  function tools(): HTMLElement[] {
    const list = h("div", { class: "onb-tools" }, h("p", { class: "muted", text: "Looking for tools…" }));
    const row = (name: string, purpose: string, path: string | null, hint: string, action?: HTMLElement) =>
      h(
        "div",
        { class: `onb-tool ${path ? "found" : "missing"}` },
        h("span", { class: "onb-tool-mark", text: path ? "✓" : "–" }),
        h("span", { class: "onb-tool-text" }, h("b", { text: name }), h("small", { class: "muted", text: path ? `${purpose} · ${path}` : `${purpose} · ${hint}`, title: path ?? hint })),
        ...(action && !path ? [action] : []),
      );
    const load = async () => {
      const [tc, dbg, clangd] = await Promise.all([
        invoke<Toolchain>("toolchain_info").catch(() => null),
        invoke<DebugTools>("debug_tools").catch(() => null),
        clangdApi.find(settings.clangd.path).catch(() => null),
      ]);
      const installBtn = h("button", { class: "onb-btn small", text: "Install" });
      installBtn.addEventListener("click", async () => {
        installBtn.disabled = true;
        installBtn.textContent = "Installing…";
        try {
          await installClangd();
          load();
        } catch (e) {
          installBtn.disabled = false;
          installBtn.textContent = "Retry";
          installBtn.title = String(e);
        }
      });
      const debugServer = dbg?.stlink_server ?? dbg?.openocd ?? dbg?.jlink_server ?? null;
      list.replaceChildren(
        row("clangd", "IntelliSense for C/C++", clangd ? `${clangd.version} (${clangd.source})` : null, clangdState() === "installing" ? "installing…" : "not found — Taara can download it (~20 MB)", installBtn),
        row("Git", "Source Control view", tc?.git ?? null, "install Git for Windows (git-scm.com)"),
        row("ARM GCC", "Build (arm-none-eabi-gcc)", tc?.arm_gcc ?? null, "install the Arm GNU Toolchain or STM32CubeIDE and add its bin folder to PATH"),
        row("Make / CMake", "Build system", tc?.make ?? tc?.cmake ?? null, "install make (e.g. from xPack) or CMake"),
        row("STM32CubeProgrammer", "Flash", tc?.cube_programmer ?? null, "install STM32CubeProgrammer (or STM32CubeIDE, which bundles it)"),
        row("GDB server", "Debug (ST-LINK / OpenOCD / J-Link)", debugServer, "install STM32CubeIDE, OpenOCD or J-Link"),
        row("arm-none-eabi-gdb", "Debugger", dbg?.gdb ?? null, "part of the Arm GNU Toolchain"),
      );
    };
    load();
    return [
      h("p", { class: "muted", text: "Taara uses the tools already on your machine. Nothing here is required to edit files — missing tools only disable the matching feature." }),
      list,
      h("p", { class: "muted small", text: "Per-project build and flash commands: Build › Configure Tasks… (.taara/tasks.json)." }),
    ];
  }

  // ---------------------------------------------------------------- step 3
  function start(): HTMLElement[] {
    const action = (label: string, detail: string, fn: () => void) => {
      const b = h("button", { class: "onb-action" }, h("b", { text: label }), h("small", { class: "muted", text: detail }));
      b.addEventListener("click", () => {
        close();
        fn();
      });
      return b;
    };
    const keys: [string, string][] = [
      ["Quick Open file", "file.quickOpen"],
      ["Command Palette", "view.commandPalette"],
      ["Search in Files", "view.search"],
      ["Go to Definition", "go.definition"],
      ["Build", "build.build"],
      ["Start Debugging", "debug.start"],
      ["Terminal", "view.terminal"],
    ];
    return [
      h(
        "div",
        { class: "onb-actions" },
        action("Open Folder…", "Open an STM32CubeIDE, Makefile or CMake project", () => actions.exec("file.openFolder")),
        action("Open File…", "Edit a single file", () => actions.exec("file.open")),
        action("Connect to SSH Host…", "Edit files on a remote machine", () => actions.remoteConnect()),
        action("Browse Extensions", "Themes, icons, language grammars from Open VSX", () => actions.exec("view.extensions")),
      ),
      h("h3", { text: "Keyboard shortcuts" }),
      h(
        "div",
        { class: "onb-keys" },
        ...keys.map(([label, id]) => h("div", {}, h("span", { text: label }), h("kbd", { text: actions.keyOf(id) ?? "" }))),
      ),
    ];
  }

  render();
}
