//! Language servers (clangd for C/C++).
//!
//! * A generic stdio JSON-RPC bridge: the server runs as a child process (no
//!   console window); framed messages are forwarded to the UI as
//!   `lsp://message` events, and the UI sends requests back with `lsp_send`.
//! * Locating / installing clangd (official release from github.com/clangd,
//!   SHA-256 verified).
//! * Guessing compile flags for embedded projects that have no
//!   compile_commands.json (STM32CubeIDE, Makefile, Keil, EIDE...).

use crate::fs_cmds::display_path;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Manager};

// ------------------------------------------------------------------ process bridge

struct Proc {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct LspState {
    procs: Mutex<HashMap<u32, Proc>>,
    next_id: AtomicU32,
}

#[derive(Serialize, Clone)]
struct LspMessage {
    id: u32,
    message: String,
}

#[derive(Serialize, Clone)]
struct LspExit {
    id: u32,
    code: Option<i32>,
}

#[derive(Serialize, Clone)]
struct LspLog {
    id: u32,
    line: String,
}

/// Don't flash a console window for child processes on Windows.
pub(crate) fn hide_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Read one `Content-Length` framed message. `Ok(None)` at end of stream.
fn read_frame(reader: &mut impl BufRead) -> std::io::Result<Option<String>> {
    let mut len: Option<usize> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            if len.is_some() {
                break;
            }
            continue;
        }
        if let Some(v) = line.strip_prefix("Content-Length:") {
            len = v.trim().parse().ok();
        }
    }
    let mut body = vec![0u8; len.unwrap_or(0)];
    reader.read_exact(&mut body)?;
    Ok(Some(String::from_utf8_lossy(&body).into_owned()))
}

#[tauri::command]
pub fn lsp_start(app: AppHandle, state: tauri::State<'_, Arc<LspState>>, command: String, args: Vec<String>, cwd: Option<String>) -> Result<u32, String> {
    let mut cmd = Command::new(&command);
    cmd.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(dir) = cwd.filter(|d| Path::new(d).is_dir()) {
        cmd.current_dir(dir);
    }
    let mut child = hide_window(&mut cmd).spawn().map_err(|e| format!("Cannot start {command}: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    state.procs.lock().unwrap().insert(id, Proc { child, stdin });

    let state_ref = state.inner().clone();
    let app_out = app.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Ok(Some(message)) = read_frame(&mut reader) {
            let _ = app_out.emit("lsp://message", LspMessage { id, message });
        }
        let code = state_ref.procs.lock().unwrap().remove(&id).and_then(|mut p| p.child.wait().ok()).and_then(|s| s.code());
        let _ = app_out.emit("lsp://exit", LspExit { id, code });
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app.emit("lsp://log", LspLog { id, line });
        }
    });
    Ok(id)
}

#[tauri::command]
pub fn lsp_send(state: tauri::State<'_, Arc<LspState>>, id: u32, message: String) -> Result<(), String> {
    let mut procs = state.procs.lock().unwrap();
    let p = procs.get_mut(&id).ok_or("Language server is not running")?;
    write!(p.stdin, "Content-Length: {}\r\n\r\n{}", message.len(), message)
        .and_then(|_| p.stdin.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lsp_stop(state: tauri::State<'_, Arc<LspState>>, id: u32) {
    if let Some(mut p) = state.procs.lock().unwrap().remove(&id) {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
}

/// Kill all servers (on app exit).
pub fn stop_all(state: &LspState) {
    for (_, mut p) in state.procs.lock().unwrap().drain() {
        let _ = p.child.kill();
    }
}

// ------------------------------------------------------------------ clangd

#[derive(Serialize)]
pub struct ClangdInfo {
    pub path: String,
    pub version: String,
    pub source: String,
}

const CLANGD_EXE: &str = if cfg!(windows) { "clangd.exe" } else { "clangd" };

fn tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("tools");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// `<dir>/*/bin/clangd.exe`, newest folder name first.
fn bundled_in(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|e| e.path().join("bin").join(CLANGD_EXE))
        .filter(|p| p.is_file())
        .collect();
    found.sort();
    found.reverse();
    found
}

pub(crate) fn on_path(exe: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|d| d.join(exe)).find(|p| p.is_file()))
}

fn clangd_version(path: &Path) -> Option<String> {
    let out = hide_window(Command::new(path).arg("--version")).stdin(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.contains("clangd version"))?;
    Some(line.split("clangd version").nth(1)?.split_whitespace().next()?.to_string())
}

#[tauri::command]
pub async fn clangd_find(app: AppHandle, custom: Option<String>) -> Result<Option<ClangdInfo>, String> {
    let tools = tools_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut candidates: Vec<(PathBuf, &str)> = Vec::new();
        if let Some(c) = custom.filter(|c| !c.trim().is_empty()) {
            candidates.push((PathBuf::from(c.trim()), "settings"));
        }
        candidates.extend(bundled_in(&tools).into_iter().map(|p| (p, "Taara")));
        if let Some(p) = on_path(CLANGD_EXE) {
            candidates.push((p, "PATH"));
        }
        for base in [std::env::var_os("ProgramFiles"), std::env::var_os("ProgramW6432")].into_iter().flatten() {
            candidates.push((PathBuf::from(base).join("LLVM").join("bin").join(CLANGD_EXE), "LLVM"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let install = PathBuf::from(appdata).join(r"Code\User\globalStorage\llvm-vs-code-extensions.vscode-clangd\install");
            for ver in fs::read_dir(&install).into_iter().flatten().filter_map(Result::ok) {
                candidates.extend(bundled_in(&ver.path()).into_iter().map(|p| (p, "VS Code clangd extension")));
            }
        }
        for (path, source) in candidates {
            if path.is_file() {
                if let Some(version) = clangd_version(&path) {
                    return Some(ClangdInfo { path: display_path(&path), version, source: source.to_string() });
                }
            }
        }
        None
    })
    .await
    .map_err(|e| e.to_string())
}

/// Download the latest official clangd release for Windows from GitHub,
/// verified against the SHA-256 digest GitHub publishes for the asset.
#[tauri::command]
pub async fn clangd_install(app: AppHandle) -> Result<ClangdInfo, String> {
    let tools = tools_dir(&app)?;
    let tools2 = tools.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let agent = crate::marketplace::agent();
        let release: Value = agent
            .get("https://api.github.com/repos/clangd/clangd/releases/latest")
            .set("Accept", "application/vnd.github+json")
            .call()
            .map_err(crate::marketplace::http_error)?
            .into_json()
            .map_err(|e| e.to_string())?;
        let asset = release["assets"]
            .as_array()
            .and_then(|a| a.iter().find(|a| a["name"].as_str().is_some_and(|n| n.starts_with("clangd-windows-") && n.ends_with(".zip"))))
            .ok_or("No Windows build in the latest clangd release")?;
        let url = asset["browser_download_url"].as_str().unwrap_or_default();
        if !url.starts_with("https://github.com/clangd/clangd/releases/download/") {
            return Err(format!("Unexpected download location: {url}"));
        }
        let digest = asset["digest"]
            .as_str()
            .and_then(|d| d.strip_prefix("sha256:"))
            .filter(|d| d.len() == 64)
            .ok_or("GitHub did not publish a SHA-256 digest for clangd; refusing to install")?
            .to_ascii_lowercase();
        let zip_path = tools2.join(".download-clangd.zip");
        let result = crate::marketplace::download_verified(&agent, url, &digest, &zip_path, 300 * 1024 * 1024).and_then(|_| {
            let mut zip = zip::ZipArchive::new(fs::File::open(&zip_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            for i in 0..zip.len() {
                let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
                let Some(rel) = entry.enclosed_name() else { continue };
                let out = tools2.join(rel);
                if entry.is_dir() {
                    fs::create_dir_all(&out).map_err(|e| e.to_string())?;
                } else {
                    if let Some(parent) = out.parent() {
                        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    let mut f = fs::File::create(&out).map_err(|e| e.to_string())?;
                    std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
                }
            }
            Ok(())
        });
        let _ = fs::remove_file(&zip_path);
        result
    })
    .await
    .map_err(|e| e.to_string())??;
    let path = bundled_in(&tools).into_iter().next().ok_or("clangd.exe not found in the downloaded archive")?;
    let version = clangd_version(&path).ok_or("The downloaded clangd does not run")?;
    Ok(ClangdInfo { path: display_path(&path), version, source: "Taara".into() })
}

// ------------------------------------------------------------------ project flags

#[derive(Serialize, Default)]
pub struct CppProjectConfig {
    /// Folder holding compile_commands.json, when the project has one.
    pub compile_commands_dir: Option<String>,
    /// Flags for files not covered by a compilation database.
    pub fallback_flags: Vec<String>,
    /// Human-readable summary for the status bar tooltip.
    pub summary: Vec<String>,
}

// No leading \b: the define usually follows "-D" ("-DSTM32F407xx").
pub(crate) static DEVICE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(STM32[A-Z][0-9]{2,3}[0-9A-Z]?x[0-9A-Zx])\b").unwrap());
const KNOWN_DEFINES: &[&str] = &["USE_HAL_DRIVER", "USE_FULL_LL_DRIVER", "USE_STDPERIPH_DRIVER", "ARM_MATH_CM0PLUS", "ARM_MATH_CM3", "ARM_MATH_CM4", "ARM_MATH_CM7"];

pub(crate) fn is_project_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(lower.as_str(), "makefile" | "cmakelists.txt" | ".cproject" | "eide.json" | "platformio.ini")
        || [".mk", ".cmake", ".ioc", ".uvprojx", ".uvproj", ".ewp"].iter().any(|e| lower.ends_with(e))
}

/// -mcpu for an STM32 family (e.g. STM32F407xx -> cortex-m4).
fn cpu_for(device: &str) -> &'static str {
    let fam = &device[5..7.min(device.len())];
    match fam {
        "F0" | "G0" | "C0" | "L0" | "U0" => "cortex-m0plus",
        "F1" | "F2" | "L1" => "cortex-m3",
        "F7" | "H7" => "cortex-m7",
        "L5" | "U5" | "H5" => "cortex-m33",
        _ => "cortex-m4",
    }
}

/// Ask arm-none-eabi-gcc for its system include directories.
fn gcc_system_includes() -> (Option<PathBuf>, Vec<String>) {
    let exe = if cfg!(windows) { "arm-none-eabi-gcc.exe" } else { "arm-none-eabi-gcc" };
    let mut gcc = on_path(exe);
    if gcc.is_none() {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            let p = PathBuf::from(home).join(".eide").join("tools").join("gcc_arm").join("bin").join(exe);
            gcc = p.is_file().then_some(p);
        }
    }
    let Some(gcc) = gcc else { return (None, vec![]) };
    let out = hide_window(Command::new(&gcc).args(["-xc", "-E", "-v", "-"]))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();
    let Ok(out) = out else { return (Some(gcc), vec![]) };
    let text = String::from_utf8_lossy(&out.stderr);
    let mut dirs = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        if line.starts_with("#include <...> search starts here:") {
            inside = true;
        } else if line.starts_with("End of search list.") {
            break;
        } else if inside {
            let p = PathBuf::from(line.trim());
            if p.is_dir() {
                let canon = fs::canonicalize(&p).unwrap_or(p);
                dirs.push(display_path(&canon));
            }
        }
    }
    (Some(gcc), dirs)
}

fn collect_eide(v: &Value, defines: &mut Vec<String>, incs: &mut Vec<String>) {
    match v {
        Value::Object(map) => {
            for (k, val) in map {
                if let (Some(list), true) = (val.as_array(), k == "defineList" || k == "incList") {
                    for s in list.iter().filter_map(Value::as_str) {
                        if k == "defineList" { defines.push(s.to_string()) } else { incs.push(s.to_string()) }
                    }
                } else {
                    collect_eide(val, defines, incs);
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|i| collect_eide(i, defines, incs)),
        _ => {}
    }
}

fn project_config(root: &Path) -> CppProjectConfig {
    let mut cfg = CppProjectConfig::default();

    // 1. A compilation database wins (CMake / Bear / EIDE export...).
    for entry in ignore::WalkBuilder::new(root).require_git(false).hidden(false).max_depth(Some(3)).build().filter_map(Result::ok) {
        if entry.file_name() == "compile_commands.json" {
            if let Some(dir) = entry.path().parent() {
                cfg.compile_commands_dir = Some(display_path(dir));
                cfg.summary.push(format!("compile_commands.json: {}", display_path(entry.path())));
                break;
            }
        }
    }

    // 2. Fallback flags: header folders, defines from project files, toolchain headers.
    let mut header_dirs = BTreeSet::new();
    let mut device_count: HashMap<String, usize> = HashMap::new();
    let mut defines = BTreeSet::new();
    let mut extra_incs = Vec::new();
    let mut sources = BTreeSet::new();
    for entry in ignore::WalkBuilder::new(root).require_git(false).hidden(false).max_depth(Some(14)).build().filter_map(Result::ok) {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        let lower = name.to_ascii_lowercase();
        if [".h", ".hpp", ".hh", ".hxx"].iter().any(|e| lower.ends_with(e)) {
            if let Some(dir) = entry.path().parent() {
                if header_dirs.len() < 500 {
                    header_dirs.insert(dir.to_path_buf());
                }
            }
        } else if is_project_file(&name) && entry.metadata().map(|m| m.len() < 4 * 1024 * 1024).unwrap_or(false) {
            let Ok(text) = fs::read_to_string(entry.path()) else { continue };
            for c in DEVICE.captures_iter(&text) {
                *device_count.entry(c[1].to_string()).or_default() += 1;
            }
            for d in KNOWN_DEFINES {
                // "-DUSE_HAL_DRIVER": there is no word boundary between "D" and "U".
                if Regex::new(&format!(r"(?:^|[^A-Za-z0-9_]|-D){d}\b")).unwrap().is_match(&text) {
                    defines.insert(d.to_string());
                }
            }
            if lower == "eide.json" {
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    let mut ds = Vec::new();
                    collect_eide(&v, &mut ds, &mut extra_incs);
                    defines.extend(ds.into_iter().filter(|d| !d.contains(char::is_whitespace)));
                }
            }
            sources.insert(display_path(entry.path().strip_prefix(root).unwrap_or(entry.path())));
        }
    }
    // Exactly one device define (two would break the CMSIS headers).
    let device = device_count.into_iter().max_by_key(|(_, n)| *n).map(|(d, _)| d);
    if let Some(d) = &device {
        defines.retain(|x| !DEVICE.is_match(x));
        defines.insert(d.clone());
    }

    let (gcc, sys) = gcc_system_includes();
    let embedded = device.is_some() || defines.iter().any(|d| d.starts_with("USE_"));
    let mut flags = Vec::new();
    if embedded {
        flags.push("--target=arm-none-eabi".to_string());
        flags.push(format!("-mcpu={}", device.as_deref().map(cpu_for).unwrap_or("cortex-m4")));
        flags.push("-mthumb".into());
        if sys.is_empty() {
            flags.push("-ffreestanding".into());
        }
    }
    flags.extend(defines.iter().map(|d| format!("-D{d}")));
    for inc in &extra_incs {
        let p = root.join(inc.replace('/', std::path::MAIN_SEPARATOR_STR));
        if p.is_dir() {
            header_dirs.insert(p);
        }
    }
    flags.extend(header_dirs.iter().map(|d| format!("-I{}", display_path(d))));
    if embedded {
        flags.extend(sys.iter().map(|d| format!("-isystem{d}")));
    }

    cfg.summary.push(match &device {
        Some(d) => format!("Target: {d} ({})", cpu_for(d)),
        None if embedded => "Target: ARM (device not detected)".into(),
        None => "Target: host".into(),
    });
    if !defines.is_empty() {
        cfg.summary.push(format!("Defines: {}", defines.iter().cloned().collect::<Vec<_>>().join(", ")));
    }
    cfg.summary.push(format!("Include folders: {}", header_dirs.len()));
    if let Some(g) = gcc {
        cfg.summary.push(format!("System headers from {} ({} folders)", display_path(&g), sys.len()));
    }
    if !sources.is_empty() {
        cfg.summary.push(format!("From: {}", sources.into_iter().take(5).collect::<Vec<_>>().join(", ")));
    }
    cfg.fallback_flags = flags;
    cfg
}

#[tauri::command]
pub async fn cpp_project_config(root: String) -> Result<CppProjectConfig, String> {
    tauri::async_runtime::spawn_blocking(move || project_config(Path::new(&root)))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frames_are_parsed() {
        let data = "Content-Length: 7\r\nContent-Type: x\r\n\r\n{\"a\":1}Content-Length: 2\r\n\r\n{}";
        let mut r = BufReader::new(Cursor::new(data));
        assert_eq!(read_frame(&mut r).unwrap().as_deref(), Some("{\"a\":1}"));
        assert_eq!(read_frame(&mut r).unwrap().as_deref(), Some("{}"));
        assert_eq!(read_frame(&mut r).unwrap(), None);
    }

    #[test]
    fn stm32_project_flags() {
        let dir = std::env::temp_dir().join(format!("taara-lsp-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Core/Inc")).unwrap();
        fs::create_dir_all(dir.join("Drivers/CMSIS/Include")).unwrap();
        fs::write(dir.join("Core/Inc/main.h"), "").unwrap();
        fs::write(dir.join("Drivers/CMSIS/Include/core_cm4.h"), "").unwrap();
        fs::write(dir.join("Makefile"), "C_DEFS = -DUSE_HAL_DRIVER -DSTM32F407xx\n").unwrap();
        let cfg = project_config(&dir);
        assert!(cfg.compile_commands_dir.is_none());
        let f = &cfg.fallback_flags;
        assert!(f.contains(&"--target=arm-none-eabi".to_string()));
        assert!(f.contains(&"-mcpu=cortex-m4".to_string()));
        assert!(f.contains(&"-DSTM32F407xx".to_string()));
        assert!(f.contains(&"-DUSE_HAL_DRIVER".to_string()));
        assert_eq!(f.iter().filter(|x| x.starts_with("-I")).count(), 2);

        fs::create_dir_all(dir.join("build")).unwrap();
        fs::write(dir.join("build/compile_commands.json"), "[]").unwrap();
        assert!(project_config(&dir).compile_commands_dir.unwrap().ends_with("build"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cpu_by_family() {
        assert_eq!(cpu_for("STM32F103xB"), "cortex-m3");
        assert_eq!(cpu_for("STM32H743xx"), "cortex-m7");
        assert_eq!(cpu_for("STM32G071xx"), "cortex-m0plus");
        assert!(DEVICE.is_match("-DSTM32F030x6"));
        assert!(!DEVICE.is_match("STM32F4xx_HAL_Driver"));
    }
}
