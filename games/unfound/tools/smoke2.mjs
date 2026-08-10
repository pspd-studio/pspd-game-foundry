#!/usr/bin/env node
/**
 * v2.1 세션 스모크 — 사람이 누를 수 있는 모든 순서를 무작위로 눌러 본다.
 *   node tools/smoke2.mjs [판수] [시드]
 *
 * 잡으려는 것은 밸런스가 아니라 "예외 없이 끝까지 가는가"다.
 * UI 없이 코어(EconSession)만 두들기므로 브라우저 없이 CI에서 돈다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadData, makeRng } from './lib.mjs';
import { EconSession } from '../src/core/econSession.ts';

const D = loadData();
D.contracts = JSON.parse(readFileSync(join(D.ROOT, 'data', 'contracts.json'), 'utf8'));

const RUNS = Number(process.argv[2] ?? 200);
const SEED = Number(process.argv[3] ?? 42);
const rng = makeRng(SEED);
const pick = (a) => a[Math.floor(rng() * a.length)];

let fails = 0, ends = 0, combos = 0, sells = 0, hints = 0, deliveries = 0, discoveries = 0;
let carry = [];

for (let n = 0; n < RUNS; n++) {
  const S = new EconSession(D, (Math.floor(rng() * 0xffffffff) >>> 0) || 1, {
    carryKnown: n % 3 === 0 ? carry : [],
  });
  let guard = 0;
  while (S.phase !== 'over') {
    if (guard++ > 4000) throw new Error(`턴이 끝나지 않는다 (run ${n}, turn ${S.turn})`);

    if (S.phase === 'draft') { S.takeDraft(Math.floor(rng() * 4) - 1); continue; }
    if (S.firstBuyer) { if (rng() < 0.8) S.takeFirstBuyer(); else S.declineFirstBuyer(); continue; }

    const roll = rng();
    if (roll < 0.55 && S.field.length >= 2) {
      const i = Math.floor(rng() * S.field.length);
      let j = Math.floor(rng() * S.field.length);
      if (i === j) j = (j + 1) % S.field.length;
      const r = S.combine(i, j);
      if (r.ok) { combos++; if (r.firstTime) discoveries++; }
    } else if (roll < 0.7 && S.canMarket() && S.field.length) {
      if (S.sell(Math.floor(rng() * S.field.length))) sells++;
    } else if (roll < 0.75 && S.canMarket()) {
      if (S.buyHint()) hints++;
      else S.buy(pick(S.buyableCards()));
    } else if (roll < 0.82) {
      const c = pick(S.contracts);
      if (S.deliver(c.id)) deliveries++;
    } else if (roll < 0.86 && S.field.length) {
      S.discard(Math.floor(rng() * S.field.length));
    } else {
      S.endTurn();
    }

    // 불변식: 슬롯을 절대 넘지 않는다
    if (S.used > S.R.fieldSlots) throw new Error(`슬롯 초과 ${S.used}/${S.R.fieldSlots} (run ${n})`);
    if (S.gold < 0) throw new Error(`자금 음수 ${S.gold} (run ${n})`);
  }
  ends++;
  if (S.settlement.runFail) fails++;
  if (!S.events.some((e) => e.t === 'run_end')) throw new Error('run_end 이벤트 없음');
  if (S.turn !== S.R.runTurns) throw new Error(`런 길이 이상: ${S.turn} != ${S.R.runTurns}`);
  carry = S.carryKeys();
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(`UNFOUND v2.1 세션 스모크 — ${RUNS}판 (시드 ${SEED})`);
console.log(`  완주 ${ends}/${RUNS} · 무작위 플레이 실패율 ${pct(fails / ends)}`);
console.log(`  조합 ${combos} · 발견 ${discoveries} · 판매 ${sells} · 단서 ${hints} · 납품 ${deliveries}`);
console.log('  예외 없음. 슬롯·자금 불변식 유지.');
