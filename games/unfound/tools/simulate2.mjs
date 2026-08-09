#!/usr/bin/env node
/**
 * UNFOUND v2.1 G2 시뮬레이터 — 경제 런.
 *   node tools/simulate2.mjs [판수] [시드] [키=값 ...]
 * 시나리오를 한 번에 돌려 킬 라인 3개 + 보조 지표를 뽑는다.
 *   - 추론 AI 런 실패율 30~50% + 해금 모사(사전지식 0/50/100%)에서 단조 감소
 *   - 선지식 AI(레시피 5개, 발견 안 함) 계약 달성률 < 40%
 *   - 단서(계열) AI가 전수 스캔 AI보다 첫 tier C 도달 30% 이상 빠름
 */
import { loadData, fmtPct } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { playEconRun, reachableRecipes } from './econ2.mjs';

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

console.log(`\nUNFOUND v2.1 G2 시뮬 — ${RUNS}판 × 시나리오 (시드 ${SEED})${overrides.length ? '  덮어씀: ' + overrides.join(' ') : ''}`);
console.log('─'.repeat(64));

const reach = reachableRecipes(D, D.regions[0]);
console.log(`숲 도달 가능 레시피: ${reach.length}/${D.recipes.length}`);

const greedy = scenario('greedy');
const reasoner = scenario('reasoner');
const preknown = scenario('preknown');
const unlock50 = scenario('reasoner', { preknownFraction: 0.5 });
const unlock100 = scenario('reasoner', { preknownFraction: 1.0 });
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
const f50 = row('해금 50%', unlock50);
const f100 = row('해금 100%', unlock100);
row('포화 OFF', satOff);
row('도감 100%', fullCodex);

console.log('\n[킬 라인 판정]');
const okFail = fReason >= 0.30 && fReason <= 0.50;
console.log(`  1. 추론 AI 런 실패율 30~50%      → ${fmtPct(fReason)}  ${okFail ? 'O' : 'X'}`);
const mono = fReason > f50 && f50 > f100 && (fReason - f100) >= 0.15;
console.log(`     해금 모사 단조감소(낙폭≥15%p)  → ${fmtPct(fReason)} > ${fmtPct(f50)} > ${fmtPct(f100)}  ${mono ? 'O' : 'X'}`);
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
console.log('');
