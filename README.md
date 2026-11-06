# 작업실

앱과 프로젝트를 소개하는 공개 포트폴리오입니다. HTML, CSS, JavaScript로 만든 사이트입니다. 기본 공개 화면은 설치 없이 실행할 수 있고, 관리자 기능은 Supabase에 연결합니다.

## 실행

```sh
cd /workspace/-
python3 -m http.server 3000 --bind 0.0.0.0
```

브라우저에서 서버의 3000번 포트로 확인합니다. `index.html`을 직접 열어도 작동합니다.

## 프로젝트 관리

`projects.js`의 목록을 수정합니다. `name`, `description`, `tags`, `note`로 소개를 바꾸고, 공개된 앱 주소를 `url`에 추가하세요. 완성한 앱은 `status`를 `live`로 변경하면 “사용 가능” 필터에 표시됩니다. 새 프로젝트는 목록에 객체를 추가하면 됩니다. 공개 파일에는 비밀번호나 개인 정보를 넣지 마세요.

## GitHub Pages로 공개하기

코드를 GitHub에 올린 다음 저장소 Settings → Pages에서 Deploy from a branch, main 브랜치, /(root)를 선택해 저장합니다. 이 작업은 별도의 공개 배포 단계입니다.

## 제작 기록 추가

`journal.js`의 `journalEntries`에 기록을 추가합니다. `projectId`는 `projects.js`의 프로젝트 `id`와 같아야 합니다. `id`는 고유한 숫자, `date`는 `YYYY-MM-DD` 형식입니다. 제목(`title`), 요약(`summary`), 펼쳐 볼 본문(`body`)을 작성하면 전체 기록과 해당 프로젝트 필터에 자동으로 표시됩니다. 프로젝트 필터는 프로젝트 목록에서 자동 생성되며 기록이 없어도 표시됩니다.


## 관리자 화면

`admin.html`에서 프로젝트와 제작 기록을 관리합니다. 최초 연결은 [SETUP.md](SETUP.md)를 따라 진행합니다. Supabase를 연결하기 전에는 공개 화면의 기존 내용을 유지하며, 관리자 저장 기능에는 실제 로그인과 데이터베이스 권한이 필요합니다. 대표 이미지는 HTTPS 이미지 주소를 사용합니다.

코드나 설정을 수정한 뒤에는 다음 명령으로 정적 파일의 버전 주소를 갱신하세요.

```sh
python3 scripts/version-assets.py
```

## 검증

별도 임시 디렉터리에 테스트 의존성을 설치해 실행할 수 있습니다. 앱 실행에는 이 의존성이 필요하지 않습니다.

```sh
npm install --prefix /tmp/wanderer-tests --no-audit --no-fund --ignore-scripts @electric-sql/pglite@0.5.15 playwright
NODE_PATH=/tmp/wanderer-tests/node_modules node tests/database.test.cjs
NODE_PATH=/tmp/wanderer-tests/node_modules CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser.test.cjs
```

브라우저 테스트에는 시스템 Chromium이 필요합니다. 데이터베이스 테스트는 로컬 PostgreSQL 호환 엔진에서 RLS를 검증합니다. 브라우저 테스트는 Supabase 인증/API 응답을 모의 처리하며 실제 서비스 연결 검증을 대체하지 않습니다. 실제 연결 후에는 SETUP.md의 공개·초안·관리자 로그인 확인을 완료해야 합니다.


## 분류와 초안 관리

관리자 프로젝트 편집 화면의 분류는 앱의 용도를 나타내며 선택 목록으로 지정합니다. `categories.js`에서 분류 코드와 표시 이름을 관리합니다. 기존 목록에 없는 분류 값은 편집 시 기존 값으로 유지됩니다.

상단 ‘아직 공개하지 않은 초안’ 또는 ‘초안 보관함’ 탭에서 프로젝트와 제작 기록 초안을 모아 볼 수 있습니다. ‘프로젝트 초안’은 이름과 간단한 소개만 입력하면 저장되며 관리용 ID는 자동 생성됩니다. 공개 상태를 공개로 바꿔 저장하면 보관함에서 빠지고 방문자 화면에 표시됩니다. 간단한 소개는 공개 프로젝트 카드와 관리자 목록에 표시되며 최대 500자입니다. 기존 데이터베이스 구조를 사용하므로 추가 SQL 실행은 필요하지 않습니다.
