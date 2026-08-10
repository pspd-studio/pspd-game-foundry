/**
 * UNFOUND v2.2 수직 슬라이스 — 진입점.
 *
 * 하는 일은 넷뿐이다: 코어(EconSession)를 만들고, 클릭을 코어 동작으로 옮기고,
 * 회기 사이의 장기 시계(저울질 — 세션 내 변수, localStorage 금지)를 들고, 다시 그린다.
 * 규칙 판단은 한 줄도 여기 없다 — 있으면 시뮬과 사람이 다른 게임을 하게 된다.
 */
import './econ.css';
import { DATA } from '../data/browser.ts';
import contractsJson from '../../data/contracts.json';
import guestsJson from '../../data/guests.json';
import { EconSession, type EconData, type GuestsFile, type PlayEvent } from '../core/econSession.ts';
import {
  GRADE_NAMES, endRunCareer, newCareer, readEconRules, reviewRequirement, runsUntilReview,
  type CareerState, type ContractsFile, type EconRules,
} from '../core/econ.ts';
import { render, tagKo, type CareerHud, type ViewState } from './econView.ts';
import { createPlayLogger } from './playlog.ts';
import { attachRemote, remoteEnabled } from './remote.ts';
import { fxFail, fxFirstSale, fxSuccess, fxSuspense, skipFx } from './fx.ts';

const D: EconData = Object.assign({}, DATA, { contracts: contractsJson as unknown as ContractsFile });
const GUESTS = guestsJson as unknown as GuestsFile;
const R0: EconRules = readEconRules(DATA.rules);

const app = document.getElementById('app')!;
const foot = document.getElementById('foot')!;
const logger = createPlayLogger();
attachRemote(logger);

/** 판매 성사 플레이버 — 손님의 "아… 이거였구나" 계열 (세계관 A안, 5~8종). */
const SALE_FLAVOR = [
  '아… 이거였구나.',
  '이 냄새, 어릴 때 맡아 본 것 같은데.',
  '이걸 다시 볼 줄은 몰랐네.',
  '잃어버린 줄도 몰랐던 물건인데.',
  '그래, 이런 모양이었지. 이름만 안 떠올랐어.',
  '할머니 집 선반에 이게 있었어.',
  '장부에서만 보던 걸 실물로 보네.',
];
const flavor = (): string => SALE_FLAVOR[Math.floor(Math.random() * SALE_FLAVOR.length)];

let S: EconSession;
let carry: string[] = [];
let runIndex = 0;
/** 장기 시계 — 세션(탭) 안에서만 산다. 저장하지 않는다 (SSOT: 브라우저 저장 없음). */
const career: CareerState = newCareer(R0);
let sent = 0;
let busy = false; // 연출 중 입력 잠금 (탭은 스킵으로만 동작)

const V: ViewState = {
  selected: [], toast: null, signal: null, log: [], confirm: null,
  showIntro: true, showCodex: false, hypo: null, offlineLog: !remoteEnabled(),
  career: null, review: null, reviewDebut: null,
};

function careerHud(): CareerHud | null {
  // 첫 판(1회기)은 완전 은닉 — 첫 정산에서 3줄로 데뷔한다 (SSOT 장기 시계).
  if (!R0.reviewOn || runIndex < 2) return null;
  const req = reviewRequirement(R0, career);
  return {
    runIndex,
    gradeName: GRADE_NAMES[career.grade],
    runsUntil: runsUntilReview(career),
    reqCount: req.count, reqTierC: req.tierC,
    newSince: career.newSinceReview, cNewSince: career.cNewSinceReview,
    deferred: career.deferred,
  };
}

function newRun(): void {
  runIndex++;
  const seed = (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
  S = new EconSession(D, seed, { carryKnown: carry, runIndex, guests: GUESTS });
  V.selected = []; V.signal = null; V.confirm = null; V.hypo = null; V.log = [];
  V.review = null; V.reviewDebut = null;
  runSettled = false;
  V.career = careerHud();
  V.log.push(`${S.turn}턴 — 작업대에 ${S.field.length}장.`);
  sent = 0;
  drain();
  draw();
}

/** 코어가 쌓아 둔 이벤트를 로거로 넘기고, 몇 가지는 기록 줄로도 옮긴다 (코어는 로거를 모른다). */
function drain(): void {
  for (; sent < S.events.length; sent++) {
    const e = S.events[sent];
    logger.push(e);
    narrate(e);
  }
}

function narrate(e: PlayEvent): void {
  if (e.t === 'event_pin') {
    const name = e.kind === 'dream' ? '같은 꿈 소동' : '바깥 장수';
    V.log.push(`게시판에 회색 핀 — ${name}, '${tagKo(e.tag)}' 계열. ${e.starts_at - e.turn}턴 뒤.`);
  } else if (e.t === 'scale_day') {
    V.log.push(`저울의 날 공고 — 이번 갠 사이 신규 복원 ${e.goal}종 출품이면 단서 1장.`);
  } else if (e.t === 'scale_day_reward') {
    V.log.push('저울의 날 — 출품을 채웠다. 단서 1장을 받았다.');
  } else if (e.t === 'hint' && e.source === 'appraiser') {
    V.log.push('감정사가 지나가듯 말했다 — 단서 1장.');
  } else if (e.t === 'hint' && e.source === 'hypothesis') {
    V.log.push('가설이 맞았다 — 단서 1장.');
  }
}

function say(msg: string): void {
  V.log.push(msg);
  V.toast = msg;
}

function name(id: string): string { return S.card(id).name_ko; }

function draw(): void {
  V.career = S.phase === 'over' ? V.career : careerHud();
  app.innerHTML = render(S, V);
  foot.textContent = remoteEnabled()
    ? '플레이 기록이 익명으로 수집됩니다 (개인정보 없음).'
    : '로컬 플레이 — 기록은 전송되지 않습니다.';
}

/** 새 계열(태그)의 첫 등재인가 — 성공 연출 금색 판정. */
function isNewFamily(resultId: string): boolean {
  const tags = new Set(S.card(resultId).tags);
  for (const id of S.codex) {
    if (id === resultId) continue;
    for (const t of S.card(id).tags) tags.delete(t);
  }
  return tags.size > 0;
}

let runSettled = false;

/** 정산 순간 — 장기 시계에 회기를 적립하고, 때가 되면 저울질을 연다. 런당 한 번만. */
function onRunOver(): void {
  if (!R0.reviewOn || runSettled) return;
  runSettled = true;
  const nd = S.newDiscoveries();
  const res = endRunCareer(R0, career, nd.total, nd.tierC);
  if (res.held) {
    logger.push({
      t: 'review', turn: S.turn, pass: res.pass, was_retry: res.wasRetry,
      required: res.required, achieved: res.achieved, grade: res.grade,
    } as PlayEvent);
  }
  // 정산 화면의 장기 시계 줄은 심사 반영 후 상태로 (첫 판은 데뷔 3줄이 대신한다)
  if (runIndex >= 2) {
    const req = reviewRequirement(R0, career);
    V.career = {
      runIndex, gradeName: GRADE_NAMES[career.grade], runsUntil: runsUntilReview(career),
      reqCount: req.count, reqTierC: req.tierC,
      newSince: career.newSinceReview, cNewSince: career.cNewSinceReview, deferred: career.deferred,
    };
  }
  if (res.held) {
    V.review = {
      pass: res.pass, wasRetry: res.wasRetry, required: res.required, achieved: res.achieved,
      tierCRequired: res.tierCRequired, tierCAchieved: res.tierCAchieved,
      gradeName: GRADE_NAMES[res.grade],
    };
  } else if (runIndex === 1) {
    // 3줄 데뷔 — 첫 정산은 "저울질까지 1갠 사이" (심야 개정: 오프바이원 정정)
    const req = reviewRequirement(R0, career);
    const until = runsUntilReview(career);
    V.reviewDebut = [
      `저울질까지 ${until ?? '-'}갠 사이 — 현재: ${GRADE_NAMES[career.grade]}`,
      `신규 복원 ${career.newSinceReview}/${req.count}`,
      `요구: C급 ${req.tierC}종`,
    ];
  }
}

/* ── 동작 ──────────────────────────────────────────────────── */

async function doCombine(i: number, j: number): Promise<void> {
  const nameA = name(S.field[i]);
  const nameB = name(S.field[j]);
  const r = S.combine(i, j);
  drain();
  V.selected = [];
  if (r.ok || r.reason === 'no_recipe') {
    busy = true;
    await fxSuspense(nameA, nameB); // ① 서스펜스 홀드 + S1 (탭=스킵)
    busy = false;
  }
  if (r.ok) {
    V.signal = null;
    say(r.firstTime ? `발견 — ${r.result.name_ko}!` : `${r.result.name_ko} 완성.`);
    draw();
    busy = true;
    await fxSuccess(r.result.name_ko, { gold: isNewFamily(r.result.id), firstTime: r.firstTime }); // ②
    busy = false;
    drain();
    draw();
    return;
  }
  if (r.reason === 'no_recipe') {
    const hintText = r.hint
      ? (r.signal === 'warm'
        ? `'${tagKo(r.hint.ta)}'와 '${tagKo(r.hint.tb)}'는 만나는 계열이다 — 이 둘만 아니었다`
        : `'${tagKo(r.hint.ta)}'와 '${tagKo(r.hint.tb)}'는 애초에 잘 안 섞인다`)
      : null;
    const detailText = r.detail
      ? `야경꾼: 그보다 '${tagKo(r.detail.ta)}'와 '${tagKo(r.detail.tb)}' 쪽이 끌린다`
      : null;
    V.signal = { pair: `${nameA} + ${nameB}`, signal: r.signal, hint: hintText, detail: detailText };
    V.toast = null;
    if (r.exposed) V.log.push('장부에 희미한 자리가 하나 드러났다.');
    fxFail(); // ③ 흔들림 (문구 타자기·힌트 페이드는 CSS)
  } else if (r.reason === 'ledger') {
    say('장부에 이미 적어 두었다 — 그 조합은 아니었다.');
    logger.deadClick('combine_ledger', S.turn);
  } else if (r.reason === 'unique_fail') {
    say(`${r.result.name_ko} 조합이 어그러졌다. 재료는 남았다.`);
  } else if (r.reason === 'cap') {
    say('등유가 다 됐다 — 이번 턴 실험은 여기까지다.');
    logger.deadClick('combine_cap', S.turn);
  } else if (r.reason === 'no_slot') {
    say('작업대가 좁다. 팔거나 버리고 다시.');
    logger.deadClick('combine_no_slot', S.turn);
  }
  draw();
}

function onAction(act: string, el: HTMLElement): void {
  V.toast = null;
  const idx = Number(el.dataset.idx ?? '-1');
  const id = el.dataset.id ?? '';

  switch (act) {
    case 'start':
      V.showIntro = false;
      break;

    case 'pick': {
      if (S.phase !== 'play') return;
      const at = V.selected.indexOf(idx);
      if (at >= 0) V.selected.splice(at, 1);
      else if (V.selected.length < 2) V.selected.push(idx);
      else V.selected = [V.selected[1], idx];
      V.signal = null;
      break;
    }

    case 'clear':
      V.selected = [];
      break;

    case 'combine': {
      if (V.selected.length !== 2) return;
      const [i, j] = V.selected;
      const risky = S.isRiskyPair(i, j);
      if (risky) { V.confirm = { i, j, resultName: risky.name_ko }; break; }
      void doCombine(i, j);
      return;
    }

    case 'confirm-yes': {
      const c = V.confirm!;
      V.confirm = null;
      void doCombine(c.i, c.j);
      return;
    }

    case 'confirm-no':
      V.confirm = null;
      break;

    case 'buyer-yes': {
      const target = S.firstBuyer!;
      const tier = S.card(target).tier;
      const base = S.R.basePrice[tier] ?? 2;
      const mult = S.R.firstPremium[tier] ?? 1;
      const p = S.takeFirstBuyer();
      if (p === null) { say('손님은 그냥 갔다.'); break; }
      say(`${name(target)}을(를) ${p}G에 팔았다.`);
      drain();
      draw();
      busy = true;
      void fxFirstSale(flavor(), base, p, p > base ? `첫 발견 프리미엄 ×${mult}` : null) // ④
        .then(() => { busy = false; });
      return;
    }

    case 'buyer-no':
      S.declineFirstBuyer();
      say('손님을 돌려보냈다.');
      break;

    case 'visitor-yes': {
      const who = S.pendingVisitor!;
      if (!S.acceptVisitor()) { say('작업대에 자리가 없다.'); break; }
      say(`${name(who)}을(를) 들였다. 맞는 물건을 쥐여줘 보자.`);
      break;
    }

    case 'visitor-no': {
      const who = S.pendingVisitor!;
      S.declineVisitor();
      say(`${name(who)}은(는) 안개 쪽으로 돌아갔다.`);
      break;
    }

    case 'sell': {
      if (V.selected.length !== 1) return;
      const si = V.selected[0];
      const sid = S.field[si];
      const warn = S.neededForContract(sid);
      const p = S.priceOfCard(sid);
      if (!S.sell(si)) { logger.deadClick('sell', S.turn); say('지금은 팔 수 없다.'); break; }
      V.selected = [];
      const e = S.events[S.events.length - 1];
      const toMerchant = e.t === 'sell' && e.to_merchant;
      say(`손님: "${flavor()}" — ${name(sid)} ${p}G.${toMerchant ? ' (바깥 장수가 사 갔다)' : ''}${warn ? ' (어음에 필요한 물건이었다)' : ''}`);
      break;
    }

    case 'buy':
      if (!S.buy(id)) { logger.deadClick('buy', S.turn); say('지금은 살 수 없다.'); break; }
      say(`${name(id)}을(를) 사 왔다.`);
      break;

    case 'hint': {
      const h = S.buyHint();
      if (!h) { logger.deadClick('hint', S.turn); say('살 수 있는 단서가 없다.'); break; }
      say(`단서 — ${h.text}`);
      break;
    }

    case 'claim':
      if (!S.claim(id)) { logger.deadClick('claim', S.turn); break; }
      say('어음을 수주했다. 게시판에는 새 어음이 붙었다.');
      break;

    case 'deliver':
      if (!S.deliver(id)) { logger.deadClick('deliver', S.turn); break; }
      say('어음에 납품했다.');
      break;

    case 'discard': {
      if (V.selected.length !== 1) return;
      const di = V.selected[0];
      const did = S.field[di];
      if (!S.discard(di)) { logger.deadClick('discard', S.turn); break; }
      V.selected = [];
      say(S.isPersonLike(did) ? `${name(did)}이(가) 떠났다.` : `${name(did)}을(를) 버렸다.`);
      break;
    }

    case 'draft': {
      const before = S.turn;
      if (!S.takeDraft(idx)) { logger.deadClick('draft', S.turn); say('칸이 모자란다.'); break; }
      if (idx >= 0) say(`${before}턴 — 경매에서 한 장 건졌다.`);
      break;
    }

    case 'end': {
      const wasOver = S.phase === 'over';
      S.endTurn();
      V.selected = []; V.signal = null;
      if (!wasOver && S.phase === 'over') onRunOver(); // 정산 후 재클릭에 심사가 중복 진행되면 안 된다
      else if (!wasOver) V.log.push(`${S.turn}턴 시작.`);
      break;
    }

    case 'codex':
      V.showCodex = !V.showCodex;
      break;

    case 'hypo':
      V.hypo = { recipeId: id, a: null, b: null };
      break;

    case 'hypo-mat': {
      if (!V.hypo) return;
      if (V.hypo.a === id) V.hypo.a = null;
      else if (V.hypo.b === id) V.hypo.b = null;
      else if (!V.hypo.a) V.hypo.a = id;
      else if (!V.hypo.b) V.hypo.b = id;
      else V.hypo.b = id;
      break;
    }

    case 'hypo-write': {
      if (!V.hypo?.a || !V.hypo.b) return;
      const ok = S.writeHypothesis(V.hypo.recipeId, V.hypo.a, V.hypo.b);
      V.hypo = null;
      say(ok ? '연필로 적어 두었다 — 맞으면 단서 1장.' : '지금은 적을 수 없다.');
      if (!ok) logger.deadClick('hypothesis', S.turn);
      break;
    }

    case 'hypo-close':
      V.hypo = null;
      break;

    case 'copylog': {
      // 로그 서버가 없을 때의 우회로 — 테스터가 요약을 복사해 보내면 지표는 그대로 나온다.
      const text = JSON.stringify(logger.summary());
      void navigator.clipboard?.writeText(text)
        .then(() => { V.toast = '기록을 복사했습니다. 붙여넣어 보내 주세요.'; draw(); })
        .catch(() => { window.prompt('아래 내용을 복사해 보내 주세요', text); });
      break;
    }

    case 'again':
      carry = S.carryKeys();
      newRun();
      return;
  }

  drain();
  draw();
}

app.addEventListener('click', (ev) => {
  if (skipFx()) return; // 연출 중 탭 = 스킵
  if (busy) return;
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el || el.hasAttribute('disabled')) return;
  onAction(el.dataset.act!, el);
});
document.getElementById('fx')?.addEventListener('click', () => { skipFx(); });

newRun();
