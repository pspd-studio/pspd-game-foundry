/**
 * UNFOUND v2.1 경제 코어 (규칙 층).
 *
 * SSOT v2.1(docs/00-SSOT.md)의 규칙이 사는 유일한 곳이다.
 * - AI 자동 플레이(`econAuto.ts`, 시뮬레이터)와
 * - 사람 플레이 세션(`econSession.ts`, G3 슬라이스 UI)이
 * **여기 있는 같은 함수**를 쓴다. 규칙을 두 번 짜지 않는다.
 *
 * 수치는 전부 rules.json / contracts.json에서 읽는다. 코드 하드코딩 금지.
 */
import type { Card, GameData, Recipe, Region, Rules } from './types.ts';
import { pairKey } from './data.ts';

/* ── 규칙 읽기 ────────────────────────────────────────────────── */

export interface TierMap {
  [tier: string]: number;
}

export interface EconRules {
  fieldSlots: number;
  startingHand: number;
  supply: number;
  discardPerTurn: number;
  runTurns: number;
  draftFromTurn: number;
  unknownAttemptFactor: number;
  startingGold: number;
  basePrice: TierMap;
  firstPremium: TierMap;
  demandPool: TierMap;
  saturationR: number;
  resaleFactor: number;
  buyMarkup: number;
  failSettlement: number;
  /** 단서 1건 가격. rules.json에 키가 없으면 tier B 기본가로 (SSOT: 위키보다 싸야 한다). */
  hintPrice: number;
  /** 유니크(고티어) 조합으로 취급할 티어. */
  uniqueTier: string;
  /**
   * 유니크 조합 성공률 (성공/실패 2분포, 실패해도 재료는 남는다).
   * SSOT 미확정 항목 — rules.json의 `v2_unique_success_rate`가 유일한 값이다.
   * 1.0이면 현행 유지(= G2 시뮬과 같은 상태)라서 사람 지표와 시뮬 지표를 같은 자로 비교할 수 있다.
   */
  uniqueSuccess: number;
  /** 시작 패에 보장할 **서로 다른** 확정 조합 수. */
  startingMinRecipes: number;
  /** 시작 패에서 같은 카드가 나올 수 있는 최대 장수. */
  startingMaxDuplicate: number;
  /** 공급 후보 3장을 서로 다르게 뽑을지. */
  supplyDistinct: boolean;

  /* ── v2.2 (2026-08-10 패치) — 전부 스위치. OFF면 v2.1과 완전히 같은 동작·난수 순서다. ── */

  /** 이벤트 덱 (같은 꿈 소동·바깥 장수·저울의 날). */
  eventsOn: boolean;
  /** 가격 배수 총 상한 (프리미엄 포함, max 규칙 — SSOT "곱셈 금지"). */
  eventPriceCap: number;
  /** 턴당 이벤트 예고가 뜰 확률 (핀 자리가 빌 때). */
  eventChance: number;
  /** 첫 판(1회기)에서 이벤트가 잠드는 턴 수 (SSOT: 첫 판 턴 1~5 이벤트 0개). */
  eventQuietTurnsFirstRun: number;
  eventDreamMult: number;
  eventDreamNotice: number;
  eventDreamDuration: number;
  eventMerchantMult: number;
  eventMerchantNotice: number;
  /** 저울의 날 — 이번 회기 신규 복원 목표 종 수 (달성 시 단서 1장). */
  eventScaleDayCount: number;
  /** 저울의 날이 회기 시작에 공고될 확률. */
  eventScaleDayChance: number;

  /** 승급 심사 「저울질」. */
  reviewOn: boolean;
  reviewFirstAfterRuns: number;
  reviewEveryRuns: number;
  reviewFirstCount: number;
  reviewCount: number;
  reviewRetryAfterRuns: number;
  /** 등급별 tier C 신규 복원 요구 (도제=1, 등급마다 1단계 상승 — SSOT 장기 시계). */
  reviewTierCReq: number[];

  /** 계약 게시판 수주 (분모 3 고정 — 미수주 = 자동 미달). */
  contractBoardOn: boolean;
  /** 실패쌍 장부 자동 기록 — 동일 실패쌍 재시도는 상한을 소모하지 않는다. */
  failLedgerOn: boolean;
  /** 온보딩(push+시장 잠금)을 첫 런 한정으로. 2런차부터 턴 1 드래프트·시장 개방. */
  onboardingFirstRunOnly: boolean;
  /** 난이도 튜닝 손잡이: mid 계약 요구 수량 보정 (음수 = 하향, 최소 1). */
  midCountOffset: number;
  /** 중간 마감 턴 재배치 (SSOT v2.2 "중간 마감 10턴"). 0이면 계약 데이터 원본(8턴) 유지. */
  midDeadline: number;
}

/** 5급 명칭 (SSOT 장기 시계 — 견습→도제→공인→장인→명장). 데이터가 아니라 규칙 어휘라 여기 산다. */
export const GRADE_NAMES = ['견습', '도제', '공인', '장인', '명장'] as const;

const num = (rules: Rules, k: string, fb: number): number =>
  (typeof rules[k] === 'number' ? (rules[k] as number) : fb);
const obj = (rules: Rules, k: string, fb: TierMap): TierMap =>
  (rules[k] && typeof rules[k] === 'object' ? (rules[k] as TierMap) : fb);
const flag = (rules: Rules, k: string, fb: boolean): boolean =>
  (rules[k] === undefined ? fb : rules[k] === true || rules[k] === 1);
const nums = (rules: Rules, k: string, fb: number[]): number[] =>
  (Array.isArray(rules[k]) ? (rules[k] as number[]) : fb);

export function readEconRules(rules: Rules): EconRules {
  const basePrice = obj(rules, 'v2_base_price', { A: 4, B: 12, C: 30 });
  return {
    fieldSlots: num(rules, 'field_slots', 7),
    startingHand: num(rules, 'starting_hand', 7),
    supply: num(rules, 'supply_candidates_per_turn', 3),
    discardPerTurn: num(rules, 'discard_per_turn', 1),
    runTurns: num(rules, 'v2_run_turns', 22),
    draftFromTurn: num(rules, 'v2_draft_from_turn', 4),
    unknownAttemptFactor: num(rules, 'v2_unknown_attempt_factor', 2),
    startingGold: num(rules, 'v2_starting_gold', 10),
    basePrice,
    firstPremium: obj(rules, 'v2_first_premium', { A: 2.0, B: 2.5, C: 4.0 }),
    demandPool: obj(rules, 'v2_demand_pool', { A: 10, B: 8, C: 4 }),
    saturationR: num(rules, 'v2_saturation_r', 0.85),
    resaleFactor: num(rules, 'v2_resale_factor', 0.5),
    buyMarkup: num(rules, 'v2_buy_markup', 1.0),
    failSettlement: num(rules, 'v2_fail_settlement', 0.5),
    hintPrice: num(rules, 'v2_hint_price', basePrice.B ?? 12),
    uniqueTier: typeof rules['v2_unique_tier'] === 'string' ? (rules['v2_unique_tier'] as string) : 'C',
    uniqueSuccess: num(rules, 'v2_unique_success_rate', 1.0),
    startingMinRecipes: num(rules, 'v2_starting_min_recipes', 2),
    startingMaxDuplicate: num(rules, 'v2_starting_max_duplicate', 2),
    supplyDistinct: rules['v2_supply_distinct'] === undefined ? true : rules['v2_supply_distinct'] === true,

    // v2.2 — 스위치 기본값은 전부 OFF. 켜는 것은 rules.json이 한다 (G2 재현이 기본이어야 한다).
    eventsOn: flag(rules, 'v22_events', false),
    eventPriceCap: num(rules, 'v22_event_price_cap', 4),
    eventChance: num(rules, 'v22_event_chance', 0.25),
    eventQuietTurnsFirstRun: num(rules, 'v22_event_quiet_turns_first_run', 5),
    eventDreamMult: num(rules, 'v22_event_dream_mult', 2),
    eventDreamNotice: num(rules, 'v22_event_dream_notice', 3),
    eventDreamDuration: num(rules, 'v22_event_dream_duration', 3),
    eventMerchantMult: num(rules, 'v22_event_merchant_mult', 2),
    eventMerchantNotice: num(rules, 'v22_event_merchant_notice', 1),
    eventScaleDayCount: num(rules, 'v22_event_scale_day_count', 3),
    eventScaleDayChance: num(rules, 'v22_event_scale_day_chance', 0.35),
    reviewOn: flag(rules, 'v22_review', false),
    reviewFirstAfterRuns: num(rules, 'v22_review_first_after_runs', 2),
    reviewEveryRuns: num(rules, 'v22_review_every_runs', 3),
    reviewFirstCount: num(rules, 'v22_review_first_count', 8),
    reviewCount: num(rules, 'v22_review_count', 12),
    reviewRetryAfterRuns: num(rules, 'v22_review_retry_after_runs', 2),
    reviewTierCReq: nums(rules, 'v22_review_tier_c_req', [1, 2, 3, 4]),
    contractBoardOn: flag(rules, 'v22_contract_board', false),
    failLedgerOn: flag(rules, 'v22_fail_ledger', false),
    onboardingFirstRunOnly: flag(rules, 'v22_onboarding_first_run_only', false),
    midCountOffset: num(rules, 'v22_mid_count_offset', 0),
    midDeadline: num(rules, 'v22_mid_deadline', 0),
  };
}

/* ── 계열(태그) 친화도 ───────────────────────────────────────── */

/** 전체 레시피의 태그쌍 빈도. "계열 규칙성"을 학습한 플레이어의 사전 지식 모델. */
export function buildAffinity(D: GameData): Map<string, number> {
  const freq = new Map<string, number>();
  for (const r of D.recipes) {
    const a = D.cardById.get(r.inputs[0]);
    const b = D.cardById.get(r.inputs[1]);
    if (!a || !b) continue;
    for (const ta of a.tags) for (const tb of b.tags) {
      const k = [ta, tb].sort().join('|');
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
  }
  return freq;
}

export function affinityScore(D: GameData, aff: Map<string, number>, idA: string, idB: string): number {
  const a = D.cardById.get(idA);
  const b = D.cardById.get(idB);
  if (!a || !b) return 0;
  let s = 0;
  for (const ta of a.tags) for (const tb of b.tags) s += aff.get([ta, tb].sort().join('|')) ?? 0;
  return s;
}

/** 지역 풀에서 도달 가능한 레시피 (재료가 풀 카드 또는 풀에서 파생 가능한 결과물). */
export function reachableRecipes(D: GameData, region: Region): Recipe[] {
  const have = new Set(region.card_pool);
  let grew = true;
  const ok = new Set<string>();
  while (grew) {
    grew = false;
    for (const r of D.recipes) {
      if (ok.has(r.id)) continue;
      if (have.has(r.inputs[0]) && have.has(r.inputs[1])) {
        ok.add(r.id);
        if (!have.has(r.result)) { have.add(r.result); grew = true; }
      }
    }
  }
  return [...ok].map((id) => D.recipes.find((r) => r.id === id)!).filter(Boolean);
}

/**
 * 실패 근접 신호의 임계값. SSOT: 실패도 추론 재료여야 하므로
 * "아무 일 없음"과 "부글거리다 멎음"을 구분한다.
 * 실제 레시피 쌍들의 친화 점수 분포에서 하위 25%를 기준선으로 삼는다 —
 * 즉 진짜 레시피 4개 중 3개는 '따뜻함'으로 잡힌다.
 */
export function nearMissThreshold(D: GameData, aff: Map<string, number>): number {
  const scores = D.recipes
    .map((r) => affinityScore(D, aff, r.inputs[0], r.inputs[1]))
    .sort((a, b) => a - b);
  if (!scores.length) return 0;
  return scores[Math.floor(scores.length * 0.25)];
}

/* ── 필드 계산 ───────────────────────────────────────────────── */

export function slotUsed(D: GameData, field: string[]): number {
  return field.reduce((s, id) => s + (D.cardById.get(id)?.slot_cost ?? 0), 0);
}

export function pairsOf(field: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < field.length; i++)
    for (let j = i + 1; j < field.length; j++) out.push([i, j]);
  return out;
}

/* ── 가격 ────────────────────────────────────────────────────── */

export interface PriceContext {
  /** 이번 런에서 발견한 결과물 id */
  codex: Set<string>;
  /** 런 시작 시점에 이미 알고 있던 결과물 (프리미엄 제외 대상) */
  initialResults: Set<string>;
  /** 첫 판매 프리미엄을 이미 쓴 결과물 */
  soldOnce: Set<string>;
  /** 티어별 누적 판매 유닛 */
  tierSold: TierMap;
  saturationOff?: boolean;
  /**
   * v2.2 이벤트 가격 배수 (같은 꿈 소동·바깥 장수). 없으면 ×1.
   * 배수끼리는 곱하지 않고 **max**로 겹치고 총 상한은 eventPriceCap이다
   * (SSOT 이벤트 덱 — "가격 배수는 곱셈이 아니라 max, 총 상한 ×4". 프리미엄 포함).
   */
  eventMultOf?: (card: Card) => number;
}

/**
 * 판매가. 배수(첫 발견 프리미엄 ×2/×2.5/×4, 이벤트 배수)를 max로 겹쳐 상한 ×4까지 적용한 뒤
 * 티어 풀 포화 감쇠(r^k)를 곱한다. 이벤트가 없으면 원본 econ2.mjs의 price()와 같은 값이 나온다 —
 * 이 함수가 유일한 구현이다.
 */
export function priceOf(_D: GameData, R: EconRules, ctx: PriceContext, card: Card): number {
  const tier = card.tier;
  let p = R.basePrice[tier] ?? 2;
  let boost = 1;
  if (card.tier !== 'A' && ctx.codex.has(card.id) && !ctx.initialResults.has(card.id) && !ctx.soldOnce.has(card.id))
    boost = Math.max(boost, R.firstPremium[tier] ?? 1);
  if (ctx.eventMultOf) boost = Math.max(boost, ctx.eventMultOf(card));
  p *= Math.min(boost, R.eventPriceCap);
  const over = (ctx.tierSold[tier] ?? 0) - (R.demandPool[tier] ?? 99);
  if (!ctx.saturationOff && over >= 0) p *= Math.pow(R.saturationR, over + 1);
  return Math.round(p);
}

/** 첫 발견 프리미엄이 아직 살아 있는가 (UI 배지용). */
export function hasPremium(_D: GameData, ctx: PriceContext, card: Card): boolean {
  return card.tier !== 'A' && ctx.codex.has(card.id) && !ctx.initialResults.has(card.id) && !ctx.soldOnce.has(card.id);
}

/* ── 계약 ────────────────────────────────────────────────────── */

export interface ContractDef {
  id: string;
  slot: 'mid' | 'late' | string;
  deadline: number;
  kind: 'tier_count' | 'distinct_tier' | 'discovery' | 'gold' | 'specific' | string;
  count?: number;
  tier?: string;
  amount?: number;
  reward: number;
  options?: string[];
  distinct?: boolean;
}

export interface ContractsFile {
  contracts: ContractDef[];
  run_pick: { mid: number; late: number };
}

export interface RunContract extends ContractDef {
  delivered: number;
  done: boolean;
  failed: boolean;
  kindsDone: Set<string>;
  /**
   * v2.2 게시판 수주 — false면 아직 게시 중인 어음이다 (납품 불가, 마감 지나면 자동 미달).
   * 게시판 스위치가 꺼져 있으면 항상 true (v2.1 자동 배정과 동일).
   */
  claimed: boolean;
}

/** v2.2 난이도 손잡이를 계약 한 건에 적용한다 (mid 수량 보정 + 중간 마감 재배치). */
export function tuneContract(c: ContractDef, midCountOffset: number, midDeadline: number): ContractDef {
  if (c.slot !== 'mid') return c;
  return {
    ...c,
    count: typeof c.count === 'number' ? Math.max(1, c.count + midCountOffset) : c.count,
    deadline: midDeadline > 0 ? midDeadline : c.deadline,
  };
}

/**
 * 런의 계약 3건을 뽑는다 (mid n + late m). rng 호출 순서는 원본과 같다.
 * midCountOffset·midDeadline은 난이도 튜닝 손잡이 (rules.json v22_*) — 0이면 원본과 동일.
 */
export function rollContracts(
  file: ContractsFile, rng: () => number, midCountOffset = 0, claimed = true, midDeadline = 0,
): RunContract[] {
  const mids = file.contracts.filter((c) => c.slot === 'mid');
  const lates = file.contracts.filter((c) => c.slot === 'late');
  const pickN = (arr: ContractDef[], n: number): ContractDef[] => {
    const a = [...arr];
    const out: ContractDef[] = [];
    for (let i = 0; i < n && a.length; i++) out.push(a.splice(Math.floor(rng() * a.length), 1)[0]);
    return out;
  };
  return [...pickN(mids, file.run_pick.mid), ...pickN(lates, file.run_pick.late)]
    .map((c) => ({
      ...tuneContract(c, midCountOffset, midDeadline),
      delivered: 0, done: false, failed: false, kindsDone: new Set<string>(), claimed,
    }));
}

/** 이 계약에 납품 가능한 필드 인덱스. 없으면 -1. */
export function contractTargetIndex(
  D: GameData, c: RunContract, field: string[], codex: Set<string>, initialResults: Set<string>,
): number {
  if (c.kind === 'gold') return -1;
  if (c.kind === 'tier_count') return field.findIndex((id) => D.cardById.get(id)?.tier === c.tier);
  if (c.kind === 'distinct_tier')
    return field.findIndex((id) => D.cardById.get(id)?.tier === c.tier && !c.kindsDone.has(id));
  if (c.kind === 'discovery')
    return field.findIndex((id) => D.cardById.get(id)?.tier !== 'A' && codex.has(id) && !initialResults.has(id));
  return field.findIndex((id) => (c.options ?? []).includes(id) && (!c.distinct || !c.kindsDone.has(id)));
}

/** 이 카드가 아직 살아 있는 계약에 필요한가 (UI 경고 + AI 판매 보류용). */
export function neededByContract(
  D: GameData, contracts: RunContract[], turn: number, id: string, codex: Set<string>, initialResults: Set<string>,
): boolean {
  const card = D.cardById.get(id);
  if (!card) return false;
  return contracts.some((c) => {
    if (c.done || c.failed || turn > c.deadline || (c.count ?? 0) - c.delivered <= 0) return false;
    if (c.kind === 'tier_count') return card.tier === c.tier;
    if (c.kind === 'distinct_tier') return card.tier === c.tier && !c.kindsDone.has(id);
    if (c.kind === 'discovery') return codex.has(id) && !initialResults.has(id);
    if (c.kind === 'gold') return false;
    return (c.options ?? []).includes(id) && (!c.distinct || !c.kindsDone.has(id));
  });
}

/** 골드 액수를 행동 환산으로 병기 (벤치마크 문법 3 — "골드 X"는 감이 안 온다). */
export function goldInActions(R: EconRules, amount: number): string {
  const base = R.basePrice.B ?? 12;
  const n = Math.max(1, Math.round(amount / base));
  return `B급 ${n}번 판 값`;
}

/** 계약 한 건 설명문 (UI·로그 공용). R을 주면 골드 계약에 행동 환산을 병기한다. */
export function contractLabel(D: GameData, c: ContractDef, R?: EconRules): string {
  if (c.kind === 'gold')
    return `자금 ${c.amount}G 보유${R ? ` (${goldInActions(R, c.amount ?? 0)})` : ''}`;
  if (c.kind === 'tier_count') return `${c.tier}급 상품 ${c.count}개 납품`;
  if (c.kind === 'distinct_tier') return `서로 다른 ${c.tier}급 상품 ${c.count}종 납품`;
  if (c.kind === 'discovery') return `이 런에서 새로 발견한 상품 ${c.count}개 납품`;
  const names = (c.options ?? []).map((id) => D.cardById.get(id)?.name_ko ?? id).join(' / ');
  return `${names} 중 ${c.distinct ? '서로 다른 ' : ''}${c.count}개 납품`;
}

/* ── 시작 필드 ───────────────────────────────────────────────── */

/** 이 필드에서 지금 발동 가능한 **서로 다른** 레시피 수. 같은 레시피가 중복 카드로 여러 쌍을 만들어도 1로 센다. */
export function distinctRecipeCount(D: GameData, field: string[]): number {
  const seen = new Set<string>();
  for (const [i, j] of pairsOf(field)) {
    const k = pairKey(field[i], field[j]);
    if (D.recipeByKey.has(k)) seen.add(k);
  }
  return seen.size;
}

/** 카드 한 장 뽑기 — 같은 카드가 이미 상한만큼 있으면 다시 뽑는다 (풀이 작아 중복이 잦다). */
function drawFromPool(region: Region, rng: () => number, have: string[], maxDup: number): string {
  const pool = region.card_pool;
  for (let a = 0; a < 12; a++) {
    const id = pool[Math.floor(rng() * pool.length)];
    if (have.filter((x) => x === id).length < maxDup) return id;
  }
  return pool[Math.floor(rng() * pool.length)]; // 풀이 너무 작아 못 피하면 그냥 준다
}

/**
 * 시작 필드 7장.
 *
 * **서로 다른 확정 조합 2개 이상**을 보장한다 (시드 보정, 최대 40회 재추첨).
 * 2026-08-10 정정: 예전에는 "쌍"의 개수를 셌는데, 바람이 3장이면 같은 레시피 하나가 3쌍으로 잡혀
 * 보장을 통과했다. 첫 조합 한 번 하고 나면 손이 죽는 패가 12.0% 나왔다 (2만 판 실측).
 * 같은 카드는 기본 2장까지만 (`v2_starting_max_duplicate`) — 7칸 중 3칸이 같은 카드면 선택이 사라진다.
 */
export function rollStartingField(D: GameData, R: EconRules, region: Region, rng: () => number): string[] {
  let best: string[] = [];
  let bestScore = -1;
  for (let tries = 0; tries < 40; tries++) {
    const field: string[] = [];
    for (let i = 0; i < R.startingHand; i++)
      field.push(drawFromPool(region, rng, field, R.startingMaxDuplicate));
    const distinct = distinctRecipeCount(D, field);
    if (distinct > bestScore) { bestScore = distinct; best = field; }
    if (distinct >= R.startingMinRecipes) break;
  }
  return best; // 40회를 다 써도 그때까지 가장 나은 패를 준다 (빈손보다 낫다)
}

/**
 * 이번 턴 공급 후보 (턴 1~3은 push 3장, 이후는 이 중 1장 드래프트).
 * 후보끼리는 서로 다르게 뽑는다 — 같은 카드 3장을 놓고 "골라라"는 선택지가 아니다 (실측 1.2%).
 */
export function rollSupply(R: EconRules, region: Region, rng: () => number): string[] {
  const out: string[] = [];
  const maxDup = R.supplyDistinct ? 1 : R.supply;
  for (let i = 0; i < R.supply; i++) out.push(drawFromPool(region, rng, out, maxDup));
  return out;
}

/* ── 정산 ────────────────────────────────────────────────────── */

export interface Settlement {
  fulfilled: number;
  contractsTotal: number;
  runFail: boolean;
  gold: number;
  settle: number;
}

/** 계약 2/3 미달 = 런 실패. 실패 런 정산 재화 ≤ 성공 런의 50%. */
export function settleRun(R: EconRules, contracts: RunContract[], gold: number): Settlement {
  const fulfilled = contracts.filter((c) => c.done).length;
  const runFail = fulfilled < contracts.length - 1;
  return {
    fulfilled,
    contractsTotal: contracts.length,
    runFail,
    gold,
    settle: runFail ? Math.round(gold * R.failSettlement) : gold,
  };
}

/* ── 승급 심사 「저울질」 (v2.2 — SSOT 장기 시계) ─────────────────
   1회기 = 1런. 첫 심사는 2회기 종료 시, 이후 3회기마다 자동 판정 (신청·비용 없음).
   잣대는 도감 단일축: 심사 창(직전 심사 이후) 신규 복원 종 수 + tier C 조건.
   낙방 = 강등·몰수 없음, 유예 + 2런 뒤 재심. 보상 "공간 1개"는 슬라이스에선 문구 스텁. */

export interface CareerState {
  /** 0=견습 … 4=명장 (GRADE_NAMES 인덱스) */
  grade: number;
  /** 마친 회기(런) 수 */
  runsDone: number;
  /** 이 회기 수를 마치는 순간 심사가 열린다 */
  nextReviewAfter: number;
  /** 심사 창 안의 신규 복원 종 수 (계정 도감에 새로 등재된 결과물) */
  newSinceReview: number;
  /** 그중 tier C */
  cNewSinceReview: number;
  firstReviewDone: boolean;
  /** 직전 심사 낙방 — 유예 중 (2런 뒤 재심) */
  deferred: boolean;
}

export function newCareer(R: EconRules): CareerState {
  return {
    grade: 0, runsDone: 0, nextReviewAfter: R.reviewFirstAfterRuns,
    newSinceReview: 0, cNewSinceReview: 0, firstReviewDone: false, deferred: false,
  };
}

export interface ReviewResult {
  held: boolean;
  pass: boolean;
  wasRetry: boolean;
  required: number;
  achieved: number;
  tierCRequired: number;
  tierCAchieved: number;
  /** 심사 직후 등급 (GRADE_NAMES 인덱스) */
  grade: number;
}

/** 다음 심사까지 남은 회기 수 (0이면 이번 정산이 심사다). 명장은 null. */
export function runsUntilReview(cs: CareerState): number | null {
  if (cs.grade >= GRADE_NAMES.length - 1) return null;
  return Math.max(0, cs.nextReviewAfter - cs.runsDone);
}

/** 현재 심사 창의 요구치. */
export function reviewRequirement(R: EconRules, cs: CareerState): { count: number; tierC: number } {
  return {
    count: cs.firstReviewDone ? R.reviewCount : R.reviewFirstCount,
    tierC: R.reviewTierCReq[Math.min(cs.grade, R.reviewTierCReq.length - 1)] ?? 0,
  };
}

/**
 * 회기 하나를 마감한다 — 신규 복원 수를 창에 누적하고, 때가 되면 심사를 연다.
 * cs를 제자리에서 고친다 (호출자가 세션 간 상태를 들고 있다 — localStorage 금지, SSOT).
 */
export function endRunCareer(
  R: EconRules, cs: CareerState, newDiscoveries: number, newCDiscoveries: number,
): ReviewResult {
  cs.runsDone++;
  cs.newSinceReview += newDiscoveries;
  cs.cNewSinceReview += newCDiscoveries;

  const noMore = cs.grade >= GRADE_NAMES.length - 1; // 명장 — 전당 기록 전환, 심사 없음
  const req = reviewRequirement(R, cs);
  const base: ReviewResult = {
    held: false, pass: false, wasRetry: cs.deferred,
    required: req.count, achieved: cs.newSinceReview,
    tierCRequired: req.tierC, tierCAchieved: cs.cNewSinceReview, grade: cs.grade,
  };
  if (noMore || cs.runsDone < cs.nextReviewAfter) return base;

  const pass = cs.newSinceReview >= req.count && cs.cNewSinceReview >= req.tierC;
  if (pass) {
    cs.grade = Math.min(cs.grade + 1, GRADE_NAMES.length - 1);
    cs.firstReviewDone = true;
    cs.deferred = false;
    cs.newSinceReview = 0;
    cs.cNewSinceReview = 0;
    cs.nextReviewAfter = cs.runsDone + R.reviewEveryRuns;
  } else {
    cs.deferred = true; // 유예 — 창은 리셋하지 않는다 (계속 모아 재심)
    cs.nextReviewAfter = cs.runsDone + R.reviewRetryAfterRuns;
  }
  return { ...base, held: true, pass, grade: cs.grade };
}

/* ── 실패 = 정보: 계열 힌트 1비트 (v2.2) ─────────────────────────
   실패 근접 신호에 계열 힌트를 최소 1비트 보장한다 (SSOT 조합 실패).
   난수를 쓰지 않는다 — 같은 쌍이면 항상 같은 힌트가 나와야 하고(장부 기록과 정합),
   시뮬 난수 순서도 건드리면 안 된다. 두 카드의 태그쌍 중 레시피 빈도가 가장 높은 쌍을 고른다. */

export interface FailHint {
  /** 두 카드에서 뽑은 대표 태그쌍 */
  ta: string;
  tb: string;
  /** 이 태그쌍이 실제 레시피 문법에 있는가 (warm의 근거) */
  grammatical: boolean;
}

export function failHintOf(D: GameData, aff: Map<string, number>, idA: string, idB: string): FailHint | null {
  const a = D.cardById.get(idA);
  const b = D.cardById.get(idB);
  if (!a || !b || !a.tags.length || !b.tags.length) return null;
  let best: FailHint | null = null;
  let bestScore = -1;
  for (const ta of a.tags) for (const tb of b.tags) {
    const s = aff.get([ta, tb].sort().join('|')) ?? 0;
    // 동점이면 사전순 — 결정적이어야 한다
    if (s > bestScore || (s === bestScore && best && `${ta}|${tb}` < `${best.ta}|${best.tb}`)) {
      bestScore = s;
      best = { ta, tb, grammatical: s > 0 };
    }
  }
  return best;
}

export { pairKey };
