// 창 관리자 (WinTamer) — frontend. Ports 창 관리자.dc.html to plain JS and wires it
// to the Rust/Win32 backend through Tauri's invoke + window controls.

const TAURI = window.__TAURI__ || {};
const invoke = TAURI.core ? TAURI.core.invoke : async () => { throw new Error("Tauri runtime not available"); };
const appWindow = TAURI.window
  ? TAURI.window.getCurrentWindow()
  : { minimize() {}, toggleMaximize() {}, close() {} };

const state = {
  theme: "light",
  query: "",
  selectedId: null,
  windows: [],
  refreshing: false,
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

function geomField(w, key, label, locked) {
  const box = `display:flex;align-items:center;border-radius:6px;border:1px solid var(--control-line);background:var(--control);overflow:hidden;${locked ? "opacity:.45;pointer-events:none" : ""}`;
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
      return `<div class="row" data-act="select" data-id="${w.hwnd}" style="${rowStyle}">
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

function leftHTML(list) {
  return `<div style="width:250px;flex:none;display:flex;flex-direction:column;background:var(--pane);border-right:1px solid var(--line);min-height:0">
    <div style="padding:11px 12px 8px;display:flex;flex-direction:column;gap:9px">
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
      const locked = (k === "w" || k === "h") && sel.sizeLocked;
      return geomField(sel, k, label, locked);
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
      </div>

      <div style="font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text3);margin:16px 0 8px">표시 이름</div>
      <div style="background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px">
        <div style="display:flex;align-items:center;gap:8px">
          <input data-act="alias" value="${escAttr(sel.alias || "")}" placeholder="${escAttr(sel.title)}" maxlength="120" style="flex:1;min-width:0;height:30px;border-radius:6px;border:1px solid var(--control-line);background:var(--control);color:var(--text);font-size:13px;padding:0 10px" />
          ${sel.alias ? `<div class="hov" data-act="alias-reset" title="원래 제목으로 되돌리기" style="width:30px;height:30px;flex:none;border-radius:6px;border:1px solid var(--control-line);background:var(--control);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text2);font-size:15px">↺</div>` : ""}
        </div>
        <div style="font-size:11px;color:var(--text2);margin-top:7px">목록에 표시할 이름입니다. 비워두면 원래 제목(<span style="color:var(--text3)">${esc(sel.title)}</span>)을 사용합니다.</div>
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

function render() {
  const list = filteredWindows();

  // Preserve scroll positions across the full re-render so toggling a property
  // doesn't snap the panes back to the top.
  const prevList = document.getElementById("winlist");
  const prevRight = document.getElementById("rightpane");
  const listScroll = prevList ? prevList.scrollTop : 0;
  const rightScroll = prevRight ? prevRight.scrollTop : 0;

  card.innerHTML =
    titleBarHTML() +
    `<div style="flex:1;display:flex;min-height:0">${leftHTML(list)}${rightHTML()}</div>`;

  const newList = document.getElementById("winlist");
  if (newList) newList.scrollTop = listScroll;
  const newRight = document.getElementById("rightpane");
  if (newRight) newRight.scrollTop = rightScroll;
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
  if ((key === "w" || key === "h") && w.sizeLocked) return;
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
// Events
// ---------------------------------------------------------------------------

function wireEvents() {
  card.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    switch (act) {
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
    }
  });

  card.addEventListener("input", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    if (t.dataset.act === "search") {
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
