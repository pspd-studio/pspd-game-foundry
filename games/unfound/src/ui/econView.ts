/**
 * v3.0 슬라이스 화면 그리기 — 문자열 HTML을 만들어 돌려주는 순수 함수들.
 *
 * 아트는 없다. 텍스트와 도형뿐이다 (G3 통과 전 아트 금지).
 * 화면은 "책상 위 문서" 구도다 (클론 인상 방어 — 07 지시서 불변 조건):
 *   캔버스 매트(칸 경계선 보임) · 장부 · 게시판 · 턴 트랙 · 하단 확인 바.
 *   카드가 벌판에 흩어진 구도 금지.
 * 세계관 A안(안개 장부)의 명사 사전이 여기 산다:
 *   도감→바랜 장부 / 상점→되찾이 가게 / 계약→공물 어음 / 수요 게시판→분실물 게시판 /
 *   공급 드래프트→무주물 경매 / 심사→저울질 / 회기→갠 사이 / 지역→물러난 거리
 * 조작은 전부 탭+선택→확인 — 드래그 전면 금지 (07 지시서).
 */
import type { EconSession } from '../core/econSession.ts';
import type { RunContract } from '../core/econ.ts';
import { topOf } from '../core/econ.ts';
import { EVENT_NAMES } from '../core/econEvents.ts';
import { DISPATCH_NAMES, type DispatchDest } from '../core/econSession.ts';

export interface CareerHud {
  runIndex: number;
  gradeName: string;
  /** 다음 저울질까지 남은 갠 사이 (null = 명장, 더는 없다) */
  runsUntil: number | null;
  reqCount: number;
  reqTierC: number;
  newSince: number;
  cNewSince: number;
  deferred: boolean;
}

export interface ReviewView {
  pass: boolean;
  wasRetry: boolean;
  required: number;
  achieved: number;
  tierCRequired: number;
  tierCAchieved: number;
  gradeName: string;
}

export interface ViewState {
  /** 선택된 더미 인덱스 (최대 2 — 순서가 쌓기 방향이다). */
  selected: number[];
  toast: string | null;
  signal: { pair: string; signal: 'warm' | 'cold'; hint: string | null; detail: string | null } | null;
  log: string[];
  confirm: { i: number; j: number; resultName: string } | null;
  showIntro: boolean;
  showCodex: boolean;
  /** 가설 기입 중 (레시피 id + 고른 재료). */
  hypo: { recipeId: string; a: string | null; b: string | null } | null;
  /** 뒷면 목록을 열어 둔 더미 (파내기). */
  digPile: number | null;
  /** 이동 확인 중인 지역 인덱스. */
  moveTo: number | null;
  /** 파견 행선지 고르는 중. */
  dispatchOpen: boolean;
  /** 로그 서버가 꺼져 있을 때만 정산 화면에 "기록 복사" 버튼을 낸다. */
  offlineLog: boolean;
  /** 장기 시계 표시. null이면 완전 은닉 (첫 판). */
  career: CareerHud | null;
  /** 이번 정산이 저울질이었으면 그 결과. */
  review: ReviewView | null;
  /** 정산 화면 3줄 데뷔용 (첫 정산에만 채워진다). */
  reviewDebut: string[] | null;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const tierClass = (t: string): string => `t${t}`;

/** 계열 태그의 우리말 (표시 전용 — 데이터의 태그 id는 그대로 둔다). */
export const TAG_KO: Record<string, string> = {
  mineral: '돌붙이', solid: '단단한 것', plant: '풀붙이', wood: '나무', liquid: '젖은 것',
  nature: '자연', life: '생명', craft: '손일', energy: '기운', heat: '뜨거운 것',
  sky: '하늘', fast: '빠른 것', creature: '짐승', slow: '느린 것', record: '기록',
  light: '빛', concept: '관념', poison: '독', death: '죽음', dark: '어둠',
  sound: '소리', rare: '희귀', tool: '연장', weapon: '무기', control: '다룸',
  metal: '쇠붙이', person: '사람', food: '먹을 것',
};
export const tagKo = (t: string): string => TAG_KO[t] ?? t;

/* ── 지역 카드 띠 (상단 — 지도 전환 없음, SSOT [v3.0] 이동) ──── */

function regionStrip(S: EconSession): string {
  const cards = S.D.regions.map((rg, i) => {
    if (i === S.regionIdx) {
      return `<div class="region cur">
        <b>${esc(rg.name_ko)}</b><small>지금 있는 거리</small>
        <span class="rtags">${rg.theme_tags.slice(0, 3).map((t) => `<i>${esc(tagKo(t))}</i>`).join('')}</span>
      </div>`;
    }
    if (i < S.unlockedRegions) {
      const going = S.traveling?.to === i;
      return `<button class="region back${going ? ' going' : ''}" data-act="move" data-idx="${i}"
        ${S.traveling || S.marketActionUsed || S.phase !== 'play' ? 'disabled' : ''}>
        <b>${esc(rg.name_ko)}</b><small>${going ? `이동 중 — ${S.traveling!.left}턴` : `⏱ ${S.R.moveTurns}턴`}</small>
      </button>`;
    }
    return `<div class="region locked"><b>${esc(rg.name_ko)}</b><small>저울질이 열어 준다</small></div>`;
  });
  return `<div class="regions">${cards.join('')}
    ${S.traveling ? '<span class="travelnote">길 위 — 조합은 되지만 시장·게시판은 없다</span>' : ''}</div>`;
}

/* ── 캔버스 매트 (펼침 12자리 + 더미) ──────────────────────── */

function pileCard(S: EconSession, V: ViewState, pi: number): string {
  const pile = S.piles[pi];
  const id = topOf(pile);
  const c = S.card(id);
  const sel = V.selected.includes(pi);
  const person = S.isPersonLike(id);
  const striking = S.strikes.has(id);
  const price = person ? null : S.priceOfCard(id);
  const prem = !person && S.premiumOn(id);
  const need = !person && S.neededForContract(id);
  const evtBoost = !person && S.eventDeck && S.eventDeck.multOf(S.turn, c) > 1;
  const guest = S.guestCard(id);
  const buried = pile.length - 1;
  // 묻힌 카드의 계열 글리프 — 뒷면은 이름을 밝히지 않는다 (정보 은닉)
  const glyphs = pile.slice(0, -1).slice(-4)
    .map((bid) => esc(tagKo(S.card(bid).tags[0] ?? '')[0] ?? '?')).join('·');
  return `
    <button class="card ${tierClass(c.tier)}${sel ? ' sel' : ''}${buried ? ' hasPile' : ''}"
            style="grid-column: span ${c.slot_cost}" draggable="true"
            data-act="pick" data-idx="${pi}" title="${esc(c.name_ko)} · ${c.tier}급 · ${c.slot_cost}자리${buried ? ` · 밑에 ${buried}장` : ''}">
      <span class="cname">${esc(c.name_ko)}</span>
      <span class="cmeta">${person ? (c.tier === 'G' ? (striking ? '식객 · 파업 중' : '식객') : '인물') : `${c.tier} · ${c.slot_cost}자리`}</span>
      ${guest?.effect_ko ? `<span class="ceffect">${striking ? '배가 고파 일을 놓았다' : esc(guest.effect_ko)}</span>` : ''}
      ${price !== null ? `<span class="cprice${evtBoost ? ' evt' : ''}">${price}G${prem ? ' <b class="prem">첫판매</b>' : ''}</span>` : ''}
      ${need ? '<span class="badge need">어음</span>' : ''}
      <span class="tags">${c.tags.map((t) => `<i>${esc(tagKo(t))}</i>`).join('')}</span>
      ${buried ? `<span class="pilebadge" data-act="digmenu" data-idx="${pi}" title="더미 — 뒷면 목록 열기">×${pile.length}<i>${glyphs}</i></span>` : ''}
    </button>`;
}

function matPanel(S: EconSession, V: ViewState): string {
  const empty = Math.max(0, S.free);
  const holes = Array.from({ length: empty }, () => '<div class="slot-empty"></div>').join('');
  return `
  <section class="panel field-panel">
    <h2>캔버스 매트 <small>펼침 ${S.used}/${S.R.spreadSlots}자리 · 더미는 깊이 무한 · 파내기 무료</small></h2>
    <div class="mat">
      ${S.piles.map((_, i) => pileCard(S, V, i)).join('')}
      ${holes}
    </div>
    ${V.signal ? `<p class="signal ${V.signal.signal}">${V.signal.signal === 'warm'
      ? '부글거리다… 멎었다.'
      : '아무 일도 없었다.'}${V.signal.hint ? ` <span class="fadein">(${esc(V.signal.hint)})</span>` : ''}${
        V.signal.detail ? ` <span class="fadein slow">(${esc(V.signal.detail)})</span>` : ''}
      <small>${esc(V.signal.pair)}</small></p>` : ''}
  </section>`;
}

/* ── 하단 확인 바 — 모든 조작의 확인 단계 (드래그 금지 문법) ── */

function confirmBar(S: EconSession, V: ViewState): string {
  const n = V.selected.length;
  const two = n === 2;
  const one = n === 1;
  const selId = one ? topOf(S.piles[V.selected[0]]) : null;
  const sellable = Boolean(selId && !S.isPersonLike(selId));
  const selPrice = selId && sellable ? S.priceOfCard(selId) : null;
  const selNext = selId && sellable ? S.nextPriceOfCard(selId) : null;
  const ledgered = two && S.inLedger(V.selected[0], V.selected[1]);
  const tried = two && S.wasTried(V.selected[0], V.selected[1]);
  const preview = two ? S.previewResult(V.selected[0], V.selected[1]) : null;
  const canUnstack = one && S.piles[V.selected[0]].length > 1;
  const foretell = selPrice !== null && selNext !== null && selNext < selPrice;
  return `
  <div class="confirmbar">
    <div class="cbinfo">
      실험 <b>${S.unknownLeft}</b>회 · 시장 <b>${S.marketActionUsed ? '끝' : S.traveling ? '길 위' : S.marketOpen ? '가능' : '잠김'}</b>
      ${tried ? ' · <b>이미 해본 조합</b>' : ''}${ledgered ? ' · <b>장부에 적힌 실패</b>' : ''}
      ${foretell ? ` · <b class="foretell">이번 ${selPrice}G → 다음 ${selNext}G</b>` : ''}
    </div>
    <div class="cbacts">
      ${two ? `<button class="primary" data-act="combine" ${ledgered ? 'disabled' : ''}>합치기${preview ? ` → ${esc(preview.name_ko)}` : ''}</button>
               <button data-act="stack" title="첫 카드를 둘째 더미 위에 얹는다">쌓기</button>` : ''}
      ${one ? `<button class="primary" data-act="sell" ${sellable && S.canMarket() ? '' : 'disabled'}>팔기${selPrice !== null ? ` ${selPrice}G` : ''}</button>
               ${canUnstack ? '<button data-act="unstack">따로 놓기</button>' : ''}
               <button data-act="discard" ${S.discardLeft > 0 ? '' : 'disabled'}>버리기 (${S.discardLeft})</button>` : ''}
      ${n ? '<button data-act="clear">해제</button>' : '<span class="cbhint">카드 두 장을 탭하면 합치거나 쌓을 수 있다</span>'}
    </div>
  </div>`;
}

/* ── 게시판 (심사 게이지 고정 카드 + 공물 어음 + 이벤트 핀) ── */

function careerCard(V: ViewState): string {
  if (!V.career) return '';
  const c = V.career;
  const gaugeMax = Math.max(1, c.reqCount);
  const on = Math.min(c.newSince, gaugeMax);
  return `
  <div class="careercard" title="승급 심사 「저울질」 — 잣대는 장부 하나뿐이다">
    <b>${esc(c.gradeName)}</b>
    ${c.runsUntil === null ? '<small>전당 기록</small>' : `
      <small>저울질까지 ${c.runsUntil}갠 사이${c.deferred ? ' · 유예' : ''}</small>
      <span class="gauge">${Array.from({ length: gaugeMax }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</span>
      <small>신규 복원 ${c.newSince}/${c.reqCount} · C급 ${c.cNewSince}/${c.reqTierC}</small>`}
  </div>`;
}

function contractCard(S: EconSession, c: RunContract): string {
  const left = c.deadline - S.turn;
  const state = c.done ? 'done' : c.failed ? 'failed' : !c.claimed ? 'posted' : left <= 2 ? 'urgent' : '';
  const can = !S.traveling && c.claimed && !c.done && !c.failed && S.turn <= c.deadline && S.deliverableIndex(c) >= 0;
  const canClaim = !S.traveling && !c.claimed && !c.done && !c.failed && S.turn <= c.deadline && S.R.contractBoardOn;
  const track = Math.max(0, Math.min(10, left));
  return `
    <div class="contract ${state}">
      <div class="seal">${c.done ? '완납' : c.failed ? '미달' : c.claimed ? '수주' : '게시'}</div>
      <div class="cbody">
        <b>${esc(S.labelOf(c))}</b>
        <div class="ctrack" title="기한까지 ${left}턴">
          ${Array.from({ length: 10 }, (_, i) => `<i class="${i < track ? 'on' : ''}"></i>`).join('')}
        </div>
        <small>${c.kind === 'gold' ? `자금 ${S.gold}/${c.amount}G` : `${c.delivered}/${c.count ?? 1} 납품`} ·
          기한 ${c.deadline}턴 · 삯 ${c.reward}G</small>
      </div>
      ${canClaim
        ? `<button class="primary" data-act="claim" data-id="${c.id}">수주</button>`
        : `<button data-act="deliver" data-id="${c.id}" ${can ? '' : 'disabled'}>납품</button>`}
    </div>`;
}

function mealLine(S: EconSession): string {
  const guests = S.spreadGuests();
  if (!guests.length) return '';
  const strikers = guests.filter((g) => S.strikes.has(g));
  return `<p class="hintline${strikers.length ? ' meal-warn' : ''}">
    마감 턴 밥값 — 식객 ${guests.length}명 × 먹을 것 1장 (지금 ${S.foodCount()}장 보유${
      strikers.length ? ` · ${strikers.map((g) => esc(S.card(g).name_ko)).join('·')} 파업 중` : ''})</p>`;
}

function boardPanel(S: EconSession, V: ViewState): string {
  return `
  <section class="panel">
    <h2>게시판 <small>${S.contracts.filter((c) => c.done).length}/${S.contracts.length} 완납 · 2건 이상이면 넘긴다</small></h2>
    ${careerCard(V)}
    ${S.contracts.map((c) => contractCard(S, c)).join('')}
    ${eventPins(S)}
    ${S.R.contractBoardOn ? '<p class="hintline">미수주 어음은 기한이 지나면 미달로 남는다.</p>' : ''}
    ${mealLine(S)}
  </section>`;
}

/* ── 분실물 게시판 (시세 + 이벤트 핀 2자리) ─────────────────── */

function eventPins(S: EconSession): string {
  if (!S.eventDeck) return '';
  const active = S.eventDeck.activePins(S.turn);
  const notice = S.eventDeck.noticePins(S.turn);
  const pinHtml = [
    ...active.map((p) => `<div class="pin live${p.kind === 'dream' ? ' gold' : ''}">●
      <b>${EVENT_NAMES[p.kind]}</b> — '${esc(tagKo(p.tag))}' ×${p.kind === 'dream' ? S.R.eventDreamMult : S.R.eventMerchantMult}
      <small>${p.kind === 'merchant' ? '오늘만. 시장 행동으로만 응답할 수 있다' : `${p.endsAt - S.turn + 1}턴 남음`}</small></div>`),
    ...notice.map((p) => `<div class="pin">○
      <b>${EVENT_NAMES[p.kind]}</b> — '${esc(tagKo(p.tag))}' <small>${p.startsAt - S.turn}턴 뒤</small></div>`),
  ];
  while (pinHtml.length < 2) pinHtml.push('<div class="pin empty">·<small>빈 핀 자리</small></div>');
  const sd = S.eventDeck.scaleDay;
  return `
    <div class="pins">${pinHtml.slice(0, 2).join('')}</div>
    ${sd ? `<p class="hintline${sd.rewarded ? ' done' : ''}">저울의 날 — 이번 갠 사이 신규 복원 ${Math.min(S.scaleDayProgress, sd.goal)}/${sd.goal}종 출품 ${sd.rewarded ? '· 단서를 받았다' : '→ 단서 1장'}</p>` : ''}`;
}

function demandBoard(S: EconSession): string {
  const tiers = Object.keys(S.R.basePrice);
  const delay = S.guestActive('demand_delay') ? S.R.rumorDelay : 0;
  return `
  <section class="panel">
    <h2>분실물 게시판 <small>수요는 갠 사이 안에서 돌아오지 않는다</small></h2>
    <table class="demand">
      <tr><th>급</th><th>기본가</th><th>남은 수요</th><th>시세</th></tr>
      ${tiers.map((t) => {
        const pool = (S.R.demandPool[t] ?? 0) + delay;
        const sold = S.tierSold[t] ?? 0;
        const left = Math.max(0, pool - sold);
        const over = sold - pool;
        const cur = Math.round((S.R.basePrice[t] ?? 0) * (over >= 0 ? Math.pow(S.R.saturationR, over + 1) : 1));
        const next = Math.round((S.R.basePrice[t] ?? 0) * (over + 1 >= 0 ? Math.pow(S.R.saturationR, over + 2) : 1));
        return `<tr class="${left === 0 ? 'sat' : ''}">
          <td>${t}</td><td>${S.R.basePrice[t]}G</td>
          <td><span class="bar"><i style="width:${pool ? (left / pool) * 100 : 0}%"></i></span> ${left}/${pool}</td>
          <td>${cur}G ${over >= 0 ? `<b class="down">▼ 다음 ${next}G</b>` : left === 1 ? '<b class="down">곧 꺾인다</b>' : ''}</td>
        </tr>`;
      }).join('')}
    </table>
    ${delay ? '<p class="hintline">소문쟁이가 소등을 1칸 늦추고 있다.</p>' : ''}
  </section>`;
}

/* ── 되찾이 가게 (시장 — 턴당 1회) + 조수 ───────────────────── */

function assistantBlock(S: EconSession): string {
  if (S.assistant) {
    return `<div class="assistant out">
      <b>조수</b> — ${DISPATCH_NAMES[S.assistant.dest]}에 가 있다 ·
      <small>⏱ ${Math.max(0, S.assistant.returnTurn - S.turn)}턴 뒤 보따리</small>
    </div>`;
  }
  return `<div class="assistant">
    <button data-act="dispatch-open" ${S.canDispatch() ? '' : 'disabled'}>
      조수 보내기 <small>${S.R.dispatchWage}G · ⏱${S.R.dispatchTurns}턴</small>
    </button>
    <small class="sub">보따리에는 재료만 담겨 온다.</small>
  </div>`;
}

function marketPanel(S: EconSession): string {
  if (!S.marketOpen) {
    return `<section class="panel muted">
      <h2>되찾이 가게 <small>잠김</small></h2>
      <p>처음 되찾은 물건이 생기면 그리워하던 손님이 찾아온다.</p>
      ${assistantBlock(S)}
    </section>`;
  }
  const can = S.canMarket();
  const buyables = S.buyableCards();
  const persons = S.availablePersons();
  return `
  <section class="panel${S.traveling ? ' muted' : ''}">
    <h2>되찾이 가게 <small>${S.traveling ? '길 위 — 닫힘' : '턴당 1회 — 사기 · 팔기 · 단서 · 소개'}</small></h2>
    <div class="buyrow">
      ${buyables.map((id) => `<button class="buy" data-act="buy" data-id="${id}"
          ${can && S.gold >= S.buyCost() ? '' : 'disabled'}>
          ${esc(S.card(id).name_ko)} <small>${S.buyCost()}G</small></button>`).join('')}
    </div>
    <div class="row" style="margin-top:8px">
      <button class="hintbuy" data-act="hint" ${can && S.gold >= S.hintCost() ? '' : 'disabled'}>
        단서 사기 <small>${S.hintCost()}G</small>
      </button>
      ${persons.length ? `<button data-act="person" ${can && S.gold >= S.R.personPrice ? '' : 'disabled'}>
        떠도는 인물 소개받기 <small>${S.R.personPrice}G</small></button>` : ''}
    </div>
    ${S.hints.length ? `<ul class="hints">${S.hints.map((h) => `<li>${esc(h.text)}</li>`).join('')}</ul>` : ''}
    ${assistantBlock(S)}
  </section>`;
}

/* ── 바랜 장부 (도감 — 노출된 실루엣만) ─────────────────────── */

function codexPanel(S: EconSession, V: ViewState): string {
  const found = [...S.codex];
  const silhouettes = S.hypothesisTargets();
  return `
  <section class="panel" id="ledger">
    <h2>바랜 장부 <small>${S.known.size}장 적힘</small>
      <button class="link" data-act="codex">${V.showCodex ? '접기' : '펼치기'}</button>
    </h2>
    ${V.showCodex ? `<div class="codex">
      ${found.map((id) => `<span class="found ${tierClass(S.card(id).tier)}">${esc(S.card(id).name_ko)}</span>`).join('')}
      ${silhouettes.map((r) => `<button class="hole${S.hypotheses.has(r.id) ? ' penned' : ''}"
          data-act="hypo" data-id="${r.id}"
          title="가설 기입 (무료) — 적중하면 단서 1장">?${S.hypotheses.has(r.id) ? '<i>✎</i>' : ''}</button>`).join('')}
    </div>
    ${silhouettes.length ? '<p class="hintline">희미한 자리(?)를 눌러 재료 가설을 미리 적을 수 있다 — 무료, 적중 시 단서 1장.</p>' : ''}`
    : `<div class="codex"><span class="countline">${found.length ? esc(S.card(found[found.length - 1]).name_ko) + ' …' : '아직 비어 있다'}</span>
       ${silhouettes.length ? `<span class="hole still">? ×${silhouettes.length}</span>` : ''}</div>`}
  </section>`;
}

/* ── 오버레이 ───────────────────────────────────────────────── */

function draftOverlay(S: EconSession): string {
  if (S.phase !== 'draft' || !S.draftCandidates) return '';
  return `
  <div class="overlay">
    <div class="sheet">
      <h2>무주물 경매 — 한 장만 고른다</h2>
      <p class="sub">주인 잃은 것들이다. 고르지 않은 것은 흘러간다.${S.guestActive('draft_plus') ? ' (짐꾼이 한 장 더 물어왔다)' : ''}</p>
      <div class="draftrow">
        ${S.draftCandidates.map((id, i) => {
          const c = S.card(id);
          return `<button class="card ${tierClass(c.tier)}" data-act="draft" data-idx="${i}">
            <span class="cname">${esc(c.name_ko)}</span>
            <span class="cmeta">${c.tier} · ${c.slot_cost}자리</span>
            <span class="tags">${c.tags.map((t) => `<i>${esc(tagKo(t))}</i>`).join('')}</span>
          </button>`;
        }).join('')}
      </div>
      ${S.free <= 0 ? '<p class="sub">펼칠 자리가 없다 — 가져오면 더미 위에 얹힌다.</p>' : ''}
      <button class="ghost" data-act="draft" data-idx="-1">전부 포기</button>
    </div>
  </div>`;
}

/** 더미 뒷면 목록 — 파내기 (뒷면 은닉 유지: 계열 태그만 보인다). */
function digOverlay(S: EconSession, V: ViewState): string {
  if (V.digPile === null || V.digPile >= S.piles.length) return '';
  const pile = S.piles[V.digPile];
  const buried = pile.slice(0, -1);
  return `
  <div class="overlay">
    <div class="sheet">
      <h2>더미를 들춘다 <small>파내기는 공짜 — 뒷면은 계열만 보인다</small></h2>
      <p class="sub">맨 위: <b>${esc(S.card(topOf(pile)).name_ko)}</b> · 밑에 ${buried.length}장</p>
      <div class="digrow">
        ${buried.map((id, di) => `<button class="facedown" data-act="dig" data-idx="${di}">
          <span class="fdmark">안개</span>
          <span class="tags">${S.card(id).tags.map((t) => `<i>${esc(tagKo(t))}</i>`).join('')}</span>
          <small>꺼내 펼친다</small>
        </button>`).join('')}
      </div>
      <button class="ghost" data-act="dig-close">덮는다</button>
    </div>
  </div>`;
}

/** 이동 확인 — 탭+확인 (드래그·즉시 이동 없음). */
function moveOverlay(S: EconSession, V: ViewState): string {
  if (V.moveTo === null) return '';
  const rg = S.D.regions[V.moveTo];
  return `
  <div class="overlay">
    <div class="sheet">
      <h2>${esc(rg.name_ko)}(으)로 간다</h2>
      <p>장부를 덮고 짐을 싼다. <b>⏱ ${S.R.moveTurns}턴</b> — 길 위에서 조합은 되지만
        시장과 게시판은 없다. 카드는 전부 지고 간다.</p>
      <div class="row">
        <button class="primary" data-act="move-yes">떠난다</button>
        <button data-act="move-no">머문다</button>
      </div>
    </div>
  </div>`;
}

/** 파견 행선지 3중 1택 (드래프트 문법). */
function dispatchOverlay(S: EconSession, V: ViewState): string {
  if (!V.dispatchOpen) return '';
  const rows: Array<[DispatchDest, string]> = [
    ['explore', '다른 거리의 재료를 물어온다. 어쩌다 사람을 데려오기도 한다.'],
    ['garden', '먹을 것을 길러 온다 — 식객 밥값.'],
    ['gather', '이 거리의 재료를 그러모아 온다.'],
  ];
  return `
  <div class="overlay">
    <div class="sheet">
      <h2>조수를 보낸다 <small>임금 ${S.R.dispatchWage}G · ⏱${S.R.dispatchTurns}턴 뒤 보따리</small></h2>
      <p class="sub">성과는 기다린 시간이 아니라 행선지가 정한다. 보따리에는 재료만 담긴다.</p>
      ${rows.map(([d, desc]) => `<button class="destbtn" data-act="dispatch-go" data-id="${d}">
        <b>${DISPATCH_NAMES[d]}</b><small>${desc}</small></button>`).join('')}
      <button class="ghost" data-act="dispatch-close">보내지 않는다</button>
    </div>
  </div>`;
}

/** 온보딩 3번 — 첫 되찾은 물건에 손님이 찾아온다. 판매 동사를 화면이 먼저 시연한다. */
function buyerOverlay(S: EconSession): string {
  if (S.phase !== 'play' || !S.firstBuyer) return '';
  const c = S.card(S.firstBuyer);
  return `
  <div class="overlay">
    <div class="sheet">
      <h2>손님이 찾아왔다</h2>
      <p>"그 <b>${esc(c.name_ko)}</b>… 안개 전에 우리 집에 있던 겁니다.
        <b>${S.priceOfCard(S.firstBuyer)}G</b>에 삽니다."</p>
      <p class="sub">되찾은 물건은 처음 팔 때 가장 비싸다. 이 거래는 이번 턴 시장 행동을 쓰지 않는다.</p>
      <div class="row">
        <button class="primary" data-act="buyer-yes">판다</button>
        <button data-act="buyer-no">아직 안 판다</button>
      </div>
    </div>
  </div>`;
}

/** 떠도는 인물이 가게 앞에 온다 (식객 — 공급 풀 밖 지급, 플로우 감사 #3). */
function visitorOverlay(S: EconSession): string {
  if (S.phase !== 'play' || !S.pendingVisitor) return '';
  const c = S.card(S.pendingVisitor);
  return `
  <div class="overlay">
    <div class="sheet">
      <h2>가게 앞에 사람이 서 있다</h2>
      <p><b>${esc(c.name_ko)}</b>. 안개가 지운 것은 물건만이 아니다 —
        맞는 물건을 쥐여주면, 잊었던 일이 깨어날지도 모른다.</p>
      <p class="sub">펼침 1자리를 차지한다. 받아들이면 이 갠 사이 동안만 머문다. 식객이 되면 마감 턴마다 먹을 것 1장을 든다.</p>
      <div class="row">
        <button class="primary" data-act="visitor-yes">들인다</button>
        <button data-act="visitor-no">돌려보낸다</button>
      </div>
    </div>
  </div>`;
}

/** 가설 기입 — 바랜 장부의 희미한 자리에 재료 둘을 미리 적는다 (무료). */
function hypoOverlay(S: EconSession, V: ViewState): string {
  if (!V.hypo) return '';
  const mats = S.hypothesisMaterials();
  const pickBtn = (id: string): string => {
    const on = V.hypo!.a === id || V.hypo!.b === id;
    return `<button class="mat${on ? ' sel' : ''}" data-act="hypo-mat" data-id="${id}">${esc(S.card(id).name_ko)}</button>`;
  };
  const ready = V.hypo.a && V.hypo.b;
  return `
  <div class="overlay">
    <div class="sheet wide">
      <h2>가설 기입 <small>무료 · 적중하면 단서 1장, 틀려도 벌은 없다</small></h2>
      <p class="sub">희미한 자리 옆에 연필로 적어 둔다 — "이 둘이었던 것 같은데."</p>
      <div class="matrow">${mats.map(pickBtn).join('')}</div>
      <div class="row">
        <button class="primary" data-act="hypo-write" ${ready ? '' : 'disabled'}>기입한다</button>
        <button data-act="hypo-close">덮는다</button>
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
      <p class="intro-line">안개가 걷혔다. 장부는 절반이 비었다.</p>
      <button class="primary" data-act="start">가게를 연다</button>
    </div>
  </div>`;
}

function settleOverlay(S: EconSession, V: ViewState): string {
  if (S.phase !== 'over' || !S.settlement) return '';
  const s = S.settlement;
  const silhouettes = S.hypothesisTargets().length;
  return `
  <div class="overlay">
    <div class="sheet wide">
      <h2>${s.runFail ? '정산 — 어음 미달' : '정산 — 어음 이행'}</h2>
      <p class="sub">공물 어음 ${s.fulfilled}/${s.contractsTotal} · 자금 ${s.gold}G →
        <b>${s.settle}G</b>${s.runFail ? ' <small>(미달 정산 50%)</small>' : ''}</p>
      <h3>이번 갠 사이에 되찾은 것</h3>
      <div class="codex">
        ${[...S.codex].map((id) => `<span class="found ${tierClass(S.card(id).tier)}">${esc(S.card(id).name_ko)}</span>`).join('')}
        ${silhouettes ? `<span class="hole still">? ×${silhouettes}</span>` : ''}
      </div>
      ${V.reviewDebut ? `<div class="reviewbox debut">${V.reviewDebut.map((l) => `<p>${esc(l)}</p>`).join('')}</div>` : ''}
      ${V.review ? `<div class="reviewbox ${V.review.pass ? 'pass' : 'defer'}">
        <h3>저울질${V.review.wasRetry ? ' (재심)' : ''}</h3>
        <p>${V.review.pass
          ? `저울이 기울었다 — <b>${esc(V.review.gradeName)}</b>이 되었다. 다음 거리가 열립니다.`
          : `저울이 아직 평평하다 — 유예. 두 갠 사이 뒤에 다시 단다.`}</p>
        <p class="sub">신규 복원 ${V.review.achieved}/${V.review.required}종 · C급 ${V.review.tierCAchieved}/${V.review.tierCRequired}종</p>
      </div>` : ''}
      ${V.career && !V.reviewDebut && !V.review && V.career.runsUntil !== null ? `<p class="sub">
        저울질까지 ${V.career.runsUntil}갠 사이 — 장부 ${V.career.newSince}/${V.career.reqCount}${V.career.deferred ? ' (유예 중)' : ''}</p>` : ''}
      <p class="sub reset-notice">안개가 덮는다 — 돈·재고·시세는 두고 간다. 장부와 등급만 챙긴다.</p>
      <div class="row">
        <button class="primary" data-act="again">다음 갠 사이</button>
        ${V.offlineLog ? '<button data-act="copylog">기록 복사</button>' : ''}
      </div>
      ${V.offlineLog ? '<p class="sub"><small>테스트에 참여 중이라면 「기록 복사」를 눌러 나온 내용을 보내 주세요.</small></p>' : ''}
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
    <div class="gold" id="hud-gold"><b>${S.gold}</b>G</div>
    <div class="slots">
      자리 ${S.used}/${S.R.spreadSlots}
      <span class="gauge">${Array.from({ length: S.R.spreadSlots }, (_, i) =>
        `<i class="${i < S.used ? 'on' : ''}"></i>`).join('')}</span>
    </div>
    <button class="primary end" data-act="end">턴 종료</button>
  </div>
  ${regionStrip(S)}
  <div class="cols">
    <div class="col main">
      ${matPanel(S, V)}
      ${marketPanel(S)}
      <section class="panel log">
        <h2>기록</h2>
        <ul>${V.log.slice(-12).reverse().map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      </section>
    </div>
    <div class="col side">
      ${boardPanel(S, V)}
      ${demandBoard(S)}
      ${codexPanel(S, V)}
    </div>
  </div>
  ${confirmBar(S, V)}
  ${V.toast ? `<div class="toast">${esc(V.toast)}</div>` : ''}
  ${draftOverlay(S)}
  ${digOverlay(S, V)}
  ${moveOverlay(S, V)}
  ${dispatchOverlay(S, V)}
  ${buyerOverlay(S)}
  ${visitorOverlay(S)}
  ${hypoOverlay(S, V)}
  ${confirmOverlay(V)}
  ${settleOverlay(S, V)}
  ${introOverlay(V)}`;
}
