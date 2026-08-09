import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadData() {
  const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
  const effects = read('effects.json').effects;
  const cards = read('cards.json').cards;
  const recipes = read('recipes.json').recipes;
  const enemies = read('enemies.json').enemies;
  const regions = read('regions.json').regions;
  const rules = read('rules.json');

  const effectById = new Map(effects.map((e) => [e.id, e]));
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const enemyById = new Map(enemies.map((e) => [e.id, e]));

  // 순서 무관 조합 키
  const recipeByKey = new Map();
  for (const r of recipes) recipeByKey.set(pairKey(r.inputs[0], r.inputs[1]), r);

  return { effects, cards, recipes, enemies, regions, rules, effectById, cardById, enemyById, recipeByKey, ROOT };
}

export function pairKey(a, b) {
  return [a, b].sort().join('+');
}

export function cardPower(card, effectById) {
  return (card.effects || []).reduce((s, id) => s + (effectById.get(id)?.weight ?? 0), 0);
}

export function fmtPct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

// 재현 가능한 난수 (시드 고정 → 같은 결과)
export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}
