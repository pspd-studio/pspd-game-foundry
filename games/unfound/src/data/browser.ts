/**
 * 브라우저용 데이터 로더.
 * data/*.json을 **복사하지 않고** 상위 폴더의 원본을 그대로 import한다 (Vite root가 games/unfound).
 * 진실 원천은 한 곳이어야 하므로 사본을 만들지 않는다.
 */
import cards from '../../data/cards.json';
import recipes from '../../data/recipes.json';
import effects from '../../data/effects.json';
import enemies from '../../data/enemies.json';
import regions from '../../data/regions.json';
import rules from '../../data/rules.json';
// core/index.ts가 아니라 data.ts를 직접 부른다 — index.ts는 v1 전투 엔진(부검 후 동결)까지 재수출해서
// 그쪽을 거치면 슬라이스가 쓰지도 않는 코드가 번들에 실린다.
import { buildData } from '../core/data.ts';
import type { GameData, RawData } from '../core/types.ts';

export const DATA: GameData = buildData(
  { cards, recipes, effects, enemies, regions, rules } as unknown as RawData,
);
