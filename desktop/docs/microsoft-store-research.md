# Microsoft Store 배포 조사

확인일: **2026-11-10 (한국 시간)**. 대상은 저장소 `desktop/`의 `v0.1.0` Windows 테스트 앱입니다. **조사·설계만 했으며 패키지 변경, 서명, 계정 등록, Store 제출은 하지 않았습니다.**

Microsoft Learn 웹사이트는 이 환경의 네트워크 제한으로 HTTP 403을 반환했습니다. 아래 Microsoft 공식 공개 문서 원본을 직접 읽었습니다. 화면의 등록 절차·국가별 제공 여부와 요건은 실제 제출 직전에 공식 페이지에서 다시 확인해야 합니다.

- MicrosoftDocs/windows-dev-docs 원본 기준: [`a3812316d9d6678be4e526ffb4b1c4f3958d956d`](https://github.com/MicrosoftDocs/windows-dev-docs/tree/a3812316d9d6678be4e526ffb4b1c4f3958d956d/hub/apps/publish).
- electron-builder 상류 문서 기준: [`802f7abff53ada423be0524eab6e8c198ccb23ea`](https://github.com/electron-userland/electron-builder/tree/802f7abff53ada423be0524eab6e8c198ccb23ea/website/docs).
- 웹페이지를 실제 열어 확인한 결과와 공개된 공식 원문을 읽은 결과를 구분합니다. 이후 문서·대시보드가 달라질 수 있습니다.

## 1. 지금 설치 파일과 Store 배포 경로

현재 [package.json](../package.json)은 Electron `33.4.11`, electron-builder `26.18.0`, NSIS x64, `com.myplanner.app`을 사용합니다. 코드 서명과 자동 업데이트는 없습니다. 현재 `.exe`를 그대로 제출하면 Store가 대신 서명해 주는 것은 아닙니다.

| 경로                                       | 패키지·제출 방법                                                            | 서명 요건                                                                                                                   | 현재 앱에 필요한 준비                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 현재 홈페이지 테스트 배포                  | GitHub Releases의 NSIS `MyPlanner-Setup.exe`                                | 현재 미서명. Edge 다운로드 평판 경고·Windows 게시자 경고가 나타날 수 있음                                                   | 테스트 안내 유지. Store 제출 완료로 표시하지 않음                                              |
| **Store의 MSIX/AppX 경로: 우선 검토 권고** | `.msix`, `.appx` 및 지원되는 bundle/upload 패키지를 Partner Center에 업로드 | Microsoft는 인증 통과 후 패키지를 Microsoft 인증서로 다시 서명. 제출에 CA 신뢰 인증서·PFX 구매가 필수는 아님 [M1][M2]       | Store identity, Publisher, 로고, manifest, 권한, Windows SDK, 설치·업데이트·데이터 이전 재검증 |
| Store의 기존 Win32 EXE/MSI 경로            | 버전별 고유 HTTPS 설치 파일 URL 제출                                        | **설치 파일과 포함된 모든 PE 파일에 신뢰되는 CA 체인의 코드 서명이 필요. Store가 이 EXE/MSI를 다시 서명하지 않음** [M1][M3] | 인증서/서명 서비스, DLL·실행 파일 포함 서명, 무인 설치, 고정된 버전별 배포 파일                |
| Store 외부 MSIX/AppX 배포                  | 홈페이지·기업 배포 등                                                       | 배포자가 적합한 서명·신뢰 체계를 준비해야 함. Store 제출의 서명 면제가 외부 배포까지 적용되는 것은 아님 [M1]                | 별도 서명·설치 신뢰 확인                                                                       |

Store EXE/MSI 제출은 오프라인 독립 설치 파일과 silent install을 요구합니다. 현재 NSIS `/S`가 자동 검사에서 동작한 것은 일부 근거일 뿐, 서명·심사를 대신하지 않습니다 [M3].

**URL 정책 차이:** 홈페이지는 `/releases/latest/download/MyPlanner-Setup.exe`라는 고정 주소를 사용할 수 있습니다. 반면 Store EXE/MSI 경로는 제출 뒤 내용이 바뀌지 않는 **버전별 URL**을 요구합니다. 이 경로를 선택한다면 `/releases/download/v0.1.0/MyPlanner-Setup.exe`와 같이 버전을 고정하고 다음 버전은 새 URL로 제출해야 합니다. `latest` 주소를 Store 제출 URL로 그대로 사용하면 안 됩니다 [M3].

## 2. 개발자 등록과 공개 정보

공식 등록 문서는 Individual과 Company 계정을 구분합니다 [M4].

- 취미·개인·비상업적 프로젝트와 사업·직업 활동에 해당하는 배포의 계정 선택 기준이 다릅니다. 닉네임만으로 계정 종류를 결정하지 않습니다. Individual에서 Company로 직접 전환할 수 없다는 안내도 있습니다.
- **현재 공식 원문은 `storedeveloper.microsoft.com`의 새 등록 경로에서 개인·기업 모두 등록비가 없다고 안내**합니다. 예전 등록 흐름과 다른 도구 문서의 과거 비용 설명을 현재 비용으로 단정하지 않습니다. 실제 국가·계정의 신청 화면을 최종 확인해야 합니다. 코드 서명 서비스 비용, 다른 플랫폼의 개발자 비용과는 별도입니다.
- 개인 등록에는 Microsoft 계정과 신분증·셀피를 이용한 본인 확인이 안내돼 있습니다. 기업 등록에는 사업체·연락처·소속 확인 등이 필요합니다.
- 본인 확인용 실명 정보와 Store에 노출되는 Publisher 표시·지원 연락처는 구분해서 검토해야 합니다. 공개되는 항목·지역별 요구 사항은 실제 등록 화면에서 확인합니다. ‘떠돌이’라는 표시만으로 모든 법적 정보를 비공개로 둘 수 있다고 약속하지 않습니다.
- 신분증, 계정 비밀번호, 서명 인증서·비밀 키는 Microsoft의 공식 등록/비밀 관리 경로에서만 처리하고 저장소·Releases·홈페이지에 올리지 않습니다. 이번 조사에서 이러한 자료는 수집하지 않았습니다.

등록 후 앱 이름을 예약하고 Partner Center의 **Product identity**에서 패키지 이름·Publisher·표시 이름 등을 확인해야 합니다. 문자열의 대소문자·공백도 manifest와 일치해야 합니다 [M1]. `com.myplanner.app` 하나만으로 Store identity가 완성되지는 않습니다.

## 3. 개인정보 처리방침

Microsoft Store 정책 **10.5.1**은 개인정보 접근·수집·전송 시 개인정보 처리방침과 Partner Center URL을 요구하고, **Win32·Desktop Bridge 앱은 개인정보에 본질적으로 접근하는 유형이라 항상 처리방침이 필요**하다고 명시합니다 [M5]. 로컬 파일만 사용하는 현재 앱도 해당 유형 기준을 확인해야 합니다.

다음 내용은 향후 처리방침을 작성할 때 확인할 항목이며, 현재 확정된 법률 문구나 이미 게시된 정책이 아닙니다.

| 현재 로컬 앱에서 설명할 사실                                   | 계정·동기화를 도입할 때 추가할 사실                    |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| 일정·할 일·목표와 설정을 로컬 JSON에 보관                      | 계정 식별자와 서버에 보내는 항목, 업로드 동의          |
| 로컬 자동 백업·복원 및 사용자가 선택한 폴더                    | Supabase 등 처리 서비스, 실제 저장 지역·보관 기간·보안 |
| OneDrive 등 선택 폴더의 동기화는 사용자가 선택한 서비스에 의존 | 계정 삭제·내보내기·탈퇴 시 서버/기기/백업 데이터 처리  |
| 실제로 확인한 수집·통신 동작과 지원 문의 방법                  | 로그·오류 수집이 있다면 내용·제외할 민감 정보          |

일정 내용은 민감한 개인 정보를 포함할 수 있으므로 실제 접근·전송·보관 행위를 정확히 설명해야 합니다. 현재 구현하지 않은 계정 동기화를 ‘이미 제공한다’고 쓰거나, 로컬 파일에 보관한다는 이유로 ‘개인정보에 전혀 접근하지 않는다’고 단정하지 않습니다. 정책 URL은 공개 가능해야 하지만 사용자 일정이나 계정 키를 정책의 예시에 넣지 않습니다. 기능과 데이터 처리 방식이 달라지면 정책도 함께 갱신해야 합니다 [M5].

## 4. electron-builder로 가능한가

**가능한 경로가 있습니다. 다만 현재 고정 버전과 최신 상류 문서를 구분해야 합니다.**

- 현재 설치된 `app-builder-lib 26.18.0`의 `scheme.json`에는 `appx` 설정·타깃이 있고 `msix` 설정은 없습니다. 따라서 현재 버전에서는 우선 **AppX Store 패키지**를 검토할 수 있습니다. Microsoft는 `.appx`도 Store 업로드 형식으로 인정합니다 [M2][E1].
- 확인한 최신 상류 문서는 별도의 **MSIX beta** 타깃을 설명합니다. 최신 문서에 있다는 이유로 현재 고정 버전에서 `--win msix`가 동작한다고 가정하면 안 됩니다. 이를 택하려면 도구 버전·Windows SDK/toolset을 따로 검토하고 빌드·설치·인증을 재검사해야 합니다 [E2]. 이번 작업에서는 업그레이드하지 않았습니다.
- AppX 설정은 Store에서 받은 `identityName`, `publisher`, `publisherDisplayName`, applicationId, 한국어 리소스와 적절한 로고를 준비하는 방식입니다. 기존 `.ico`만으로 Store에 필요한 모든 이미지가 충족된다고 가정하지 않습니다 [E1].
- Electron의 full-trust 실행에는 manifest의 `runFullTrust` 같은 capability 검토가 필요합니다. 기본 템플릿에 권한이 있다는 사실이 Store의 승인 보장은 아닙니다. 필요한 권한과 동작을 심사 자료에 설명해야 합니다.
- 상류 AppX 문서의 과거 **$19 등록비** 설명은 Microsoft의 현재 새 등록 문서와 다릅니다. 비용·정책은 Microsoft 원문을 우선합니다. 도구 문서의 NSIS/MSI 비교표도 Microsoft의 별도 EXE/MSI 제출 경로 유무를 판단하는 근거로 쓰지 않습니다 [M3][M4][E1].

실제 Store 패키지는 이번에 제작하지 않았으며 인증·심사 통과도 확인하지 않았습니다.

## 5. 정식 패키지로 넘어가기 전 확인할 것

이 항목들은 **다음 작업의 설계 목록**입니다. 앱 본체를 바꿔야 하는 사항은 먼저 변경 내용과 이유를 사용자·Claude에게 전달해야 합니다.

1. 개발자 등록 종류와 앱 이름, Publisher/identity 확보. 비밀 자료는 저장소에 넣지 않기.
2. AppX(현재 도구) 또는 MSIX(도구 변경 필요)를 선택하고 package identity·버전 번호·권한·아이콘을 설계. Store 버전 규칙은 별도 적용되므로 `0.1.0`을 기계적으로 복사하지 않기 [M1].
3. MSIX/AppX의 파일·사용자 데이터 경로 차이 확인. NSIS의 기존 `my-planner` 폴더가 자동으로 이전된다고 가정하지 않고 로컬 백업·명시적 가져오기·실패 시 복구를 계획.
4. Store identity에서 알림 제목·클릭, 트레이, 자동 시작 등록과 `--hidden`, 선택 폴더 접근, 종료 전 저장, 제거·업데이트 시 데이터 보존을 다시 확인. 현재 NSIS 검사 결과를 Store 패키지 결과로 확대하지 않기.
5. Windows App Certification Kit와 별도 테스트 계정/기기 검사, 스크린샷·설명·연령 등급·지원 정보·개인정보 처리방침·인증 노트 준비 [M1][M6]. 가짜 예시 데이터만 사용하기.
6. 현재 Electron·패키징 도구의 지원 상태와 Store 심사 기준을 제출 시점에 재확인. 실제 문제가 보이면 앱·Windows 버전, 증상·재현 순서·원문 오류·화면을 먼저 기록하고 원인 추측만으로 고치지 않기.
7. 제출·승인 이후 홈페이지의 테스트 다운로드와 Store 설치 경로를 어떻게 구분할지 별도로 결정. 현재 고정 다운로드와 테스트 릴리스는 그대로 유지.

## 출처

아래 문서를 **2026-11-10**에 공식 공개 원본으로 확인했습니다. Microsoft 원문 링크는 위 MicrosoftDocs 고정 커밋의 동일한 `hub/…` 파일에서 재현할 수 있습니다.

| 번호 | 공식 페이지                                                                                                                                                                                                                                                                                                               | 확인한 핵심                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| M1   | [MSIX app package requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements) · [고정 원문](https://github.com/MicrosoftDocs/windows-dev-docs/blob/a3812316d9d6678be4e526ffb4b1c4f3958d956d/hub/apps/publish/publish-your-app/msix/app-package-requirements.md)  | 문서 ms.date 2026-07-27, Store 재서명과 EXE/MSI·외부 배포의 차이, manifest·버전 |
| M2   | [Upload MSIX app packages](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/upload-app-packages)                                                                                                                                                                                              | `.msix`, `.appx` 등 업로드 형식                                                 |
| M3   | [MSI/EXE app package requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements) · [고정 원문](https://github.com/MicrosoftDocs/windows-dev-docs/blob/a3812316d9d6678be4e526ffb4b1c4f3958d956d/hub/apps/publish/publish-your-app/msi/app-package-requirements.md) | 코드 서명·불변 버전 URL·무인 독립 설치                                          |
| M4   | [Open a developer account](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account) · [고정 원문](https://github.com/MicrosoftDocs/windows-dev-docs/blob/a3812316d9d6678be4e526ffb4b1c4f3958d956d/hub/apps/publish/partner-center/open-a-developer-account.md)                     | 계정 종류, 새 등록 경로의 등록비 없음, 신원 확인                                |
| M5   | [Microsoft Store policies §10.5](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies#105-personal-information) · [고정 원문](https://github.com/MicrosoftDocs/windows-dev-docs/blob/a3812316d9d6678be4e526ffb4b1c4f3958d956d/hub/apps/publish/store-policies.md)                                        | Win32/Desktop Bridge 개인정보 처리방침, 동의·보안                               |
| M6   | [MSIX certification process](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-certification-process)                                                                                                                                                                                      | 인증·제출 단계                                                                  |
| E1   | [electron-builder AppX](https://www.electron.build/appx.html) · [고정 원문](https://github.com/electron-userland/electron-builder/blob/802f7abff53ada423be0524eab6e8c198ccb23ea/website/docs/appx.md)                                                                                                                     | AppX 설정·identity·Store 서명·리소스                                            |
| E2   | [electron-builder MSIX](https://www.electron.build/msix.html) · [고정 원문](https://github.com/electron-userland/electron-builder/blob/802f7abff53ada423be0524eab6e8c198ccb23ea/website/docs/msix.md)                                                                                                                     | 상류 beta 지원·SDK/toolset·Windows 빌드 필요                                    |

현재 버전 지원 판정은 저장소의 잠금 파일과 실제 설치된 `app-builder-lib 26.18.0/scheme.json`을 비교한 정적 조사입니다. Store 계정·실제 패키지 빌드로 검증한 결과는 아닙니다.
