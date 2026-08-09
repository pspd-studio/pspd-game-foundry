/**
 * 전투 코어. UI를 전혀 모르고, DOM·네트워크·console을 건드리지 않는다.
 *
 * 규칙 세 개:
 *   1. 카드·레시피·적·수치를 여기에 적지 않는다. 전부 인자로 받은 GameData에서 읽는다.
 *   2. 같은 (state, 인자) → 같은 결과. 난수는 state.rngState로 들고 다닌다.
 *   3. 바깥에 알릴 것은 GameEvent로만 흘린다 (emit). 3단계 Supabase 전송은 이 seam에 붙인다.
 *
 * tools/simulate.mjs와 브라우저 UI가 **이 파일 하나**를 공유한다.
 */
import type {
  Card, GameData, GameState, EnemyInstance, GameEvent, EventSink, CombineOutcome, Recipe,
} from './types.ts';
import { pairKey, readSwitches } from './data.ts';
import { rngNext, rngPick, seedToState } from './rng.ts';

const noop: EventSink = () => {};

/* ── 조회 헬퍼 (UI도 그대로 쓴다) ───────────────────────────── */

export function usedSlots(field: readonly Card[]): number {
  return field.reduce((s, c) => s + c.slot_cost, 0);
}

export function slotCap(data: GameData, st: GameState): number {
  return (data.rules.field_slots as number) + st.bonusSlots;
}

export function recipeFor(data: GameData, a: string, b: string): Recipe | undefined {
  return data.recipeByKey.get(pairKey(a, b));
}

export function aliveEnemies(st: GameState): EnemyInstance[] {
  return st.enemies.filter((e) => e.hp > 0);
}

export function region(data: GameData, st: GameState) {
  return data.regions.find((r) => r.id === st.regionId)!;
}

export function supplyPool(data: GameData, st: GameState): string[] {
  const pool = region(data, st).card_pool;
  if (!st.decayed.length) return pool;
  const left = pool.filter((id) => !st.decayed.includes(id));
  return left.length ? left : pool;
}

/* ── 상태 복제 (순수성 유지) ────────────────────────────────── */

function clone(st: GameState): GameState {
  return {
    ...st,
    field: st.field.slice(),
    enemies: st.enemies.map((e) => ({ ...e })),
    discovered: st.discovered.slice(),
    knownRecipes: st.knownRecipes.slice(),
    decayed: st.decayed.slice(),
  };
}

/* ── 내부 변이 헬퍼 (clone된 state에만 쓴다) ────────────────── */

function drawInto(data: GameData, st: GameState, n: number, emit: EventSink): void {
  const pool = supplyPool(data, st);
  for (let k = 0; k < n; k++) {
    const cap = slotCap(data, st);
    const r = rngPick(pool, st.rngState);
    st.rngState = r.state;
    const c = data.cardById.get(r.value)!;
    if (usedSlots(st.field) + c.slot_cost > cap) {
      emit({ t: 'draw', turn: st.turn, card: c.id, accepted: false, reason: 'no_slot' });
      continue;
    }
    st.field.push(c);
    emit({ t: 'draw', turn: st.turn, card: c.id, accepted: true });
  }
}

function applyEffects(data: GameData, st: GameState, card: Card): void {
  for (const id of card.effects || []) {
    const e = data.effectById.get(id);
    if (!e) continue;
    const alive = () => st.enemies.filter((x) => x.hp > 0);
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
        if (id === 'card_draw_2') st.pendingDraw += 2;
        if (id === 'slot_free_1') st.bonusSlots += 1;
        if (id === 'card_add_random') st.pendingDraw += 1;
        break;
      }
      case 'survive': {
        if (e.params.amount) st.hp = Math.min(st.maxHp, st.hp + e.params.amount);
        break;
      }
    }
  }
}

/* ── 공개 API ──────────────────────────────────────────────── */

export function createGame(data: GameData, seed: number, emit: EventSink = noop, regionId?: string): GameState {
  const sw = readSwitches(data.rules);
  let rngState = seedToState(seed);

  let chosen;
  if (regionId) {
    chosen = data.regions.find((r) => r.id === regionId) ?? data.regions[0];
  } else {
    const r = rngPick(data.regions, rngState);
    rngState = r.state;
    chosen = r.value;
  }

  const st: GameState = {
    rngState,
    seed,
    regionId: chosen.id,
    turn: 1,
    hp: data.rules.player_hp,
    maxHp: data.rules.player_hp,
    pendingDraw: 0,
    bonusSlots: 0,
    field: [],
    enemies: chosen.enemy_pool.map((id, k) => {
      const e = data.enemyById.get(id)!;
      return { ...e, hp: e.hp, maxHp: e.hp, row: e.start_row + k, stunned: 0, uid: k + 1 };
    }),
    discardLeft: sw.discard_per_turn,
    discovered: [],
    knownRecipes: [],
    combosThisTurn: 0,
    turnLocked: false,
    decayed: [],
    over: null,
    nextUid: chosen.enemy_pool.length + 1,
  };

  emit({
    t: 'run_start', seed, region: chosen.id, hp: st.hp,
    rules_switches: {
      enemy_on_reach: sw.enemy_on_reach,
      failed_combine_cost: sw.failed_combine_cost,
      discard_decay: sw.discard_decay,
      enemy_descend: sw.enemy_descend,
      discard_per_turn: sw.discard_per_turn,
    },
  });

  drawInto(data, st, data.rules.starting_hand, emit);
  return st;
}

/**
 * 필드의 i번째와 j번째를 조합한다.
 * 실패(레시피 없음 / 칸 부족)도 정상 반환값이다 — 실패 시도가 다음 콘텐츠의 근거이므로
 * 반드시 이벤트로 남긴다.
 */
export function attemptCombine(
  data: GameData, prev: GameState, i: number, j: number, emit: EventSink = noop,
): { state: GameState; outcome: CombineOutcome } {
  const sw = readSwitches(data.rules);
  if (prev.over) return { state: prev, outcome: { ok: false, reason: 'game_over' } };
  if (i === j || i < 0 || j < 0 || i >= prev.field.length || j >= prev.field.length) {
    return { state: prev, outcome: { ok: false, reason: 'bad_index' } };
  }
  if (prev.turnLocked) return { state: prev, outcome: { ok: false, reason: 'limit' } };
  if (sw.combine_limit_per_turn != null && prev.combosThisTurn >= sw.combine_limit_per_turn) {
    return { state: prev, outcome: { ok: false, reason: 'limit' } };
  }

  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  const a = prev.field[lo];
  const b = prev.field[hi];
  const r = recipeFor(data, a.id, b.id);

  if (!r) {
    const st = clone(prev);
    emit({ t: 'combine_fail', turn: st.turn, inputs: [a.id, b.id], reason: 'no_recipe', cost: sw.failed_combine_cost });
    if (sw.failed_combine_cost === 'hp') {
      st.hp -= 1;
      if (st.hp <= 0) {
        st.over = 'loss';
        emit({ t: 'run_end', result: 'loss', turn: st.turn, hp_left: st.hp, discovered: st.discovered.slice(), reached_by: [] });
      }
    } else if (sw.failed_combine_cost === 'turn') {
      st.turnLocked = true;
    }
    return { state: st, outcome: { ok: false, reason: 'no_recipe' } };
  }

  const result = data.cardById.get(r.result)!;
  const cap = slotCap(data, prev);
  const after = usedSlots(prev.field) - a.slot_cost - b.slot_cost + result.slot_cost;
  if (after > cap) {
    emit({ t: 'combine_fail', turn: prev.turn, inputs: [a.id, b.id], reason: 'no_slot', cost: 'none' });
    return { state: prev, outcome: { ok: false, reason: 'no_slot' } };
  }

  const st = clone(prev);
  st.field.splice(hi, 1);
  st.field.splice(lo, 1);
  st.field.push(result);
  applyEffects(data, st, result);

  const firstTime = !st.knownRecipes.includes(r.id);
  if (firstTime) st.knownRecipes.push(r.id);
  if (!st.discovered.includes(result.id)) st.discovered.push(result.id);
  st.combosThisTurn += 1;

  emit({
    t: 'combine_ok', turn: st.turn, recipe: r.id, inputs: [a.id, b.id], result: result.id,
    discovery_text: r.discovery_text ?? '', first_time: firstTime, chain_index: st.combosThisTurn,
  });

  return {
    state: st,
    outcome: { ok: true, recipe: r, result, discovery_text: r.discovery_text ?? '', first_time: firstTime },
  };
}

/** 턴당 버리기. rules.json의 discard_per_turn이 한도다. */
export function discardAt(
  data: GameData, prev: GameState, index: number, emit: EventSink = noop, by: 'player' | 'ai_dead_card' = 'player',
): { state: GameState; ok: boolean } {
  const sw = readSwitches(data.rules);
  if (prev.over) return { state: prev, ok: false };
  if (index < 0 || index >= prev.field.length) return { state: prev, ok: false };
  if (prev.discardLeft <= 0) return { state: prev, ok: false };

  const st = clone(prev);
  const [card] = st.field.splice(index, 1);
  st.discardLeft -= 1;
  const decayed = sw.discard_decay === 'remove_from_pool';
  if (decayed && !st.decayed.includes(card.id)) st.decayed.push(card.id);
  emit({ t: 'discard', turn: st.turn, card: card.id, by, decayed });
  return { state: st, ok: true };
}

/**
 * 턴 종료: 점유율 기록 → 승리 판정 → 적 행동 → 패배 판정 → 공급.
 * 이 순서는 G2 기준선을 만든 순서 그대로다. 바꾸면 시뮬 지표가 전부 어긋난다.
 */
export function endTurn(data: GameData, prev: GameState, emit: EventSink = noop): GameState {
  if (prev.over) return prev;
  const sw = readSwitches(data.rules);
  const st = clone(prev);

  const used = usedSlots(st.field);
  emit({
    t: 'turn_end', turn: st.turn, used_slots: used,
    occupancy: used / (data.rules.field_slots as number),
    field: st.field.map((c) => c.id), hp: st.hp,
  });

  if (st.enemies.every((e) => e.hp <= 0)) {
    st.over = 'win';
    emit({ t: 'run_end', result: 'win', turn: st.turn, hp_left: st.hp, discovered: st.discovered.slice(), reached_by: [] });
    return st;
  }

  const reachedBy: string[] = [];
  for (const e of st.enemies) {
    if (e.hp <= 0) continue;
    if (e.stunned > 0) { e.stunned--; continue; }
    if (sw.enemy_descend && e.row > 0) {
      e.row -= e.behavior === 'slow_heavy' && st.turn % 2 === 0 ? 0 : 1;
    }
    if (e.row <= 0) {
      const dmg = e.behavior === 'slow_heavy'
        ? (data.rules.enemy_reach_damage_heavy as number)
        : (data.rules.enemy_reach_damage as number);
      st.hp -= dmg;
      reachedBy.push(e.id);
      emit({ t: 'enemy_reach', turn: st.turn, enemy: e.id, damage: dmg, on_reach: sw.enemy_on_reach });
      if (sw.enemy_on_reach === 'despawn') e.hp = 0;
    }
    if (e.behavior === 'steal_card' && st.field.length) {
      const r = rngNext(st.rngState);
      st.rngState = r.state;
      const idx = Math.floor(r.value * st.field.length);
      const [stolen] = st.field.splice(idx, 1);
      emit({ t: 'discard', turn: st.turn, card: stolen.id, by: 'enemy_steal', decayed: false });
    }
  }

  if (st.hp <= 0) {
    st.over = 'loss';
    emit({ t: 'run_end', result: 'loss', turn: st.turn, hp_left: st.hp, discovered: st.discovered.slice(), reached_by: reachedBy });
    return st;
  }

  st.bonusSlots = 0;
  drawInto(data, st, (data.rules.supply_candidates_per_turn as number) + st.pendingDraw, emit);
  st.pendingDraw = 0;

  if (st.turn >= sw.max_turns) {
    st.over = 'loss';
    emit({ t: 'run_end', result: 'loss', turn: st.turn, hp_left: st.hp, discovered: st.discovered.slice(), reached_by: reachedBy });
    return st;
  }

  st.turn += 1;
  st.discardLeft = sw.discard_per_turn;
  st.combosThisTurn = 0;
  st.turnLocked = false;
  return st;
}

export type { GameEvent, GameState, CombineOutcome };
