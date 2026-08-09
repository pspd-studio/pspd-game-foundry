/**
 * 배포 설정. 여기 두 값만 채우면 플레이 로그가 Supabase로 들어간다.
 * 비워 두면 로그 전송만 꺼지고 게임은 그대로 돈다.
 *
 * anon 키는 브라우저에 배포되도록 설계된 공개 키다. 비밀이 아니다.
 * 보안은 테이블 RLS(INSERT만 허용, SELECT 금지)로 지킨다 — docs/40-playtest-db.sql 참조.
 * service_role 키는 절대 여기 넣지 않는다. 그건 진짜 비밀키다.
 */
export const SUPABASE = {
  /** 예: https://abcdefghijklmnop.supabase.co */
  url: '',
  /** Project Settings → API Keys의 anon / publishable 키 */
  anonKey: '',
};
