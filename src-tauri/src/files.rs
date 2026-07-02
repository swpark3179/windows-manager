//! 파일 그룹 / 완전 숨김 관리 for 창 관리자 (WinTamer).
//!
//! "완전 숨김"은 `FILE_ATTRIBUTE_HIDDEN`과 `FILE_ATTRIBUTE_SYSTEM`을 함께 적용해 구현한다.
//! 탐색기의 기본 설정에서는 "숨김 파일 표시"를 켜도 보호된 운영 체제 파일(HIDDEN+SYSTEM)은
//! 계속 숨겨지므로, 두 속성을 함께 걸면 파일이 목록에서 사실상 완전히 사라진다.
//!
//! 적용 전의 HIDDEN/SYSTEM 원본 상태를 스토어에 기록해 두었다가 해제 시 그대로 복원한다.
//! desktop.ini처럼 원래부터 HIDDEN+SYSTEM인 파일은 적용/해제 모두 무해한 no-op이 된다.
//!
//! 스토어는 `%LOCALAPPDATA%\WinTamer\file-groups.json`에 저장된다. 그룹은 폴더 경로에
//! 귀속되고, 파일 항목은 절대 경로를 키로 한다. 폴더를 나열할 때마다 사라진 파일의
//! 항목을 정리(prune)하고, 밖에서(탐색기 등) 속성이 바뀐 파일은 스토어를 현실에 맞춘다.

use std::collections::HashMap;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use windows::core::{GUID, PCWSTR};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{
    GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_SYSTEM, FILE_FLAGS_AND_ATTRIBUTES, INVALID_FILE_ATTRIBUTES,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Pictures,
    FOLDERID_PublicDesktop, SHChangeNotify, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
    SHCNE_ATTRIBUTES, SHCNF_PATHW,
};

const HIDDEN: u32 = FILE_ATTRIBUTE_HIDDEN.0;
const SYSTEM: u32 = FILE_ATTRIBUTE_SYSTEM.0;

// ---------------------------------------------------------------------------
// Persistent store
// ---------------------------------------------------------------------------

/// 그룹 하나. `folder`는 그룹이 속한 폴더의 절대 경로.
#[derive(Serialize, Deserialize, Clone)]
struct StoredGroup {
    id: String,
    name: String,
    hidden: bool,
    folder: String,
}

/// 파일 하나에 대해 기억하는 것. 키는 절대 경로.
#[derive(Serialize, Deserialize, Clone, Default)]
struct StoredFile {
    /// 속한 그룹, 없으면 None.
    #[serde(default)]
    group_id: Option<String>,
    /// 개별(그룹과 무관한) 완전 숨김 여부.
    #[serde(default)]
    fully_hidden: bool,
    /// `Some(_)` ⇔ 우리가 HIDDEN+SYSTEM을 적용해 둔 상태. 값 = 적용 전 HIDDEN 여부.
    #[serde(default)]
    orig_hidden: Option<bool>,
    /// 적용 전 SYSTEM 여부 (desktop.ini처럼 원래 SYSTEM인 파일에서 복원 시 SYSTEM을 지우지 않기 위함).
    #[serde(default)]
    orig_system: bool,
    /// 바탕화면 파일을 숨기기 직전에 캡처한 아이콘 좌표. 해제 후 이 자리로 되돌린다.
    /// `orig_hidden`이 `Some`인 동안에만 의미가 있으며, 복원과 함께 비워진다.
    #[serde(default)]
    orig_x: Option<i32>,
    #[serde(default)]
    orig_y: Option<i32>,
}

impl StoredFile {
    /// 더 이상 기억할 것이 없는 항목인가 (스토어에서 지워도 되는가).
    fn is_empty(&self) -> bool {
        self.group_id.is_none() && !self.fully_hidden && self.orig_hidden.is_none()
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct FileStore {
    #[serde(default)]
    next_id: u64,
    #[serde(default)]
    groups: Vec<StoredGroup>,
    #[serde(default)]
    files: HashMap<String, StoredFile>,
}

static STORE: LazyLock<Mutex<FileStore>> = LazyLock::new(|| Mutex::new(load_store()));

/// `%LOCALAPPDATA%\WinTamer\file-groups.json`
fn store_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    let mut dir = PathBuf::from(base);
    dir.push("WinTamer");
    let _ = std::fs::create_dir_all(&dir);
    dir.push("file-groups.json");
    Some(dir)
}

fn load_store() -> FileStore {
    let Some(path) = store_path() else {
        return FileStore::default();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return FileStore::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_store(store: &FileStore) {
    let Some(path) = store_path() else { return };
    if let Ok(json) = serde_json::to_string(store) {
        let _ = std::fs::write(path, json);
    }
}

// ---------------------------------------------------------------------------
// Attribute plumbing
// ---------------------------------------------------------------------------

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn get_attrs(path: &str) -> Option<u32> {
    let wide = to_wide(path);
    let attrs = unsafe { GetFileAttributesW(PCWSTR(wide.as_ptr())) };
    if attrs == INVALID_FILE_ATTRIBUTES {
        None
    } else {
        Some(attrs)
    }
}

fn set_attrs(path: &str, attrs: u32) -> Result<(), String> {
    // 남는 속성이 하나도 없으면 0은 유효하지 않으므로 NORMAL로 대신한다.
    let attrs = if attrs == 0 { FILE_ATTRIBUTE_NORMAL.0 } else { attrs };
    let wide = to_wide(path);
    unsafe { SetFileAttributesW(PCWSTR(wide.as_ptr()), FILE_FLAGS_AND_ATTRIBUTES(attrs)) }
        .map_err(|e| format!("{path}: {e}"))?;
    // 열려 있는 탐색기 창이 즉시 갱신되도록 셸에 속성 변경을 알린다.
    unsafe {
        SHChangeNotify(SHCNE_ATTRIBUTES, SHCNF_PATHW, Some(wide.as_ptr() as *const _), None);
    }
    Ok(())
}

/// 한 파일의 실제 속성을 원하는 완전 숨김 상태(`desired`)에 맞춘다.
/// 적용 시 원본 HIDDEN/SYSTEM 상태를 기록하고, 해제 시 그 기록대로 복원한다.
fn reconcile(path: &str, entry: &mut StoredFile, desired: bool) -> Result<(), String> {
    match (desired, entry.orig_hidden) {
        (true, None) => {
            let attrs = get_attrs(path).ok_or_else(|| format!("{path}: 속성을 읽을 수 없습니다"))?;
            entry.orig_hidden = Some(attrs & HIDDEN != 0);
            entry.orig_system = attrs & SYSTEM != 0;
            set_attrs(path, attrs | HIDDEN | SYSTEM)
        }
        (false, Some(orig_hidden)) => {
            // 파일이 이미 사라졌으면 조용히 기록만 정리한다.
            if let Some(attrs) = get_attrs(path) {
                let mut a = attrs;
                if !entry.orig_system {
                    a &= !SYSTEM;
                }
                if orig_hidden {
                    a |= HIDDEN;
                } else {
                    a &= !HIDDEN;
                }
                if a != attrs {
                    set_attrs(path, a)?;
                }
            }
            entry.orig_hidden = None;
            entry.orig_system = false;
            Ok(())
        }
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Known folders
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    id: String,
    name: String,
    path: String,
}

fn known_folder(rfid: &GUID) -> Option<PathBuf> {
    unsafe {
        let pw = SHGetKnownFolderPath(rfid, KF_FLAG_DEFAULT, HANDLE::default()).ok()?;
        let s = pw.to_string().ok();
        CoTaskMemFree(Some(pw.0 as *const _));
        s.map(PathBuf::from)
    }
}

/// 표시할 폴더들. OneDrive 리디렉션 등을 따라가도록 SHGetKnownFolderPath로 해석한다.
fn folder_table() -> Vec<(&'static str, &'static str, &'static GUID)> {
    vec![
        ("desktop", "바탕 화면", &FOLDERID_Desktop),
        ("downloads", "다운로드", &FOLDERID_Downloads),
        ("documents", "문서", &FOLDERID_Documents),
        ("pictures", "사진", &FOLDERID_Pictures),
        ("public-desktop", "공용 바탕 화면", &FOLDERID_PublicDesktop),
    ]
}

fn resolve_folder(id: &str) -> Result<FolderInfo, String> {
    for (fid, name, guid) in folder_table() {
        if fid == id {
            let path = known_folder(guid).ok_or_else(|| format!("{name} 폴더를 찾을 수 없습니다"))?;
            return Ok(FolderInfo {
                id: fid.to_string(),
                name: name.to_string(),
                path: path.to_string_lossy().to_string(),
            });
        }
    }
    Err(format!("알 수 없는 폴더: {id}"))
}

/// 사용자·공용 바탕화면 디렉터리 경로(소문자). 바탕화면 아이콘 좌표를 관리할 대상 판별용.
fn desktop_dirs() -> Vec<String> {
    [&FOLDERID_Desktop, &FOLDERID_PublicDesktop]
        .iter()
        .filter_map(|g| known_folder(g))
        .map(|p| p.to_string_lossy().to_lowercase())
        .collect()
}

/// 이 파일이 바탕화면(사용자/공용) 바로 아래에 있는가 — 그렇다면 아이콘 좌표를 관리한다.
fn is_desktop_path(path: &str) -> bool {
    match Path::new(path).parent() {
        Some(parent) => {
            let p = parent.to_string_lossy().to_lowercase();
            desktop_dirs().iter().any(|d| *d == p)
        }
        None => false,
    }
}

/// 한 폴더 내 여러 파일의 완전 숨김 상태를 원하는 값(`desired`)으로 맞추는 배치 처리.
/// 바탕화면 파일이면 숨기기 직전 좌표를 캡처하고, 해제 후 그 좌표로 되돌린다(전부 한 번의
/// 데스크톱 뷰 접근으로 묶음 처리). 반환값은 개별 파일에서 발생한 오류 메시지 목록.
fn apply_full_hidden(store: &mut FileStore, targets: &[(String, bool)]) -> Vec<String> {
    // 1) 숨김으로 전환되는(현재 미적용) 바탕화면 파일들의 좌표를 먼저 캡처한다.
    let to_capture: Vec<String> = targets
        .iter()
        .filter(|(p, desired)| {
            *desired
                && is_desktop_path(p)
                && store.files.get(p).map_or(true, |e| e.orig_hidden.is_none())
        })
        .map(|(p, _)| p.clone())
        .collect();
    if !to_capture.is_empty() {
        let positions = crate::desktop::capture_positions(&to_capture);
        for (key, (x, y)) in positions {
            // capture_positions 의 키는 소문자 경로. 원본 키와 매칭해 저장한다.
            if let Some(orig) = to_capture.iter().find(|p| p.to_lowercase() == key) {
                let e = store.files.entry(orig.clone()).or_default();
                e.orig_x = Some(x);
                e.orig_y = Some(y);
            }
        }
    }

    // 2) 속성을 적용/복원한다.
    let mut errors = Vec::new();
    for (path, desired) in targets {
        if let Some(entry) = store.files.get_mut(path) {
            if let Err(e) = reconcile(path, entry, *desired) {
                errors.push(e);
            }
        }
    }

    // 3) 보임으로 전환된 바탕화면 파일 중 저장된 좌표가 있는 것들을 되돌린다.
    let restores: Vec<(String, i32, i32)> = targets
        .iter()
        .filter(|(p, desired)| !*desired && is_desktop_path(p))
        .filter_map(|(p, _)| {
            let e = store.files.get(p)?;
            match (e.orig_x, e.orig_y) {
                (Some(x), Some(y)) => Some((p.clone(), x, y)),
                _ => None,
            }
        })
        .collect();
    if !restores.is_empty() {
        crate::desktop::restore_positions(&restores);
        for (p, _, _) in &restores {
            if let Some(e) = store.files.get_mut(p) {
                e.orig_x = None;
                e.orig_y = None;
            }
        }
    }

    errors
}

// ---------------------------------------------------------------------------
// Listing payloads
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfo {
    id: String,
    name: String,
    hidden: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    /// 수정 시각, epoch 밀리초.
    modified: u64,
    /// OS 숨김 속성. 완전 숨김을 우리가 적용한 파일은 적용 전 원본 값을 보여준다.
    hidden: bool,
    /// OS 시스템 속성 (동일하게 원본 기준). HIDDEN+SYSTEM 파일은 탐색기 기본 설정에서 안 보인다.
    system: bool,
    /// 개별(그룹과 무관한) 완전 숨김 여부.
    fully_hidden: bool,
    group_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    folder: FolderInfo,
    files: Vec<FileEntry>,
    groups: Vec<GroupInfo>,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_folders() -> Result<Vec<FolderInfo>, String> {
    let mut out = Vec::new();
    for (id, name, guid) in folder_table() {
        if let Some(path) = known_folder(guid) {
            if path.is_dir() {
                out.push(FolderInfo {
                    id: id.to_string(),
                    name: name.to_string(),
                    path: path.to_string_lossy().to_string(),
                });
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn list_files(folder_id: String) -> Result<FolderListing, String> {
    let folder = resolve_folder(&folder_id)?;
    let dir = Path::new(&folder.path);

    let entries = std::fs::read_dir(dir).map_err(|e| format!("폴더를 열 수 없습니다: {e}"))?;

    // 실제 디렉터리 내용 수집. 스토어와의 대조는 락 안에서 한 번에 처리한다.
    struct Raw {
        name: String,
        path: String,
        is_dir: bool,
        size: u64,
        modified: u64,
        attrs: u32,
    }
    let mut raw: Vec<Raw> = Vec::new();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path().to_string_lossy().to_string();
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        raw.push(Raw {
            name,
            path,
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified,
            attrs: meta.file_attributes(),
        });
    }
    // 탐색기처럼 폴더 먼저, 이후 이름순.
    raw.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let snapshot = {
        let mut store = STORE.lock().map_err(|e| e.to_string())?;
        let mut changed = false;

        // 1) 이 폴더에 귀속된 스토어 항목 중 실체가 사라진 파일 정리.
        let prefix = format!("{}\\", folder.path.trim_end_matches('\\'));
        let live: std::collections::HashSet<&str> = raw.iter().map(|r| r.path.as_str()).collect();
        let stale: Vec<String> = store
            .files
            .keys()
            .filter(|k| k.starts_with(&prefix) && !live.contains(k.as_str()))
            .cloned()
            .collect();
        for k in stale {
            store.files.remove(&k);
            changed = true;
        }

        // 2) 우리가 숨겨 뒀다고 기록돼 있는데 밖에서 속성이 풀린 파일 → 현실을 따른다.
        for r in &raw {
            if let Some(e) = store.files.get_mut(&r.path) {
                if e.orig_hidden.is_some() && (r.attrs & (HIDDEN | SYSTEM)) != (HIDDEN | SYSTEM) {
                    e.orig_hidden = None;
                    e.orig_system = false;
                    e.fully_hidden = false;
                    e.orig_x = None;
                    e.orig_y = None;
                    changed = true;
                }
            }
        }
        store.files.retain(|_, e| {
            if e.is_empty() {
                changed = true;
                false
            } else {
                true
            }
        });

        if changed {
            let snap = store.clone();
            drop(store);
            save_store(&snap);
            snap
        } else {
            store.clone()
        }
    };

    let group_ids: std::collections::HashSet<&str> = snapshot
        .groups
        .iter()
        .filter(|g| g.folder == folder.path)
        .map(|g| g.id.as_str())
        .collect();

    let files = raw
        .into_iter()
        .map(|r| {
            let stored = snapshot.files.get(&r.path);
            let applied = stored.and_then(|e| e.orig_hidden);
            let (hidden, system) = match (stored, applied) {
                // 우리가 숨긴 파일: 적용 전 원본 속성을 보여준다.
                (Some(e), Some(orig_hidden)) => (orig_hidden, e.orig_system),
                _ => (r.attrs & HIDDEN != 0, r.attrs & SYSTEM != 0),
            };
            let group_id = stored
                .and_then(|e| e.group_id.clone())
                // 다른 폴더로 이동한 파일 등 고아 멤버십은 노출하지 않는다.
                .filter(|gid| group_ids.contains(gid.as_str()));
            FileEntry {
                name: r.name,
                path: r.path,
                is_dir: r.is_dir,
                size: r.size,
                modified: r.modified,
                hidden,
                system,
                fully_hidden: stored.map(|e| e.fully_hidden).unwrap_or(false),
                group_id,
            }
        })
        .collect();

    let groups = snapshot
        .groups
        .iter()
        .filter(|g| g.folder == folder.path)
        .map(|g| GroupInfo {
            id: g.id.clone(),
            name: g.name.clone(),
            hidden: g.hidden,
        })
        .collect();

    Ok(FolderListing { folder, files, groups })
}

/// 선택한 파일들을 새 그룹으로 묶는다. 이미 다른 그룹에 있던 파일은 새 그룹으로 옮긴다.
/// 새 그룹은 항상 보이는 상태(hidden=false)로 시작하므로 파일 속성은 건드리지 않는다 —
/// 단, 개별 완전 숨김이 걸린 파일은 그 상태를 그대로 유지한다.
#[tauri::command]
pub fn group_files(folder_id: String, name: String, paths: Vec<String>) -> Result<GroupInfo, String> {
    if paths.is_empty() {
        return Err("선택된 파일이 없습니다".into());
    }
    let folder = resolve_folder(&folder_id)?;

    let (snapshot, info) = {
        let mut store = STORE.lock().map_err(|e| e.to_string())?;
        store.next_id += 1;
        let id = format!("g{}", store.next_id);
        let trimmed = name.trim();
        let group_name = if trimmed.is_empty() {
            let count = store.groups.iter().filter(|g| g.folder == folder.path).count();
            format!("새 그룹 {}", count + 1)
        } else {
            trimmed.to_string()
        };
        store.groups.push(StoredGroup {
            id: id.clone(),
            name: group_name.clone(),
            hidden: false,
            folder: folder.path.clone(),
        });
        for p in &paths {
            let entry = store.files.entry(p.clone()).or_default();
            entry.group_id = Some(id.clone());
        }
        let info = GroupInfo { id, name: group_name, hidden: false };
        (store.clone(), info)
    };
    save_store(&snapshot);
    Ok(info)
}

/// 그룹의 완전 숨김을 켜거나 끈다. 모든 멤버 파일의 실제 속성을 함께 맞춘다.
#[tauri::command]
pub fn set_group_hidden(group_id: String, hidden: bool) -> Result<(), String> {
    let (snapshot, errors) = {
        let mut store = STORE.lock().map_err(|e| e.to_string())?;
        let Some(g) = store.groups.iter_mut().find(|g| g.id == group_id) else {
            return Err("그룹을 찾을 수 없습니다".into());
        };
        g.hidden = hidden;

        // 그룹 멤버는 그룹 숨김이거나 개별 완전 숨김이면 숨긴 상태를 원한다.
        let targets: Vec<(String, bool)> = store
            .files
            .iter()
            .filter(|(_, e)| e.group_id.as_deref() == Some(group_id.as_str()))
            .map(|(p, e)| (p.clone(), hidden || e.fully_hidden))
            .collect();
        let errors = apply_full_hidden(&mut store, &targets);
        (store.clone(), errors)
    };
    save_store(&snapshot);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

/// 그룹을 해제한다. 멤버 파일은 (개별 완전 숨김이 아니라면) 원래 속성으로 복원된다.
#[tauri::command]
pub fn ungroup_files(group_id: String) -> Result<(), String> {
    let (snapshot, errors) = {
        let mut store = STORE.lock().map_err(|e| e.to_string())?;
        if !store.groups.iter().any(|g| g.id == group_id) {
            return Err("그룹을 찾을 수 없습니다".into());
        }
        store.groups.retain(|g| g.id != group_id);

        // 멤버들을 그룹에서 떼어내고, (개별 완전 숨김이 아닌 한) 속성 복원을 원한다.
        let member_paths: Vec<String> = store
            .files
            .iter()
            .filter(|(_, e)| e.group_id.as_deref() == Some(group_id.as_str()))
            .map(|(p, _)| p.clone())
            .collect();
        let mut targets = Vec::new();
        for p in &member_paths {
            if let Some(entry) = store.files.get_mut(p) {
                entry.group_id = None;
                targets.push((p.clone(), entry.fully_hidden));
            }
        }
        let errors = apply_full_hidden(&mut store, &targets);
        store.files.retain(|_, e| !e.is_empty());
        (store.clone(), errors)
    };
    save_store(&snapshot);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

/// 파일 하나를 그룹에서 뺀다. 그룹이 숨김 상태였다면 (개별 완전 숨김이 아닌 한) 속성을 복원한다.
#[tauri::command]
pub fn remove_from_group(path: String) -> Result<(), String> {
    let (snapshot, errors) = {
        let mut store = STORE.lock().map_err(|e| e.to_string())?;
        let desired = match store.files.get_mut(&path) {
            Some(entry) => {
                entry.group_id = None;
                entry.fully_hidden
            }
            None => return Err("그룹에 속한 파일이 아닙니다".into()),
        };
        let errors = apply_full_hidden(&mut store, &[(path.clone(), desired)]);
        store.files.retain(|_, e| !e.is_empty());
        (store.clone(), errors)
    };
    save_store(&snapshot);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

/// 파일 하나의 개별 완전 숨김을 켜거나 끈다. 숨김 그룹에 속해 있으면 속성은 유지된다.
#[tauri::command]
pub fn set_file_hidden(path: String, hidden: bool) -> Result<(), String> {
    let (snapshot, errors) = {
        let mut store = STORE.lock().map_err(|e| e.to_string())?;
        let group_hidden = store
            .files
            .get(&path)
            .and_then(|e| e.group_id.clone())
            .map(|gid| store.groups.iter().any(|g| g.id == gid && g.hidden))
            .unwrap_or(false);
        store.files.entry(path.clone()).or_default().fully_hidden = hidden;
        let desired = hidden || group_hidden;
        let errors = apply_full_hidden(&mut store, &[(path.clone(), desired)]);
        store.files.retain(|_, e| !e.is_empty());
        (store.clone(), errors)
    };
    save_store(&snapshot);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_round_trips_through_json() {
        let mut files = HashMap::new();
        files.insert(
            "C:\\Users\\me\\Desktop\\메모.txt".to_string(),
            StoredFile {
                group_id: Some("g1".into()),
                fully_hidden: true,
                orig_hidden: Some(false),
                orig_system: false,
                orig_x: Some(320),
                orig_y: Some(96),
            },
        );
        let store = FileStore {
            next_id: 1,
            groups: vec![StoredGroup {
                id: "g1".into(),
                name: "이전 버전".into(),
                hidden: true,
                folder: "C:\\Users\\me\\Desktop".into(),
            }],
            files,
        };
        let json = serde_json::to_string(&store).unwrap();
        let back: FileStore = serde_json::from_str(&json).unwrap();
        assert_eq!(back.next_id, 1);
        assert_eq!(back.groups.len(), 1);
        assert!(back.groups[0].hidden);
        let f = back.files.get("C:\\Users\\me\\Desktop\\메모.txt").unwrap();
        assert_eq!(f.group_id.as_deref(), Some("g1"));
        assert!(f.fully_hidden);
        assert_eq!(f.orig_hidden, Some(false));
        assert_eq!(f.orig_x, Some(320));
        assert_eq!(f.orig_y, Some(96));
    }

    #[test]
    fn garbage_store_loads_as_empty() {
        let parsed: FileStore = serde_json::from_str("{ not json").unwrap_or_default();
        assert!(parsed.groups.is_empty());
        assert!(parsed.files.is_empty());
    }

    #[test]
    fn reconcile_applies_and_restores_attributes() {
        // 실제 임시 파일로 HIDDEN+SYSTEM 적용 → 복원 왕복을 검증한다.
        let dir = std::env::temp_dir();
        let path = dir.join(format!("wintamer-test-{}.txt", std::process::id()));
        std::fs::write(&path, "test").unwrap();
        let p = path.to_string_lossy().to_string();

        let mut entry = StoredFile::default();
        let before = get_attrs(&p).unwrap();
        assert_eq!(before & HIDDEN, 0, "임시 파일은 숨김이 아니어야 함");

        // 적용: HIDDEN+SYSTEM 둘 다 걸린다.
        reconcile(&p, &mut entry, true).unwrap();
        let applied = get_attrs(&p).unwrap();
        assert_ne!(applied & HIDDEN, 0);
        assert_ne!(applied & SYSTEM, 0);
        assert_eq!(entry.orig_hidden, Some(false));
        assert!(!entry.orig_system);

        // 이미 원하는 상태면 no-op.
        reconcile(&p, &mut entry, true).unwrap();

        // 해제: 원래(둘 다 없음)로 복원된다.
        reconcile(&p, &mut entry, false).unwrap();
        let restored = get_attrs(&p).unwrap();
        assert_eq!(restored & HIDDEN, 0);
        assert_eq!(restored & SYSTEM, 0);
        assert_eq!(entry.orig_hidden, None);

        std::fs::remove_file(&path).unwrap();
    }

    /// 실제 커맨드 `set_file_hidden`을 통해 바탕화면 파일을 완전 숨김 → 해제했을 때
    /// 아이콘이 숨기기 직전 좌표로 복귀하는지 검증하는 E2E 테스트. explorer 데스크톱이
    /// 필요하므로 기본 실행에서 제외한다.
    ///   실행: cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture
    #[test]
    #[ignore]
    fn full_hide_unhide_restores_desktop_position() {
        use std::time::Duration;
        let dir = known_folder(&FOLDERID_Desktop).expect("바탕화면 경로");
        let path = dir.join("zz-wintamer-e2e.txt");
        std::fs::write(&path, "e2e").unwrap();
        let key = path.to_string_lossy().to_string();

        // 아이콘이 나타날 때까지 잠시 기다린 뒤, 뚜렷한 위치로 옮겨 초기 좌표를 만든다.
        std::thread::sleep(Duration::from_millis(600));
        crate::desktop::restore_positions(&[(key.clone(), 360, 320)]);
        std::thread::sleep(Duration::from_millis(300));
        let before = crate::desktop::capture_positions(&[key.clone()]);
        let p0 = *before
            .get(&key.to_lowercase())
            .expect("초기 아이콘 좌표를 찾지 못함 (자동 정렬이 켜져 있을 수 있음)");
        println!("숨기기 전 좌표 = {p0:?}");

        // 실제 커맨드로 완전 숨김 → 좌표가 스토어에 캡처되어야 한다.
        set_file_hidden(key.clone(), true).unwrap();
        {
            let store = STORE.lock().unwrap();
            let e = store.files.get(&key).expect("숨김 후 스토어 항목");
            assert!(e.fully_hidden);
            assert_eq!((e.orig_x, e.orig_y), (Some(p0.0), Some(p0.1)), "좌표 미캡처");
        }

        // 실제 커맨드로 해제 → 아이콘이 원래 좌표로 복귀해야 한다.
        set_file_hidden(key.clone(), false).unwrap();
        std::thread::sleep(Duration::from_millis(400));
        let after = crate::desktop::capture_positions(&[key.clone()]);
        let p1 = *after.get(&key.to_lowercase()).expect("복귀 후 좌표");
        println!("해제 후 좌표 = {p1:?}");
        assert!(
            (p0.0 - p1.0).abs() + (p0.1 - p1.1).abs() < 40,
            "원래 자리로 복귀하지 못함: {p0:?} → {p1:?}"
        );
        // 해제 후에는 스토어 항목이 정리되어야 한다.
        assert!(!STORE.lock().unwrap().files.contains_key(&key), "항목 미정리");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn empty_entries_are_detected() {
        assert!(StoredFile::default().is_empty());
        assert!(!StoredFile { fully_hidden: true, ..Default::default() }.is_empty());
        assert!(!StoredFile { group_id: Some("g1".into()), ..Default::default() }.is_empty());
        assert!(!StoredFile { orig_hidden: Some(true), ..Default::default() }.is_empty());
    }
}
