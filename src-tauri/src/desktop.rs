//! 바탕화면 아이콘 좌표 저장/복원 for 창 관리자 (WinTamer).
//!
//! 완전 숨김(HIDDEN+SYSTEM)을 적용하면 아이콘이 바탕화면에서 사라지고, 해제하면 셸이
//! 그 아이콘을 **원래 자리가 아니라 첫 번째 빈 격자 칸**에 다시 놓는다. 사용자가 정리해 둔
//! 배치가 흐트러지는 것을 막기 위해, 숨기기 직전 아이콘의 좌표를 읽어 두었다가 해제 후
//! 그 좌표로 되돌린다.
//!
//! 바탕화면 격자는 파일 속성이 아니라 셸(데스크톱 ListView)이 관리하므로, 실행 중인
//! explorer의 데스크톱 뷰에 COM으로 접근한다:
//!   CLSID_ShellWindows → FindWindowSW(SWC_DESKTOP) → IServiceProvider
//!   → QueryService(SID_STopLevelBrowser, IShellBrowser) → QueryActiveShellView
//!   → IFolderView2.  좌표는 `GetItemPosition`으로 읽고 `SelectAndPositionItems`로 되돌린다.
//!
//! 모든 동작은 **best-effort**다. COM 실패·자동 정렬·아이콘 미발견 등 어떤 이유로 실패해도
//! 조용히 포기할 뿐, 호출부의 숨김/해제 자체를 실패시키지 않는다.

use std::collections::HashMap;
use std::time::Duration;

use windows::core::{Interface, VARIANT};
use windows::Win32::Foundation::POINT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IServiceProvider, CLSCTX_ALL,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::Common::{ITEMIDLIST, STRRET};
use windows::Win32::UI::Shell::{
    ILFree, IFolderView2, IShellBrowser, IShellFolder, IShellWindows, ShellWindows, StrRetToBufW,
    SHGDN_FORPARSING, SID_STopLevelBrowser, SVGIO_ALLVIEW, SVSI_POSITIONITEM, SWC_DESKTOP,
    SWFO_NEEDDISPATCH,
};

/// 이 호출 동안 COM을 STA로 초기화하고, 우리가 초기화한 경우에만 해제한다.
struct ComGuard(bool);

impl ComGuard {
    fn new() -> Self {
        // 이미 초기화돼 있으면(S_FALSE) 성공으로 치되 균형을 위해 해제 대상에 포함한다.
        // RPC_E_CHANGED_MODE 등 실패면 해제하지 않는다.
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        ComGuard(hr.is_ok())
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

/// 실행 중인 explorer의 바탕화면 폴더 뷰를 얻는다.
unsafe fn desktop_view() -> windows::core::Result<IFolderView2> {
    let shell_windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL)?;
    let empty = VARIANT::default();
    let mut hwnd = 0i32;
    let dispatch =
        shell_windows.FindWindowSW(&empty, &empty, SWC_DESKTOP, &mut hwnd, SWFO_NEEDDISPATCH)?;
    let provider: IServiceProvider = dispatch.cast()?;
    let browser: IShellBrowser = provider.QueryService(&SID_STopLevelBrowser)?;
    let view = browser.QueryActiveShellView()?;
    view.cast::<IFolderView2>()
}

/// 폴더 내 한 자식 항목의 파싱용 표시 이름(파일 시스템 항목이면 전체 경로)을 읽는다.
unsafe fn item_path(folder: &IShellFolder, pidl: *const ITEMIDLIST) -> Option<String> {
    let mut strret = STRRET::default();
    folder.GetDisplayNameOf(pidl, SHGDN_FORPARSING, &mut strret).ok()?;
    let mut buf = [0u16; 1024];
    StrRetToBufW(&mut strret, Some(pidl), &mut buf).ok()?;
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..end]))
}

/// 주어진 경로들의 현재 바탕화면 아이콘 좌표를 읽는다. 찾은 것만 담아 반환한다(best-effort).
/// 키는 입력 경로를 소문자로 정규화한 값.
pub fn capture_positions(paths: &[String]) -> HashMap<String, (i32, i32)> {
    let mut out = HashMap::new();
    if paths.is_empty() {
        return out;
    }
    let _com = ComGuard::new();
    unsafe {
        let Ok(view) = desktop_view() else { return out };
        let Ok(folder) = view.GetFolder::<IShellFolder>() else { return out };
        let wanted: HashMap<String, String> = paths
            .iter()
            .map(|p| (p.to_lowercase(), p.clone()))
            .collect();

        let count = view.ItemCount(SVGIO_ALLVIEW).unwrap_or(0);
        for i in 0..count {
            let Ok(pidl) = view.Item(i) else { continue };
            if let Some(name) = item_path(&folder, pidl) {
                if let Some(orig) = wanted.get(&name.to_lowercase()) {
                    if let Ok(pt) = view.GetItemPosition(pidl) {
                        out.insert(orig.to_lowercase(), (pt.x, pt.y));
                    }
                }
            }
            ILFree(Some(pidl));
        }
    }
    out
}

/// 주어진 (경로, x, y) 항목들을 바탕화면의 해당 좌표로 되돌린다. 완전 숨김을 막 해제한
/// 직후에는 아이콘이 아직 뷰에 다시 나타나지 않았을 수 있으므로, 짧게 폴링하며 재시도한다.
pub fn restore_positions(items: &[(String, i32, i32)]) {
    if items.is_empty() {
        return;
    }
    let _com = ComGuard::new();
    unsafe {
        let Ok(view) = desktop_view() else { return };
        let Ok(folder) = view.GetFolder::<IShellFolder>() else { return };

        let mut remaining: HashMap<String, (i32, i32)> = items
            .iter()
            .map(|(p, x, y)| (p.to_lowercase(), (*x, *y)))
            .collect();

        // 최대 약 2초(20 × 100ms). 보통은 첫 한두 번째 시도에서 아이콘이 나타난다.
        for _ in 0..20 {
            if remaining.is_empty() {
                break;
            }
            let count = view.ItemCount(SVGIO_ALLVIEW).unwrap_or(0);
            for i in 0..count {
                let Ok(pidl) = view.Item(i) else { continue };
                if let Some(name) = item_path(&folder, pidl) {
                    if let Some(&(x, y)) = remaining.get(&name.to_lowercase()) {
                        let pt = POINT { x, y };
                        let apidl = [pidl as *const ITEMIDLIST];
                        let _ = view.SelectAndPositionItems(
                            1,
                            apidl.as_ptr(),
                            Some(&pt),
                            SVSI_POSITIONITEM.0 as u32,
                        );
                        remaining.remove(&name.to_lowercase());
                    }
                }
                ILFree(Some(pidl));
            }
            if remaining.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{
        SHChangeNotify, SHGetKnownFolderPath, FOLDERID_Desktop, KF_FLAG_DEFAULT, SHCNE_UPDATEDIR,
        SHCNF_PATHW,
    };

    fn desktop_dir() -> Option<std::path::PathBuf> {
        unsafe {
            let pw = SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DEFAULT, HANDLE::default()).ok()?;
            let s = pw.to_string().ok();
            CoTaskMemFree(Some(pw.0 as *const _));
            s.map(std::path::PathBuf::from)
        }
    }

    fn notify_dir(dir: &std::path::Path) {
        let wide: Vec<u16> = dir
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        unsafe { SHChangeNotify(SHCNE_UPDATEDIR, SHCNF_PATHW, Some(wide.as_ptr() as *const _), None) };
    }

    /// 라이브 바탕화면에서 GetItemPosition ↔ SelectAndPositionItems 왕복이 실제로 동작하는지
    /// 검증한다. 임시 아이콘을 만들어 옮겼다가 원래 자리로 되돌리므로 사용자의 실제 배치는
    /// 건드리지 않는다. explorer 데스크톱이 필요하므로 기본 실행에서 제외(`--ignored`)한다.
    ///   실행: cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture
    #[test]
    #[ignore]
    fn desktop_icon_position_round_trips() {
        let dir = desktop_dir().expect("바탕화면 경로");
        let path = dir.join("zz-wintamer-pos-test.txt");
        std::fs::write(&path, "pos").unwrap();
        notify_dir(&dir);
        let key = path.to_string_lossy().to_string();

        // 새 아이콘이 데스크톱 뷰에 나타날 때까지 최대 ~3초 대기하며 원래 좌표를 읽는다.
        let mut origin = None;
        for _ in 0..30 {
            let m = capture_positions(&[key.clone()]);
            if let Some(&p) = m.get(&key.to_lowercase()) {
                origin = Some(p);
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let (ox, oy) = origin.expect("새 아이콘 좌표를 찾지 못함 (자동 정렬이 켜져 있을 수 있음)");
        println!("origin = ({ox}, {oy})");

        // 뚜렷이 다른 위치로 옮긴 뒤, 실제로 이동했는지 확인.
        restore_positions(&[(key.clone(), ox + 160, oy + 120)]);
        std::thread::sleep(Duration::from_millis(300));
        let moved = capture_positions(&[key.clone()]);
        let (mx, my) = *moved.get(&key.to_lowercase()).expect("이동 후 좌표");
        println!("moved = ({mx}, {my})");
        assert!(
            (mx - ox).abs() + (my - oy).abs() > 50,
            "아이콘이 이동하지 않음: ({ox},{oy}) → ({mx},{my})"
        );

        // 원래 자리로 되돌린 뒤, 근처(격자 스냅 오차 허용)로 복귀했는지 확인.
        restore_positions(&[(key.clone(), ox, oy)]);
        std::thread::sleep(Duration::from_millis(300));
        let back = capture_positions(&[key.clone()]);
        let (bx, by) = *back.get(&key.to_lowercase()).expect("복귀 후 좌표");
        println!("back = ({bx}, {by})");
        assert!(
            (bx - ox).abs() + (by - oy).abs() < 80,
            "원래 자리로 복귀하지 못함: 기대 ({ox},{oy}), 실제 ({bx},{by})"
        );

        std::fs::remove_file(&path).unwrap();
        notify_dir(&dir);
    }
}
