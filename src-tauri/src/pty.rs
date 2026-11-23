//! Integrated terminal: shells running in a pseudo terminal (ConPTY on
//! Windows), streamed to xterm.js through `pty://data` events.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
}

#[derive(Serialize, Clone)]
struct PtyData {
    id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: u32,
    code: Option<u32>,
}

#[derive(Serialize, Clone)]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
}

/// Decode a byte stream as UTF-8 without breaking multi-byte characters that
/// are split across reads.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    out.push_str(s);
                    self.pending.clear();
                    return out;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap());
                    match e.error_len() {
                        // Incomplete sequence at the end: keep it for the next read.
                        None => {
                            self.pending.drain(..valid);
                            return out;
                        }
                        // Invalid bytes: replace them and continue.
                        Some(len) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + len);
                        }
                    }
                }
            }
        }
    }
}

fn existing(p: PathBuf) -> Option<String> {
    p.is_file().then(|| crate::fs_cmds::display_path(&p))
}

fn on_path(exe: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|d| d.join(exe)).find(|p| p.is_file()))
}

/// Shells available on this machine, default first.
#[tauri::command]
pub fn pty_shells() -> Vec<ShellInfo> {
    let mut shells = Vec::new();
    let mut add = |name: &str, path: Option<String>, args: &[&str]| {
        if let Some(path) = path {
            if !shells.iter().any(|s: &ShellInfo| s.path.eq_ignore_ascii_case(&path)) {
                shells.push(ShellInfo { name: name.into(), path, args: args.iter().map(|a| a.to_string()).collect() });
            }
        }
    };
    if cfg!(windows) {
        let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        let system_root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        add("PowerShell", on_path("pwsh.exe").and_then(existing).or_else(|| existing(program_files.join(r"PowerShell\7\pwsh.exe"))), &["-NoLogo"]);
        add("Windows PowerShell", existing(system_root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe")), &["-NoLogo"]);
        add("Command Prompt", std::env::var_os("ComSpec").map(PathBuf::from).and_then(existing).or_else(|| existing(system_root.join(r"System32\cmd.exe"))), &[]);
        add("Git Bash", existing(program_files.join(r"Git\bin\bash.exe")), &["--login", "-i"]);
    } else {
        let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        add("Shell", existing(PathBuf::from(sh)), &["-l"]);
    }
    shells
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: tauri::State<'_, Arc<PtyState>>,
    shell: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let mut cmd = CommandBuilder::new(&shell);
    cmd.args(&args);
    spawn_session(app, state.inner(), cmd, cwd, cols, rows, None).map_err(|e| format!("Cannot start {shell}: {e}"))
}

/// Run a command line (build / flash task) in a terminal. The command is
/// written to a temporary .cmd file so quoting and `&&` work exactly as typed.
#[tauri::command]
pub fn pty_spawn_task(app: AppHandle, state: tauri::State<'_, Arc<PtyState>>, command: String, cwd: Option<String>, cols: u16, rows: u16) -> Result<u32, String> {
    if cfg!(windows) {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let script = std::env::temp_dir().join(format!("taara-task-{stamp}.cmd"));
        // CRLF line endings for cmd.exe; UTF-8 code page for non-ASCII paths.
        let lines: Vec<&str> = command.lines().collect();
        let body = format!("@echo off\r\nchcp 65001 >nul\r\n{}\r\nexit /b %ERRORLEVEL%\r\n", lines.join("\r\n"));
        std::fs::write(&script, body).map_err(|e| e.to_string())?;
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        let mut cmd = CommandBuilder::new(comspec);
        cmd.args(["/d", "/c"]);
        cmd.arg(&script);
        spawn_session(app, state.inner(), cmd, cwd, cols, rows, Some(script))
    } else {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", &command]);
        spawn_session(app, state.inner(), cmd, cwd, cols, rows, None)
    }
}

fn spawn_session(
    app: AppHandle,
    state: &Arc<PtyState>,
    mut cmd: CommandBuilder,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    cleanup: Option<PathBuf>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    if let Some(dir) = cwd.filter(|d| Path::new(d).is_dir()) {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "TaaraEditor");
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    state.sessions.lock().unwrap().insert(id, Session { master: pair.master, writer, killer });

    let app_out = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut utf8 = Utf8Stream::default();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = utf8.push(&buf[..n]);
                    if !data.is_empty() {
                        let _ = app_out.emit("pty://data", PtyData { id, data });
                    }
                }
            }
        }
    });
    // With ConPTY the reader only ends once the pseudo console is closed, so
    // wait for the process itself and then drop the session.
    let state_ref = state.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        // Let the reader flush the last output before the session closes.
        std::thread::sleep(std::time::Duration::from_millis(150));
        state_ref.sessions.lock().unwrap().remove(&id);
        if let Some(p) = cleanup {
            let _ = std::fs::remove_file(p);
        }
        let _ = app.emit("pty://exit", PtyExit { id, code });
    });
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: tauri::State<'_, Arc<PtyState>>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("Terminal has exited")?;
    s.writer.write_all(data.as_bytes()).and_then(|_| s.writer.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: tauri::State<'_, Arc<PtyState>>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("Terminal has exited")?;
    s.master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, Arc<PtyState>>, id: u32) {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        let _ = s.killer.kill();
    }
}

/// Kill all shells (on app exit).
pub fn kill_all(state: &PtyState) {
    for (_, mut s) in state.sessions.lock().unwrap().drain() {
        let _ = s.killer.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_split_across_reads() {
        let text = "Xin chào 😀 ok";
        let bytes = text.as_bytes();
        let mut s = Utf8Stream::default();
        let mut out = String::new();
        // Feed one byte at a time: multi-byte chars arrive in pieces.
        for b in bytes {
            out.push_str(&s.push(&[*b]));
        }
        assert_eq!(out, text);
        assert_eq!(Utf8Stream::default().push(&[b'a', 0xFF, b'b']), "a\u{FFFD}b");
    }

    #[test]
    fn finds_a_shell() {
        assert!(!pty_shells().is_empty());
    }

    #[test]
    fn spawn_echo_and_exit() {
        // Exercise the real PTY path without Tauri: run a command and read its output.
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let shell = pty_shells().into_iter().find(|s| s.name.contains("Command") || s.name == "Shell").unwrap();
        let mut cmd = CommandBuilder::new(&shell.path);
        if cfg!(windows) {
            cmd.args(["/c", "echo", "taara-pty-ok"]);
        } else {
            cmd.args(["-c", "echo taara-pty-ok"]);
        }
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut all = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                // ConPTY asks for the cursor position at startup and waits for
                // the answer; a terminal (xterm.js in the app) replies to it.
                if buf[..n].windows(4).any(|w| w == b"\x1b[6n") {
                    let _ = writer.write_all(b"\x1b[1;1R");
                }
                all.extend_from_slice(&buf[..n]);
                if String::from_utf8_lossy(&all).contains("taara-pty-ok") {
                    let _ = tx.send(String::from_utf8_lossy(&all).into_owned());
                }
            }
        });
        let out = rx.recv_timeout(std::time::Duration::from_secs(20)).expect("no output from the shell within 20 s");
        assert!(out.contains("taara-pty-ok"));
        assert!(child.wait().unwrap().success());
        drop(pair.master);
    }
}
