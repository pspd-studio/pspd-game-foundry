/**
 * UNFOUND 경제 코어 — 얇은 재수출 껍데기.
 *
 * 실제 구현은 `src/core/econ.ts`(규칙)와 `src/core/econAuto.ts`(AI 정책)에 산다.
 * 사람이 하는 슬라이스와 시뮬레이터가 **같은 규칙 코드**를 쓰게 하려는 것이다.
 * v3.0부터 AI는 EconSession(사람 세션 코어)을 그대로 운전한다 — 규칙 이중 구현이 없다.
 * 이 파일은 기존 도구(tools/simulate2.mjs)의 import 경로를 깨지 않기 위해 남겨 둔다.
 */
export {
  readEconRules, buildAffinity, affinityScore, reachableRecipes,
  slotUsed, pairsOf, priceOf, rollContracts, rollStartingField, rollSupply, settleRun,
  newCareer, endRunCareer, reviewRequirement, runsUntilReview, unlockedRegionCount,
  GRADE_NAMES, pairKey, spreadOf, spreadUsed, topOf, allCards,
} from '../src/core/econ.ts';
export { playEconRun } from '../src/core/econAuto.ts';
export { EconSession } from '../src/core/econSession.ts';
