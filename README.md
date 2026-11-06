# 작업실

앱과 프로젝트를 소개하는 공개 포트폴리오입니다. 별도의 설치나 API 키가 필요하지 않은 HTML, CSS, JavaScript 사이트입니다.

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
