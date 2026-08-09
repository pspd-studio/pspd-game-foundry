/** 코어 공개 입구. UI와 tools/*.mjs는 여기만 import한다. */
export * from './types.ts';
export { pairKey, cardPower, buildData, readSwitches, fmtPct } from './data.ts';
export type { Switches } from './data.ts';
export { makeRng, rngNext, rngPick, seedToState } from './rng.ts';
export {
  createGame, attemptCombine, discardAt, endTurn,
  usedSlots, slotCap, recipeFor, aliveEnemies, region, supplyPool,
} from './engine.ts';
export { findBestCombo, hasPartner, deadCardIndices, aiCombinePhase, aiDiscardPhase } from './ai.ts';
export { playRunAuto } from './autoplay.ts';
