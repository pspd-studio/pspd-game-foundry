/**
 * 플레이 로그 원격 전송 (Supabase REST).
 *
 * 의존성을 늘리지 않기 위해 supabase-js를 쓰지 않고 REST 엔드포인트에 직접 POST한다.
 * `SUPABASE.url`이 비어 있으면 이 파일은 아무 일도 하지 않는다 — 즉 키가 없어도 게임은 돈다.
 *
 * 왜 anon 키를 코드에 넣어도 되는가:
 *   anon 키는 애초에 브라우저에 배포되도록 설계된 공개 키다. 안전은 키를 숨겨서가 아니라
 *   테이블의 RLS 정책(INSERT만 허용, SELECT 금지)으로 지킨다. 정책은 docs/40-playtest-db.sql에 있다.
 *   따라서 테스터가 키를 봐도 남의 로그를 읽거나 기존 행을 고칠 수 없다.
 *
 * 개인정보는 보내지 않는다. 세션 식별자는 randomUUID이고 IP·UA는 우리가 따로 기록하지 않는다.
 */
import { SUPABASE } from '../config.ts';
import type { LogRecord, Logger } from './log.ts';

const TABLE = 'play_events';
const BATCH = 12;
const FLUSH_MS = 4000;

interface Row {
  session: string;
  run: number;
  ms: number;
  turn: number | null;
  type: string;
  payload: unknown;
}

function toRow(r: LogRecord): Row {
  const e = r.event as Record<string, unknown>;
  const { t, ...rest } = e;
  return {
    session: r.session,
    run: r.run,
    ms: r.ms,
    turn: typeof e.turn === 'number' ? e.turn : null,
    type: String(t),
    payload: rest,
  };
}

/** 켜져 있는지. 링크만 돌리고 로그는 안 받는 상태도 정상 동작이어야 한다. */
export function remoteEnabled(): boolean {
  return Boolean(SUPABASE.url && SUPABASE.anonKey);
}

export function attachRemote(logger: Logger): void {
  if (!remoteEnabled()) return;

  const endpoint = `${SUPABASE.url.replace(/\/+$/, '')}/rest/v1/${TABLE}`;
  const headers = {
    'content-type': 'application/json',
    apikey: SUPABASE.anonKey,
    authorization: `Bearer ${SUPABASE.anonKey}`,
    prefer: 'return=minimal',
  };

  let queue: Row[] = [];
  let timer: number | undefined;

  function send(rows: Row[], beacon: boolean): void {
    if (!rows.length) return;
    const body = JSON.stringify(rows);
    // 페이지를 떠나는 순간에는 fetch가 취소될 수 있어 sendBeacon을 쓴다.
    // sendBeacon은 헤더를 못 붙이므로 apikey를 쿼리로 넘긴다(anon 키는 공개 키라 문제 없다).
    if (beacon && navigator.sendBeacon) {
      const url = `${endpoint}?apikey=${encodeURIComponent(SUPABASE.anonKey)}`;
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      return;
    }
    void fetch(endpoint, { method: 'POST', headers, body, keepalive: true })
      .catch(() => { /* 전송 실패가 게임을 멈추게 하지 않는다 */ });
  }

  function flush(beacon = false): void {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    const rows = queue;
    queue = [];
    send(rows, beacon);
  }

  logger.addSink((r) => {
    queue.push(toRow(r));
    // 판이 끝나는 순간은 이탈 직전일 확률이 높으니 바로 보낸다.
    if (queue.length >= BATCH || r.event.t === 'run_end') flush();
    else if (timer === undefined) timer = window.setTimeout(() => flush(), FLUSH_MS);
  });

  // 세션 요약을 한 줄 더 남긴다 — G3 지표 4종(세션 길이·판 수·첫 조합까지 시간)의 원재료.
  const summarize = (): void => {
    const s = logger.summary();
    queue.push({
      session: s.session, run: s.runs, ms: s.session_ms, turn: null,
      type: 'session_summary', payload: s,
    });
    flush(true);
  };

  window.addEventListener('pagehide', summarize);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') summarize();
  });
}
