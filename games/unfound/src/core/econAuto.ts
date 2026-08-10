/**
 * UNFOUND v3.0 — AI 자동 플레이 (G2 시뮬레이터의 정책 층).
 *
 * v3.0부터 AI는 **사람과 같은 세션 코어(EconSession)를 그대로 운전한다** — 규칙 이중 구현 제거.
 * 구 7칸 수치(35.1/31.1/45.7)의 난수 재현 제약이 사라졌기 때문에 가능해졌다
 * (07 지시서: 규칙이 바뀌었으므로 G2 재측정으로 대체).
 *
 * 행동 공간 (07 지시서 Phase 2): 적재 접근 · 이동 · 수주 선택 · 파견 · 식객 활용.
 * 뒷면 정보 제약에 대해: 파내기가 무료라 기계적 제약은 펼침 용량뿐이고, AI는 자기가 묻은
 * 카드를 기억한다 (사람도 자기가 쌓은 것은 기억한다). 뒷면의 정보 비용은 사람 화면에서
 * 마찰로 작동하는 것이고, 시뮬 지표에는 "후보가 넓어질수록 전수 스캔이 비싸진다"로 나타난다.
 */
import { makeRng } from './rng.ts';
import {
  affinityScore, allCards, buildAffinity, pairKey, reachableRecipes, readEconRules, topOf,
  type RunContract,
} from './econ.ts';
import {
  EconSession, type DispatchDest, type EconData, type GuestsFile,
} from './econSession.ts';

export type EconPolicy = 'greedy' | 'reasoner' | 'preknown';

export interface EconRunOpts {
  saturationOff?: boolean;
  fullCodex?: boolean;
  regionIdx?: number;
  carryKnown?: string[];
  /** 몇 번째 회기(런)인가. 온보딩 첫 런 한정·이벤트 침묵 규칙이 본다. 기본 1. */
  runIndex?: number;
  /** 등급 (0=견습) — 지역 출입권. */
  grade?: number;
  guests?: GuestsFile;
}

/** 한 판의 결과 요약 — 시뮬레이터가 지표를 뽑는 유일한 창구. */
export interface RunSummary {
  runFail: boolean;
  fulfilled: number;
  contractsTotal: number;
  gold: number;
  settle: number;
  discovered: number;
  discoveredIds: string[];
  combos: number;
  turns: number;
  occAvg: number;
  giveUps: number;
  firstSaleTurn: number;
  firstCTurn: number;
  topShare: number;
  earlyGoldRate: number;
  lateGoldRate: number;
  combosLast3: number;
  soldKinds: number;
  knownKeys: string[];
  newDiscov: number;
  newDiscovC: number;
  midDone: number;
  midTotal: number;
  maxChain: number;
  guestsJoined: number;
  guestTurns: number;
  feeds: number;
  strikes: number;
  moves: number;
  dispatches: number;
  digs: number;
  nearMisses: number;
}

interface Stats { giveUps: number }

/** (pi, di) — 카드의 첫 위치. 없으면 null. */
function locate(S: EconSession, id: string): [number, number] | null {
  for (let pi = 0; pi < S.piles.length; pi++) {
    const di = S.piles[pi].indexOf(id);
    if (di >= 0) return [pi, di];
  }
  return null;
}

/** 묻힌 카드면 그 더미 맨 위로 파낸다 (무료). */
function makeTop(S: EconSession, pi: number, di: number): void {
  if (di < S.piles[pi].length - 1) S.dig(pi, di);
}

/**
 * 두 카드를 서로 다른 더미의 맨 위로 만든다 (조합 준비). 같은 더미에 있으면
 * 하나를 펼치거나(unstack) 다른 더미로 옮긴다(restack). 실패하면 null.
 */
function bringTogether(S: EconSession, idA: string, idB: string): [number, number] | null {
  let a = locate(S, idA);
  let b = locate(S, idB);
  if (!a || !b) return null;
  if (a[0] === b[0]) {
    makeTop(S, b[0], b[1]);
    const bp = b[0];
    if (!S.unstack(bp)) {
      const other = S.piles.findIndex((p, k) => k !== bp && !S.isPersonLike(topOf(p)));
      if (other < 0 || !S.restack(bp, other)) return null;
    }
    a = locate(S, idA);
    b = locate(S, idB);
    if (!a || !b || a[0] === b[0]) return null;
  }
  makeTop(S, a[0], a[1]);
  makeTop(S, b[0], b[1]);
  a = locate(S, idA);
  b = locate(S, idB);
  if (!a || !b) return null;
  return [a[0], b[0]];
}

/** 이 카드가 이 계약에 납품 가능한가 (묻힌 카드 포함 — 파내면 되니까). */
function matchesContract(S: EconSession, c: RunContract, id: string): boolean {
  const card = S.card(id);
  if (!card || S.isPersonLike(id)) return false;
  if (c.kind === 'tier_count') return card.tier === c.tier;
  if (c.kind === 'distinct_tier') return card.tier === c.tier && !c.kindsDone.has(id);
  if (c.kind === 'discovery') return card.tier !== 'A' && S.codex.has(id) && !S.initialResults.has(id);
  if (c.kind === 'gold') return false;
  return (c.options ?? []).includes(id) && (!c.distinct || !c.kindsDone.has(id));
}

/**
 * 한 판 자동 플레이.
 * policy: 'greedy'(전수 스캔) | 'reasoner'(계약 역산+계열 단서) | 'preknown'(레시피 알고 발견 안 함)
 */
export function playEconRun(
  D: EconData, seed: number, policy: EconPolicy, opts: EconRunOpts = {},
): RunSummary {
  const R = readEconRules(D.rules);
  // 정책 전용 난수 — 세션(규칙) 난수와 분리된 스트림
  const prng = makeRng(((seed ^ 0x7f4a7c15) >>> 0) || 1);
  const regionIdx = opts.regionIdx ?? 0;
  const region = D.regions[regionIdx];
  const grade = opts.grade ?? 0;

  // ── 사전 지식 (선지식 AI / 도감 100%) ────────────────────────
  let carry = opts.carryKnown ? [...opts.carryKnown] : [];
  if (opts.fullCodex) {
    const keys = new Set<string>();
    const unlockedN = Math.min(R.regionsStart + grade, D.regions.length);
    for (const rg of D.regions.slice(0, unlockedN))
      for (const r of reachableRecipes(D, rg)) keys.add(pairKey(r.inputs[0], r.inputs[1]));
    carry = [...keys];
  } else if (policy === 'preknown' && !carry.length) {
    // 시장에서 바로 구할 수 있는(풀 내 tier A) 재료 2장짜리 고가 레시피 5개 — "아는 장사" 모델
    const reach = reachableRecipes(D, region);
    const direct = reach.filter((r) => r.inputs.every((id) => region.card_pool.includes(id)));
    const byValue = direct.sort((a, b) =>
      (R.basePrice[D.cardById.get(b.result)!.tier] ?? 0) - (R.basePrice[D.cardById.get(a.result)!.tier] ?? 0));
    carry = byValue.slice(0, 5).map((r) => pairKey(r.inputs[0], r.inputs[1]));
  }

  const S = new EconSession(D, seed, {
    regionIdx, carryKnown: carry, runIndex: opts.runIndex ?? 1, grade,
    guests: opts.guests, saturationOff: opts.saturationOff,
  });

  const aff = buildAffinity(D);
  const affMemo = new Map<string, number>();
  const affOf = (a: string, b: string): number => {
    const k = pairKey(a, b);
    let v = affMemo.get(k);
    if (v === undefined) { v = affinityScore(D, aff, a, b); affMemo.set(k, v); }
    return v;
  };

  const stats: Stats = { giveUps: 0 };
  let movedThisTurn = false;

  /* ── 정책 조각들 ─────────────────────────────────────────── */

  const chooseDraft = (cands: string[]): number => {
    if (policy === 'greedy') return 0;
    let best = -1, pick = 0;
    const inField = allCards(S.piles);
    for (let i = 0; i < cands.length; i++) {
      const id = cands[i];
      let s = 0;
      for (const key of S.known) if (key.split('+').includes(id)) s += 10; // 아는 레시피의 재료면 가산
      for (const f of inField) {
        const k = pairKey(id, f);
        if (S.known.has(k) && S.recipeOf(k)) s += 100;
        else if (policy !== 'preknown') s += affOf(id, f);
      }
      if (s > best) { best = s; pick = i; }
    }
    return pick;
  };

  /** 수주 선택 — mid는 즉시, late는 첫 턴에 적성 좋은 것 하나(재게시 문법), 2턴부터 전부. */
  const lateFit = (c: RunContract): number => {
    if (c.kind === 'specific') return 4;
    if (c.kind === 'distinct_tier') return 3;
    if (c.kind === 'tier_count') return 2;
    return 1; // gold — 수동적이라 마지막
  };
  const doClaims = (): void => {
    if (!S.R.contractBoardOn) return;
    const posted = (): RunContract[] =>
      S.contracts.filter((c) => !c.claimed && !c.done && !c.failed && S.turn <= c.deadline);
    if (policy !== 'reasoner' || S.turn >= 2) {
      for (const c of posted()) S.claim(c.id);
      return;
    }
    // reasoner 1턴: mid 먼저, late는 최고 적성 1건만 — 남은 자리는 재게시를 본다
    const mid = posted().find((c) => c.slot === 'mid');
    if (mid) S.claim(mid.id);
    const lates = posted().filter((c) => c.slot === 'late').sort((a, b) => lateFit(b) - lateFit(a));
    if (lates.length) S.claim(lates[0].id);
  };

  /** 아는 레시피 실행 (무제한) — 필요하면 파낸다. 스캔 봇은 뒷면을 기억하지 못한다. */
  const doKnownCombos = (): void => {
    let did = true;
    let guard = 0;
    while (did && guard++ < 80) {
      did = false;
      const ids = [...new Set(policy === 'greedy' ? S.spread : allCards(S.piles))];
      outer:
      for (let x = 0; x < ids.length; x++) {
        for (let y = x + 1; y < ids.length; y++) {
          const key = pairKey(ids[x], ids[y]);
          if (!S.known.has(key)) continue;
          const r = S.recipeOf(key);
          if (!r) continue;
          const res = S.card(r.result);
          // A 재료를 A로 바꾸는 조합은 절반만 (재료 낭비 방지 휴리스틱 — v2 계승)
          if (res.tier === 'A' && prng() < 0.5) continue;
          const pos = bringTogether(S, ids[x], ids[y]);
          if (!pos) continue;
          if (S.combine(pos[0], pos[1]).ok) { did = true; break outer; }
        }
      }
    }
  };

  /** 미발견 시도 (상한 = 턴당 6회 고정) — greedy: 무작위 / reasoner: 계열 친화 + 실패 학습 + 인물 우선. */
  let nearMisses = 0;
  // 실패도 정보다: cold 신호가 가리킨 계열쌍은 뒤로, warm 계열쌍은 앞으로 (추론 AI의 학습)
  const coldFamilies = new Set<string>();
  const warmFamilies = new Set<string>();
  const doUnknownAttempts = (): void => {
    if (policy === 'preknown') return;
    let cands: Array<[string, string]> = [];
    let regen = true;
    let guard = 0;
    while (S.unknownLeft > 0 && guard++ < 200) {
      if (regen) {
        cands = [];
        const seen = new Set<string>();
        // 적재 접근 — 뒷면 정보 제약 (07 지시서): 전수 스캔 봇은 자기가 묻은 카드를
        // 기억하지 못한다. 눈에 보이는 펼친 카드만 긁는다. 추론 AI는 자기가 쌓은 것을
        // 기억하는 플레이어 모델이라 전 카드가 후보다 — 후보가 넓어질수록 단서로 줄인다.
        const uids = [...new Set(policy === 'greedy' ? S.spread : allCards(S.piles))];
        for (let x = 0; x < uids.length; x++) {
          for (let y = x + 1; y < uids.length; y++) {
            const key = pairKey(uids[x], uids[y]);
            if (S.known.has(key) || S.failedPairs.has(key) || S.triedKeys.has(key) || seen.has(key)) continue;
            seen.add(key);
            cands.push([uids[x], uids[y]]);
          }
        }
        if (policy === 'reasoner') {
          const score = (p: [string, string]): number => {
            // 인물+물건 우선 — 맞는 물건을 쥐여주면 직업이 깨어난다 (식객 활용)
            const persons = (S.isPersonLike(p[0]) ? 1 : 0) + (S.isPersonLike(p[1]) ? 1 : 0);
            if (persons === 1) {
              const item = S.isPersonLike(p[0]) ? p[1] : p[0];
              if (S.card(item).tier === 'B') return 1000;
            }
            if (persons > 0) return -1000; // 인물끼리는 섞지 않는다
            let s = affOf(p[0], p[1]);
            // 산 단서를 실제로 쓴다: "X는 'tag' 계열과 반응이 좋다" → 그 쌍을 최우선으로
            for (const h of S.hints) {
              if ((h.cardId === p[0] && S.card(p[1]).tags.includes(h.tag)) ||
                  (h.cardId === p[1] && S.card(p[0]).tags.includes(h.tag))) s += 400;
            }
            // 실패 학습 — 이 쌍의 계열 조합이 cold로 판명난 계열이면 뒤로, warm이면 앞으로
            for (const ta of S.card(p[0]).tags) for (const tb of S.card(p[1]).tags) {
              const fam = [ta, tb].sort().join('|');
              if (coldFamilies.has(fam)) s -= 60;
              if (warmFamilies.has(fam)) s += 40;
            }
            return s;
          };
          cands.sort((p, q) => score(q) - score(p));
        }
        regen = false;
      }
      if (!cands.length) break;
      const pick = policy === 'reasoner'
        ? cands.shift()!
        : cands.splice(Math.floor(prng() * cands.length), 1)[0];
      const pos = bringTogether(S, pick[0], pick[1]);
      if (!pos) continue;
      const out = S.combine(pos[0], pos[1]);
      if (out.ok) regen = true; // 필드가 바뀌었다 — 후보 재생성
      else if (out.reason === 'no_recipe') {
        nearMisses++;
        // 실패가 판 정보를 적립한다 (실패=정보 2규칙의 AI 쪽 소비자)
        if (out.hint) {
          const fam = [out.hint.ta, out.hint.tb].sort().join('|');
          if (out.signal === 'cold') coldFamilies.add(fam);
          else warmFamilies.add(fam);
        }
      } else if (out.reason === 'cap') break;
    }
    if (S.unknownLeft <= 0 && cands.length) stats.giveUps++; // 더 긁고 싶었는데 상한
  };

  /** 납품 — 스프레드에 없으면 파내서 준다. */
  const doDeliveries = (): void => {
    if (S.traveling) return;
    for (const c of S.contracts) {
      if (!c.claimed || c.done || c.failed || S.turn > c.deadline || c.kind === 'gold') continue;
      let guard = 0;
      while (guard++ < 20 && !c.done) {
        if (S.deliverableIndex(c) >= 0) { if (!S.deliver(c.id)) break; continue; }
        const target = allCards(S.piles).find((id) => matchesContract(S, c, id));
        if (!target) break;
        const pos = locate(S, target);
        if (!pos) break;
        makeTop(S, pos[0], pos[1]);
        if (S.deliverableIndex(c) < 0) break;
        if (!S.deliver(c.id)) break;
      }
    }
  };

  /** 이동 — 추론 AI만. 이 지역의 발견거리가 마르면 다른 지역으로 (계약 역산). */
  const maybeMove = (): void => {
    if (policy !== 'reasoner' || S.traveling || movedThisTurn) return;
    if (S.turn < 5 || S.turn > S.R.runTurns - 4 || S.marketActionUsed) return;
    const midPending = S.contracts.some(
      (c) => c.slot === 'mid' && c.claimed && !c.done && !c.failed && S.turn <= c.deadline);
    if (midPending) return;
    const unknownIn = (rgIdx: number): number =>
      reachableRecipes(D, D.regions[rgIdx])
        .filter((r) => !S.known.has(pairKey(r.inputs[0], r.inputs[1]))).length;
    const cur = unknownIn(S.regionIdx);
    if (cur >= 3) return;
    let bestIdx = -1, bestVal = cur + 2;
    for (let i = 0; i < S.unlockedRegions; i++) {
      if (i === S.regionIdx) continue;
      const v = unknownIn(i);
      if (v > bestVal) { bestVal = v; bestIdx = i; }
    }
    if (bestIdx >= 0 && S.startMove(bestIdx)) movedThisTurn = true;
  };

  /** 파견 — 조수는 greedy 빼고 쓴다. 행선지: 밥이 급하면 텃밭, 아니면 탐사/채집터. */
  const maybeDispatch = (): void => {
    if (policy === 'greedy') return;
    if (!S.canDispatch() || S.turn > S.R.runTurns - S.R.dispatchTurns - 1) return;
    if (S.gold < S.R.dispatchWage + 8) return; // 임금 내고도 살림이 남아야 보낸다
    let dest: DispatchDest = 'gather';
    if (policy === 'reasoner') {
      const guests = S.spreadGuests().length;
      if (guests > 0 && S.foodCount() < guests + 1) dest = 'garden';
      else if (S.unlockedRegions > 1) dest = prng() < 0.5 ? 'explore' : 'gather';
    }
    S.dispatch(dest);
  };

  /** 시장 (턴당 1회) — 판매 vs 구매 vs 단서 택1. 계약 필요품·식객 밥은 지킨다. */
  const doMarket = (): void => {
    if (!S.canMarket()) return;
    const guests = S.spreadGuests().length;
    const foodN = S.foodCount();
    const uniqueIds = [...new Set(allCards(S.piles))];
    const sellable = uniqueIds.filter((id) => {
      const c = S.card(id);
      if (S.isPersonLike(id) || c.tier === 'A') return false;
      if (policy === 'reasoner' && S.neededForContract(id)) return false; // 계약에 필요한 물건은 팔지 않는다
      if (policy === 'reasoner' && guests > 0 && c.tags.includes('food') && foodN <= guests) return false;
      return true;
    });
    sellable.sort((a, b) => S.priceOfCard(b) - S.priceOfCard(a));
    const wantSell = sellable[0] ?? null;

    // 구매 욕구: 아는 고가 레시피의 빠진 재료 (지역 시장 = 풀의 A 카드)
    let wantBuy: string | null = null;
    if (policy !== 'greedy' && S.gold >= S.buyCost()) {
      const inField = new Set(allCards(S.piles));
      outer: for (const r of reachableRecipes(D, S.region)) {
        if (!S.known.has(pairKey(r.inputs[0], r.inputs[1]))) continue;
        if (D.cardById.get(r.result)!.tier === 'A') continue;
        const have0 = inField.has(r.inputs[0]), have1 = inField.has(r.inputs[1]);
        if (have0 !== have1) {
          const need = have0 ? r.inputs[1] : r.inputs[0];
          if (S.region.card_pool.includes(need) && D.cardById.get(need)!.tier === 'A') {
            wantBuy = need;
            break outer;
          }
        }
      }
    }

    if (wantSell && wantBuy) stats.giveUps++; // 택1 — 여기가 배타성이다
    if (wantSell && (!wantBuy || S.priceOfCard(wantSell) >= S.R.basePrice.A * 2)) {
      const pos = locate(S, wantSell);
      if (!pos) return;
      makeTop(S, pos[0], pos[1]);
      const pi = locate(S, wantSell)![0];
      S.sell(pi);
    } else if (wantBuy) {
      S.buy(wantBuy);
    } else if (policy === 'reasoner' && S.gold >= S.hintCost() + 10) {
      // 팔 것도 살 것도 없는 턴 — 정보에 투자한다 (정보 경제: 위키 대신 게임 안 단서)
      S.buyHint();
    }
  };

  /* ── 턴 루프 ─────────────────────────────────────────────── */

  let guard = 0;
  while (S.phase !== 'over' && guard++ < 3000) {
    if (S.pendingVisitor) {
      // 식객 활용: reasoner·greedy는 들이고, 선지식(회전 봇)은 돌려보낸다
      if (policy === 'preknown') S.declineVisitor();
      else if (!S.acceptVisitor()) S.declineVisitor();
      continue;
    }
    if (S.phase === 'draft') {
      const cands = S.draftCandidates!;
      if (!S.takeDraft(chooseDraft(cands))) S.takeDraft(-1);
      stats.giveUps++; // 드래프트는 매번 나머지를 포기하는 문법이다
      continue;
    }
    movedThisTurn = false;
    doClaims();
    doKnownCombos();
    doUnknownAttempts();
    if (S.firstBuyer) S.takeFirstBuyer();
    doDeliveries();
    maybeMove();
    doMarket();
    maybeDispatch();
    S.endTurn();
  }

  /* ── 요약 ────────────────────────────────────────────────── */

  const events = S.events;
  let firstSaleTurn = 0, firstCTurn = 0;
  const revenueByCard = new Map<string, number>();
  const soldKinds = new Set<string>();
  const goldCurve: Array<{ turn: number; gold: number; combos: number }> = [];
  const occs: number[] = [];
  for (const e of events) {
    if (e.t === 'sell') {
      if (!firstSaleTurn) firstSaleTurn = e.turn;
      soldKinds.add(e.card);
      revenueByCard.set(e.card, (revenueByCard.get(e.card) ?? 0) + e.gold);
    } else if (e.t === 'combine_ok') {
      if (!firstCTurn && e.first_time && S.card(e.result)?.tier === 'C') firstCTurn = e.turn;
    } else if (e.t === 'turn_end') {
      occs.push(e.occupancy);
      goldCurve.push({ turn: e.turn, gold: e.gold, combos: e.combos });
    }
  }
  const s = S.settlement!;
  const topRevenue = Math.max(0, ...revenueByCard.values());
  const totalRevenue = [...revenueByCard.values()].reduce((acc, x) => acc + x, 0);
  const nd = S.newDiscoveries();
  const midDone = S.contracts.filter((c) => c.slot === 'mid' && c.done).length;
  const midTotal = S.contracts.filter((c) => c.slot === 'mid').length;
  const last3Base = goldCurve[goldCurve.length - 4]?.combos ?? 0;

  return {
    runFail: s.runFail, fulfilled: s.fulfilled, contractsTotal: s.contractsTotal,
    gold: S.gold, settle: s.settle,
    discovered: S.codex.size, discoveredIds: [...S.codex],
    combos: S.combosTotal, turns: S.R.runTurns,
    occAvg: occs.reduce((a, x) => a + x, 0) / (occs.length || 1),
    giveUps: stats.giveUps,
    firstSaleTurn, firstCTurn,
    topShare: totalRevenue ? topRevenue / totalRevenue : 0,
    earlyGoldRate: (goldCurve[6]?.gold ?? S.gold) / 7,
    lateGoldRate: (S.gold - (goldCurve[goldCurve.length - 8]?.gold ?? 0)) / 7,
    combosLast3: S.combosTotal - last3Base,
    soldKinds: soldKinds.size,
    knownKeys: S.carryKeys(),
    newDiscov: nd.total, newDiscovC: nd.tierC,
    midDone, midTotal,
    maxChain: S.maxChain,
    guestsJoined: S.guestsJoined, guestTurns: S.guestTurns,
    feeds: S.feedsCount, strikes: S.strikesCount,
    moves: S.movesCount, dispatches: S.dispatchCount, digs: S.digsCount,
    nearMisses,
  };
}
