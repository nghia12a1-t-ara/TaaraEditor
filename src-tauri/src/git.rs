//! Git integration through the git command line (like VS Code): status,
//! file contents at HEAD / index for diffs, and running git commands.

use crate::fs_cmds::{decode, display_path};
use crate::lsp::{hide_window, on_path};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn git_exe() -> Result<PathBuf, String> {
    on_path(if cfg!(windows) { "git.exe" } else { "git" }).ok_or_else(|| "Git is not installed (git was not found in PATH)".to_string())
}

/// Run git in `cwd`. Never prompts in the terminal (credential helpers with a
/// GUI, like Git Credential Manager, still work).
fn git(cwd: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new(git_exe()?);
    cmd.args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut cmd).output().map_err(|e| format!("Cannot run git: {e}"))
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct GitFile {
    /// Absolute path.
    pub path: String,
    /// Path before a rename/copy, if any.
    pub orig_path: Option<String>,
    /// Index (staged) status: ' ', M, A, D, R, C, U, ?
    pub index: char,
    /// Working tree status: ' ', M, A, D, U, ?
    pub worktree: char,
    pub conflict: bool,
}

#[derive(Serialize, Debug, Default)]
pub struct GitStatus {
    pub is_repo: bool,
    pub root: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
}

/// Parse `git status --porcelain=v2 --branch -z`.
fn parse_status(root: &Path, out: &str) -> GitStatus {
    let mut st = GitStatus { is_repo: true, root: display_path(root), ..Default::default() };
    let abs = |p: &str| display_path(&root.join(p.replace('/', std::path::MAIN_SEPARATOR_STR)));
    let mut entries = out.split('\0').peekable();
    while let Some(e) = entries.next() {
        if e.is_empty() {
            continue;
        }
        if let Some(h) = e.strip_prefix("# branch.head ") {
            if h == "(detached)" {
                st.detached = true;
            } else {
                st.branch = Some(h.to_string());
            }
        } else if let Some(u) = e.strip_prefix("# branch.upstream ") {
            st.upstream = Some(u.to_string());
        } else if let Some(ab) = e.strip_prefix("# branch.ab ") {
            for part in ab.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    st.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    st.behind = n.parse().unwrap_or(0);
                }
            }
        } else if e.starts_with("# ") {
            // branch.oid and others
        } else if let Some(p) = e.strip_prefix("? ") {
            st.files.push(GitFile { path: abs(p), orig_path: None, index: '?', worktree: '?', conflict: false });
        } else if e.starts_with("! ") {
            // ignored
        } else {
            let kind = &e[..1];
            let fields: Vec<&str> = e.splitn(match kind { "1" => 9, "2" => 10, "u" => 11, _ => 2 }, ' ').collect();
            let xy: Vec<char> = fields.get(1).map(|s| s.chars().collect()).unwrap_or_default();
            let (x, y) = (xy.first().copied().unwrap_or(' '), xy.get(1).copied().unwrap_or(' '));
            let norm = |c: char| if c == '.' { ' ' } else { c };
            match kind {
                "1" => st.files.push(GitFile { path: abs(fields.last().unwrap_or(&"")), orig_path: None, index: norm(x), worktree: norm(y), conflict: false }),
                "2" => {
                    let orig = entries.next().map(abs);
                    st.files.push(GitFile { path: abs(fields.last().unwrap_or(&"")), orig_path: orig, index: norm(x), worktree: norm(y), conflict: false })
                }
                "u" => st.files.push(GitFile { path: abs(fields.last().unwrap_or(&"")), orig_path: None, index: 'U', worktree: 'U', conflict: true }),
                _ => {}
            }
        }
    }
    st
}

#[tauri::command]
pub async fn git_status(folder: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&folder);
        let top = git(&dir, &["rev-parse", "--show-toplevel"])?;
        if !top.status.success() {
            return Ok(GitStatus::default());
        }
        let root = PathBuf::from(String::from_utf8_lossy(&top.stdout).trim());
        let out = git(&root, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(parse_status(&root, &String::from_utf8_lossy(&out.stdout)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct GitOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Run `git <args>` in the repository (stage, commit, checkout, pull, push...).
#[tauri::command]
pub async fn git_run(root: String, args: Vec<String>) -> Result<GitOutput, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = git(Path::new(&root), &argv)?;
        Ok(GitOutput { code: out.status.code(), stdout: String::from_utf8_lossy(&out.stdout).into_owned(), stderr: String::from_utf8_lossy(&out.stderr).into_owned() })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// File content at a revision: `rev` = "HEAD" or "" (the index). Returns
/// null when the file does not exist there (new file).
#[tauri::command]
pub async fn git_show(root: String, rev: String, path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root_p = PathBuf::from(&root);
        let rel = Path::new(&path).strip_prefix(&root_p).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| path.replace('\\', "/"));
        let spec = format!("{rev}:{rel}");
        let out = git(&root_p, &["show", &spec])?;
        if !out.status.success() {
            return Ok(None);
        }
        Ok(Some(decode(&out.stdout).map(|f| f.content).unwrap_or_else(|_| String::from_utf8_lossy(&out.stdout).into_owned())))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let root = Path::new(r"C:\repo");
        let out = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb src/main.c\0\
1 A. N... 000000 100644 100644 000 ccc inc/new.h\0\
2 R. N... 100644 100644 100644 ddd eee R100 docs/new name.md\0docs/old.md\0\
u UU N... 100644 100644 100644 100644 a b c conflict.c\0\
? untracked.txt\0";
        let st = parse_status(root, out);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!(st.files.len(), 5);
        assert_eq!((st.files[0].index, st.files[0].worktree), (' ', 'M'));
        assert!(st.files[0].path.ends_with(r"src\main.c"));
        assert_eq!((st.files[1].index, st.files[1].worktree), ('A', ' '));
        assert!(st.files[2].path.ends_with("new name.md"));
        assert!(st.files[2].orig_path.as_deref().unwrap().ends_with("old.md"));
        assert!(st.files[3].conflict);
        assert_eq!(st.files[4].index, '?');
    }

    #[test]
    fn status_of_a_real_repo() {
        let Ok(_) = git_exe() else { return };
        let dir = std::env::temp_dir().join(format!("taara-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| assert!(git(&dir, args).unwrap().status.success(), "git {args:?}");
        run(&["init", "-q", "-b", "main"]);
        run(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
        std::fs::write(dir.join("a.c"), "int x;\n").unwrap();
        let out = git(&dir, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]).unwrap();
        let st = parse_status(&dir, &String::from_utf8_lossy(&out.stdout));
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.files.len(), 1);
        assert_eq!(st.files[0].index, '?');
        let _ = std::fs::remove_dir_all(&dir);
    }
}
