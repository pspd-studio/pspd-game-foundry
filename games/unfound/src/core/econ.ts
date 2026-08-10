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
}

const num = (rules: Rules, k: string, fb: number): number =>
  (typeof rules[k] === 'number' ? (rules[k] as number) : fb);
const obj = (rules: Rules, k: string, fb: TierMap): TierMap =>
  (rules[k] && typeof rules[k] === 'object' ? (rules[k] as TierMap) : fb);

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
}

/**
 * 판매가. 첫 발견 프리미엄(×2/×2.5/×4) → 티어 풀 포화 감쇠(r^k) 순으로 적용한다.
 * 원본 econ2.mjs의 price()와 같은 식이다 — 이 함수가 유일한 구현이다.
 */
export function priceOf(_D: GameData, R: EconRules, ctx: PriceContext, card: Card): number {
  const tier = card.tier;
  let p = R.basePrice[tier] ?? 2;
  if (card.tier !== 'A' && ctx.codex.has(card.id) && !ctx.initialResults.has(card.id) && !ctx.soldOnce.has(card.id))
    p *= R.firstPremium[tier] ?? 1;
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
}

/** 런의 계약 3건을 뽑는다 (mid n + late m). rng 호출 순서는 원본과 같다. */
export function rollContracts(file: ContractsFile, rng: () => number): RunContract[] {
  const mids = file.contracts.filter((c) => c.slot === 'mid');
  const lates = file.contracts.filter((c) => c.slot === 'late');
  const pickN = (arr: ContractDef[], n: number): ContractDef[] => {
    const a = [...arr];
    const out: ContractDef[] = [];
    for (let i = 0; i < n && a.length; i++) out.push(a.splice(Math.floor(rng() * a.length), 1)[0]);
    return out;
  };
  return [...pickN(mids, file.run_pick.mid), ...pickN(lates, file.run_pick.late)]
    .map((c) => ({ ...c, delivered: 0, done: false, failed: false, kindsDone: new Set<string>() }));
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

/** 계약 한 건 설명문 (UI·로그 공용). */
export function contractLabel(D: GameData, c: ContractDef): string {
  if (c.kind === 'gold') return `자금 ${c.amount}G 보유`;
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

export { pairKey };
