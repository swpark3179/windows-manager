// 창 관리자 (WinTamer) — frontend. Ports 창 관리자.dc.html to plain JS and wires it
// to the Rust/Win32 backend through Tauri's invoke + window controls.

const TAURI = window.__TAURI__ || {};
const invoke = TAURI.core ? TAURI.core.invoke : async () => { throw new Error("Tauri runtime not available"); };
const appWindow = TAURI.window
  ? TAURI.window.getCurrentWindow()
  : { minimize() {}, toggleMaximize() {}, close() {} };

const state = {
  theme: "light",
  mode: "windows", // "windows" | "files"
  query: "",
  selectedId: null,
  windows: [],
  refreshing: false,

  // -- 파일 탭 --
  folders: [], // [{id, name, path}]
  currentFolderId: null,
  filesData: null, // 마지막 list_files 응답: {folder, files, groups}
  fileView: "manage", // "manage" | "preview"
  folderMenuOpen: false,
  addToGroupMenuOpen: false,
  expandedGroupId: null,
  selectedFilePaths: [],
  newGroupName: "",
  filesLoading: false,
  filesError: null, // 목록 로드 실패 (우측 패널 전체를 에러 화면으로)
  fileOpError: null, // 개별 조작 실패 (배너로 표시)
};

let card; // root element, persists across renders

// ---------------------------------------------------------------------------
// Theme palette (mirrors the design)
// ---------------------------------------------------------------------------

const ACCENT = "#0067c0";

function palette(theme) {
  const base = ACCENT;
  if (theme === "dark") return {
    "--bg": "#202020", "--pane": "#272727", "--card": "#2b2b2b",
    "--line": "rgba(255,255,255,0.07)", "--text": "#ffffff", "--text2": "#cdcdcd", "--text3": "#8c8c8c",
    "--accent": `color-mix(in srgb, ${base} 56%, #ffffff)`, "--accent-text": "#101010",
    "--hover": "rgba(255,255,255,0.055)", "--sel": "rgba(255,255,255,0.07)",
    "--tg-border": "#9a9a9a", "--tg-knob": "#cfcfcf", "--knob-on": "#101010",
    "--control": "rgba(255,255,255,0.045)", "--control-line": "rgba(255,255,255,0.12)",
    "--scroll": "rgba(255,255,255,0.20)", "--scroll-h": "rgba(255,255,255,0.34)", "--close-hover": "#c42b1c",
  };
  return {
    "--bg": "#f3f3f3", "--pane": "#f9f9f9", "--card": "#ffffff",
    "--line": "rgba(0,0,0,0.07)", "--text": "#1b1b1b", "--text2": "#5f5f5f", "--text3": "#9b9b9b",
    "--accent": base, "--accent-text": "#ffffff",
    "--hover": "rgba(0,0,0,0.045)", "--sel": `color-mix(in srgb, ${base} 11%, transparent)`,
    "--tg-border": "#8a8a8a", "--tg-knob": "#5a5a5a", "--knob-on": "#ffffff",
    "--control": "#ffffff", "--control-line": "rgba(0,0,0,0.13)",
    "--scroll": "rgba(0,0,0,0.22)", "--scroll-h": "rgba(0,0,0,0.36)", "--close-hover": "#c42b1c",
  };
}

function applyVars() {
  const p = palette(state.theme);
  for (const k in p) card.style.setProperty(k, p[k]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s) {
  return esc(s).replace(/"/g, "&quot;");
}
function colorFor(s) {
  let h = 0;
  for (const ch of String(s || "?")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 52% 52%)`;
}
function initialFor(app, title) {
  const s = String(app || title || "?").trim();
  return (s[0] || "?").toUpperCase();
}
function getSel() {
  return state.windows.find((w) => w.hwnd === state.selectedId) || state.windows[0] || null;
}
// The name to show in the UI: the user's custom alias if set, else the real OS title.
function displayName(w) {
  const a = (w.alias || "").trim();
  return a || w.title;
}
// The window's genuine title: what we captured before renaming it, else its current title.
function originalTitle(w) {
  return (w.origTitle || "").trim() || w.title;
}
function filteredWindows() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.windows;
  return state.windows.filter(
    (w) =>
      w.title.toLowerCase().includes(q) ||
      (w.alias || "").toLowerCase().includes(q) ||
      w.app.toLowerCase().includes(q) ||
      w.proc.toLowerCase().includes(q)
  );
}

// ---------------------------------------------------------------------------
// 파일 탭 헬퍼
// ---------------------------------------------------------------------------

function fmtSize(f) {
  if (f.isDir) return "폴더";
  const n = Number(f.size) || 0;
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
function fmtDate(ms) {
  if (!ms) return "—";
  const d = new Date(Number(ms));
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function extOf(name) {
  const b = String(name).replace(/^~\$/, "");
  const i = b.lastIndexOf(".");
  const e = i > 0 ? b.slice(i + 1) : b.startsWith(".") ? b.slice(1) : "";
  return e.toLowerCase();
}
const EXT_COLORS = {
  docx: "#2b579a", doc: "#2b579a", pdf: "#c0392b",
  xlsx: "#217346", xls: "#217346", csv: "#217346",
  png: "#c2477e", jpg: "#c2477e", jpeg: "#c2477e", gif: "#c2477e",
  exe: "#5a6270", msi: "#5a6270", txt: "#7a8290", lnk: "#8a8d91",
};
function extColor(ext) {
  return EXT_COLORS[ext] || "#8a8d91";
}
function folderSvg(size, stroke) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" style="flex:none"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>`;
}
const EYE_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const EYE_OFF_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

function fileIconHTML(f, size) {
  const st = `width:${size}px;height:${size}px;flex:none;border-radius:${size >= 30 ? 7 : 6}px;display:flex;align-items:center;justify-content:center;font-size:${size >= 30 ? 9 : 8}px;font-weight:700;letter-spacing:.02em;color:#fff;`;
  if (f.isDir) return `<div style="${st}background:#e8b339">${folderSvg(size >= 30 ? 15 : 13, "#fff")}</div>`;
  const ext = extOf(f.name);
  return `<div style="${st}background:${extColor(ext)}">${esc(ext ? ext.slice(0, 3).toUpperCase() : "FILE")}</div>`;
}

function groupById(gid) {
  const d = state.filesData;
  return d ? (d.groups || []).find((g) => g.id === gid) || null : null;
}
// 그룹 숨김 또는 개별 완전 숨김이 걸려 있는가 (탐색기에서 완전히 사라지는 상태).
function isEffectivelyHidden(f) {
  const g = f.groupId ? groupById(f.groupId) : null;
  return !!(g && g.hidden) || !!f.fullyHidden;
}

function sw(on) {
  return {
    track: `flex:none;box-sizing:border-box;width:40px;height:20px;border-radius:11px;display:flex;align-items:center;padding:0 3px;cursor:pointer;transition:all .16s ease;${on ? "background:var(--accent);border:1px solid var(--accent);justify-content:flex-end" : "background:transparent;border:1.5px solid var(--tg-border);justify-content:flex-start"}`,
    knob: `border-radius:50%;transition:all .16s ease;${on ? "width:13px;height:13px;background:var(--knob-on)" : "width:11px;height:11px;background:var(--tg-knob)"}`,
  };
}

function toggleRow(w, key, label, desc, first) {
  const s = sw(w[key]);
  return `<div style="display:flex;align-items:center;gap:12px;padding:12px 14px;${first ? "" : "border-top:1px solid var(--line)"}">
    <div style="flex:1;min-width:0">
      <div style="font-size:13px;font-weight:500">${esc(label)}</div>
      <div style="font-size:11px;color:var(--text2);margin-top:2px">${esc(desc)}</div>
    </div>
    <div data-act="toggle" data-key="${key}" style="${s.track}"><div style="${s.knob}"></div></div>
  </div>`;
}

function geomField(w, key, label) {
  const box = `display:flex;align-items:center;border-radius:6px;border:1px solid var(--control-line);background:var(--control);overflow:hidden`;
  return `<div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
      <span style="font-size:11px;color:var(--text2)">${esc(label)}</span>
      <span style="font-size:10px;color:var(--text3)">px</span>
    </div>
    <div style="${box}">
      <div class="hov" data-act="geom-dec" data-key="${key}" style="width:26px;flex:none;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text2);font-size:15px;align-self:stretch">−</div>
      <input data-act="geom" data-key="${key}" value="${escAttr(w[key])}" style="flex:1;width:0;border:none;background:transparent;text-align:center;font-size:13px;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums;padding:6px 0" />
      <div class="hov" data-act="geom-inc" data-key="${key}" style="width:26px;flex:none;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text2);font-size:15px;align-self:stretch">+</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function titleBarHTML() {
  return `<div data-tauri-drag-region style="height:40px;flex:none;display:flex;align-items:center;padding-left:13px;gap:9px;border-bottom:1px solid var(--line)">
    <div data-tauri-drag-region style="width:17px;height:17px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:2px">
      <div style="border-radius:1.5px;background:var(--accent)"></div>
      <div style="border-radius:1.5px;background:var(--accent);opacity:.55"></div>
      <div style="border-radius:1.5px;background:var(--accent);opacity:.55"></div>
      <div style="border-radius:1.5px;background:var(--accent)"></div>
    </div>
    <div data-tauri-drag-region style="font-size:12.5px;font-weight:600;letter-spacing:.01em">창 관리자</div>
    <div data-tauri-drag-region style="font-size:11px;color:var(--text3);font-weight:500;padding-top:1px">WinTamer</div>
    <div data-tauri-drag-region style="flex:1"></div>
    <div class="hov" data-act="theme" title="테마 전환" style="width:34px;height:30px;border-radius:5px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text2);margin-right:6px">${state.theme === "light" ? "☾" : "☀"}</div>
    <div style="display:flex;height:40px">
      <div class="hov" data-act="win-min" title="최소화" style="width:46px;display:flex;align-items:center;justify-content:center;cursor:default;color:var(--text2)"><div style="width:11px;height:1px;background:currentColor"></div></div>
      <div class="hov" data-act="win-max" title="최대화" style="width:46px;display:flex;align-items:center;justify-content:center;cursor:default;color:var(--text2)"><div style="width:9px;height:9px;border:1px solid currentColor;border-radius:1px"></div></div>
      <div class="closehov" data-act="win-close" title="닫기" style="width:46px;display:flex;align-items:center;justify-content:center;cursor:default;color:var(--text2);font-size:14px">✕</div>
    </div>
  </div>`;
}

function listHTML(list) {
  if (!list.length) {
    return `<div style="padding:18px 10px;font-size:12px;color:var(--text3);text-align:center;line-height:1.5">표시할 창이 없습니다<br/>새로고침을 눌러 보세요</div>`;
  }
  return list
    .map((w) => {
      const isSel = w.hwnd === state.selectedId;
      const active =
        w.alwaysOnTop || w.hiddenFromTaskbar || w.overlay || w.titleHidden || w.translucent || w.sizeLocked;
      const rowStyle = `display:flex;align-items:center;gap:10px;padding:8px 9px;margin:1px 0;border-radius:7px;cursor:pointer;transition:background .12s;${isSel ? "background:var(--sel);box-shadow:inset 2.5px 0 0 var(--accent)" : "background:transparent"}`;
      const iconStyle = `width:30px;height:30px;flex:none;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;background:${colorFor(w.proc || w.app)}`;
      return `<div class="row" data-act="select" data-id="${w.hwnd}" title="클릭하여 선택" style="${rowStyle}">
        <div style="${iconStyle}">${esc(initialFor(w.app, w.title))}</div>
        <div style="min-width:0;flex:1">
          <div style="font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)">${esc(displayName(w))}</div>
          <div style="font-size:10.5px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px">${esc(w.proc)} · PID ${w.pid}</div>
        </div>
        ${active ? `<div style="width:6px;height:6px;flex:none;border-radius:50%;background:var(--accent)"></div>` : ""}
      </div>`;
    })
    .join("");
}

// 좌측 상단 창/파일 탭 전환.
function tabsHTML() {
  const base = "flex:1;height:29px;display:flex;align-items:center;justify-content:center;gap:6px;border-radius:6px;font-size:12.5px;white-space:nowrap;cursor:pointer;transition:all .13s;";
  const on = "background:var(--card);color:var(--text);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.09)";
  const off = "color:var(--text2);font-weight:500";
  const isWin = state.mode === "windows";
  return `<div style="padding:10px 12px 4px;flex:none">
    <div style="display:flex;gap:3px;background:var(--hover);border-radius:8px;padding:3px">
      <div data-act="tab-win" style="${base}${isWin ? on : off}">
        <span style="width:13px;height:13px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:1.5px"><span style="background:currentColor;border-radius:1px"></span><span style="background:currentColor;border-radius:1px;opacity:.6"></span><span style="background:currentColor;border-radius:1px;opacity:.6"></span><span style="background:currentColor;border-radius:1px"></span></span>
        창
      </div>
      <div data-act="tab-files" style="${base}${!isWin ? on : off}">
        ${folderSvg(14, "currentColor")}
        파일
      </div>
    </div>
  </div>`;
}

function leftHTML(list) {
  return `<div style="width:250px;flex:none;display:flex;flex-direction:column;background:var(--pane);border-right:1px solid var(--line);min-height:0">
    ${tabsHTML()}
    <div style="padding:8px 12px 8px;display:flex;flex-direction:column;gap:9px">
      <div style="display:flex;align-items:center;gap:7px">
        <div style="position:relative;flex:1;display:flex;align-items:center">
          <div style="position:absolute;left:9px;font-size:12px;color:var(--text3);pointer-events:none">⌕</div>
          <input class="search" data-act="search" value="${escAttr(state.query)}" placeholder="창 검색" style="width:100%;height:30px;border-radius:5px;border:1px solid var(--control-line);background:var(--control);color:var(--text);font-size:12.5px;padding:0 10px 0 24px" />
        </div>
        <div class="hov" data-act="refresh" title="목록 새로고침" style="width:30px;height:30px;flex:none;border-radius:5px;border:1px solid var(--control-line);background:var(--control);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text2);font-size:14px"><div style="display:inline-block;${state.refreshing ? "animation:spin .55s linear" : ""}">⟳</div></div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;padding:0 2px">
        <div style="font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text3)">실행 중인 창</div>
        <div id="wincount" style="font-size:10.5px;font-weight:600;color:var(--text3)">${list.length}개</div>
      </div>
    </div>
    <div id="winlist" style="flex:1;overflow-y:auto;padding:2px 8px 10px;min-height:0">${listHTML(list)}</div>
  </div>`;
}

function filesSidebarHTML() {
  const cur = state.folders.find((f) => f.id === state.currentFolderId) || null;
  const folderName = state.filesData ? state.filesData.folder.name : cur ? cur.name : "폴더";

  const menu = state.folderMenuOpen
    ? `<div style="position:absolute;left:0;right:0;top:38px;z-index:30;background:var(--card);border:1px solid var(--line);border-radius:8px;box-shadow:0 12px 34px rgba(0,0,0,.2);padding:4px;display:flex;flex-direction:column;gap:1px">
        ${state.folders
          .map((f) => {
            const active = f.id === state.currentFolderId;
            return `<div class="hov" data-act="folder-pick" data-id="${escAttr(f.id)}" title="${escAttr(f.path)}" style="display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:6px;cursor:pointer;font-size:12.5px;${active ? "background:var(--sel);color:var(--accent);font-weight:600" : "color:var(--text)"}">
              ${folderSvg(14, "currentColor")}
              <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.name)}</span>
            </div>`;
          })
          .join("")}
      </div>`
    : "";

  const legendRow = (dot, title, desc) => `<div style="display:flex;align-items:flex-start;gap:9px">
      <span style="width:9px;height:9px;flex:none;margin-top:4px;border-radius:50%;${dot}"></span>
      <div style="font-size:11.5px;color:var(--text2);line-height:1.45"><b style="color:var(--text)">${esc(title)}</b><br />${esc(desc)}</div>
    </div>`;

  return `<div style="width:250px;flex:none;display:flex;flex-direction:column;background:var(--pane);border-right:1px solid var(--line);min-height:0">
    ${tabsHTML()}
    <div style="padding:8px 12px 8px;flex:none;display:flex;flex-direction:column;gap:9px">
      <div style="font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text3);padding:0 2px">폴더 선택</div>
      <div style="position:relative">
        <div data-act="folder-menu" title="${escAttr(cur ? cur.path : "")}" style="display:flex;align-items:center;gap:7px;height:34px;border-radius:6px;border:1px solid var(--control-line);background:var(--control);padding:0 10px;cursor:pointer">
          ${folderSvg(14, "var(--accent)")}
          <span style="flex:1;min-width:0;font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(folderName)}</span>
          <span style="font-size:10px;color:var(--text3);flex:none;transition:transform .15s;${state.folderMenuOpen ? "transform:rotate(180deg)" : ""}">▾</span>
        </div>
        ${menu}
      </div>
    </div>
    <div style="flex:1;overflow-y:auto;padding:6px 12px 12px;min-height:0;display:flex;flex-direction:column;gap:10px">
      <div style="font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text3)">파일 상태 안내</div>
      ${legendRow("background:#d24435", "완전 숨김 그룹", "숨김 파일 보기와 무관하게 목록에서 완전히 사라짐")}
      ${legendRow("background:var(--accent)", "일반 그룹", "묶여 있지만 계속 표시됨")}
      ${legendRow("background:var(--tg-border);opacity:.6", "숨김 속성", "운영체제 숨김 파일 (반투명 표시)")}
    </div>
  </div>`;
}

function rightHTML() {
  const sel = getSel();
  if (!sel) {
    return `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:13px;background:var(--bg)">창을 선택하세요</div>`;
  }

  const badges = [];
  if (sel.alwaysOnTop) badges.push("항상 위로");
  if (sel.titleHidden) badges.push("타이틀 숨김");
  if (sel.translucent) badges.push(`반투명 ${sel.opacity}%`);
  if (sel.hiddenFromTaskbar) badges.push("작업표시줄 숨김");
  if (sel.overlay) badges.push("오버레이 모드");
  if (sel.sizeLocked) badges.push("크기 고정");

  const badgesHTML = badges.length
    ? badges
        .map(
          (b) =>
            `<div style="display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;background:var(--sel);color:var(--accent);font-size:11px;font-weight:600;animation:pop .18s ease"><span style="width:5px;height:5px;border-radius:50%;background:currentColor"></span>${esc(b)}</div>`
        )
        .join("")
    : `<div style="padding:4px 10px;font-size:11px;color:var(--text3)">적용된 속성 없음 · 기본 상태</div>`;

  const behavior =
    toggleRow(sel, "alwaysOnTop", "항상 위로", "다른 모든 창보다 항상 앞에 표시", true) +
    toggleRow(sel, "hiddenFromTaskbar", "작업 표시줄에서 숨기기", "작업 표시줄에서 아이콘 감추기", false) +
    toggleRow(sel, "overlay", "오버레이 모드", "클릭이 뒤 창으로 통과되며, 현재 창의 포커스도 뺏지 않음", false);

  const opacitySlider = sel.translucent
    ? `<div style="padding:12px 14px 14px;border-top:1px solid var(--line)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px">
          <div style="font-size:12px;color:var(--text2)">투명도</div>
          <div id="opval" style="font-size:12.5px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums">${sel.opacity}%</div>
        </div>
        <input type="range" min="20" max="100" step="1" value="${sel.opacity}" data-act="opacity" style="width:100%;height:4px;cursor:pointer" />
      </div>`
    : "";

  const appearance =
    toggleRow(sel, "titleHidden", "상단 타이틀 숨김", "제목 표시줄을 숨겨 화면 공간 확보", true) +
    toggleRow(sel, "translucent", "반투명 모드", "창 전체를 투명하게 표시", false) +
    opacitySlider;

  const sizeTog = sw(sel.sizeLocked);
  const geom = ["x", "y", "w", "h"]
    .map((k) => {
      const label = { x: "위치 X", y: "위치 Y", w: "너비", h: "높이" }[k];
      return geomField(sel, k, label);
    })
    .join("");

  return `<div id="rightpane" style="flex:1;overflow-y:auto;min-height:0;background:var(--bg)">
    <div style="padding:16px 18px 22px;display:flex;flex-direction:column;gap:2px">
      <div style="display:flex;align-items:center;gap:12px;padding-bottom:14px;border-bottom:1px solid var(--line)">
        <div style="width:42px;height:42px;flex:none;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:700;color:#fff;background:${colorFor(sel.proc || sel.app)}">${esc(initialFor(sel.app, sel.title))}</div>
        <div style="min-width:0;flex:1">
          <div style="font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(displayName(sel))}</div>
          <div style="font-size:11.5px;color:var(--text2);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(sel.app)} · ${esc(sel.proc)} · PID ${sel.pid}</div>
        </div>
        <div class="hov" data-act="bring-front" title="이 창을 화면 맨 앞으로 가져오기" style="flex:none;height:30px;padding:0 12px;border-radius:7px;border:1px solid var(--control-line);background:var(--control);color:var(--text);font-size:12.5px;font-weight:500;display:flex;align-items:center;gap:6px;cursor:pointer">⤒ 맨 앞으로</div>
      </div>

      <div style="font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text3);margin:16px 0 8px">창 이름</div>
      <div style="background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px">
        <div style="display:flex;align-items:center;gap:8px">
          <input data-act="alias" value="${escAttr(sel.alias || "")}" placeholder="${escAttr(originalTitle(sel))}" maxlength="120" style="flex:1;min-width:0;height:30px;border-radius:6px;border:1px solid var(--control-line);background:var(--control);color:var(--text);font-size:13px;padding:0 10px" />
          ${sel.alias ? `<div class="hov" data-act="alias-reset" title="원래 제목으로 되돌리기" style="width:30px;height:30px;flex:none;border-radius:6px;border:1px solid var(--control-line);background:var(--control);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text2);font-size:15px">↺</div>` : ""}
        </div>
        <div style="font-size:11px;color:var(--text2);margin-top:7px">실제 창 제목(타이틀바·작업 표시줄)에 반영됩니다. 비워두면 원래 제목(<span style="color:var(--text3)">${esc(originalTitle(sel))}</span>)으로 되돌립니다.</div>
      </div>

      <div style="font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text3);margin:18px 0 8px">현재 적용 상태</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${badgesHTML}</div>

      <div style="font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text3);margin:20px 0 4px">동작</div>
      <div style="background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden">${behavior}</div>

      <div style="font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text3);margin:18px 0 4px">모양</div>
      <div style="background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden">${appearance}</div>

      <div style="font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text3);margin:18px 0 4px">크기 및 위치</div>
      <div style="background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--line)">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:500">크기 고정</div>
            <div style="font-size:11px;color:var(--text2);margin-top:2px">크기 조절을 막고 위치 이동만 허용</div>
          </div>
          <div data-act="toggle" data-key="sizeLocked" style="${sizeTog.track}"><div style="${sizeTog.knob}"></div></div>
        </div>
        <div style="padding:13px 14px;display:grid;grid-template-columns:1fr 1fr;gap:11px">${geom}</div>
      </div>

      <div style="font-size:10.5px;color:var(--text3);margin-top:14px;line-height:1.5;display:flex;gap:6px">
        <span style="flex:none">ⓘ</span><span>오버레이 모드는 창을 클릭 통과시키면서도 입력 포커스를 빼앗지 않아, 영상·자막·치트시트를 위에 띄워 둘 때 유용합니다.</span>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// 파일 탭 — 우측 패널
// ---------------------------------------------------------------------------

const TAG_NEUTRAL = "display:inline-flex;align-items:center;padding:2px 7px;border-radius:5px;font-size:10px;font-weight:600;white-space:nowrap;background:var(--hover);color:var(--text3)";
const TAG_ACCENT = "display:inline-flex;align-items:center;padding:2px 7px;border-radius:5px;font-size:10px;font-weight:600;white-space:nowrap;background:var(--sel);color:var(--accent)";
const TAG_RED = "display:inline-flex;align-items:center;padding:2px 7px;border-radius:5px;font-size:10px;font-weight:600;white-space:nowrap;background:rgba(196,43,28,.14);color:#d24435";

function manageFileRowHTML(f, idx) {
  const g = f.groupId ? groupById(f.groupId) : null;
  const groupHidden = !!(g && g.hidden);
  const fully = groupHidden || !!f.fullyHidden;
  const checked = state.selectedFilePaths.includes(f.path);
  const op = fully ? ".46" : f.hidden ? ".74" : "1";

  const tags = [];
  if (f.hidden) tags.push({ text: "숨김", style: TAG_NEUTRAL });
  if (f.system) tags.push({ text: "시스템", style: TAG_NEUTRAL });
  if (g && !g.hidden) tags.push({ text: g.name, style: TAG_ACCENT });
  if (groupHidden) tags.push({ text: "그룹 숨김", style: TAG_RED });
  else if (f.fullyHidden) tags.push({ text: "완전 숨김", style: TAG_RED });

  const hideTitle = groupHidden ? "그룹에서 숨김 중" : f.fullyHidden ? "완전 숨김 해제" : "이 파일 완전 숨김";
  return `<div class="row" data-act="file-check" data-path="${escAttr(f.path)}" style="display:flex;align-items:center;gap:11px;padding:9px 12px;cursor:pointer;transition:background .1s;opacity:${op};${idx > 0 ? "border-top:1px solid var(--line);" : ""}${checked ? "background:var(--sel);" : "background:transparent;"}">
    <div style="width:18px;height:18px;flex:none;border-radius:5px;border:1.5px solid var(--control-line);display:flex;align-items:center;justify-content:center;font-size:11px;line-height:1;transition:all .12s;${checked ? "background:var(--accent);border-color:var(--accent);color:var(--accent-text)" : ""}">${checked ? "✓" : ""}</div>
    ${fileIconHTML(f, 30)}
    <div style="min-width:0;flex:1">
      <div style="font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${fully ? "text-decoration:line-through" : ""}">${esc(f.name)}</div>
      <div style="font-size:10.5px;color:var(--text3);margin-top:1px">${esc(fmtSize(f))} · ${fmtDate(f.modified)}</div>
    </div>
    <div style="display:flex;align-items:center;gap:5px;flex:none">${tags.map((t) => `<span style="${t.style}">${esc(t.text)}</span>`).join("")}</div>
    <div class="hov" data-act="file-hide" data-path="${escAttr(f.path)}" title="${escAttr(hideTitle)}" style="width:30px;height:30px;flex:none;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:${groupHidden ? "default" : "pointer"};${fully ? "color:#d24435" : "color:var(--text3)"}${groupHidden ? ";opacity:.5" : ""}">${fully ? EYE_OFF_SVG : EYE_SVG}</div>
  </div>`;
}

function groupCardHTML(g) {
  const files = (state.filesData.files || []).filter((f) => f.groupId === g.id);
  const s = sw(g.hidden);
  const expanded = state.expandedGroupId === g.id;

  const members = files
    .map(
      (m) => `<div class="row" style="display:flex;align-items:center;gap:10px;padding:7px 6px;border-radius:6px;background:transparent">
        ${fileIconHTML(m, 26)}
        <div style="min-width:0;flex:1">
          <div style="font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m.name)}</div>
          <div style="font-size:10px;color:var(--text3);margin-top:1px">${esc(fmtSize(m))} · ${fmtDate(m.modified)}</div>
        </div>
        <div class="hov" data-act="member-remove" data-path="${escAttr(m.path)}" style="font-size:11px;color:var(--text2);cursor:pointer;padding:4px 10px;border-radius:6px;border:1px solid var(--control-line);white-space:nowrap">그룹에서 제외</div>
      </div>`
    )
    .join("");

  return `<div style="border-radius:9px;background:var(--card);border:1px solid var(--line);overflow:hidden">
    <div style="display:flex;align-items:center;gap:11px;padding:11px 13px">
      <div style="width:9px;height:9px;flex:none;border-radius:50%;background:${g.hidden ? "#d24435" : "var(--accent)"}"></div>
      <div data-act="group-expand" data-id="${escAttr(g.id)}" style="min-width:0;flex:1;display:flex;align-items:center;gap:8px;cursor:pointer">
        <span style="font-size:10px;color:var(--text3);flex:none;transition:transform .15s;${expanded ? "transform:rotate(90deg)" : ""}">▸</span>
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(g.name)}</div>
          <div style="font-size:11px;color:var(--text2);margin-top:2px">파일 ${files.length}개${g.hidden ? " · 목록에서 숨김" : ""}</div>
        </div>
      </div>
      <div class="hov" data-act="group-ungroup" data-id="${escAttr(g.id)}" style="font-size:11.5px;color:var(--text2);cursor:pointer;padding:5px 9px;border-radius:6px">묶음 해제</div>
      <div style="display:flex;align-items:center;gap:7px;flex:none">
        <span style="font-size:11.5px;color:var(--text2)">완전 숨김</span>
        <div data-act="group-hide" data-id="${escAttr(g.id)}" style="${s.track}"><div style="${s.knob}"></div></div>
      </div>
    </div>
    ${expanded ? `<div style="border-top:1px solid var(--line);padding:5px 8px 8px;display:flex;flex-direction:column;gap:1px">${members || `<div style="padding:12px;text-align:center;font-size:11px;color:var(--text3)">그룹에 파일이 없습니다</div>`}</div>` : ""}
  </div>`;
}

function filesRightHTML() {
  const open = `<div id="filepane" style="flex:1;overflow-y:auto;min-height:0;background:var(--bg)">`;

  if (state.filesError && !state.filesData) {
    return `${open}<div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--text3);font-size:12.5px;padding:20px">
      <div>폴더를 불러오지 못했습니다</div>
      <div style="font-size:11px;max-width:360px;text-align:center;word-break:break-all">${esc(state.filesError)}</div>
      <div class="hov" data-act="files-reload" style="padding:7px 14px;border-radius:6px;border:1px solid var(--control-line);background:var(--control);cursor:pointer;color:var(--text);font-size:12px">다시 시도</div>
    </div></div>`;
  }
  const d = state.filesData;
  if (!d) {
    return `${open}<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:13px">${state.filesLoading ? "불러오는 중…" : "폴더를 선택하세요"}</div></div>`;
  }

  const files = d.files || [];
  const groups = d.groups || [];
  const isManage = state.fileView === "manage";
  const managedHidden = files.filter(isEffectivelyHidden).length;
  const shown = files.filter((f) => !isEffectivelyHidden(f) && !(f.hidden && f.system));
  const totalHidden = files.filter((f) => f.hidden).length;

  const headerText = isManage
    ? `파일 ${files.length}개 · 그룹 ${groups.length}개 · 숨김 속성 ${totalHidden}개`
    : `표시 중 ${shown.length}개 · 완전 숨김 ${managedHidden}개`;

  const viewTabBase = "height:29px;padding:0 14px;display:flex;align-items:center;justify-content:center;border-radius:6px;font-size:12.5px;white-space:nowrap;cursor:pointer;transition:all .13s;";
  const tabOn = "background:var(--card);color:var(--text);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.09)";
  const tabOff = "color:var(--text2);font-weight:500";

  const opError = state.fileOpError
    ? `<div style="margin-top:12px;padding:9px 12px;border-radius:8px;background:rgba(196,43,28,.12);color:#d24435;font-size:11.5px;line-height:1.5;word-break:break-all">일부 항목에 적용하지 못했습니다: ${esc(state.fileOpError)}</div>`
    : "";

  let body;
  if (isManage) {
    const selCount = state.selectedFilePaths.length;
    const addMenu =
      state.addToGroupMenuOpen && groups.length
        ? `<div style="position:absolute;right:0;top:36px;z-index:30;min-width:160px;max-height:230px;overflow-y:auto;background:var(--card);border:1px solid var(--line);border-radius:8px;box-shadow:0 12px 34px rgba(0,0,0,.2);padding:4px;display:flex;flex-direction:column;gap:1px">
            ${groups
              .map(
                (g) => `<div class="hov" data-act="add-to-group" data-id="${escAttr(g.id)}" style="display:flex;align-items:center;gap:8px;padding:8px 9px;border-radius:6px;cursor:pointer;font-size:12.5px;color:var(--text)">
                <span style="width:8px;height:8px;flex:none;border-radius:50%;background:${g.hidden ? "#d24435" : "var(--accent)"}"></span>
                <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(g.name)}</span>
              </div>`
              )
              .join("")}
          </div>`
        : "";
    const addBtn = groups.length
      ? `<div style="position:relative;flex:none">
          <div class="hov" data-act="add-menu" style="height:30px;padding:0 11px;border-radius:6px;border:1px solid var(--control-line);background:var(--control);font-size:12.5px;font-weight:500;color:var(--text);display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap">기존 그룹에 추가<span style="font-size:9px;color:var(--text3);transition:transform .15s;${state.addToGroupMenuOpen ? "transform:rotate(180deg)" : ""}">▾</span></div>
          ${addMenu}
        </div>`
      : "";
    const selBar = selCount
      ? `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin-top:14px;padding:9px 11px;border-radius:9px;background:var(--sel);border:1px solid var(--accent)">
          <span style="font-size:12.5px;font-weight:600;color:var(--accent);white-space:nowrap">${selCount}개 선택됨</span>
          <div style="flex:1"></div>
          ${addBtn}
          <input class="search" data-act="group-name" value="${escAttr(state.newGroupName)}" placeholder="새 그룹 이름" style="height:30px;width:110px;border-radius:6px;border:1px solid var(--control-line);background:var(--control);padding:0 10px;font-size:12px;color:var(--text)" />
          <div data-act="make-group" style="height:30px;padding:0 13px;border-radius:6px;background:var(--accent);color:var(--accent-text);font-size:12.5px;font-weight:600;display:flex;align-items:center;cursor:pointer;white-space:nowrap">새 그룹</div>
          <div class="hov" data-act="clear-filesel" style="height:30px;padding:0 8px;border-radius:6px;font-size:12px;color:var(--text2);display:flex;align-items:center;cursor:pointer">해제</div>
        </div>`
      : "";

    const groupsBlock = groups.length
      ? `<div style="margin-top:18px">
          <div style="font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text3);margin-bottom:8px">그룹</div>
          <div style="display:flex;flex-direction:column;gap:8px">${groups.map(groupCardHTML).join("")}</div>
        </div>`
      : "";

    body = `${selBar}${groupsBlock}
      <div style="margin-top:18px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <span style="font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text3)">파일</span>
          <span style="font-size:11px;color:var(--text3)">체크 → 그룹 · 눈 아이콘 → 개별 완전 숨김</span>
        </div>
        <div style="background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden">
          ${files.length ? files.map(manageFileRowHTML).join("") : `<div style="padding:28px;text-align:center;color:var(--text3);font-size:12px">폴더가 비어 있습니다</div>`}
        </div>
      </div>`;
  } else {
    const note =
      managedHidden > 0
        ? `완전 숨김으로 지정된 파일 ${managedHidden}개는 윈도우의 '숨김 파일 보기' 설정과 무관하게 완전히 숨겨집니다. 지금 보이는 목록이 실제 탐색기 모습입니다.`
        : `완전히 숨긴 파일이 없습니다. '관리' 탭에서 파일을 묶고 그룹을 완전 숨김으로 지정해 보세요.`;
    const rows = shown
      .map(
        (f, idx) => `<div style="display:flex;align-items:center;gap:11px;padding:9px 12px;${f.hidden ? "opacity:.6;" : ""}${idx > 0 ? "border-top:1px solid var(--line);" : ""}">
          ${fileIconHTML(f, 30)}
          <div style="min-width:0;flex:1">
            <div style="font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.name)}</div>
            <div style="font-size:10.5px;color:var(--text3);margin-top:1px">${esc(fmtSize(f))} · ${fmtDate(f.modified)}</div>
          </div>
          ${f.hidden ? `<span style="${TAG_NEUTRAL}">숨김</span>` : ""}
        </div>`
      )
      .join("");
    body = `<div style="display:flex;gap:7px;align-items:flex-start;margin-top:16px;margin-bottom:14px;padding:10px 12px;border-radius:8px;background:var(--sel);font-size:11.5px;color:var(--text2);line-height:1.5">
        <span style="flex:none;color:var(--accent)">ⓘ</span><span>${esc(note)}</span>
      </div>
      <div style="background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden">
        ${rows || `<div style="padding:28px;text-align:center;color:var(--text3);font-size:12px">표시할 파일이 없습니다</div>`}
      </div>`;
  }

  return `${open}
    <div style="padding:16px 18px 24px;display:flex;flex-direction:column">
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;padding-bottom:14px;border-bottom:1px solid var(--line)">
        <div style="min-width:0">
          <div style="font-size:16px;font-weight:600;display:flex;align-items:center;gap:9px">
            <span style="width:30px;height:30px;border-radius:8px;background:var(--sel);color:var(--accent);display:flex;align-items:center;justify-content:center">${folderSvg(17, "currentColor")}</span>
            ${esc(d.folder.name)}
          </div>
          <div style="font-size:11.5px;color:var(--text2);margin-top:6px">${esc(headerText)}</div>
        </div>
        <div class="hov" data-act="files-reload" title="목록 새로고침" style="width:30px;height:30px;flex:none;border-radius:5px;border:1px solid var(--control-line);background:var(--control);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text2);font-size:14px"><div style="display:inline-block;${state.filesLoading ? "animation:spin .55s linear" : ""}">⟳</div></div>
      </div>
      ${opError}
      <div style="display:flex;align-items:center;margin-top:16px">
        <div style="display:flex;gap:3px;background:var(--hover);border-radius:8px;padding:3px">
          <div data-act="view-manage" style="${viewTabBase}${isManage ? tabOn : tabOff}">관리</div>
          <div data-act="view-preview" style="${viewTabBase}${!isManage ? tabOn : tabOff}">탐색기 미리보기</div>
        </div>
      </div>
      ${body}
    </div>
  </div>`;
}

function render() {
  // Preserve scroll positions across the full re-render so toggling a property
  // doesn't snap the panes back to the top.
  const scrolls = {};
  for (const id of ["winlist", "rightpane", "filepane"]) {
    const el = document.getElementById(id);
    if (el) scrolls[id] = el.scrollTop;
  }

  const isWin = state.mode === "windows";
  const left = isWin ? leftHTML(filteredWindows()) : filesSidebarHTML();
  const right = isWin ? rightHTML() : filesRightHTML();
  card.innerHTML = titleBarHTML() + `<div style="flex:1;display:flex;min-height:0">${left}${right}</div>`;

  for (const id in scrolls) {
    const el = document.getElementById(id);
    if (el) el.scrollTop = scrolls[id];
  }
}

// ---------------------------------------------------------------------------
// Backend interaction
// ---------------------------------------------------------------------------

async function loadWindows() {
  try {
    const list = await invoke("list_windows");
    state.windows = Array.isArray(list) ? list : [];
    if (!state.windows.some((w) => w.hwnd === state.selectedId)) {
      state.selectedId = state.windows[0] ? state.windows[0].hwnd : null;
    }
  } catch (err) {
    console.error("list_windows failed:", err);
  }
  render();
}

async function applyToggle(key) {
  const w = getSel();
  if (!w) return;
  const nv = !w[key];
  w[key] = nv;
  if (key === "translucent" && nv && (!w.opacity || w.opacity >= 100)) w.opacity = 85;
  render();
  try {
    if (key === "alwaysOnTop") await invoke("set_always_on_top", { hwnd: w.hwnd, on: nv });
    else if (key === "hiddenFromTaskbar") await invoke("set_hidden_from_taskbar", { hwnd: w.hwnd, on: nv });
    else if (key === "titleHidden") await invoke("set_title_hidden", { hwnd: w.hwnd, on: nv });
    else if (key === "sizeLocked") await invoke("set_size_locked", { hwnd: w.hwnd, on: nv });
    else if (key === "overlay" || key === "translucent")
      await invoke("set_layered", {
        hwnd: w.hwnd,
        overlay: w.overlay,
        translucent: w.translucent,
        opacity: w.opacity,
      });
  } catch (err) {
    console.error(`apply ${key} failed:`, err);
    await loadWindows();
  }
}

async function applyGeom(w) {
  try {
    await invoke("set_geometry", { hwnd: w.hwnd, x: w.x, y: w.y, w: w.w, h: w.h });
  } catch (err) {
    console.error("set_geometry failed:", err);
  }
}

async function applyAlias(value) {
  const w = getSel();
  if (!w) return;
  const v = String(value).trim();
  if ((w.alias || "") === v) return; // unchanged — skip the round-trip
  w.alias = v || null;
  render();
  try {
    await invoke("set_alias", { hwnd: w.hwnd, alias: v });
  } catch (err) {
    console.error("set_alias failed:", err);
    await loadWindows();
  }
}

async function bumpGeom(key, d) {
  const w = getSel();
  if (!w) return;
  w[key] = Math.max(0, (Number(w[key]) || 0) + d);
  render();
  await applyGeom(w);
}

let opTimer = null;
function queueLayered(w) {
  clearTimeout(opTimer);
  opTimer = setTimeout(() => {
    invoke("set_layered", {
      hwnd: w.hwnd,
      overlay: w.overlay,
      translucent: w.translucent,
      opacity: w.opacity,
    }).catch((err) => console.error("set_layered failed:", err));
  }, 40);
}

// Bring a window to the front once (a one-shot raise + focus, not a permanent topmost).
async function bringToFront(id) {
  try {
    await invoke("bring_to_front", { hwnd: id });
  } catch (err) {
    console.error("bring_to_front failed:", err);
  }
}

async function doRefresh() {
  state.refreshing = true;
  render();
  await loadWindows();
  setTimeout(() => {
    state.refreshing = false;
    render();
  }, 450);
}

// ---------------------------------------------------------------------------
// 파일 탭 — 백엔드 연동
// ---------------------------------------------------------------------------

async function loadFolders() {
  try {
    const list = await invoke("list_folders");
    state.folders = Array.isArray(list) ? list : [];
    if (!state.folders.some((f) => f.id === state.currentFolderId)) {
      state.currentFolderId = state.folders[0] ? state.folders[0].id : null;
    }
  } catch (err) {
    console.error("list_folders failed:", err);
    state.filesError = String(err);
  }
}

async function loadFiles() {
  if (!state.currentFolderId) return;
  state.filesLoading = true;
  state.filesError = null;
  render();
  try {
    const d = await invoke("list_files", { folderId: state.currentFolderId });
    state.filesData = d;
    // 사라진 파일이 선택 목록에 남지 않도록 정리.
    const live = new Set((d.files || []).map((f) => f.path));
    state.selectedFilePaths = state.selectedFilePaths.filter((p) => live.has(p));
  } catch (err) {
    console.error("list_files failed:", err);
    state.filesError = String(err);
    state.filesData = null;
  }
  state.filesLoading = false;
  render();
}

// 파일 조작 커맨드 하나를 실행하고 목록을 다시 읽는다. 실패는 배너로 알린다.
async function fileOp(cmd, args) {
  state.fileOpError = null;
  try {
    await invoke(cmd, args);
  } catch (err) {
    console.error(`${cmd} failed:`, err);
    state.fileOpError = String(err);
  }
  await loadFiles();
}

async function openFilesTab() {
  state.mode = "files";
  render();
  if (!state.folders.length) await loadFolders();
  if (state.filesData) render();
  else await loadFiles();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function wireEvents() {
  card.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-act]");
    const act = t ? t.dataset.act : null;

    // 폴더 드롭다운은 메뉴 밖 아무 곳이나 클릭하면 닫힌다.
    if (state.folderMenuOpen && act !== "folder-menu" && act !== "folder-pick") {
      state.folderMenuOpen = false;
      render();
      if (!t) return;
    }
    // "기존 그룹에 추가" 드롭다운도 밖을 클릭하면 닫힌다.
    if (state.addToGroupMenuOpen && act !== "add-menu" && act !== "add-to-group") {
      state.addToGroupMenuOpen = false;
      render();
      if (!t) return;
    }
    if (!t) return;
    switch (act) {
      case "tab-win":
        state.mode = "windows";
        render();
        break;
      case "tab-files":
        await openFilesTab();
        break;
      case "folder-menu":
        state.folderMenuOpen = !state.folderMenuOpen;
        render();
        break;
      case "folder-pick": {
        const id = t.dataset.id;
        state.folderMenuOpen = false;
        if (id !== state.currentFolderId) {
          state.currentFolderId = id;
          state.filesData = null;
          state.selectedFilePaths = [];
          state.newGroupName = "";
          state.expandedGroupId = null;
          state.addToGroupMenuOpen = false;
          state.fileOpError = null;
          await loadFiles();
        } else {
          render();
        }
        break;
      }
      case "view-manage":
        state.fileView = "manage";
        render();
        break;
      case "view-preview":
        state.fileView = "preview";
        render();
        break;
      case "files-reload":
        await loadFiles();
        break;
      case "file-check": {
        const p = t.dataset.path;
        const i = state.selectedFilePaths.indexOf(p);
        if (i >= 0) state.selectedFilePaths.splice(i, 1);
        else state.selectedFilePaths.push(p);
        render();
        break;
      }
      case "clear-filesel":
        state.selectedFilePaths = [];
        render();
        break;
      case "make-group": {
        if (!state.selectedFilePaths.length || !state.currentFolderId) break;
        const paths = state.selectedFilePaths.slice();
        const name = state.newGroupName;
        state.selectedFilePaths = [];
        state.newGroupName = "";
        await fileOp("group_files", { folderId: state.currentFolderId, name, paths });
        break;
      }
      case "add-menu":
        state.addToGroupMenuOpen = !state.addToGroupMenuOpen;
        render();
        break;
      case "add-to-group": {
        const id = t.dataset.id;
        state.addToGroupMenuOpen = false;
        if (!state.selectedFilePaths.length) {
          render();
          break;
        }
        const paths = state.selectedFilePaths.slice();
        state.selectedFilePaths = [];
        state.expandedGroupId = id; // 추가 결과를 바로 보여준다
        await fileOp("add_to_group", { groupId: id, paths });
        break;
      }
      case "file-hide": {
        const p = t.dataset.path;
        const f = ((state.filesData && state.filesData.files) || []).find((x) => x.path === p);
        if (!f) break;
        const g = f.groupId ? groupById(f.groupId) : null;
        if (g && g.hidden) break; // 그룹 숨김이 우선 — 개별 토글은 비활성
        await fileOp("set_file_hidden", { path: p, hidden: !f.fullyHidden });
        break;
      }
      case "group-expand": {
        const id = t.dataset.id;
        state.expandedGroupId = state.expandedGroupId === id ? null : id;
        render();
        break;
      }
      case "group-hide": {
        const g = groupById(t.dataset.id);
        if (!g) break;
        await fileOp("set_group_hidden", { groupId: g.id, hidden: !g.hidden });
        break;
      }
      case "group-ungroup":
        await fileOp("ungroup_files", { groupId: t.dataset.id });
        break;
      case "member-remove":
        await fileOp("remove_from_group", { path: t.dataset.path });
        break;
      case "select":
        state.selectedId = Number(t.dataset.id);
        render();
        break;
      case "theme":
        state.theme = state.theme === "light" ? "dark" : "light";
        applyVars();
        render();
        break;
      case "refresh":
        await doRefresh();
        break;
      case "win-min":
        appWindow.minimize();
        break;
      case "win-max":
        appWindow.toggleMaximize();
        break;
      case "win-close":
        appWindow.close();
        break;
      case "toggle":
        await applyToggle(t.dataset.key);
        break;
      case "geom-inc":
        await bumpGeom(t.dataset.key, 10);
        break;
      case "geom-dec":
        await bumpGeom(t.dataset.key, -10);
        break;
      case "alias-reset":
        await applyAlias("");
        break;
      case "bring-front": {
        const w = getSel();
        if (w) bringToFront(w.hwnd);
        break;
      }
    }
  });

  card.addEventListener("keydown", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    // 그룹 이름 입력에서 Enter → 바로 그룹으로 묶기.
    if (t.dataset.act === "group-name" && e.key === "Enter") {
      state.newGroupName = t.value;
      const btn = card.querySelector('[data-act="make-group"]');
      if (btn) btn.click();
    }
  });

  card.addEventListener("input", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    if (t.dataset.act === "group-name") {
      state.newGroupName = t.value; // 리렌더 없이 상태만 갱신 (포커스 유지)
    } else if (t.dataset.act === "search") {
      state.query = t.value;
      const list = filteredWindows();
      const wl = document.getElementById("winlist");
      if (wl) wl.innerHTML = listHTML(list);
      const wc = document.getElementById("wincount");
      if (wc) wc.textContent = `${list.length}개`;
    } else if (t.dataset.act === "opacity") {
      const w = getSel();
      if (!w) return;
      w.opacity = Number(t.value);
      const ov = document.getElementById("opval");
      if (ov) ov.textContent = `${w.opacity}%`;
      queueLayered(w);
    }
  });

  card.addEventListener("change", async (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    if (t.dataset.act === "geom") {
      const w = getSel();
      if (!w) return;
      const v = parseInt(String(t.value).replace(/[^0-9-]/g, ""), 10);
      w[t.dataset.key] = isNaN(v) ? 0 : v;
      await applyGeom(w);
      render();
    } else if (t.dataset.act === "alias") {
      await applyAlias(t.value); // commit on blur / Enter
    } else if (t.dataset.act === "opacity") {
      render(); // sync the "반투명 X%" badge once the drag ends
    }
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  card = document.getElementById("card");
  applyVars();
  wireEvents();
  render();
  loadWindows();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
