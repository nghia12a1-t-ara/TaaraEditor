# Taara Editor (Rust version)

A lightweight code editor for embedded developers, the Rust/Tauri rewrite of the
[Python Taara IDE](https://github.com/nghia12a1-t-ara/TaaraMCU-IDE): a fast editor with build, flash, debug, Git
and Remote SSH for STM32 projects, and support for VS Code extensions (`.vsix`).

- **Backend:** Rust + [Tauri 2](https://v2.tauri.app). It uses the system WebView2, so it ships no Chromium.
- **Editor:** [Monaco](https://microsoft.github.io/monaco-editor/), the editor core of VS Code.
- **UI:** plain TypeScript + CSS, with no UI framework.
- **Installer:** NSIS per-user `setup.exe` (no administrator rights), updates itself from GitHub Releases.

## Install

Download `Taara.Editor_<version>_x64-setup.exe` from the
[latest release](https://github.com/nghia12a1-t-ara/TaaraEditor/releases/latest) and run it.
The first start shows a short welcome tour (theme, tool check, where to start); reopen it with
Help → Welcome Tour.

## Features

| Area | What you get |
|------|--------------|
| Editing | Monaco: multi-cursor, find/replace with regex, folding, bracket colorization, minimap, sticky scroll, word-based completion |
| Files | Open file/folder, tabs (drag to reorder, middle-click to close), dirty markers, Save/Save As/Save All, encodings (UTF-8, UTF-8 BOM, UTF-16 LE/BE, Windows-1252), CRLF/LF |
| Explorer | Lazy file tree, new file/folder, rename, copy path, reveal active file |
| Search | VS Code-style Search view: regex / case / whole word, **Replace** (preserve case, `$1` groups, live preview, per match / per file / all), files to include / exclude globs, open-editors-only, `.gitignore` toggle, searches unsaved editor content, parallel and cancellable. Quick Open (Ctrl+P) |
| Code navigation | Workspace symbol index in Rust (incremental, parallel): Go to Definition / Peek (F12, Ctrl+Click) for functions, prototypes, macros, enum members, typedefs, globals and struct fields; definition → declaration jump; `#include` navigation; Find All References (Shift+F12); Go to Symbol in Workspace (Ctrl+T) and in File (Ctrl+R); Function List; breadcrumb |
| C/C++ IntelliSense | **clangd** (LSP): semantic completion, hover, signature help, errors as you type (with a problems counter), Format Document (Shift+Alt+F), precise definition/references. One-click install of the official clangd (SHA-256 verified). Works without `compile_commands.json`: detects the STM32 device (`-DSTM32F407xx` → Cortex-M4), HAL/LL defines, include folders and the ARM GCC system headers from Makefile / CubeIDE / Keil / **EIDE** projects |
| Terminal | Integrated terminal (Ctrl+`): PowerShell / Command Prompt / Git Bash in a real ConPTY, several terminals, theme colors, Ctrl+C/Ctrl+V copy-paste, **Ctrl+Click on `file.c:12:5` in the output opens it**, resizable / maximizable panel |
| Build / Flash | Build (F7 / Ctrl+Shift+B), Rebuild, Clean, Flash (Ctrl+F8), Build & Flash (Ctrl+F9), toolbar buttons. Auto-detected from Makefile targets (`build` / `clean` / `run` like the Python version), STM32CubeIDE `Debug/makefile`, CMake / CMakePresets, or `.taara/tasks.json`. Flash with STM32CubeProgrammer (standalone or **bundled in STM32CubeIDE**), OpenOCD or st-flash; `${elf}` / `${bin}` resolve to the newest output. Saves all files first; gcc / ld errors go to the **Problems** panel (Ctrl+Shift+M) and the editor |
| Remote SSH | Built in (pure Rust, `russh`): **⇄** status-bar button or File → Open Remote Folder (SSH). Hosts from `~/.ssh/config`, auth via Windows ssh-agent, `~/.ssh/id_*` keys (ed25519 / ECDSA / RSA, passphrase prompt) or password; `~/.ssh/known_hosts` checked like OpenSSH (fingerprint prompt for new hosts, connection refused when a host key changed). Remote folder in the Explorer over SFTP, edit and save remote files, Search (grep on the host), Quick Open (find on the host), terminal = shell on the host, session restored on restart. Passwords are never stored |
| Debugging | **Run and Debug** view (Ctrl+Shift+D) and Debug menu, like VS Code: F5 builds, starts the GDB server (**ST-LINK_gdbserver** from STM32CubeIDE/CubeProgrammer, or OpenOCD), loads the program and stops at `main()`; or `"server": "none"` to attach to any GDB server (J-Link, pyOCD, QEMU, Renode…). Breakpoints in the gutter / F9 (saved per project, follow edits), F10 / F11 / Shift+F11 / F6 / Shift+F5 / Ctrl+Shift+F5, floating debug toolbar, Variables (expandable structs and pointers, double-click to edit), Watch, Call Stack, hover values, Debug Console for GDB commands. Uses `arm-none-eabi-gdb` from EIDE, CubeIDE or PATH |
| Git | **Source Control** view (Ctrl+Shift+G) with a change-count badge: staged / changes / merge conflicts, stage / unstage / discard per file or all, commit (Ctrl+Enter, smart commit, amend), pull / push (publishes new branches) / sync / fetch, side-by-side **diff viewer**. Editor gutter shows added / modified / deleted lines while you type; Explorer colors files by status (M / U / A / D); branch and ahead/behind in the status bar (click to checkout or create a branch). Uses your installed git, so its config, hooks and credentials apply |
| Languages | C/C++, ASM, linker scripts, Makefile, CMake, Python, Rust, JSON, YAML, XML, Markdown, shell… plus anything installed from a `.vsix` |
| Themes | Dark, Light, Monokai, Khaki, plus any VS Code color theme or file icon theme (File → Preferences → File Icon Theme) from a `.vsix` |
| Extensions | Search and install from the [Open VSX](https://open-vsx.org) marketplace (Ctrl+Shift+X), or install a local `.vsix` (button, drag & drop, double-click). Uses the extension's themes, grammars, languages and snippets |
| Toolbar | Notepad++-style toggles in the menu bar row: Word Wrap, Show All Characters (spaces, tabs and `CRLF`/`LF` markers), Function List |
| Updates | Checks GitHub Releases a few seconds after startup (can be turned off in the welcome tour) and shows **⇧ Update x.y.z** in the status bar; Help → Check for Updates… on demand. Install and Restart / Skip This Version / Later. Updates are signed and verified before installing |
| Session | Window size/position, open folder, open files, active tab, panels, theme and preferences are restored |

The symbol parser is a fast heuristic written in TypeScript ([src/symbols.ts](src/symbols.ts)).
It handles typical firmware code: `typedef struct {…} X_t`, `__attribute__((weak))`,
return types on their own line, C++ methods and constructors, and ASM labels. ctags is not needed.

## Quick start (developers)

Prerequisites: Rust (MSVC toolchain), Node.js 18+. WebView2 ships with Windows 10/11.
The Tauri CLI comes with `npm install`.

```bash
npm install
npm run tauri dev                                              # run with hot reload
powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1  # signed release exe + installer
```

The release build signs the update bundle, so it needs the updater key: the script reads
`%USERPROFILE%\.tauri\taara-editor.key` (and `taara-editor.key.password.txt`) or the
`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` environment variables.
`-Test` keeps the `window.__taaraDebug` hook used by automated UI tests; normal release builds
don't contain it.

Outputs:

- `src-tauri/target/release/taara-editor.exe` is the portable exe.
- `src-tauri/target/release/bundle/nsis/Taara Editor_<version>_x64-setup.exe` is the installer
  (plus `.exe.sig`, its update signature).

Tests:

```bash
cd src-tauri && cargo test     # Rust: encodings, search/replace/globs, symbol parser, index, VSIX, marketplace
npx tsc --noEmit               # frontend type check
```

> **Note:** If `CC`/`CXX` are set globally to MinGW (for example by Qt), MSVC builds break.
> [src-tauri/.cargo/config.toml](src-tauri/.cargo/config.toml) overrides them for this project only.

## Releasing

GitHub Actions ([.github/workflows](.github/workflows)):

- **CI** (`ci.yml`, every push / pull request): `tsc` + Vite build, `cargo clippy -D warnings`, `cargo test`.
- **Release** (`release.yml`, on a `v*` tag): builds the installer, signs the update and creates a
  **draft** GitHub Release with the installer, `.sig` and `latest.json`.

One-time setup: in the GitHub repository, Settings → Secrets and variables → Actions, add
`TAURI_SIGNING_PRIVATE_KEY` (the content of `taara-editor.key`) and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The public key is in
[tauri.conf.json](src-tauri/tauri.conf.json) (`plugins.updater.pubkey`). Back up the private key:
without it, installed copies can't be updated any more.

To release a version:

```bash
node scripts/version.mjs set 0.2.0      # package.json, Cargo.toml, tauri.conf.json
git commit -am "Release 0.2.0"
git tag v0.2.0 && git push origin main v0.2.0
```

Then review the draft release on GitHub and click **Publish release**. Installed editors find the
update through `https://github.com/nghia12a1-t-ara/TaaraEditor/releases/latest/download/latest.json`,
so only published (non-draft, non-prerelease) releases are offered.

## Keyboard shortcuts

| Action | Shortcut |
|--------|----------|
| New File / Open File / Open Folder | Ctrl+N / Ctrl+O / Ctrl+Shift+O |
| Save / Save As / Save All | Ctrl+S / Ctrl+Shift+S / Ctrl+Alt+S |
| Close Tab / Switch Tabs | Ctrl+W / Ctrl+1…9, Ctrl+Tab |
| Find / Replace / Find in Files / Replace in Files | Ctrl+F / Ctrl+H / Ctrl+Shift+F / Ctrl+Shift+H |
| Quick Open / Command Palette | Ctrl+P / Ctrl+Shift+P |
| Go to Line / Symbol in File / Symbol in Workspace | Ctrl+G / Ctrl+R / Ctrl+T |
| Go to Definition / Peek / References | F12 or Ctrl+Click / Alt+F12 / Shift+F12 |
| Toggle Sidebar / Function List | Ctrl+B / Ctrl+Alt+O |
| Explorer / Search / Extensions | Ctrl+Shift+E / F / X |
| Word Wrap / Zoom | Alt+Z / Ctrl+= Ctrl+- Ctrl+0 |
| Color Theme | Ctrl+K Ctrl+T |
| Toggle Terminal / New Terminal | Ctrl+` / Ctrl+Shift+` |
| Start or Continue / Stop / Restart debugging | F5 / Shift+F5 / Ctrl+Shift+F5 |
| Step Over / Into / Out / Pause | F10 / F11 / Shift+F11 / F6 |
| Toggle Breakpoint | F9 |
| Source Control | Ctrl+Shift+G (commit with Ctrl+Enter) |
| Build / Flash / Build and Flash | F7 or Ctrl+Shift+B / Ctrl+F8 / Ctrl+F9 |

## Where data is stored

- `%APPDATA%\com.taaramcu.editor\settings.json` stores settings and the session.
- `%LOCALAPPDATA%\com.taaramcu.editor\extensions\<publisher>.<name>-<version>\` stores unpacked extensions.

## Project structure

```
TaaraEditor/
├── index.html, src/            # Frontend (TypeScript, bundled by Vite)
│   ├── main.ts                 # Wiring: commands, menus, keybindings, session
│   ├── editor-manager.ts       # Documents, tabs, save/close logic
│   ├── monaco-setup.ts         # Monaco with only the languages we need
│   ├── themes.ts               # VS Code theme JSON -> Monaco rules + workbench CSS vars
│   ├── file-icons.ts           # File icon themes (VS Code iconThemes format)
│   ├── textmate.ts             # TextMate grammars (vscode-textmate + Oniguruma WASM)
│   ├── extension-host.ts       # Applies .vsix contributions
│   ├── symbols.ts              # Function list / breadcrumb parser
│   ├── navigation.ts           # Definition, references, workspace symbols, #include
│   ├── lsp-client.ts           # JSON-RPC client for language servers
│   ├── clangd.ts               # clangd features for Monaco (completion, hover, diagnostics...)
│   ├── build-tasks.ts          # Build / flash orchestration
│   ├── problems.ts             # gcc / ld output parser, Problems store, build markers
│   ├── remote.ts               # ssh:// paths, connect flow (host key / password prompts), remote search
│   ├── gdb-mi.ts               # GDB/MI parser and client
│   ├── debug.ts                # Debug session: server, breakpoints, stepping, variables, watch, hover
│   ├── git.ts                  # Git status, operations, editor gutter
│   ├── line-diff.ts            # Myers line diff for the gutter
│   ├── text-search.ts          # Search / replace in open editors (unsaved content)
│   ├── updater.ts              # Update check / download / install (GitHub Releases)
│   └── ui/                     # Explorer, search, extensions, outline, status bar, menus, quick pick, welcome tour
├── scripts/
│   ├── version.mjs             # Set / check the version in all three manifests
│   └── build-release.ps1       # Local signed release build
└── src-tauri/                  # Rust backend
    ├── src/fs_cmds.rs          # Read/write with encoding detection, explorer ops, file listing
    ├── src/search.rs           # Search / replace in files (globs, .gitignore, parallel, cancellable)
    ├── src/symbols.rs          # Symbol parser for the index (C/C++, ASM, Python, Rust, JS/TS)
    ├── src/index.rs            # Incremental workspace symbol index
    ├── src/lsp.rs              # Language server bridge, clangd install, embedded compile-flag detection
    ├── src/pty.rs              # Terminal sessions (ConPTY via portable-pty), task runner
    ├── src/tasks.rs            # Build / clean / flash command detection, flash tools, artifacts
    ├── src/remote.rs           # Remote SSH: ssh_config, auth, known_hosts, SFTP, exec, remote shells
    ├── src/debug.rs            # Process bridge for GDB/MI and GDB servers, debug tool detection
    ├── src/git.rs              # git status (porcelain v2), git commands, file contents at HEAD / index
    ├── src/extensions.rs       # .vsix install/uninstall/list, package.nls.json resolution
    ├── src/marketplace.rs      # Open VSX search / manifest / verified download
    ├── src/settings.rs         # settings.json persistence
    └── tauri.conf.json         # Window + NSIS installer config
```

## VS Code extension support

Extensions follow VS Code's own format. A `.vsix` is unpacked as is, and `package.json` → `contributes` is read.

| Contribution | Status |
|--------------|--------|
| `themes` (color themes, incl. `include` chains, JSONC) | ✅ |
| `grammars` (TextMate `.tmLanguage.json` / plist, injections) | ✅ |
| `languages` (ids, extensions, filenames, `language-configuration.json`) | ✅ |
| `snippets` | ✅ |
| `iconThemes` (file icon themes: Material Icon Theme, vscode-icons…; SVG or icon fonts, light variants) | ✅ |
| `productIconThemes` | ⏳ planned |
| `commands`, `keybindings`, `menus`, `configuration` | ⏳ needs extension host |
| Extension code (`main` / `activationEvents`) | ⏳ needs extension host |
| VS Code Remote extensions (Remote-SSH, Open Remote - SSH) | ✗ rely on VS Code's remote server architecture; use Taara's built-in Remote SSH instead |
| Marketplace (Open VSX): search, categories, compatibility check before install, SHA-256 verified download | ✅ |

### Plan for running extension code

1. **Extension host process:** bundle a small Node.js runtime as a Tauri *sidecar* and run
   extensions there. VS Code itself does the same. This keeps the editor process light,
   and the host starts only when an installed extension needs it.
2. **`vscode` API shim:** implement the API that embedded extensions use most
   (`commands`, `window`, `workspace`, `languages.*Provider`, `TextDocument`, `Diagnostic`)
   and forward it over JSON-RPC: Node host ↔ Rust ↔ Monaco providers.
3. **Language servers:** many language extensions (for example clangd and cortex-debug's helpers)
   are thin LSP clients. Supporting `vscode-languageclient` gives the largest win, because Monaco
   providers map almost 1:1 to LSP requests.

## Roadmap

- [x] Text editor with VS Code-like workbench
- [x] Declarative VSIX support (themes, grammars, languages, snippets)
- [x] File icon themes from VSIX
- [x] Open VSX marketplace (search, install, update)
- [ ] Node extension host + `vscode` API subset
- [x] LSP (clangd) integration
- [x] Build / flash for STM32 (ported from the Python version)
- [x] Debugging (ST-LINK GDB server / OpenOCD / any GDB server + GDB/MI)
- [x] Integrated terminal
- [x] Git integration (Source Control, diff, gutter)
- [x] Remote SSH
- [x] Auto-update from GitHub Releases, CI / release workflows, first-run welcome tour
- [ ] Debug views for MCUs (registers, SVD peripherals, memory, disassembly)
