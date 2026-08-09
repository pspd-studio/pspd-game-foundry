/**
 * UI 컨트롤러. 규칙 판단을 하지 않는다 — 전부 src/core에 물어본다.
 * 여기서 하는 일은 세 가지뿐이다: 입력 받기 / 코어 호출 / 화면 다시 그리기.
 */
import './styles.css';
import { DATA } from '../data/browser.ts';
import {
  createGame, attemptCombine, discardAt, endTurn, aliveEnemies, readSwitches,
} from '../core/index.ts';
import type { GameState } from '../core/index.ts';
import { boardHTML, esc } from './view.ts';
import type { ViewModel } from './view.ts';
import { createLogger } from './log.ts';
import { attachRemote, remoteEnabled } from './remote.ts';

const root = document.getElementById('app')!;
const fx = document.getElementById('fx')!;
const logger = createLogger();

// ?log=1 이면 이벤트를 콘솔로도 흘린다.
const params = new URLSearchParams(location.search);
if (params.get('log') === '1') logger.addSink((r) => console.log('[unfound]', r.ms, r.event.t, r.event));

// 원격 전송. config.ts가 비어 있으면 아무 일도 하지 않는다 (게임은 그대로 돈다).
attachRemote(logger);

const vm: ViewModel = { selected: [], discardMode: false, tutorialStep: 0 };
let st: GameState = newRun();

function newRun(): GameState {
  vm.selected = [];
  vm.discardMode = false;
  const seedParam = Number(params.get('seed'));
  const seed = Number.isFinite(seedParam) && seedParam > 0
    ? seedParam + logger.run * 7919
    : (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  return createGame(DATA, seed, logger.push, params.get('region') ?? undefined);
}

function render(): void {
  root.innerHTML = boardHTML(DATA, st, vm);
  const foot = document.getElementById('foot');
  if (foot) {
    foot.textContent = `세션 ${logger.session.slice(0, 8)} · ${logger.run}판 · 이벤트 ${logger.records.length}`
      + (remoteEnabled() ? ' · 기록 중' : '');
  }
}

/* ── 연출 ─────────────────────────────────────────────────── */

function discovery(text: string, resultName: string): void {
  fx.innerHTML = `<div class="overlay discovery" data-act="close-fx">
    <div class="disc-card">
      <p class="disc-kicker">발견</p>
      <h2>${esc(resultName)}</h2>
      <p class="disc-text">${esc(text)}</p>
    </div>
  </div>`;
  window.setTimeout(() => { if (fx.querySelector('.discovery')) fx.innerHTML = ''; }, 2400);
}

function toast(msg: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  fx.appendChild(el);
  window.setTimeout(() => el.remove(), 1800);
}

function shake(idx: number[]): void {
  for (const i of idx) {
    const el = root.querySelector<HTMLElement>(`.card[data-idx="${i}"]`);
    if (!el) continue;
    el.classList.add('shake');
    window.setTimeout(() => el.classList.remove('shake'), 400);
  }
}

/* ── 행동 ─────────────────────────────────────────────────── */

function tryCombine(i: number, j: number): void {
  const before = st.field.map((c) => c.name_ko);
  const res = attemptCombine(DATA, st, i, j, logger.push);
  vm.selected = [];

  if (res.outcome.ok) {
    st = res.state;
    if (vm.tutorialStep === 0) vm.tutorialStep = 1;
    render();
    discovery(res.outcome.discovery_text, res.outcome.result.name_ko);
    // 적을 다 정리했으면 시뮬레이터와 같은 순서로 턴을 닫아 승리를 확정한다.
    if (aliveEnemies(st).length === 0) doEndTurn();
    return;
  }

  const pair = `${before[i]} + ${before[j]}`;
  if (res.outcome.reason === 'no_slot') {
    toast(`${pair} — 결과를 놓을 칸이 없습니다.`);
  } else if (res.outcome.reason === 'no_recipe') {
    st = res.state;
    const cost = readSwitches(DATA.rules).failed_combine_cost;
    toast(`${pair} — 아직 아무 일도 일어나지 않습니다.${cost === 'hp' ? ' (HP 1)' : cost === 'turn' ? ' (이번 턴 조합 끝)' : ''}`);
  } else {
    toast('지금은 조합할 수 없습니다.');
  }
  shake([i, j]);
  render();
}

function doDiscard(i: number): void {
  const name = st.field[i]?.name_ko ?? '';
  const res = discardAt(DATA, st, i, logger.push, 'player');
  if (!res.ok) { toast('이번 턴에는 더 버릴 수 없습니다.'); return; }
  st = res.state;
  vm.discardMode = false;
  vm.selected = [];
  if (vm.tutorialStep < 3) vm.tutorialStep = 3;
  toast(`${name}을(를) 버렸습니다.`);
  render();
}

function doEndTurn(): void {
  st = endTurn(DATA, st, logger.push);
  vm.selected = [];
  vm.discardMode = false;
  if (vm.tutorialStep === 1 && st.turn >= 2) vm.tutorialStep = 2;
  render();
  if (st.over) {
    const s = logger.summary();
    console.log('[unfound] 세션 요약', s);
  }
}

function restart(): void {
  st = newRun();
  vm.tutorialStep = 0;
  fx.innerHTML = '';
  render();
}

/* ── 입력 ─────────────────────────────────────────────────── */

document.addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement;
  if (t.closest('[data-act="close-fx"]')) { fx.innerHTML = ''; return; }

  const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'restart') return restart();
  if (act === 'end-turn') return doEndTurn();
  if (act === 'discard-mode') {
    vm.discardMode = !vm.discardMode;
    vm.selected = [];
    return render();
  }
  if (t.closest('.tutorial')) { vm.tutorialStep += 1; return render(); }

  const cardEl = t.closest<HTMLElement>('.card[data-idx]');
  if (!cardEl || st.over) return;
  const idx = Number(cardEl.dataset.idx);

  if (vm.discardMode) return doDiscard(idx);

  if (vm.selected.includes(idx)) vm.selected = vm.selected.filter((x) => x !== idx);
  else vm.selected.push(idx);

  if (vm.selected.length >= 2) {
    const [a, b] = vm.selected;
    return tryCombine(a, b);
  }
  render();
});

// 드래그로도 조합할 수 있게 한다 (두 장 클릭과 동등한 경로).
let dragFrom = -1;
document.addEventListener('dragstart', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('.card[data-idx]');
  if (!el) return;
  dragFrom = Number(el.dataset.idx);
  ev.dataTransfer?.setData('text/plain', String(dragFrom));
});
document.addEventListener('dragover', (ev) => {
  if (dragFrom >= 0 && (ev.target as HTMLElement).closest('.card[data-idx]')) ev.preventDefault();
});
document.addEventListener('drop', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('.card[data-idx]');
  if (!el || dragFrom < 0 || st.over) return;
  ev.preventDefault();
  const to = Number(el.dataset.idx);
  const from = dragFrom;
  dragFrom = -1;
  if (from !== to) tryCombine(from, to);
});

// 디버그·로그 추출용. 3단계에서 이 핸들에 전송 sink를 붙일 수 있다.
Object.defineProperty(globalThis, '__unfound', {
  value: { DATA, logger, get state() { return st; } },
  configurable: true,
});

render();
