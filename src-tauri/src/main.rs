// 창 관리자 (WinTamer) — Tauri 2.0 / Windows desktop only
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
