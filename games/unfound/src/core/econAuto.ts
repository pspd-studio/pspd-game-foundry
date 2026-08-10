/**
 * UNFOUND v2.1 — AI 자동 플레이 (G2 시뮬레이터의 정책 층).
 *
 * 규칙은 여기 없다. 전부 `econ.ts`에서 가져다 쓴다 — 이 파일에 있는 것은
 * "AI가 무엇을 고르는가"(정책)뿐이다. 사람 플레이(`econSession.ts`)와 규칙이 갈라지지 않게 하려는 것이다.
 *
 * 난수 호출 순서는 G2 측정치(36.0% / 29.4% / 40.5%, 시드 42·7)를 재현해야 하므로
 * 원본 tools/econ2.mjs와 **한 줄도 어긋나지 않게** 유지한다. 순서를 바꾸면 지표가 바뀐다.
 */
import type { GameData } from './types.ts';
import { makeRng } from './rng.ts';
import {
  affinityScore, buildAffinity, contractTargetIndex, neededByContract, pairKey, pairsOf,
  priceOf, readEconRules, reachableRecipes, rollContracts, rollStartingField, rollSupply,
  settleRun, slotUsed,
  type ContractsFile, type PriceContext, type RunContract, type TierMap,
} from './econ.ts';

export type EconPolicy = 'greedy' | 'reasoner' | 'preknown';

export interface EconRunOpts {
  preknownFraction?: number;
  saturationOff?: boolean;
  fullCodex?: boolean;
  regionIdx?: number;
  carryKnown?: string[];
}

export type EconEvent =
  | { t: 'discover'; card: string; tier: string; turn: number }
  | { t: 'sell'; card: string; gold: number; turn: number }
  | { t: 'buy'; card: string; gold: number; turn: number }
  | { t: 'contract_done'; id: string; turn: number }
  | { t: 'supply_skipped' }
  | { t: 'near_miss' }
  | { t: 'discard' }
  | { t: 'turn_end'; turn: number; occupancy: number; gold: number }
  | { t: 'run_end'; [k: string]: unknown };

/** 시뮬레이터가 넘겨주는 데이터 (GameData + contracts.json). */
export type EconData = GameData & { contracts: ContractsFile };

/**
 * 한 판 자동 플레이.
 * policy: 'greedy'(전수 스캔) | 'reasoner'(계약 역산+계열 단서) | 'preknown'(레시피 알고 발견 안 함)
 */
export function playEconRun(
  D: EconData, seed: number, policy: EconPolicy, emit: (e: EconEvent) => void, opts: EconRunOpts = {},
): void {
  const R = readEconRules(D.rules);
  const rng = makeRng(seed);
  const aff = buildAffinity(D);
  const region = D.regions[opts.regionIdx ?? 0]; // 기본 숲. 회차 곡선에서는 해금된 지역 중 선택
  const reach = reachableRecipes(D, region);

  // ── 사전 지식 (해금 모사 / 선지식 AI) ─────────────────────────
  const known = new Set<string>(); // 발동 가능해진 레시피 key
  const codex = new Set<string>(); // 이 런에서 발견(결과물 종류)
  if (opts.carryKnown) for (const k of opts.carryKnown) known.add(k);
  if (opts.fullCodex) for (const r of reach) known.add(pairKey(r.inputs[0], r.inputs[1]));
  else if (policy === 'preknown') {
    // 시장에서 바로 구할 수 있는(풀 내 tier A) 재료 2장짜리 고가 레시피 5개 — "아는 장사" 모델
    const direct = reach.filter((r) => r.inputs.every((id) => region.card_pool.includes(id)));
    const byValue = direct.sort((a, b) =>
      (R.basePrice[D.cardById.get(b.result)!.tier] ?? 0) - (R.basePrice[D.cardById.get(a.result)!.tier] ?? 0));
    for (const r of byValue.slice(0, 5)) known.add(pairKey(r.inputs[0], r.inputs[1]));
  } else if ((opts.preknownFraction ?? 0) > 0) {
    const shuffled = [...reach].sort(() => rng() - 0.5);
    for (const r of shuffled.slice(0, Math.round(reach.length * (opts.preknownFraction ?? 0))))
      known.add(pairKey(r.inputs[0], r.inputs[1]));
  }

  const initialResults = new Set<string>(
    [...known].map((k) => D.recipeByKey.get(k)?.result).filter(Boolean) as string[],
  );

  const contracts: RunContract[] = rollContracts(D.contracts, rng);

  let field: string[] = rollStartingField(D, R, region, rng);

  let gold = R.startingGold;
  let marketOpen = false;
  const soldOnce = new Set<string>(); // 첫 판매 프리미엄 소진 여부 (결과물 id)
  const tierSold: TierMap = { A: 0, B: 0, C: 0 };
  const soldKinds = new Set<string>();
  const revenueByCard = new Map<string, number>();
  let combosTotal = 0, combosLast3 = 0, giveUps = 0, firstSaleTurn = 0, firstCTurn = 0;
  const goldCurve: Array<{ turn: number; gold: number; combos: number }> = [];

  const pctx: PriceContext = { codex, initialResults, soldOnce, tierSold, saturationOff: opts.saturationOff };
  const price = (card: { id: string; tier: string }) => priceOf(D, R, pctx, D.cardById.get(card.id)!);

  const removeAt = (idx: number) => field.splice(idx, 1)[0];

  const tryCombine = (i: number, j: number): boolean => {
    const key = pairKey(field[i], field[j]);
    const r = D.recipeByKey.get(key);
    if (!r) return false;
    const res = D.cardById.get(r.result)!;
    const freed = D.cardById.get(field[i])!.slot_cost + D.cardById.get(field[j])!.slot_cost;
    if (slotUsed(D, field) - freed + res.slot_cost > R.fieldSlots) return false;
    field = field.filter((_, k) => k !== i && k !== j);
    field.push(r.result);
    known.add(key);
    combosTotal++;
    if (!codex.has(r.result)) {
      codex.add(r.result);
      if (res.tier === 'C' && !firstCTurn) firstCTurn = turn;
      emit({ t: 'discover', card: r.result, tier: res.tier, turn });
    }
    return true;
  };

  let turn = 0;
  for (turn = 1; turn <= R.runTurns; turn++) {
    // 1) 공급 (턴 1~3 push / 이후 드래프트 1장)
    const candidates = rollSupply(R, region, rng);
    const accept = (id: string): boolean => {
      if (slotUsed(D, field) + D.cardById.get(id)!.slot_cost <= R.fieldSlots) { field.push(id); return true; }
      return false;
    };
    if (turn < R.draftFromTurn) {
      for (const id of candidates) if (!accept(id)) emit({ t: 'supply_skipped' });
    } else {
      // 드래프트: 정책별 선택. 나머지는 소멸 (= 매 턴 2장 포기 — 배타성)
      let pickId: string = candidates[0];
      if (policy === 'greedy') pickId = candidates[0];
      else {
        // 계열 친화: 필드와 궁합 점수가 가장 높은 후보 / 선지식은 아는 레시피 재료 우선
        let best = -1;
        for (const id of candidates) {
          let s = 0;
          for (const key of known) if (key.split('+').includes(id)) s += 10; // 아는 레시피의 재료면 가산
          for (const f of field) {
            const k = pairKey(id, f);
            if (known.has(k) && D.recipeByKey.has(k)) s += 100;
            else if (policy !== 'preknown') s += affinityScore(D, aff, id, f);
          }
          if (s > best) { best = s; pickId = id; }
        }
      }
      if (!accept(pickId)) { giveUps++; emit({ t: 'supply_skipped' }); }
    }

    // 2) 아는 레시피 실행 (무제한) — 가치 있는 결과 위주
    let did = true;
    while (did) {
      did = false;
      for (const [i, j] of pairsOf(field)) {
        const key = pairKey(field[i], field[j]);
        if (known.has(key) && D.recipeByKey.has(key)) {
          const res = D.cardById.get(D.recipeByKey.get(key)!.result)!;
          // A 재료를 A로 바꾸는 조합은 필드에 여유 있을 때만 (재료 낭비 방지 휴리스틱)
          if (res.tier === 'A' && slotUsed(D, field) < R.fieldSlots - 2 && rng() < 0.5) continue;
          if (tryCombine(i, j)) { did = true; break; }
        }
      }
    }

    // 3) 미발견 시도 (상한 = 공급 × 2) — greedy: 무작위 / reasoner: 계열 친화 순
    if (policy !== 'preknown') {
      const cap = R.supply * R.unknownAttemptFactor;
      let attempts = 0;
      const tried = new Set<string>();
      while (attempts < cap) {
        const cand = pairsOf(field)
          .filter(([i, j]) => !known.has(pairKey(field[i], field[j])) && !tried.has(pairKey(field[i], field[j])));
        if (!cand.length) break;
        let pick: [number, number];
        if (policy === 'reasoner') {
          cand.sort(([a1, b1], [a2, b2]) =>
            affinityScore(D, aff, field[a2], field[b2]) - affinityScore(D, aff, field[a1], field[b1]));
          pick = cand[0];
        } else pick = cand[Math.floor(rng() * cand.length)];
        const key = pairKey(field[pick[0]], field[pick[1]]);
        tried.add(key);
        attempts++;
        if (!tryCombine(pick[0], pick[1])) emit({ t: 'near_miss' });
      }
      if (attempts >= cap) {
        const remaining = pairsOf(field)
          .filter(([i, j]) => !known.has(pairKey(field[i], field[j])) && !tried.has(pairKey(field[i], field[j])));
        if (remaining.length) giveUps++; // 더 긁고 싶었는데 상한
      }
    }

    // 3.5) 첫 판매: 구매자가 찾아온다 — 첫 발견물(B 이상)이 생기면 계약보다 먼저 성사 (온보딩 규칙)
    if (!marketOpen) {
      const firstIdx = field.findIndex((id) => D.cardById.get(id)!.tier !== 'A' && codex.has(id));
      if (firstIdx >= 0) {
        const card = D.cardById.get(field[firstIdx])!;
        const p = price(card);
        removeAt(firstIdx);
        gold += p;
        soldOnce.add(card.id);
        soldKinds.add(card.id);
        tierSold[card.tier] = (tierSold[card.tier] ?? 0) + 1;
        revenueByCard.set(card.id, (revenueByCard.get(card.id) ?? 0) + p);
        marketOpen = true;
        firstSaleTurn = turn;
        emit({ t: 'sell', card: card.id, gold: p, turn });
      }
    }

    // 4) 계약 납품 (무료 행동)
    for (const c of contracts) {
      if (c.done || c.failed || turn > c.deadline) continue;
      if (c.kind === 'gold') {
        if (gold >= (c.amount ?? 0)) { c.done = true; gold += c.reward; emit({ t: 'contract_done', id: c.id, turn }); }
        continue;
      }
      const idx = contractTargetIndex(D, c, field, codex, initialResults);
      // reasoner는 계약을 우선하고, greedy는 팔 물건이 남을 때만 납품
      if (idx >= 0 && (policy !== 'greedy' || field.filter((id) => D.cardById.get(id)!.tier !== 'A').length > 1)) {
        c.kindsDone.add(field[idx]);
        removeAt(idx);
        c.delivered++;
        if (c.delivered >= (c.count ?? 1)) { c.done = true; gold += c.reward; emit({ t: 'contract_done', id: c.id, turn }); }
      }
    }

    // 5) 시장 행동 (턴당 1회: 판매 or 구매)
    const sellable = field
      .map((id, idx) => ({ id, idx, card: D.cardById.get(id)! }))
      .filter((x) => x.card.tier !== 'A' || slotUsed(D, field) > R.fieldSlots - 1);
    let wantSell: { id: string; idx: number; card: { id: string; tier: string } } | null = null;
    if (sellable.length) {
      sellable.sort((a, b) => price(b.card) - price(a.card));
      // 계약에 필요한 물건은 팔지 않는다 (reasoner)
      wantSell = sellable.find((x) =>
        policy !== 'reasoner' || !neededByContract(D, contracts, turn, x.id, codex, initialResults)) ?? null;
    }
    // reasoner 구매 욕구: 아는 고가 레시피의 빠진 재료 (지역 시장 = 풀의 A 카드)
    let wantBuy: string | null = null;
    if (policy !== 'greedy' && gold >= (R.basePrice.A * R.buyMarkup)) {
      outer: for (const r of reach) {
        if (!known.has(pairKey(r.inputs[0], r.inputs[1]))) continue;
        const resTier = D.cardById.get(r.result)!.tier;
        if (resTier === 'A') continue;
        const have0 = field.includes(r.inputs[0]), have1 = field.includes(r.inputs[1]);
        if (have0 !== have1) {
          const need = have0 ? r.inputs[1] : r.inputs[0];
          if (region.card_pool.includes(need) && D.cardById.get(need)!.tier === 'A') { wantBuy = need; break outer; }
        }
      }
    }
    if (marketOpen) {
      if (wantSell && wantBuy) giveUps++; // 택1 — 여기가 배타성이다
      if (wantSell && (!wantBuy || price(wantSell.card) >= R.basePrice.A * 2)) {
        const p = price(wantSell.card);
        const sold = wantSell;
        field = field.filter((_, k) => k !== sold.idx);
        gold += p;
        soldOnce.add(sold.id);
        soldKinds.add(sold.id);
        tierSold[sold.card.tier] = (tierSold[sold.card.tier] ?? 0) + 1;
        revenueByCard.set(sold.id, (revenueByCard.get(sold.id) ?? 0) + p);
        emit({ t: 'sell', card: sold.id, gold: p, turn });
      } else if (wantBuy) {
        const cost = Math.round(R.basePrice.A * R.buyMarkup);
        if (gold >= cost && slotUsed(D, field) + D.cardById.get(wantBuy)!.slot_cost <= R.fieldSlots) {
          gold -= cost;
          field.push(wantBuy);
          emit({ t: 'buy', card: wantBuy, gold: -cost, turn });
        }
      }
    }

    // 6) 버리기 1장 — 조합 상대 없는 A 카드 (선지식 AI는 '아는 레시피' 기준으로 죽은 카드 판정)
    if (R.discardPerTurn > 0 && slotUsed(D, field) >= R.fieldSlots - 1) {
      const hasPair = (i: number) => pairsOf(field).some(([a, b]) => {
        if (a !== i && b !== i) return false;
        const k = pairKey(field[a], field[b]);
        return policy === 'preknown' ? known.has(k) : D.recipeByKey.has(k);
      });
      const deadIdx = field.findIndex((id, i) => D.cardById.get(id)!.tier === 'A' && !hasPair(i));
      if (deadIdx >= 0) { removeAt(deadIdx); emit({ t: 'discard' }); }
    }

    if (turn === R.runTurns - 3) combosLast3 = combosTotal; // 기준점 저장 (정산 때 차감)
    goldCurve.push({ turn, gold, combos: combosTotal });
    emit({ t: 'turn_end', turn, occupancy: slotUsed(D, field) / R.fieldSlots, gold });

    for (const c of contracts) if (!c.done && turn >= c.deadline) c.failed = true;
  }

  // ── 정산 ──────────────────────────────────────────────────────
  const s = settleRun(R, contracts, gold);
  const topRevenue = Math.max(0, ...revenueByCard.values());
  const totalRevenue = [...revenueByCard.values()].reduce((acc, x) => acc + x, 0);
  emit({
    t: 'run_end', turn: R.runTurns, gold, settle: s.settle, runFail: s.runFail,
    fulfilled: s.fulfilled, contractsTotal: s.contractsTotal,
    discovered: [...codex], combos: combosTotal, giveUps, firstSaleTurn, firstCTurn,
    topShare: totalRevenue ? topRevenue / totalRevenue : 0,
    earlyGoldRate: (goldCurve[6]?.gold ?? gold) / 7,
    lateGoldRate: (gold - (goldCurve[goldCurve.length - 8]?.gold ?? 0)) / 7,
    combosLast3: combosTotal - combosLast3, soldKinds: soldKinds.size, knownKeys: [...known],
  });
}
