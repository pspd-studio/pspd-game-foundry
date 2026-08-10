#!/usr/bin/env node
/**
 * UNFOUND v3.0 G2 재측정 시뮬레이터 — 경제 런.
 *   node tools/simulate2.mjs [판수] [시드] [키=값 ...]
 *
 * 07 지시서 Phase 2: 구 7칸 수치(35.1/31.1/45.7)는 재현 대상이 아니다 — 규칙이 바뀌었으므로
 * **v3.0 상태 그대로** 킬 라인 3종을 재측정한다 (시드 42·7 교차, 시도 3회 규칙).
 *   1. 추론 AI 런 실패율 30~50%
 *   2. 선지식 AI(레시피 5개, 발견 안 함) 계약 달성률 < 40%
 *   3. 단서(계열) AI가 전수 스캔 AI보다 첫 tier C 도달 30% 이상 빠름
 * + 보조·신규 지표 (지시서 Phase 2 절).
 */
import { loadData, fmtPct, makeRng, pairKey } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  playEconRun, reachableRecipes, readEconRules, rollContracts, rollStartingField,
  newCareer, endRunCareer, unlockedRegionCount,
} from './econ2.mjs';

const D = loadData();
D.contracts = JSON.parse(readFileSync(join(D.ROOT, 'data', 'contracts.json'), 'utf8'));
const GUESTS = JSON.parse(readFileSync(join(D.ROOT, 'data', 'guests.json'), 'utf8'));
const RUNS = Number(process.argv[2] ?? 2000);
const SEED = Number(process.argv[3] ?? 42);
const overrides = [];
for (const a of process.argv.slice(4)) {
  const m = /^([a-z_0-9]+)=(.+)$/.exec(a);
  if (!m) continue;
  D.rules[m[1]] = m[2] === 'null' ? null : Number.isNaN(Number(m[2])) ? m[2] : Number(m[2]);
  overrides.push(a);
}

const R = readEconRules(D.rules);
const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)] ?? 0; };

function scenario(policy, opts = {}, runs = RUNS) {
  const rs = [];
  for (let i = 0; i < runs; i++)
    rs.push(playEconRun(D, SEED + i * 7919, policy, { guests: GUESTS, ...opts }));
  return rs;
}
const failRate = (rs) => rs.filter((r) => r.runFail).length / rs.length;
const contractRate = (rs) => rs.reduce((s, r) => s + r.fulfilled, 0) / rs.reduce((s, r) => s + r.contractsTotal, 0);

console.log(`\nUNFOUND v3.0 G2 재측정 — ${RUNS}판 × 시나리오 (시드 ${SEED})${overrides.length ? '  덮어씀: ' + overrides.join(' ') : ''}`);
console.log('─'.repeat(64));
console.log(`숲 도달 가능 레시피: ${reachableRecipes(D, D.regions[0]).length}/${D.recipes.length} · 펼침 자리 ${R.spreadSlots} · 시도 상한 ${R.unknownAttempts}/턴 · 출입 지역 ${unlockedRegionCount(R, 0, D.regions.length)}(견습)`);

const greedy = scenario('greedy');
const reasoner = scenario('reasoner');
const preknown = scenario('preknown');

const row = (name, rs) => {
  console.log(
    `${name.padEnd(12)} 실패율 ${fmtPct(failRate(rs)).padStart(6)}  계약 ${(contractRate(rs) * 100).toFixed(0).padStart(3)}%  ` +
    `조합/턴 ${(avg(rs.map((r) => r.combos / r.turns))).toFixed(2)}  발견 ${avg(rs.map((r) => r.discovered)).toFixed(1)}종  ` +
    `점유 ${fmtPct(avg(rs.map((r) => r.occAvg)))}  포기/턴 ${avg(rs.map((r) => r.giveUps / r.turns)).toFixed(2)}  ` +
    `첫판매 t${med(rs.map((r) => r.firstSaleTurn).filter(Boolean))}  첫C t${med(rs.map((r) => r.firstCTurn).filter(Boolean))}(${fmtPct(rs.filter((r) => r.firstCTurn).length / rs.length)})  ` +
    `자산 ${avg(rs.map((r) => r.settle)).toFixed(0)}G`
  );
};

console.log('\n[시나리오]');
row('탐욕(스캔)', greedy);
row('추론(단서)', reasoner);
row('선지식(5개)', preknown);
const satOff = scenario('greedy', { saturationOff: true }, Math.max(200, Math.floor(RUNS / 4)));
const fullCodex = scenario('reasoner', { fullCodex: true }, Math.max(200, Math.floor(RUNS / 4)));
row('포화 OFF', satOff);
row('도감 100%', fullCodex);

/* ── 회차 곡선 + 심사 (전 스위치 ON — v3.0 실제 상태. 등급이 지역 출입권을 연다) ── */

function pickRegion(carry, grade) {
  const unlockedN = unlockedRegionCount(R, grade, D.regions.length);
  let regionIdx = 0, bestKnown = -1, frontierIdx = 0, frontierUnknown = -1, found = false;
  for (let g = 0; g < unlockedN; g++) {
    const rs = reachableRecipes(D, D.regions[g]);
    const unknown = rs.filter((rc) => !carry.includes(pairKey(rc.inputs[0], rc.inputs[1]))).length;
    const knownN = rs.length - unknown;
    if (unknown > frontierUnknown) { frontierUnknown = unknown; frontierIdx = g; }
    if (unknown >= 2 && knownN > bestKnown) { bestKnown = knownN; regionIdx = g; found = true; }
  }
  return found ? regionIdx : frontierIdx;
}

function career(policy, players, runsEach) {
  const a = {
    runs: 0, fails: 0, early: [], late: [],
    firstHeld: 0, firstPass: 0, laterHeld: 0, laterPass: 0, retryHeld: 0, retryPass: 0,
    midDone: 0, midTotal: 0, mid1Done: 0, mid1Total: 0,
    newByRun: Array.from({ length: runsEach }, () => []),
    byRunFail: Array.from({ length: runsEach }, () => ({ runs: 0, fails: 0 })),
  };
  for (let p = 0; p < players; p++) {
    let carry = [];
    const cs = newCareer(R);
    for (let r = 0; r < runsEach; r++) {
      const regionIdx = pickRegion(carry, cs.grade);
      const out = playEconRun(D, SEED + (p * runsEach + r) * 7919, policy, {
        carryKnown: carry, regionIdx, runIndex: r + 1, grade: cs.grade, guests: GUESTS,
      });
      a.runs++;
      a.byRunFail[r].runs++;
      if (out.runFail) { a.fails++; a.byRunFail[r].fails++; }
      a.early.push(out.earlyGoldRate);
      a.late.push(out.lateGoldRate);
      a.midDone += out.midDone;
      a.midTotal += out.midTotal;
      if (r === 0) { a.mid1Done += out.midDone; a.mid1Total += out.midTotal; }
      a.newByRun[r].push(out.newDiscov);
      carry = out.knownKeys;
      const wasRetry = cs.deferred;
      const wasFirst = !cs.firstReviewDone;
      const res = endRunCareer(R, cs, out.newDiscov, out.newDiscovC);
      if (!res.held) continue;
      if (wasRetry) { a.retryHeld++; if (res.pass) a.retryPass++; }
      else if (wasFirst) { a.firstHeld++; if (res.pass) a.firstPass++; }
      else { a.laterHeld++; if (res.pass) a.laterPass++; }
    }
  }
  return a;
}

/** 무지 플레이어 모델 — 시작 펼침에서 무작위 쌍을 상한(6회)까지 눌러 본다. */
function naiveFirstCombine(runs) {
  let ok = 0;
  for (let i = 0; i < runs; i++) {
    const rng = makeRng(SEED + i * 7919);
    rollContracts(D.contracts, rng); // 실제 런과 같은 난수 소비 순서
    const field = rollStartingField(D, R, D.regions[0], rng);
    const pairs = [];
    for (let x = 0; x < field.length; x++)
      for (let y = x + 1; y < field.length; y++) pairs.push([field[x], field[y]]);
    for (let k = pairs.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      [pairs[k], pairs[j]] = [pairs[j], pairs[k]];
    }
    const tried = new Set();
    let attempts = 0;
    for (const [x, y] of pairs) {
      const key = pairKey(x, y);
      if (tried.has(key)) continue;
      tried.add(key);
      if (D.recipeByKey.has(key)) { ok++; break; }
      if (++attempts >= R.unknownAttempts) break;
    }
  }
  return ok / runs;
}

const players = Math.max(25, Math.floor(RUNS / 8));
const c = career('reasoner', players, 8);
const cBot = career('preknown', Math.max(25, Math.floor(players / 2)), 8);

/* ── 킬 라인 판정 ── */
console.log('\n[킬 라인 판정 — v3.0 상태 그대로]');
const fReason = failRate(reasoner);
console.log(`  1. 추론 AI 런 실패율 30~50%      → ${fmtPct(fReason)}  ${fReason >= 0.30 && fReason <= 0.50 ? 'O' : 'X'}`);
const preRate = contractRate(preknown);
console.log(`  2. 선지식 AI 계약 달성률 < 40%   → ${fmtPct(preRate)}  ${preRate < 0.40 ? 'O' : 'X'}`);
const cScan = avg(greedy.map((r) => r.firstCTurn).filter(Boolean));
const cClue = avg(reasoner.map((r) => r.firstCTurn).filter(Boolean));
const speedup = (cScan - cClue) / cScan;
console.log(`  3. 단서 AI 첫 C 도달 30% 빠름    → 스캔 t${cScan.toFixed(1)} vs 단서 t${cClue.toFixed(1)} (${fmtPct(speedup)})  ${speedup >= 0.30 ? 'O' : 'X'}`);

/* ── 보조·신규 지표 (07 지시서 Phase 2) ── */
console.log('\n[보조·신규 지표 (추론 AI 기준)]');
const cpt = avg(reasoner.map((r) => r.combos / r.turns));
console.log(`  턴당 조합 ≥1.0             → ${cpt.toFixed(2)}  ${cpt >= 1.0 ? 'O' : 'X'}`);
const gpt = avg(reasoner.map((r) => r.giveUps / r.turns));
console.log(`  행동 포기 ≥1.0/턴          → ${gpt.toFixed(2)}  ${gpt >= 1.0 ? 'O' : 'X'}`);
const curve = avg(c.late) / (avg(c.early) || 1);
console.log(`  자산 곡선 후반 ≤ 초반×1.5  → ${curve.toFixed(2)}  ${curve <= 1.5 ? 'O' : 'X'}`);
const heldTotal = c.firstHeld + c.laterHeld + c.retryHeld;
const passTotal = c.firstPass + c.laterPass + c.retryPass;
const firstRate = c.firstHeld ? c.firstPass / c.firstHeld : 0;
const allRate = heldTotal ? passTotal / heldTotal : 0;
console.log(`  심사 통과율 60~75%         → ${fmtPct(allRate)} (${heldTotal}회)  ${allRate >= 0.60 && allRate <= 0.75 ? 'O' : 'X'}`);
console.log(`  첫 심사 65~80%             → ${fmtPct(firstRate)} (${c.firstHeld}회)  ${firstRate >= 0.65 && firstRate <= 0.80 ? 'O' : 'X'}`);
const botHeld = cBot.firstHeld + cBot.laterHeld + cBot.retryHeld;
const botPass = cBot.firstPass + cBot.laterPass + cBot.retryPass;
const botRate = botHeld ? botPass / botHeld : 0;
console.log(`  회전 봇 심사 통과 <10%     → ${fmtPct(botRate)} (${botHeld}회)  ${botRate < 0.10 ? 'O' : 'X'}`);
const mid1Rate = c.mid1Total ? c.mid1Done / c.mid1Total : 0;
console.log(`  첫 계약(1회기 mid) 90%+    → ${fmtPct(mid1Rate)}  ${mid1Rate >= 0.90 ? 'O' : 'X'}  (전 회기 mid ${fmtPct(c.midTotal ? c.midDone / c.midTotal : 0)})`);
const topShare = avg(reasoner.map((r) => r.topShare));
console.log(`  최다 상품 매출 <40%        → ${fmtPct(topShare)}  ${topShare < 0.40 ? 'O' : 'X'}  (아키타입 프록시)`);
const chainMed = med(reasoner.map((r) => r.maxChain));
console.log(`  연쇄 깊이 중앙값 ≥2        → ${chainMed}  ${chainMed >= 2 ? 'O' : 'X'}`);
const fsMed = med(reasoner.map((r) => r.firstSaleTurn).filter(Boolean));
console.log(`  첫 판매 ≤3턴 (중앙값)      → t${fsMed}  ${fsMed <= 3 ? 'O' : 'X'}`);
const naive = naiveFirstCombine(Math.min(RUNS, 2000));
console.log(`  무지 모델 첫 조합 1턴 ≥85% → ${fmtPct(naive)}  ${naive >= 0.85 ? 'O' : 'X'}`);

/* 식객 가드레일 */
const noGuest = reasoner.filter((r) => r.guestsJoined === 0);
const withGuest = reasoner.filter((r) => r.guestsJoined > 0);
const ngOk = noGuest.filter((r) => !r.runFail).length;
console.log(`  식객 0장 런 계약 성립      → 0장 런 ${noGuest.length}판 중 성공 ${ngOk}판 (실패율 ${fmtPct(noGuest.length ? failRate(noGuest) : 0)} vs 식객 런 ${fmtPct(withGuest.length ? failRate(withGuest) : 0)})  ${ngOk > 0 ? 'O' : 'X'}`);
console.log(`  [참고] 식객 결성 ${fmtPct(withGuest.length / reasoner.length)}판 · 평균 ${avg(reasoner.map((r) => r.guestsJoined)).toFixed(2)}명 · 활동 ${avg(reasoner.map((r) => r.guestTurns)).toFixed(1)}턴/판`);
console.log(`  [참고] 밥값 — 급식 ${avg(reasoner.map((r) => r.feeds)).toFixed(2)}회/판 · 파업 ${avg(reasoner.map((r) => r.strikes)).toFixed(2)}회/판 (밥값 전담 계측)`);
console.log(`  [참고] 이동 ${avg(reasoner.map((r) => r.moves)).toFixed(2)}회/판 · 파견 ${avg(reasoner.map((r) => r.dispatches)).toFixed(2)}회/판 · 파내기 ${avg(reasoner.map((r) => r.digs)).toFixed(1)}회/판`);
console.log(`  [참고] 포화 ON/OFF 발견 격차 — OFF ${avg(satOff.map((r) => r.discovered)).toFixed(1)} vs ON ${avg(greedy.map((r) => r.discovered)).toFixed(1)}종`);
console.log(`  [참고] 도감 100% AI 계약 달성 ${fmtPct(contractRate(fullCodex))} (20~90% 창)`);
console.log(`  [참고] 회차 실패율 — ${c.byRunFail.map((x, i) => `런${i + 1} ${(x.fails / (x.runs || 1) * 100).toFixed(0)}%`).join('  ')}`);
console.log(`  [참고] 런별 신규 레시피 — ${c.newByRun.map((x, i) => `런${i + 1} ${avg(x).toFixed(1)}`).join('  ')}`);
console.log(`  [참고] 재심 통과 ${fmtPct(c.retryHeld ? c.retryPass / c.retryHeld : 0)} (${c.retryHeld}회)`);
console.log('');
