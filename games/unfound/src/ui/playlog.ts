/**
 * v2.1 플레이 로그 수집 seam.
 *
 * 코어(EconSession)는 PlayEvent만 흘리고 아무 곳에도 보내지 않는다. 여기서 그걸 받아
 * 메모리에 쌓고 등록된 sink(콘솔, Supabase)에 넘긴다. 네트워크 코드도 키도 여기 없다.
 *
 * 마찰 계측(피벗 브리프 온보딩 9번)이 이 파일의 두 번째 일이다:
 * 첫 조합·첫 판매·첫 구매·첫 턴종료 도달 시각, 무반응 클릭 수, 동일 실패쌍 반복 횟수.
 *
 * 개인정보는 수집하지 않는다. 세션 식별자는 랜덤 생성값이다.
 */
import type { PlayEvent } from '../core/econSession.ts';

export interface PlayRecord extends Record<string, unknown> {
  /** 세션 시작 후 경과 ms. "첫 핵심 행동까지 몇 초" 지표가 이 값에서 나온다. */
  ms: number;
  run: number;
  session: string;
  event: PlayEvent;
}

export type PlaySink = (r: PlayRecord) => void;

/** 마찰 계측: 아무 일도 일어나지 않은 클릭 (버튼은 눌렸는데 규칙이 막은 경우). */
export interface DeadClick {
  what: string;
  turn: number;
}

export function createPlayLogger(sessionId?: string) {
  const session = sessionId ?? randomId();
  const t0 = Date.now();
  const records: PlayRecord[] = [];
  const sinks: PlaySink[] = [];
  const deadClicks: DeadClick[] = [];
  let run = 0;

  function push(event: PlayEvent): void {
    if (event.t === 'run_start') run += 1;
    const r: PlayRecord = { ms: Date.now() - t0, run, session, event };
    records.push(r);
    for (const s of sinks) {
      try { s(r); } catch { /* 로깅이 게임을 멈추게 하지 않는다 */ }
    }
  }

  /** 눌렀는데 아무 일도 없었던 클릭. 규칙이 이해되지 않는 지점을 잡는다. */
  function deadClick(what: string, turn: number): void {
    deadClicks.push({ what, turn });
  }

  const firstMs = (pred: (e: PlayEvent) => boolean): number | null => {
    const r = records.find((x) => pred(x.event));
    return r ? r.ms : null;
  };

  return {
    session,
    get run() { return run; },
    records,
    push,
    deadClick,
    addSink(s: PlaySink) { sinks.push(s); },
    snapshot(): PlayRecord[] { return records.slice(); },

    /** 세션 요약 — G3 기준 4종 + 마찰 계측 + v2.2 계측(가설·식객·이벤트 응답·심사·연쇄)의 원재료. */
    summary() {
      const runs = new Set(records.map((r) => r.run)).size;
      const ends = records.filter((r) => r.event.t === 'run_end');
      const failedRuns = ends.filter((r) => r.event.t === 'run_end' && r.event.run_fail).length;

      // v2.2 계측 (07 지시서 작업 8) — 전부 run_end/review 이벤트에서 집계한다
      const endEvents = ends.map((r) => r.event as Record<string, unknown>);
      const sum = (k: string): number =>
        endEvents.reduce((s, e) => s + (typeof e[k] === 'number' ? (e[k] as number) : 0), 0);
      const reviews = records
        .filter((r) => r.event.t === 'review')
        .map((r) => r.event as Record<string, unknown>)
        .map((e) => ({ pass: Boolean(e.pass), was_retry: Boolean(e.was_retry), achieved: e.achieved, required: e.required }));

      // 플레이어가 기대했지만 없던 조합 — 다음 콘텐츠의 최고 근거
      const failPairs = new Map<string, number>();
      for (const r of records) {
        if (r.event.t !== 'combine_fail') continue;
        const k = [...r.event.inputs].sort().join(' + ');
        failPairs.set(k, (failPairs.get(k) ?? 0) + 1);
      }
      const deadClickCount = new Map<string, number>();
      for (const d of deadClicks) deadClickCount.set(d.what, (deadClickCount.get(d.what) ?? 0) + 1);

      return {
        session,
        runs,
        runs_failed: failedRuns,
        session_ms: Date.now() - t0,
        first_combine_ms: firstMs((e) => e.t === 'combine_ok'),
        first_sell_ms: firstMs((e) => e.t === 'sell'),
        first_buy_ms: firstMs((e) => e.t === 'buy' || e.t === 'hint'),
        first_turn_end_ms: firstMs((e) => e.t === 'turn_end'),
        failed_pairs: [...failPairs].sort((a, b) => b[1] - a[1]).slice(0, 30),
        repeated_fail_max: Math.max(0, ...failPairs.values()),
        dead_clicks: [...deadClickCount].sort((a, b) => b[1] - a[1]),
        dead_click_total: deadClicks.length,
        events: records.length,
        // v2.2 (07 지시서 작업 8)
        hypotheses_written: sum('hypotheses'),
        hypothesis_hits: sum('hypothesis_hits'),
        guests_joined: sum('guests_joined'),
        guest_turns: sum('guest_turns'),
        merchant_sells: sum('merchant_sells'),
        ledger_blocks: sum('ledger_blocks'),
        max_chain_per_run: endEvents.map((e) => (typeof e.max_chain === 'number' ? e.max_chain : 0)),
        reviews,
      };
    },
  };
}

export type PlayLogger = ReturnType<typeof createPlayLogger>;

function randomId(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID();
  return 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
