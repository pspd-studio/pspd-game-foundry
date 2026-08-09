#!/usr/bin/env node
/**
 * 스모크 테스트 — "한 판이 끝까지 돌아가는가"를 브라우저 없이 증명한다.
 *   node tools/smoke.mjs
 *
 * 하는 일
 *   1. 코어로 실제 한 판을 굴려 시작 → 조합 → 적 하강 → 승리/패배까지 출력한다 (승/패 둘 다)
 *   2. 조합 실패(레시피 없는 쌍)가 이벤트로 남는지 확인한다
 *   3. 렌더 함수(src/ui/view.ts는 문자열을 돌려주는 순수 함수)를 단위 확인한다:
 *      data의 모든 카드 이름이 화면에 나오고, slot_cost가 폭(--w)으로 반영되는지
 *   4. 미확정 스위치 3종이 실제로 동작을 바꾸는지 확인한다
 *
 * 실패하면 종료 코드 1.
 */
import { loadData } from './lib.mjs';
import {
  createGame, attemptCombine, discardAt, endTurn, aiCombinePhase, aiDiscardPhase,
  recipeFor, usedSlots, readSwitches, playRunAuto,
} from '../src/core/index.ts';
import { boardHTML, cardChipHTML } from '../src/ui/view.ts';

const D = loadData();
const fails = [];
const ok = (cond, label) => { if (!cond) fails.push(label); return cond; };
const line = '─'.repeat(60);
const nm = (id) => D.cardById.get(id)?.name_ko ?? id;

/* ── 1. 한 판 전체 (해설 출력) ───────────────────────────────── */

function playNarrated(seed, label) {
  const events = [];
  const emit = (e) => events.push(e);
  let st = createGame(D, seed, emit);
  console.log(`\n${line}\n[${label}] 시드 ${seed} · 지역 ${st.regionId}`);
  console.log(`  시작 필드: ${st.field.map((c) => `${c.name_ko}(${c.slot_cost})`).join(' ')}  ${usedSlots(st.field)}/${D.rules.field_slots}칸`);
  console.log(`  적: ${st.enemies.map((e) => `${e.name_ko} HP${e.hp} @row${e.row}`).join(' / ')}`);

  let guard = 0;
  while (!st.over && guard++ < 40) {
    const t = st.turn;
    const mark = events.length;
    st = aiCombinePhase(D, st, emit);
    st = aiDiscardPhase(D, st, emit);
    st = endTurn(D, st, emit);
    const fresh = events.slice(mark);
    const combos = fresh.filter((e) => e.t === 'combine_ok');
    const reach = fresh.filter((e) => e.t === 'enemy_reach');
    const parts = [];
    if (combos.length) {
      parts.push(combos.map((c) => `${nm(c.inputs[0])}+${nm(c.inputs[1])}→${nm(c.result)}`).join(', '));
    } else parts.push('조합 없음');
    if (reach.length) parts.push(`피격 ${reach.map((r) => `${D.enemyById.get(r.enemy).name_ko} -${r.damage}`).join(',')}`);
    const rows = st.enemies.filter((e) => e.hp > 0).map((e) => `${e.name_ko}@${e.row}`).join(' ') || '전멸';
    console.log(`  T${String(t).padStart(2)} HP${String(st.hp).padStart(3)} | ${parts.join(' | ')} | 적 ${rows}`);
  }
  const end = events.find((e) => e.t === 'run_end');
  console.log(`  결과: ${end.result === 'win' ? '승리' : '패배'} (턴 ${end.turn}, 발견 ${end.discovered.length}종: ${end.discovered.map(nm).join(', ') || '없음'})`);
  ok(!!st.over, `[${label}] 판이 끝나지 않았습니다`);
  ok(events.some((e) => e.t === 'combine_ok'), `[${label}] 조합이 한 번도 일어나지 않았습니다`);
  return { st, events };
}

// 승리 시드와 패배 시드를 각각 찾아 둘 다 끝까지 굴린다.
let winSeed = null;
let lossSeed = null;
for (let s = 1; s <= 400 && (winSeed === null || lossSeed === null); s++) {
  const res = playRunAuto(D, s * 7919, () => {});
  if (res.over === 'win' && winSeed === null) winSeed = s * 7919;
  if (res.over === 'loss' && lossSeed === null) lossSeed = s * 7919;
}
ok(winSeed !== null, '승리하는 판을 찾지 못했습니다');
ok(lossSeed !== null, '패배하는 판을 찾지 못했습니다');

const won = playNarrated(winSeed, '승리 케이스');
const lost = playNarrated(lossSeed, '패배 케이스');
ok(won.st.over === 'win', '승리 케이스가 승리로 끝나지 않았습니다');
ok(lost.st.over === 'loss', '패배 케이스가 패배로 끝나지 않았습니다');
ok(lost.events.some((e) => e.t === 'enemy_reach'), '패배 케이스에 적 하강(피격) 기록이 없습니다');

/* ── 2. 조합 실패가 로그에 남는가 ────────────────────────────── */

console.log(`\n${line}\n[실패 조합 로그]`);
{
  // 레시피가 없는 쌍을 데이터에서 찾아 시도한다 (카드 id를 코드에 적지 않는다).
  let pair = null;
  outer: for (const a of D.cards) {
    for (const b of D.cards) {
      if (a.id === b.id) continue;
      if (!recipeFor(D, a.id, b.id)) { pair = [a, b]; break outer; }
    }
  }
  ok(!!pair, '레시피 없는 쌍을 찾지 못했습니다');
  const evs = [];
  let st = createGame(D, 12345, (e) => evs.push(e));
  st.field = [pair[0], pair[1]];
  const before = evs.length;
  const res = attemptCombine(D, st, 0, 1, (e) => evs.push(e));
  const fail = evs.slice(before).find((e) => e.t === 'combine_fail');
  ok(res.outcome.ok === false && res.outcome.reason === 'no_recipe', '레시피 없는 쌍이 실패로 처리되지 않았습니다');
  ok(!!fail, '실패한 조합이 로그 이벤트로 남지 않았습니다');
  console.log(`  ${pair[0].name_ko} + ${pair[1].name_ko} → 실패, 이벤트 ${fail ? `combine_fail(cost=${fail.cost})` : '없음'}`);

  // 성공 쌍은 discovery_text를 반환한다
  const r0 = D.recipes[0];
  let st2 = createGame(D, 777, () => {});
  st2.field = [D.cardById.get(r0.inputs[0]), D.cardById.get(r0.inputs[1])];
  const good = attemptCombine(D, st2, 0, 1, () => {});
  ok(good.outcome.ok && good.outcome.discovery_text === r0.discovery_text, 'discovery_text가 전달되지 않았습니다');
  console.log(`  ${nm(r0.inputs[0])} + ${nm(r0.inputs[1])} → ${nm(r0.result)} : "${good.outcome.ok ? good.outcome.discovery_text : ''}"`);

  // 버리기 한도
  const lim = readSwitches(D.rules).discard_per_turn;
  let st3 = createGame(D, 999, () => {});
  let cnt = 0;
  for (let i = 0; i < lim + 2; i++) {
    const r = discardAt(D, st3, 0, () => {}, 'player');
    if (!r.ok) break;
    st3 = r.state; cnt++;
  }
  ok(cnt === lim, `버리기 한도가 rules.json(discard_per_turn=${lim})과 다릅니다: ${cnt}`);
  console.log(`  버리기 한도 ${cnt}장/턴 (rules.json 값과 일치)`);
}

/* ── 3. 렌더 함수 단위 확인 ─────────────────────────────────── */

console.log(`\n${line}\n[렌더 단위 확인]`);
{
  const vm = { selected: [0], discardMode: false, tutorialStep: 0 };
  const st = won.st;
  const html = boardHTML(D, st, vm);
  ok(html.includes('class="field'), 'boardHTML에 필드가 없습니다');
  ok(html.includes('턴 종료'), 'boardHTML에 턴 종료 버튼이 없습니다');
  ok(html.includes('발견'), 'boardHTML에 발견 수치가 없습니다');

  // 도감에 discovery_text가 그대로 나오는가
  for (const id of st.knownRecipes) {
    const r = D.recipes.find((x) => x.id === id);
    if (!r.discovery_text) continue;
    ok(html.includes(r.discovery_text.replace(/'/g, '&#39;')), `도감에 '${id}'의 discovery_text가 없습니다`);
  }

  // data의 모든 카드가 코드 수정 없이 렌더되는가 + slot_cost가 폭에 반영되는가
  let widthOk = true;
  const missing = [];
  for (const c of D.cards) {
    const chip = cardChipHTML(c, 0, { selected: [], discardMode: false, tutorialStep: 0 });
    if (!chip.includes(`>${c.name_ko}<`)) missing.push(c.id);
    if (!chip.includes(`--w:${c.slot_cost}`)) widthOk = false;
  }
  ok(missing.length === 0, `렌더되지 않는 카드: ${missing.join(', ')}`);
  ok(widthOk, 'slot_cost가 카드 폭(--w)에 반영되지 않습니다');
  const byCost = new Map();
  for (const c of D.cards) byCost.set(c.slot_cost, (byCost.get(c.slot_cost) ?? 0) + 1);
  console.log(`  카드 ${D.cards.length}장 전부 렌더됨. 폭 분포: ${[...byCost].sort().map(([k, v]) => `${k}칸 ${v}장`).join(' / ')}`);
  console.log(`  도감 항목 ${st.knownRecipes.length}개, HTML ${html.length}자`);
}

/* ── 4. 미확정 스위치가 실제로 작동하는가 ───────────────────── */

console.log(`\n${line}\n[SSOT 미확정 스위치]`);
{
  const base = JSON.stringify(D.rules);
  const trial = (patch, label) => {
    Object.assign(D.rules, patch);
    let n = 0;
    let hp = 0;
    for (let i = 0; i < 40; i++) {
      const st = playRunAuto(D, 4242 + i * 7919, () => { n++; });
      hp += st.hp;
    }
    D.rules = JSON.parse(base);
    console.log(`  ${label}: 이벤트 ${n}건, 평균 잔여HP ${(hp / 40).toFixed(1)}`);
    return n;
  };
  const a = trial({}, '현행 (persist / none / 열화없음)');
  const b = trial({ enemy_on_reach: 'despawn' }, 'enemy_on_reach=despawn');
  const c = trial({ discard_decay: 'remove_from_pool' }, 'discard_decay=remove_from_pool');
  ok(a !== b, 'enemy_on_reach 스위치가 동작을 바꾸지 않습니다');
  ok(a !== c, 'discard_decay 스위치가 동작을 바꾸지 않습니다');

  // failed_combine_cost는 AI가 실패 조합을 하지 않으므로 직접 확인한다
  let pair = null;
  outer2: for (const x of D.cards) for (const y of D.cards) {
    if (x.id !== y.id && !recipeFor(D, x.id, y.id)) { pair = [x, y]; break outer2; }
  }
  for (const cost of ['none', 'hp', 'turn']) {
    D.rules.failed_combine_cost = cost;
    let st = createGame(D, 55, () => {});
    st.field = [pair[0], pair[1]];
    const before = st.hp;
    const r = attemptCombine(D, st, 0, 1, () => {});
    const s2 = r.state;
    console.log(`  failed_combine_cost=${cost}: HP ${before}→${s2.hp}, 턴잠김 ${s2.turnLocked}`);
    if (cost === 'none') ok(s2.hp === before && !s2.turnLocked, 'none인데 비용이 발생했습니다');
    if (cost === 'hp') ok(s2.hp === before - 1, 'hp인데 HP가 줄지 않았습니다');
    if (cost === 'turn') ok(s2.turnLocked === true, 'turn인데 턴이 잠기지 않았습니다');
  }
  D.rules = JSON.parse(base);
  console.log(`  (기본값은 rules.json 그대로 — 현행 유지: failed_combine_cost=${readSwitches(D.rules).failed_combine_cost})`);
}

/* ── 결과 ───────────────────────────────────────────────────── */

console.log(`\n${line}`);
if (fails.length) {
  console.log(`스모크 실패 ${fails.length}건`);
  fails.forEach((f) => console.log(`  x ${f}`));
  console.log(`${line}\n`);
  process.exit(1);
}
console.log('스모크 통과 — 한 판이 끝까지 돌아가고, 렌더는 data만 보고 그려집니다.');
console.log(`${line}\n`);
