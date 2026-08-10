/**
 * UNFOUND v3.0 — 사람 플레이 세션 (G3 수직 슬라이스용).
 *
 * 규칙은 한 줄도 여기서 새로 정하지 않는다. 전부 `econ.ts`의 함수를 부른다.
 * AI 자동 플레이(`econAuto.ts`)와 같은 규칙 위에서 돌아가야, G2 지표와 G3 사람 지표를
 * 같은 자로 잰 것이 된다.
 *
 * v3.0 (2026-08-10 전면 개정 — 07 지시서):
 *   - 필드: 7칸 폐기 → 펼침 자리 12 + 솔리테어 적재 (더미 깊이 무한, 파내기 무료·즉시).
 *     묻힌 카드는 뒷면 — 계열 태그만 노출, 조합·판매·납품 후보 제외.
 *     내부 조작(조합·정리·파내기·아는 레시피)은 무제한 — 카운터는 미발견 시도 상한(턴당 6회)뿐.
 *     펼침 용량은 **새 카드가 들어올 때만** 막는다. 파냄·판매로 드러난 카드가 잠깐 넘치는 것은
 *     허용한다 (SSOT: "비용은 행동이 아니라 정보에").
 *   - 이동: 지역 카드 띠. 이동 1턴(초기값), 이동 중 조합 가능·시장/게시판 불가.
 *   - 파견: 조수 고용(임금) → 탐사/텃밭/채집터 → 예고 턴 귀환, 보따리=재료만.
 *   - 식객 5종 + 밥값: 중간·최종 마감 턴에 식객당 '먹을 것' 1장, 없으면 파업.
 *
 * 이 파일은 네트워크도 DOM도 모른다. 이벤트를 배열에 쌓아 둘 뿐이고,
 * 전송은 ui/remote.ts가, 그리기는 ui/*.ts가 한다.
 */
import type { Card, GameData, Recipe, Region } from './types.ts';
import { makeRng } from './rng.ts';
import {
  affinityScore, allCards, buildAffinity, contractLabel, contractTargetIndex, failHintOf,
  hasPremium, nearMissThreshold, neededByContract, pairKey, pairsOf, priceOf, readEconRules,
  reachableRecipes, rollContracts, rollStartingField, rollSupply, settleRun, spreadOf,
  topOf, tuneContract, unlockedRegionCount,
  type ContractDef, type ContractsFile, type EconRules, type FailHint, type Pile,
  type PriceContext, type RunContract, type Settlement, type TierMap,
} from './econ.ts';
import { EventDeck } from './econEvents.ts';

export type EconData = GameData & { contracts: ContractsFile };

/** data/guests.json — 식객 (공급 풀 밖). */
export interface GuestCard extends Card {
  effect?: string;
  effect_ko?: string;
}
export interface GuestsFile {
  persons: GuestCard[];
  guests: GuestCard[];
  recipes: Recipe[];
}

export type SessionPhase = 'draft' | 'play' | 'over';
export type DispatchDest = 'explore' | 'garden' | 'gather';

/** 행선지 이름 (UI·로그 공용). */
export const DISPATCH_NAMES: Record<DispatchDest, string> = {
  explore: '탐사', garden: '텃밭', gather: '채집터',
};

export interface Hint {
  /** 사람에게 보여줄 문장 */
  text: string;
  /** 이 단서가 가리키는 재료 id (UI 강조용) */
  cardId: string;
  tag: string;
}

export type PlayEvent =
  | { t: 'run_start'; turn: 0; seed: number; region: string; field: string[]; contracts: string[]; run_index: number }
  | { t: 'supply_push'; turn: number; card: string; accepted: boolean }
  | { t: 'draft'; turn: number; taken: string; passed: string[] }
  | { t: 'combine_ok'; turn: number; inputs: [string, string]; result: string; first_time: boolean; known: boolean; chain: number }
  | { t: 'combine_fail'; turn: number; inputs: [string, string]; signal: 'warm' | 'cold'; attempts_left: number; hint_a: string | null; hint_b: string | null; exposed: string | null }
  | { t: 'combine_blocked'; turn: number; reason: 'no_slot' | 'cap' | 'unique_fail' | 'ledger' }
  | { t: 'sell'; turn: number; card: string; gold: number; premium: boolean; to_merchant: boolean }
  | { t: 'buy'; turn: number; card: string; gold: number }
  | { t: 'buy_person'; turn: number; card: string; gold: number }
  | { t: 'hint'; turn: number; card: string; tag: string; gold: number; source: 'buy' | 'appraiser' | 'hypothesis' | 'scale_day' }
  | { t: 'deliver'; turn: number; contract: string; card: string; done: boolean }
  | { t: 'discard'; turn: number; card: string }
  | { t: 'claim'; turn: number; contract: string }
  | { t: 'dig'; turn: number; card: string }
  | { t: 'stack'; turn: number; card: string; onto: string }
  | { t: 'move_start'; turn: number; to: string; cost: number }
  | { t: 'move_end'; turn: number; region: string }
  | { t: 'dispatch'; turn: number; dest: DispatchDest; wage: number; return_turn: number }
  | { t: 'dispatch_return'; turn: number; cards: string[]; person: string | null }
  | { t: 'feed'; turn: number; guest: string; card: string }
  | { t: 'strike'; turn: number; guest: string }
  | { t: 'strike_end'; turn: number; guest: string }
  | { t: 'event_pin'; turn: number; kind: string; tag: string; starts_at: number; ends_at: number }
  | { t: 'scale_day'; turn: number; goal: number }
  | { t: 'scale_day_reward'; turn: number }
  | { t: 'visitor'; turn: number; card: string }
  | { t: 'visitor_accept'; turn: number; card: string }
  | { t: 'visitor_decline'; turn: number; card: string }
  | { t: 'hypothesis'; turn: number; recipe: string; inputs: [string, string] }
  | { t: 'hypothesis_hit'; turn: number; recipe: string }
  | { t: 'hypothesis_miss'; turn: number; recipe: string }
  | { t: 'review'; turn: number; pass: boolean; was_retry: boolean; required: number; achieved: number; grade: number }
  | { t: 'turn_end'; turn: number; gold: number; occupancy: number; combos: number }
  | { t: 'run_end'; turn: number; gold: number; settle: number; run_fail: boolean; fulfilled: number; discovered: string[]; combos: number; hints: number;
      max_chain: number; hypotheses: number; hypothesis_hits: number; ledger_blocks: number;
      guests_joined: number; guest_turns: number; merchant_sells: number;
      moves: number; dispatches: number; feeds: number; strikes: number; digs: number };

export type CombineResult =
  | { ok: true; result: Card; firstTime: boolean; wasKnown: boolean; chain: number }
  | { ok: false; reason: 'no_recipe'; signal: 'warm' | 'cold'; hint: FailHint | null; detail: FailHint | null; exposed: Recipe | null }
  | { ok: false; reason: 'unique_fail'; result: Card }
  | { ok: false; reason: 'ledger' }
  | { ok: false; reason: 'no_slot' | 'cap' | 'bad_index' | 'over' };

export interface SessionOpts {
  regionIdx?: number;
  /** 계정 도감 이월 (2판째 이후). 레시피 key 목록 */
  carryKnown?: string[];
  /** 몇 번째 회기(런)인가 — 1부터. 온보딩 첫 런 한정·이벤트 침묵 규칙이 이 값을 본다. */
  runIndex?: number;
  /** 등급 (0=견습). 지역 출입권(승급 보상=공간)이 이 값을 본다. */
  grade?: number;
  /** 식객 데이터 (data/guests.json). 없으면 식객·방문 이벤트가 꺼진다. */
  guests?: GuestsFile;
  /** 시뮬 전용 — 포화 ON/OFF 대조 지표용. 사람 플레이에서는 쓰지 않는다. */
  saturationOff?: boolean;
}

export class EconSession {
  readonly D: EconData;
  readonly R: EconRules;
  readonly seed: number;
  readonly runIndex: number;
  readonly grade: number;
  private readonly rng: () => number;
  /** 부속 난수 (이벤트·방문·재게시·공짜 단서·파견 보따리) — 본류와 분리된 스트림. */
  private readonly rng2: () => number;
  private readonly aff: Map<string, number>;
  private readonly warmAt: number;

  phase: SessionPhase = 'play';
  turn = 1;
  /** 솔리테어 필드 — 더미 배열. 각 더미의 마지막 원소가 펼친(앞면) 카드다. */
  piles: Pile[] = [];
  regionIdx: number;
  gold: number;
  contracts: RunContract[];
  readonly known = new Set<string>();
  /** 런 시작 시점의 장부 (이월분) — 심사 "신규 복원" 카운트 기준선. */
  private readonly initialKnown: Set<string>;
  readonly codex = new Set<string>();
  readonly initialResults = new Set<string>();
  readonly soldOnce = new Set<string>();
  readonly tierSold: TierMap = { A: 0, B: 0, C: 0 };
  readonly hints: Hint[] = [];
  readonly events: PlayEvent[] = [];

  marketOpen = false;
  /** 찾아온 구매자가 노리는 카드 id (온보딩 3번). 처리 전까지 유지된다. */
  firstBuyer: string | null = null;
  marketActionUsed = false;
  discardLeft: number;
  unknownLeft: number;
  draftCandidates: string[] | null = null;
  combosTotal = 0;
  settlement: Settlement | null = null;
  /** 이번 턴에 이미 실패해 본 쌍 (같은 쌍 재시도는 상한을 깎지 않는다) */
  private triedThisTurn = new Set<string>();

  /* ── v2.2 상태 (유지) ── */
  readonly failedPairs = new Set<string>();
  ledgerBlocks = 0;
  readonly exposed = new Set<string>();
  readonly hypotheses = new Map<string, [string, string]>();
  hypothesisHits = 0;
  readonly eventDeck: EventDeck | null;
  scaleDayProgress = 0;
  pendingVisitor: string | null = null;
  private visitTurns: number[] = [];
  private visitorQueue: string[] = [];
  guestsJoined = 0;
  guestTurns = 0;
  merchantSells = 0;
  private readonly depthOf = new Map<string, number>();
  maxChain = 0;

  /* ── v3.0 상태 ── */
  /** 이동 중 — 도착 지역과 남은 턴. 이동 중에는 공급·시장·게시판이 닫힌다. */
  traveling: { to: number; left: number } | null = null;
  /** 파견 나간 조수 — 행선지와 귀환 턴. 파견 중에는 다시 보낼 수 없다. */
  assistant: { dest: DispatchDest; returnTurn: number } | null = null;
  /** 파업 중인 식객 id (효과 정지 — 밥이 생기면 재개). */
  readonly strikes = new Set<string>();
  /** 이번 런에서 이미 들인(만난) 인물 id — 방문·구매·보따리 중복 방지. */
  private readonly ownedPersons = new Set<string>();
  movesCount = 0;
  dispatchCount = 0;
  feedsCount = 0;
  strikesCount = 0;
  digsCount = 0;

  private readonly guestsFile: GuestsFile | null;
  private readonly gCardById = new Map<string, GuestCard>();
  private readonly gRecipeByKey = new Map<string, Recipe>();
  private readonly saturationOff: boolean = false;

  constructor(D: EconData, seed: number, opts: SessionOpts = {}) {
    this.D = D;
    this.seed = seed;
    this.runIndex = Math.max(1, opts.runIndex ?? 1);
    this.grade = Math.max(0, opts.grade ?? 0);
    this.R = readEconRules(D.rules);
    this.rng = makeRng(seed);
    this.rng2 = makeRng(((seed ^ 0x51ed2701) >>> 0) || 1);
    this.aff = buildAffinity(D);
    this.warmAt = nearMissThreshold(D, this.aff);
    this.regionIdx = Math.min(opts.regionIdx ?? 0, this.unlockedRegions - 1);
    this.saturationOff = opts.saturationOff === true;

    this.guestsFile = opts.guests ?? null;
    if (this.guestsFile) {
      for (const c of [...this.guestsFile.persons, ...this.guestsFile.guests]) this.gCardById.set(c.id, c);
      for (const r of this.guestsFile.recipes) this.gRecipeByKey.set(pairKey(r.inputs[0], r.inputs[1]), r);
    }

    if (opts.carryKnown) {
      for (const k of opts.carryKnown) {
        this.known.add(k);
        const r = D.recipeByKey.get(k) ?? this.gRecipeByKey.get(k);
        if (r) this.initialResults.add(r.result);
      }
    }
    this.initialKnown = new Set(this.known);

    this.contracts = rollContracts(
      D.contracts, this.rng, this.R.midCountOffset, !this.R.contractBoardOn, this.R.midDeadline,
      this.R.lateCountOffset,
    );
    // 시작 펼침 7장 · 더미 0 (쌓기는 8장째에서 자연 발견 — 온보딩)
    this.piles = rollStartingField(D, this.R, this.region, this.rng).map((id) => [id]);
    this.gold = this.R.startingGold;
    this.discardLeft = this.R.discardPerTurn;
    this.unknownLeft = this.R.unknownAttempts;

    // 온보딩(push+시장 잠금)은 첫 런 한정 — 2런차부터 턴 1 드래프트·시장 개방 (플로우 감사 #7)
    if (this.R.onboardingFirstRunOnly && this.runIndex >= 2) this.marketOpen = true;

    this.eventDeck = this.R.eventsOn
      ? new EventDeck(D, this.R, this.accessibleRegions(), seed, this.runIndex)
      : null;

    // 식객 방문 일정 (시드 보정 — 런당 1~2회 보장·상한)
    if (this.guestsFile && this.guestsFile.persons.length) {
      const first = 4 + Math.floor(this.rng2() * 6); // 4~9턴
      this.visitTurns = [first];
      if (this.rng2() < 0.5) {
        const second = first + 3 + Math.floor(this.rng2() * 5);
        if (second <= this.R.runTurns - 2) this.visitTurns.push(second);
      }
      // 방문 순서: 인물 전체를 부속 난수로 섞는다 (풀 밖 지급 — 시드 보정)
      const order = this.guestsFile.persons.map((p) => p.id);
      for (let k = order.length - 1; k > 0; k--) {
        const j = Math.floor(this.rng2() * (k + 1));
        [order[k], order[j]] = [order[j], order[k]];
      }
      this.visitorQueue = order;
    }

    this.push({
      t: 'run_start', turn: 0, seed, region: this.region.id,
      field: spreadOf(this.piles), contracts: this.contracts.map((c) => c.id), run_index: this.runIndex,
    });
    if (this.eventDeck?.scaleDay)
      this.push({ t: 'scale_day', turn: 1, goal: this.eventDeck.scaleDay.goal });

    this.beginTurnV22();
    // 1턴 공급은 즉시 (첫 런의 턴 1~3은 push)
    this.supplyPhase();
  }

  /* ── 조회 ──────────────────────────────────────────────────── */

  card(id: string): Card { return (this.D.cardById.get(id) ?? this.gCardById.get(id))!; }
  guestCard(id: string): GuestCard | null { return this.gCardById.get(id) ?? null; }
  recipeOf(key: string): Recipe | undefined { return this.D.recipeByKey.get(key) ?? this.gRecipeByKey.get(key); }
  get region(): Region { return this.D.regions[this.regionIdx]; }
  /** 등급이 열어 준 지역 수 (승급 보상 = 공간 = 지역 출입권). */
  get unlockedRegions(): number { return unlockedRegionCount(this.R, this.grade, this.D.regions.length); }
  accessibleRegions(): Region[] { return this.D.regions.slice(0, this.unlockedRegions); }
  /** 펼친 카드들 (더미 인덱스 순). */
  get spread(): string[] { return spreadOf(this.piles); }
  get used(): number {
    return this.piles.reduce((s, p) => s + (this.card(topOf(p))?.slot_cost ?? 1), 0);
  }
  get free(): number { return this.R.spreadSlots - this.used; }
  get lastTurn(): number { return this.R.runTurns; }
  /** 이번 런의 실효 드래프트 시작 턴 (2런차부터는 턴 1). */
  get draftFrom(): number {
    return this.R.onboardingFirstRunOnly && this.runIndex >= 2 ? 1 : this.R.draftFromTurn;
  }
  /** 중간 마감 턴 (밥값 리듬이 이 달력을 따른다). */
  get midDeadlineTurn(): number {
    return this.contracts.find((c) => c.slot === 'mid')?.deadline ?? 0;
  }

  private get pctx(): PriceContext {
    return {
      codex: this.codex, initialResults: this.initialResults, soldOnce: this.soldOnce, tierSold: this.tierSold,
      eventMultOf: this.eventDeck ? (c) => this.eventDeck!.multOf(this.turn, c) : undefined,
      demandDelay: this.guestActive('demand_delay') ? this.R.rumorDelay : 0,
      saturationOff: this.saturationOff,
    };
  }

  priceOfCard(id: string): number { return priceOf(this.D, this.R, this.pctx, this.card(id)); }
  /** 지금 팔면 다음 같은 물건 가격은 얼마가 되나 — 시세 투명화 (Moonlighter 반면교사). */
  nextPriceOfCard(id: string): number {
    const c = this.card(id);
    const tierSold = { ...this.tierSold, [c.tier]: (this.tierSold[c.tier] ?? 0) + 1 };
    const soldOnce = new Set(this.soldOnce);
    soldOnce.add(id);
    return priceOf(this.D, this.R, { ...this.pctx, tierSold, soldOnce }, c);
  }
  premiumOn(id: string): boolean { return hasPremium(this.D, this.pctx, this.card(id)); }
  neededForContract(id: string): boolean {
    return neededByContract(this.D, this.activeContracts(), this.turn, id, this.codex, this.initialResults);
  }
  labelOf(c: RunContract): string { return contractLabel(this.D, c, this.R); }
  deliverableIndex(c: RunContract): number {
    if (!c.claimed) return -1;
    return contractTargetIndex(this.D, c, this.spread, this.codex, this.initialResults);
  }
  /** 수주한 계약만 (납품 경고·AI 판단용). */
  private activeContracts(): RunContract[] { return this.contracts.filter((c) => c.claimed); }
  /** 이 지역에서 도달 가능한 레시피 수 (내부용 — 화면에는 전체 개수를 내보이지 않는다). */
  reachableCount(): number { return reachableRecipes(this.D, this.region).length; }
  /** 시장에서 살 수 있는 재료 (지역 풀의 A 카드). */
  buyableCards(): string[] {
    return [...new Set(this.region.card_pool)].filter((id) => this.card(id).tier === 'A');
  }
  buyCost(): number { return Math.round(this.R.basePrice.A * this.R.buyMarkup); }
  hintCost(): number { return this.R.hintPrice; }
  /** 아직 만나지 않은 떠도는 인물 (시장 소개 대상). */
  availablePersons(): GuestCard[] {
    return (this.guestsFile?.persons ?? []).filter((p) => !this.ownedPersons.has(p.id));
  }
  /** 이 식객 효과가 지금 켜져 있는가 (펼쳐진 동안만 발동, 파업이면 정지). */
  guestActive(effect: string): boolean {
    return this.spread.some((id) => this.gCardById.get(id)?.effect === effect && !this.strikes.has(id));
  }
  /** 인물·식객은 팔거나 납품할 수 없다 (tier P/G). */
  isPersonLike(id: string): boolean {
    const t = this.card(id)?.tier;
    return t === 'P' || t === 'G';
  }
  /** 필드의 펼친 식객들. */
  spreadGuests(): string[] {
    return this.spread.filter((id) => this.gCardById.get(id)?.effect);
  }
  /** 필드 어딘가의 '먹을 것' 카드 수 (밥값 UI용). */
  foodCount(): number {
    return allCards(this.piles).filter((id) => this.card(id).tags.includes('food')).length;
  }

  private push(e: PlayEvent): void { this.events.push(e); }

  /* ── v3.0 배치 — 펼침 용량은 새 카드가 들어올 때만 검사한다 ── */

  /**
   * 새 카드를 필드에 놓는다. stackOn을 주면 그 더미 위에 쌓고(묻는다), 없으면
   * 빈 자리에 펼치되 자리가 없으면 자동으로 더미 위에 얹는다 (A 카드 우선).
   */
  placeCard(id: string, stackOn?: number): boolean {
    const cost = this.card(id).slot_cost;
    if (stackOn !== undefined && stackOn >= 0 && stackOn < this.piles.length) {
      const top = this.card(topOf(this.piles[stackOn]));
      if (this.isPersonLike(topOf(this.piles[stackOn]))) return false; // 사람 위에 얹지 않는다
      if (cost - top.slot_cost > this.free) return false;
      const onto = topOf(this.piles[stackOn]);
      this.piles[stackOn].push(id);
      this.push({ t: 'stack', turn: this.turn, card: id, onto });
      return true;
    }
    if (this.free >= cost) { this.piles.push([id]); return true; }
    // 자동 쌓기 — A 카드 더미 우선
    let best = -1;
    for (let k = 0; k < this.piles.length; k++) {
      const topId = topOf(this.piles[k]);
      if (this.isPersonLike(topId)) continue;
      const delta = cost - this.card(topId).slot_cost;
      if (delta > this.free) continue;
      if (best < 0 || (this.card(topId).tier === 'A' && this.card(topOf(this.piles[best])).tier !== 'A'))
        best = k;
    }
    if (best < 0) return false;
    const onto = topOf(this.piles[best]);
    this.piles[best].push(id);
    this.push({ t: 'stack', turn: this.turn, card: id, onto });
    return true;
  }

  /** 파내기 — 묻힌 카드를 그 더미 맨 위로. 무료·즉시 (내부 조작 무제한). */
  dig(pi: number, depth: number): boolean {
    if (this.phase === 'over' || pi < 0 || pi >= this.piles.length) return false;
    const p = this.piles[pi];
    if (depth < 0 || depth >= p.length - 1) return false; // 맨 위는 이미 펼쳐져 있다
    const [card] = p.splice(depth, 1);
    p.push(card);
    this.digsCount++;
    this.push({ t: 'dig', turn: this.turn, card });
    return true;
  }

  /** 펼치기 — 더미 맨 위 카드를 빈 자리로 꺼내 새 더미로 만든다. 드러나는 아랫장만큼 자리가 필요하다. */
  unstack(pi: number): boolean {
    if (this.phase === 'over' || pi < 0 || pi >= this.piles.length) return false;
    const p = this.piles[pi];
    if (p.length < 2) return false;
    const revealed = this.card(p[p.length - 2]);
    if (this.free < revealed.slot_cost) return false;
    const id = p.pop()!;
    this.piles.push([id]);
    this.push({ t: 'dig', turn: this.turn, card: id });
    return true;
  }

  /** 정리 — 한 더미의 펼친 카드를 다른 더미 위로 옮겨 묻는다. 무료 (내부 조작 무제한). */
  restack(fromPi: number, toPi: number): boolean {
    if (this.phase === 'over' || fromPi === toPi) return false;
    if (fromPi < 0 || fromPi >= this.piles.length || toPi < 0 || toPi >= this.piles.length) return false;
    if (this.isPersonLike(topOf(this.piles[toPi]))) return false;
    const card = this.piles[fromPi].pop()!;
    const onto = topOf(this.piles[toPi]);
    this.piles[toPi].push(card);
    if (!this.piles[fromPi].length) this.piles.splice(fromPi, 1);
    this.push({ t: 'stack', turn: this.turn, card, onto });
    return true;
  }

  /* ── v2.2 턴 시작 처리 (이벤트 핀 · 방문 인물) ─────────────── */

  private beginTurnV22(): void {
    if (this.eventDeck) {
      const pin = this.eventDeck.beginTurn(this.turn);
      if (pin)
        this.push({ t: 'event_pin', turn: this.turn, kind: pin.kind, tag: pin.tag, starts_at: pin.startsAt, ends_at: pin.endsAt });
    }
    if (this.traveling) return; // 이동 중에는 아무도 가게 앞에 오지 않는다
    if (this.visitTurns.includes(this.turn) && this.visitorQueue.length && !this.pendingVisitor) {
      const next = this.visitorQueue.find((pid) => !this.ownedPersons.has(pid));
      if (next) {
        this.pendingVisitor = next;
        this.visitorQueue = this.visitorQueue.filter((x) => x !== next);
        this.push({ t: 'visitor', turn: this.turn, card: next });
      }
    }
  }

  acceptVisitor(): boolean {
    if (!this.pendingVisitor) return false;
    const id = this.pendingVisitor;
    if (!this.placeCard(id)) return false;
    this.ownedPersons.add(id);
    this.pendingVisitor = null;
    this.push({ t: 'visitor_accept', turn: this.turn, card: id });
    return true;
  }

  declineVisitor(): void {
    if (!this.pendingVisitor) return;
    this.push({ t: 'visitor_decline', turn: this.turn, card: this.pendingVisitor });
    this.pendingVisitor = null;
  }

  /* ── 공급 ──────────────────────────────────────────────────── */

  private supplyPhase(): void {
    if (this.traveling) { this.phase = 'play'; this.draftCandidates = null; return; } // 길 위에는 경매가 없다
    const count = this.R.supply + (this.guestActive('draft_plus') ? this.R.porterExtra : 0);
    const candidates = rollSupply(this.R, this.region, this.rng, count);
    if (this.turn < this.draftFrom) {
      for (const id of candidates) {
        const ok = this.placeCard(id);
        this.push({ t: 'supply_push', turn: this.turn, card: id, accepted: ok });
      }
      this.phase = 'play';
      this.draftCandidates = null;
    } else {
      this.draftCandidates = candidates;
      this.phase = 'draft';
    }
  }

  /** 드래프트: 후보 중 1장 선택, 나머지는 소멸. idx<0이면 전부 포기. stackOn으로 쌓을 더미 지정 가능. */
  takeDraft(idx: number, stackOn?: number): boolean {
    if (this.phase !== 'draft' || !this.draftCandidates) return false;
    const cands = this.draftCandidates;
    const taken = idx >= 0 ? cands[idx] : null;
    if (taken) {
      if (!this.placeCard(taken, stackOn)) return false;
    }
    this.push({ t: 'draft', turn: this.turn, taken: taken ?? '', passed: cands.filter((_, i) => i !== idx) });
    this.draftCandidates = null;
    this.phase = 'play';
    return true;
  }

  /* ── 조합 (펼친 카드 두 장 = 더미 두 개의 맨 위) ─────────────── */

  combine(i: number, j: number): CombineResult {
    if (this.phase !== 'play') return { ok: false, reason: 'over' };
    if (i === j || i < 0 || j < 0 || i >= this.piles.length || j >= this.piles.length)
      return { ok: false, reason: 'bad_index' };

    const idA = topOf(this.piles[i]);
    const idB = topOf(this.piles[j]);
    const key = pairKey(idA, idB);
    const recipe = this.recipeOf(key);
    const wasKnown = this.known.has(key);
    const inputs: [string, string] = [idA, idB];

    // 실패쌍 장부 — 같은 쌍 재시도는 상한을 깎지 않고 차단한다 ("장부에 이미 적어 두었다")
    if (this.R.failLedgerOn && !recipe && this.failedPairs.has(key)) {
      this.ledgerBlocks++;
      this.push({ t: 'combine_blocked', turn: this.turn, reason: 'ledger' });
      return { ok: false, reason: 'ledger' };
    }

    // 미발견 시도 상한 (아는 레시피 실행은 무제한 — 솔리테어 원칙)
    if (!wasKnown && !this.triedThisTurn.has(key) && this.unknownLeft <= 0) {
      this.push({ t: 'combine_blocked', turn: this.turn, reason: 'cap' });
      return { ok: false, reason: 'cap' };
    }

    if (!recipe) {
      if (!this.triedThisTurn.has(key)) { this.unknownLeft--; this.triedThisTurn.add(key); }
      this.failedPairs.add(key);
      const signal: 'warm' | 'cold' =
        affinityScore(this.D, this.aff, inputs[0], inputs[1]) >= this.warmAt ? 'warm' : 'cold';
      // 실패 = 정보: 계열 힌트 1비트 보장 + (warm이면) 실루엣 노출
      const hint = failHintOf(this.D, this.aff, inputs[0], inputs[1]);
      const exposedRecipe = signal === 'warm' ? this.exposeNear(inputs) : null;
      // 야경꾼: 근접 신호 1단계 상세 — 문법에 맞는 대안 태그쌍을 하나 더 흘린다
      const detail = this.guestActive('fail_detail') ? this.detailHint(inputs, hint) : null;
      this.push({
        t: 'combine_fail', turn: this.turn, inputs, signal, attempts_left: this.unknownLeft,
        hint_a: hint?.ta ?? null, hint_b: hint?.tb ?? null, exposed: exposedRecipe?.id ?? null,
      });
      return { ok: false, reason: 'no_recipe', signal, hint, detail, exposed: exposedRecipe };
    }

    const res = this.card(recipe.result);
    // 내부 조작은 원칙적으로 막지 않는다 — 결과가 재료 둘을 비운 자리조차 넘칠 때만 차단.
    const freed = this.card(idA).slot_cost + this.card(idB).slot_cost;
    if (this.used - freed + res.slot_cost > this.R.spreadSlots) {
      this.push({ t: 'combine_blocked', turn: this.turn, reason: 'no_slot' });
      return { ok: false, reason: 'no_slot' };
    }

    if (!wasKnown && !this.triedThisTurn.has(key)) { this.unknownLeft--; this.triedThisTurn.add(key); }

    // 유니크(고티어) 조합은 성공/실패 2분포. 실패해도 재료는 남는다 (SSOT v2.1).
    if (res.tier === this.R.uniqueTier && this.R.uniqueSuccess < 1 && this.rng() >= this.R.uniqueSuccess) {
      this.push({ t: 'combine_blocked', turn: this.turn, reason: 'unique_fail' });
      return { ok: false, reason: 'unique_fail', result: res };
    }

    // 연쇄 깊이 — 중간 결과물을 재료로 쓴 체인 길이
    const chain = Math.max(this.depthOf.get(inputs[0]) ?? 0, this.depthOf.get(inputs[1]) ?? 0) + 1;
    this.depthOf.set(recipe.result, chain);
    this.maxChain = Math.max(this.maxChain, chain);

    this.piles[i].pop();
    this.piles[j].pop();
    this.piles = this.piles.filter((p) => p.length);
    this.piles.push([recipe.result]);
    this.known.add(key);
    this.combosTotal++;
    const firstTime = !this.codex.has(recipe.result);
    if (firstTime) this.codex.add(recipe.result);
    if (this.gCardById.has(recipe.result)) this.guestsJoined++;
    this.push({ t: 'combine_ok', turn: this.turn, inputs, result: recipe.result, first_time: firstTime, known: wasKnown, chain });

    // 가설 기입 판정 — 보상은 사전 기입에만 (SSOT)
    const hypo = this.hypotheses.get(recipe.id);
    if (hypo && firstTime) {
      const match = pairKey(hypo[0], hypo[1]) === key;
      if (match) {
        this.hypothesisHits++;
        this.push({ t: 'hypothesis_hit', turn: this.turn, recipe: recipe.id });
        this.grantFreeHint('hypothesis');
      } else {
        this.push({ t: 'hypothesis_miss', turn: this.turn, recipe: recipe.id }); // 오답 무벌 — 기록만
      }
      this.hypotheses.delete(recipe.id);
    }
    this.exposed.delete(recipe.id);

    // 저울의 날 — 이번 회기 신규 복원 goal종이면 단서 1장
    if (firstTime && this.eventDeck?.scaleDay && !this.gCardById.has(recipe.result)) {
      this.scaleDayProgress++;
      const sd = this.eventDeck.scaleDay;
      if (!sd.rewarded && this.scaleDayProgress >= sd.goal) {
        sd.rewarded = true;
        this.push({ t: 'scale_day_reward', turn: this.turn });
        this.grantFreeHint('scale_day');
      }
    }

    this.openMarketIfFirstGood();
    return { ok: true, result: res, firstTime, wasKnown, chain };
  }

  /** warm 실패가 드러내는 실루엣 — 시도한 쌍과 태그가 가장 겹치는 미지의 도달 가능 레시피. 결정적. */
  private exposeNear(inputs: [string, string]): Recipe | null {
    const tagsA = new Set(this.card(inputs[0]).tags);
    const tagsB = new Set(this.card(inputs[1]).tags);
    let best: Recipe | null = null;
    let bestScore = 0;
    const candidates = reachableRecipes(this.D, this.region)
      .filter((r) => !this.known.has(pairKey(r.inputs[0], r.inputs[1])) && !this.exposed.has(r.id))
      .sort((a, b) => (a.id < b.id ? -1 : 1)); // 결정적 순서
    for (const r of candidates) {
      const t0 = this.D.cardById.get(r.inputs[0])?.tags ?? [];
      const t1 = this.D.cardById.get(r.inputs[1])?.tags ?? [];
      const s = Math.max(
        t0.filter((t) => tagsA.has(t)).length + t1.filter((t) => tagsB.has(t)).length,
        t0.filter((t) => tagsB.has(t)).length + t1.filter((t) => tagsA.has(t)).length,
      );
      if (s > bestScore) { bestScore = s; best = r; }
    }
    if (best) this.exposed.add(best.id);
    return best;
  }

  /** 야경꾼의 한 단계 상세 — 이 두 카드 태그 중 문법에 맞는(레시피 빈도 있는) 다른 쌍. 결정적. */
  private detailHint(inputs: [string, string], base: FailHint | null): FailHint | null {
    const a = this.card(inputs[0]);
    const b = this.card(inputs[1]);
    let best: FailHint | null = null;
    let bestScore = 0;
    for (const ta of a.tags) for (const tb of b.tags) {
      if (base && ta === base.ta && tb === base.tb) continue;
      const s = this.aff.get([ta, tb].sort().join('|')) ?? 0;
      if (s > bestScore) { bestScore = s; best = { ta, tb, grammatical: true }; }
    }
    return best;
  }

  /**
   * 첫 발견물(B 이상)이 생기면 **구매자가 찾아온다** (온보딩 3번).
   * 판매 동사를 화면이 먼저 시연하는 자리다. 이 거래는 턴당 1회 시장 행동을 쓰지 않는다 —
   * AI 자동 플레이도 같은 자리에서 시장 행동 밖으로 첫 판매를 처리한다.
   */
  private openMarketIfFirstGood(): void {
    if (this.marketOpen) return;
    const id = this.spread.find((x) => this.card(x).tier !== 'A' && this.codex.has(x) && !this.isPersonLike(x));
    if (!id) return;
    this.marketOpen = true;
    this.firstBuyer = id;
  }

  /** 찾아온 구매자에게 판다 (시장 행동을 쓰지 않는다). */
  takeFirstBuyer(): number | null {
    if (!this.firstBuyer) return null;
    const idx = this.spread.indexOf(this.firstBuyer);
    if (idx < 0) { this.firstBuyer = null; return null; }
    const p = this.sellAt(idx);
    this.firstBuyer = null;
    return p;
  }

  declineFirstBuyer(): void { this.firstBuyer = null; }

  /* ── 시장 (턴당 1회: 판매 or 구매 or 단서 or 인물 소개) ──────── */

  canMarket(): boolean {
    return this.phase === 'play' && this.marketOpen && !this.marketActionUsed && !this.traveling;
  }

  sell(pi: number): boolean {
    if (!this.canMarket() || pi < 0 || pi >= this.piles.length) return false;
    if (this.isPersonLike(topOf(this.piles[pi]))) return false; // 사람은 팔지 않는다
    this.sellAt(pi);
    this.marketActionUsed = true;
    return true;
  }

  /** 실제 판매 처리 (가격·프리미엄·포화 갱신). 시장 행동 소모 여부는 부르는 쪽이 정한다. */
  private sellAt(pi: number): number {
    const id = topOf(this.piles[pi]);
    const c = this.card(id);
    const p = this.priceOfCard(id);
    const premium = this.premiumOn(id);
    const merchant = this.eventDeck?.merchantNow(this.turn) ?? null;
    const toMerchant = Boolean(merchant && c.tags.includes(merchant.tag));
    if (toMerchant) this.merchantSells++;
    this.piles[pi].pop();
    this.piles = this.piles.filter((x) => x.length);
    this.gold += p;
    this.soldOnce.add(id);
    this.tierSold[c.tier] = (this.tierSold[c.tier] ?? 0) + 1;
    this.push({ t: 'sell', turn: this.turn, card: id, gold: p, premium, to_merchant: toMerchant });
    this.checkGoldContracts();
    // 감정사 — 판매 시 그 계열 단서 확률+ (식객, 하드코딩 허용)
    if (this.guestActive('sale_hint') && this.rng2() < 0.35)
      this.grantFreeHint('appraiser', new Set(c.tags));
    return p;
  }

  buy(id: string): boolean {
    if (!this.canMarket()) return false;
    const cost = this.buyCost();
    if (this.gold < cost || !this.placeCard(id)) return false;
    this.gold -= cost;
    this.marketActionUsed = true;
    this.push({ t: 'buy', turn: this.turn, card: id, gold: -cost });
    return true;
  }

  /** 떠도는 인물을 소개받는다 (식객 획득 경로 '구매'). 시장 행동을 소모한다. */
  buyPerson(): string | null {
    if (!this.canMarket()) return null;
    const cands = this.availablePersons();
    if (!cands.length || this.gold < this.R.personPrice) return null;
    const pick = cands[Math.floor(this.rng2() * cands.length)];
    if (!this.placeCard(pick.id)) return null;
    this.gold -= this.R.personPrice;
    this.ownedPersons.add(pick.id);
    this.marketActionUsed = true;
    this.push({ t: 'buy_person', turn: this.turn, card: pick.id, gold: -this.R.personPrice });
    return pick.id;
  }

  /** 아직 모르는 도달 가능 레시피 하나를 골라 힌트 문장을 만든다. tagFilter가 있으면 그 계열 우선. */
  private revealHint(rand: () => number, tagFilter?: Set<string>): { hint: Hint; recipe: Recipe } | null {
    let unknown = reachableRecipes(this.D, this.region)
      .filter((r) => !this.known.has(pairKey(r.inputs[0], r.inputs[1])))
      .filter((r) => !this.hints.some((h) => h.cardId === r.inputs[0] || h.cardId === r.inputs[1]));
    if (tagFilter) {
      const filtered = unknown.filter((r) =>
        r.inputs.some((id) => (this.D.cardById.get(id)?.tags ?? []).some((t) => tagFilter.has(t))));
      if (filtered.length) unknown = filtered;
    }
    if (!unknown.length) return null;
    const r = unknown[Math.floor(rand() * unknown.length)];
    // 필드에 있는 쪽을 주어로 삼으면 바로 써먹을 수 있다
    const inField = new Set(allCards(this.piles));
    const subjIdx = inField.has(r.inputs[0]) ? 0 : inField.has(r.inputs[1]) ? 1 : 0;
    const subject = this.card(r.inputs[subjIdx]);
    const other = this.card(r.inputs[1 - subjIdx]);
    const tag = other.tags[Math.floor(rand() * other.tags.length)];
    return {
      hint: { text: `${subject.name_ko}은(는) '${tag}' 계열과 반응이 좋다.`, cardId: subject.id, tag },
      recipe: r,
    };
  }

  /**
   * 단서 구매 — 정보 경제. **단서 구매도 시장 행동 턴당 1회를 소모한다** (플로우 감사 #8).
   * 레시피 자체는 알려주지 않는다.
   */
  buyHint(): Hint | null {
    if (!this.canMarket()) return null;
    const cost = this.hintCost();
    if (this.gold < cost) return null;
    const got = this.revealHint(this.rng);
    if (!got) return null;
    this.gold -= cost;
    this.hints.push(got.hint);
    this.exposed.add(got.recipe.id); // 단서는 실루엣도 드러낸다 (??? 노출 규칙)
    this.marketActionUsed = true;
    this.push({ t: 'hint', turn: this.turn, card: got.hint.cardId, tag: got.hint.tag, gold: -cost, source: 'buy' });
    return got.hint;
  }

  /** 공짜 단서 (감정사·가설 적중·저울의 날 보상) — 시장 행동을 쓰지 않고, 부속 난수를 쓴다. */
  private grantFreeHint(source: 'appraiser' | 'hypothesis' | 'scale_day', tagFilter?: Set<string>): Hint | null {
    const got = this.revealHint(this.rng2, tagFilter);
    if (!got) return null;
    this.hints.push(got.hint);
    this.exposed.add(got.recipe.id);
    this.push({ t: 'hint', turn: this.turn, card: got.hint.cardId, tag: got.hint.tag, gold: 0, source });
    return got.hint;
  }

  /* ── 이동 (지역 카드 띠 — 탭+확인) ──────────────────────────── */

  /**
   * 이동을 시작한다. 이번 턴의 바깥 행동(시장·게시판)을 접고 짐을 싼다 —
   * 이동 중 조합 가능·시장 불가 (SSOT [v3.0] 이동).
   */
  startMove(to: number): boolean {
    if (this.phase !== 'play' || this.traveling || to === this.regionIdx) return false;
    if (to < 0 || to >= this.unlockedRegions) return false;
    if (this.marketActionUsed) return false; // 장 본 날에는 떠나지 못한다 — 이동은 그 턴의 바깥 행동이다
    this.traveling = { to, left: this.R.moveTurns };
    this.marketActionUsed = true;
    this.movesCount++;
    this.push({ t: 'move_start', turn: this.turn, to: this.D.regions[to].id, cost: this.R.moveTurns });
    return true;
  }

  /* ── 파견 (조수 고용 → 행선지 3중 1택 → 예고 턴 귀환) ────────── */

  canDispatch(): boolean {
    return this.phase === 'play' && !this.traveling && !this.assistant && this.gold >= this.R.dispatchWage;
  }

  dispatch(dest: DispatchDest): boolean {
    if (!this.canDispatch()) return false;
    this.gold -= this.R.dispatchWage;
    this.assistant = { dest, returnTurn: this.turn + this.R.dispatchTurns };
    this.dispatchCount++;
    this.push({ t: 'dispatch', turn: this.turn, dest, wage: this.R.dispatchWage, return_turn: this.assistant.returnTurn });
    return true;
  }

  /** 보따리 — 재료만 (레시피·단서 금지). 성과는 대기 시간이 아니라 행선지가 결정한다. */
  private dispatchArrive(): void {
    const a = this.assistant!;
    this.assistant = null;
    const n = this.R.dispatchBundle;
    const cards: string[] = [];
    if (a.dest === 'gather') {
      // 채집터 — 지금 지역의 재료
      const pool = this.region.card_pool;
      for (let k = 0; k < n; k++) cards.push(pool[Math.floor(this.rng2() * pool.length)]);
    } else if (a.dest === 'garden') {
      // 텃밭 — 먹을 것 (밥값 연계)
      const pool = this.D.cards.filter((c) => c.tier === 'A' && c.tags.includes('food')).map((c) => c.id);
      for (let k = 0; k < n; k++) cards.push(pool[Math.floor(this.rng2() * pool.length)]);
    } else {
      // 탐사 — 다른 지역의 재료 (+ 낮은 확률로 떠도는 인물)
      const others = this.accessibleRegions().filter((r) => r.id !== this.region.id);
      const pool = (others.length ? others : [this.region]).flatMap((r) => r.card_pool);
      for (let k = 0; k < n; k++) cards.push(pool[Math.floor(this.rng2() * pool.length)]);
    }
    let person: string | null = null;
    if (a.dest === 'explore' && this.rng2() < this.R.dispatchPersonChance) {
      const cands = this.availablePersons();
      if (cands.length) {
        person = cands[Math.floor(this.rng2() * cands.length)].id;
        this.ownedPersons.add(person);
      }
    }
    for (const id of cards) this.placeCard(id);
    if (person) this.placeCard(person);
    this.push({ t: 'dispatch_return', turn: this.turn, cards, person });
  }

  /* ── 계약: 수주(무료) + 납품(무료) — 이동 중에는 게시판이 없다 ── */

  /**
   * 게시판 수주 — 어음을 잡아야 납품할 수 있다. 잡으면 남은 미수주 자리의 어음이 재게시된다
   * (드래프트 문법). 분모는 3 고정 — 안 잡은 자리는 마감이 지나면 자동 미달로 남는다.
   */
  claim(contractId: string): boolean {
    if (this.phase !== 'play' || !this.R.contractBoardOn || this.traveling) return false;
    const c = this.contracts.find((x) => x.id === contractId);
    if (!c || c.claimed || c.failed || this.turn > c.deadline) return false;
    c.claimed = true;
    this.push({ t: 'claim', turn: this.turn, contract: c.id });
    // 재게시: 아직 수주하지 않은 자리의 어음을 새로 뽑는다 (부속 난수 — 본류 보존)
    for (let k = 0; k < this.contracts.length; k++) {
      const other = this.contracts[k];
      if (other.claimed || other.done || other.failed) continue;
      const pool = this.D.contracts.contracts.filter(
        (d) => d.slot === other.slot && !this.contracts.some((x) => x.id === d.id),
      );
      if (!pool.length) continue;
      const pick: ContractDef = pool[Math.floor(this.rng2() * pool.length)];
      this.contracts[k] = {
        ...tuneContract(pick, this.R.midCountOffset, this.R.midDeadline, this.R.lateCountOffset),
        delivered: 0, done: false, failed: false, kindsDone: new Set<string>(), claimed: false,
      };
    }
    return true;
  }

  deliver(contractId: string): boolean {
    if (this.phase !== 'play' || this.traveling) return false;
    const c = this.contracts.find((x) => x.id === contractId);
    if (!c || !c.claimed || c.done || c.failed || this.turn > c.deadline) return false;
    const pi = this.deliverableIndex(c);
    if (pi < 0) return false;
    const card = topOf(this.piles[pi]);
    c.kindsDone.add(card);
    this.piles[pi].pop();
    this.piles = this.piles.filter((x) => x.length);
    c.delivered++;
    const done = c.delivered >= (c.count ?? 1);
    if (done) { c.done = true; this.gold += c.reward; }
    this.push({ t: 'deliver', turn: this.turn, contract: c.id, card, done });
    if (done) this.checkGoldContracts();
    return true;
  }

  private checkGoldContracts(): void {
    for (const c of this.contracts) {
      if (c.kind !== 'gold' || !c.claimed || c.done || c.failed || this.turn > c.deadline) continue;
      if (this.gold >= (c.amount ?? 0)) {
        c.done = true;
        this.gold += c.reward;
        this.push({ t: 'deliver', turn: this.turn, contract: c.id, card: '', done: true });
      }
    }
  }

  /* ── 가설 기입 (무료 — 노출된 ??? 실루엣만) ─────────────────── */

  /** 가설을 적을 수 있는 실루엣 (노출됐고 아직 모르는 레시피). */
  hypothesisTargets(): Recipe[] {
    return [...this.exposed]
      .map((id) => this.D.recipes.find((r) => r.id === id))
      .filter((r): r is Recipe => Boolean(r) && !this.known.has(pairKey(r!.inputs[0], r!.inputs[1])))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** 가설 재료 후보 — 이 런에서 눈에 보였던 카드들 (지역 풀 + 발견물 + 필드). */
  hypothesisMaterials(): string[] {
    const seen = new Set<string>([...this.region.card_pool, ...this.codex, ...allCards(this.piles)]);
    return [...seen].filter((id) => !this.isPersonLike(id)).sort();
  }

  writeHypothesis(recipeId: string, a: string, b: string): boolean {
    if (this.phase !== 'play' || !this.exposed.has(recipeId) || a === b) return false;
    const r = this.D.recipes.find((x) => x.id === recipeId);
    if (!r || this.known.has(pairKey(r.inputs[0], r.inputs[1]))) return false;
    this.hypotheses.set(recipeId, [a, b]);
    this.push({ t: 'hypothesis', turn: this.turn, recipe: recipeId, inputs: [a, b] });
    return true;
  }

  /* ── 버리기 ────────────────────────────────────────────────── */

  discard(pi: number): boolean {
    if (this.phase !== 'play' || this.discardLeft <= 0) return false;
    if (pi < 0 || pi >= this.piles.length) return false;
    const id = topOf(this.piles[pi]);
    this.piles[pi].pop();
    this.piles = this.piles.filter((x) => x.length);
    this.discardLeft--;
    this.push({ t: 'discard', turn: this.turn, card: id });
    return true;
  }

  /* ── 밥값 (마감 턴에만 — 달력 원칙 정합) ─────────────────────── */

  /** 필드에서 '먹을 것' 한 장을 찾는다 — 묻힌 것 우선, A급 우선 (창고부터 꺼낸다). */
  private findFood(): { pi: number; di: number } | null {
    let best: { pi: number; di: number; score: number } | null = null;
    for (let pi = 0; pi < this.piles.length; pi++) {
      const p = this.piles[pi];
      for (let di = 0; di < p.length; di++) {
        const c = this.card(p[di]);
        if (!c.tags.includes('food')) continue;
        const buried = di < p.length - 1;
        const score = (buried ? 0 : 2) + (c.tier === 'A' ? 0 : 1);
        if (!best || score < best.score) best = { pi, di, score };
      }
    }
    return best;
  }

  private consumeFood(): string | null {
    const f = this.findFood();
    if (!f) return null;
    const [id] = this.piles[f.pi].splice(f.di, 1);
    this.piles = this.piles.filter((x) => x.length);
    return id;
  }

  /** 마감 턴의 정기 밥값 + 파업 중 식객의 재급식. endTurn이 부른다. */
  private feedPhase(): void {
    // 재급식 — 파업 중 식객은 밥이 생기는 대로 다시 일한다 ("죽거나 떠나지 않는다")
    for (const gid of [...this.strikes]) {
      if (!allCards(this.piles).includes(gid)) { this.strikes.delete(gid); continue; }
      const food = this.consumeFood();
      if (!food) break;
      this.strikes.delete(gid);
      this.push({ t: 'feed', turn: this.turn, guest: gid, card: food });
      this.push({ t: 'strike_end', turn: this.turn, guest: gid });
      this.feedsCount++;
    }
    // 정기 밥값 — 중간·최종 마감 턴에만, 펼쳐진 식객만 (묻힌 식객은 쉬는 중)
    const isMeal = this.turn === this.midDeadlineTurn || this.turn === this.R.runTurns;
    if (!isMeal) return;
    for (const gid of this.spreadGuests()) {
      if (this.strikes.has(gid)) continue;
      const food = this.consumeFood();
      if (food) {
        this.feedsCount++;
        this.push({ t: 'feed', turn: this.turn, guest: gid, card: food });
      } else {
        this.strikes.add(gid);
        this.strikesCount++;
        this.push({ t: 'strike', turn: this.turn, guest: gid });
      }
    }
  }

  /* ── 턴 종료 ───────────────────────────────────────────────── */

  endTurn(): void {
    if (this.phase === 'over') return;
    if (this.phase === 'draft') this.takeDraft(-1);
    this.pendingVisitor = null; // 응대하지 않은 인물은 떠난다
    // 도둑 — 매턴 잔돈 (상시형은 이 한 장뿐)
    if (this.guestActive('gold_trickle')) this.gold += this.R.thiefGold;
    this.feedPhase();
    this.checkGoldContracts();
    this.guestTurns += this.spreadGuests().filter((id) => !this.strikes.has(id)).length;
    this.push({
      t: 'turn_end', turn: this.turn, gold: this.gold,
      occupancy: this.used / this.R.spreadSlots, combos: this.combosTotal,
    });
    for (const c of this.contracts) if (!c.done && this.turn >= c.deadline) c.failed = true;

    if (this.turn >= this.R.runTurns) { this.finish(); return; }

    this.turn++;
    this.marketActionUsed = false;
    this.discardLeft = this.R.discardPerTurn;
    this.unknownLeft = this.R.unknownAttempts;
    this.triedThisTurn = new Set();

    // 이동 — 예고된 턴을 다 걸으면 새 지역에 도착해 있다
    if (this.traveling) {
      this.traveling.left--;
      if (this.traveling.left <= 0) {
        this.regionIdx = this.traveling.to;
        this.traveling = null;
        this.push({ t: 'move_end', turn: this.turn, region: this.region.id });
      }
    }
    // 파견 귀환 — 예고된 턴에 보따리가 도착한다
    if (this.assistant && this.turn >= this.assistant.returnTurn) this.dispatchArrive();

    this.beginTurnV22();
    this.supplyPhase();
  }

  private finish(): void {
    this.phase = 'over';
    this.draftCandidates = null;
    const s = settleRun(this.R, this.contracts, this.gold);
    this.settlement = s;
    this.push({
      t: 'run_end', turn: this.turn, gold: this.gold, settle: s.settle, run_fail: s.runFail,
      fulfilled: s.fulfilled, discovered: [...this.codex], combos: this.combosTotal, hints: this.hints.length,
      max_chain: this.maxChain, hypotheses: this.events.filter((e) => e.t === 'hypothesis').length,
      hypothesis_hits: this.hypothesisHits, ledger_blocks: this.ledgerBlocks,
      guests_joined: this.guestsJoined, guest_turns: this.guestTurns, merchant_sells: this.merchantSells,
      moves: this.movesCount, dispatches: this.dispatchCount, feeds: this.feedsCount,
      strikes: this.strikesCount, digs: this.digsCount,
    });
  }

  /** 다음 런으로 이월할 레시피 key (계정 도감 — 런 밖 누적). 식객 레시피도 지식은 이월된다. */
  carryKeys(): string[] { return [...this.known]; }

  /**
   * 이번 런의 신규 복원 수 (심사 창 누적용) — 장부에 새로 적힌 레시피 수다 (도감 단일축,
   * 이월분·식객 레시피 제외). AI 시뮬(econAuto)과 같은 잣대여야 심사 통과율을 같은 자로 잰다.
   */
  newDiscoveries(): { total: number; tierC: number } {
    let total = 0, tierC = 0;
    for (const k of this.known) {
      if (this.initialKnown.has(k) || this.gRecipeByKey.has(k)) continue;
      total++;
      if (this.card(this.D.recipeByKey.get(k)?.result ?? '')?.tier === 'C') tierC++;
    }
    return { total, tierC };
  }

  /** 이번 턴에 이미 실패해 본 쌍들. 재시도는 상한을 깎지 않으므로 UI·도구가 알아야 한다. */
  get triedKeys(): ReadonlySet<string> { return this.triedThisTurn; }

  /** 이 쌍(더미 i, j의 펼친 카드)을 이번 턴에 이미 시도했는가. */
  wasTried(i: number, j: number): boolean {
    if (i < 0 || j < 0 || i >= this.piles.length || j >= this.piles.length) return false;
    return this.triedThisTurn.has(pairKey(topOf(this.piles[i]), topOf(this.piles[j])));
  }

  /** 이 쌍이 실패쌍 장부에 이미 적혀 있는가. */
  inLedger(i: number, j: number): boolean {
    if (i < 0 || j < 0 || i >= this.piles.length || j >= this.piles.length) return false;
    return this.failedPairs.has(pairKey(topOf(this.piles[i]), topOf(this.piles[j])));
  }

  /** 이미 아는 쌍이면 결과 카드를 미리 보여준다 (모르는 쌍은 null — 레시피는 숨겨진 채로 둔다). */
  previewResult(i: number, j: number): Card | null {
    if (i < 0 || j < 0 || i >= this.piles.length || j >= this.piles.length) return null;
    const key = pairKey(topOf(this.piles[i]), topOf(this.piles[j]));
    if (!this.known.has(key)) return null;
    const r = this.recipeOf(key);
    return r ? this.card(r.result) : null;
  }

  /** 위험 조합(유니크) 사전 고지 — 아는 쌍이고 결과가 유니크 티어일 때만 참.
   *  2분포 스위치(v2_unique_success_rate)가 꺼져 있으면 배지도 꺼진다 (거짓 고지 금지). */
  isRiskyPair(i: number, j: number): Card | null {
    if (this.R.uniqueSuccess >= 1) return null;
    const res = this.previewResult(i, j);
    return res && res.tier === this.R.uniqueTier ? res : null;
  }

  /** 필드에서 조합 가능한(아는) 쌍이 하나라도 있는가 — UI 힌트용. */
  hasKnownPair(): boolean {
    const s = this.spread;
    return pairsOf(s).some(([i, j]) => this.known.has(pairKey(s[i], s[j])));
  }
}
