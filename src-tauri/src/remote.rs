//! Remote SSH: connect to a host (OpenSSH-compatible config, agent, keys,
//! known_hosts), browse and edit files over SFTP, run remote shells and
//! commands. Pure Rust (russh), so ed25519 / ECDSA / RSA keys all work.

use crate::fs_cmds::{decode, encode, TextFile};
use russh::client::{self, Handle};
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKey};
use russh::{ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

// ------------------------------------------------------------------ ~/.ssh/config

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct HostConfig {
    /// The alias typed by the user (Host entry or user@host).
    pub alias: String,
    pub hostname: String,
    pub user: Option<String>,
    pub port: u16,
    pub identity_files: Vec<String>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

fn expand_tilde(p: &str) -> String {
    match (p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")), home()) {
        (Some(rest), Some(h)) => h.join(rest).to_string_lossy().into_owned(),
        _ => p.to_string(),
    }
}

/// `*` and `?` wildcards, like OpenSSH Host patterns.
fn wildcard(pattern: &str, text: &str) -> bool {
    fn go(p: &[u8], t: &[u8]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some(b'*'), _) => go(&p[1..], t) || (!t.is_empty() && go(p, &t[1..])),
            (Some(b'?'), Some(_)) => go(&p[1..], &t[1..]),
            (Some(a), Some(b)) if a.eq_ignore_ascii_case(b) => go(&p[1..], &t[1..]),
            _ => false,
        }
    }
    go(pattern.as_bytes(), text.as_bytes())
}

/// One `Host` block of ssh_config: its patterns and its `key value` options.
type ConfigBlock = (Vec<String>, Vec<(String, String)>);

/// Minimal ssh_config parser: Host blocks with HostName, User, Port, IdentityFile.
fn parse_config(text: &str) -> Vec<ConfigBlock> {
    let mut blocks: Vec<ConfigBlock> = vec![(vec!["*".into()], vec![])];
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.trim().to_ascii_lowercase(), v.trim().trim_start_matches('=').trim().trim_matches('"').to_string()),
            None => continue,
        };
        if key == "host" {
            blocks.push((value.split_whitespace().map(str::to_string).collect(), vec![]));
        } else if key == "match" {
            blocks.push((vec![], vec![])); // unsupported: never matches
        } else {
            blocks.last_mut().unwrap().1.push((key, value));
        }
    }
    blocks
}

fn config_text() -> String {
    home().and_then(|h| std::fs::read_to_string(h.join(".ssh").join("config")).ok()).unwrap_or_default()
}

/// Resolve `alias`, `user@host`, `host:port` or `user@host:port` with ~/.ssh/config.
pub fn resolve_host(target: &str, config: &str) -> HostConfig {
    let (user_part, host_part) = match target.rsplit_once('@') {
        Some((u, h)) => (Some(u.to_string()), h),
        None => (None, target),
    };
    let (host, port) = match host_part.rsplit_once(':') {
        Some((h, p)) if p.parse::<u16>().is_ok() => (h.to_string(), p.parse::<u16>().ok()),
        _ => (host_part.to_string(), None),
    };
    let mut cfg = HostConfig { alias: target.to_string(), hostname: host.clone(), user: user_part, port: port.unwrap_or(22), identity_files: vec![] };
    let mut seen = std::collections::HashSet::new();
    for (patterns, opts) in parse_config(config) {
        let positive = patterns.iter().filter(|p| !p.starts_with('!')).any(|p| wildcard(p, &host));
        let negative = patterns.iter().filter_map(|p| p.strip_prefix('!')).any(|p| wildcard(p, &host));
        if !positive || negative {
            continue;
        }
        // First value wins, like OpenSSH (IdentityFile accumulates).
        for (k, v) in opts {
            match k.as_str() {
                "identityfile" => cfg.identity_files.push(expand_tilde(&v)),
                _ if !seen.insert(k.clone()) => {}
                "hostname" => cfg.hostname = v.replace("%h", &host),
                "user" if cfg.user.is_none() => cfg.user = Some(v),
                "port" if port.is_none() => cfg.port = v.parse().unwrap_or(22),
                _ => {}
            }
        }
    }
    cfg
}

#[tauri::command]
pub fn ssh_hosts() -> Vec<HostConfig> {
    let text = config_text();
    let mut out = Vec::new();
    for (patterns, _) in parse_config(&text) {
        for p in patterns {
            if !p.contains(['*', '?', '!']) && !out.iter().any(|h: &HostConfig| h.alias == p) {
                out.push(resolve_host(&p, &text));
            }
        }
    }
    out
}

// ------------------------------------------------------------------ connection

struct Client {
    host: String,
    port: u16,
    accept_new_key: bool,
    /// Why the server key was rejected (reported to the UI).
    rejected: Arc<StdMutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key: PublicKey = match key {
            keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            keys::PublicKeyOrCertificate::Certificate(c) => PublicKey::new(c.public_key().clone(), ""),
        };
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        match keys::check_known_hosts(&self.host, self.port, &key) {
            Ok(true) => Ok(true),
            Ok(false) if self.accept_new_key => {
                // Trust on first use, recorded like OpenSSH does.
                let _ = keys::known_hosts::learn_known_hosts(&self.host, self.port, &key);
                Ok(true)
            }
            Ok(false) => {
                *self.rejected.lock().unwrap() = Some(format!("UNKNOWN_HOST|{}|{fingerprint}", key.algorithm()));
                Ok(false)
            }
            Err(keys::Error::KeyChanged { line }) => {
                *self.rejected.lock().unwrap() = Some(format!("KEY_CHANGED|{line}|{fingerprint}"));
                Ok(false)
            }
            Err(e) => {
                *self.rejected.lock().unwrap() = Some(format!("ERROR|{e}"));
                Ok(false)
            }
        }
    }
}

struct Conn {
    handle: Handle<Client>,
    sftp: SftpSession,
}

struct Shell {
    writer: russh::ChannelWriteHalf<client::Msg>,
}

#[derive(Default)]
pub struct RemoteState {
    conns: Mutex<HashMap<u32, Arc<Conn>>>,
    shells: Mutex<HashMap<u32, Shell>>,
    next_id: AtomicU32,
}

#[derive(Serialize)]
pub struct ConnectInfo {
    pub id: u32,
    pub label: String,
    pub user: String,
    pub host: String,
    pub home: String,
    pub auth: String,
}

fn default_identity_files() -> Vec<String> {
    let Some(h) = home() else { return vec![] };
    ["id_ed25519", "id_ecdsa", "id_rsa"].iter().map(|n| h.join(".ssh").join(n).to_string_lossy().into_owned()).collect()
}

fn s<T: AsRef<[u8]>>(v: T) -> String {
    String::from_utf8_lossy(v.as_ref()).into_owned()
}

/// Try agent, then key files, then password. Returns the method that worked.
async fn authenticate(handle: &mut Handle<Client>, user: &str, cfg: &HostConfig, password: Option<&str>, passphrase: Option<&str>) -> Result<String, String> {
    let rsa_hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
    let mut tried = Vec::new();

    // 1. ssh-agent (Windows OpenSSH agent service, then Pageant).
    #[cfg(windows)]
    {
        if let Ok(mut agent) = keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            if let Ok(ids) = agent.request_identities().await {
                for id in ids {
                    if let keys::agent::AgentIdentity::PublicKey { key, .. } = id {
                        tried.push("agent".to_string());
                        if let Ok(r) = handle.authenticate_publickey_with(user, key, rsa_hash, &mut agent).await {
                            if r.success() {
                                return Ok("ssh-agent".into());
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Key files (from ~/.ssh/config, then the defaults).
    let mut files = cfg.identity_files.clone();
    files.extend(default_identity_files());
    files.dedup();
    let mut encrypted = Vec::new();
    for f in files.iter().filter(|f| std::path::Path::new(f).is_file()) {
        let key = match keys::load_secret_key(f, None) {
            Ok(k) => k,
            Err(_) => match passphrase.map(|p| keys::load_secret_key(f, Some(p))) {
                Some(Ok(k)) => k,
                _ => {
                    encrypted.push(f.clone());
                    continue;
                }
            },
        };
        tried.push(f.clone());
        let auth = handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash)).await.map_err(|e| e.to_string())?;
        if auth.success() {
            return Ok(format!("key {f}"));
        }
    }

    // 3. Password.
    if let Some(pw) = password {
        let auth = handle.authenticate_password(user, pw).await.map_err(|e| e.to_string())?;
        if auth.success() {
            return Ok("password".into());
        }
        return Err("AUTH_FAILED|Wrong password".into());
    }
    if !encrypted.is_empty() && passphrase.is_none() {
        return Err(format!("NEED_PASSPHRASE|{}", encrypted[0]));
    }
    Err(format!("NEED_PASSWORD|{}", if tried.is_empty() { "no keys found".to_string() } else { format!("tried {}", tried.join(", ")) }))
}

/// Connect to `target` (alias from ~/.ssh/config or user@host[:port]).
///
/// Errors are `KIND|details` strings the UI understands: UNKNOWN_HOST,
/// KEY_CHANGED, NEED_PASSWORD, NEED_PASSPHRASE, AUTH_FAILED, CONNECT.
#[tauri::command]
pub async fn ssh_connect(
    state: tauri::State<'_, Arc<RemoteState>>,
    target: String,
    password: Option<String>,
    passphrase: Option<String>,
    accept_host_key: bool,
) -> Result<ConnectInfo, String> {
    let cfg = resolve_host(&target, &config_text());
    let user = cfg.user.clone().or_else(|| std::env::var("USERNAME").ok()).unwrap_or_else(|| "root".into());
    let rejected = Arc::new(StdMutex::new(None));
    let handler = Client { host: cfg.hostname.clone(), port: cfg.port, accept_new_key: accept_host_key, rejected: rejected.clone() };
    let config = Arc::new(client::Config { inactivity_timeout: None, keepalive_interval: Some(Duration::from_secs(30)), ..Default::default() });
    let connect = client::connect(config, (cfg.hostname.as_str(), cfg.port), handler);
    let mut handle = match tokio::time::timeout(Duration::from_secs(15), connect).await {
        Err(_) => return Err(format!("CONNECT|Timed out connecting to {}:{}", cfg.hostname, cfg.port)),
        Ok(Err(e)) => return Err(rejected.lock().unwrap().clone().unwrap_or_else(|| format!("CONNECT|{e}"))),
        Ok(Ok(h)) => h,
    };
    let auth = authenticate(&mut handle, &user, &cfg, password.as_deref(), passphrase.as_deref()).await?;

    let channel = handle.channel_open_session().await.map_err(|e| format!("CONNECT|{e}"))?;
    channel.request_subsystem(true, "sftp").await.map_err(|e| format!("CONNECT|SFTP is not available: {e}"))?;
    let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| format!("CONNECT|SFTP: {e}"))?;
    let home = sftp.canonicalize(".").await.map(s).unwrap_or_else(|_| "/".into());

    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let label = target.clone();
    state.conns.lock().await.insert(id, Arc::new(Conn { handle, sftp }));
    Ok(ConnectInfo { id, label, user, host: cfg.hostname, home, auth })
}

async fn conn(state: &RemoteState, id: u32) -> Result<Arc<Conn>, String> {
    state.conns.lock().await.get(&id).cloned().ok_or_else(|| "The SSH connection was closed".to_string())
}

#[tauri::command]
pub async fn ssh_disconnect(state: tauri::State<'_, Arc<RemoteState>>, id: u32) -> Result<(), String> {
    if let Some(c) = state.conns.lock().await.remove(&id) {
        let _ = c.sftp.close().await;
        let _ = c.handle.disconnect(Disconnect::ByApplication, "", "en").await;
    }
    Ok(())
}

// ------------------------------------------------------------------ SFTP

#[derive(Serialize)]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

fn join(dir: &str, name: &str) -> String {
    format!("{}/{}", dir.trim_end_matches('/'), name)
}

#[tauri::command]
pub async fn ssh_read_dir(state: tauri::State<'_, Arc<RemoteState>>, id: u32, path: String) -> Result<Vec<RemoteEntry>, String> {
    let c = conn(&state, id).await?;
    let mut out = Vec::new();
    for e in c.sftp.read_dir(path.clone()).await.map_err(|e| e.to_string())? {
        let name = s(e.file_name());
        if name == "." || name == ".." || name == ".git" {
            continue;
        }
        let full = join(&path, &name);
        let mut is_dir = e.file_type().is_dir();
        if e.file_type().is_symlink() {
            is_dir = c.sftp.metadata(full.clone()).await.map(|m| m.is_dir()).unwrap_or(false);
        }
        out.push(RemoteEntry { name, path: full, is_dir });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command]
pub async fn ssh_read_file(state: tauri::State<'_, Arc<RemoteState>>, id: u32, path: String) -> Result<TextFile, String> {
    let c = conn(&state, id).await?;
    let meta = c.sftp.metadata(path.clone()).await.map_err(|e| e.to_string())?;
    if meta.size.unwrap_or(0) > 64 * 1024 * 1024 {
        return Err("File is too large".into());
    }
    let bytes = c.sftp.read(path).await.map_err(|e| e.to_string())?;
    decode(&bytes)
}

#[tauri::command]
pub async fn ssh_write_file(state: tauri::State<'_, Arc<RemoteState>>, id: u32, path: String, content: String, encoding: Option<String>) -> Result<(), String> {
    let c = conn(&state, id).await?;
    let bytes = encode(&content, encoding.as_deref().unwrap_or("utf-8"));
    c.sftp.write(path, &bytes).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_create_file(state: tauri::State<'_, Arc<RemoteState>>, id: u32, path: String) -> Result<(), String> {
    let c = conn(&state, id).await?;
    if c.sftp.try_exists(path.clone()).await.unwrap_or(false) {
        return Err(format!("'{path}' already exists"));
    }
    c.sftp.create(path).await.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_create_dir(state: tauri::State<'_, Arc<RemoteState>>, id: u32, path: String) -> Result<(), String> {
    let c = conn(&state, id).await?;
    // mkdir -p
    let mut cur = String::new();
    for part in path.split('/').filter(|p| !p.is_empty()) {
        cur = format!("{cur}/{part}");
        if !c.sftp.try_exists(cur.clone()).await.unwrap_or(false) {
            c.sftp.create_dir(cur.clone()).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_rename(state: tauri::State<'_, Arc<RemoteState>>, id: u32, from: String, to: String) -> Result<(), String> {
    let c = conn(&state, id).await?;
    if c.sftp.try_exists(to.clone()).await.unwrap_or(false) {
        return Err(format!("'{to}' already exists"));
    }
    c.sftp.rename(from, to).await.map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ commands & shells

#[derive(Serialize)]
pub struct ExecResult {
    pub code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
}

/// Run a command on the host and collect its output (used for remote search,
/// file listing...). Output is capped at 32 MB.
#[tauri::command]
pub async fn ssh_exec(state: tauri::State<'_, Arc<RemoteState>>, id: u32, command: String) -> Result<ExecResult, String> {
    let c = conn(&state, id).await?;
    let mut channel = c.handle.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.exec(true, command).await.map_err(|e| e.to_string())?;
    let (mut out, mut err, mut code) = (Vec::new(), Vec::new(), None);
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } if out.len() < 32 << 20 => out.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, .. } if err.len() < 1 << 20 => err.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
            _ => {}
        }
    }
    Ok(ExecResult { code, stdout: s(out), stderr: s(err) })
}

#[derive(Serialize, Clone)]
struct ShellData {
    id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct ShellExit {
    id: u32,
    code: Option<u32>,
}

/// Interactive remote shell in a PTY; output arrives as `ssh://data` events.
#[tauri::command]
pub async fn ssh_shell_open(app: AppHandle, state: tauri::State<'_, Arc<RemoteState>>, id: u32, cols: u32, rows: u32, cwd: Option<String>) -> Result<u32, String> {
    let c = conn(&state, id).await?;
    let channel = c.handle.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]).await.map_err(|e| e.to_string())?;
    match cwd {
        // Start the login shell in the workspace folder.
        Some(dir) => {
            let quoted = format!("'{}'", dir.replace('\'', r"'\''"));
            channel.exec(true, format!("cd {quoted} 2>/dev/null; exec \"${{SHELL:-/bin/sh}}\" -l")).await
        }
        None => channel.request_shell(true).await,
    }
    .map_err(|e| e.to_string())?;
    let (mut reader, writer) = channel.split();
    let shell_id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    state.shells.lock().await.insert(shell_id, Shell { writer });
    let state_ref = state.inner().clone();
    tokio::spawn(async move {
        let mut pending: Vec<u8> = Vec::new();
        let mut code = None;
        while let Some(msg) = reader.wait().await {
            let bytes = match msg {
                ChannelMsg::Data { data } => data.to_vec(),
                ChannelMsg::ExtendedData { data, .. } => data.to_vec(),
                ChannelMsg::ExitStatus { exit_status } => {
                    code = Some(exit_status);
                    continue;
                }
                _ => continue,
            };
            // Keep incomplete UTF-8 sequences for the next chunk.
            pending.extend_from_slice(&bytes);
            let valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => pending.len(),
            };
            let data = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            if !data.is_empty() {
                let _ = app.emit("ssh://data", ShellData { id: shell_id, data });
            }
        }
        state_ref.shells.lock().await.remove(&shell_id);
        let _ = app.emit("ssh://exit", ShellExit { id: shell_id, code });
    });
    Ok(shell_id)
}

#[tauri::command]
pub async fn ssh_shell_write(state: tauri::State<'_, Arc<RemoteState>>, id: u32, data: String) -> Result<(), String> {
    let shells = state.shells.lock().await;
    let sh = shells.get(&id).ok_or("The remote shell has exited")?;
    sh.writer.data_bytes(data.into_bytes()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_shell_resize(state: tauri::State<'_, Arc<RemoteState>>, id: u32, cols: u32, rows: u32) -> Result<(), String> {
    let shells = state.shells.lock().await;
    let sh = shells.get(&id).ok_or("The remote shell has exited")?;
    sh.writer.window_change(cols, rows, 0, 0).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_shell_close(state: tauri::State<'_, Arc<RemoteState>>, id: u32) -> Result<(), String> {
    if let Some(sh) = state.shells.lock().await.remove(&id) {
        let _ = sh.writer.close().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = "
# comment
Host pi raspberry
    HostName 192.168.1.50
    User pi
    IdentityFile ~/.ssh/id_pi

Host build-*
    User builder
    Port 2222

Host *
    User fallback
    IdentityFile ~/.ssh/id_default
";

    #[test]
    fn resolves_aliases_and_wildcards() {
        let pi = resolve_host("pi", CONFIG);
        assert_eq!(pi.hostname, "192.168.1.50");
        assert_eq!(pi.user.as_deref(), Some("pi")); // first value wins over "Host *"
        assert_eq!(pi.port, 22);
        assert_eq!(pi.identity_files.len(), 2);
        assert!(pi.identity_files[0].ends_with("id_pi"));

        let b = resolve_host("build-01", CONFIG);
        assert_eq!((b.hostname.as_str(), b.user.as_deref(), b.port), ("build-01", Some("builder"), 2222));

        let explicit = resolve_host("root@build-02:2200", CONFIG);
        assert_eq!((explicit.user.as_deref(), explicit.port), (Some("root"), 2200));

        let other = resolve_host("example.com", CONFIG);
        assert_eq!(other.user.as_deref(), Some("fallback"));
    }

    #[test]
    fn wildcard_matching() {
        assert!(wildcard("*.lan", "nas.lan"));
        assert!(wildcard("dev-?", "dev-1"));
        assert!(!wildcard("dev-?", "dev-10"));
        assert!(wildcard("*", "anything"));
    }
}
