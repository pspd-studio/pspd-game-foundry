/**
 * 화면 그리기. **문자열을 돌려주는 순수 함수**로 두었다.
 *   - DOM에 직접 손대지 않으므로 노드에서 단위 확인이 가능하다 (tools/smoke.mjs)
 *   - 카드 이름·색·칸 수는 전부 data에서 계산한다. 카드 id를 이 파일에 적지 않는다.
 *
 * 아트 에셋은 쓰지 않는다. 카드는 이름 텍스트 + 색 사각형이고,
 * slot_cost가 큰 카드는 그만큼 넓게 그려서 7칸 압박이 눈에 보이게 한다.
 */
import type { Card, GameData, GameState } from '../core/index.ts';
import { usedSlots, slotCap, aliveEnemies, region } from '../core/index.ts';

export interface ViewModel {
  selected: number[];
  discardMode: boolean;
  tutorialStep: number;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/** 카드 색은 태그에서 결정론적으로 뽑는다. 팔레트를 코드에 나열하지 않는다. */
export function cardHue(c: Card): number {
  const key = (c.tags && c.tags.length ? c.tags[0] : c.id);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

export function cardChipHTML(c: Card, idx: number, vm: ViewModel, extraClass = ''): string {
  const sel = vm.selected.includes(idx) ? ' is-sel' : '';
  const hue = cardHue(c);
  return `<button class="card t-${esc(c.tier)}${sel} ${extraClass}" data-idx="${idx}" draggable="true"
    style="--hue:${hue};--w:${c.slot_cost}"
    title="${esc(c.name_ko)} — ${c.slot_cost}칸">
    <span class="card-name">${esc(c.name_ko)}</span>
    <span class="card-cost">${c.slot_cost}칸</span>
  </button>`;
}

export function fieldHTML(data: GameData, st: GameState, vm: ViewModel): string {
  const cap = slotCap(data, st);
  const used = usedSlots(st.field);
  const cells = Array.from({ length: cap }, (_, i) =>
    `<span class="slot ${i < used ? 'slot-on' : ''}"></span>`).join('');
  const cards = st.field.map((c, i) => cardChipHTML(c, i, vm)).join('');
  return `<section class="field ${vm.discardMode ? 'mode-discard' : ''}">
    <header class="field-head">
      <span class="label">필드</span>
      <span class="slots" aria-label="슬롯 ${used} / ${cap}">${cells}</span>
      <span class="slots-num ${used >= cap ? 'is-full' : ''}">${used} / ${cap}칸</span>
    </header>
    <div class="cards" data-zone="field">${cards || '<p class="empty">필드가 비었습니다.</p>'}</div>
  </section>`;
}

export function enemiesHTML(data: GameData, st: GameState): string {
  const maxRow = Math.max(1, ...data.enemies.map((e) => e.start_row) ) + data.regions.reduce((m, r) => Math.max(m, r.enemy_pool.length), 0);
  const alive = aliveEnemies(st);
  const rows: string[] = [];
  for (let r = maxRow; r >= 0; r--) {
    const here = alive.filter((e) => e.row === r || (r === 0 && e.row <= 0));
    rows.push(`<div class="lane-row ${r === 0 ? 'lane-you' : ''}">
      <span class="lane-n">${r === 0 ? '나' : r}</span>
      <span class="lane-slot">${here.map((e) => `<span class="enemy ${e.is_boss ? 'is-boss' : ''} ${e.stunned > 0 ? 'is-stun' : ''}">
        ${esc(e.name_ko)} <b>${e.hp}/${e.maxHp}</b>${e.stunned > 0 ? ` <i>봉인 ${e.stunned}</i>` : ''}
      </span>`).join('')}</span>
    </div>`);
  }
  return `<section class="lane">
    <header class="field-head"><span class="label">${esc(region(data, st).name_ko)} — 적 ${alive.length}</span></header>
    ${rows.join('')}
  </section>`;
}

export function statusHTML(data: GameData, st: GameState): string {
  return `<header class="status">
    <span class="pill">턴 <b>${st.turn}</b></span>
    <span class="pill hp">HP <b>${Math.max(0, st.hp)}</b> / ${st.maxHp}</span>
    <span class="pill">발견 <b>${st.discovered.length}</b></span>
    <span class="pill">지역 <b>${esc(region(data, st).name_ko)}</b></span>
  </header>`;
}

export function controlsHTML(st: GameState, vm: ViewModel): string {
  return `<div class="controls">
    <button class="btn ${vm.discardMode ? 'is-on' : ''}" data-act="discard-mode" ${st.over || st.discardLeft <= 0 ? 'disabled' : ''}>
      버리기 (남은 ${st.discardLeft})
    </button>
    <button class="btn primary" data-act="end-turn" ${st.over ? 'disabled' : ''}>턴 종료</button>
    <button class="btn ghost" data-act="restart">새 판</button>
  </div>`;
}

/** 이번 판의 도감 — 발견한 레시피만 보여준다. discovery_text가 이 게임의 재미 자체다. */
export function codexHTML(data: GameData, st: GameState): string {
  if (!st.knownRecipes.length) {
    return `<section class="codex"><header class="field-head"><span class="label">도감</span></header>
      <p class="empty">아직 아무것도 발견하지 않았습니다.</p></section>`;
  }
  const items = st.knownRecipes.map((id) => {
    const r = data.recipes.find((x) => x.id === id)!;
    const nm = (cid: string) => esc(data.cardById.get(cid)?.name_ko ?? cid);
    return `<li><span class="codex-eq">${nm(r.inputs[0])} + ${nm(r.inputs[1])} → <b>${nm(r.result)}</b></span>
      <span class="codex-txt">${esc(r.discovery_text ?? '')}</span></li>`;
  }).join('');
  return `<section class="codex"><header class="field-head"><span class="label">도감 ${st.knownRecipes.length}</span></header>
    <ul>${items}</ul></section>`;
}

const TUTORIAL = [
  '카드 두 장을 눌러 보세요. 맞는 짝이면 새것이 만들어집니다.',
  '필드는 7칸입니다. 강한 카드는 더 넓은 자리를 씁니다.',
  '짝이 없는 카드는 턴에 한 장 버릴 수 있습니다.',
];

export function tutorialHTML(vm: ViewModel): string {
  if (vm.tutorialStep >= TUTORIAL.length) return '';
  return `<p class="tutorial">${esc(TUTORIAL[vm.tutorialStep])}</p>`;
}

export function endHTML(data: GameData, st: GameState): string {
  const win = st.over === 'win';
  const list = st.knownRecipes.map((id) => {
    const r = data.recipes.find((x) => x.id === id)!;
    return `<li><b>${esc(data.cardById.get(r.result)?.name_ko ?? r.result)}</b> — ${esc(r.discovery_text ?? '')}</li>`;
  }).join('');
  return `<div class="overlay end">
    <div class="end-card">
      <h2>${win ? '살아남았습니다' : '여기서 끝났습니다'}</h2>
      <p>턴 ${st.turn} · 발견 ${st.discovered.length}종 · 남은 HP ${Math.max(0, st.hp)}</p>
      ${list ? `<ul class="end-list">${list}</ul>` : '<p class="empty">이번 판에는 발견이 없었습니다.</p>'}
      <button class="btn primary" data-act="restart">한 판 더</button>
    </div>
  </div>`;
}

export function boardHTML(data: GameData, st: GameState, vm: ViewModel): string {
  return [
    statusHTML(data, st),
    tutorialHTML(vm),
    enemiesHTML(data, st),
    fieldHTML(data, st, vm),
    controlsHTML(st, vm),
    codexHTML(data, st),
    st.over ? endHTML(data, st) : '',
  ].join('\n');
}
