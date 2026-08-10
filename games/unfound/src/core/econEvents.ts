/**
 * UNFOUND v2.2 이벤트 덱 (같은 꿈 소동 · 바깥 장수 · 저울의 날).
 *
 * SSOT 이벤트 덱 절:
 *   - 이벤트는 고르지 않는다 — 닥침 + 예고 (날씨).
 *   - 동시 활성 최대 2개 (게시판 핀 자리 2개가 물리 상한).
 *   - 예고 전용 UI 금지 — 회색 핀 → 색 핀, 수요 칸 금색.
 *   - 첫 판 턴 1~5 이벤트 0개.
 *   - 가격 배수는 곱셈이 아니라 max, 총 상한 ×4 (적용은 econ.ts priceOf).
 *
 * 난수는 **자체 스트림**을 쓴다 (시드에서 파생하되 본류와 분리) — v2.1 G2 수치를 만든
 * 본류 난수 호출 순서를 한 번도 건드리지 않기 위해서다 (07 지시서 불변 조건).
 */
import type { Card, GameData, Region } from './types.ts';
import { makeRng } from './rng.ts';
import { reachableRecipes, type EconRules } from './econ.ts';

export type EventKind = 'dream' | 'merchant';

export interface EventPin {
  kind: EventKind;
  /** 대상 계열 태그 */
  tag: string;
  /** 발동 시작 턴 (그 전은 예고 = 회색 핀) */
  startsAt: number;
  /** 마지막 발동 턴 */
  endsAt: number;
}

/** 저울의 날 — 회기 공고. 이번 회기 신규 복원 goal종이면 단서 1장. */
export interface ScaleDay {
  goal: number;
  rewarded: boolean;
}

/** 이벤트 이름 (UI·로그 공용). */
export const EVENT_NAMES: Record<EventKind, string> = {
  dream: '같은 꿈 소동',
  merchant: '바깥 장수',
};

export class EventDeck {
  private readonly rng: () => number;
  private readonly R: EconRules;
  private readonly tagPool: string[];
  readonly pins: EventPin[] = [];
  readonly scaleDay: ScaleDay | null;
  private readonly quietUntil: number;

  /**
   * @param runIndex 1부터 센다. 첫 판은 턴 1~5 이벤트 0개, 저울의 날도 공고하지 않는다
   *                 (온보딩과 겹치지 않게 — SSOT "이벤트 온보딩 간섭 없음" 검산 유지).
   */
  constructor(D: GameData, R: EconRules, region: Region, seed: number, runIndex: number) {
    this.R = R;
    // 본류(makeRng(seed))와 다른 시드 — 황금비 상수로 밀어 상관을 끊는다.
    this.rng = makeRng(((seed ^ 0x9e3779b9) >>> 0) || 1);
    this.quietUntil = runIndex <= 1 ? R.eventQuietTurnsFirstRun : 1;

    // 대상 계열: 이 지역에서 도달 가능한 결과물(B 이상)의 태그 — 팔 수 없는 계열을 지목하면 빈 이벤트다.
    const tags = new Set<string>();
    for (const r of reachableRecipes(D, region)) {
      const c = D.cardById.get(r.result);
      if (c && c.tier !== 'A') for (const t of c.tags) tags.add(t);
    }
    this.tagPool = [...tags].sort(); // 결정적 순서

    this.scaleDay =
      runIndex > 1 && this.rng() < R.eventScaleDayChance
        ? { goal: R.eventScaleDayCount, rewarded: false }
        : null;
  }

  /** 턴 시작 처리 — 만료 핀 제거 후, 핀 자리가 비면 새 예고를 굴린다. 새로 잡힌 예고를 돌려준다. */
  beginTurn(turn: number): EventPin | null {
    for (let i = this.pins.length - 1; i >= 0; i--)
      if (this.pins[i].endsAt < turn) this.pins.splice(i, 1);

    if (turn <= this.quietUntil || this.pins.length >= 2 || !this.tagPool.length) return null;
    if (this.rng() >= this.R.eventChance) return null;

    const kind: EventKind = this.rng() < 0.5 ? 'dream' : 'merchant';
    const tag = this.tagPool[Math.floor(this.rng() * this.tagPool.length)];
    const pin: EventPin =
      kind === 'dream'
        ? {
            kind, tag,
            startsAt: turn + this.R.eventDreamNotice,
            endsAt: turn + this.R.eventDreamNotice + this.R.eventDreamDuration - 1,
          }
        : {
            kind, tag,
            startsAt: turn + this.R.eventMerchantNotice,
            endsAt: turn + this.R.eventMerchantNotice, // 바깥 장수는 딱 1턴
          };
    this.pins.push(pin);
    return pin;
  }

  /** 이 턴에 활성인 핀들. */
  activePins(turn: number): EventPin[] {
    return this.pins.filter((p) => p.startsAt <= turn && turn <= p.endsAt);
  }

  /** 이 턴에 예고 중인 핀들 (회색 핀). */
  noticePins(turn: number): EventPin[] {
    return this.pins.filter((p) => p.startsAt > turn);
  }

  /** 바깥 장수가 이 턴 활성이면 그 핀 (그 턴 시장 행동으로만 응답 가능, 매입 계열 제한). */
  merchantNow(turn: number): EventPin | null {
    return this.activePins(turn).find((p) => p.kind === 'merchant') ?? null;
  }

  /**
   * 이 카드에 지금 걸리는 이벤트 가격 배수 (max 규칙의 재료 — 합산은 priceOf가 한다).
   * 바깥 장수는 자기 계열만 산다 — 계열 밖 카드에는 ×1.
   */
  multOf(turn: number, card: Card): number {
    let m = 1;
    for (const p of this.activePins(turn)) {
      if (!card.tags.includes(p.tag)) continue;
      m = Math.max(m, p.kind === 'dream' ? this.R.eventDreamMult : this.R.eventMerchantMult);
    }
    return m;
  }
}
