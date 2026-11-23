mod debug;
mod extensions;
mod fs_cmds;
mod git;
mod index;
mod lsp;
mod marketplace;
mod pty;
mod remote;
mod search;
mod settings;
mod symbols;
mod tasks;

/// Paths passed on the command line (e.g. "Open with Taara Editor").
#[tauri::command]
fn get_startup_paths() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter_map(|a| std::fs::canonicalize(&a).ok())
        .map(|p| fs_cmds::display_path(&p))
        .collect()
}

/// Stop clangd, terminals and debug servers (before the updater replaces the
/// executable, so no child process keeps files of the install folder busy).
#[tauri::command]
fn stop_child_processes(app: tauri::AppHandle) {
    use tauri::Manager;
    lsp::stop_all(&app.state::<std::sync::Arc<lsp::LspState>>());
    pty::kill_all(&app.state::<std::sync::Arc<pty::PtyState>>());
    debug::kill_all(&app.state::<std::sync::Arc<debug::ProcState>>());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(std::sync::Arc::new(index::IndexState::default()))
        .manage(std::sync::Arc::new(lsp::LspState::default()))
        .manage(std::sync::Arc::new(pty::PtyState::default()))
        .manage(std::sync::Arc::new(remote::RemoteState::default()))
        .manage(std::sync::Arc::new(debug::ProcState::default()))
        .invoke_handler(tauri::generate_handler![
            get_startup_paths,
            stop_child_processes,
            fs_cmds::read_text_file,
            fs_cmds::write_text_file,
            fs_cmds::read_dir,
            fs_cmds::create_file,
            fs_cmds::create_dir,
            fs_cmds::rename_path,
            fs_cmds::list_files,
            search::search_in_files,
            search::replace_in_files,
            index::index_folder,
            index::index_update_file,
            index::index_find_definitions,
            index::index_workspace_symbols,
            index::index_find_files,
            index::extract_symbols,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::clangd_find,
            lsp::clangd_install,
            lsp::cpp_project_config,
            pty::pty_shells,
            pty::pty_spawn,
            pty::pty_spawn_task,
            tasks::task_config,
            tasks::task_find_artifact,
            tasks::task_init_config,
            tasks::toolchain_info,
            git::git_status,
            git::git_run,
            git::git_show,
            debug::proc_start,
            debug::proc_write,
            debug::proc_kill,
            debug::debug_tools,
            remote::ssh_hosts,
            remote::ssh_connect,
            remote::ssh_disconnect,
            remote::ssh_read_dir,
            remote::ssh_read_file,
            remote::ssh_write_file,
            remote::ssh_create_file,
            remote::ssh_create_dir,
            remote::ssh_rename,
            remote::ssh_exec,
            remote::ssh_shell_open,
            remote::ssh_shell_write,
            remote::ssh_shell_resize,
            remote::ssh_shell_close,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            settings::load_settings,
            settings::save_settings,
            extensions::list_extensions,
            extensions::install_vsix,
            extensions::uninstall_extension,
            extensions::extensions_dir,
            marketplace::marketplace_search,
            marketplace::marketplace_manifest,
            marketplace::marketplace_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Taara Editor")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_child_processes(app.clone());
            }
        });
}
