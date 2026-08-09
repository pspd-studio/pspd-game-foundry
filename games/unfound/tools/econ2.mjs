/**
 * UNFOUND v2.1 경제 코어 — 전투 없는 조합-경제 런 (G2 재진입용).
 * SSOT v2.1(docs/00-SSOT.md)의 규칙을 구현한다. 순수 함수 + 이벤트 스트림 구조로,
 * G3 슬라이스에서 이 로직을 src/core로 승격해 그대로 쓴다 (v1 engine.ts는 부검 후 동결).
 * 규칙 수치는 전부 rules.json의 v2_* 키에서 읽는다. 코드 하드코딩 금지.
 */
import { pairKey } from '../src/core/index.ts';
import { makeRng } from './lib.mjs';

const num = (rules, k, fb) => (typeof rules[k] === 'number' ? rules[k] : fb);
const obj = (rules, k, fb) => (rules[k] && typeof rules[k] === 'object' ? rules[k] : fb);

export function readEconRules(rules) {
  return {
    fieldSlots: num(rules, 'field_slots', 7),
    startingHand: num(rules, 'starting_hand', 7),
    supply: num(rules, 'supply_candidates_per_turn', 3),
    discardPerTurn: num(rules, 'discard_per_turn', 1),
    runTurns: num(rules, 'v2_run_turns', 22),
    draftFromTurn: num(rules, 'v2_draft_from_turn', 4),
    unknownAttemptFactor: num(rules, 'v2_unknown_attempt_factor', 2),
    startingGold: num(rules, 'v2_starting_gold', 10),
    basePrice: obj(rules, 'v2_base_price', { A: 4, B: 12, C: 30 }),
    firstPremium: obj(rules, 'v2_first_premium', { A: 2.0, B: 2.5, C: 4.0 }),
    demandPool: obj(rules, 'v2_demand_pool', { A: 10, B: 8, C: 4 }),
    saturationR: num(rules, 'v2_saturation_r', 0.85),
    resaleFactor: num(rules, 'v2_resale_factor', 0.5),
    buyMarkup: num(rules, 'v2_buy_markup', 1.0),
    failSettlement: num(rules, 'v2_fail_settlement', 0.5),
  };
}

/** 계열(태그) 친화도 사전 — 전체 레시피의 태그쌍 빈도. "계열 규칙성"을 학습한 플레이어의 사전 지식 모델. */
export function buildAffinity(D) {
  const freq = new Map();
  for (const r of D.recipes) {
    const [a, b] = r.inputs.map((id) => D.cardById.get(id));
    for (const ta of a.tags) for (const tb of b.tags) {
      const k = [ta, tb].sort().join('|');
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
  }
  return freq;
}

export function affinityScore(D, aff, idA, idB) {
  const a = D.cardById.get(idA), b = D.cardById.get(idB);
  let s = 0;
  for (const ta of a.tags) for (const tb of b.tags) s += aff.get([ta, tb].sort().join('|')) ?? 0;
  return s;
}

/** 지역 풀에서 도달 가능한 레시피 (재료가 풀 카드 또는 풀에서 파생 가능한 결과물). */
export function reachableRecipes(D, region) {
  const have = new Set(region.card_pool);
  let grew = true;
  const ok = new Set();
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
  return [...ok].map((id) => D.recipes.find((r) => r.id === id));
}

function slotUsed(D, field) {
  return field.reduce((s, id) => s + D.cardById.get(id).slot_cost, 0);
}

function pairsOf(field) {
  const out = [];
  for (let i = 0; i < field.length; i++)
    for (let j = i + 1; j < field.length; j++) out.push([i, j]);
  return out;
}

/**
 * 한 판 자동 플레이.
 * policy: 'greedy'(전수 스캔) | 'reasoner'(계약 역산+계열 단서) | 'preknown'(레시피 알고 발견 안 함)
 * opts: { preknownFraction, saturationOff, fullCodex }
 */
export function playEconRun(D, seed, policy, emit, opts = {}) {
  const R = readEconRules(D.rules);
  const rng = makeRng(seed);
  const aff = buildAffinity(D);
  const region = D.regions[opts.regionIdx ?? 0]; // 기본 숲. 회차 곡선에서는 해금된 지역 중 선택
  const reach = reachableRecipes(D, region);

  // ── 사전 지식 (해금 모사 / 선지식 AI) ─────────────────────────
  const known = new Set(); // 발동 가능해진 레시피 key
  const codex = new Set(); // 이 런에서 발견(결과물 종류)
  if (opts.carryKnown) for (const k of opts.carryKnown) known.add(k);
  if (opts.fullCodex) for (const r of reach) known.add(pairKey(r.inputs[0], r.inputs[1]));
  else if (policy === 'preknown') {
    // 시장에서 바로 구할 수 있는(풀 내 tier A) 재료 2장짜리 고가 레시피 5개 — "아는 장사" 모델
    const direct = reach.filter((r) => r.inputs.every((id) => region.card_pool.includes(id)));
    const byValue = direct.sort((a, b) => (R.basePrice[D.cardById.get(b.result).tier] ?? 0) - (R.basePrice[D.cardById.get(a.result).tier] ?? 0));
    for (const r of byValue.slice(0, 5)) known.add(pairKey(r.inputs[0], r.inputs[1]));
  } else if (opts.preknownFraction > 0) {
    const shuffled = [...reach].sort(() => rng() - 0.5);
    for (const r of shuffled.slice(0, Math.round(reach.length * opts.preknownFraction)))
      known.add(pairKey(r.inputs[0], r.inputs[1]));
  }

  const initialResults = new Set([...known].map((k) => D.recipeByKey.get(k)?.result).filter(Boolean));

  // ── 계약 뽑기 ────────────────────────────────────────────────
  const mids = D.contracts.contracts.filter((c) => c.slot === 'mid');
  const lates = D.contracts.contracts.filter((c) => c.slot === 'late');
  const pickN = (arr, n) => {
    const a = [...arr];
    const out = [];
    for (let i = 0; i < n && a.length; i++) out.push(a.splice(Math.floor(rng() * a.length), 1)[0]);
    return out;
  };
  const contracts = [...pickN(mids, D.contracts.run_pick.mid), ...pickN(lates, D.contracts.run_pick.late)]
    .map((c) => ({ ...c, delivered: 0, done: false, failed: false, kindsDone: new Set() }));

  // ── 시작 필드: 확정 조합 2쌍 보장 (시드 보정) ──────────────────
  let field = [];
  for (let tries = 0; tries < 40; tries++) {
    field = [];
    for (let i = 0; i < R.startingHand; i++) field.push(region.card_pool[Math.floor(rng() * region.card_pool.length)]);
    let pairs = 0;
    for (const [i, j] of pairsOf(field)) if (D.recipeByKey.has(pairKey(field[i], field[j]))) pairs++;
    if (pairs >= 2) break;
  }

  let gold = R.startingGold;
  let marketOpen = false;
  const soldOnce = new Set(); // 첫 판매 프리미엄 소진 여부 (결과물 id)
  const tierSold = { A: 0, B: 0, C: 0 };
  const soldKinds = new Set();
  const revenueByCard = new Map();
  let combosTotal = 0, combosLast3 = 0, giveUps = 0, firstSaleTurn = 0, firstCTurn = 0;
  const goldCurve = [];

  const price = (card) => {
    const tier = card.tier;
    let p = R.basePrice[tier] ?? 2;
    if (card.tier !== 'A' && codex.has(card.id) && !initialResults.has(card.id) && !soldOnce.has(card.id)) p *= R.firstPremium[tier] ?? 1;
    const over = tierSold[tier] - (R.demandPool[tier] ?? 99);
    if (!opts.saturationOff && over >= 0) p *= Math.pow(R.saturationR, over + 1);
    return Math.round(p);
  };

  const removeAt = (idx) => field.splice(idx, 1)[0];

  const tryCombine = (i, j) => {
    const key = pairKey(field[i], field[j]);
    const r = D.recipeByKey.get(key);
    if (!r) return false;
    const res = D.cardById.get(r.result);
    const freed = D.cardById.get(field[i]).slot_cost + D.cardById.get(field[j]).slot_cost;
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
    const candidates = Array.from({ length: R.supply }, () => region.card_pool[Math.floor(rng() * region.card_pool.length)]);
    const accept = (id) => {
      if (slotUsed(D, field) + D.cardById.get(id).slot_cost <= R.fieldSlots) { field.push(id); return true; }
      return false;
    };
    if (turn < R.draftFromTurn) {
      for (const id of candidates) if (!accept(id)) emit({ t: 'supply_skipped' });
    } else {
      // 드래프트: 정책별 선택. 나머지는 소멸 (= 매 턴 2장 포기 — 배타성)
      let pickId;
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
          const res = D.cardById.get(D.recipeByKey.get(key).result);
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
      const tried = new Set();
      while (attempts < cap) {
        const cand = pairsOf(field)
          .filter(([i, j]) => !known.has(pairKey(field[i], field[j])) && !tried.has(pairKey(field[i], field[j])));
        if (!cand.length) break;
        let pick;
        if (policy === 'reasoner') {
          cand.sort(([a1, b1], [a2, b2]) => affinityScore(D, aff, field[a2], field[b2]) - affinityScore(D, aff, field[a1], field[b1]));
          pick = cand[0];
        } else pick = cand[Math.floor(rng() * cand.length)];
        const key = pairKey(field[pick[0]], field[pick[1]]);
        tried.add(key);
        attempts++;
        if (!tryCombine(pick[0], pick[1])) emit({ t: 'near_miss' });
      }
      if (attempts >= cap) {
        const remaining = pairsOf(field).filter(([i, j]) => !known.has(pairKey(field[i], field[j])) && !tried.has(pairKey(field[i], field[j])));
        if (remaining.length) giveUps++; // 더 긁고 싶었는데 상한
      }
    }

    // 3.5) 첫 판매: 구매자가 찾아온다 — 첫 발견물(B 이상)이 생기면 계약보다 먼저 성사 (온보딩 규칙)
    if (!marketOpen) {
      const firstIdx = field.findIndex((id) => D.cardById.get(id).tier !== 'A' && codex.has(id));
      if (firstIdx >= 0) {
        const card = D.cardById.get(field[firstIdx]);
        const p = price(card);
        removeAt(firstIdx);
        gold += p;
        soldOnce.add(card.id);
        soldKinds.add(card.id);
        tierSold[card.tier]++;
        revenueByCard.set(card.id, (revenueByCard.get(card.id) ?? 0) + p);
        marketOpen = true;
        firstSaleTurn = turn;
        emit({ t: 'sell', card: card.id, gold: p, turn });
      }
    }

    // 4) 계약 납품 (무료 행동)
    for (const c of contracts) {
      if (c.done || c.failed || turn > c.deadline) continue;
      if (c.kind === 'gold') { if (gold >= c.amount) { c.done = true; gold += c.reward; emit({ t: 'contract_done', id: c.id, turn }); } continue; }
      let idx = -1;
      if (c.kind === 'tier_count') idx = field.findIndex((id) => D.cardById.get(id).tier === c.tier);
      else if (c.kind === 'distinct_tier') idx = field.findIndex((id) => D.cardById.get(id).tier === c.tier && !c.kindsDone.has(id));
      else if (c.kind === 'discovery') idx = field.findIndex((id) => D.cardById.get(id).tier !== 'A' && codex.has(id) && !initialResults.has(id));
      else idx = field.findIndex((id) => c.options.includes(id) && (!c.distinct || !c.kindsDone.has(id)));
      // reasoner는 계약을 우선하고, greedy는 팔 물건이 남을 때만 납품
      if (idx >= 0 && (policy !== 'greedy' || field.filter((id) => D.cardById.get(id).tier !== 'A').length > 1)) {
        c.kindsDone.add(field[idx]);
        removeAt(idx);
        c.delivered++;
        if (c.delivered >= c.count) { c.done = true; gold += c.reward; emit({ t: 'contract_done', id: c.id, turn }); }
      }
    }

    // 5) 시장 행동 (턴당 1회: 판매 or 구매)
    const sellable = field
      .map((id, idx) => ({ id, idx, card: D.cardById.get(id) }))
      .filter((x) => x.card.tier !== 'A' || slotUsed(D, field) > R.fieldSlots - 1);
    let wantSell = null;
    if (sellable.length) {
      sellable.sort((a, b) => price(b.card) - price(a.card));
      // 계약에 필요한 물건은 팔지 않는다 (reasoner)
      wantSell = sellable.find((x) => {
        if (policy !== 'reasoner') return true;
        return !contracts.some((c) => {
          if (c.done || c.failed || turn > c.deadline || c.count - c.delivered <= 0) return false;
          if (c.kind === 'tier_count') return x.card.tier === c.tier;
          if (c.kind === 'distinct_tier') return x.card.tier === c.tier && !c.kindsDone.has(x.id);
          if (c.kind === 'discovery') return codex.has(x.id) && !initialResults.has(x.id);
          if (c.kind === 'gold') return false;
          return c.options.includes(x.id) && (!c.distinct || !c.kindsDone.has(x.id));
        });
      }) ?? null;
    }
    // reasoner 구매 욕구: 아는 고가 레시피의 빠진 재료 (지역 시장 = 풀의 A 카드)
    let wantBuy = null;
    if (policy !== 'greedy' && gold >= (R.basePrice.A * R.buyMarkup)) {
      outer: for (const r of reach) {
        if (!known.has(pairKey(r.inputs[0], r.inputs[1]))) continue;
        const resTier = D.cardById.get(r.result).tier;
        if (resTier === 'A') continue;
        const have0 = field.includes(r.inputs[0]), have1 = field.includes(r.inputs[1]);
        if (have0 !== have1) {
          const need = have0 ? r.inputs[1] : r.inputs[0];
          if (region.card_pool.includes(need) && D.cardById.get(need).tier === 'A') { wantBuy = need; break outer; }
        }
      }
    }
    if (marketOpen) {
      if (wantSell && wantBuy) giveUps++; // 택1 — 여기가 배타성이다
      if (wantSell && (!wantBuy || price(wantSell.card) >= R.basePrice.A * 2)) {
        const p = price(wantSell.card);
        field = field.filter((_, k) => k !== wantSell.idx);
        gold += p;
        soldOnce.add(wantSell.id);
        soldKinds.add(wantSell.id);
        tierSold[wantSell.card.tier]++;
        revenueByCard.set(wantSell.id, (revenueByCard.get(wantSell.id) ?? 0) + p);
        emit({ t: 'sell', card: wantSell.id, gold: p, turn });
      } else if (wantBuy) {
        const cost = Math.round(R.basePrice.A * R.buyMarkup);
        if (gold >= cost && slotUsed(D, field) + D.cardById.get(wantBuy).slot_cost <= R.fieldSlots) {
          gold -= cost;
          field.push(wantBuy);
          emit({ t: 'buy', card: wantBuy, gold: -cost, turn });
        }
      }
    }

    // 6) 버리기 1장 — 조합 상대 없는 A 카드 (선지식 AI는 '아는 레시피' 기준으로 죽은 카드 판정)
    if (R.discardPerTurn > 0 && slotUsed(D, field) >= R.fieldSlots - 1) {
      const hasPair = (i) => pairsOf(field).some(([a, b]) => {
        if (a !== i && b !== i) return false;
        const k = pairKey(field[a], field[b]);
        return policy === 'preknown' ? known.has(k) : D.recipeByKey.has(k);
      });
      const deadIdx = field.findIndex((id, i) => D.cardById.get(id).tier === 'A' && !hasPair(i));
      if (deadIdx >= 0) { removeAt(deadIdx); emit({ t: 'discard' }); }
    }

    if (turn === R.runTurns - 3) combosLast3 = combosTotal; // 기준점 저장 (정산 때 차감)
    goldCurve.push({ turn, gold, combos: combosTotal });
    emit({ t: 'turn_end', turn, occupancy: slotUsed(D, field) / R.fieldSlots, gold });

    for (const c of contracts) if (!c.done && turn >= c.deadline) c.failed = true;
  }

  // ── 정산 ──────────────────────────────────────────────────────
  const fulfilled = contracts.filter((c) => c.done).length;
  const runFail = fulfilled < contracts.length - 1; // 2/3 미달
  const settle = runFail ? Math.round(gold * R.failSettlement) : gold;
  const topRevenue = Math.max(0, ...revenueByCard.values());
  const totalRevenue = [...revenueByCard.values()].reduce((s, x) => s + x, 0);
  emit({
    t: 'run_end', turn: R.runTurns, gold, settle, runFail, fulfilled, contractsTotal: contracts.length,
    discovered: [...codex], combos: combosTotal, giveUps, firstSaleTurn, firstCTurn,
    topShare: totalRevenue ? topRevenue / totalRevenue : 0,
    earlyGoldRate: (goldCurve[6]?.gold ?? gold) / 7,
    lateGoldRate: (gold - (goldCurve[goldCurve.length - 8]?.gold ?? 0)) / 7,
    combosLast3: combosTotal - combosLast3, soldKinds: soldKinds.size, knownKeys: [...known],
  });
}
