#!/usr/bin/env node
/**
 * 자동 플레이 시뮬레이터.
 *   node tools/simulate.mjs [판수] [시드] [키=값 ...]
 *   예: node tools/simulate.mjs 2000 42
 *       node tools/simulate.mjs 2000 42 discard_per_turn=0    ← rules.json을 고치지 않고 대조만
 *
 * 사람이 손으로 못 하는 일을 대신한다: 수천 판을 돌려서
 *   - 승률이 극단(90% 이상 / 20% 이하)으로 쏠리는지
 *   - 아무도 안 쓰는 레시피가 몇 개인지
 *   - 필드 슬롯이 실제로 압박으로 작동하는지 (평균 점유율)
 *   - 한 턴에 연쇄가 몇 번이나 터지는지 (기획 22-C)
 *   - 한 판에서 발견물을 몇 종류나 보는지 (이 게임의 재미 자체)
 * 를 숫자로 뽑는다.
 *
 * ★ 게임 규칙은 여기에 없다. src/core가 유일한 구현이고 이 파일은 그것을 돌려서
 *   이벤트 스트림을 집계하는 계측기일 뿐이다. 브라우저 빌드도 같은 코어를 쓴다.
 *
 * 주의: AI는 탐욕적으로 둔다. 사람 플레이어보다 약하다.
 * 절대값이 아니라 값을 바꿨을 때의 '변화 방향'을 보는 도구다.
 */
import { loadData, fmtPct } from './lib.mjs';
import { playRunAuto, readSwitches } from '../src/core/index.ts';

const D = loadData();
const RUNS = Number(process.argv[2] ?? 1000);
const SEED = Number(process.argv[3] ?? 12345);

// 시나리오 대조용 임시 덮어쓰기. rules.json은 건드리지 않는다.
const overrides = [];
for (const a of process.argv.slice(4)) {
  const m = /^([a-z_]+)=(.+)$/.exec(a);
  if (!m) continue;
  const v = m[2] === 'null' ? null : Number.isNaN(Number(m[2])) ? m[2] : Number(m[2]);
  D.rules[m[1]] = v;
  overrides.push(`${m[1]}=${m[2]}`);
}

const DISCARD = readSwitches(D.rules).discard_per_turn;

const stats = {
  wins: 0, losses: 0, turns: 0, combos: 0, maxChain: 0,
  recipeUse: new Map(D.recipes.map((r) => [r.id, 0])),
  cardSeen: new Map(D.cards.map((c) => [c.id, 0])),
  slotOccupancy: [], hpLeft: [],
  discovKinds: [], discovTierC: [], drawTries: 0, drawSkipped: 0, discarded: 0,
  failedCombines: 0,
};

/** 코어가 흘리는 이벤트를 지표로 접는다. 여기가 3단계 Supabase 전송이 붙을 자리와 같은 seam이다. */
function collect(e) {
  switch (e.t) {
    case 'draw':
      stats.drawTries++;
      if (e.accepted) stats.cardSeen.set(e.card, stats.cardSeen.get(e.card) + 1);
      else stats.drawSkipped++;
      break;
    case 'combine_ok':
      stats.combos++;
      stats.recipeUse.set(e.recipe, stats.recipeUse.get(e.recipe) + 1);
      if (e.chain_index > stats.maxChain) stats.maxChain = e.chain_index;
      break;
    case 'combine_fail':
      if (e.reason === 'no_recipe') stats.failedCombines++;
      break;
    case 'discard':
      if (e.by === 'ai_dead_card') stats.discarded++;
      break;
    case 'turn_end':
      stats.slotOccupancy.push(e.occupancy);
      break;
    case 'run_end':
      if (e.result === 'win') { stats.wins++; stats.hpLeft.push(e.hp_left); }
      else stats.losses++;
      stats.turns += e.turn;
      stats.discovKinds.push(e.discovered.length);
      stats.discovTierC.push(e.discovered.filter((id) => D.cardById.get(id).tier === 'C').length);
      break;
  }
}

for (let i = 0; i < RUNS; i++) playRunAuto(D, SEED + i * 7919, collect);

const total = stats.wins + stats.losses;
const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const unused = [...stats.recipeUse].filter(([, n]) => n === 0).map(([id]) => id);
const rarely = [...stats.recipeUse].filter(([, n]) => n > 0 && n < RUNS * 0.02).map(([id, n]) => `${id}(${n})`);
// tier B/C는 조합으로만 얻는 것이 정상이므로, 지역 풀 누락은 tier A만 문제 삼는다.
const unseen = [...stats.cardSeen]
  .filter(([id, n]) => n === 0 && D.cardById.get(id).tier === 'A')
  .map(([id]) => id);

const line = '─'.repeat(60);
console.log(`\n${line}\nUNFOUND 시뮬레이션 — ${RUNS}판 (시드 ${SEED})\n${line}`);
if (overrides.length) console.log(`덮어쓴 값     ${overrides.join(' ')}  (rules.json은 그대로)`);
console.log(`승률          ${fmtPct(stats.wins / total)}  (승 ${stats.wins} / 패 ${stats.losses})`);
console.log(`평균 턴 수    ${(stats.turns / total).toFixed(1)}`);
console.log(`턴당 조합     ${(stats.combos / stats.turns).toFixed(2)}회   최장 연쇄 ${stats.maxChain}회`);
console.log(`판당 발견     ${avg(stats.discovKinds).toFixed(1)}종  (그중 tier C ${avg(stats.discovTierC).toFixed(2)}종)`);
console.log(`필드 점유율   ${fmtPct(avg(stats.slotOccupancy))}  (100%에 가까울수록 슬롯이 실제 압박으로 작동)`);
console.log(`드로우 폐기율 ${fmtPct(stats.drawSkipped / (stats.drawTries || 1))}  (칸이 없어 공급 카드를 버린 비율)`);
console.log(`버린 카드     ${(stats.discarded / total).toFixed(1)}장/판  (버리기 한도 ${DISCARD}장/턴)`);
console.log(`승리 시 잔여HP ${avg(stats.hpLeft).toFixed(1)} / ${D.rules.player_hp}`);

console.log(`\n[한 번도 안 쓰인 레시피 ${unused.length}개]`);
console.log(unused.length ? '  ' + unused.join(', ') : '  없음');
console.log(`\n[거의 안 쓰인 레시피 ${rarely.length}개]`);
console.log(rarely.length ? '  ' + rarely.join(', ') : '  없음');
if (unseen.length) console.log(`\n[어떤 지역에도 안 나오는 카드]\n  ${unseen.join(', ')}`);

console.log(`\n판정`);
const wr = stats.wins / total;
if (wr > 0.9) console.log('  ! 승률이 너무 높습니다. 탐욕적 AI로도 이 정도면 사람은 거의 안 집니다.');
else if (wr < 0.2) console.log('  ! 승률이 너무 낮습니다. 다만 AI가 약해서일 수 있으니 사람 플레이와 대조하세요.');
else console.log('  승률은 검증 가능한 구간에 있습니다.');
if (avg(stats.slotOccupancy) < 0.7) console.log('  ! 필드 점유율이 낮습니다. 7칸 제한이 압박으로 작동하지 않고 있습니다.');
if (stats.combos / stats.turns > 5) console.log('  ! 턴당 연쇄가 깁니다. 전투가 자동 해결처럼 느껴질 위험 (기획 22-C).');
console.log(`\n${line}\n`);
