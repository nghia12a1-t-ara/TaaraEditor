//! VS Code extension (.vsix) installation and discovery.
//!
//! A .vsix is a zip archive whose `extension/` folder holds the extension
//! (`package.json` + assets). We unpack that folder to
//! `%LOCALAPPDATA%/com.taaramcu.editor/extensions/<publisher>.<name>-<version>/`.
//!
//! Only the manifest is interpreted here; the frontend applies the declarative
//! contributions (themes, languages, grammars, snippets). Running extension
//! JavaScript (`main`/`browser`) needs an extension host and is not done yet.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
    /// `publisher.name`, lower-cased (same id format as VS Code).
    pub id: String,
    pub name: String,
    pub publisher: String,
    pub version: String,
    pub display_name: String,
    pub description: String,
    /// Absolute folder that holds the unpacked extension.
    pub path: String,
    /// True when the extension ships JavaScript we cannot run yet.
    pub has_code: bool,
    /// `package.json` with `%nls.key%` placeholders resolved.
    pub manifest: Value,
}

pub(crate) fn root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("extensions");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn extension_id(manifest: &Value) -> Option<String> {
    let publisher = manifest.get("publisher")?.as_str()?;
    let name = manifest.get("name")?.as_str()?;
    Some(format!("{publisher}.{name}").to_lowercase())
}

/// Replace `"%key%"` strings with their value from `package.nls.json`.
fn resolve_nls(value: &mut Value, nls: &Value) {
    match value {
        Value::String(s) if s.len() > 2 && s.starts_with('%') && s.ends_with('%') => {
            let key = &s[1..s.len() - 1];
            let resolved = match nls.get(key) {
                Some(Value::String(t)) => Some(t.clone()),
                Some(Value::Object(o)) => o.get("message").and_then(Value::as_str).map(str::to_string),
                _ => None,
            };
            if let Some(t) = resolved {
                *s = t;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| resolve_nls(v, nls)),
        Value::Object(map) => map.values_mut().for_each(|v| resolve_nls(v, nls)),
        _ => {}
    }
}

fn read_extension(dir: &Path) -> Option<ExtensionInfo> {
    let text = fs::read_to_string(dir.join("package.json")).ok()?;
    let mut manifest: Value = serde_json::from_str(&text).ok()?;
    if let Some(nls) = fs::read_to_string(dir.join("package.nls.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    {
        resolve_nls(&mut manifest, &nls);
    }
    let id = extension_id(&manifest)?;
    let name = str_field(&manifest, "name");
    let display_name = match str_field(&manifest, "displayName") {
        d if d.is_empty() => name.clone(),
        d => d,
    };
    Some(ExtensionInfo {
        id,
        publisher: str_field(&manifest, "publisher"),
        version: str_field(&manifest, "version"),
        description: str_field(&manifest, "description"),
        has_code: manifest.get("main").is_some() || manifest.get("browser").is_some(),
        path: crate::fs_cmds::display_path(dir),
        display_name,
        name,
        manifest,
    })
}

fn installed(root: &Path) -> Vec<ExtensionInfo> {
    let Ok(entries) = fs::read_dir(root) else { return vec![] };
    let mut list: Vec<ExtensionInfo> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir() && !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| read_extension(&e.path()))
        .collect();
    list.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    list
}

fn remove_installed(root: &Path, id: &str) -> Result<usize, String> {
    let mut removed = 0;
    for ext in installed(root).into_iter().filter(|e| e.id == id) {
        fs::remove_dir_all(&ext.path).map_err(|e| e.to_string())?;
        removed += 1;
    }
    Ok(removed)
}

pub(crate) fn install(root: &Path, vsix: &Path) -> Result<ExtensionInfo, String> {
    let file = fs::File::open(vsix).map_err(|e| format!("Cannot open {}: {e}", vsix.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid .vsix: {e}"))?;

    let manifest: Value = {
        let mut entry = zip
            .by_name("extension/package.json")
            .map_err(|_| "Not a valid .vsix: extension/package.json is missing".to_string())?;
        let mut text = String::new();
        entry.read_to_string(&mut text).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| format!("Invalid package.json: {e}"))?
    };
    let id = extension_id(&manifest).ok_or("package.json needs 'publisher' and 'name'")?;
    let version = str_field(&manifest, "version");

    // Unpack into a staging folder, then swap it in, so a failed install
    // never leaves a half-written extension behind.
    let staging = root.join(format!(".installing-{id}"));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let unpack = (|| -> Result<(), String> {
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
            // `enclosed_name` rejects absolute paths and `..` (zip-slip).
            let Some(rel) = entry
                .enclosed_name()
                .and_then(|p| p.strip_prefix("extension").ok().map(Path::to_path_buf))
            else {
                continue;
            };
            if rel.as_os_str().is_empty() {
                continue;
            }
            let out = staging.join(rel);
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
    })();
    if let Err(e) = unpack {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }

    remove_installed(root, &id)?;
    let target = root.join(format!("{id}-{version}"));
    fs::rename(&staging, &target).map_err(|e| e.to_string())?;
    read_extension(&target).ok_or_else(|| "Installed extension could not be read".into())
}

#[tauri::command]
pub fn extensions_dir(app: AppHandle) -> Result<String, String> {
    root_dir(&app).map(|p| crate::fs_cmds::display_path(&p))
}

#[tauri::command]
pub fn list_extensions(app: AppHandle) -> Result<Vec<ExtensionInfo>, String> {
    Ok(installed(&root_dir(&app)?))
}

#[tauri::command]
pub async fn install_vsix(app: AppHandle, path: String) -> Result<ExtensionInfo, String> {
    let root = root_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || install(&root, Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn uninstall_extension(app: AppHandle, id: String) -> Result<(), String> {
    match remove_installed(&root_dir(&app)?, &id.to_lowercase())? {
        0 => Err(format!("Extension '{id}' is not installed")),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_vsix(path: &Path, version: &str) {
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        zip.start_file("extension.vsixmanifest", opts).unwrap();
        zip.write_all(b"<xml/>").unwrap();
        zip.start_file("extension/package.json", opts).unwrap();
        write!(
            zip,
            r#"{{"name":"demo","publisher":"Acme","version":"{version}","displayName":"%dn%",
               "contributes":{{"themes":[{{"label":"%theme%","uiTheme":"vs-dark","path":"./themes/t.json"}}]}}}}"#
        )
        .unwrap();
        zip.start_file("extension/package.nls.json", opts).unwrap();
        zip.write_all(br#"{"dn":"Demo Ext","theme":{"message":"Demo Theme"}}"#).unwrap();
        zip.start_file("extension/themes/t.json", opts).unwrap();
        zip.write_all(b"{}").unwrap();
        zip.start_file("extension/../../evil.txt", opts).unwrap();
        zip.write_all(b"x").unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn install_upgrade_uninstall() {
        let tmp = std::env::temp_dir().join(format!("taara-ext-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let root = tmp.join("extensions");
        fs::create_dir_all(&root).unwrap();

        let v1 = tmp.join("v1.vsix");
        make_vsix(&v1, "1.0.0");
        let info = install(&root, &v1).unwrap();
        assert_eq!(info.id, "acme.demo");
        assert_eq!(info.display_name, "Demo Ext");
        assert_eq!(info.manifest["contributes"]["themes"][0]["label"], "Demo Theme");
        assert!(root.join("acme.demo-1.0.0/themes/t.json").exists());
        assert!(!tmp.join("evil.txt").exists());

        // Installing a newer version replaces the old one.
        let v2 = tmp.join("v2.vsix");
        make_vsix(&v2, "2.0.0");
        install(&root, &v2).unwrap();
        let list = installed(&root);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].version, "2.0.0");

        assert_eq!(remove_installed(&root, "acme.demo").unwrap(), 1);
        assert!(installed(&root).is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }
}
