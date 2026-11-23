//! Build / clean / flash tasks for embedded projects.
//!
//! Commands come from `.taara/tasks.json` when present; otherwise they are
//! detected from the project (Makefile targets, STM32CubeIDE `Debug/makefile`,
//! CMake / CMakePresets). Flashing uses STM32CubeProgrammer (standalone or the
//! copy bundled with STM32CubeIDE), OpenOCD or st-flash, whichever is found.

use crate::fs_cmds::display_path;
use crate::lsp::{is_project_file, on_path, DEVICE};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::SystemTime;

#[derive(Serialize, Default, Debug)]
pub struct TaskConfig {
    /// Where the commands come from: "tasks.json", "make", "cubeide", "cmake" or "none".
    pub system: String,
    /// Working directory for the commands.
    pub cwd: String,
    pub build: Option<String>,
    pub rebuild: Option<String>,
    pub clean: Option<String>,
    /// May contain ${elf}, ${bin}, ${hex}: resolved when flashing.
    pub flash: Option<String>,
    pub flash_tool: Option<String>,
    pub device: Option<String>,
    pub notes: Vec<String>,
}

static MAKE_TARGET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^([A-Za-z0-9_.\-]+)\s*:(?:[^=]|$)").unwrap());

fn jobs() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(16)
}

fn make_targets(makefile: &Path) -> Vec<String> {
    fs::read_to_string(makefile)
        .map(|t| MAKE_TARGET.captures_iter(&t).map(|c| c[1].to_string()).collect())
        .unwrap_or_default()
}

/// Most frequent STM32 device define in the project files.
fn detect_device(root: &Path) -> Option<String> {
    let mut count: HashMap<String, usize> = HashMap::new();
    for e in ignore::WalkBuilder::new(root).require_git(false).hidden(false).max_depth(Some(4)).build().filter_map(Result::ok) {
        let name = e.file_name().to_string_lossy();
        if e.file_type().is_some_and(|t| t.is_file()) && is_project_file(&name) {
            if let Ok(text) = fs::read_to_string(e.path()) {
                for c in DEVICE.captures_iter(&text) {
                    *count.entry(c[1].to_string()).or_default() += 1;
                }
            }
        }
    }
    count.into_iter().max_by_key(|(_, n)| *n).map(|(d, _)| d)
}

/// OpenOCD target config for an STM32 device (STM32F407xx -> stm32f4x).
fn openocd_target(device: &str) -> String {
    let fam = device.get(5..7).unwrap_or("F4").to_ascii_lowercase();
    match fam.as_str() {
        "l0" | "l1" => format!("stm32{fam}"),
        _ => format!("stm32{fam}x"),
    }
}

fn newest(paths: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    let mut v: Vec<PathBuf> = paths.into_iter().filter(|p| p.is_file()).collect();
    v.sort();
    v.pop()
}

/// STM32CubeProgrammer CLI: PATH, standalone install, or bundled in STM32CubeIDE.
fn find_cube_programmer() -> Option<PathBuf> {
    let exe = "STM32_Programmer_CLI.exe";
    if let Some(p) = on_path(exe) {
        return Some(p);
    }
    let mut candidates = Vec::new();
    for base in [std::env::var_os("ProgramFiles"), std::env::var_os("ProgramFiles(x86)")].into_iter().flatten() {
        candidates.push(PathBuf::from(base).join(r"STMicroelectronics\STM32Cube\STM32CubeProgrammer\bin").join(exe));
    }
    if let Some(p) = newest(candidates) {
        return Some(p);
    }
    // C:\ST\STM32CubeIDE_x\STM32CubeIDE\plugins\*cubeprogrammer*\tools\bin\
    let mut bundled = Vec::new();
    for ide in fs::read_dir(r"C:\ST").into_iter().flatten().filter_map(Result::ok) {
        let plugins = ide.path().join("STM32CubeIDE").join("plugins");
        for p in fs::read_dir(&plugins).into_iter().flatten().filter_map(Result::ok) {
            if p.file_name().to_string_lossy().contains("cubeprogrammer") {
                bundled.push(p.path().join("tools").join("bin").join(exe));
            }
        }
    }
    newest(bundled)
}

fn quote(p: &Path) -> String {
    format!("\"{}\"", display_path(p))
}

/// Default flash command for the tools available on this machine.
fn default_flash(device: Option<&str>) -> Option<(String, String)> {
    if let Some(cli) = find_cube_programmer() {
        return Some((format!("{} -c port=SWD mode=UR -w \"${{elf}}\" -v -rst", quote(&cli)), format!("STM32CubeProgrammer ({})", display_path(&cli))));
    }
    if let Some(ocd) = on_path("openocd.exe").or_else(|| on_path("openocd")) {
        let target = device.map(openocd_target).unwrap_or_else(|| "stm32f4x".into());
        return Some((
            format!("{} -f interface/stlink.cfg -f target/{target}.cfg -c \"program {{${{elf}}}} verify reset exit\"", quote(&ocd)),
            format!("OpenOCD ({})", display_path(&ocd)),
        ));
    }
    if let Some(st) = on_path("st-flash.exe").or_else(|| on_path("st-flash")) {
        return Some((format!("{} --reset write \"${{bin}}\" 0x08000000", quote(&st)), format!("st-flash ({})", display_path(&st))));
    }
    None
}

fn from_tasks_json(root: &Path, cfg: &mut TaskConfig) -> bool {
    let path = root.join(".taara").join("tasks.json");
    let Ok(text) = fs::read_to_string(&path) else { return false };
    // Allow // comments like VS Code's tasks.json.
    let cleaned: String = text.lines().map(|l| if l.trim_start().starts_with("//") { "" } else { l }).collect::<Vec<_>>().join("\n");
    let v: Value = match serde_json::from_str(&cleaned) {
        Ok(v) => v,
        Err(e) => {
            cfg.notes.push(format!(".taara/tasks.json is invalid: {e}"));
            return false;
        }
    };
    let get = |k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(str::to_string);
    cfg.system = "tasks.json".into();
    cfg.build = get("build");
    cfg.rebuild = get("rebuild");
    cfg.clean = get("clean");
    cfg.flash = get("flash");
    if let Some(cwd) = get("cwd") {
        cfg.cwd = display_path(&root.join(cwd));
    }
    cfg.notes.push(format!("Commands from {}", display_path(&path)));
    true
}

fn detect(root: &Path) -> TaskConfig {
    let mut cfg = TaskConfig { system: "none".into(), cwd: display_path(root), device: detect_device(root), ..Default::default() };
    let j = jobs();
    let from_json = from_tasks_json(root, &mut cfg);

    if !from_json {
        let makefile = ["Makefile", "makefile", "GNUmakefile"].iter().map(|n| root.join(n)).find(|p| p.is_file());
        let cube_debug = ["Debug", "Release"].iter().map(|d| root.join(d).join("makefile")).find(|p| p.is_file());
        if let Some(mk) = makefile {
            let targets = make_targets(&mk);
            let has = |t: &str| targets.iter().any(|x| x == t);
            cfg.system = "make".into();
            // Taara's STM32 template (python version) uses build / run / clean targets.
            cfg.build = Some(if has("build") { format!("make -j{j} build") } else { format!("make -j{j}") });
            cfg.clean = has("clean").then(|| "make clean".to_string());
            cfg.rebuild = cfg.clean.as_ref().map(|c| format!("{c} && {}", cfg.build.as_ref().unwrap()));
            cfg.flash = ["flash", "run", "upload", "program", "download"].iter().find(|t| has(t)).map(|t| format!("make {t}"));
            cfg.notes.push(format!("Makefile targets: {}", targets.iter().take(12).cloned().collect::<Vec<_>>().join(", ")));
        } else if let Some(mk) = cube_debug {
            // STM32CubeIDE managed build: Debug/makefile is generated by the IDE.
            let dir = mk.parent().unwrap().file_name().unwrap().to_string_lossy().to_string();
            cfg.system = "cubeide".into();
            cfg.build = Some(format!("make -j{j} -C {dir} all"));
            cfg.clean = Some(format!("make -C {dir} clean"));
            cfg.rebuild = Some(format!("make -C {dir} clean && make -j{j} -C {dir} all"));
            cfg.notes.push(format!("STM32CubeIDE project ({dir}/makefile is generated by CubeIDE; regenerate it there after changing project settings)"));
        } else if root.join("CMakeLists.txt").is_file() {
            cfg.system = "cmake".into();
            let preset = fs::read_to_string(root.join("CMakePresets.json"))
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .and_then(|v| v["configurePresets"].as_array()?.iter().filter_map(|p| p["name"].as_str()).find(|n| !n.starts_with("default")).map(str::to_string)
                    .or_else(|| v["configurePresets"].as_array()?.first()?["name"].as_str().map(str::to_string)));
            if let Some(p) = preset {
                cfg.build = Some(format!("cmake --preset {p} && cmake --build --preset {p} -j {j}"));
                cfg.clean = Some(format!("cmake --build --preset {p} --target clean"));
                cfg.rebuild = Some(format!("cmake --build --preset {p} --clean-first -j {j}"));
                cfg.notes.push(format!("CMake preset: {p}"));
            } else {
                let gen = if on_path("ninja.exe").or_else(|| on_path("ninja")).is_some() { "Ninja" } else { "Unix Makefiles" };
                cfg.build = Some(format!("cmake -S . -B build -G \"{gen}\" && cmake --build build -j {j}"));
                cfg.clean = Some("cmake --build build --target clean".into());
                cfg.rebuild = Some(format!("cmake --build build --clean-first -j {j}"));
            }
        }
    }

    if cfg.flash.is_none() {
        if let Some((cmd, tool)) = default_flash(cfg.device.as_deref()) {
            cfg.flash = Some(cmd);
            cfg.flash_tool = Some(tool);
        } else {
            cfg.notes.push("No flash tool found: install STM32CubeProgrammer, OpenOCD or st-flash, or set \"flash\" in .taara/tasks.json".into());
        }
    } else if cfg.flash_tool.is_none() {
        cfg.flash_tool = Some(cfg.flash.clone().unwrap_or_default());
    }
    cfg
}

#[tauri::command]
pub async fn task_config(root: String) -> Result<TaskConfig, String> {
    tauri::async_runtime::spawn_blocking(move || detect(Path::new(&root))).await.map_err(|e| e.to_string())
}

/// Build tools found on this machine (shown by the first-run welcome tour).
#[derive(Serialize)]
pub struct Toolchain {
    pub git: Option<String>,
    pub arm_gcc: Option<String>,
    pub make: Option<String>,
    pub cmake: Option<String>,
    pub ninja: Option<String>,
    pub cube_programmer: Option<String>,
}

#[tauri::command]
pub async fn toolchain_info() -> Result<Toolchain, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let find = |names: &[&str]| names.iter().find_map(|n| on_path(n)).map(|p| display_path(&p));
        Toolchain {
            git: find(&["git.exe", "git"]),
            arm_gcc: find(&["arm-none-eabi-gcc.exe", "arm-none-eabi-gcc"]),
            make: find(&["make.exe", "mingw32-make.exe", "make"]),
            cmake: find(&["cmake.exe", "cmake"]),
            ninja: find(&["ninja.exe", "ninja"]),
            cube_programmer: find_cube_programmer().map(|p| display_path(&p)),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Newest build artifact with this extension (e.g. "elf"), searching the
/// usual output folders first.
#[tauri::command]
pub fn task_find_artifact(root: String, ext: String) -> Option<String> {
    let root = PathBuf::from(root);
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for e in ignore::WalkBuilder::new(&root)
        .require_git(false)
        .git_ignore(false) // build/ is usually git-ignored
        .hidden(false)
        .max_depth(Some(5))
        .build()
        .filter_map(Result::ok)
    {
        let p = e.path();
        if !e.file_type().is_some_and(|t| t.is_file()) || p.extension().and_then(|x| x.to_str()).map(str::to_ascii_lowercase).as_deref() != Some(ext.as_str()) {
            continue;
        }
        if p.components().any(|c| c.as_os_str() == "node_modules" || c.as_os_str() == ".git") {
            continue;
        }
        let modified = e.metadata().ok().and_then(|m| m.modified().ok()).unwrap_or(SystemTime::UNIX_EPOCH);
        if best.as_ref().is_none_or(|(t, _)| modified > *t) {
            best = Some((modified, p.to_path_buf()));
        }
    }
    best.map(|(_, p)| display_path(&p))
}

/// Write a starter .taara/tasks.json with the detected commands.
#[tauri::command]
pub fn task_init_config(root: String) -> Result<String, String> {
    let root = PathBuf::from(root);
    let dir = root.join(".taara");
    let path = dir.join("tasks.json");
    if !path.exists() {
        let cfg = detect(&root);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let s = |o: &Option<String>| Value::String(o.clone().unwrap_or_default());
        let mut obj = serde_json::Map::new();
        obj.insert("build".into(), s(&cfg.build));
        obj.insert("rebuild".into(), s(&cfg.rebuild));
        obj.insert("clean".into(), s(&cfg.clean));
        obj.insert("flash".into(), s(&cfg.flash));
        obj.insert("cwd".into(), Value::String(".".into()));
        obj.insert(
            "debug".into(),
            serde_json::json!({
                "server": "auto",
                "target": "127.0.0.1:3333",
                "stopAtMain": true,
                "load": true,
                "buildFirst": true,
                "initCommands": []
            }),
        );
        let body = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
        let text = format!(
            "// Taara build tasks. Commands run with cmd.exe in `cwd` (relative to the project folder).\n// In \"flash\", ${{elf}}, ${{bin}} and ${{hex}} are replaced by the newest build output.\n{body}\n"
        );
        fs::write(&path, text).map_err(|e| e.to_string())?;
    }
    Ok(display_path(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("taara-tasks-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn makefile_targets_drive_commands() {
        let d = tmp("make");
        fs::write(d.join("Makefile"), "C_DEFS = -DSTM32F103xB\nTARGET = blinky\nall: build\nbuild: $(OBJ)\n\t$(CC)\nclean:\n\trm -rf build\nrun:\n\tst-flash\nVAR := x\n").unwrap();
        let c = detect(&d);
        assert_eq!(c.system, "make");
        assert!(c.build.as_deref().unwrap().ends_with(" build"));
        assert_eq!(c.clean.as_deref(), Some("make clean"));
        assert_eq!(c.flash.as_deref(), Some("make run"));
        assert_eq!(c.device.as_deref(), Some("STM32F103xB"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn cubeide_and_tasks_json() {
        let d = tmp("cube");
        fs::create_dir_all(d.join("Debug")).unwrap();
        fs::write(d.join("Debug/makefile"), "all: x\n").unwrap();
        fs::write(d.join(".cproject"), "<option value=\"STM32F407xx\"/>").unwrap();
        let c = detect(&d);
        assert_eq!(c.system, "cubeide");
        assert!(c.build.as_deref().unwrap().contains("-C Debug all"));
        assert_eq!(openocd_target(c.device.as_deref().unwrap()), "stm32f4x");

        // A starter tasks.json overrides detection afterwards.
        let path = task_init_config(display_path(&d)).unwrap();
        let text = fs::read_to_string(&path).unwrap().replace("-C Debug all", "-C Debug all VERBOSE=1");
        fs::write(&path, text).unwrap();
        let c = detect(&d);
        assert_eq!(c.system, "tasks.json");
        assert!(c.build.as_deref().unwrap().ends_with("VERBOSE=1"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn newest_artifact_is_found() {
        let d = tmp("art");
        fs::create_dir_all(d.join("build/old")).unwrap();
        fs::write(d.join("build/old/a.elf"), "x").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        fs::write(d.join("build/b.elf"), "x").unwrap();
        fs::write(d.join(".gitignore"), "build/\n").unwrap();
        assert!(task_find_artifact(display_path(&d), "elf".into()).unwrap().ends_with("b.elf"));
        assert!(task_find_artifact(display_path(&d), "hex".into()).is_none());
        let _ = fs::remove_dir_all(&d);
    }
}
