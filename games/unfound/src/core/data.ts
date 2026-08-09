import type { GameData, RawData, Card, Effect, Rules } from './types.ts';

/** 순서 무관 조합 키. lib.mjs의 pairKey와 같다. */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('+');
}

export function cardPower(card: Card, effectById: Map<string, Effect>): number {
  return (card.effects || []).reduce((s, id) => s + (effectById.get(id)?.weight ?? 0), 0);
}

/**
 * JSON 원본 → 색인이 붙은 런타임 데이터.
 * 노드(tools/lib.mjs)와 브라우저(src/data/browser.ts)가 **이 함수 하나**를 공유한다.
 * 그래서 데이터 해석이 두 군데로 갈라지지 않는다.
 */
export function buildData(raw: RawData): GameData {
  const effects = raw.effects.effects;
  const cards = raw.cards.cards;
  const recipes = raw.recipes.recipes;
  const enemies = raw.enemies.enemies;
  const regions = raw.regions.regions;
  const rules = raw.rules;

  const effectById = new Map(effects.map((e) => [e.id, e]));
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const enemyById = new Map(enemies.map((e) => [e.id, e]));

  const recipeByKey = new Map<string, (typeof recipes)[number]>();
  for (const r of recipes) recipeByKey.set(pairKey(r.inputs[0], r.inputs[1]), r);

  return { effects, cards, recipes, enemies, regions, rules, effectById, cardById, enemyById, recipeByKey };
}

/* ── SSOT 미확정 항목 스위치 ────────────────────────────────────
   값은 코드에 박지 않는다. rules.json에서 읽고, 키가 없을 때만 아래 기본값을 쓴다.
   기본값도 "현행 유지"에 맞춰 두었고, 대표가 rules.json에 키를 넣는 순간 그 값이 이긴다. */

export interface Switches {
  /** 적이 플레이어 영역에 도달한 뒤: 남아서 매 턴 때린다(persist) / 사라진다(despawn) */
  enemy_on_reach: 'persist' | 'despawn';
  /** 레시피 없는 쌍을 눌렀을 때의 비용: none / turn(턴 즉시 종료) / hp(체력 1) */
  failed_combine_cost: 'none' | 'turn' | 'hp';
  /** 버린 카드 열화: none(미적용) / remove_from_pool(그 판에서 다시 공급되지 않음) */
  discard_decay: 'none' | 'remove_from_pool';
  /** 적 하강 타이머 유지 여부 */
  enemy_descend: boolean;
  discard_per_turn: number;
  combine_limit_per_turn: number | null;
  max_turns: number;
}

export function readSwitches(rules: Rules): Switches {
  const s = (k: string, fallback: string) => (typeof rules[k] === 'string' ? (rules[k] as string) : fallback);
  const n = (k: string, fallback: number) => (typeof rules[k] === 'number' ? (rules[k] as number) : fallback);
  return {
    enemy_on_reach: s('enemy_on_reach', 'persist') as Switches['enemy_on_reach'],
    failed_combine_cost: s('failed_combine_cost', 'none') as Switches['failed_combine_cost'],
    discard_decay: s('discard_decay', 'none') as Switches['discard_decay'],
    enemy_descend: rules.enemy_descend === undefined ? true : rules.enemy_descend === true,
    discard_per_turn: n('discard_per_turn', 0),
    combine_limit_per_turn:
      typeof rules.combine_limit_per_turn === 'number' ? rules.combine_limit_per_turn : null,
    max_turns: n('max_turns', 30),
  };
}

export function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
