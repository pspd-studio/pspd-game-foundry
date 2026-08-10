/**
 * v2.1 슬라이스 화면 그리기 — 문자열 HTML을 만들어 돌려주는 순수 함수들.
 *
 * 아트는 없다. 텍스트와 도형뿐이다 (G3 통과 전 아트 금지).
 * 다만 "카드 게임"이 아니라 "카드로 하는 상점 경영"으로 보여야 하므로,
 * 화면 문법(피벗 브리프)의 오브젝트 네 개를 전면에 세운다:
 *   7칸 슬롯 그리드 · 물음표 뚫린 도감 · 시세가 꺾이는 수요 게시판 · 인장 찍힌 계약서.
 */
import type { EconSession } from '../core/econSession.ts';
import type { RunContract } from '../core/econ.ts';

export interface ViewState {
  selected: number[];
  toast: string | null;
  signal: { pair: string; signal: 'warm' | 'cold' } | null;
  log: string[];
  confirm: { i: number; j: number; resultName: string } | null;
  showIntro: boolean;
  showCodex: boolean;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const tierClass = (t: string): string => `t${t}`;

/* ── 필드 (7칸 슬롯 그리드) ─────────────────────────────────── */

function fieldCard(S: EconSession, V: ViewState, idx: number): string {
  const id = S.field[idx];
  const c = S.card(id);
  const sel = V.selected.includes(idx);
  const price = S.priceOfCard(id);
  const prem = S.premiumOn(id);
  const need = S.neededForContract(id);
  return `
    <button class="card ${tierClass(c.tier)}${sel ? ' sel' : ''}" style="grid-column: span ${c.slot_cost}"
            data-act="pick" data-idx="${idx}" title="${esc(c.name_ko)} · ${c.tier}급 · ${c.slot_cost}칸">
      <span class="cname">${esc(c.name_ko)}</span>
      <span class="cmeta">${c.tier} · ${c.slot_cost}칸</span>
      <span class="cprice">${price}G${prem ? ' <b class="prem">첫판매</b>' : ''}</span>
      ${need ? '<span class="badge need">계약</span>' : ''}
      <span class="tags">${c.tags.map((t) => `<i>${esc(t)}</i>`).join('')}</span>
    </button>`;
}

function fieldPanel(S: EconSession, V: ViewState): string {
  const empty = Math.max(0, S.free);
  const holes = Array.from({ length: empty }, () => '<div class="slot-empty"></div>').join('');
  const two = V.selected.length === 2;
  const oneSel = V.selected.length === 1;
  return `
  <section class="panel field-panel">
    <h2>작업대 <small>${S.used}/${S.R.fieldSlots}칸</small></h2>
    <div class="grid7">
      ${S.field.map((_, i) => fieldCard(S, V, i)).join('')}
      ${holes}
    </div>
    <div class="row actions">
      <button class="primary" data-act="combine" ${two ? '' : 'disabled'}>합치기</button>
      <button data-act="sell" ${oneSel && S.canMarket() ? '' : 'disabled'}>팔기 ${oneSel ? `(${S.priceOfCard(S.field[V.selected[0]])}G)` : ''}</button>
      <button data-act="discard" ${oneSel && S.discardLeft > 0 ? '' : 'disabled'}>버리기 (${S.discardLeft})</button>
      <button data-act="clear" ${V.selected.length ? '' : 'disabled'}>선택 해제</button>
    </div>
    <p class="hintline">
      이번 턴 남은 실험 <b>${S.unknownLeft}</b>회 ·
      시장 행동 <b>${S.marketActionUsed ? '사용함' : S.marketOpen ? '가능' : '잠김'}</b>
    </p>
    ${V.signal ? `<p class="signal ${V.signal.signal}">${V.signal.signal === 'warm'
      ? '부글거리다 멎었다. 계열은 맞는 것 같다.'
      : '아무 일도 없었다.'} <small>${esc(V.signal.pair)}</small></p>` : ''}
  </section>`;
}

/* ── 인장 찍힌 계약서 ───────────────────────────────────────── */

function contractCard(S: EconSession, c: RunContract): string {
  const left = c.deadline - S.turn;
  const state = c.done ? 'done' : c.failed ? 'failed' : left <= 2 ? 'urgent' : '';
  const can = !c.done && !c.failed && S.turn <= c.deadline && S.deliverableIndex(c) >= 0;
  const track = Math.max(0, Math.min(10, left));
  return `
    <div class="contract ${state}">
      <div class="seal">${c.done ? '완납' : c.failed ? '파기' : '진행'}</div>
      <div class="cbody">
        <b>${esc(S.labelOf(c))}</b>
        <div class="ctrack" title="마감까지 ${left}턴">
          ${Array.from({ length: 10 }, (_, i) => `<i class="${i < track ? 'on' : ''}"></i>`).join('')}
        </div>
        <small>${c.kind === 'gold' ? `자금 ${S.gold}/${c.amount}G` : `${c.delivered}/${c.count ?? 1} 납품`} ·
          마감 ${c.deadline}턴 · 보상 ${c.reward}G</small>
      </div>
      <button data-act="deliver" data-id="${c.id}" ${can ? '' : 'disabled'}>납품</button>
    </div>`;
}

function contractPanel(S: EconSession): string {
  return `
  <section class="panel">
    <h2>계약서 <small>${S.contracts.filter((c) => c.done).length}/${S.contracts.length} 완납 · 2건 이상이면 성공</small></h2>
    ${S.contracts.map((c) => contractCard(S, c)).join('')}
  </section>`;
}

/* ── 시세가 꺾이는 수요 게시판 ──────────────────────────────── */

function demandBoard(S: EconSession): string {
  const tiers = Object.keys(S.R.basePrice);
  return `
  <section class="panel">
    <h2>수요 게시판 <small>티어 풀은 런 안에서 회복되지 않는다</small></h2>
    <table class="demand">
      <tr><th>티어</th><th>기본가</th><th>남은 수요</th><th>시세</th></tr>
      ${tiers.map((t) => {
        const pool = S.R.demandPool[t] ?? 0;
        const sold = S.tierSold[t] ?? 0;
        const left = Math.max(0, pool - sold);
        const over = sold - pool;
        const cur = Math.round((S.R.basePrice[t] ?? 0) * (over >= 0 ? Math.pow(S.R.saturationR, over + 1) : 1));
        return `<tr class="${left === 0 ? 'sat' : ''}">
          <td>${t}</td><td>${S.R.basePrice[t]}G</td>
          <td><span class="bar"><i style="width:${pool ? (left / pool) * 100 : 0}%"></i></span> ${left}/${pool}</td>
          <td>${cur}G ${over >= 0 ? '<b class="down">▼</b>' : ''}</td>
        </tr>`;
      }).join('')}
    </table>
  </section>`;
}

/* ── 시장 (턴당 1회) ────────────────────────────────────────── */

function marketPanel(S: EconSession): string {
  if (!S.marketOpen) {
    return `<section class="panel muted">
      <h2>시장 <small>잠김</small></h2>
      <p>처음 발견한 물건이 생기면 구매자가 찾아온다.</p>
    </section>`;
  }
  const can = S.canMarket();
  const buyables = S.buyableCards();
  return `
  <section class="panel">
    <h2>시장 <small>턴당 1회 · 사거나 팔거나 단서 하나</small></h2>
    <div class="buyrow">
      ${buyables.map((id) => `<button class="buy" data-act="buy" data-id="${id}"
          ${can && S.gold >= S.buyCost() && S.free >= S.card(id).slot_cost ? '' : 'disabled'}>
          ${esc(S.card(id).name_ko)} <small>${S.buyCost()}G</small></button>`).join('')}
    </div>
    <button class="hintbuy" data-act="hint" ${can && S.gold >= S.hintCost() ? '' : 'disabled'}>
      단서 사기 <small>${S.hintCost()}G</small>
    </button>
    ${S.hints.length ? `<ul class="hints">${S.hints.map((h) => `<li>${esc(h.text)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

/* ── 물음표 뚫린 도감 ───────────────────────────────────────── */

function codexPanel(S: EconSession, V: ViewState): string {
  const total = S.reachableCount();
  const found = [...S.codex];
  const holes = Math.max(0, total - S.known.size);
  return `
  <section class="panel">
    <h2>도감 <small>${S.known.size}/${total} 레시피</small>
      <button class="link" data-act="codex">${V.showCodex ? '접기' : '펼치기'}</button>
    </h2>
    ${V.showCodex ? `<div class="codex">
      ${found.map((id) => `<span class="found ${tierClass(S.card(id).tier)}">${esc(S.card(id).name_ko)}</span>`).join('')}
      ${Array.from({ length: holes }, () => '<span class="hole">?</span>').join('')}
    </div>` : `<div class="codexbar"><i style="width:${total ? (S.known.size / total) * 100 : 0}%"></i></div>`}
  </section>`;
}

/* ── 오버레이 ───────────────────────────────────────────────── */

function draftOverlay(S: EconSession): string {
  if (S.phase !== 'draft' || !S.draftCandidates) return '';
  return `
  <div class="overlay">
    <div class="sheet">
      <h2>공급 — 한 장만 고른다</h2>
      <p class="sub">나머지 두 장은 사라진다.</p>
      <div class="draftrow">
        ${S.draftCandidates.map((id, i) => {
          const c = S.card(id);
          return `<button class="card ${tierClass(c.tier)}" data-act="draft" data-idx="${i}"
            ${S.free >= c.slot_cost ? '' : 'disabled'}>
            <span class="cname">${esc(c.name_ko)}</span>
            <span class="cmeta">${c.tier} · ${c.slot_cost}칸</span>
            <span class="tags">${c.tags.map((t) => `<i>${esc(t)}</i>`).join('')}</span>
          </button>`;
        }).join('')}
      </div>
      ${S.draftCandidates.every((id) => S.free < S.card(id).slot_cost)
        ? '<p class="sub">작업대에 자리가 없다. 이번 공급은 통째로 넘긴다.</p>' : ''}
      <button class="ghost" data-act="draft" data-idx="-1">전부 포기</button>
    </div>
  </div>`;
}

/** 온보딩 3번 — 첫 발견물에 구매자가 찾아온다. 판매 동사를 화면이 먼저 시연한다. */
function buyerOverlay(S: EconSession): string {
  if (S.phase !== 'play' || !S.firstBuyer) return '';
  const c = S.card(S.firstBuyer);
  return `
  <div class="overlay">
    <div class="sheet">
      <h2>구매자가 찾아왔다</h2>
      <p>"그 <b>${esc(c.name_ko)}</b>, 처음 보는 물건이군. <b>${S.priceOfCard(S.firstBuyer)}G</b>에 삽니다."</p>
      <p class="sub">처음 발견한 물건은 처음 팔 때 가장 비싸다. 이 거래는 이번 턴 시장 행동을 쓰지 않는다.</p>
      <div class="row">
        <button class="primary" data-act="buyer-yes">판다</button>
        <button data-act="buyer-no">아직 안 판다</button>
      </div>
    </div>
  </div>`;
}

function confirmOverlay(V: ViewState): string {
  if (!V.confirm) return '';
  return `
  <div class="overlay">
    <div class="sheet danger">
      <h2>위험한 조합</h2>
      <p><b>${esc(V.confirm.resultName)}</b>은(는) 실패할 수 있다. 실패해도 재료는 남는다.</p>
      <div class="row">
        <button class="primary" data-act="confirm-yes">그래도 한다</button>
        <button data-act="confirm-no">그만둔다</button>
      </div>
    </div>
  </div>`;
}

function introOverlay(V: ViewState): string {
  if (!V.showIntro) return '';
  return `
  <div class="overlay">
    <div class="sheet">
      <h2>UNFOUND</h2>
      <p>두 장을 골라 합쳐 보세요. 레시피는 아무도 모릅니다.</p>
      <p>처음 발견한 물건은 처음 팔 때 가장 비쌉니다.</p>
      <p>18턴 안에 계약 3건 중 2건을 채우면 성공입니다.</p>
      <button class="primary" data-act="start">시작</button>
    </div>
  </div>`;
}

function settleOverlay(S: EconSession): string {
  if (S.phase !== 'over' || !S.settlement) return '';
  const s = S.settlement;
  const total = S.reachableCount();
  const holes = Math.max(0, total - S.known.size);
  return `
  <div class="overlay">
    <div class="sheet wide">
      <h2>${s.runFail ? '정산 — 계약 미달' : '정산 — 계약 이행'}</h2>
      <p class="sub">계약 ${s.fulfilled}/${s.contractsTotal} · 자금 ${s.gold}G →
        <b>${s.settle}G</b>${s.runFail ? ' <small>(실패 정산 50%)</small>' : ''}</p>
      <h3>이번 런에서 채운 도감</h3>
      <div class="codex">
        ${[...S.codex].map((id) => `<span class="found ${tierClass(S.card(id).tier)}">${esc(S.card(id).name_ko)}</span>`).join('')}
        ${Array.from({ length: holes }, () => '<span class="hole">?</span>').join('')}
      </div>
      <p class="sub">아직 ${holes}개가 비어 있다.</p>
      <button class="primary" data-act="again">다시 한 판</button>
    </div>
  </div>`;
}

/* ── 전체 ───────────────────────────────────────────────────── */

export function render(S: EconSession, V: ViewState): string {
  const turnTrack = Array.from({ length: S.lastTurn }, (_, i) =>
    `<i class="${i < S.turn ? 'on' : ''}"></i>`).join('');
  return `
  <div class="hud">
    <div class="turn">
      <b>${S.turn} / ${S.lastTurn}턴</b>
      <div class="track">${turnTrack}</div>
    </div>
    <div class="gold"><b>${S.gold}</b>G</div>
    <div class="slots">칸 ${S.used}/${S.R.fieldSlots}</div>
    <button class="primary end" data-act="end">턴 종료</button>
  </div>
  <div class="cols">
    <div class="col main">
      ${fieldPanel(S, V)}
      ${marketPanel(S)}
      <section class="panel log">
        <h2>기록</h2>
        <ul>${V.log.slice(-12).reverse().map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      </section>
    </div>
    <div class="col side">
      ${contractPanel(S)}
      ${demandBoard(S)}
      ${codexPanel(S, V)}
    </div>
  </div>
  ${V.toast ? `<div class="toast">${esc(V.toast)}</div>` : ''}
  ${draftOverlay(S)}
  ${buyerOverlay(S)}
  ${confirmOverlay(V)}
  ${settleOverlay(S)}
  ${introOverlay(V)}`;
}
