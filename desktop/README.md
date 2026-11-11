# 내 플래너

일정(캘린더) · 할 일 · 목표를 한 곳에서 관리하는 Windows 데스크톱 앱입니다. Electron + 순수 JavaScript(프레임워크 없음)로 만들었습니다.

## 현재 상태와 작업 범위

- 기존 `main.js`, `preload.js`, `store.js`, `renderer/`의 앱 기능은 유지합니다. 이 작업에서는 패키징·검사·배포 설정을 추가했습니다.
- `package-lock.json`과 NSIS 설정, 저장소 루트의 `.github/workflows/desktop.yml`을 사용합니다. 도구 버전은 Electron **45.3.0**, electron-builder **26.18.0**, Playwright **1.58.2**로 고정했습니다.
- **코드 서명은 없습니다. 자동 업데이트는 0.1.1 후보에 추가했으며 Windows 설치·갱신 검증은 대기 중입니다.** 이 배포는 Windows 10/11 **64비트 테스트 버전**입니다.
- Windows CI에서 원본 테스트 5개, NSIS 빌드·설치, 실제 설치 앱의 자동 검사 7개 그룹을 통과했고 `v0.1.0` Release를 공개했습니다. OS의 실제 알림·트레이 표시, 로그인·로그오프, 실제 클라우드 폴더 동기화는 사용자 PC에서 추가 확인해야 합니다. 근거는 [검증 기록](VERIFICATION.md)에 구분했습니다.

현재 브랜치의 소스 버전은 **0.1.1 후보**이며 공개 Release는 **v0.1.0**입니다. 코드 준비와 배포는 구분합니다.

이번 전체 감사 결과와 수정·미확인 항목은 [2026-11-11 전체 감사](../AUDIT-2026-11-11.md)에 기록했습니다. 최신 소스의 Windows 검사 결과와 과거 0.1.0의 통과 기록은 구분합니다.

## 개발 실행

필요한 것: Windows 10/11 64비트, Node.js 22.12 이상(22 LTS 권장). 아래 명령은 이 `desktop/` 폴더에서 실행합니다.

```bash
npm ci         # 커밋된 package-lock.json과 같은 의존성 설치
npm test       # 원본 5개 + 업데이트 2개 + 실행 안전성 1개 검사
npm start      # electron . 으로 실제 앱 실행
```

처음 잠금 파일을 만들거나 의존성을 변경할 때는 `npm install`을 사용하고 변경된 `package-lock.json`을 함께 커밋합니다. CI에서는 잠금 파일을 재생성하지 않고 `npm ci`를 사용합니다.

- `npm start -- --hidden`은 창 없이 트레이로 시작하는 실행 경로입니다.
- `renderer/index.html`을 일반 브라우저로 열면 저장소가 `localStorage`로 대체됩니다. 브라우저 화면 검사만으로 PC의 파일 저장·트레이·알림·자동 백업·종료 전 저장을 검증했다고 판단하지 않습니다.
- `setup.bat`, `make-shortcut.ps1`은 예전 개발용 바로가기 스크립트입니다. 배포용 설치 파일은 아래 `npm run dist:win`으로 만듭니다.

## 테스트

```bash
npm test                 # Node 테스트 8개 파일, Electron 실행 불필요
npm run test:desktop     # 실제 Electron 창과 저장 경로 자동 검사
npm run test:renderer    # 실제 HTML/CSP 화면 회귀 검사(Chromium 필요)
npm run dist:win         # Windows NSIS 설치 파일 제작
npm run test:package     # 패키지의 코드·아이콘·preload 경로와 불필요한 파일 검사
```

원본 단위 테스트 파일은 모두 유지합니다. 업데이트 상태·저장/백업 차단 검사(`test/updater.test.js`)와 실제 라이브러리의 로컬 다운로드·해시 검사(`test/updater-download.test.js`)를 추가했습니다. [업데이트 설계와 검증 범위](docs/auto-update.md)를 참고하세요.

| 파일                      | 검사 내용                                              |
| ------------------------- | ------------------------------------------------------ |
| `test/recurrence.test.js` | 반복 일정 전개                                         |
| `test/holidays.test.js`   | 한국 공휴일·대체공휴일                                 |
| `test/quickadd.test.js`   | 빠른 입력(한국어 문장 해석)                            |
| `test/store.test.js`      | 저장·원자적 쓰기·백업·복구·동기화 폴더                 |
| `test/main.mock.test.js`  | 가짜 Electron 모듈로 main의 트레이·알림·종료 흐름 검사 |

`test/main.mock.test.js`의 가짜 Electron 검사와 실제 Electron 실행 검사는 서로 구분합니다. `tools/desktop-smoke.cjs`는 실제 앱을 실행하며, 설치된 프로그램을 검사할 때는 `PLANNER_EXECUTABLE`에 설치 경로를 전달합니다. 결과·오류·스크린샷은 `test-results/`에 기록하고, CI에서 `my-planner-windows` 아티팩트로 보관합니다. 실패한 검사가 있으면 설치 파일을 Release로 공개하지 않습니다.

### 브라우저 화면 테스트

Playwright는 개발 의존성에 포함되어 있습니다. 화면 검사를 별도로 실행하려면 Chromium을 준비합니다.

```bash
npx playwright install chromium
node tools/browser-tests/build-preview.js
node tools/browser-tests/smoke2.js
node tools/browser-tests/smoke3.js
node tools/browser-tests/smoke4.js
node tools/browser-tests/audit.js
node tools/browser-tests/audit2.js
node tools/browser-tests/audit3.js
```

- 생성된 단일 HTML은 `tools/browser-tests/preview/`, 스크린샷은 `tools/browser-tests/out/`에 저장됩니다.
- 이 도구들은 예시 데이터가 포함된 브라우저 미리보기와 일부 가짜 저장소를 검사합니다. 실제 앱은 CSP가 적용된 `renderer/index.html`을 로드하므로 실제 Electron 검사도 필요합니다.
- `tools/browser-tests/preview-seed.js`는 가짜 예시 데이터입니다. 패키지 파일 목록에서 `tools/`, `test/`, `test-results/`를 제외하므로 이 파일과 검사 데이터가 설치 앱에 들어가지 않습니다.

## Windows 설치 파일 만들기

Windows에서 다음 명령을 실행합니다.

```bash
npm ci
npm test
npm run test:desktop
npm run dist:win
npm run test:package
```

- 결과 파일은 `dist/MyPlanner-Setup.exe`입니다. NSIS 방식이며 설치 위치를 고를 수 있습니다. 바탕화면·시작 메뉴 이름은 ‘내 플래너’, 실행 파일은 `MyPlanner.exe`입니다.
- `build.appId`는 main의 `app.setAppUserModelId`와 같은 **`com.myplanner.app`**입니다.
- `productName`은 **`my-planner`**로 유지합니다. 개발 실행과 설치 앱의 사용자 데이터 폴더 이름이 달라지지 않도록 한 설정입니다.
- 포함 목록: `main.js`, `preload.js`, `store.js`, `updater.js`, 운영 의존성(`electron-updater` 포함), `renderer/**`, `assets/**`, `package.json`. main이 직접 불러오는 `renderer/recurrence.js`도 포함됩니다.
- 설치 아이콘은 `assets/icon.ico`, 창·트레이 아이콘은 `assets/icon.png`입니다. 패키지 검사와 설치 후 실행 검사에서 경로를 확인합니다.
- 제거 시 사용자 데이터를 자동으로 삭제하지 않도록 `deleteAppDataOnUninstall: false`를 사용합니다.
- 코드 서명이 없으므로 SmartScreen에 ‘Windows의 PC 보호’와 ‘알 수 없는 게시자’가 표시될 수 있습니다. 배포한 `MyPlanner-Setup.exe`인지 출처를 확인하고 신뢰하는 경우에만 ‘추가 정보 → 실행’을 선택합니다. 보안 기능을 끄는 설정은 필요하지 않습니다.

### GitHub Actions와 Release

저장소 루트 `.github/workflows/desktop.yml`은 `windows-latest`에서 아래 순서로 실행하도록 구성합니다.

1. 잠금 파일로 설치(`npm ci`) 후 원본 5개·업데이트 2개·실행 안전성 1개 검사
2. 실제 Electron 실행 검사(`tools/desktop-smoke.cjs`)
3. NSIS 설치 파일 빌드 후 패키지 파일 검사(`tools/check-package.cjs`)
4. NSIS 무인 설치 후 설치된 `MyPlanner.exe` 실행 검사
5. CI 전용 다음 패치 버전을 빌드하여 실제 설치 앱의 다운로드·저장 실패 차단·갱신·재실행·데이터 보존 검사. 검사 후 원래 버전의 설치 파일을 복원하고 다시 검사
6. 설치 파일의 SHA-256 생성, 결과와 스크린샷을 아티팩트로 보관
7. 앞 단계가 성공한 **버전 태그 실행에서만** GitHub Releases에 설치 파일·체크섬·`latest.yml`·blockmap(생성 시)·검사 기록 공개. 다음 패치 테스트용 파일은 공개하지 않음

`main` 브랜치 변경과 수동 실행은 검사 및 아티팩트 제작용입니다. 공개는 `desktop/package.json` 버전과 일치하는 `v0.1.0` 같은 태그를 푸시할 때만 진행합니다. 예를 들어 버전이 `0.1.0`일 때:

```bash
git tag v0.1.0
git push origin v0.1.0
```

설치 파일 이름은 버전이 바뀌어도 `MyPlanner-Setup.exe`로 고정합니다. 공개 Release를 최신으로 지정하면 홈페이지에서 사용하는 주소를 유지할 수 있습니다.

```text
https://github.com/psho0324/-/releases/latest/download/MyPlanner-Setup.exe
```

홈페이지의 `config.js` → `desktopReleases.calendar.ready`는 실제 Release의 설치 파일이 준비되고 검사 결과를 확인한 뒤에만 켭니다. 그전에는 설치 파일 준비 중 상태를 유지합니다. 관리자에서 별도 다운로드 주소를 지정한 경우에는 그 설정을 우선합니다.

### 검증 상태 기록

아래는 실제 실행 결과입니다. 자동 검사로 확인한 범위와 사용자 PC에서 남은 수동 확인을 구분합니다.

| 범위                                    | 현재 상태                                           | 근거                                                                                                                                                                                                                                   |
| --------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 원본 Node 테스트 5개                    | Linux·Windows 통과                                  | [Windows 실행 42577451935](https://github.com/psho0324/-/actions/runs/42577451935)                                                                                                                                                     |
| Windows 개발 실행·실제 Electron 검사    | 통과                                                | [Windows 실행 42577451935](https://github.com/psho0324/-/actions/runs/42577451935)                                                                                                                                                     |
| Windows NSIS 빌드·패키지 검사·무인 설치 | 설치 앱 실행까지 통과                               | 같은 실행의 `my-planner-windows` 아티팩트                                                                                                                                                                                              |
| 설치 앱의 9개 수동 확인 항목            | 자동 검사는 일부 통과, OS·클라우드 수동 확인은 남음 | [상세 검증 기록](VERIFICATION.md)과 아래 확인 목록                                                                                                                                                                                     |
| 공개 Release·다운로드 주소              | v0.1.0 공개 및 설치 앱 결과 파일 확인               | [Release](https://github.com/psho0324/-/releases/tag/v0.1.0), [태그 실행 42577948676](https://github.com/psho0324/-/actions/runs/42577948676), [installed.json](https://github.com/psho0324/-/releases/download/v0.1.0/installed.json) |

## 기능

- **캘린더**: 월/주/일 보기, 일정 추가·수정·삭제(제목, 종일, 시작/종료, 색, 메모, 알림), 반복(매일/매주/매월/매년, 간격, 종료일, "이 회차만 삭제"), 일정 끌어서 이동(월/주/일), 한국 공휴일·대체공휴일 표시(2024~2035, 임시공휴일은 수동 표)
- **할 일**: 마감일·우선순위·완료 체크, 필터, 밀린 할 일 탭(오늘로/내일로/날짜 선택/삭제/모두 오늘로), 오늘 일정도 "오늘 할 일"로 체크
- **목표(프로젝트)**: 할 일 묶음, 진행률, 기한
- **카테고리/필터**: 일정·할 일 공통
- **홈**: 작은 달력, 오늘 할 일 완료율 원, 오늘 일정, 밀린 할 일, 목표 진행
- **통계**: 일별 완료, 카테고리별 일정 시간, 목표 진행, 연속 달성 (이름 두 가지 기준 주의: "끝낸 일"은 체크한 날 기준, "기한 달성률"은 기한 기준)
- **빠른 입력**: 한 줄 문장으로 일정/할 일 생성(예: `내일 오후 3시 치과 #개인`)
- **삭제 실행 취소**(토스트 + Ctrl+Z), **저장 상태 표시**(저장 실패 시 경고 + 자동/수동 재시도)
- **설정**: 주 시작 요일, 알림 켜기/끄기, 카테고리 추가, 백업 내보내기/가져오기(가져온 데이터는 검증·정리 후 반영), 계속 실행/자동 시작, 저장 위치(동기화 폴더)
- **반응형**: 좁은 화면(≤760px)에서 하단 탭 바, 접히는 검색·카테고리, 월간 달력은 점 + 선택한 날 일정 목록
- **다크 모드**: 시스템 설정을 따름

### 데스크톱(Electron) 전용 기능의 구현 위치

| 기능                                                                             | 코드 위치                                                                                                                |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 시스템 트레이, X 버튼 → 트레이로 숨김, "계속 실행" 설정                          | `main.js` (`createTray`, `win.on('close')`)                                                                              |
| 단일 실행(두 번째 실행 시 기존 창을 앞으로)                                      | `main.js` (`requestSingleInstanceLock`, `second-instance`)                                                               |
| 윈도우 시작 시 자동 실행(`--hidden`)                                             | `main.js` (`applyAutoStart`)                                                                                             |
| 일정 알림(30초마다 확인, 앱/트레이 실행 중에만)                                  | `main.js` (`checkReminders`)                                                                                             |
| 자동 백업(하루 1번, 최근 20개 보관, 복원, 손상 파일 자동 복구)                   | `store.js`                                                                                                               |
| 저장 폴더 변경 / 동기화 폴더(OneDrive·Google Drive 등), 2.5초마다 외부 변경 확인 | `store.js`, `main.js`, 설정 화면                                                                                         |
| 종료·창 닫기 전 저장 확인(저장 실패 시 안내창), 윈도우 종료/로그오프 처리        | `main.js` (`flushRenderer`, `confirmQuit`, `before-quit`), `preload.js`(`onFlushRequest`), `renderer/app.js`(`flushAll`) |
| 안전한 IPC 노출                                                                  | `preload.js` (`contextBridge` → `window.storage`)                                                                        |

## 구조

| 경로                                           | 역할                                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `main.js`                                      | 창·트레이·알림 스케줄러·자동 시작·IPC·종료 전 저장 확인                                                                                   |
| `preload.js`                                   | 화면에 `window.storage`(저장/불러오기/백업/동기화/종료 전 저장 요청) 노출                                                                 |
| `store.js`                                     | 파일 저장(원자적 쓰기), 일일 백업, 손상 복구, 저장 폴더 설정(`planner-config.json`), 외부 변경 감지. Electron 비의존이라 단독 테스트 가능 |
| `renderer/index.html`                          | 화면 뼈대 (CSP: `default-src 'self'`)                                                                                                     |
| `renderer/app.js`                              | 화면 전체 로직(IIFE 하나, 약 2,500줄)                                                                                                     |
| `renderer/styles.css`                          | 스타일(라이트/다크 토큰, 반응형)                                                                                                          |
| `renderer/recurrence.js`                       | 반복 일정 전개 (`main.js`와 화면이 공용)                                                                                                  |
| `renderer/holidays.js`, `renderer/quickadd.js` | 공휴일 계산 / 빠른 입력 해석 (UMD, Node 테스트 가능)                                                                                      |
| `renderer/storage.js`                          | 저장소 어댑터: Electron(`window.storage`) 또는 브라우저 `localStorage`                                                                    |
| `assets/`                                      | 앱 아이콘 (`tools/make_icon.py`로 생성, Pillow 필요)                                                                                      |
| `test/`                                        | Node 단위 테스트                                                                                                                          |
| `tools/browser-tests/`                         | Playwright 화면 테스트와 미리보기 빌더                                                                                                    |
| `tools/desktop-smoke.cjs`                      | 실제 Electron과 설치 앱 자동 검사                                                                                                         |
| `tools/check-package.cjs`                      | 패키지 파일·경로 검사                                                                                                                     |
| `package-lock.json`                            | 의존성 버전 고정                                                                                                                          |
| `../.github/workflows/desktop.yml`             | Windows 검사·NSIS 빌드·태그 Release                                                                                                       |

## 데이터

- 데이터 파일 `planner-data.json`은 Electron `userData` 폴더에 저장됩니다(Windows에서는 보통 `%APPDATA%\my-planner`, `productName`도 같은 이름으로 유지함). 백업은 같은 폴더의 `backups/`(항상 이 PC 안), 저장 위치 설정은 `planner-config.json`입니다.
- 저장 폴더를 동기화 폴더로 바꾸면 `planner-data.json`만 그 폴더로 이동하고, 백업은 이 PC에 남습니다.
- 개인 일정 데이터는 이 ZIP에 포함되어 있지 않습니다.

## 구현하지 않았거나 확인하지 못한 것

**구현되지 않음**

- 코드 서명
- 자동 업데이트의 Windows 설치 앱 실증: 구현은 0.1.1 후보에 포함했지만 아직 통과 결과가 없습니다. 공개된 0.1.0에는 업데이트 기능이 없으므로 0.1.1은 한 번 직접 설치해야 합니다.
- 두 PC에서 동시에 수정했을 때의 병합 — 현재는 **나중에 저장한 쪽이 이김**(덮이기 직전 내용은 `backups/`에 남김)
- 임시공휴일 자동 반영 — `renderer/holidays.js`의 표에 직접 추가해야 함
- 반복 일정의 "이 회차만 수정", 일정 크기 조절(드래그로 길이 변경) — 구현하지 않음(이전 README 기준, 이번 정리에서 다시 확인하지는 않음)
- 모바일 주간/일간 보기의 전용 레이아웃(PC 구성 그대로) — 모바일은 웹 미리보기용 반응형일 뿐 모바일 앱이 아님
- 서버/계정 기반 동기화

**설치 앱(Windows)에서 직접 확인해야 하는 것**

아래 9개 항목은 Windows 사용자 PC에서의 수동 확인 목록입니다. 자동 검사가 일부 흐름을 확인하더라도 OS 화면 표시·로그인·로그오프·실제 클라우드 폴더 검증까지 통과한 것으로 확대하지 않습니다. 실패하면 앱 버전, Windows 버전, 재현 순서, 실제 오류 문구와 스크린샷을 기록합니다. 개인 일정 대신 테스트용 가짜 데이터를 사용하고 결과를 공개하기 전 개인 정보 포함 여부를 확인합니다.

1. 트레이 아이콘 생성·표시, X 버튼 → 트레이로 숨김, 트레이 "열기/종료"
2. 일정 알림이 제시간에 뜨는지, 알림 클릭 시 창이 열리는지, `AppUserModelId` 설정에 따른 알림 표시
3. 윈도우 시작 시 자동 실행(`--hidden`으로 창 없이 시작) 및 설정 화면 토글과의 연동
4. 이미 실행 중일 때 다시 실행하면 창이 하나만 유지되는지
5. **종료 전 저장**: 할 일을 추가한 직후 트레이 "종료"를 눌러도 다시 켰을 때 남아 있는지, 저장 위치를 읽기 전용 폴더로 바꿨을 때 종료 시 "저장 실패" 안내창이 뜨는지, 윈도우 종료/로그오프 중 동작
6. 자동 백업(실제 `userData` 폴더), 백업 복원
7. 동기화 폴더(실제 OneDrive/Google Drive 폴더), 다른 PC에서 바뀐 내용 반영, 폴더가 사라졌다 돌아오는 경우
8. 패키징 후 아이콘 경로(`assets/icon.png`)와 `preload.js` 경로가 올바르게 동작하는지
9. 저장 실패 표시가 실제 IPC 오류(파일 쓰기 실패)에서도 뜨는지 — 실제 Electron 저장 경로의 실패와 종료 안내창을 사용자 PC에서도 확인
