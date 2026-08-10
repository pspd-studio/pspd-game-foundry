#!/usr/bin/env node
/**
 * v3.0 세션 스모크 — 사람이 누를 수 있는 모든 순서를 무작위로 눌러 본다.
 *   node tools/smoke2.mjs [판수] [시드]
 *
 * 잡으려는 것은 밸런스가 아니라 "예외 없이 끝까지 가는가"다.
 * UI 없이 코어(EconSession)만 두들기므로 브라우저 없이 CI에서 돈다.
 * v3.0 행동 공간 전부: 조합·판매·구매·단서·수주·납품·가설·버리기 +
 * 파내기·정리·펼치기·이동·파견·인물 소개·식객(밥값은 자동).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadData, makeRng } from './lib.mjs';
import { EconSession } from '../src/core/econSession.ts';

const D = loadData();
D.contracts = JSON.parse(readFileSync(join(D.ROOT, 'data', 'contracts.json'), 'utf8'));
const GUESTS = JSON.parse(readFileSync(join(D.ROOT, 'data', 'guests.json'), 'utf8'));

const RUNS = Number(process.argv[2] ?? 200);
const SEED = Number(process.argv[3] ?? 42);
const rng = makeRng(SEED);
const pick = (a) => a[Math.floor(rng() * a.length)];

let fails = 0, ends = 0, combos = 0, sells = 0, hints = 0, deliveries = 0, discoveries = 0;
let claims = 0, hypos = 0, visitors = 0, guestsJoined = 0;
let digs = 0, stacks = 0, moves = 0, dispatches = 0, personBuys = 0, feeds = 0, strikes = 0;
let carry = [];

for (let n = 0; n < RUNS; n++) {
  const S = new EconSession(D, (Math.floor(rng() * 0xffffffff) >>> 0) || 1, {
    carryKnown: n % 3 === 0 ? carry : [],
    runIndex: (n % 5) + 1, // 온보딩 첫 런 한정·이벤트 침묵 규칙 두 경로 다 밟는다
    grade: n % 4,          // 등급별 지역 출입권 경로도 밟는다
    guests: GUESTS,
  });
  let guard = 0;
  while (S.phase !== 'over') {
    if (guard++ > 6000) throw new Error(`턴이 끝나지 않는다 (run ${n}, turn ${S.turn})`);

    if (S.phase === 'draft') { S.takeDraft(Math.floor(rng() * 5) - 1, rng() < 0.3 ? Math.floor(rng() * S.piles.length) : undefined); continue; }
    if (S.firstBuyer) { if (rng() < 0.8) S.takeFirstBuyer(); else S.declineFirstBuyer(); continue; }
    if (S.pendingVisitor) {
      if (rng() < 0.7 && S.acceptVisitor()) visitors++;
      else S.declineVisitor();
      continue;
    }

    // v2.2 게시판: 어음을 무작위로 수주한다 (수주 없이는 납품이 안 된다)
    const posted = S.contracts.filter((c) => !c.claimed && !c.failed && S.turn <= c.deadline);
    if (posted.length && rng() < 0.5) { if (S.claim(pick(posted).id)) claims++; continue; }

    const roll = rng();
    if (roll < 0.42 && S.piles.length >= 2) {
      const i = Math.floor(rng() * S.piles.length);
      let j = Math.floor(rng() * S.piles.length);
      if (i === j) j = (j + 1) % S.piles.length;
      const r = S.combine(i, j);
      if (r.ok) { combos++; if (r.firstTime) discoveries++; }
    } else if (roll < 0.5 && S.piles.length) {
      // 솔리테어 조작 3종 — 파내기 / 정리 / 펼치기
      const pi = Math.floor(rng() * S.piles.length);
      const op = rng();
      if (op < 0.4 && S.piles[pi].length > 1) {
        if (S.dig(pi, Math.floor(rng() * (S.piles[pi].length - 1)))) digs++;
      } else if (op < 0.7 && S.piles.length >= 2) {
        let pj = Math.floor(rng() * S.piles.length);
        if (pi === pj) pj = (pj + 1) % S.piles.length;
        if (S.restack(pi, pj)) stacks++;
      } else if (S.piles[pi]?.length > 1) {
        S.unstack(pi);
      }
    } else if (roll < 0.62 && S.canMarket() && S.piles.length) {
      if (S.sell(Math.floor(rng() * S.piles.length))) sells++;
    } else if (roll < 0.68 && S.canMarket()) {
      const r2 = rng();
      if (r2 < 0.4) { if (S.buyHint()) hints++; }
      else if (r2 < 0.7) S.buy(pick(S.buyableCards()));
      else if (S.buyPerson()) personBuys++;
    } else if (roll < 0.74) {
      const c = pick(S.contracts);
      if (S.deliver(c.id)) deliveries++;
    } else if (roll < 0.78) {
      // 가설 기입 — 노출된 실루엣이 있으면 무작위 재료 두 장을 적는다
      const targets = S.hypothesisTargets();
      const mats = S.hypothesisMaterials();
      if (targets.length && mats.length >= 2) {
        const a = pick(mats);
        let b = pick(mats);
        if (a === b) b = mats[(mats.indexOf(a) + 1) % mats.length];
        if (S.writeHypothesis(pick(targets).id, a, b)) hypos++;
      }
    } else if (roll < 0.81) {
      // 이동 — 열린 다른 지역으로
      const to = Math.floor(rng() * S.unlockedRegions);
      if (S.startMove(to)) moves++;
    } else if (roll < 0.84) {
      if (S.dispatch(pick(['explore', 'garden', 'gather']))) dispatches++;
    } else if (roll < 0.88 && S.piles.length) {
      S.discard(Math.floor(rng() * S.piles.length));
    } else {
      S.endTurn();
    }

    // 불변식: 자금 음수 금지. 펼침 자리는 "새 카드 배치"만 막으므로 일시 초과는 허용되지만,
    // 터무니없는 폭주(2배 초과)는 버그다.
    if (S.gold < 0) throw new Error(`자금 음수 ${S.gold} (run ${n})`);
    if (S.used > S.R.spreadSlots * 2) throw new Error(`펼침 폭주 ${S.used}/${S.R.spreadSlots} (run ${n})`);
    for (const p of S.piles) if (!p.length) throw new Error(`빈 더미 (run ${n})`);
  }
  ends++;
  if (S.settlement.runFail) fails++;
  if (!S.events.some((e) => e.t === 'run_end')) throw new Error('run_end 이벤트 없음');
  if (S.turn !== S.R.runTurns) throw new Error(`런 길이 이상: ${S.turn} != ${S.R.runTurns}`);
  guestsJoined += S.guestsJoined;
  feeds += S.feedsCount;
  strikes += S.strikesCount;
  carry = S.carryKeys();
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(`UNFOUND v3.0 세션 스모크 — ${RUNS}판 (시드 ${SEED})`);
console.log(`  완주 ${ends}/${RUNS} · 무작위 플레이 실패율 ${pct(fails / ends)}`);
console.log(`  조합 ${combos} · 발견 ${discoveries} · 판매 ${sells} · 단서 ${hints} · 납품 ${deliveries}`);
console.log(`  수주 ${claims} · 가설 ${hypos} · 인물 영입 ${visitors} · 소개 ${personBuys} · 식객 결성 ${guestsJoined}`);
console.log(`  파내기 ${digs} · 정리 ${stacks} · 이동 ${moves} · 파견 ${dispatches} · 급식 ${feeds} · 파업 ${strikes}`);
console.log('  예외 없음. 자금·더미 불변식 유지.');
