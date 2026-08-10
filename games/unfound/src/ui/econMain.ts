/**
 * UNFOUND v2.1 수직 슬라이스 — 진입점.
 *
 * 하는 일은 셋뿐이다: 코어(EconSession)를 만들고, 클릭을 코어 동작으로 옮기고, 다시 그린다.
 * 규칙 판단은 한 줄도 여기 없다 — 있으면 시뮬과 사람이 다른 게임을 하게 된다.
 */
import './econ.css';
import { DATA } from '../data/browser.ts';
import contractsJson from '../../data/contracts.json';
import { EconSession, type EconData } from '../core/econSession.ts';
import type { ContractsFile } from '../core/econ.ts';
import { render, type ViewState } from './econView.ts';
import { createPlayLogger } from './playlog.ts';
import { attachRemote, remoteEnabled } from './remote.ts';

const D: EconData = Object.assign({}, DATA, { contracts: contractsJson as unknown as ContractsFile });

const app = document.getElementById('app')!;
const foot = document.getElementById('foot')!;
const logger = createPlayLogger();
attachRemote(logger);

let S: EconSession;
let carry: string[] = [];
let sent = 0;
const V: ViewState = {
  selected: [], toast: null, signal: null, log: [], confirm: null,
  showIntro: true, showCodex: false, offlineLog: !remoteEnabled(),
};

function newRun(): void {
  const seed = (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
  S = new EconSession(D, seed, { carryKnown: carry });
  V.selected = []; V.signal = null; V.confirm = null; V.log = [];
  V.log.push(`${S.turn}턴 — 작업대에 ${S.field.length}장.`);
  sent = 0;
  drain();
  draw();
}

/** 코어가 쌓아 둔 이벤트를 로거로 넘긴다 (코어는 로거를 모른다). */
function drain(): void {
  for (; sent < S.events.length; sent++) logger.push(S.events[sent]);
}

function say(msg: string): void {
  V.log.push(msg);
  V.toast = msg;
}

function name(id: string): string { return S.card(id).name_ko; }

function draw(): void {
  app.innerHTML = render(S, V);
  foot.textContent = remoteEnabled()
    ? '플레이 기록이 익명으로 수집됩니다 (개인정보 없음).'
    : '로컬 플레이 — 기록은 전송되지 않습니다.';
}

/* ── 동작 ──────────────────────────────────────────────────── */

function doCombine(i: number, j: number): void {
  const r = S.combine(i, j);
  drain();
  V.selected = [];
  if (r.ok) {
    V.signal = null;
    say(r.firstTime ? `발견 — ${r.result.name_ko}!` : `${r.result.name_ko} 완성.`);
  } else if (r.reason === 'no_recipe') {
    V.signal = { pair: `${name(S.field[i])} + ${name(S.field[j])}`, signal: r.signal };
    V.toast = null;
  } else if (r.reason === 'unique_fail') {
    say(`${r.result.name_ko} 조합이 어그러졌다. 재료는 남았다.`);
  } else if (r.reason === 'cap') {
    say('이번 턴 실험은 여기까지다.');
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
      doCombine(i, j);
      return;
    }

    case 'confirm-yes': {
      const c = V.confirm!;
      V.confirm = null;
      doCombine(c.i, c.j);
      return;
    }

    case 'confirm-no':
      V.confirm = null;
      break;

    case 'buyer-yes': {
      const target = S.firstBuyer!;
      const p = S.takeFirstBuyer();
      say(p === null ? '구매자는 그냥 갔다.' : `${name(target)}을(를) ${p}G에 팔았다.`);
      break;
    }

    case 'buyer-no':
      S.declineFirstBuyer();
      say('구매자를 돌려보냈다.');
      break;

    case 'sell': {
      if (V.selected.length !== 1) return;
      const si = V.selected[0];
      const sid = S.field[si];
      const warn = S.neededForContract(sid);
      const p = S.priceOfCard(sid);
      if (!S.sell(si)) { logger.deadClick('sell', S.turn); say('지금은 팔 수 없다.'); break; }
      V.selected = [];
      say(`${name(sid)} ${p}G에 팔았다.${warn ? ' (계약에 필요한 물건이었다)' : ''}`);
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

    case 'deliver':
      if (!S.deliver(id)) { logger.deadClick('deliver', S.turn); break; }
      say('계약에 납품했다.');
      break;

    case 'discard': {
      if (V.selected.length !== 1) return;
      const di = V.selected[0];
      const did = S.field[di];
      if (!S.discard(di)) { logger.deadClick('discard', S.turn); break; }
      V.selected = [];
      say(`${name(did)}을(를) 버렸다.`);
      break;
    }

    case 'draft': {
      const before = S.turn;
      if (!S.takeDraft(idx)) { logger.deadClick('draft', S.turn); say('칸이 모자란다.'); break; }
      if (idx >= 0) say(`${before}턴 — 공급에서 한 장 골랐다.`);
      break;
    }

    case 'end':
      S.endTurn();
      V.selected = []; V.signal = null;
      if (S.phase !== 'over') V.log.push(`${S.turn}턴 시작.`);
      break;

    case 'codex':
      V.showCodex = !V.showCodex;
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
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el || el.hasAttribute('disabled')) return;
  onAction(el.dataset.act!, el);
});

newRun();
