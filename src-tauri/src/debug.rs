//! Debugging support: a line-based process bridge (for GDB/MI and GDB
//! servers) and detection of the debug tools installed on this machine.

use crate::fs_cmds::display_path;
use crate::lsp::{hide_window, on_path};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

// ------------------------------------------------------------------ process bridge

struct Proc {
    child: Child,
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
pub struct ProcState {
    procs: Mutex<HashMap<u32, Proc>>,
    next_id: AtomicU32,
}

#[derive(Serialize, Clone)]
struct ProcLine {
    id: u32,
    stream: &'static str,
    line: String,
}

#[derive(Serialize, Clone)]
struct ProcExit {
    id: u32,
    code: Option<i32>,
}

/// Start a process whose stdout/stderr are forwarded line by line as
/// `proc://line` events (used for gdb --interpreter=mi and GDB servers).
#[tauri::command]
pub fn proc_start(app: AppHandle, state: tauri::State<'_, Arc<ProcState>>, command: String, args: Vec<String>, cwd: Option<String>) -> Result<u32, String> {
    let mut cmd = Command::new(&command);
    cmd.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(dir) = cwd.filter(|d| Path::new(d).is_dir()) {
        cmd.current_dir(dir);
    }
    let mut child = hide_window(&mut cmd).spawn().map_err(|e| format!("Cannot start {command}: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdin = child.stdin.take();
    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    state.procs.lock().unwrap().insert(id, Proc { child, stdin });

    let app_err = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app_err.emit("proc://line", ProcLine { id, stream: "err", line });
        }
    });
    let state_ref = state.inner().clone();
    std::thread::spawn(move || {
        // Lossy decoding: GDB may print paths in the ANSI code page.
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string();
                    let _ = app.emit("proc://line", ProcLine { id, stream: "out", line });
                }
            }
        }
        let code = state_ref.procs.lock().unwrap().remove(&id).and_then(|mut p| p.child.wait().ok()).and_then(|s| s.code());
        let _ = app.emit("proc://exit", ProcExit { id, code });
    });
    Ok(id)
}

#[tauri::command]
pub fn proc_write(state: tauri::State<'_, Arc<ProcState>>, id: u32, text: String) -> Result<(), String> {
    let mut procs = state.procs.lock().unwrap();
    let p = procs.get_mut(&id).ok_or("Process is not running")?;
    let stdin = p.stdin.as_mut().ok_or("Process has no input")?;
    stdin.write_all(text.as_bytes()).and_then(|_| stdin.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn proc_kill(state: tauri::State<'_, Arc<ProcState>>, id: u32) {
    if let Some(mut p) = state.procs.lock().unwrap().remove(&id) {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
}

pub fn kill_all(state: &ProcState) {
    for (_, mut p) in state.procs.lock().unwrap().drain() {
        let _ = p.child.kill();
    }
}

// ------------------------------------------------------------------ tool detection

#[derive(Serialize, Default)]
pub struct DebugTools {
    pub gdb: Option<String>,
    pub stlink_server: Option<String>,
    /// Folder with STM32_Programmer_CLI (ST-LINK_gdbserver needs it, `-cp`).
    pub cube_programmer_dir: Option<String>,
    pub openocd: Option<String>,
    pub jlink_server: Option<String>,
}

fn cubeide_plugin_tools(fragment: &str, exe: &str) -> Option<PathBuf> {
    let mut found = Vec::new();
    for ide in fs::read_dir(r"C:\ST").into_iter().flatten().filter_map(Result::ok) {
        let plugins = ide.path().join("STM32CubeIDE").join("plugins");
        for p in fs::read_dir(&plugins).into_iter().flatten().filter_map(Result::ok) {
            if p.file_name().to_string_lossy().contains(fragment) {
                let candidate = p.path().join("tools").join("bin").join(exe);
                if candidate.is_file() {
                    found.push(candidate);
                }
            }
        }
    }
    found.sort();
    found.pop()
}

fn find_gdb() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "arm-none-eabi-gdb.exe" } else { "arm-none-eabi-gdb" };
    if let Some(p) = on_path(exe) {
        return Some(p);
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let p = PathBuf::from(home).join(".eide").join("tools").join("gcc_arm").join("bin").join(exe);
        if p.is_file() {
            return Some(p);
        }
    }
    cubeide_plugin_tools("gnu-tools-for-stm32", exe)
}

#[tauri::command]
pub async fn debug_tools() -> Result<DebugTools, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let stlink = on_path("ST-LINK_gdbserver.exe").or_else(|| cubeide_plugin_tools("stlink-gdb-server", "ST-LINK_gdbserver.exe"));
        let cube = on_path("STM32_Programmer_CLI.exe")
            .or_else(|| {
                [std::env::var_os("ProgramFiles"), std::env::var_os("ProgramFiles(x86)")]
                    .into_iter()
                    .flatten()
                    .map(|b| PathBuf::from(b).join(r"STMicroelectronics\STM32Cube\STM32CubeProgrammer\bin\STM32_Programmer_CLI.exe"))
                    .find(|p| p.is_file())
            })
            .or_else(|| cubeide_plugin_tools("cubeprogrammer", "STM32_Programmer_CLI.exe"));
        DebugTools {
            gdb: find_gdb().map(|p| display_path(&p)),
            stlink_server: stlink.map(|p| display_path(&p)),
            cube_programmer_dir: cube.and_then(|p| p.parent().map(display_path)),
            openocd: on_path("openocd.exe").or_else(|| on_path("openocd")).map(|p| display_path(&p)),
            jlink_server: on_path("JLinkGDBServerCL.exe").or_else(|| cubeide_plugin_tools("jlink", "JLinkGDBServerCL.exe")).map(|p| display_path(&p)),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_gdb_somewhere_or_none() {
        // Must not panic whatever is installed.
        let _ = find_gdb();
        let _ = cubeide_plugin_tools("does-not-exist", "x.exe");
    }
}
