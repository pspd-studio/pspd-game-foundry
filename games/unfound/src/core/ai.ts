/**
 * 탐욕적 자동 플레이어. G2 시뮬레이터가 쓰던 판단 로직을 그대로 옮긴 것이다.
 * UI는 이걸 쓰지 않는다 (사람이 판단한다). 스모크 테스트와 시뮬레이터만 쓴다.
 *
 * 주의: 사람보다 약하다. 절대값이 아니라 변화 방향을 보는 도구다.
 */
import type { Card, GameData, GameState, EventSink } from './types.ts';
import { cardPower, readSwitches } from './data.ts';
import { attemptCombine, discardAt, recipeFor } from './engine.ts';

export interface ComboPick {
  i: number;
  j: number;
  recipeId: string;
  result: Card;
  gain: number;
}

export function findBestCombo(data: GameData, field: readonly Card[]): ComboPick | null {
  let best: ComboPick | null = null;
  for (let i = 0; i < field.length; i++) {
    for (let j = i + 1; j < field.length; j++) {
      const r = recipeFor(data, field[i].id, field[j].id);
      if (!r) continue;
      const result = data.cardById.get(r.result)!;
      const gain = cardPower(result, data.effectById)
        - cardPower(field[i], data.effectById) * 0.4
        - cardPower(field[j], data.effectById) * 0.4;
      if (!best || gain > best.gain) best = { i, j, recipeId: r.id, result, gain };
    }
  }
  return best;
}

/** i번째 카드에 조합 상대가 필드에 있는가. UI의 힌트 표시에도 쓴다. */
export function hasPartner(data: GameData, field: readonly Card[], i: number): boolean {
  for (let j = 0; j < field.length; j++) {
    if (i === j) continue;
    if (recipeFor(data, field[i].id, field[j].id)) return true;
  }
  return false;
}

/** 조합 상대가 하나도 없는 카드의 위치. UI가 "버릴 후보"로 표시한다. */
export function deadCardIndices(data: GameData, field: readonly Card[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < field.length; i++) if (!hasPartner(data, field, i)) out.push(i);
  return out;
}

/** 이득이 나는 조합을 더 이상 없을 때까지 연쇄로 돌린다. */
export function aiCombinePhase(data: GameData, prev: GameState, emit: EventSink): GameState {
  let st = prev;
  let guard = 0;
  while (guard++ < 25) {
    const best = findBestCombo(data, st.field);
    if (!best || best.gain <= 0) break;
    const res = attemptCombine(data, st, best.i, best.j, emit);
    if (!res.outcome.ok) break;
    st = res.state;
  }
  return st;
}

/**
 * 버리기: 조합 상대가 하나도 없는 카드를 한도까지 버린다.
 * 사람이라면 "이건 쓸 데가 없다"고 판단해 버릴 카드만 버리는 보수적 모델이다.
 */
export function aiDiscardPhase(data: GameData, prev: GameState, emit: EventSink): GameState {
  const n = readSwitches(data.rules).discard_per_turn;
  let st = prev;
  for (let d = 0; d < n; d++) {
    let idx = -1;
    for (let i = 0; i < st.field.length; i++) if (!hasPartner(data, st.field, i)) { idx = i; break; }
    if (idx < 0) break;
    const res = discardAt(data, st, idx, emit, 'ai_dead_card');
    if (!res.ok) break;
    st = res.state;
  }
  return st;
}
