//! Win32 window enumeration + manipulation for 창 관리자 (WinTamer).
//!
//! Every command takes a window handle as an `i64` (the raw HWND, safe to round-trip
//! through JS since handles fit comfortably below 2^53). Each mutating command records
//! the handle in `MANAGED` so a window we have modified keeps showing up in the list even
//! if a change (e.g. hiding from the taskbar) would otherwise drop it from the alt-tab set.

use core::ffi::c_void;
use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, BOOL, COLORREF, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetLayeredWindowAttributes, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsWindow, IsWindowVisible, SetLayeredWindowAttributes,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, GWL_STYLE, HWND_NOTOPMOST,
    HWND_TOPMOST, LWA_ALPHA, SET_WINDOW_POS_FLAGS, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNA, WS_CAPTION, WS_EX_APPWINDOW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_THICKFRAME,
};

/// Handles we have touched — always included in the listing, even when filtered out otherwise.
static MANAGED: LazyLock<Mutex<HashSet<isize>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

fn mark(hwnd: i64) {
    if let Ok(mut m) = MANAGED.lock() {
        m.insert(hwnd as isize);
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
        .map(|m| m.contains(&(hwnd.0 as isize)))
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

unsafe fn build_info(hwnd: HWND) -> Option<WindowInfo> {
    if !IsWindow(hwnd).as_bool() {
        return None;
    }

    let len = GetWindowTextLengthW(hwnd);
    let title = if len > 0 {
        let mut buf = vec![0u16; (len + 1) as usize];
        let n = GetWindowTextW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..n as usize])
    } else {
        String::new()
    };

    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let proc_name = process_name(pid);
    let app = app_name(&proc_name, &title);

    let mut rect = RECT::default();
    let _ = GetWindowRect(hwnd, &mut rect);

    let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;

    let (translucent, opacity) = layered_alpha(hwnd, ex);

    Some(WindowInfo {
        hwnd: id_of(hwnd),
        title,
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

        // Drop dead handles from the managed set.
        if let Ok(mut m) = MANAGED.lock() {
            m.retain(|&id| IsWindow(HWND(id as *mut c_void)).as_bool());
        }

        let mut out: Vec<WindowInfo> = handles.into_iter().filter_map(|h| build_info(h)).collect();
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
