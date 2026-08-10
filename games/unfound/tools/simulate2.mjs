#!/usr/bin/env node
/**
 * UNFOUND v2.1 G2 시뮬레이터 — 경제 런.
 *   node tools/simulate2.mjs [판수] [시드] [키=값 ...]
 * 시나리오를 한 번에 돌려 킬 라인 3개 + 보조 지표를 뽑는다.
 *   - 추론 AI 런 실패율 30~50% + 해금 모사(사전지식 0/50/100%)에서 단조 감소
 *   - 선지식 AI(레시피 5개, 발견 안 함) 계약 달성률 < 40%
 *   - 단서(계열) AI가 전수 스캔 AI보다 첫 tier C 도달 30% 이상 빠름
 */
import { loadData, fmtPct, makeRng, pairKey } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  playEconRun, reachableRecipes, readEconRules, rollContracts, rollStartingField,
  newCareer, endRunCareer,
} from './econ2.mjs';

const D = loadData();
D.contracts = JSON.parse(readFileSync(join(D.ROOT, 'data', 'contracts.json'), 'utf8'));
const RUNS = Number(process.argv[2] ?? 2000);
const SEED = Number(process.argv[3] ?? 42);
const overrides = [];
for (const a of process.argv.slice(4)) {
  const m = /^([a-z_0-9]+)=(.+)$/.exec(a);
  if (!m) continue;
  D.rules[m[1]] = m[2] === 'null' ? null : Number.isNaN(Number(m[2])) ? m[2] : Number(m[2]);
  overrides.push(a);
}

/* v2.2 스위치. 킬 라인 3종은 역사적 재현이 목적이므로 **전부 OFF**로 돌리고
   (G2 통과 수치 35.1/31.1/45.7는 이 상태에서 잰 것이다), ON 상태 검증은 뒤에 따로 돈다. */
const V22_OFF = {
  v22_events: 0, v22_review: 0, v22_contract_board: 0, v22_fail_ledger: 0,
  v22_onboarding_first_run_only: 0, v22_mid_count_offset: 0, v22_mid_deadline: 0,
};
const RULES_ON = { ...D.rules };
const RULES_OFF = { ...D.rules, ...V22_OFF };

function scenario(policy, opts = {}, runs = RUNS) {
  const s = {
    runs: 0, fails: 0, fulfilled: 0, contracts: 0, combos: 0, turns: 0,
    discov: [], giveUps: 0, occ: [], firstSale: [], firstC: [], topShare: [],
    early: [], late: [], last3: [], recipesUsed: new Set(), settle: [], soldKinds: [],
  };
  for (let i = 0; i < runs; i++) {
    playEconRun(D, SEED + i * 7919, policy, (e) => {
      if (e.t === 'turn_end') s.occ.push(e.occupancy);
      if (e.t === 'discover') s.recipesUsed.add(e.card);
      if (e.t === 'run_end') {
        s.runs++; s.turns += e.turn; s.combos += e.combos;
        if (e.runFail) s.fails++;
        s.fulfilled += e.fulfilled; s.contracts += e.contractsTotal;
        s.discov.push(e.discovered.length); s.giveUps += e.giveUps;
        if (e.firstSaleTurn) s.firstSale.push(e.firstSaleTurn);
        if (e.firstCTurn) s.firstC.push(e.firstCTurn);
        s.topShare.push(e.topShare); s.early.push(e.earlyGoldRate); s.late.push(e.lateGoldRate);
        s.last3.push(e.combosLast3); s.settle.push(e.settle); s.soldKinds.push(e.soldKinds);
      }
    }, opts);
  }
  return s;
}

const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)] ?? 0; };

console.log(`\nUNFOUND v2.1+v2.2 G2 시뮬 — ${RUNS}판 × 시나리오 (시드 ${SEED})${overrides.length ? '  덮어씀: ' + overrides.join(' ') : ''}`);
console.log('─'.repeat(64));

const reach = reachableRecipes(D, D.regions[0]);
console.log(`숲 도달 가능 레시피: ${reach.length}/${D.recipes.length}`);
console.log('킬 라인 구간은 v2.2 스위치 OFF (G2 재현 상태), [v2.2 ON] 구간만 패치 상태.');

D.rules = RULES_OFF;
const greedy = scenario('greedy');
const reasoner = scenario('reasoner');
const preknown = scenario('preknown');

/** 지역 선택: 계약을 이기려는 플레이어 — 아는 레시피가 가장 많되 발견거리(미지 2개 이상)가 남은 지역. */
function pickRegion(carry, r) {
  const unlockedN = r < 2 ? 1 : r < 4 ? 2 : 3; // 해금 = 공간: 런 3+에 폐허, 런 5+에 화산
  let regionIdx = 0, bestKnown = -1, frontierIdx = 0, frontierUnknown = -1, found = false;
  for (let g = 0; g < unlockedN; g++) {
    const rs = reachableRecipes(D, D.regions[g]);
    const unknown = rs.filter((rc) => !carry.includes([rc.inputs[0], rc.inputs[1]].sort().join('+'))).length;
    const knownN = rs.length - unknown;
    if (unknown > frontierUnknown) { frontierUnknown = unknown; frontierIdx = g; }
    if (unknown >= 2 && knownN > bestKnown) { bestKnown = knownN; regionIdx = g; found = true; }
  }
  return found ? regionIdx : frontierIdx;
}

// 회차 곡선: 같은 플레이어가 런을 거듭 — 계정 도감(발견한 레시피)이 다음 런에 이월 (로그라이트 해금 모델)
function career(players, runsEach) {
  const byRun = Array.from({ length: runsEach }, () => ({ runs: 0, fails: 0 }));
  for (let p = 0; p < players; p++) {
    let carry = [];
    for (let r = 0; r < runsEach; r++) {
      const regionIdx = pickRegion(carry, r);
      playEconRun(D, SEED + (p * runsEach + r) * 7919, 'reasoner', (e) => {
        if (e.t === 'run_end') {
          byRun[r].runs++;
          if (e.runFail) byRun[r].fails++;
          carry = e.knownKeys;
        }
      }, { carryKnown: carry, regionIdx });
    }
  }
  return byRun.map((x) => x.fails / x.runs);
}
const careerCurve = career(Math.max(50, Math.floor(RUNS / 8)), 8);
const satOff = scenario('greedy', { saturationOff: true });
const fullCodex = scenario('reasoner', { fullCodex: true });

const row = (name, s) => {
  const failRate = s.fails / s.runs;
  console.log(
    `${name.padEnd(14)} 실패율 ${fmtPct(failRate).padStart(6)}  계약 ${(s.fulfilled / s.contracts * 100).toFixed(0).padStart(3)}%  ` +
    `조합/턴 ${(s.combos / s.turns).toFixed(2)}  발견 ${avg(s.discov).toFixed(1)}종  점유 ${fmtPct(avg(s.occ))}  ` +
    `포기/판 ${(s.giveUps / s.runs).toFixed(1)}  첫판매 t${med(s.firstSale)}  첫C t${med(s.firstC)}(${fmtPct(s.firstC.length / s.runs)})  자산 ${avg(s.settle).toFixed(0)}G`
  );
  return failRate;
};

console.log('\n[시나리오]');
const fGreedy = row('탐욕(스캔)', greedy);
const fReason = row('추론(단서)', reasoner);
row('선지식(5개)', preknown);
console.log('회차 곡선(실패율)  ' + careerCurve.map((f, i) => `런${i + 1} ${(f * 100).toFixed(0)}%`).join('  '));
row('포화 OFF', satOff);
row('도감 100%', fullCodex);

console.log('\n[킬 라인 판정]');
const okFail = fReason >= 0.30 && fReason <= 0.50;
console.log(`  1. 추론 AI 런 실패율 30~50%      → ${fmtPct(fReason)}  ${okFail ? 'O' : 'X'}`);
const earlyF = (careerCurve[0] + careerCurve[1]) / 2, lateF = (careerCurve[5] + careerCurve[6] + careerCurve[7]) / 3;
const mono = earlyF >= 0.30 && earlyF <= 0.50 && lateF >= 0.15 && lateF <= 0.25 && (earlyF - lateF) >= 0.15;
console.log(`     회차 곡선: 런1~2 30~50% → 런6~8 15~25% (낙폭≥15%p) → ${fmtPct(earlyF)} → ${fmtPct(lateF)}  ${mono ? 'O' : 'X'}`);
const preRate = preknown.fulfilled / preknown.contracts;
console.log(`  2. 선지식 AI 계약 달성률 < 40%   → ${fmtPct(preRate)}  ${preRate < 0.40 ? 'O' : 'X'}`);
const cScan = avg(greedy.firstC), cClue = avg(reasoner.firstC);
const speedup = (cScan - cClue) / cScan;
console.log(`  3. 단서 AI 첫 C 도달 30% 빠름    → 스캔 t${cScan.toFixed(1)} vs 단서 t${cClue.toFixed(1)} (${fmtPct(speedup)})  ${speedup >= 0.30 ? 'O' : 'X'}`);

console.log('\n[보조 지표 (추론 AI 기준)]');
console.log(`  턴당 조합 ≥1.0        → ${(reasoner.combos / reasoner.turns).toFixed(2)}  ${reasoner.combos / reasoner.turns >= 1.0 ? 'O' : 'X'}`);
console.log(`  점유율 65~80%         → ${fmtPct(avg(reasoner.occ))}  ${avg(reasoner.occ) >= 0.65 && avg(reasoner.occ) <= 0.80 ? 'O' : 'X'}`);
console.log(`  판당 발견 ≥7.8종      → ${avg(reasoner.discov).toFixed(1)}  ${avg(reasoner.discov) >= 7.8 ? 'O' : 'X'}`);
console.log(`  행동 포기/판 ≥1.0/턴? → ${(reasoner.giveUps / reasoner.runs).toFixed(1)}회/판`);
console.log(`  포화 ON/OFF: 발견 OFF ${avg(satOff.discov).toFixed(1)} vs ON ${avg(greedy.discov).toFixed(1)} / 판매 상품 종수 OFF ${avg(satOff.soldKinds).toFixed(1)} vs ON ${avg(greedy.soldKinds).toFixed(1)}`);
console.log(`  첫 판매 ≤3턴 (중앙값) → t${med(reasoner.firstSale)}  ${med(reasoner.firstSale) <= 3 ? 'O' : 'X'}`);
console.log(`  최다 상품 매출 <40%   → ${fmtPct(avg(reasoner.topShare))}  ${avg(reasoner.topShare) < 0.40 ? 'O' : 'X'}`);
console.log(`  자산 후반/초반 ≤1.5   → ${(avg(reasoner.late) / (avg(reasoner.early) || 1)).toFixed(2)}`);
console.log(`  마지막 3턴 조합 ≥0.7/턴 → ${(avg(reasoner.last3) / 3).toFixed(2)}`);
console.log(`  도감100% AI 달성률 20~90% → ${fmtPct(fullCodex.fulfilled / fullCodex.contracts)}  ${fullCodex.fulfilled / fullCodex.contracts >= 0.2 && fullCodex.fulfilled / fullCodex.contracts <= 0.9 ? 'O' : 'X'}`);
const usedRecipeResults = new Set([...greedy.recipesUsed, ...reasoner.recipesUsed]);
const reachableResults = new Set(reach.map((r) => r.result));
const unusedShare = 1 - usedRecipeResults.size / reachableResults.size;
console.log(`  미발견 콘텐츠(숲 도달 기준) <30% → ${fmtPct(unusedShare)}  ${unusedShare < 0.3 ? 'O' : 'X'}`);

/* ── v2.2 ON 상태 (이벤트·심사·게시판·장부·온보딩 한정 전부 켬) ──
   07 지시서 검증 조건: 런 실패율 30~50% 밴드 · 자산 곡선 후반 ≤ 초반×1.5 ·
   심사 통과율 60~75%(첫 심사 65~80%) · 첫 계약 90%+ · 무지 플레이어 첫 조합 1턴 ≥85%. */

D.rules = RULES_ON;
const R_ON = readEconRules(D.rules);

function careerOn(players, runsEach) {
  const a = {
    runs: 0, fails: 0, early: [], late: [],
    firstHeld: 0, firstPass: 0, laterHeld: 0, laterPass: 0, retryHeld: 0, retryPass: 0,
    midDone: 0, midTotal: 0, mid1Done: 0, mid1Total: 0, newByRun: Array.from({ length: runsEach }, () => []),
  };
  for (let p = 0; p < players; p++) {
    let carry = [];
    const cs = newCareer(R_ON);
    for (let r = 0; r < runsEach; r++) {
      const regionIdx = pickRegion(carry, r);
      playEconRun(D, SEED + (p * runsEach + r) * 7919, 'reasoner', (e) => {
        if (e.t !== 'run_end') return;
        a.runs++;
        if (e.runFail) a.fails++;
        a.early.push(e.earlyGoldRate);
        a.late.push(e.lateGoldRate);
        a.midDone += e.midDone;
        a.midTotal += e.midTotal;
        if (r === 0) { a.mid1Done += e.midDone; a.mid1Total += e.midTotal; } // 첫 계약 = 새 플레이어의 첫 어음
        a.newByRun[r].push(e.newDiscov);
        carry = e.knownKeys;
        const wasRetry = cs.deferred;
        const wasFirst = !cs.firstReviewDone;
        const res = endRunCareer(R_ON, cs, e.newDiscov, e.newDiscovC);
        if (!res.held) return;
        if (wasRetry) { a.retryHeld++; if (res.pass) a.retryPass++; }
        else if (wasFirst) { a.firstHeld++; if (res.pass) a.firstPass++; }
        else { a.laterHeld++; if (res.pass) a.laterPass++; }
      }, { carryKnown: carry, regionIdx, runIndex: r + 1 });
    }
  }
  return a;
}

/** 무지 플레이어 모델 — 시작 패에서 무작위 쌍을 상한(후보 3장×2=6회)까지 눌러 본다. */
function naiveFirstCombine(runs) {
  let ok = 0;
  for (let i = 0; i < runs; i++) {
    const rng = makeRng(SEED + i * 7919);
    rollContracts(D.contracts, rng); // 실제 런과 같은 난수 소비 순서
    const field = rollStartingField(D, R_ON, D.regions[0], rng);
    const pairs = [];
    for (let x = 0; x < field.length; x++)
      for (let y = x + 1; y < field.length; y++) pairs.push([field[x], field[y]]);
    for (let k = pairs.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      [pairs[k], pairs[j]] = [pairs[j], pairs[k]];
    }
    const cap = R_ON.supply * R_ON.unknownAttemptFactor;
    const tried = new Set();
    let attempts = 0;
    for (const [x, y] of pairs) {
      const key = pairKey(x, y);
      if (tried.has(key)) continue;
      tried.add(key);
      if (D.recipeByKey.has(key)) { ok++; break; }
      if (++attempts >= cap) break;
    }
  }
  return ok / runs;
}

const onPlayers = Math.max(25, Math.floor(RUNS / 16));
const on = careerOn(onPlayers, 8);
const heldTotal = on.firstHeld + on.laterHeld + on.retryHeld;
const passTotal = on.firstPass + on.laterPass + on.retryPass;
const onFail = on.fails / on.runs;
const onCurve = avg(on.late) / (avg(on.early) || 1);
const firstRate = on.firstHeld ? on.firstPass / on.firstHeld : 0;
const allRate = heldTotal ? passTotal / heldTotal : 0;
const retryRate = on.retryHeld ? on.retryPass / on.retryHeld : 0;
const midRate = on.midTotal ? on.midDone / on.midTotal : 0;
const mid1Rate = on.mid1Total ? on.mid1Done / on.mid1Total : 0;
const naive = naiveFirstCombine(Math.min(RUNS, 2000));

console.log(`\n[v2.2 ON 상태 — ${onPlayers}명 × 8회기 = ${on.runs}판 (이벤트·심사·게시판·장부·온보딩 한정 ON)]`);
console.log(`  런 실패율 30~50% 밴드      → ${fmtPct(onFail)}  ${onFail >= 0.30 && onFail <= 0.50 ? 'O' : 'X'}`);
console.log(`  자산 곡선 후반 ≤ 초반×1.5  → ${onCurve.toFixed(2)}  ${onCurve <= 1.5 ? 'O' : 'X'}`);
console.log(`  첫 심사 통과율 65~80%      → ${fmtPct(firstRate)} (판정 ${on.firstHeld}회)  ${firstRate >= 0.65 && firstRate <= 0.80 ? 'O' : 'X'}`);
console.log(`  첫 계약(1회기 mid) 90%+    → ${fmtPct(mid1Rate)}  ${mid1Rate >= 0.90 ? 'O' : 'X'}  (전 회기 mid ${fmtPct(midRate)})`);
console.log(`  무지 플레이어 첫 조합 1턴  → ${fmtPct(naive)}  ${naive >= 0.85 ? 'O' : 'X'}`);
console.log(`  [참고] 심사 전체 ${fmtPct(allRate)} (${heldTotal}회) · 재심 ${fmtPct(retryRate)} (${on.retryHeld}회)`);
console.log(`  [참고] 종 풀 대비 누적 요구량 (08 검산 지표) — 런별 신규 레시피: ${on.newByRun.map((x, i) => `런${i + 1} ${avg(x).toFixed(1)}`).join('  ')}`);
console.log('     이후 심사 창(3회기 12종)은 현행 50레시피 풀에서 구조적으로 고갈된다 — 6계열 증량(재태깅) 전 알려진 임계 (08 문서 3절 검산).');
console.log('');
