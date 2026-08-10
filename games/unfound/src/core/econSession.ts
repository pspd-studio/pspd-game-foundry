/**
 * UNFOUND v2.1 — 사람 플레이 세션 (G3 수직 슬라이스용).
 *
 * 규칙은 한 줄도 여기서 새로 정하지 않는다. 전부 `econ.ts`의 함수를 부른다.
 * AI 자동 플레이(`econAuto.ts`)와 같은 규칙 위에서 돌아가야, G2 지표와 G3 사람 지표를
 * 같은 자로 잰 것이 된다.
 *
 * 이 파일은 네트워크도 DOM도 모른다. 이벤트를 배열에 쌓아 둘 뿐이고,
 * 전송은 ui/remote.ts가, 그리기는 ui/*.ts가 한다.
 */
import type { Card, GameData, Region } from './types.ts';
import { makeRng } from './rng.ts';
import {
  affinityScore, buildAffinity, contractLabel, contractTargetIndex, hasPremium, nearMissThreshold,
  neededByContract, pairKey, pairsOf, priceOf, readEconRules, reachableRecipes,
  rollContracts, rollStartingField, rollSupply, settleRun, slotUsed,
  type ContractsFile, type EconRules, type PriceContext, type RunContract, type Settlement, type TierMap,
} from './econ.ts';

export type EconData = GameData & { contracts: ContractsFile };

export type SessionPhase = 'draft' | 'play' | 'over';

export interface Hint {
  /** 사람에게 보여줄 문장 */
  text: string;
  /** 이 단서가 가리키는 재료 id (UI 강조용) */
  cardId: string;
  tag: string;
}

export type PlayEvent =
  | { t: 'run_start'; turn: 0; seed: number; region: string; field: string[]; contracts: string[] }
  | { t: 'supply_push'; turn: number; card: string; accepted: boolean }
  | { t: 'draft'; turn: number; taken: string; passed: string[] }
  | { t: 'combine_ok'; turn: number; inputs: [string, string]; result: string; first_time: boolean; known: boolean }
  | { t: 'combine_fail'; turn: number; inputs: [string, string]; signal: 'warm' | 'cold'; attempts_left: number }
  | { t: 'combine_blocked'; turn: number; reason: 'no_slot' | 'cap' | 'unique_fail' }
  | { t: 'sell'; turn: number; card: string; gold: number; premium: boolean }
  | { t: 'buy'; turn: number; card: string; gold: number }
  | { t: 'hint'; turn: number; card: string; tag: string; gold: number }
  | { t: 'deliver'; turn: number; contract: string; card: string; done: boolean }
  | { t: 'discard'; turn: number; card: string }
  | { t: 'turn_end'; turn: number; gold: number; occupancy: number; combos: number }
  | { t: 'run_end'; turn: number; gold: number; settle: number; run_fail: boolean; fulfilled: number; discovered: string[]; combos: number; hints: number };

export type CombineResult =
  | { ok: true; result: Card; firstTime: boolean; wasKnown: boolean }
  | { ok: false; reason: 'no_recipe'; signal: 'warm' | 'cold' }
  | { ok: false; reason: 'unique_fail'; result: Card }
  | { ok: false; reason: 'no_slot' | 'cap' | 'bad_index' | 'over' };

export interface SessionOpts {
  regionIdx?: number;
  /** 계정 도감 이월 (2판째 이후). 레시피 key 목록 */
  carryKnown?: string[];
}

export class EconSession {
  readonly D: EconData;
  readonly R: EconRules;
  readonly region: Region;
  readonly seed: number;
  private readonly rng: () => number;
  private readonly aff: Map<string, number>;
  private readonly warmAt: number;

  phase: SessionPhase = 'play';
  turn = 1;
  field: string[] = [];
  gold: number;
  contracts: RunContract[];
  readonly known = new Set<string>();
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

  constructor(D: EconData, seed: number, opts: SessionOpts = {}) {
    this.D = D;
    this.seed = seed;
    this.R = readEconRules(D.rules);
    this.rng = makeRng(seed);
    this.aff = buildAffinity(D);
    this.warmAt = nearMissThreshold(D, this.aff);
    this.region = D.regions[opts.regionIdx ?? 0];

    if (opts.carryKnown) {
      for (const k of opts.carryKnown) {
        this.known.add(k);
        const r = D.recipeByKey.get(k);
        if (r) this.initialResults.add(r.result);
      }
    }

    this.contracts = rollContracts(D.contracts, this.rng);
    this.field = rollStartingField(D, this.R, this.region, this.rng);
    this.gold = this.R.startingGold;
    this.discardLeft = this.R.discardPerTurn;
    this.unknownLeft = this.R.supply * this.R.unknownAttemptFactor;

    this.push({
      t: 'run_start', turn: 0, seed, region: this.region.id,
      field: [...this.field], contracts: this.contracts.map((c) => c.id),
    });
    // 1턴 공급은 즉시 (턴 1~3은 push)
    this.supplyPhase();
  }

  /* ── 조회 ──────────────────────────────────────────────────── */

  card(id: string): Card { return this.D.cardById.get(id)!; }
  get used(): number { return slotUsed(this.D, this.field); }
  get free(): number { return this.R.fieldSlots - this.used; }
  get lastTurn(): number { return this.R.runTurns; }

  private get pctx(): PriceContext {
    return { codex: this.codex, initialResults: this.initialResults, soldOnce: this.soldOnce, tierSold: this.tierSold };
  }

  priceOfCard(id: string): number { return priceOf(this.D, this.R, this.pctx, this.card(id)); }
  premiumOn(id: string): boolean { return hasPremium(this.D, this.pctx, this.card(id)); }
  neededForContract(id: string): boolean {
    return neededByContract(this.D, this.contracts, this.turn, id, this.codex, this.initialResults);
  }
  labelOf(c: RunContract): string { return contractLabel(this.D, c); }
  deliverableIndex(c: RunContract): number {
    return contractTargetIndex(this.D, c, this.field, this.codex, this.initialResults);
  }
  /** 이 지역에서 도달 가능한 레시피 수 (도감 실루엣 개수). */
  reachableCount(): number { return reachableRecipes(this.D, this.region).length; }
  /** 시장에서 살 수 있는 재료 (지역 풀의 A 카드). */
  buyableCards(): string[] {
    return [...new Set(this.region.card_pool)].filter((id) => this.card(id).tier === 'A');
  }
  buyCost(): number { return Math.round(this.R.basePrice.A * this.R.buyMarkup); }
  hintCost(): number { return this.R.hintPrice; }

  private push(e: PlayEvent): void { this.events.push(e); }

  /* ── 공급 ──────────────────────────────────────────────────── */

  private supplyPhase(): void {
    const candidates = rollSupply(this.R, this.region, this.rng);
    if (this.turn < this.R.draftFromTurn) {
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
    const recipe = this.D.recipeByKey.get(key);
    const wasKnown = this.known.has(key);
    const inputs: [string, string] = [this.field[i], this.field[j]];

    // 미발견 시도 상한 (아는 레시피 실행은 무제한)
    if (!wasKnown && !this.triedThisTurn.has(key) && this.unknownLeft <= 0) {
      this.push({ t: 'combine_blocked', turn: this.turn, reason: 'cap' });
      return { ok: false, reason: 'cap' };
    }

    if (!recipe) {
      if (!this.triedThisTurn.has(key)) { this.unknownLeft--; this.triedThisTurn.add(key); }
      const signal: 'warm' | 'cold' =
        affinityScore(this.D, this.aff, inputs[0], inputs[1]) >= this.warmAt ? 'warm' : 'cold';
      this.push({ t: 'combine_fail', turn: this.turn, inputs, signal, attempts_left: this.unknownLeft });
      return { ok: false, reason: 'no_recipe', signal };
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

    this.field = this.field.filter((_, k) => k !== i && k !== j);
    this.field.push(recipe.result);
    this.known.add(key);
    this.combosTotal++;
    const firstTime = !this.codex.has(recipe.result);
    if (firstTime) this.codex.add(recipe.result);
    this.push({ t: 'combine_ok', turn: this.turn, inputs, result: recipe.result, first_time: firstTime, known: wasKnown });
    this.openMarketIfFirstGood();
    return { ok: true, result: res, firstTime, wasKnown };
  }

  /**
   * 첫 발견물(B 이상)이 생기면 **구매자가 찾아온다** (온보딩 3번).
   * 판매 동사를 화면이 먼저 시연하는 자리다. 이 거래는 턴당 1회 시장 행동을 쓰지 않는다 —
   * AI 자동 플레이도 같은 자리에서 시장 행동 밖으로 첫 판매를 처리한다.
   */
  private openMarketIfFirstGood(): void {
    if (this.marketOpen) return;
    const id = this.field.find((x) => this.card(x).tier !== 'A' && this.codex.has(x));
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
    this.field.splice(idx, 1);
    this.gold += p;
    this.soldOnce.add(id);
    this.tierSold[c.tier] = (this.tierSold[c.tier] ?? 0) + 1;
    this.push({ t: 'sell', turn: this.turn, card: id, gold: p, premium });
    this.checkGoldContracts();
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

  /**
   * 단서 구매 — 정보 경제. 아직 모르는 도달 가능 레시피 하나를 골라
   * "재료 A는 ○○ 계열과 반응이 좋다" 한 줄로 흘린다. 레시피 자체는 알려주지 않는다.
   */
  buyHint(): Hint | null {
    if (!this.canMarket()) return null;
    const cost = this.hintCost();
    if (this.gold < cost) return null;
    const unknown = reachableRecipes(this.D, this.region)
      .filter((r) => !this.known.has(pairKey(r.inputs[0], r.inputs[1])))
      .filter((r) => !this.hints.some((h) => h.cardId === r.inputs[0] || h.cardId === r.inputs[1]));
    if (!unknown.length) return null;
    const r = unknown[Math.floor(this.rng() * unknown.length)];
    // 필드에 있는 쪽을 주어로 삼으면 바로 써먹을 수 있다
    const subjIdx = this.field.includes(r.inputs[0]) ? 0 : this.field.includes(r.inputs[1]) ? 1 : 0;
    const subject = this.card(r.inputs[subjIdx]);
    const other = this.card(r.inputs[1 - subjIdx]);
    const tag = other.tags[Math.floor(this.rng() * other.tags.length)];
    const hint: Hint = { text: `${subject.name_ko}은(는) '${tag}' 계열과 반응이 좋다.`, cardId: subject.id, tag };
    this.gold -= cost;
    this.hints.push(hint);
    this.marketActionUsed = true;
    this.push({ t: 'hint', turn: this.turn, card: subject.id, tag, gold: -cost });
    return hint;
  }

  /* ── 계약 납품 (무료 행동) ──────────────────────────────────── */

  deliver(contractId: string): boolean {
    if (this.phase !== 'play') return false;
    const c = this.contracts.find((x) => x.id === contractId);
    if (!c || c.done || c.failed || this.turn > c.deadline) return false;
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
      if (c.kind !== 'gold' || c.done || c.failed || this.turn > c.deadline) continue;
      if (this.gold >= (c.amount ?? 0)) {
        c.done = true;
        this.gold += c.reward;
        this.push({ t: 'deliver', turn: this.turn, contract: c.id, card: '', done: true });
      }
    }
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
    this.checkGoldContracts();
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
    });
  }

  /** 다음 런으로 이월할 레시피 key (계정 도감 — 런 밖 누적). */
  carryKeys(): string[] { return [...this.known]; }

  /** 이미 아는 쌍이면 결과 카드를 미리 보여준다 (모르는 쌍은 null — 레시피는 숨겨진 채로 둔다). */
  previewResult(i: number, j: number): Card | null {
    if (i < 0 || j < 0 || i >= this.field.length || j >= this.field.length) return null;
    const key = pairKey(this.field[i], this.field[j]);
    if (!this.known.has(key)) return null;
    const r = this.D.recipeByKey.get(key);
    return r ? this.card(r.result) : null;
  }

  /** 위험 조합(유니크) 사전 고지 — 아는 쌍이고 결과가 유니크 티어일 때만 참. */
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
