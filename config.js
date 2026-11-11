// Supabase 연결 후 Project URL과 공개용 publishable key만 입력합니다.
// 비밀번호, secret key, service_role key는 이 파일에 넣지 않습니다.
window.WORKSPACE_CONFIG = {
  // 공개 화면도 Supabase에 저장된 공개 프로젝트와 기록을 읽습니다.
  useDatabase: true,
  supabaseUrl: 'https://virgpebdldcqwrzsmuqc.supabase.co',
  publishableKey: 'sb_publishable_rx1WEBuWMQOrebbBBfVv1A_bETXuaKz',
  // 빌드·설치 검사를 통과한 Release의 파일이 실제로 공개된 뒤에만 ready를 켭니다.
  // 관리자에서 등록한 다운로드 주소가 있으면 그 설정을 우선합니다.
  desktopReleases: {
    calendar: {
      ready: true,
      downloadUrl: 'https://github.com/psho0324/-/releases/latest/download/MyPlanner-Setup.exe',
      downloadPlatform: 'windows',
      downloadVersion: '0.1.1',
      downloadRequirements: 'Windows 10/11 · 64비트',
      unsigned: true
    }
  }
};
