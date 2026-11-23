//! Search and replace in files (VS Code-style): include/exclude globs,
//! .gitignore support, parallel walk, cancellation of superseded searches.

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use regex::{Captures, Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const MAX_FILE_SIZE: u64 = 4 * 1024 * 1024;
const MAX_PREVIEW_CHARS: usize = 240;

/// Bumped by every search; running walks stop when they are superseded.
static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub root: String,
    pub query: String,
    pub is_regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub max_results: Option<usize>,
    /// Comma-separated globs, e.g. "src, *.c, ./Core/**".
    #[serde(default)]
    pub include: String,
    #[serde(default)]
    pub exclude: String,
    /// Respect .gitignore / .ignore files and skip hidden files.
    #[serde(default = "yes")]
    pub use_ignore_files: bool,
}

fn yes() -> bool {
    true
}

#[derive(Serialize)]
pub struct LineMatch {
    /// 1-based line number.
    pub line: usize,
    /// 1-based start/end columns in UTF-16 code units (what Monaco expects).
    pub start_col: usize,
    pub end_col: usize,
    /// Line text (trimmed at the start) and the match position inside it.
    pub preview: String,
    pub preview_start: usize,
    pub preview_end: usize,
}

#[derive(Serialize)]
pub struct FileMatches {
    pub path: String,
    pub matches: Vec<LineMatch>,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub files: Vec<FileMatches>,
    pub total: usize,
    pub truncated: bool,
    pub cancelled: bool,
}

pub(crate) fn build_regex(query: &str, is_regex: bool, case_sensitive: bool, whole_word: bool) -> Result<Regex, String> {
    let mut pattern = if is_regex { query.to_string() } else { regex::escape(query) };
    if whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| e.to_string())
}

/// VS Code-style glob list -> GlobSet. `src` matches a folder or file named
/// src anywhere, `*.c` matches at any depth, `./Core` is relative to the root.
fn build_globs(spec: &str) -> Result<Option<GlobSet>, String> {
    let mut builder = GlobSetBuilder::new();
    let mut any = false;
    for raw in spec.split(',') {
        let mut p = raw.trim().replace('\\', "/");
        if p.is_empty() {
            continue;
        }
        p = p.trim_end_matches('/').to_string();
        let anchored = if let Some(rest) = p.strip_prefix("./") {
            rest.to_string()
        } else if p.starts_with("**/") || p.starts_with('/') {
            p.trim_start_matches('/').to_string()
        } else {
            format!("**/{p}")
        };
        for pat in [anchored.clone(), format!("{anchored}/**")] {
            let glob = GlobBuilder::new(&pat)
                .literal_separator(true)
                .case_insensitive(true)
                .build()
                .map_err(|e| format!("Invalid pattern '{}': {e}", raw.trim()))?;
            builder.add(glob);
        }
        any = true;
    }
    if !any {
        return Ok(None);
    }
    builder.build().map(Some).map_err(|e| e.to_string())
}

fn relative(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Iterate lines as (content without EOL, EOL).
fn lines_with_eol(text: &str) -> impl Iterator<Item = (&str, &str)> {
    text.split_inclusive('\n').map(|l| {
        if let Some(c) = l.strip_suffix("\r\n") {
            (c, "\r\n")
        } else if let Some(c) = l.strip_suffix('\n') {
            (c, "\n")
        } else {
            (l, "")
        }
    })
}

fn search_text(re: &Regex, text: &str, budget: usize) -> Vec<LineMatch> {
    let mut out = Vec::new();
    for (idx, (line, _)) in lines_with_eol(text).enumerate() {
        for m in re.find_iter(line) {
            if m.start() == m.end() {
                continue;
            }
            let start_col = utf16_len(&line[..m.start()]) + 1;
            let end_col = start_col + utf16_len(m.as_str());
            let trimmed = line.trim_start();
            let cut = line.len() - trimmed.len();
            let preview: String = trimmed.chars().take(MAX_PREVIEW_CHARS).collect();
            let ps = utf16_len(&line[cut..m.start().max(cut)]);
            let pe = (ps + utf16_len(m.as_str())).min(utf16_len(&preview));
            out.push(LineMatch { line: idx + 1, start_col, end_col, preview, preview_start: ps.min(pe), preview_end: pe });
            if out.len() >= budget {
                return out;
            }
        }
    }
    out
}

fn run_search(opts: SearchOptions, generation: u64) -> Result<SearchResult, String> {
    let empty = |cancelled| SearchResult { files: vec![], total: 0, truncated: false, cancelled };
    if opts.query.is_empty() {
        return Ok(empty(false));
    }
    let re = build_regex(&opts.query, opts.is_regex, opts.case_sensitive, opts.whole_word)?;
    let include = build_globs(&opts.include)?;
    let exclude = build_globs(&opts.exclude)?.map(Arc::new);
    let max = opts.max_results.unwrap_or(10_000);
    let root = PathBuf::from(&opts.root);

    let mut walker = ignore::WalkBuilder::new(&root);
    walker
        .git_ignore(opts.use_ignore_files)
        .git_global(opts.use_ignore_files)
        .git_exclude(opts.use_ignore_files)
        .ignore(opts.use_ignore_files)
        .parents(opts.use_ignore_files)
        .hidden(opts.use_ignore_files)
        // Like VS Code: honor .gitignore even when the folder is not a git repo.
        .require_git(false);
    {
        let root = root.clone();
        let exclude = exclude.clone();
        walker.filter_entry(move |e| {
            if e.file_name() == ".git" {
                return false;
            }
            exclude.as_ref().is_none_or(|ex| !ex.is_match(relative(&root, e.path())))
        });
    }

    let files = Mutex::new(Vec::<FileMatches>::new());
    let total = AtomicUsize::new(0);
    walker.build_parallel().run(|| {
        let (re, include, root, files, total) = (&re, &include, &root, &files, &total);
        Box::new(move |entry| {
            if GENERATION.load(Ordering::Relaxed) != generation || total.load(Ordering::Relaxed) >= max {
                return ignore::WalkState::Quit;
            }
            let Ok(entry) = entry else { return ignore::WalkState::Continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return ignore::WalkState::Continue;
            }
            if include.as_ref().is_some_and(|inc| !inc.is_match(relative(root, entry.path()))) {
                return ignore::WalkState::Continue;
            }
            if entry.metadata().map(|m| m.len() > MAX_FILE_SIZE).unwrap_or(true) {
                return ignore::WalkState::Continue;
            }
            let Ok(bytes) = fs::read(entry.path()) else { return ignore::WalkState::Continue };
            if bytes[..bytes.len().min(1024)].contains(&0) {
                return ignore::WalkState::Continue; // binary
            }
            let text = String::from_utf8_lossy(&bytes);
            let budget = max.saturating_sub(total.load(Ordering::Relaxed)).max(1);
            let matches = search_text(re, &text, budget);
            if !matches.is_empty() {
                total.fetch_add(matches.len(), Ordering::Relaxed);
                files.lock().unwrap().push(FileMatches { path: crate::fs_cmds::display_path(entry.path()), matches });
            }
            ignore::WalkState::Continue
        })
    });

    if GENERATION.load(Ordering::Relaxed) != generation {
        return Ok(empty(true));
    }
    let mut files = files.into_inner().unwrap();
    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    let total = total.into_inner();
    Ok(SearchResult { files, total, truncated: total >= max, cancelled: false })
}

#[tauri::command]
pub async fn search_in_files(options: SearchOptions) -> Result<SearchResult, String> {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || run_search(options, generation))
        .await
        .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------------ replace

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTarget {
    pub path: String,
    /// (line, start_col) of the matches to replace; all matches when absent.
    pub matches: Option<Vec<(usize, usize)>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceRequest {
    pub query: String,
    pub is_regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub replace: String,
    pub preserve_case: bool,
    pub targets: Vec<ReplaceTarget>,
}

#[derive(Serialize, Default)]
pub struct ReplaceResult {
    pub replaced: usize,
    pub files: usize,
    pub errors: Vec<String>,
}

/// Apply the case pattern of `matched` to `replacement` (VS Code "Preserve Case").
pub(crate) fn preserve_case(matched: &str, replacement: &str) -> String {
    let letters: Vec<char> = matched.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.is_empty() {
        return replacement.to_string();
    }
    if letters.iter().all(|c| c.is_uppercase()) && letters.len() > 1 {
        return replacement.to_uppercase();
    }
    if letters.iter().all(|c| c.is_lowercase()) {
        return replacement.to_lowercase();
    }
    if letters[0].is_uppercase() && letters[1..].iter().all(|c| c.is_lowercase()) {
        let mut chars = replacement.chars();
        return match chars.next() {
            Some(f) => f.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
            None => String::new(),
        };
    }
    replacement.to_string()
}

fn replacement_for(caps: &Captures, req: &ReplaceRequest) -> String {
    let mut out = String::new();
    if req.is_regex {
        caps.expand(&req.replace, &mut out);
    } else {
        out.push_str(&req.replace);
    }
    if req.preserve_case {
        out = preserve_case(&caps[0], &out);
    }
    out
}

/// Replace in `text`; returns the new text and the number of replacements.
fn replace_text(re: &Regex, text: &str, req: &ReplaceRequest, only: Option<&[(usize, usize)]>) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut count = 0;
    for (idx, (line, eol)) in lines_with_eol(text).enumerate() {
        let mut last = 0;
        for caps in re.captures_iter(line) {
            let m = caps.get(0).unwrap();
            if m.start() == m.end() {
                continue;
            }
            if let Some(only) = only {
                let col = utf16_len(&line[..m.start()]) + 1;
                if !only.contains(&(idx + 1, col)) {
                    continue;
                }
            }
            out.push_str(&line[last..m.start()]);
            out.push_str(&replacement_for(&caps, req));
            last = m.end();
            count += 1;
        }
        out.push_str(&line[last..]);
        out.push_str(eol);
    }
    (out, count)
}

#[tauri::command]
pub async fn replace_in_files(request: ReplaceRequest) -> Result<ReplaceResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let re = build_regex(&request.query, request.is_regex, request.case_sensitive, request.whole_word)?;
        let mut result = ReplaceResult::default();
        for target in &request.targets {
            let res = (|| -> Result<usize, String> {
                let file = crate::fs_cmds::read_text_file(target.path.clone())?;
                let (text, n) = replace_text(&re, &file.content, &request, target.matches.as_deref());
                if n > 0 {
                    crate::fs_cmds::write_text_file(target.path.clone(), text, Some(file.encoding))?;
                }
                Ok(n)
            })();
            match res {
                Ok(0) => {}
                Ok(n) => {
                    result.replaced += n;
                    result.files += 1;
                }
                Err(e) => result.errors.push(format!("{}: {e}", target.path)),
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_are_utf16() {
        // An astral-plane char is 4 UTF-8 bytes but 2 UTF-16 units.
        let re = build_regex("b", false, true, false).unwrap();
        let m = search_text(&re, "a\n\u{1F600}b", 10);
        assert_eq!((m[0].line, m[0].start_col, m[0].end_col), (2, 3, 4));
    }

    #[test]
    fn whole_word_and_case() {
        let re = build_regex("gpio", false, false, true).unwrap();
        let m = search_text(&re, "GPIO_Init(GPIO); gpioA", 10);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].start_col, 11);
    }

    #[test]
    fn literal_query_is_escaped() {
        let re = build_regex("a.b(", false, true, false).unwrap();
        assert_eq!(search_text(&re, "axb( a.b(", 10).len(), 1);
    }

    #[test]
    fn preview_offsets_skip_indentation() {
        let re = build_regex("x", false, true, false).unwrap();
        let m = &search_text(&re, "    int x;", 10)[0];
        assert_eq!((m.preview.as_str(), m.preview_start, m.preview_end), ("int x;", 4, 5));
    }

    #[test]
    fn globs_follow_vscode_conventions() {
        let g = build_globs("src, *.c, ./Core/Inc").unwrap().unwrap();
        assert!(g.is_match("src"));
        assert!(g.is_match("a/src/x.h"));
        assert!(g.is_match("main.c"));
        assert!(g.is_match("Drivers/x/y.c"));
        assert!(g.is_match("Core/Inc/main.h"));
        assert!(!g.is_match("Lib/Core/Inc/main.h"));
        assert!(!g.is_match("main.h"));
        assert!(build_globs(" , ").unwrap().is_none());
    }

    #[test]
    fn search_respects_include_exclude() {
        let dir = std::env::temp_dir().join(format!("taara-search-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Drivers")).unwrap();
        fs::create_dir_all(dir.join("Core")).unwrap();
        fs::write(dir.join("Drivers/hal.c"), "HAL_Init();\n").unwrap();
        fs::write(dir.join("Core/main.c"), "HAL_Init();\n").unwrap();
        fs::write(dir.join("Core/main.h"), "void HAL_Init(void);\n").unwrap();
        fs::create_dir_all(dir.join("build")).unwrap();
        fs::write(dir.join("build/out.map"), "HAL_Init\n").unwrap();
        fs::write(dir.join(".gitignore"), "build/\n").unwrap();
        let opts = |include: &str, exclude: &str| SearchOptions {
            root: dir.to_string_lossy().into(),
            query: "HAL_Init".into(),
            is_regex: false,
            case_sensitive: true,
            whole_word: true,
            max_results: None,
            include: include.into(),
            exclude: exclude.into(),
            use_ignore_files: true,
        };
        let names = |r: SearchResult| r.files.iter().map(|f| f.path.rsplit(['\\', '/']).next().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(names(run_search(opts("", ""), GENERATION.load(Ordering::SeqCst)).unwrap()), vec!["main.c", "main.h", "hal.c"]); // sorted by path: Core/ < Drivers/
        assert_eq!(names(run_search(opts("*.c", "Drivers"), GENERATION.load(Ordering::SeqCst)).unwrap()), vec!["main.c"]);
        // .gitignore is honored without a git repo, and can be turned off.
        let mut all = opts("", "");
        all.use_ignore_files = false;
        assert_eq!(names(run_search(all, GENERATION.load(Ordering::SeqCst)).unwrap()), vec!["out.map", "main.c", "main.h", "hal.c"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn replace_keeps_eol_and_supports_groups() {
        let req = |query: &str, replace: &str, is_regex: bool, preserve: bool| ReplaceRequest {
            query: query.into(),
            is_regex,
            case_sensitive: false,
            whole_word: false,
            replace: replace.into(),
            preserve_case: preserve,
            targets: vec![],
        };
        let r = req(r"GPIO(\w)", "PORT_$1", true, false);
        let re = build_regex(&r.query, true, false, false).unwrap();
        assert_eq!(replace_text(&re, "GPIOA\r\nx GPIOB\n", &r, None), ("PORT_A\r\nx PORT_B\n".to_string(), 2));
        // Only the selected match.
        assert_eq!(replace_text(&re, "GPIOA GPIOB", &r, Some(&[(1, 7)])).0, "GPIOA PORT_B");
        // Preserve case.
        let r = req("led", "lamp", false, true);
        let re = build_regex("led", false, false, false).unwrap();
        assert_eq!(replace_text(&re, "LED Led led", &r, None).0, "LAMP Lamp lamp");
    }
}
