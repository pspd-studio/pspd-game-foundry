/**
 * v2.2 발견 연출 (심야 개정 B).
 *
 * 원칙 (08 점검 문서 — juice는 채널 중첩, 다 빼면 스프레드시트):
 *   - 순간당 ≤1.5초. 탭 = 스킵. prefers-reduced-motion이면 전부 생략.
 *   - 아트 없음 — 문자·도형·CSS·웹오디오 합성음만.
 *   - 규칙 판단은 한 줄도 없다. 코어가 낸 결과를 "보여주는 시간"만 만든다.
 *
 * 사운드 3개는 전부 웹오디오 합성: S1 부글 / S2 발견 상승음 / S3 동전.
 */

const REDUCED = typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (REDUCED) return null;
  try {
    ctx = ctx ?? new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch { return null; }
}

function tone(freq: number, at: number, dur: number, type: OscillatorType, gain: number, slideTo?: number): void {
  const a = audio();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime + at);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, a.currentTime + at + dur);
  g.gain.setValueAtTime(0.0001, a.currentTime + at);
  g.gain.exponentialRampToValueAtTime(gain, a.currentTime + at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + at + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + at);
  o.stop(a.currentTime + at + dur + 0.05);
}

/** S1 — 부글: 낮은 블립 두세 방울. */
export function sndBubble(): void {
  tone(140 + Math.random() * 40, 0, 0.09, 'sine', 0.12, 90);
  tone(180 + Math.random() * 60, 0.10, 0.08, 'sine', 0.10, 120);
  if (Math.random() < 0.6) tone(160 + Math.random() * 50, 0.20, 0.07, 'sine', 0.08, 110);
}

/** S2 — 발견 상승음: 미끄러져 올라가는 스윕 + 반짝. */
export function sndDiscover(gold = false): void {
  tone(320, 0, 0.28, 'sine', 0.14, 900);
  tone(gold ? 1320 : 1050, 0.22, 0.16, 'triangle', 0.10);
  if (gold) tone(1760, 0.32, 0.14, 'triangle', 0.08);
}

/** S3 — 동전: 높은 두 음. */
export function sndCoin(): void {
  tone(988, 0, 0.07, 'square', 0.05);
  tone(1319, 0.07, 0.12, 'square', 0.05);
}

/* ── 연출 본체 ─────────────────────────────────────────────── */

const fxRoot = (): HTMLElement | null => document.getElementById('fx');

/** 진행 중 연출을 즉시 끝내는 스킵 훅 (탭 = 스킵). */
let skipNow: (() => void) | null = null;

function hold(ms: number): Promise<void> {
  if (REDUCED) return Promise.resolve();
  return new Promise((res) => {
    const timer = setTimeout(finish, ms);
    function finish(): void { clearTimeout(timer); skipNow = null; res(); }
    skipNow = finish;
  });
}

export function skipFx(): boolean {
  if (!skipNow) return false;
  const el = fxRoot();
  if (el) el.innerHTML = '';
  skipNow();
  return true;
}

/** ① 조합 서스펜스 — 카드 두 장이 중앙으로, `?` 점멸 300~500ms + S1. */
export async function fxSuspense(nameA: string, nameB: string): Promise<void> {
  const el = fxRoot();
  if (REDUCED || !el) return;
  sndBubble();
  el.innerHTML = `
    <div class="fx-center" role="presentation">
      <span class="fx-card fx-left">${nameA}</span>
      <span class="fx-q">?</span>
      <span class="fx-card fx-right">${nameB}</span>
    </div>`;
  await hold(300 + Math.floor(Math.random() * 200));
  el.innerHTML = '';
}

/**
 * ② 성공 — 결과명 글자 스태거 + 문자 파티클(✦·˚) + 장부로 `+1` 비행 + 도장.
 * gold=신규 계열 최초. 전체 ≤1.2초.
 */
export async function fxSuccess(resultName: string, opts: { gold: boolean; firstTime: boolean }): Promise<void> {
  const el = fxRoot();
  if (REDUCED || !el) return;
  sndDiscover(opts.gold);
  document.querySelector('.field-panel')?.classList.add('fx-pulse');
  const chars = [...resultName].map((ch, i) =>
    `<span class="fx-ch" style="animation-delay:${i * 55}ms">${ch}</span>`).join('');
  const parts = Array.from({ length: 10 }, (_, i) => {
    const g = ['✦', '·', '˚'][i % 3];
    const x = -60 + Math.random() * 120;
    const d = Math.random() * 0.25;
    return `<span class="fx-part" style="left:calc(50% + ${x}px);animation-delay:${d}s">${g}</span>`;
  }).join('');
  el.innerHTML = `
    <div class="fx-center${opts.gold ? ' gold' : ''}" role="presentation">
      <div class="fx-name">${chars}</div>
      ${parts}
      ${opts.firstTime ? '<div class="fx-stamp">장부에 기록되었다</div><div class="fx-fly">+1</div>' : ''}
    </div>`;
  // `+1`은 장부 패널 쪽으로 날아간다
  const fly = el.querySelector<HTMLElement>('.fx-fly');
  const ledger = document.getElementById('ledger');
  if (fly && ledger) {
    const r = ledger.getBoundingClientRect();
    fly.style.setProperty('--fly-x', `${r.left + r.width / 2 - innerWidth / 2}px`);
    fly.style.setProperty('--fly-y', `${r.top + 20 - innerHeight / 2}px`);
  }
  await hold(opts.firstTime ? 1100 : 600);
  document.querySelector('.field-panel')?.classList.remove('fx-pulse');
  el.innerHTML = '';
}

/** ③ 실패 — 작업대가 짧게 흔들린다 (문구·힌트 페이드는 signal 요소의 CSS가 맡는다). */
export function fxFail(): void {
  if (REDUCED) return;
  sndBubble();
  const p = document.querySelector('.field-panel');
  if (!p) return;
  p.classList.add('fx-shake');
  setTimeout(() => p.classList.remove('fx-shake'), 360);
}

/** ④ 첫 판매 — 말풍선 + 가격 카운트업(기본가→프리미엄가) + 금색 라벨 + 동전 비행 + S3. */
export async function fxFirstSale(
  flavor: string, basePrice: number, finalPrice: number, multLabel: string | null,
): Promise<void> {
  const el = fxRoot();
  if (REDUCED || !el) {
    return;
  }
  el.innerHTML = `
    <div class="fx-center" role="presentation">
      <div class="fx-bubble">${flavor}</div>
      <div class="fx-price"><b class="fx-num">${basePrice}</b>G</div>
      ${multLabel ? `<div class="fx-label">${multLabel}</div>` : ''}
      <span class="fx-coin">◉</span>
    </div>`;
  const num = el.querySelector<HTMLElement>('.fx-num');
  const t0 = performance.now();
  const dur = 500;
  const tick = (): void => {
    if (!num || !el.innerHTML) return;
    const k = Math.min(1, (performance.now() - t0) / dur);
    num.textContent = String(Math.round(basePrice + (finalPrice - basePrice) * k));
    if (k < 1) requestAnimationFrame(tick);
    else sndCoin();
  };
  requestAnimationFrame(tick);
  await hold(1300);
  el.innerHTML = '';
}
