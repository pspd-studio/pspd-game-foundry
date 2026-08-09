/**
 * 시드 기반 난수. tools/lib.mjs의 makeRng와 **비트 단위로 같은 수열**을 낸다.
 * 다른 점은 상태를 클로저에 숨기지 않고 값으로 주고받는다는 것뿐이다 —
 * 그래서 코어 전체가 "같은 입력 → 같은 출력"인 순수 함수로 유지된다.
 */

export function seedToState(seed: number): number {
  return (seed >>> 0) || 1;
}

/** xorshift32. lib.mjs의 makeRng 본문과 동일한 연산 순서를 지킨다. */
export function rngNext(state: number): { value: number; state: number } {
  let s = state;
  s ^= s << 13; s >>>= 0;
  s ^= s >> 17;
  s ^= s << 5; s >>>= 0;
  return { value: s / 4294967296, state: s };
}

/** 배열에서 하나 고른다 (lib.mjs의 pick과 동일). */
export function rngPick<T>(arr: readonly T[], state: number): { value: T; state: number } {
  const r = rngNext(state);
  return { value: arr[Math.floor(r.value * arr.length)], state: r.state };
}

/** 클로저형 난수 — 기존 도구 호환용. 새 코드는 rngNext를 쓴다. */
export function makeRng(seed: number): () => number {
  let s = seedToState(seed);
  return () => {
    const r = rngNext(s);
    s = r.state;
    return r.value;
  };
}
