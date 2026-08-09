/**
 * 코어 타입. 콘텐츠는 전부 data/*.json에서 온다 — 여기에는 어떤 카드·레시피·수치도 없다.
 * 이 파일에 카드 id나 숫자 상수를 적으면 CLAUDE.md의 절대 규칙 위반이다.
 */

export type EffectCategory = 'attack' | 'control' | 'card' | 'survive';

export interface Effect {
  id: string;
  name_ko: string;
  category: EffectCategory | string;
  target: string;
  params: Record<string, number | undefined>;
  weight: number;
}

export interface Card {
  id: string;
  name_ko: string;
  tier: string;
  tags: string[];
  slot_cost: number;
  effects?: string[];
}

export interface Recipe {
  id: string;
  inputs: [string, string];
  result: string;
  conditions: unknown[];
  discovery_text?: string;
}

export interface Enemy {
  id: string;
  name_ko: string;
  hp: number;
  speed: number;
  behavior: string;
  start_row: number;
  reward_tags: string[];
  note?: string;
  is_boss?: boolean;
}

export interface Region {
  id: string;
  name_ko: string;
  difficulty: number;
  card_pool: string[];
  enemy_pool: string[];
  theme_tags: string[];
}

/**
 * rules.json 전체. 코어는 여기 있는 값만 읽고, 없는 값은 스위치 기본값(switches.ts)에서 채운다.
 * 인덱스 시그니처를 열어두는 이유: 대표가 rules.json에 새 손잡이를 추가해도 코어가 컴파일된다.
 */
export interface Rules {
  field_slots: number;
  starting_hand: number;
  supply_candidates_per_turn: number;
  combine_limit_per_turn: number | null;
  player_hp: number;
  enemy_reach_damage: number;
  enemy_reach_damage_heavy: number;
  enemy_on_reach?: string;
  failed_combine_cost?: string;
  discard_per_turn?: number;
  discard_decay?: string;
  [key: string]: unknown;
}

export interface RawData {
  cards: { cards: Card[] };
  recipes: { recipes: Recipe[] };
  effects: { effects: Effect[] };
  enemies: { enemies: Enemy[] };
  regions: { regions: Region[]; map_shape?: unknown };
  rules: Rules;
}

/** 색인까지 붙은 런타임 데이터. tools/lib.mjs와 브라우저가 같은 것을 만든다. */
export interface GameData {
  effects: Effect[];
  cards: Card[];
  recipes: Recipe[];
  enemies: Enemy[];
  regions: Region[];
  rules: Rules;
  effectById: Map<string, Effect>;
  cardById: Map<string, Card>;
  enemyById: Map<string, Enemy>;
  recipeByKey: Map<string, Recipe>;
}

export interface EnemyInstance {
  id: string;
  name_ko: string;
  hp: number;
  maxHp: number;
  speed: number;
  behavior: string;
  start_row: number;
  is_boss?: boolean;
  row: number;
  stunned: number;
  uid: number;
}

export type RunResult = 'win' | 'loss';

export interface GameState {
  /** 순수 함수를 유지하기 위해 난수 상태도 상태 안에 둔다. 같은 state → 같은 다음 state. */
  rngState: number;
  seed: number;
  regionId: string;
  turn: number;
  hp: number;
  maxHp: number;
  pendingDraw: number;
  bonusSlots: number;
  field: Card[];
  enemies: EnemyInstance[];
  /** 이번 턴에 아직 버릴 수 있는 장수. */
  discardLeft: number;
  discovered: string[];
  /** 이번 판에서 이미 발동해 본 레시피 id (도감용). */
  knownRecipes: string[];
  /** 이번 턴 조합 횟수 (combine_limit_per_turn 스위치용). */
  combosThisTurn: number;
  /** failed_combine_cost='turn'일 때, 실패한 조합이 이번 턴의 조합을 잠근다. */
  turnLocked: boolean;
  /** discard_decay='remove_from_pool'일 때, 이번 판에서 공급이 끊긴 카드 id. */
  decayed: string[];
  over: RunResult | null;
  nextUid: number;
}

/* ── 로그 이벤트 ────────────────────────────────────────────────
   3단계(Supabase)에서 이 배열만 그대로 전송하면 된다. 코어는 네트워크를 모른다. */

export type GameEvent =
  | { t: 'run_start'; seed: number; region: string; hp: number; rules_switches: Record<string, unknown> }
  | { t: 'draw'; turn: number; card: string; accepted: boolean; reason?: 'no_slot' }
  | { t: 'combine_ok'; turn: number; recipe: string; inputs: [string, string]; result: string; discovery_text: string; first_time: boolean; chain_index: number }
  | { t: 'combine_fail'; turn: number; inputs: [string, string]; reason: 'no_recipe' | 'no_slot'; cost: string }
  | { t: 'discard'; turn: number; card: string; by: 'player' | 'ai_dead_card' | 'enemy_steal'; decayed: boolean }
  | { t: 'enemy_reach'; turn: number; enemy: string; damage: number; on_reach: string }
  | { t: 'turn_end'; turn: number; used_slots: number; occupancy: number; field: string[]; hp: number }
  | { t: 'run_end'; result: RunResult; turn: number; hp_left: number; discovered: string[]; reached_by: string[] };

export type EventSink = (e: GameEvent) => void;

/** 조합 시도 결과. UI와 시뮬레이터가 같은 것을 받는다. */
export type CombineOutcome =
  | { ok: true; recipe: Recipe; result: Card; discovery_text: string; first_time: boolean }
  | { ok: false; reason: 'no_recipe' | 'no_slot' | 'bad_index' | 'game_over' | 'limit' };
