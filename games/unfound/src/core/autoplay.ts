/**
 * 자동 한 판. 턴 구조(조합 → 버리기 → 턴 종료)를 여기 한 곳에만 적는다.
 * 시뮬레이터와 스모크 테스트가 같은 함수를 쓴다.
 */
import type { GameData, GameState, EventSink } from './types.ts';
import { readSwitches } from './data.ts';
import { createGame, endTurn } from './engine.ts';
import { aiCombinePhase, aiDiscardPhase } from './ai.ts';

export function playRunAuto(data: GameData, seed: number, emit: EventSink, regionId?: string): GameState {
  const maxTurns = readSwitches(data.rules).max_turns;
  let st = createGame(data, seed, emit, regionId);
  let guard = 0;
  while (!st.over && guard++ <= maxTurns + 1) {
    st = aiCombinePhase(data, st, emit);
    st = aiDiscardPhase(data, st, emit);
    st = endTurn(data, st, emit);
  }
  return st;
}
