// 창 관리자 (WinTamer) — Tauri 2.0 / Windows desktop only
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;
mod win;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            win::list_windows,
            win::set_always_on_top,
            win::set_hidden_from_taskbar,
            win::set_title_hidden,
            win::set_size_locked,
            win::set_geometry,
            win::set_layered,
            win::set_alias,
            win::bring_to_front,
            files::list_folders,
            files::list_files,
            files::group_files,
            files::set_group_hidden,
            files::ungroup_files,
            files::remove_from_group,
            files::set_file_hidden,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
