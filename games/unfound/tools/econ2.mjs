/**
 * UNFOUND v2.1 경제 코어 — 얇은 재수출 껍데기.
 *
 * 2026-08-10 G3 1단계에서 실제 구현은 `src/core/econ.ts`(규칙)와 `src/core/econAuto.ts`(AI 정책)로
 * 승격했다. 사람이 하는 슬라이스와 시뮬레이터가 **같은 규칙 코드**를 쓰게 하려는 것이다.
 * 이 파일은 기존 도구(tools/simulate2.mjs)의 import 경로를 깨지 않기 위해 남겨 둔다.
 */
export {
  readEconRules, buildAffinity, affinityScore, reachableRecipes,
  slotUsed, pairsOf, priceOf, rollContracts, rollStartingField, rollSupply, settleRun,
  newCareer, endRunCareer, reviewRequirement, runsUntilReview, GRADE_NAMES, pairKey,
} from '../src/core/econ.ts';
export { playEconRun } from '../src/core/econAuto.ts';
