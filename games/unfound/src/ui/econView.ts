/**
 * v2.2 슬라이스 화면 그리기 — 문자열 HTML을 만들어 돌려주는 순수 함수들.
 *
 * 아트는 없다. 텍스트와 도형뿐이다 (G3 통과 전 아트 금지).
 * 세계관 A안(안개 장부)의 명사 사전이 여기 산다:
 *   도감→바랜 장부 / 상점→되찾이 가게 / 계약→공물 어음 / 수요 게시판→분실물 게시판 /
 *   공급 드래프트→무주물 경매 / 심사→저울질 / 회기→갠 사이 / 지역→물러난 거리
 * 새 화면은 없다 — 기존 화면에 오브젝트(핀·수주 단추·실루엣·3줄 데뷔)만 더했다.
 */
import type { EconSession } from '../core/econSession.ts';
import type { RunContract } from '../core/econ.ts';
import { EVENT_NAMES } from '../core/econEvents.ts';

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
  selected: number[];
  toast: string | null;
  signal: { pair: string; signal: 'warm' | 'cold'; hint: string | null; detail: string | null } | null;
  log: string[];
  confirm: { i: number; j: number; resultName: string } | null;
  showIntro: boolean;
  showCodex: boolean;
  /** 가설 기입 중 (레시피 id + 고른 재료). */
  hypo: { recipeId: string; a: string | null; b: string | null } | null;
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
  metal: '쇠붙이', person: '사람',
};
export const tagKo = (t: string): string => TAG_KO[t] ?? t;

/* ── 필드 (7칸 슬롯 그리드) ─────────────────────────────────── */

function fieldCard(S: EconSession, V: ViewState, idx: number): string {
  const id = S.field[idx];
  const c = S.card(id);
  const sel = V.selected.includes(idx);
  const person = S.isPersonLike(id);
  const price = person ? null : S.priceOfCard(id);
  const prem = !person && S.premiumOn(id);
  const need = !person && S.neededForContract(id);
  const evtBoost = !person && S.eventDeck && S.eventDeck.multOf(S.turn, c) > 1;
  const guest = S.guestCard(id);
  return `
    <button class="card ${tierClass(c.tier)}${sel ? ' sel' : ''}" style="grid-column: span ${c.slot_cost}"
            data-act="pick" data-idx="${idx}" title="${esc(c.name_ko)} · ${c.tier}급 · ${c.slot_cost}칸">
      <span class="cname">${esc(c.name_ko)}</span>
      <span class="cmeta">${person ? (c.tier === 'G' ? '식객' : '인물') : `${c.tier} · ${c.slot_cost}칸`}</span>
      ${guest?.effect_ko ? `<span class="ceffect">${esc(guest.effect_ko)}</span>` : ''}
      ${price !== null ? `<span class="cprice${evtBoost ? ' evt' : ''}">${price}G${prem ? ' <b class="prem">첫판매</b>' : ''}</span>` : ''}
      ${need ? '<span class="badge need">어음</span>' : ''}
      <span class="tags">${c.tags.map((t) => `<i>${esc(tagKo(t))}</i>`).join('')}</span>
    </button>`;
}

function fieldPanel(S: EconSession, V: ViewState): string {
  const empty = Math.max(0, S.free);
  const holes = Array.from({ length: empty }, () => '<div class="slot-empty"></div>').join('');
  const two = V.selected.length === 2;
  const oneSel = V.selected.length === 1;
  const selId = oneSel ? S.field[V.selected[0]] : null;
  const sellable = Boolean(selId && !S.isPersonLike(selId));
  const selPrice = selId && sellable ? S.priceOfCard(selId) : null;
  const selNext = selId && sellable ? S.nextPriceOfCard(selId) : null;
  const ledgered = two && S.inLedger(V.selected[0], V.selected[1]);
  return `
  <section class="panel field-panel">
    <h2>작업대 <small>${S.used}/${S.R.fieldSlots}칸</small></h2>
    <div class="grid7">
      ${S.field.map((_, i) => fieldCard(S, V, i)).join('')}
      ${holes}
    </div>
    <div class="row actions">
      <button class="primary" data-act="combine" ${two && !ledgered ? '' : 'disabled'}>합치기</button>
      <button data-act="sell" ${oneSel && sellable && S.canMarket() ? '' : 'disabled'}>팔기 ${selPrice !== null ? `(${selPrice}G)` : ''}</button>
      <button data-act="discard" ${oneSel && S.discardLeft > 0 ? '' : 'disabled'}>버리기 (${S.discardLeft})</button>
      <button data-act="clear" ${V.selected.length ? '' : 'disabled'}>선택 해제</button>
    </div>
    ${selPrice !== null && selNext !== null && selNext < selPrice
      ? `<p class="hintline foretell">이번에 팔면 ${selPrice}G → 다음엔 ${selNext}G</p>` : ''}
    <p class="hintline">
      이번 턴 남은 실험 <b>${S.unknownLeft}</b>회 ·
      시장 행동 <b>${S.marketActionUsed ? '사용함' : S.marketOpen ? '가능' : '잠김'}</b>
      ${two && S.wasTried(V.selected[0], V.selected[1]) ? ' · <b>이번 턴에 이미 해본 조합</b>' : ''}
      ${ledgered ? ' · <b>장부에 이미 적어 두었다</b>' : ''}
    </p>
    ${V.signal ? `<p class="signal ${V.signal.signal}">${V.signal.signal === 'warm'
      ? '부글거리다… 멎었다.'
      : '아무 일도 없었다.'}${V.signal.hint ? ` <span class="fadein">(${esc(V.signal.hint)})</span>` : ''}${
        V.signal.detail ? ` <span class="fadein slow">(${esc(V.signal.detail)})</span>` : ''}
      <small>${esc(V.signal.pair)}</small></p>` : ''}
  </section>`;
}

/* ── 공물 어음 게시판 (인장 + 수주) ─────────────────────────── */

function contractCard(S: EconSession, c: RunContract): string {
  const left = c.deadline - S.turn;
  const state = c.done ? 'done' : c.failed ? 'failed' : !c.claimed ? 'posted' : left <= 2 ? 'urgent' : '';
  const can = c.claimed && !c.done && !c.failed && S.turn <= c.deadline && S.deliverableIndex(c) >= 0;
  const canClaim = !c.claimed && !c.done && !c.failed && S.turn <= c.deadline && S.R.contractBoardOn;
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

function contractPanel(S: EconSession): string {
  return `
  <section class="panel">
    <h2>공물 어음 <small>${S.contracts.filter((c) => c.done).length}/${S.contracts.length} 완납 · 2건 이상이면 넘긴다</small></h2>
    ${S.contracts.map((c) => contractCard(S, c)).join('')}
    ${S.R.contractBoardOn ? '<p class="hintline">미수주 어음은 기한이 지나면 미달로 남는다.</p>' : ''}
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
  return `
  <section class="panel">
    <h2>분실물 게시판 <small>수요는 갠 사이 안에서 돌아오지 않는다</small></h2>
    ${eventPins(S)}
    <table class="demand">
      <tr><th>급</th><th>기본가</th><th>남은 수요</th><th>시세</th></tr>
      ${tiers.map((t) => {
        const pool = S.R.demandPool[t] ?? 0;
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
  </section>`;
}

/* ── 되찾이 가게 (시장 — 턴당 1회) ──────────────────────────── */

function marketPanel(S: EconSession): string {
  if (!S.marketOpen) {
    return `<section class="panel muted">
      <h2>되찾이 가게 <small>잠김</small></h2>
      <p>처음 되찾은 물건이 생기면 그리워하던 손님이 찾아온다.</p>
    </section>`;
  }
  const can = S.canMarket();
  const buyables = S.buyableCards();
  return `
  <section class="panel">
    <h2>되찾이 가게 <small>턴당 1회 — 사기 · 팔기 · 단서, 셋 중 하나</small></h2>
    <div class="buyrow">
      ${buyables.map((id) => `<button class="buy" data-act="buy" data-id="${id}"
          ${can && S.gold >= S.buyCost() && S.free >= S.card(id).slot_cost ? '' : 'disabled'}>
          ${esc(S.card(id).name_ko)} <small>${S.buyCost()}G</small></button>`).join('')}
    </div>
    <button class="hintbuy" data-act="hint" ${can && S.gold >= S.hintCost() ? '' : 'disabled'}>
      단서 사기 <small>${S.hintCost()}G · 시장 행동 1회</small>
    </button>
    ${S.hints.length ? `<ul class="hints">${S.hints.map((h) => `<li>${esc(h.text)}</li>`).join('')}</ul>` : ''}
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
      <p class="sub">주인 잃은 것들이다. 고르지 않은 두 장은 흘러간다.</p>
      <div class="draftrow">
        ${S.draftCandidates.map((id, i) => {
          const c = S.card(id);
          return `<button class="card ${tierClass(c.tier)}" data-act="draft" data-idx="${i}"
            ${S.free >= c.slot_cost ? '' : 'disabled'}>
            <span class="cname">${esc(c.name_ko)}</span>
            <span class="cmeta">${c.tier} · ${c.slot_cost}칸</span>
            <span class="tags">${c.tags.map((t) => `<i>${esc(tagKo(t))}</i>`).join('')}</span>
          </button>`;
        }).join('')}
      </div>
      ${S.draftCandidates.every((id) => S.free < S.card(id).slot_cost)
        ? '<p class="sub">작업대에 자리가 없다. 이번 경매는 통째로 넘긴다.</p>' : ''}
      <button class="ghost" data-act="draft" data-idx="-1">전부 포기</button>
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

/** 떠도는 인물이 가게 앞에 온다 (식객 맛보기 — 공급 풀 밖 지급, 플로우 감사 #3). */
function visitorOverlay(S: EconSession): string {
  if (S.phase !== 'play' || !S.pendingVisitor) return '';
  const c = S.card(S.pendingVisitor);
  const room = S.free >= c.slot_cost;
  return `
  <div class="overlay">
    <div class="sheet">
      <h2>가게 앞에 사람이 서 있다</h2>
      <p><b>${esc(c.name_ko)}</b>. 안개가 지운 것은 물건만이 아니다 —
        맞는 물건을 쥐여주면, 잊었던 일이 깨어날지도 모른다.</p>
      <p class="sub">작업대 1칸을 차지한다. 받아들이면 이 갠 사이 동안만 머문다.</p>
      <div class="row">
        <button class="primary" data-act="visitor-yes" ${room ? '' : 'disabled'}>들인다${room ? '' : ' (칸 부족)'}</button>
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
      칸 ${S.used}/${S.R.fieldSlots}
      <span class="gauge">${Array.from({ length: S.R.fieldSlots }, (_, i) =>
        `<i class="${i < S.used ? 'on' : ''}"></i>`).join('')}</span>
    </div>
    ${V.career ? `<div class="career" title="승급 심사 「저울질」">
      <b>${esc(V.career.gradeName)}</b>
      ${V.career.runsUntil === null ? '<small>전당 기록</small>'
        : `<small>저울질까지 ${V.career.runsUntil}갠 사이 · 장부 ${V.career.newSince}/${V.career.reqCount}${V.career.deferred ? ' · 유예' : ''}</small>`}
    </div>` : ''}
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
  ${visitorOverlay(S)}
  ${hypoOverlay(S, V)}
  ${confirmOverlay(V)}
  ${settleOverlay(S, V)}
  ${introOverlay(V)}`;
}
