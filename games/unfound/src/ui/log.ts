/**
 * 플레이 로그 수집 seam.
 *
 * 코어는 GameEvent만 흘리고 아무 곳에도 보내지 않는다. 여기서 그걸 받아
 *   - 메모리 배열에 쌓고
 *   - 등록된 sink(현재는 console 뿐)에 넘긴다.
 *
 * 3단계(Supabase)는 `addSink(e => queue.push(e))` 한 줄과 전송 함수만 추가하면 붙는다.
 * 이 파일에는 네트워크 코드도, 키도, Supabase 의존성도 없다.
 *
 * 개인정보는 수집하지 않는다. 세션 식별자는 랜덤 생성값이다.
 */
import type { GameEvent } from '../core/index.ts';

export interface LogRecord extends Record<string, unknown> {
  /** 세션 시작 후 경과 ms. "첫 핵심 행동까지 몇 초" 지표가 이 값에서 나온다. */
  ms: number;
  run: number;
  session: string;
  event: GameEvent;
}

export type LogSink = (r: LogRecord) => void;

export function createLogger(sessionId?: string) {
  const session = sessionId ?? randomId();
  const t0 = Date.now();
  const records: LogRecord[] = [];
  const sinks: LogSink[] = [];
  let run = 0;

  function push(event: GameEvent): void {
    if (event.t === 'run_start') run += 1;
    const r: LogRecord = { ms: Date.now() - t0, run, session, event };
    records.push(r);
    for (const s of sinks) {
      try { s(r); } catch { /* 로깅이 게임을 멈추게 하지 않는다 */ }
    }
  }

  return {
    session,
    get run() { return run; },
    records,
    push,
    addSink(s: LogSink) { sinks.push(s); },
    /** 3단계에서 전송 후 비우기 위한 자리. */
    drain(): LogRecord[] { return records.splice(0, records.length); },
    snapshot(): LogRecord[] { return records.slice(); },
    /** 세션 요약 — G3 지표 4종의 원재료. */
    summary() {
      const runs = new Set(records.map((r) => r.run)).size;
      const firstCombine = records.find((r) => r.event.t === 'combine_ok');
      const wins = records.filter((r) => r.event.t === 'run_end' && r.event.result === 'win').length;
      const fails = records.filter((r) => r.event.t === 'combine_fail' && r.event.reason === 'no_recipe');
      const failPairs = new Map<string, number>();
      for (const f of fails) {
        if (f.event.t !== 'combine_fail') continue;
        const k = [...f.event.inputs].sort().join(' + ');
        failPairs.set(k, (failPairs.get(k) ?? 0) + 1);
      }
      return {
        session,
        runs,
        wins,
        session_ms: Date.now() - t0,
        first_combine_ms: firstCombine ? firstCombine.ms : null,
        failed_pairs: [...failPairs].sort((a, b) => b[1] - a[1]),
        events: records.length,
      };
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;

function randomId(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID();
  return 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
