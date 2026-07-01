//! Win32 window enumeration + manipulation for 창 관리자 (WinTamer).
//!
//! Every command takes a window handle as an `i64` (the raw HWND, safe to round-trip
//! through JS since handles fit comfortably below 2^53). Each mutating command records
//! the handle in `MANAGED` so a window we have modified keeps showing up in the list even
//! if a change (e.g. hiding from the taskbar) would otherwise drop it from the alt-tab set.
//!
//! `MANAGED` is persisted to disk so the guarantee survives a restart of WinTamer itself:
//! a window we hid from the taskbar would otherwise become unrecoverable (filtered out by
//! `is_listable`, with no in-memory record to override it) once the app is reopened. It also
//! carries a user-chosen display name (`alias`) per window. Dead handles are pruned on every
//! enumeration, so the store self-cleans as windows close.
//!
//! A raw HWND is not a safe cross-restart key on its own: between sessions the original window
//! may have closed and its handle (or PID) been recycled by an unrelated process. So each entry
//! also records the PID and process image name captured when we touched it, and on startup we
//! re-validate every stored handle against the live system — keeping an entry only when the
//! handle still resolves to the *same* PID *and* the same process. Mismatches are dropped.

use core::ffi::c_void;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, BOOL, COLORREF, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId, OpenProcess,
    QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetForegroundWindow, GetLayeredWindowAttributes,
    GetWindowLongPtrW, GetWindowPlacement, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SetForegroundWindow,
    SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos, SetWindowTextW, ShowWindow,
    GWL_EXSTYLE, GWL_STYLE, HWND_NOTOPMOST, HWND_TOPMOST, LWA_ALPHA, SET_WINDOW_POS_FLAGS,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_RESTORE,
    SW_SHOWNA, WINDOWPLACEMENT, WS_CAPTION, WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_THICKFRAME,
};

/// What we remember about a window we have touched. The map key is the raw HWND (`isize`);
/// `pid` + `proc_name` are the identity we re-validate against on the next launch.
#[derive(Clone, Default)]
struct Managed {
    pid: u32,
    proc_name: String,
    /// User-chosen display name. When set, it is written to the real window title
    /// (title bar + taskbar) via `SetWindowTextW`. `None` ⇒ the window keeps its own title.
    alias: Option<String>,
    /// The window's original OS title, captured the first time we renamed it, so clearing
    /// the alias can restore the real title. `None` ⇒ we have not renamed this window.
    orig_title: Option<String>,
}

/// On-disk shape of one entry (the in-memory key, the HWND, becomes an explicit field here).
#[derive(Serialize, Deserialize)]
struct StoredEntry {
    hwnd: i64,
    pid: u32,
    #[serde(default)]
    proc: String,
    #[serde(default)]
    alias: Option<String>,
    #[serde(default)]
    orig_title: Option<String>,
}

/// Windows we have touched — always included in the listing, even when filtered out otherwise,
/// and the home of per-window aliases. Seeded from disk on first use (with identity re-validation)
/// so both the listing guarantee and custom names outlive a restart of WinTamer.
static MANAGED: LazyLock<Mutex<HashMap<isize, Managed>>> =
    LazyLock::new(|| Mutex::new(load_persisted()));

/// Current (PID, process image name) of a window, as the identity we persist and re-check.
unsafe fn pid_and_proc(h: HWND) -> (u32, String) {
    let mut pid = 0u32;
    GetWindowThreadProcessId(h, Some(&mut pid));
    (pid, process_name(pid))
}

/// Record (or refresh the identity of) a window we are about to modify, preserving any alias.
fn mark(hwnd: i64) {
    let (pid, proc_name) = unsafe { pid_and_proc(hwnd_from(hwnd)) };
    // Clone-then-write so we never hold the lock across file I/O. Only persist on a real change,
    // since `mark` is called on every mutating command.
    let snapshot = {
        let mut m = match MANAGED.lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        match m.get_mut(&(hwnd as isize)) {
            Some(e) if e.pid == pid && e.proc_name == proc_name => return,
            Some(e) => {
                e.pid = pid;
                e.proc_name = proc_name;
            }
            None => {
                m.insert(
                    hwnd as isize,
                    Managed { pid, proc_name, alias: None, orig_title: None },
                );
            }
        }
        m.clone()
    };
    save_persisted(&snapshot);
}

/// `%LOCALAPPDATA%\WinTamer\managed-windows.txt` — a JSON array of [`StoredEntry`].
fn store_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    let mut dir = PathBuf::from(base);
    dir.push("WinTamer");
    let _ = std::fs::create_dir_all(&dir);
    dir.push("managed-windows.txt");
    Some(dir)
}

/// Read the store and re-validate each entry against the live system: keep it only if the
/// handle still resolves to the same PID and the same process image. Entries that fail (window
/// closed, handle/PID recycled by another program) are dropped, and the pruned set is rewritten.
fn load_persisted() -> HashMap<isize, Managed> {
    let mut map = HashMap::new();
    let Some(path) = store_path() else {
        return map;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return map;
    };
    let entries: Vec<StoredEntry> = serde_json::from_str(&text).unwrap_or_default();

    let mut dropped = false;
    for e in entries {
        let h = hwnd_from(e.hwnd);
        let still_same = unsafe {
            IsWindow(h).as_bool() && {
                let (pid, proc_name) = pid_and_proc(h);
                pid == e.pid && proc_name == e.proc
            }
        };
        if still_same {
            map.insert(
                e.hwnd as isize,
                Managed {
                    pid: e.pid,
                    proc_name: e.proc,
                    alias: e.alias,
                    orig_title: e.orig_title,
                },
            );
        } else {
            dropped = true;
        }
    }
    if dropped {
        save_persisted(&map);
    }
    map
}

fn save_persisted(map: &HashMap<isize, Managed>) {
    let Some(path) = store_path() else {
        return;
    };
    let entries: Vec<StoredEntry> = map
        .iter()
        .map(|(&hwnd, m)| StoredEntry {
            hwnd: hwnd as i64,
            pid: m.pid,
            proc: m.proc_name.clone(),
            alias: m.alias.clone(),
            orig_title: m.orig_title.clone(),
        })
        .collect();
    if let Ok(json) = serde_json::to_string(&entries) {
        let _ = std::fs::write(path, json);
    }
}

#[inline]
fn hwnd_from(v: i64) -> HWND {
    HWND(v as *mut c_void)
}

#[inline]
fn id_of(h: HWND) -> i64 {
    h.0 as i64
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    hwnd: i64,
    title: String,
    /// User-chosen display name, or `None` to fall back to `title`.
    alias: Option<String>,
    /// The window's original title before we renamed it, or `None` if untouched. Lets the UI
    /// show the real title (and what "비우기" would restore) even after the live title is the alias.
    orig_title: Option<String>,
    app: String,
    #[serde(rename = "proc")]
    proc_name: String,
    pid: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    always_on_top: bool,
    hidden_from_taskbar: bool,
    overlay: bool,
    title_hidden: bool,
    translucent: bool,
    opacity: u8,
    size_locked: bool,
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<HWND>);
    let managed = MANAGED
        .lock()
        .map(|m| m.contains_key(&(hwnd.0 as isize)))
        .unwrap_or(false);
    if is_listable(hwnd) || managed {
        list.push(hwnd);
    }
    BOOL(1) // continue enumeration
}

/// Standard "would this show in alt-tab" filter: visible, titled, not a tool window,
/// not cloaked (UWP ghost), and not one of our own windows.
unsafe fn is_listable(hwnd: HWND) -> bool {
    if !IsWindowVisible(hwnd).as_bool() {
        return false;
    }
    if GetWindowTextLengthW(hwnd) == 0 {
        return false;
    }
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
    if ex & WS_EX_TOOLWINDOW.0 != 0 {
        return false;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 || pid == GetCurrentProcessId() {
        return false;
    }
    let mut cloaked = 0u32;
    let _ = DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut _ as *mut c_void,
        std::mem::size_of::<u32>() as u32,
    );
    if cloaked != 0 {
        return false;
    }
    true
}

unsafe fn build_info(hwnd: HWND, managed: &HashMap<isize, Managed>) -> Option<WindowInfo> {
    if !IsWindow(hwnd).as_bool() {
        return None;
    }

    let entry = managed.get(&(hwnd.0 as isize));
    let alias = entry.and_then(|m| m.alias.clone());
    let orig_title = entry.and_then(|m| m.orig_title.clone());

    let title = window_title(hwnd);

    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let proc_name = process_name(pid);
    let app = app_name(&proc_name, &title);

    // GetWindowRect() reports the off-screen iconic position (around -32000, -32000) for a
    // minimized window, which is meaningless to show as its size/position. GetWindowPlacement()'s
    // rcNormalPosition instead gives the rect the window will restore to, so use that while iconic.
    let mut rect = RECT::default();
    if IsIconic(hwnd).as_bool() {
        let mut wp = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        if GetWindowPlacement(hwnd, &mut wp).is_ok() {
            rect = wp.rcNormalPosition;
        } else {
            let _ = GetWindowRect(hwnd, &mut rect);
        }
    } else {
        let _ = GetWindowRect(hwnd, &mut rect);
    }

    let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;

    let (translucent, opacity) = layered_alpha(hwnd, ex);

    Some(WindowInfo {
        hwnd: id_of(hwnd),
        title,
        alias,
        orig_title,
        app,
        proc_name,
        pid,
        x: rect.left,
        y: rect.top,
        w: rect.right - rect.left,
        h: rect.bottom - rect.top,
        always_on_top: ex & WS_EX_TOPMOST.0 != 0,
        hidden_from_taskbar: ex & WS_EX_TOOLWINDOW.0 != 0,
        overlay: ex & WS_EX_TRANSPARENT.0 != 0,
        title_hidden: style & WS_CAPTION.0 != WS_CAPTION.0,
        translucent,
        opacity,
        size_locked: style & WS_THICKFRAME.0 == 0,
    })
}

unsafe fn layered_alpha(hwnd: HWND, ex: u32) -> (bool, u8) {
    if ex & WS_EX_LAYERED.0 == 0 {
        return (false, 100);
    }
    let mut alpha = 255u8;
    let ok = GetLayeredWindowAttributes(hwnd, None, Some(&mut alpha), None).is_ok();
    if ok && alpha < 255 {
        let pct = ((alpha as u32) * 100 / 255) as u8;
        (true, pct.max(1))
    } else {
        (false, 100)
    }
}

/// Read a window's current OS title (title-bar text). Empty string if it has none.
unsafe fn window_title(hwnd: HWND) -> String {
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; (len + 1) as usize];
    let n = GetWindowTextW(hwnd, &mut buf);
    String::from_utf16_lossy(&buf[..n as usize])
}

unsafe fn process_name(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }
    let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, BOOL(0), pid) {
        Ok(h) => h,
        Err(_) => return String::new(),
    };
    let mut buf = [0u16; 260];
    let mut size = buf.len() as u32;
    let res = QueryFullProcessImageNameW(
        handle,
        PROCESS_NAME_WIN32,
        PWSTR(buf.as_mut_ptr()),
        &mut size,
    );
    let _ = CloseHandle(handle);
    if res.is_err() {
        return String::new();
    }
    let full = String::from_utf16_lossy(&buf[..size as usize]);
    full.rsplit(|c| c == '\\' || c == '/')
        .next()
        .unwrap_or("")
        .to_string()
}

fn app_name(proc_name: &str, title: &str) -> String {
    let stem = proc_name
        .strip_suffix(".exe")
        .or_else(|| proc_name.strip_suffix(".EXE"))
        .unwrap_or(proc_name);
    if stem.is_empty() {
        return title
            .split(['—', '-', '|'])
            .last()
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
    }
    let mut chars = stem.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => stem.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    unsafe {
        let mut handles: Vec<HWND> = Vec::new();
        EnumWindows(Some(enum_proc), LPARAM(&mut handles as *mut _ as isize))
            .map_err(|e| e.to_string())?;

        // Drop dead handles from the managed set, and persist the prune so the on-disk
        // store doesn't accumulate handles of windows that have since closed. Snapshot the
        // surviving map for per-window alias lookup during `build_info`.
        let managed = if let Ok(mut m) = MANAGED.lock() {
            let before = m.len();
            m.retain(|&id, _| IsWindow(HWND(id as *mut c_void)).as_bool());
            let snapshot = m.clone();
            if m.len() != before {
                save_persisted(&snapshot);
            }
            snapshot
        } else {
            HashMap::new()
        };

        let mut out: Vec<WindowInfo> = handles
            .into_iter()
            .filter_map(|h| build_info(h, &managed))
            .collect();
        out.sort_by(|a, b| {
            a.app
                .to_lowercase()
                .cmp(&b.app.to_lowercase())
                .then_with(|| a.title.cmp(&b.title))
        });
        Ok(out)
    }
}

#[tauri::command]
pub fn set_always_on_top(hwnd: i64, on: bool) -> Result<(), String> {
    mark(hwnd);
    unsafe {
        let after = if on { HWND_TOPMOST } else { HWND_NOTOPMOST };
        SetWindowPos(
            hwnd_from(hwnd),
            after,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
        .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn set_hidden_from_taskbar(hwnd: i64, on: bool) -> Result<(), String> {
    mark(hwnd);
    unsafe {
        let h = hwnd_from(hwnd);
        // The taskbar only re-reads the ex-style on show, so hide → restyle → show.
        let _ = ShowWindow(h, SW_HIDE);
        let mut ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        if on {
            ex |= WS_EX_TOOLWINDOW.0;
            ex &= !WS_EX_APPWINDOW.0;
        } else {
            ex &= !WS_EX_TOOLWINDOW.0;
        }
        SetWindowLongPtrW(h, GWL_EXSTYLE, ex as isize);
        let _ = ShowWindow(h, SW_SHOWNA);
    }
    Ok(())
}

#[tauri::command]
pub fn set_title_hidden(hwnd: i64, on: bool) -> Result<(), String> {
    mark(hwnd);
    unsafe {
        let h = hwnd_from(hwnd);
        let mut style = GetWindowLongPtrW(h, GWL_STYLE) as u32;
        if on {
            style &= !WS_CAPTION.0;
        } else {
            style |= WS_CAPTION.0;
        }
        SetWindowLongPtrW(h, GWL_STYLE, style as isize);
        frame_changed(h)
    }
}

#[tauri::command]
pub fn set_size_locked(hwnd: i64, on: bool) -> Result<(), String> {
    mark(hwnd);
    unsafe {
        let h = hwnd_from(hwnd);
        let mut style = GetWindowLongPtrW(h, GWL_STYLE) as u32;
        if on {
            style &= !WS_THICKFRAME.0;
        } else {
            style |= WS_THICKFRAME.0;
        }
        SetWindowLongPtrW(h, GWL_STYLE, style as isize);
        frame_changed(h)
    }
}

#[tauri::command]
pub fn set_geometry(hwnd: i64, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
    mark(hwnd);
    unsafe {
        SetWindowPos(
            hwnd_from(hwnd),
            HWND(core::ptr::null_mut()),
            x,
            y,
            w.max(1),
            h.max(1),
            SWP_NOZORDER | SWP_NOACTIVATE,
        )
        .map_err(|e| e.to_string())
    }
}

/// Combined layered-window control. `overlay` ⇒ click-through + no focus steal;
/// `translucent` ⇒ per-pixel alpha from `opacity` (20–100%). The two share WS_EX_LAYERED,
/// so they must be reconciled together.
#[tauri::command]
pub fn set_layered(hwnd: i64, overlay: bool, translucent: bool, opacity: u8) -> Result<(), String> {
    mark(hwnd);
    unsafe {
        let h = hwnd_from(hwnd);
        let mut ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        if overlay || translucent {
            ex |= WS_EX_LAYERED.0;
        } else {
            ex &= !WS_EX_LAYERED.0;
        }
        if overlay {
            ex |= WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0;
        } else {
            ex &= !(WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0);
        }
        SetWindowLongPtrW(h, GWL_EXSTYLE, ex as isize);

        if overlay || translucent {
            let alpha = if translucent {
                let o = opacity.clamp(10, 100) as u32;
                ((o * 255 / 100) as u8).max(1)
            } else {
                255
            };
            SetLayeredWindowAttributes(h, COLORREF(0), alpha, LWA_ALPHA).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Set (or, with an empty/whitespace string, clear) the user-chosen display name for a window.
/// The name is written to the real window with `SetWindowTextW`, so it shows up in the window's
/// title bar and its taskbar button. Clearing restores the original title we captured on the first
/// rename. The entry (alias + original title + identity) is stored in `MANAGED` so the rename and
/// its undo survive a restart of WinTamer.
#[tauri::command]
pub fn set_alias(hwnd: i64, alias: String) -> Result<(), String> {
    let trimmed = alias.trim();
    let new_alias = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    };
    let h = hwnd_from(hwnd);
    let (pid, proc_name) = unsafe { pid_and_proc(h) };

    let snapshot = {
        let mut m = MANAGED.lock().map_err(|e| e.to_string())?;
        let entry = m.entry(hwnd as isize).or_insert_with(Managed::default);
        entry.pid = pid;
        entry.proc_name = proc_name;

        match &new_alias {
            Some(name) => {
                // Remember the genuine title once, before our first rename overwrites it.
                if entry.orig_title.is_none() {
                    entry.orig_title = Some(unsafe { window_title(h) });
                }
                unsafe { set_window_text(h, name)? };
            }
            None => {
                // Restore whatever the window was called before we touched it.
                if let Some(orig) = entry.orig_title.take() {
                    unsafe { set_window_text(h, &orig)? };
                }
            }
        }
        entry.alias = new_alias;
        m.clone()
    };
    save_persisted(&snapshot);
    Ok(())
}

/// Apply `text` as a window's title (title bar + taskbar button) via `SetWindowTextW`.
unsafe fn set_window_text(h: HWND, text: &str) -> Result<(), String> {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    SetWindowTextW(h, PCWSTR(wide.as_ptr())).map_err(|e| e.to_string())
}

/// Bring a window to the front of its z-order band once and give it focus, without making it
/// permanently topmost. We raise it with `BringWindowToTop` (which keeps it below any genuine
/// always-on-top window of another app) and briefly attach to the current foreground thread's
/// input queue so `SetForegroundWindow` isn't rejected by Windows' foreground-lock rules. A
/// minimized window is restored first so it actually becomes visible.
#[tauri::command]
pub fn bring_to_front(hwnd: i64) -> Result<(), String> {
    unsafe {
        let h = hwnd_from(hwnd);
        if !IsWindow(h).as_bool() {
            return Err("대상 창을 찾을 수 없습니다".into());
        }
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }

        let fg = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let cur_thread = GetCurrentThreadId();
        let attached = fg_thread != 0
            && fg_thread != cur_thread
            && AttachThreadInput(cur_thread, fg_thread, BOOL(1)).as_bool();

        let _ = BringWindowToTop(h);
        let _ = SetForegroundWindow(h);

        if attached {
            let _ = AttachThreadInput(cur_thread, fg_thread, BOOL(0));
        }
    }
    Ok(())
}

unsafe fn frame_changed(h: HWND) -> Result<(), String> {
    SetWindowPos(
        h,
        HWND(core::ptr::null_mut()),
        0,
        0,
        0,
        0,
        SET_WINDOW_POS_FLAGS(
            SWP_NOMOVE.0 | SWP_NOSIZE.0 | SWP_NOZORDER.0 | SWP_NOACTIVATE.0 | SWP_FRAMECHANGED.0,
        ),
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_entries_round_trip_through_json() {
        let entries = vec![
            StoredEntry {
                hwnd: 123_456,
                pid: 999,
                proc: "notepad.exe".into(),
                alias: Some("내 메모장".into()),
                orig_title: Some("제목 없음 - 메모장".into()),
            },
            StoredEntry {
                hwnd: -42,
                pid: 1,
                proc: "explorer.exe".into(),
                alias: None,
                orig_title: None,
            },
        ];
        let json = serde_json::to_string(&entries).unwrap();
        let back: Vec<StoredEntry> = serde_json::from_str(&json).unwrap();

        assert_eq!(back.len(), 2);
        assert_eq!(back[0].hwnd, 123_456);
        assert_eq!(back[0].pid, 999);
        assert_eq!(back[0].proc, "notepad.exe");
        assert_eq!(back[0].alias.as_deref(), Some("내 메모장"));
        assert_eq!(back[0].orig_title.as_deref(), Some("제목 없음 - 메모장"));
        assert_eq!(back[1].hwnd, -42);
        assert_eq!(back[1].alias, None);
        assert_eq!(back[1].orig_title, None);
    }

    #[test]
    fn legacy_or_garbage_store_loads_as_empty() {
        // The first cut of this store wrote one decimal handle per line — not valid JSON.
        // Loading such a file (or any corruption) must degrade to an empty set, never error.
        let legacy = "12345\n67890\n";
        let parsed: Vec<StoredEntry> = serde_json::from_str(legacy).unwrap_or_default();
        assert!(parsed.is_empty());

        let garbage = "{ not json";
        let parsed: Vec<StoredEntry> = serde_json::from_str(garbage).unwrap_or_default();
        assert!(parsed.is_empty());
    }

    #[test]
    fn missing_optional_fields_default_cleanly() {
        // An entry written by an older/leaner writer (no proc, no alias) still loads.
        let json = r#"[{"hwnd":7,"pid":3}]"#;
        let back: Vec<StoredEntry> = serde_json::from_str(json).unwrap();
        assert_eq!(back[0].hwnd, 7);
        assert_eq!(back[0].proc, "");
        assert_eq!(back[0].alias, None);
        assert_eq!(back[0].orig_title, None);
    }
}
