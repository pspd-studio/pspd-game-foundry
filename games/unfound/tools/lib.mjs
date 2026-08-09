/**
 * 노드용 데이터 로더. 색인을 만드는 로직은 여기 없다 —
 * src/core/data.ts의 buildData가 유일한 구현이고, 브라우저도 그것을 쓴다.
 * (노드 22.18+/24는 .ts를 그대로 import한다. 타입만 벗겨내므로 빌드 단계가 필요 없다.)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildData, pairKey, cardPower, fmtPct, makeRng } from '../src/core/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadData() {
  const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
  const data = buildData({
    cards: read('cards.json'),
    recipes: read('recipes.json'),
    effects: read('effects.json'),
    enemies: read('enemies.json'),
    regions: read('regions.json'),
    rules: read('rules.json'),
  });
  return { ...data, ROOT };
}

export { pairKey, cardPower, fmtPct, makeRng };

export function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}
