//! File-system commands used by the editor (open/save files, explorer tree).

use encoding_rs::{Encoding, UTF_16LE, UTF_8, WINDOWS_1252};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Refuse to open files larger than this in the editor.
const MAX_FILE_SIZE: u64 = 64 * 1024 * 1024;

#[derive(Serialize)]
pub struct TextFile {
    pub content: String,
    /// One of: "utf-8", "utf-8-bom", "utf-16le", "utf-16be", "windows-1252".
    pub encoding: String,
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Strip the `\\?\` prefix that `canonicalize` adds on Windows.
pub fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

pub(crate) fn decode(bytes: &[u8]) -> Result<TextFile, String> {
    if let Some((enc, bom_len)) = Encoding::for_bom(bytes) {
        let (text, _) = enc.decode_without_bom_handling(&bytes[bom_len..]);
        let name = if enc == UTF_8 {
            "utf-8-bom"
        } else if enc == UTF_16LE {
            "utf-16le"
        } else {
            "utf-16be"
        };
        return Ok(TextFile { content: text.into_owned(), encoding: name.into() });
    }
    let head = &bytes[..bytes.len().min(8192)];
    if head.contains(&0) {
        return Err("File appears to be binary and cannot be opened as text".into());
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => Ok(TextFile { content: s.to_string(), encoding: "utf-8".into() }),
        Err(_) => {
            let (text, _, _) = WINDOWS_1252.decode(bytes);
            Ok(TextFile { content: text.into_owned(), encoding: "windows-1252".into() })
        }
    }
}

pub(crate) fn encode(content: &str, encoding: &str) -> Vec<u8> {
    match encoding {
        "utf-8-bom" => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(content.as_bytes());
            v
        }
        "utf-16le" | "utf-16be" => {
            let le = encoding == "utf-16le";
            let mut v: Vec<u8> = if le { vec![0xFF, 0xFE] } else { vec![0xFE, 0xFF] };
            for unit in content.encode_utf16() {
                v.extend_from_slice(&if le { unit.to_le_bytes() } else { unit.to_be_bytes() });
            }
            v
        }
        "windows-1252" => WINDOWS_1252.encode(content).0.into_owned(),
        _ => content.as_bytes().to_vec(),
    }
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<TextFile, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_SIZE {
        return Err(format!("File is too large ({} MB)", meta.len() / 1024 / 1024));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    decode(&bytes)
}

#[tauri::command]
pub fn write_text_file(path: String, content: String, encoding: Option<String>) -> Result<(), String> {
    let bytes = encode(&content, encoding.as_deref().unwrap_or("utf-8"));
    // Write to a temp file first so a failed save never truncates the original.
    let target = PathBuf::from(&path);
    let mut tmp_name = target.file_name().ok_or("Invalid file path")?.to_os_string();
    tmp_name.push(".taara-tmp");
    let tmp = target.with_file_name(tmp_name);
    fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    if let Err(e) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        // Fall back to a direct write (e.g. rename blocked by another process).
        fs::write(&target, &bytes).map_err(|e2| format!("{e2} (rename failed: {e})"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name == ".git" {
                return None;
            }
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            Some(DirEntry { path: display_path(&e.path()), name, is_dir })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err(format!("'{to}' already exists"));
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// All files under `root` (respecting .gitignore), for Quick Open.
#[tauri::command]
pub async fn list_files(root: String, max: Option<usize>) -> Result<Vec<String>, String> {
    let max = max.unwrap_or(20_000);
    tauri::async_runtime::spawn_blocking(move || {
        ignore::WalkBuilder::new(&root)
            .require_git(false)
            .build()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .take(max)
            .map(|e| display_path(e.path()))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_encodings() {
        for enc in ["utf-8", "utf-8-bom", "utf-16le", "utf-16be"] {
            let bytes = encode("héllo\r\nworld", enc);
            let file = decode(&bytes).unwrap();
            assert_eq!(file.content, "héllo\r\nworld");
            assert_eq!(file.encoding, enc);
        }
        let latin = decode(&[0x63, 0x61, 0x66, 0xE9]).unwrap();
        assert_eq!(latin.content, "café");
        assert_eq!(latin.encoding, "windows-1252");
        assert_eq!(encode("café", "windows-1252"), vec![0x63, 0x61, 0x66, 0xE9]);
    }

    #[test]
    fn rejects_binary() {
        assert!(decode(&[0x7F, 0x45, 0x4C, 0x46, 0x00, 0x01]).is_err());
    }
}
