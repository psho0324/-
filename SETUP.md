# 설정 안내

## 이미 사용하던 사이트라면

1. [확장 설정 SQL](supabase/migrations/002_workspace.sql) 전체를 복사합니다. 이미 실행했다면 건너뛰어도 됩니다.
2. Supabase **SQL Editor → New query**에 붙여 넣고 **Run**을 누릅니다.
3. 이어서 [입력 검증 보완 SQL](supabase/migrations/003_validation.sql) 전체도 새 쿼리에서 실행합니다. 기존 자료를 바꾸지 않고 잘못된 형식의 새 저장·백업 가져오기를 차단합니다.
4. 관리자 화면을 새로고침합니다. 기존 이메일·비밀번호로 로그인합니다.

기존 자료를 `workspace_items`에 보존하며 이관합니다. 기존 프로젝트·기록 테이블은 삭제하지 않고 보관합니다. 이관 후에는 공개 중지한 자료가 예전 API에서 노출되거나 데이터가 두 군데로 나뉘지 않도록 기존 테이블의 브라우저 접근을 중지하고 새 저장 함수로 관리합니다. 관리자 명단, 비밀번호, Git 작성자 설정은 변경하지 않습니다. 스크립트는 트랜잭션으로 실행되고 다시 실행해도 기존 새 저장 자료를 덮어쓰지 않습니다. 여러 스크립트를 다시 실행할 때는 번호 순서대로 실행하며 마지막에 003을 실행합니다. 현재 schema.sql은 확장 이후 재실행해도 예전 테이블의 브라우저 접근을 다시 열지 않습니다. 예전 스크립트 사본 대신 저장소의 최신 파일을 사용하세요.

현재 홈페이지는 확장 전에도 기존 공개 내용을 읽을 수 있습니다. 새 관리자 저장 기능은 확장 SQL을 완료해야 사용할 수 있습니다. 오류가 나면 권한을 임의로 해제하지 말고 오류 문구를 작업 중인 채팅에 알려 주세요.

## 2026-11-11 갱신: 003을 적용했는지 확인하기

003은 PC 앱 설치와 별개인 홈페이지 서버 검증 보완입니다. 앱이나 홈페이지를 새 버전으로 받아도 Supabase SQL이 자동 실행되지는 않습니다. 이 환경에서는 운영 Supabase 적용 여부를 직접 확인하지 못했으므로 사용자가 SQL Editor에서 확인해야 합니다.

1. **SQL Editor → New query**를 엽니다. 처음 만든 프로젝트는 최신 `schema.sql` → `002_workspace.sql` → `003_validation.sql` 순서로 실행합니다. 이미 002를 실행한 프로젝트는 003 전체만 실행하면 됩니다. 여러 파일을 다시 실행한다면 마지막에 반드시 003을 실행합니다.
2. 003 실행이 오류 없이 끝나면 아래 **조회 전용** SQL을 새 쿼리에서 실행합니다. 개인 자료를 추가·수정·삭제하지 않습니다.

```sql
with validation as (
  select pg_get_functiondef(
    to_regprocedure('public.workspace_validate(text,jsonb)')
  ) as definition
)
select
  to_regclass('public.workspace_items') is not null as workspace_v2_ready,
  coalesce(position('workspace_invalid_field_type' in definition) > 0, false) as strict_field_types,
  coalesce(position('^[0-9]{4}-[0-9]{2}-[0-9]{2}$' in definition) > 0, false) as canonical_date
from validation;
```

결과 세 칸이 모두 `true`이면 v2 테이블과 003의 엄격한 타입/날짜 검증 코드가 설치돼 있음을 확인한 것입니다. 이는 함수 정의 확인이며 모든 운영 기능의 동작 검사를 대신하지 않습니다. `workspace_v2_ready`가 false면 002부터 확인하고, 나머지가 false면 최신 003 전체를 다시 실행합니다. 오류가 나면 원문을 보관하되 비밀번호·비밀 키·개인 자료는 보내지 마세요. 적용 후 관리자 화면을 새로고침해 기존 자료가 표시되는지 확인합니다.

## 새 프로젝트에서 처음 시작한다면

1. Supabase 프로젝트를 만듭니다. 데이터베이스 비밀번호는 별도로 보관합니다.
2. SQL Editor에서 `supabase/schema.sql` 전체를 실행한 다음 `supabase/migrations/002_workspace.sql`, `supabase/migrations/003_validation.sql` 순서로 실행합니다.
3. **Authentication → Users → Add user → Create new user**에서 본인 이메일과 관리자 비밀번호로 계정을 만들고 Auto Confirm User를 선택합니다.
4. 아래 SQL의 이메일을 본인 이메일로 바꿔 실행합니다. 비밀번호는 SQL이나 코드에 입력하지 않습니다.

```sql
insert into public.site_admins (user_id)
select id from auth.users where email = '본인 이메일'
on conflict (user_id) do nothing;
select user_id from public.site_admins;
```

5. Settings → Data API의 Project URL과 Settings → API Keys의 공개용 Publishable key를 `config.js`에 등록합니다. `useDatabase`는 true로 설정합니다. Secret key·service_role key·데이터베이스 비밀번호는 사용하지 않습니다.
6. `admin.html`에서 로그인합니다.

## 비밀번호 재설정

Supabase **Authentication → URL Configuration**의 Site URL과 Redirect URLs에 `https://psho0324.github.io/-/admin.html`을 등록합니다. 관리자 로그인 화면에서 이메일을 적고 ‘비밀번호 재설정 이메일 받기’를 누릅니다. 메일의 최신 링크로 새 비밀번호를 설정합니다. 기본 ConfirmationURL 템플릿의 복구 링크를 지원합니다. Gmail에서 본문이 접혔다면 작은 `…`를 눌러 펼칩니다.

## 이미지 저장소

확장 SQL은 비공개 `workspace-media` 버킷과 필요한 정책을 생성합니다. 관리자만 업로드할 수 있고, 방문자는 공개된 항목에 연결된 이미지만 읽습니다. 초안 이미지와 휴지통 이미지는 익명 읽기를 허용하지 않습니다. 이미 공개된 이미지를 방문자가 저장하거나 브라우저가 캐시한 사본까지 회수할 수는 없습니다.

업로드한 파일은 수정 이력 복원과 백업을 위해 자동으로 삭제하지 않습니다. Supabase Storage 사용량과 요금제 한도를 주기적으로 확인하세요. 이미지 삭제·이력 정리 없이 사용하면 저장 공간이 늘어납니다.

## GitHub Pages 자동 배포로 전환

확장 SQL 실행 후 진행하세요.

1. GitHub 저장소 **Settings → Pages → Source**를 **GitHub Actions**로 바꿉니다.
2. **Actions → Publish website and project previews → Run workflow**를 실행합니다.
3. 작업이 성공하면 기존 홈페이지 주소에서 확인합니다.

관리자 저장 내용은 Supabase에서 바로 읽습니다. 프로젝트별 검색·공유 소개 페이지는 main 변경, 6시간 간격 예약, 수동 실행 때 갱신합니다. 관리자 저장 때마다 GitHub를 호출할 별도 비밀 토큰은 사용하지 않습니다. 처음 전환 전까지는 기존 브랜치 배포로도 일반 홈페이지·관리자 화면을 사용할 수 있으며, 생성된 개별 소개 페이지는 Actions 전환 후 제공됩니다.

백업을 복원하거나 항목을 비공개로 바꾼 뒤 공유용 정적 페이지도 즉시 갱신하려면 배포 워크플로를 수동 실행하세요. 이미 외부 서비스에 캐시된 미리보기는 해당 서비스 정책에 따라 나중에 바뀔 수 있습니다.

## 운영 확인

- 관리자에서 초안을 작성하고 다른 시크릿 창에서 보이지 않는지 확인합니다.
- 기존 공개 항목을 수정 초안으로 저장하고 공개본이 유지되는지 확인합니다.
- 두 탭에서 같은 항목을 바꾸면 나중 탭에서 충돌 안내가 나오는지 확인합니다.
- 백업 파일을 내려받아 보관하고 작은 테스트 자료로 새 초안 복원을 확인합니다.
- Supabase 자체 자동 백업의 보존 기간과 복구 기능은 현재 요금제에서 별도로 확인합니다. 앱의 수동 내보내기만으로 서버 정기 백업이 설정되는 것은 아닙니다.

이 기능들은 코드와 로컬 PostgreSQL·브라우저 테스트로 검증합니다. SQL과 Pages 설정을 실제 서비스에 적용하기 전에는 운영 환경 적용 완료로 보지 않습니다.
