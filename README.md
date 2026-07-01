# 창 관리자 (WinTamer)

`창 관리자.dc.html` 디자인을 그대로 구현한 **Windows 전용 창 관리 도구**입니다.
프레임리스 + 반투명 커스텀 UI(디자인 1:1 포팅)와, 실제 Win32 API로 다른 앱의
최상위 창을 열거·조작하는 Rust 백엔드로 구성된 **Tauri 2.0** 데스크톱 앱입니다.

## 기능

좌측에서 실행 중인 창을 선택하고, 우측에서 다음을 토글/조정합니다.

| UI 항목 | 실제 동작 (Win32) |
|---|---|
| 항상 위로 | `SetWindowPos(HWND_TOPMOST / HWND_NOTOPMOST)` |
| 작업 표시줄에서 숨기기 | `WS_EX_TOOLWINDOW` on/off (hide→restyle→show) |
| 오버레이 모드 | `WS_EX_LAYERED \| WS_EX_TRANSPARENT \| WS_EX_NOACTIVATE` (클릭 통과 + 포커스 비탈취) |
| 상단 타이틀 숨김 | `WS_CAPTION` 제거 + `SWP_FRAMECHANGED` |
| 반투명 모드 / 투명도 | `WS_EX_LAYERED` + `SetLayeredWindowAttributes(LWA_ALPHA)` |
| 크기 고정 | `WS_THICKFRAME` 제거 (이동만 허용) |
| 위치 X/Y · 너비/높이 | `SetWindowPos` |
| 창 이름 변경 | `SetWindowTextW` — 실제 창의 타이틀바·작업 표시줄에 반영 (비우면 원래 제목 복원) |
| 맨 앞으로 (상세화면 버튼) | `BringWindowToTop` + `SetForegroundWindow` — 해당 창을 맨 앞으로 1회 (항상 위로는 무시 안 함) |

검색·새로고침·라이트/다크 테마는 프런트엔드에서 처리합니다.

## 요구 사항

- Windows 10/11, WebView2 런타임 (Win11 기본 포함)
- Node.js, Rust toolchain (`cargo`)

## 개발 / 빌드

```bash
npm install            # @tauri-apps/cli 설치
npm run icon           # (선택) 아이콘 재생성
npm run dev            # 개발 실행 (핫리로드)
npm run build          # 릴리스 빌드 + NSIS 인스톤러
```

## 구조

```
src/                 프런트엔드 (정적, 번들러 없음 — withGlobalTauri 사용)
  index.html         디자인 head 스타일 + #card 마운트
  main.js            창 관리자.dc.html 로직 포팅 + Tauri invoke 연동
src-tauri/
  src/main.rs        Tauri 부트스트랩 + 커맨드 등록
  src/win.rs         windows-rs 기반 창 열거/조작 로직
  tauri.conf.json    프레임리스 744×544 투명 창
  capabilities/      자체 창 제어 권한
```

## 주의

다른 프로세스의 창 스타일을 바꾸는 도구이므로, 일부 앱(특히 자체 프레임을
그리는 Electron 계열)은 `상단 타이틀 숨김`/`크기 고정` 토글이 시각적으로
어색하게 보일 수 있습니다. 모든 토글은 가역적이며 `새로고침`으로 실제 상태를
다시 읽어옵니다. 좌측 목록의 토글 상태는 창의 **실제 Win32 스타일**을 반영합니다.
