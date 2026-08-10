/**
 * UNFOUND v2.1+v2.2 — 사람 플레이 세션 (G3 수직 슬라이스용).
 *
 * 규칙은 한 줄도 여기서 새로 정하지 않는다. 전부 `econ.ts`의 함수를 부른다.
 * AI 자동 플레이(`econAuto.ts`)와 같은 규칙 위에서 돌아가야, G2 지표와 G3 사람 지표를
 * 같은 자로 잰 것이 된다.
 *
 * v2.2 (2026-08-10 패치): 계약 게시판 수주 · 실패쌍 장부 · 가설 기입 · ??? 실루엣 노출 규칙 ·
 * 이벤트 덱 · 식객 맛보기 · 온보딩 첫 런 한정. 전부 rules.json 스위치 뒤에 있고,
 * 새 난수는 전부 **별도 스트림(rng2)** — 본류 난수 순서는 v2.1과 동일하게 유지된다.
 *
 * 이 파일은 네트워크도 DOM도 모른다. 이벤트를 배열에 쌓아 둘 뿐이고,
 * 전송은 ui/remote.ts가, 그리기는 ui/*.ts가 한다.
 */
import type { Card, GameData, Recipe, Region } from './types.ts';
import { makeRng } from './rng.ts';
import {
  affinityScore, buildAffinity, contractLabel, contractTargetIndex, failHintOf, hasPremium,
  nearMissThreshold, neededByContract, pairKey, pairsOf, priceOf, readEconRules, reachableRecipes,
  rollContracts, rollStartingField, rollSupply, settleRun, tuneContract,
  type ContractDef, type ContractsFile, type EconRules, type FailHint, type PriceContext,
  type RunContract, type Settlement, type TierMap,
} from './econ.ts';
import { EventDeck } from './econEvents.ts';

export type EconData = GameData & { contracts: ContractsFile };

/** data/guests.json — 식객 맛보기 (공급 풀 밖). */
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
  | { t: 'hint'; turn: number; card: string; tag: string; gold: number; source: 'buy' | 'appraiser' | 'hypothesis' | 'scale_day' }
  | { t: 'deliver'; turn: number; contract: string; card: string; done: boolean }
  | { t: 'discard'; turn: number; card: string }
  | { t: 'claim'; turn: number; contract: string }
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
      guests_joined: number; guest_turns: number; merchant_sells: number };

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
  /** 식객 데이터 (data/guests.json). 없으면 식객·방문 이벤트가 꺼진다. */
  guests?: GuestsFile;
}

export class EconSession {
  readonly D: EconData;
  readonly R: EconRules;
  readonly region: Region;
  readonly seed: number;
  readonly runIndex: number;
  private readonly rng: () => number;
  /** v2.2 부속 난수 (이벤트·방문·재게시·공짜 단서) — 본류와 분리된 스트림. */
  private readonly rng2: () => number;
  private readonly aff: Map<string, number>;
  private readonly warmAt: number;

  phase: SessionPhase = 'play';
  turn = 1;
  field: string[] = [];
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

  /* ── v2.2 상태 ── */
  /** 실패쌍 장부 (런 단위). 스위치 ON이면 같은 쌍 재시도를 UI째 차단한다. */
  readonly failedPairs = new Set<string>();
  ledgerBlocks = 0;
  /** 노출된 ??? 실루엣 (레시피 id). 근접 실패·단서로 존재가 드러난 것만 — 전체 개수는 비노출. */
  readonly exposed = new Set<string>();
  /** 가설 기입: 레시피 id → 기입한 재료 2장. */
  readonly hypotheses = new Map<string, [string, string]>();
  hypothesisHits = 0;
  /** 이벤트 덱 (스위치 OFF면 null). */
  readonly eventDeck: EventDeck | null;
  /** 저울의 날 진행 (공고된 회기에만). */
  scaleDayProgress = 0;
  /** 가게 앞에 온 떠도는 인물 (수락 대기). */
  pendingVisitor: string | null = null;
  private visitTurns: number[] = [];
  private visitorQueue: string[] = [];
  guestsJoined = 0;
  guestTurns = 0;
  merchantSells = 0;
  /** 연쇄 깊이: 결과물이 재료로 쓰인 조합 체인 길이 (기본 재료 = 0). */
  private readonly depthOf = new Map<string, number>();
  maxChain = 0;

  private readonly guestsFile: GuestsFile | null;
  private readonly gCardById = new Map<string, GuestCard>();
  private readonly gRecipeByKey = new Map<string, Recipe>();

  constructor(D: EconData, seed: number, opts: SessionOpts = {}) {
    this.D = D;
    this.seed = seed;
    this.runIndex = Math.max(1, opts.runIndex ?? 1);
    this.R = readEconRules(D.rules);
    this.rng = makeRng(seed);
    this.rng2 = makeRng(((seed ^ 0x51ed2701) >>> 0) || 1);
    this.aff = buildAffinity(D);
    this.warmAt = nearMissThreshold(D, this.aff);
    this.region = D.regions[opts.regionIdx ?? 0];

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
    );
    this.field = rollStartingField(D, this.R, this.region, this.rng);
    this.gold = this.R.startingGold;
    this.discardLeft = this.R.discardPerTurn;
    this.unknownLeft = this.R.supply * this.R.unknownAttemptFactor;

    // 온보딩(push+시장 잠금)은 첫 런 한정 — 2런차부터 턴 1 드래프트·시장 개방 (플로우 감사 #7)
    if (this.R.onboardingFirstRunOnly && this.runIndex >= 2) this.marketOpen = true;

    this.eventDeck = this.R.eventsOn
      ? new EventDeck(D, this.R, this.region, seed, this.runIndex)
      : null;

    // 식객 방문 일정 (시드 보정 — 런당 1~2회 보장·상한)
    if (this.guestsFile && this.guestsFile.persons.length) {
      const first = 4 + Math.floor(this.rng2() * 6); // 4~9턴
      this.visitTurns = [first];
      if (this.rng2() < 0.5) {
        const second = first + 3 + Math.floor(this.rng2() * 5);
        if (second <= this.R.runTurns - 2) this.visitTurns.push(second);
      }
      const order = this.rng2() < 0.5 ? [0, 1] : [1, 0];
      this.visitorQueue = order
        .map((i) => this.guestsFile!.persons[i]?.id)
        .filter(Boolean) as string[];
    }

    this.push({
      t: 'run_start', turn: 0, seed, region: this.region.id,
      field: [...this.field], contracts: this.contracts.map((c) => c.id), run_index: this.runIndex,
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
  get used(): number {
    return this.field.reduce((s, id) => s + (this.card(id)?.slot_cost ?? 0), 0);
  }
  get free(): number { return this.R.fieldSlots - this.used; }
  get lastTurn(): number { return this.R.runTurns; }
  /** 이번 런의 실효 드래프트 시작 턴 (2런차부터는 턴 1). */
  get draftFrom(): number {
    return this.R.onboardingFirstRunOnly && this.runIndex >= 2 ? 1 : this.R.draftFromTurn;
  }

  private get pctx(): PriceContext {
    return {
      codex: this.codex, initialResults: this.initialResults, soldOnce: this.soldOnce, tierSold: this.tierSold,
      eventMultOf: this.eventDeck ? (c) => this.eventDeck!.multOf(this.turn, c) : undefined,
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
    return contractTargetIndex(this.D, c, this.field, this.codex, this.initialResults);
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
  /** 이 식객 효과가 지금 켜져 있는가 (필드에 펼쳐진 동안만 발동). */
  guestActive(effect: string): boolean {
    return this.field.some((id) => this.gCardById.get(id)?.effect === effect);
  }
  /** 인물·식객은 팔거나 납품할 수 없다 (tier P/G). */
  isPersonLike(id: string): boolean {
    const t = this.card(id)?.tier;
    return t === 'P' || t === 'G';
  }

  private push(e: PlayEvent): void { this.events.push(e); }

  /* ── v2.2 턴 시작 처리 (이벤트 핀 · 방문 인물) ─────────────── */

  private beginTurnV22(): void {
    if (this.eventDeck) {
      const pin = this.eventDeck.beginTurn(this.turn);
      if (pin)
        this.push({ t: 'event_pin', turn: this.turn, kind: pin.kind, tag: pin.tag, starts_at: pin.startsAt, ends_at: pin.endsAt });
    }
    if (this.visitTurns.includes(this.turn) && this.visitorQueue.length && !this.pendingVisitor) {
      // 이미 같은 인물(또는 그 식객)이 있으면 다음 인물로
      const next = this.visitorQueue.find((pid) => {
        const guestId = this.guestsFile!.recipes.find((r) => r.inputs.includes(pid))?.result;
        return !this.field.includes(pid) && (!guestId || !this.field.includes(guestId));
      });
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
    if (this.free < this.card(id).slot_cost) return false;
    this.field.push(id);
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
    const candidates = rollSupply(this.R, this.region, this.rng);
    if (this.turn < this.draftFrom) {
      for (const id of candidates) {
        const ok = this.free >= this.card(id).slot_cost;
        if (ok) this.field.push(id);
        this.push({ t: 'supply_push', turn: this.turn, card: id, accepted: ok });
      }
      this.phase = 'play';
      this.draftCandidates = null;
    } else {
      this.draftCandidates = candidates;
      this.phase = 'draft';
    }
  }

  /** 드래프트: 후보 3장 중 1장 선택, 나머지는 소멸. idx<0이면 전부 포기. */
  takeDraft(idx: number): boolean {
    if (this.phase !== 'draft' || !this.draftCandidates) return false;
    const cands = this.draftCandidates;
    const taken = idx >= 0 ? cands[idx] : null;
    if (taken) {
      if (this.free < this.card(taken).slot_cost) return false;
      this.field.push(taken);
    }
    this.push({ t: 'draft', turn: this.turn, taken: taken ?? '', passed: cands.filter((_, i) => i !== idx) });
    this.draftCandidates = null;
    this.phase = 'play';
    return true;
  }

  /* ── 조합 ──────────────────────────────────────────────────── */

  combine(i: number, j: number): CombineResult {
    if (this.phase !== 'play') return { ok: false, reason: 'over' };
    if (i === j || i < 0 || j < 0 || i >= this.field.length || j >= this.field.length)
      return { ok: false, reason: 'bad_index' };

    const key = pairKey(this.field[i], this.field[j]);
    const recipe = this.recipeOf(key);
    const wasKnown = this.known.has(key);
    const inputs: [string, string] = [this.field[i], this.field[j]];

    // 실패쌍 장부 — 같은 쌍 재시도는 상한을 깎지 않고 차단한다 ("장부에 이미 적어 두었다")
    if (this.R.failLedgerOn && !recipe && this.failedPairs.has(key)) {
      this.ledgerBlocks++;
      this.push({ t: 'combine_blocked', turn: this.turn, reason: 'ledger' });
      return { ok: false, reason: 'ledger' };
    }

    // 미발견 시도 상한 (아는 레시피 실행은 무제한)
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
    const freed = this.card(inputs[0]).slot_cost + this.card(inputs[1]).slot_cost;
    if (this.used - freed + res.slot_cost > this.R.fieldSlots) {
      this.push({ t: 'combine_blocked', turn: this.turn, reason: 'no_slot' });
      return { ok: false, reason: 'no_slot' };
    }

    if (!wasKnown && !this.triedThisTurn.has(key)) { this.unknownLeft--; this.triedThisTurn.add(key); }

    // 유니크(고티어) 조합은 성공/실패 2분포. 실패해도 재료는 남는다 (SSOT v2.1).
    // 성공률은 rules.json의 v2_unique_success_rate — 1.0이면 이 분기 자체가 꺼진 것과 같다.
    if (res.tier === this.R.uniqueTier && this.R.uniqueSuccess < 1 && this.rng() >= this.R.uniqueSuccess) {
      this.push({ t: 'combine_blocked', turn: this.turn, reason: 'unique_fail' });
      return { ok: false, reason: 'unique_fail', result: res };
    }

    // 연쇄 깊이 — 중간 결과물을 재료로 쓴 체인 길이
    const chain = Math.max(this.depthOf.get(inputs[0]) ?? 0, this.depthOf.get(inputs[1]) ?? 0) + 1;
    this.depthOf.set(recipe.result, chain);
    this.maxChain = Math.max(this.maxChain, chain);

    this.field = this.field.filter((_, k) => k !== i && k !== j);
    this.field.push(recipe.result);
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
    const id = this.field.find((x) => this.card(x).tier !== 'A' && this.codex.has(x) && !this.isPersonLike(x));
    if (!id) return;
    this.marketOpen = true;
    this.firstBuyer = id;
  }

  /** 찾아온 구매자에게 판다 (시장 행동을 쓰지 않는다). */
  takeFirstBuyer(): number | null {
    if (!this.firstBuyer) return null;
    const idx = this.field.indexOf(this.firstBuyer);
    if (idx < 0) { this.firstBuyer = null; return null; }
    const p = this.sellAt(idx);
    this.firstBuyer = null;
    return p;
  }

  declineFirstBuyer(): void { this.firstBuyer = null; }

  /* ── 시장 (턴당 1회: 판매 or 구매 or 단서) ───────────────────── */

  canMarket(): boolean { return this.phase === 'play' && this.marketOpen && !this.marketActionUsed; }

  sell(idx: number): boolean {
    if (!this.canMarket() || idx < 0 || idx >= this.field.length) return false;
    if (this.isPersonLike(this.field[idx])) return false; // 사람은 팔지 않는다
    this.sellAt(idx);
    this.marketActionUsed = true;
    return true;
  }

  /** 실제 판매 처리 (가격·프리미엄·포화 갱신). 시장 행동 소모 여부는 부르는 쪽이 정한다. */
  private sellAt(idx: number): number {
    const id = this.field[idx];
    const c = this.card(id);
    const p = this.priceOfCard(id);
    const premium = this.premiumOn(id);
    const merchant = this.eventDeck?.merchantNow(this.turn) ?? null;
    const toMerchant = Boolean(merchant && c.tags.includes(merchant.tag));
    if (toMerchant) this.merchantSells++;
    this.field.splice(idx, 1);
    this.gold += p;
    this.soldOnce.add(id);
    this.tierSold[c.tier] = (this.tierSold[c.tier] ?? 0) + 1;
    this.push({ t: 'sell', turn: this.turn, card: id, gold: p, premium, to_merchant: toMerchant });
    this.checkGoldContracts();
    // 감정사 — 판매 시 그 계열 단서 확률+ (식객 맛보기, 하드코딩 허용)
    if (this.guestActive('sale_hint') && this.rng2() < 0.35)
      this.grantFreeHint('appraiser', new Set(c.tags));
    return p;
  }

  buy(id: string): boolean {
    if (!this.canMarket()) return false;
    const cost = this.buyCost();
    if (this.gold < cost || this.free < this.card(id).slot_cost) return false;
    this.gold -= cost;
    this.field.push(id);
    this.marketActionUsed = true;
    this.push({ t: 'buy', turn: this.turn, card: id, gold: -cost });
    return true;
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
    const subjIdx = this.field.includes(r.inputs[0]) ? 0 : this.field.includes(r.inputs[1]) ? 1 : 0;
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

  /* ── 계약: 수주(무료) + 납품(무료) ──────────────────────────── */

  /**
   * 게시판 수주 — 어음을 잡아야 납품할 수 있다. 잡으면 남은 미수주 자리의 어음이 재게시된다
   * (드래프트 문법). 분모는 3 고정 — 안 잡은 자리는 마감이 지나면 자동 미달로 남는다.
   */
  claim(contractId: string): boolean {
    if (this.phase !== 'play' || !this.R.contractBoardOn) return false;
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
        ...tuneContract(pick, this.R.midCountOffset, this.R.midDeadline),
        delivered: 0, done: false, failed: false, kindsDone: new Set<string>(), claimed: false,
      };
    }
    return true;
  }

  deliver(contractId: string): boolean {
    if (this.phase !== 'play') return false;
    const c = this.contracts.find((x) => x.id === contractId);
    if (!c || !c.claimed || c.done || c.failed || this.turn > c.deadline) return false;
    const idx = this.deliverableIndex(c);
    if (idx < 0) return false;
    const card = this.field[idx];
    c.kindsDone.add(card);
    this.field.splice(idx, 1);
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
    const seen = new Set<string>([...this.region.card_pool, ...this.codex, ...this.field]);
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

  discard(idx: number): boolean {
    if (this.phase !== 'play' || this.discardLeft <= 0) return false;
    if (idx < 0 || idx >= this.field.length) return false;
    const id = this.field[idx];
    this.field.splice(idx, 1);
    this.discardLeft--;
    this.push({ t: 'discard', turn: this.turn, card: id });
    return true;
  }

  /* ── 턴 종료 ───────────────────────────────────────────────── */

  endTurn(): void {
    if (this.phase === 'over') return;
    if (this.phase === 'draft') this.takeDraft(-1);
    this.pendingVisitor = null; // 응대하지 않은 인물은 떠난다
    this.checkGoldContracts();
    this.guestTurns += this.field.filter((id) => this.gCardById.get(id)?.effect).length;
    this.push({
      t: 'turn_end', turn: this.turn, gold: this.gold,
      occupancy: this.used / this.R.fieldSlots, combos: this.combosTotal,
    });
    for (const c of this.contracts) if (!c.done && this.turn >= c.deadline) c.failed = true;

    if (this.turn >= this.R.runTurns) { this.finish(); return; }

    this.turn++;
    this.marketActionUsed = false;
    this.discardLeft = this.R.discardPerTurn;
    this.unknownLeft = this.R.supply * this.R.unknownAttemptFactor;
    this.triedThisTurn = new Set();
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

  /** 이 쌍을 이번 턴에 이미 시도했는가 (i, j는 필드 인덱스). */
  wasTried(i: number, j: number): boolean {
    if (i < 0 || j < 0 || i >= this.field.length || j >= this.field.length) return false;
    return this.triedThisTurn.has(pairKey(this.field[i], this.field[j]));
  }

  /** 이 쌍이 실패쌍 장부에 이미 적혀 있는가. */
  inLedger(i: number, j: number): boolean {
    if (i < 0 || j < 0 || i >= this.field.length || j >= this.field.length) return false;
    return this.failedPairs.has(pairKey(this.field[i], this.field[j]));
  }

  /** 이미 아는 쌍이면 결과 카드를 미리 보여준다 (모르는 쌍은 null — 레시피는 숨겨진 채로 둔다). */
  previewResult(i: number, j: number): Card | null {
    if (i < 0 || j < 0 || i >= this.field.length || j >= this.field.length) return null;
    const key = pairKey(this.field[i], this.field[j]);
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
    return pairsOf(this.field).some(([i, j]) => this.known.has(pairKey(this.field[i], this.field[j])));
  }
}
