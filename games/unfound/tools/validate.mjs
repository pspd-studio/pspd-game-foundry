#!/usr/bin/env node
/**
 * 데이터 무결성 + 레시피 그래프 건강도 검사.
 *   node tools/validate.mjs
 * 오류가 있으면 종료 코드 1. 경고는 통과시키되 목록으로 남긴다.
 *
 * 여기서 검사하는 "분기도(branch factor)"가 기획의 8장(조합 순서가 중요하다)이
 * 실제로 성립하는지를 판정하는 지표다. 카드 하나가 조합할 수 있는 상대가
 * 1개뿐이면 플레이어에게는 선택지가 없고, 순서 재미도 발생하지 않는다.
 */
import { loadData, pairKey, cardPower } from './lib.mjs';

const D = loadData();
const errors = [];
const warnings = [];
const TARGET_BRANCH = 3;

// ── 1. 참조 무결성 ────────────────────────────────────────────
for (const c of D.cards) {
  for (const e of c.effects || []) {
    if (!D.effectById.has(e)) errors.push(`카드 '${c.id}'가 없는 효과 '${e}'를 참조합니다.`);
  }
  if (!c.slot_cost || c.slot_cost < 1) errors.push(`카드 '${c.id}'의 slot_cost가 없습니다.`);
  if (c.slot_cost > D.rules.field_slots) errors.push(`카드 '${c.id}'가 필드 전체(${D.rules.field_slots}칸)보다 큽니다.`);
}
for (const r of D.recipes) {
  if (r.inputs?.length !== 2) errors.push(`레시피 '${r.id}'의 재료가 2개가 아닙니다.`);
  for (const i of r.inputs || []) {
    if (!D.cardById.has(i)) errors.push(`레시피 '${r.id}'가 없는 재료 '${i}'를 참조합니다.`);
  }
  if (!D.cardById.has(r.result)) errors.push(`레시피 '${r.id}'의 결과 '${r.result}'가 카드 목록에 없습니다.`);
  if (!r.discovery_text) warnings.push(`레시피 '${r.id}'에 발견 문구가 없습니다.`);
  if (!Array.isArray(r.conditions)) errors.push(`레시피 '${r.id}'에 conditions 배열이 없습니다.`);
}
for (const rg of D.regions) {
  for (const c of rg.card_pool) if (!D.cardById.has(c)) errors.push(`지역 '${rg.id}'가 없는 카드 '${c}'를 참조합니다.`);
  for (const e of rg.enemy_pool) if (!D.enemyById.has(e)) errors.push(`지역 '${rg.id}'가 없는 적 '${e}'를 참조합니다.`);
}

// ── 2. 중복 레시피 (순서 무관) ────────────────────────────────
const seen = new Map();
for (const r of D.recipes) {
  const k = pairKey(r.inputs[0], r.inputs[1]);
  if (seen.has(k)) errors.push(`레시피 '${r.id}'와 '${seen.get(k)}'가 같은 재료 조합(${k})입니다. 한 조합은 한 결과만 가질 수 있습니다.`);
  seen.set(k, r.id);
}

// ── 3. 그래프 건강도 ──────────────────────────────────────────
const asInput = new Map(D.cards.map((c) => [c.id, new Set()]));
const asResult = new Map(D.cards.map((c) => [c.id, 0]));
for (const r of D.recipes) {
  const [a, b] = r.inputs;
  asInput.get(a)?.add(b);
  asInput.get(b)?.add(a);
  asResult.set(r.result, (asResult.get(r.result) ?? 0) + 1);
}

const lowBranch = [];
const orphans = [];
const deadEnds = [];
for (const c of D.cards) {
  const inDeg = asInput.get(c.id).size;
  const outDeg = asResult.get(c.id);
  if (inDeg === 0 && outDeg === 0) orphans.push(c);
  else if (inDeg === 0) deadEnds.push(c);
  else if (inDeg < TARGET_BRANCH) lowBranch.push({ c, inDeg });
}

const branchSum = D.cards.reduce((s, c) => s + asInput.get(c.id).size, 0);
const avgBranch = branchSum / D.cards.length;

// ── 4. 파워 대비 슬롯 비용 ────────────────────────────────────
const slotOutliers = [];
for (const c of D.cards) {
  const p = cardPower(c, D.effectById);
  if (p >= 4.0 && c.slot_cost < 2) slotOutliers.push({ c, p });
  if (p <= 1.5 && c.slot_cost > 1) slotOutliers.push({ c, p });
}

// ── 출력 ──────────────────────────────────────────────────────
const line = '─'.repeat(60);
console.log(`\n${line}\nUNFOUND 데이터 검증\n${line}`);
console.log(`카드 ${D.cards.length}장 / 레시피 ${D.recipes.length}개 / 효과 ${D.effects.length}종 / 적 ${D.enemies.length}종`);
console.log(`평균 분기도 ${avgBranch.toFixed(2)} (목표 ${TARGET_BRANCH}.00 이상)`);

if (errors.length) {
  console.log(`\n[오류 ${errors.length}건] — 고치기 전에는 빌드하지 않습니다.`);
  errors.forEach((e) => console.log(`  x ${e}`));
} else {
  console.log('\n[오류] 없음');
}

if (orphans.length) {
  console.log(`\n[고립 카드 ${orphans.length}장] 어떤 레시피에도 등장하지 않습니다. 있으나 마나 한 카드입니다.`);
  orphans.forEach((c) => console.log(`  - ${c.name_ko} (${c.id})`));
}
if (deadEnds.length) {
  const bad = deadEnds.filter((c) => c.tier !== 'C');
  console.log(`\n[막다른 카드 ${deadEnds.length}장] 조합 결과로만 나오고 다시 재료가 되지 않습니다.`);
  deadEnds.forEach((c) => console.log(`  - ${c.name_ko} (${c.id}) tier ${c.tier}${c.tier === 'C' ? ' — 최종 발견물이라 정상' : ''}`));
  if (bad.length) console.log(`  → 이 중 ${bad.length}장은 tier A/B라 연쇄가 여기서 끊깁니다. 재료로 쓰이는 레시피가 필요합니다.`);
}
if (lowBranch.length) {
  console.log(`\n[분기 부족 ${lowBranch.length}장] 조합 상대가 ${TARGET_BRANCH}개 미만이라 선택의 여지가 없습니다.`);
  lowBranch.sort((a, b) => a.inDeg - b.inDeg).forEach(({ c, inDeg }) => console.log(`  - ${c.name_ko} (${c.id}) 상대 ${inDeg}개`));
}
if (slotOutliers.length) {
  console.log(`\n[슬롯 비용 재검토 ${slotOutliers.length}장]`);
  slotOutliers.forEach(({ c, p }) => console.log(`  - ${c.name_ko} (${c.id}) 파워 ${p.toFixed(1)} / ${c.slot_cost}칸`));
}
if (warnings.length) {
  console.log(`\n[경고 ${warnings.length}건]`);
  warnings.forEach((w) => console.log(`  ! ${w}`));
}

console.log(`\n${line}\n`);
process.exit(errors.length ? 1 : 0);
