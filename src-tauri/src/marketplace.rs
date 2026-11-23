//! Open VSX marketplace (https://open-vsx.org): search, read manifests, and
//! download + install extensions. All traffic goes to open-vsx.org only, and
//! every download is checked against the SHA-256 published by Open VSX.

use crate::extensions::{install, root_dir, ExtensionInfo};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::time::Duration;
use tauri::AppHandle;

const API: &str = "https://open-vsx.org/api";
const MAX_VSIX_BYTES: u64 = 300 * 1024 * 1024;

pub(crate) fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(60))
        .user_agent(concat!("TaaraEditor/", env!("CARGO_PKG_VERSION")))
        .try_proxy_from_env(true)
        .build()
}

pub(crate) fn http_error(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            let msg = resp
                .into_json::<Value>()
                .ok()
                .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string));
            msg.unwrap_or_else(|| format!("Open VSX returned HTTP {code}"))
        }
        ureq::Error::Transport(t) => format!("Cannot reach open-vsx.org: {t}"),
    }
}

fn get_json(agent: &ureq::Agent, url: &str) -> Result<Value, String> {
    agent.get(url).call().map_err(http_error)?.into_json().map_err(|e| e.to_string())
}

/// Namespaces and names are plain identifiers; reject anything that could
/// change the URL path.
fn check_id(s: &str) -> Result<&str, String> {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) && s != "." && s != ".." {
        Ok(s)
    } else {
        Err(format!("Invalid extension identifier '{s}'"))
    }
}

/// Only follow file links that point back to the Open VSX API.
fn api_file(detail: &Value, key: &str) -> Result<String, String> {
    let url = detail
        .pointer(&format!("/files/{key}"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Open VSX has no '{key}' file for this extension"))?;
    if url.starts_with(&format!("{API}/")) {
        Ok(url.to_string())
    } else {
        Err(format!("Unexpected download location: {url}"))
    }
}

fn detail(agent: &ureq::Agent, namespace: &str, name: &str) -> Result<Value, String> {
    get_json(agent, &format!("{API}/{}/{}", check_id(namespace)?, check_id(name)?))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn marketplace_search(
    query: String,
    category: Option<String>,
    offset: Option<u32>,
    size: Option<u32>,
) -> Result<Value, String> {
    blocking(move || {
        let agent = agent();
        let mut req = agent
            .get(&format!("{API}/-/search"))
            .query("query", &query)
            .query("offset", &offset.unwrap_or(0).to_string())
            .query("size", &size.unwrap_or(30).min(100).to_string())
            .query("sortOrder", "desc")
            .query("sortBy", if query.trim().is_empty() { "downloadCount" } else { "relevance" });
        if let Some(c) = category.filter(|c| !c.is_empty()) {
            req = req.query("category", &c);
        }
        req.call().map_err(http_error)?.into_json().map_err(|e| e.to_string())
    })
    .await
}

/// The extension's package.json, so the UI can tell what Taara can use
/// before downloading the whole .vsix.
#[tauri::command]
pub async fn marketplace_manifest(namespace: String, name: String) -> Result<Value, String> {
    blocking(move || {
        let agent = agent();
        let d = detail(&agent, &namespace, &name)?;
        get_json(&agent, &api_file(&d, "manifest")?)
    })
    .await
}

#[tauri::command]
pub async fn marketplace_install(app: AppHandle, namespace: String, name: String) -> Result<ExtensionInfo, String> {
    let root = root_dir(&app)?;
    blocking(move || {
        let agent = agent();
        let d = detail(&agent, &namespace, &name)?;
        if d.get("downloadable").and_then(Value::as_bool) == Some(false) {
            return Err("This extension is not downloadable from Open VSX".into());
        }
        let vsix_url = api_file(&d, "download")?;
        let sha_url = api_file(&d, "sha256")?;

        let expected = agent
            .get(&sha_url)
            .call()
            .map_err(http_error)?
            .into_string()
            .map_err(|e| e.to_string())?
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if expected.len() != 64 {
            return Err("Open VSX did not return a valid SHA-256 checksum".into());
        }

        let tmp = root.join(format!(".download-{}.{}.vsix", check_id(&namespace)?, check_id(&name)?));
        let result = download_verified(&agent, &vsix_url, &expected, &tmp, MAX_VSIX_BYTES).and_then(|_| install(&root, &tmp));
        let _ = fs::remove_file(&tmp);
        result
    })
    .await
}

/// Download `url` to `dest`, failing unless its SHA-256 equals `expected`
/// (lower-case hex) and it is at most `max_bytes` long.
pub(crate) fn download_verified(agent: &ureq::Agent, url: &str, expected: &str, dest: &std::path::Path, max_bytes: u64) -> Result<(), String> {
    let resp = agent.get(url).call().map_err(http_error)?;
    let mut reader = resp.into_reader().take(max_bytes + 1);
    let mut file = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Download failed: {e}"))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > max_bytes {
            return Err(format!("Download is larger than {} MB", max_bytes / 1024 / 1024));
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    drop(file);
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        let _ = fs::remove_file(dest);
        return Err(format!("Checksum mismatch for the download (expected {expected}, got {actual})"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identifiers_are_validated() {
        assert!(check_id("dracula-theme").is_ok());
        assert!(check_id("ms-vscode.cpptools").is_ok());
        assert!(check_id("..").is_err());
        assert!(check_id("a/b").is_err());
        assert!(check_id("a?b=c").is_err());
        assert!(check_id("").is_err());
    }

    #[test]
    fn only_open_vsx_file_links_are_followed() {
        let d = json!({ "files": {
            "download": "https://open-vsx.org/api/a/b/1.0.0/file/a.b-1.0.0.vsix",
            "manifest": "https://evil.example.com/package.json",
            "sha256": "https://open-vsx.org.evil.com/x"
        }});
        assert!(api_file(&d, "download").is_ok());
        assert!(api_file(&d, "manifest").is_err());
        assert!(api_file(&d, "sha256").is_err());
        assert!(api_file(&d, "icon").is_err());
    }
}
