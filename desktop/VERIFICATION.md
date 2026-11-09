# 내 플래너 PC 설치 버전 검증 기록

작성 기준: 2026-11-09, 버전 `0.1.0`. 검사에는 별도의 임시 사용자 폴더와 가짜 할 일만 사용했습니다.

## 변경 범위와 확정된 결과

- 앱 실행 코드 3개(`main.js`, `preload.js`, `store.js`)와 `renderer/`의 7개 파일은 전달받은 ZIP과 바이트 단위로 같습니다. 앱 기능은 수정하지 않았습니다.
- 원본 Node 테스트 **5개 파일**을 실행해 통과했습니다.
- Linux의 **실제 Electron**에서 자동 검사 **7개 그룹**이 통과했습니다. 가짜 Electron 검사와 구분하며, Windows 설치 앱 결과로 확대하지 않습니다.
- Linux 결과: 로컬 `test-results/linux.json`, 상세 기록 `test-results/linux/report.json`, 전체 stderr `test-results/linux/stderr.log`.
- Windows 재검사: [실행 42577451935](https://github.com/psho0324/-/actions/runs/42577451935)가 **성공**했습니다(2분 27초). 원본 테스트 5개, 실제 Electron 개발 실행, NSIS 빌드, ASAR 검사, 무인 설치, 설치된 앱의 실제 Electron 검사가 모두 통과했습니다.
- 태그 `v0.1.0`의 [Release 실행 42577948676](https://github.com/psho0324/-/actions/runs/42577948676)도 **성공**했습니다(2분 45초). [v0.1.0 Release](https://github.com/psho0324/-/releases/tag/v0.1.0)에 설치 파일을 공개했습니다.
- 공개된 [installed.json](https://github.com/psho0324/-/releases/download/v0.1.0/installed.json)을 내려받아 `platform: "win32"`, `packaged: true`, 실제 설치 앱 검사 **7개 그룹 통과**, `failures: []`를 확인했습니다.
- 홈페이지는 확인된 이 Release 설치 파일 주소를 사용합니다. 홈페이지 배포 결과는 설치 앱 검증과 별도로 확인합니다.

## README의 설치 앱 확인 항목 9개

아래의 ‘미확인’은 실패 판정이 아닙니다. 해당 Windows 환경에서 관찰한 증상·오류 문구·스크린샷은 아직 확보되지 않았습니다.

| 항목               | 확인한 범위                                                                                                                          | Windows에서 남은 확인                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 1. 트레이와 X 버튼 | Linux와 Windows 실제 앱에서 창을 닫아도 파괴되지 않고 숨겨지며, 같은 창을 다시 표시하는 흐름 확인                                    | 트레이 아이콘의 실제 모양·표시, 메뉴의 열기/종료 클릭 미확인                                  |
| 2. 알림 표시·클릭  | 원본 가짜 Electron 테스트의 알림 로직 검사                                                                                           | Windows 알림의 시간·제목·아이콘·클릭으로 창 열기 미확인                                       |
| 3. 자동 시작       | Linux와 Windows 실제 `--hidden` 실행 시 창이 보이지 않는 것 확인                                                                     | Windows 로그인 후 자동 시작과 설정 토글 연동 미확인                                           |
| 4. 단일 실행       | Linux와 Windows에서 두 번째 실제 프로세스가 종료되고 기존 창 하나가 유지되는 것 확인                                                 | 자동 검사 통과. 실제 사용자 PC에서도 재실행 흐름 확인 가능                                    |
| 5. 종료 전 저장    | Linux와 Windows에서 할 일 추가 직후 실제 `app.quit()` → 재실행 → JSON에 할 일이 남는 것 확인                                         | 트레이 종료 메뉴의 실제 조작, 읽기 전용 폴더에서 종료 경고·취소, Windows 종료/로그오프 미확인 |
| 6. 자동 백업       | Linux와 Windows의 격리된 실제 사용자 데이터 폴더에서 재시작 후 일일 백업과 수동 백업 IPC 확인. 보관·복원은 원본 단위 테스트에서 검사 | 설치 앱의 실제 사용자 폴더와 복원 화면 수동 확인 필요                                         |
| 7. 동기화 폴더     | 원본 저장소 단위 테스트의 폴더 변경·파일 저장 검사                                                                                   | 실제 OneDrive/Google Drive, 두 PC, 폴더 사라짐·재연결 미확인                                  |
| 8. 패키징 후 경로  | Linux 원본 앱과 Windows 개발·설치 앱에서 실제 preload IPC·context isolation·아이콘 경로 확인. Windows ASAR 파일 검사 통과            | 패키징 경로 자동 검사 통과. 아이콘의 OS 화면 표시 모양은 수동 확인 필요                       |
| 9. 저장 실패 표시  | Linux와 Windows 실제 파일 쓰기 실패 → IPC 오류 → 지속 경고 → 화면의 재시도로 저장 성공 확인                                          | 자동 검사 통과. 읽기 전용 종료 안내창은 별도 미확인                                           |

## 실제 실패와 재현 기록

### 이전 Windows 검사 코드 실패 — 앱 오류와 구분

- 실행: [42577141256](https://github.com/psho0324/-/actions/runs/42577141256).
- 재현: 수정 전 커밋에서 Windows로 `cd desktop`, `npm ci`, `npm run test:desktop` 실행.
- 오류 문구:

```text
Cannot read properties of undefined (reading 'endsWith')
```

- 원인: 검사 코드가 `getLastWebPreferences()`의 `prefs.preload`를 문자열로 가정했습니다. 이 Electron 버전의 반환값에는 해당 필드가 없어 검사 자체가 중단됐습니다.
- 수정: 커밋 `0ecfa41`. 실제 앱 폴더/ASAR의 preload 파일, 로드된 bridge의 IPC 실행, `preload-error` 이벤트를 검사하도록 **검사 코드만** 수정했습니다. 앱 소스는 바꾸지 않았습니다.
- 이전 실패 화면·보고서: 위 실행 페이지 → **Artifacts → my-planner-windows → test-results/source/**. 생성된 `failure.png`, `report.json`, `stderr.log`를 확인합니다. 창을 캡처하지 못한 경우 `failure.png`가 없을 수 있습니다.
- 수정 후 [Windows 재검사 42577451935](https://github.com/psho0324/-/actions/runs/42577451935)는 개발 실행·설치 앱 검사까지 성공했습니다.

### Linux 저장 실패 검사 — 의도적으로 만든 오류와 정상 복구

실제 파일 오류가 화면에 전달되는지 확인하기 위해, 임시 검사 폴더의 `planner-data.json` 파일을 보관한 뒤 같은 이름의 **디렉터리**를 만들었습니다. 그 상태에서 가짜 할 일을 추가하면 파일의 원자적 교체가 실패합니다.

실제 IPC 오류 문구:

```text
Error invoking remote method 'data:save': Error: EISDIR: illegal operation on a directory, rename '/tmp/planner-electron-smoke-NBEGhc/user-data/planner-data.json.tmp' -> '/tmp/planner-electron-smoke-NBEGhc/user-data/planner-data.json'
```

화면에 표시된 문구:

```text
⚠ 저장 실패 — 이 내용은 아직 저장되지 않았어요
다시 시도
```

디렉터리를 제거하고 원본 검사 파일을 복구한 다음 ‘다시 시도’를 눌러 실제 JSON에 추가한 할 일이 저장되는 것을 확인했습니다. 이 오류는 저장 실패 처리를 검증하기 위해 유도한 것이며, ‘읽기 전용 폴더에서 종료’ 검사와는 별개입니다.

- 시작 화면: 로컬 `test-results/linux/startup.png`.
- 실패 경고 화면: 로컬 `test-results/linux/save-failure.png`.
- 오류 원문과 복구 결과: 로컬 `test-results/linux.json`의 `saveFailureMessage`, `passed`, `stderr`.
- Linux GUI 환경의 stderr에는 GPU 초기화·알림 서비스 경고도 기록돼 있습니다. 이를 Windows 알림 표시 성공이나 Windows 앱 오류로 해석하지 않습니다.

### Windows 설치 앱 저장 실패 검사 — 의도적으로 만든 오류와 정상 복구

태그 Release의 실제 Windows 설치 앱에서도 임시 검사 데이터 파일을 같은 이름의 디렉터리로 바꿔 저장을 막았습니다. `installed.json`에 기록된 실제 IPC 오류 원문은 다음과 같습니다. `RUNNER~1` 경로는 GitHub Actions 검사 계정의 임시 폴더입니다.

```text
Error invoking remote method 'data:save': Error: EPERM: operation not permitted, rename 'C:\Users\RUNNER~1\AppData\Local\Temp\planner-electron-smoke-HHeamr\user-data\planner-data.json.tmp' -> 'C:\Users\RUNNER~1\AppData\Local\Temp\planner-electron-smoke-HHeamr\user-data\planner-data.json'
```

화면에는 위 Linux 검사와 같은 ‘⚠ 저장 실패 — 이 내용은 아직 저장되지 않았어요 / 다시 시도’가 표시됐습니다. 장애를 제거한 뒤 재시도로 실제 파일 저장이 완료됐고 검사 그룹이 통과했습니다. 이는 저장 대상 디렉터리 충돌을 유도한 결과이며, **읽기 전용 폴더에서 종료할 때 나오는 안내창은 여전히 미확인**입니다.

- 화면: [태그 실행 42577948676](https://github.com/psho0324/-/actions/runs/42577948676) → **Artifacts → my-planner-windows → test-results/installed/save-failure.png**.
- 시작 화면: 같은 아티팩트의 `test-results/installed/startup.png`.
- 오류 원문·복구 판정: 공개 [installed.json](https://github.com/psho0324/-/releases/download/v0.1.0/installed.json)의 `saveFailureMessage`, `passed`, `failures`.

## Windows 증거 파일 확인 방법

[개발 실행 검증 42577451935](https://github.com/psho0324/-/actions/runs/42577451935) 또는 [공개 태그 실행 42577948676](https://github.com/psho0324/-/actions/runs/42577948676)의 **Artifacts → my-planner-windows**에서 증거 파일을 확인할 수 있습니다. 공개된 설치 앱 보고서는 [installed.json](https://github.com/psho0324/-/releases/download/v0.1.0/installed.json)에서도 받을 수 있습니다.

| 경로                                                                            | 내용                                   |
| ------------------------------------------------------------------------------- | -------------------------------------- |
| `test-results/source.json`, `test-results/source/report.json`                   | 실제 개발 실행 검사 결과               |
| `test-results/source/startup.png`, `test-results/source/save-failure.png`       | 개발 실행 화면·의도적 저장 실패 경고   |
| `test-results/installed.json`, `test-results/installed/report.json`             | 실제 설치된 앱 검사 결과               |
| `test-results/installed/startup.png`, `test-results/installed/save-failure.png` | 설치 앱 화면·의도적 저장 실패 경고     |
| `test-results/*/failure.png`, `test-results/*/stderr.log`                       | 실패 시 가능한 화면 캡처와 stderr 원문 |
| `dist/MyPlanner-Setup.exe`, `dist/SHA256SUMS.txt`                               | 빌드 결과와 설치 파일 체크섬           |

태그 Release는 Windows 검사·NSIS 빌드·설치 후 검사가 끝까지 성공한 경우에만 공개합니다. 사용자 PC의 수동 항목에서 문제가 생기면 앱·Windows 버전, 실행 순서, 정확한 오류 문구와 화면을 추가로 기록합니다.

공개 설치 파일: [MyPlanner-Setup.exe](https://github.com/psho0324/-/releases/download/v0.1.0/MyPlanner-Setup.exe). 파일 검증용 [SHA256SUMS.txt](https://github.com/psho0324/-/releases/download/v0.1.0/SHA256SUMS.txt)도 같은 Release에 제공합니다.
