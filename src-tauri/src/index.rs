//! Workspace symbol index: powers Go to Definition, Go to Symbol in Workspace
//! and #include navigation.
//!
//! Indexing is incremental: a rescan only stats files and re-parses those whose
//! size or modification time changed, in parallel across all CPU cores.

use crate::fs_cmds::display_path;
use crate::symbols::{parser_for, Kind, Sym};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};

/// Modification time + size: a file is re-parsed only when this changes.
type FileStamp = (SystemTime, u64);

const MAX_FILE_SIZE: u64 = 8 * 1024 * 1024;

struct FileEntry {
    stamp: FileStamp,
    syms: Arc<Vec<Sym>>,
}

#[derive(Default)]
pub struct Index {
    root: Option<PathBuf>,
    files: HashMap<PathBuf, FileEntry>,
}

#[derive(Default)]
pub struct IndexState(pub Mutex<Index>);

#[derive(Serialize)]
pub struct IndexStats {
    pub files: usize,
    pub symbols: usize,
    pub parsed: usize,
    pub millis: u64,
}

#[derive(Serialize, Clone)]
pub struct SymbolLocation {
    pub path: String,
    #[serde(flatten)]
    pub sym: Sym,
}

fn stamp(meta: &fs::Metadata) -> FileStamp {
    (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len())
}

fn parse_file(path: &Path) -> Vec<Sym> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let Some(parser) = parser_for(&ext) else { return vec![] };
    match fs::read(path) {
        Ok(bytes) if !bytes[..bytes.len().min(1024)].contains(&0) => parser(&String::from_utf8_lossy(&bytes)),
        _ => vec![],
    }
}

fn indexable(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| parser_for(&e.to_ascii_lowercase()).is_some())
}

/// Walk `root` (respecting .gitignore) and re-parse what changed.
fn rescan(state: &IndexState, root: PathBuf) -> IndexStats {
    let started = Instant::now();
    // Snapshot of what we already know, so parsing runs without the lock.
    let known: HashMap<PathBuf, (FileStamp, Arc<Vec<Sym>>)> = {
        let idx = state.0.lock().unwrap();
        if idx.root.as_deref() == Some(root.as_path()) {
            idx.files.iter().map(|(p, e)| (p.clone(), (e.stamp, e.syms.clone()))).collect()
        } else {
            HashMap::new()
        }
    };

    // 1. Parallel walk: collect indexable files with their stamps.
    let found = Mutex::new(Vec::<(PathBuf, FileStamp)>::new());
    ignore::WalkBuilder::new(&root).require_git(false).build_parallel().run(|| {
        let found = &found;
        Box::new(move |entry| {
            if let Ok(e) = entry {
                if e.file_type().is_some_and(|t| t.is_file()) && indexable(e.path()) {
                    if let Ok(meta) = e.metadata() {
                        if meta.len() <= MAX_FILE_SIZE {
                            found.lock().unwrap().push((e.into_path(), stamp(&meta)));
                        }
                    }
                }
            }
            ignore::WalkState::Continue
        })
    });
    let found = found.into_inner().unwrap();

    // 2. Re-parse changed files in parallel.
    let (mut unchanged, changed): (Vec<_>, Vec<_>) = found.into_iter().partition(|(p, st)| known.get(p).is_some_and(|(k, _)| k == st));
    let parsed_count = changed.len();
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(16);
    let chunk = changed.len().div_ceil(threads).max(1);
    let parsed: Vec<(PathBuf, FileStamp, Vec<Sym>)> = std::thread::scope(|s| {
        let handles: Vec<_> = changed
            .chunks(chunk)
            .map(|part| s.spawn(move || part.iter().map(|(p, st)| (p.clone(), *st, parse_file(p))).collect::<Vec<_>>()))
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    });

    // 3. Swap in the new map (deleted files simply drop out).
    let mut files = HashMap::with_capacity(unchanged.len() + parsed.len());
    for (p, st) in unchanged.drain(..) {
        let syms = known[&p].1.clone();
        files.insert(p, FileEntry { stamp: st, syms });
    }
    for (p, st, syms) in parsed {
        files.insert(p, FileEntry { stamp: st, syms: Arc::new(syms) });
    }
    let symbols = files.values().map(|f| f.syms.len()).sum();
    let count = files.len();
    let mut idx = state.0.lock().unwrap();
    idx.root = Some(root);
    idx.files = files;
    IndexStats { files: count, symbols, parsed: parsed_count, millis: started.elapsed().as_millis() as u64 }
}

/// Lower is better: real definitions before declarations/prototypes/fields.
fn rank(kind: Kind) -> u8 {
    if kind.is_declaration() {
        1
    } else {
        0
    }
}

fn definitions(idx: &Index, name: &str) -> Vec<SymbolLocation> {
    let mut hits: Vec<SymbolLocation> = idx
        .files
        .iter()
        .flat_map(|(p, f)| {
            f.syms
                .iter()
                .filter(|s| s.name == name || s.name.rsplit("::").next() == Some(name))
                .map(move |s| SymbolLocation { path: display_path(p), sym: s.clone() })
        })
        .collect();
    // Definitions first; the UI falls back to declarations (e.g. when the
    // cursor is already on the definition, it jumps to the prototype).
    hits.sort_by(|a, b| rank(a.sym.kind).cmp(&rank(b.sym.kind)).then(a.path.cmp(&b.path)).then(a.sym.line.cmp(&b.sym.line)));
    hits
}

/// Case-insensitive match; prefix matches first, then substrings, then
/// subsequence ("hgi" -> "HAL_GPIO_Init").
fn workspace_symbols(idx: &Index, query: &str, max: usize) -> Vec<SymbolLocation> {
    let q = query.to_lowercase();
    let subseq = |name: &str| {
        let mut it = name.chars();
        q.chars().all(|c| it.any(|n| n == c))
    };
    let mut scored: Vec<(u8, usize, SymbolLocation)> = Vec::new();
    for (p, f) in &idx.files {
        for s in f.syms.iter() {
            let lower = s.name.to_lowercase();
            let score = if q.is_empty() || lower.starts_with(&q) {
                0
            } else if lower.contains(&q) {
                1
            } else if subseq(&lower) {
                2
            } else {
                continue;
            };
            scored.push((score * 2 + rank(s.kind), s.name.len(), SymbolLocation { path: display_path(p), sym: s.clone() }));
        }
    }
    scored.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.sym.name.cmp(&b.2.sym.name)));
    scored.into_iter().take(max).map(|(_, _, l)| l).collect()
}

// ------------------------------------------------------------------ commands

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn index_folder(state: tauri::State<'_, Arc<IndexState>>, root: String) -> Result<IndexStats, String> {
    let state = state.inner().clone();
    blocking(move || rescan(&state, PathBuf::from(root))).await
}

/// Re-parse one file right after it was saved.
#[tauri::command]
pub fn index_update_file(state: tauri::State<'_, Arc<IndexState>>, path: String) {
    let p = PathBuf::from(&path);
    if !indexable(&p) {
        return;
    }
    let mut idx = state.0.lock().unwrap();
    let inside = idx.root.as_ref().is_some_and(|r| p.starts_with(r));
    if !inside {
        return;
    }
    if let Ok(meta) = fs::metadata(&p) {
        let syms = Arc::new(parse_file(&p));
        idx.files.insert(p, FileEntry { stamp: stamp(&meta), syms });
    }
}

#[tauri::command]
pub fn index_find_definitions(state: tauri::State<'_, Arc<IndexState>>, name: String) -> Vec<SymbolLocation> {
    definitions(&state.0.lock().unwrap(), &name)
}

/// Symbols of unsaved editor content (same parser as the index).
#[tauri::command]
pub fn extract_symbols(text: String, file_name: String) -> Vec<Sym> {
    let ext = Path::new(&file_name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    parser_for(&ext).map(|p| p(&text)).unwrap_or_default()
}

#[tauri::command]
pub fn index_workspace_symbols(state: tauri::State<'_, Arc<IndexState>>, query: String, max: Option<usize>) -> Vec<SymbolLocation> {
    workspace_symbols(&state.0.lock().unwrap(), &query, max.unwrap_or(200))
}

/// Files whose path ends with `include` (e.g. "drivers/gpio.h"), for
/// navigating `#include` lines. Uses the indexed file list.
#[tauri::command]
pub fn index_find_files(state: tauri::State<'_, Arc<IndexState>>, include: String) -> Vec<String> {
    let want: Vec<String> = include.replace('\\', "/").split('/').filter(|s| !s.is_empty() && *s != ".").map(|s| s.to_lowercase()).collect();
    if want.is_empty() {
        return vec![];
    }
    let idx = state.0.lock().unwrap();
    let mut hits: Vec<String> = idx
        .files
        .keys()
        .filter(|p| {
            let comps: Vec<String> = p.components().rev().take(want.len()).map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect();
            comps.len() == want.len() && comps.iter().rev().eq(want.iter())
        })
        .map(|p| display_path(p))
        .collect();
    hits.sort();
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incremental_index_and_queries() {
        let dir = std::env::temp_dir().join(format!("taara-index-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Inc")).unwrap();
        fs::write(dir.join("Inc/gpio.h"), "typedef enum { GPIO_PIN_RESET, GPIO_PIN_SET } GPIO_PinState;\nvoid HAL_GPIO_Init(int x);\n").unwrap();
        fs::write(dir.join("gpio.c"), "#include \"gpio.h\"\nvoid HAL_GPIO_Init(int x)\n{\n}\n").unwrap();
        fs::write(dir.join("notes.txt"), "HAL_GPIO_Init").unwrap();

        let state = IndexState::default();
        let stats = rescan(&state, dir.clone());
        assert_eq!((stats.files, stats.parsed), (2, 2));

        let idx = state.0.lock().unwrap();
        // Definition ranks before the prototype in the header.
        let defs = definitions(&idx, "HAL_GPIO_Init");
        assert_eq!(defs.iter().map(|d| d.sym.kind).collect::<Vec<_>>(), vec![Kind::Function, Kind::Prototype]);
        assert!(defs[0].path.ends_with("gpio.c"));
        assert_eq!((defs[0].sym.line, defs[0].sym.column), (2, 6));
        assert_eq!(definitions(&idx, "GPIO_PIN_SET")[0].sym.kind, Kind::EnumMember);
        // Fuzzy workspace symbols.
        let ws = workspace_symbols(&idx, "hgi", 10);
        assert_eq!(ws[0].sym.name, "HAL_GPIO_Init");
        assert_eq!(ws[0].sym.kind, Kind::Function);
        drop(idx);

        // Unchanged rescan parses nothing; a changed file is re-parsed.
        assert_eq!(rescan(&state, dir.clone()).parsed, 0);
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(dir.join("gpio.c"), "void HAL_GPIO_DeInit(void) {}\n").unwrap();
        let stats = rescan(&state, dir.clone());
        assert_eq!(stats.parsed, 1);
        let idx = state.0.lock().unwrap();
        assert_eq!(definitions(&idx, "HAL_GPIO_Init")[0].sym.kind, Kind::Prototype);
        assert_eq!(definitions(&idx, "HAL_GPIO_DeInit").len(), 1);
        drop(idx);
        let _ = fs::remove_dir_all(&dir);
    }
}
