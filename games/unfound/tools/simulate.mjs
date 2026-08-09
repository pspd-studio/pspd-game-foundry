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
 * 주의: AI는 탐욕적으로 둔다. 사람 플레이어보다 약하다.
 * 절대값이 아니라 값을 바꿨을 때의 '변화 방향'을 보는 도구다.
 */
import { loadData, pairKey, cardPower, fmtPct, makeRng, pick } from './lib.mjs';

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

const DISCARD = D.rules.discard_per_turn ?? 0;

const stats = {
  wins: 0, losses: 0, turns: 0, combos: 0, maxChain: 0,
  recipeUse: new Map(D.recipes.map((r) => [r.id, 0])),
  cardSeen: new Map(D.cards.map((c) => [c.id, 0])),
  slotOccupancy: [], hpLeft: [],
  discovKinds: [], discovTierC: [], drawTries: 0, drawSkipped: 0, discarded: 0,
};

function usedSlots(field) {
  return field.reduce((s, c) => s + c.slot_cost, 0);
}

function applyEffects(card, state) {
  for (const id of card.effects || []) {
    const e = D.effectById.get(id);
    if (!e) continue;
    const alive = () => state.enemies.filter((x) => x.hp > 0);
    switch (e.category) {
      case 'attack': {
        const targets = e.target === 'enemy_all' ? alive()
          : e.target === 'enemy_row' ? alive().slice(0, 2)
          : alive().slice(0, 1);
        for (const t of targets) {
          if (e.params.hp_max != null) { if (t.hp <= e.params.hp_max) t.hp = 0; }
          else t.hp -= e.params.amount ?? 0;
        }
        break;
      }
      case 'control': {
        const targets = e.target === 'enemy_all' ? alive() : alive().slice(0, 1);
        for (const t of targets) {
          if (e.params.turns) t.stunned = (t.stunned ?? 0) + e.params.turns;
          if (e.params.cells) t.row += e.params.cells;
          if (id === 'cancel_action') t.stunned = (t.stunned ?? 0) + 1;
        }
        break;
      }
      case 'card': {
        if (id === 'card_draw_2') state.pendingDraw += 2;
        if (id === 'slot_free_1') state.bonusSlots += 1;
        if (id === 'card_add_random') state.pendingDraw += 1;
        break;
      }
      case 'survive': {
        if (e.params.amount) state.hp = Math.min(D.rules.player_hp, state.hp + e.params.amount);
        break;
      }
    }
  }
}

function hasPartner(field, i) {
  for (let j = 0; j < field.length; j++) {
    if (i === j) continue;
    if (D.recipeByKey.has(pairKey(field[i].id, field[j].id))) return true;
  }
  return false;
}

/**
 * 버리기: 조합 상대가 하나도 없는 카드를 최대 n장 버린다.
 * 사람이라면 "이건 쓸 데가 없다"고 판단해 버릴 카드만 버리는 보수적 모델이다.
 * 상대가 있는 카드까지 버리는 공격적 플레이는 이보다 더 잘 나올 수 있다.
 */
function discardDead(field, n) {
  let removed = 0;
  for (let d = 0; d < n; d++) {
    let idx = -1;
    for (let i = 0; i < field.length; i++) if (!hasPartner(field, i)) { idx = i; break; }
    if (idx < 0) break;
    field.splice(idx, 1);
    removed++;
  }
  return removed;
}

function findBestCombo(field) {
  let best = null;
  for (let i = 0; i < field.length; i++) {
    for (let j = i + 1; j < field.length; j++) {
      const r = D.recipeByKey.get(pairKey(field[i].id, field[j].id));
      if (!r) continue;
      const result = D.cardById.get(r.result);
      const gain = cardPower(result, D.effectById)
        - cardPower(field[i], D.effectById) * 0.4
        - cardPower(field[j], D.effectById) * 0.4;
      if (!best || gain > best.gain) best = { i, j, r, result, gain };
    }
  }
  return best;
}

/** 한 판이 끝날 때 '그 판에서 몇 종류를 발견했는가'를 기록한다. 이 게임의 재미 지표다. */
function finishRun(discovered) {
  stats.discovKinds.push(discovered.size);
  stats.discovTierC.push([...discovered].filter((id) => D.cardById.get(id).tier === 'C').length);
}

function runOne(seed) {
  const rng = makeRng(seed);
  const region = pick(D.regions, rng);
  const pool = region.card_pool;

  const state = {
    hp: D.rules.player_hp, pendingDraw: 0, bonusSlots: 0,
    enemies: region.enemy_pool.map((id, k) => {
      const e = D.enemyById.get(id);
      return { ...e, hp: e.hp, row: e.start_row + k, stunned: 0 };
    }),
  };

  const field = [];
  const discovered = new Set();
  const draw = (n) => {
    for (let k = 0; k < n; k++) {
      stats.drawTries++;
      const cap = D.rules.field_slots + state.bonusSlots;
      const c = D.cardById.get(pick(pool, rng));
      if (usedSlots(field) + c.slot_cost > cap) { stats.drawSkipped++; continue; }
      field.push(c);
      stats.cardSeen.set(c.id, stats.cardSeen.get(c.id) + 1);
    }
  };
  draw(D.rules.starting_hand);

  let turn = 0;
  while (turn < 30) {
    turn++;
    // 조합 단계 — 횟수 제한 없음
    let chain = 0;
    while (chain < 25) {
      const best = findBestCombo(field);
      if (!best || best.gain <= 0) break;
      const cap = D.rules.field_slots + state.bonusSlots;
      const after = usedSlots(field) - field[best.i].slot_cost - field[best.j].slot_cost + best.result.slot_cost;
      if (after > cap) break;
      field.splice(best.j, 1);
      field.splice(best.i, 1);
      field.push(best.result);
      applyEffects(best.result, state);
      stats.recipeUse.set(best.r.id, stats.recipeUse.get(best.r.id) + 1);
      discovered.add(best.result.id);
      chain++;
    }
    stats.combos += chain;
    if (chain > stats.maxChain) stats.maxChain = chain;

    // 버리기 단계 — 조합 상대가 없는 카드를 치운다
    if (DISCARD > 0) stats.discarded += discardDead(field, DISCARD);

    stats.slotOccupancy.push(usedSlots(field) / D.rules.field_slots);

    if (state.enemies.every((e) => e.hp <= 0)) { stats.wins++; stats.turns += turn; stats.hpLeft.push(state.hp); finishRun(discovered); return; }

    // 적 행동
    for (const e of state.enemies) {
      if (e.hp <= 0) continue;
      if (e.stunned > 0) { e.stunned--; continue; }
      if (e.row > 0) e.row -= e.behavior === 'slow_heavy' && turn % 2 === 0 ? 0 : 1;
      if (e.row <= 0) {
        state.hp -= e.behavior === 'slow_heavy' ? D.rules.enemy_reach_damage_heavy : D.rules.enemy_reach_damage;
        // enemy_on_reach: despawn 이면 도달과 동시에 사라진다 → 전투가 성립하지 않는다(승률 100%).
        if (D.rules.enemy_on_reach === 'despawn') e.hp = 0;
      }
      if (e.behavior === 'steal_card' && field.length) field.splice(Math.floor(rng() * field.length), 1);
    }
    if (state.hp <= 0) { stats.losses++; stats.turns += turn; finishRun(discovered); return; }

    // 공급
    state.bonusSlots = 0;
    draw(D.rules.supply_candidates_per_turn + state.pendingDraw);
    state.pendingDraw = 0;
  }
  stats.losses++; stats.turns += turn; finishRun(discovered);
}

for (let i = 0; i < RUNS; i++) runOne(SEED + i * 7919);

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
