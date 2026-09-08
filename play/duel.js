// 경기 모드 (봇 대전) — main.swift 듀얼 로직 포팅 (H6 2단계)
// 판정·비거리는 엔진(rules.js), 진행·봇·주자·스탯은 여기.
// PvP(pvp.js)는 이 파일의 훅(d.pvp · d.pvpSend · myBat)으로 붙는다 — 판정 코드는 하나.
import { DIFFICULTY, judge, distanceOf } from './rules.js';

export const DUEL_LEVELS = {
  // rawValue(저장값)는 한국어 고정 — 맥 UserDefaults 와 같은 규칙
  '보통':   { label: (L) => L('보통', 'Normal'), fastFlight: 520, breakFlight: 700,
              fastReveal: 55, breakReveal: 72, core: 'NORMAL', goodWindow: 50,
              fastSpeedBase: 142, breakSpeedBase: 119, botEyeBonus: 0.0, botChaseProb: 0.16 },
  '어려움': { label: (L) => L('어려움', 'Hard'), fastFlight: 430, breakFlight: 590,
              fastReveal: 66, breakReveal: 80, core: 'HARD', goodWindow: 42,
              fastSpeedBase: 149, breakSpeedBase: 125, botEyeBonus: 0.06, botChaseProb: 0.11 },
  '지옥':   { label: (L) => L('지옥', 'Hell'), fastFlight: 360, breakFlight: 500,
              fastReveal: 76, breakReveal: 88, core: 'HARD', goodWindow: 34,
              fastSpeedBase: 156, breakSpeedBase: 131, botEyeBonus: 0.12, botChaseProb: 0.07 },
};
export const BOT_SIGMA = 58;
export const HALF_CHANGE_MS = 1400;

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
// 도착 위치 흩뿌리기 — 높은 볼은 겨냥선 위로 못 간다 (D17: 공은 위로 안 꺾인다)
function spread(fast, strike, high) {
  if (strike) return { inOff: randInt(-14, 14), miss: 0 };
  const cap = high ? (fast ? 8 : 18) : 14;
  return { inOff: 0, miss: randInt(3, cap) };
}
const emptyStats = () => ({
  h1: 0, h2: 0, h3: 0, hr: 0, so: 0, bb: 0,
  eyeGood: 0, eyeTotal: 0, offSum: 0, offN: 0,
  lob: 0, rispHit: 0, rispAB: 0, gwDesc: '',
});
export const statHits = (t) => t.h1 + t.h2 + t.h3 + t.hr;
export const statEyePct = (t) => (t.eyeTotal > 0 ? Math.round((t.eyeGood / t.eyeTotal) * 100) : 0);
export const statAvgOff = (t) => (t.offN > 0 ? Math.round(t.offSum / t.offN) : 0);

// 통산 기록 (나의 기록 화면용 — localStorage)
const lifeAdd = (k, v) => localStorage.setItem(k, +(localStorage.getItem(k) ?? 0) + v);

export function makeDuel(game, L, KOref) {
  const lvl = () => DUEL_LEVELS[game.duelLevel];
  const dCfg = () => DIFFICULTY[lvl().core];
  const d = game; // 게임 상태를 공유한다 (main.swift Game 과 같은 단일 상태)

  function beginDuel(now) {
    d.mode = 'duel'; d.screen = 'match';
    d.dInnT = d.matchInnings;
    d.dB = 0; d.dS = 0; d.dOuts = 0; d.dInn = 1;
    d.dBases = [false, false, false];
    d.myStats = emptyStats(); d.oppStats = emptyStats();
    d.dPitchNo = 0; d.dOver = false;
    d.dBallsSeen = 0; d.dChases = 0;
    d.halfTop = true; d.myInnRuns = []; d.botInnRuns = []; d.curHalfRuns = 0;
    d.botAct = null; d.awaitingPitchChoice = false;
    d.paused = false;
    d.duelEndedAt = 0;
    d.halfChangeAt = 0; d.halfChangePending = false;
    d.rematchMine = false; d.rematchOpp = false;
    d.onlineStatus = '';
    d.fly = null; d.judgeText = '';
    duelNextPitch(now);
  }
  // 이번 반이닝에 내가 타자인가 — 봇전은 초=나, PvP 는 초=호스트
  const myBat = () => (d.pvp ? d.halfTop === d.isHost : d.halfTop);
  const myTotal = () => d.myInnRuns.reduce((a, b) => a + b, 0) + (myBat() ? d.curHalfRuns : 0);
  const botTotal = () => d.botInnRuns.reduce((a, b) => a + b, 0) + (!myBat() ? d.curHalfRuns : 0);
  const bump = (mine, f) => f(mine ? d.myStats : d.oppStats);
  // 선공(초)·후공(말) 팀 총점 — 봇전은 내가 선공, PvP 는 호스트가 선공
  const topTotal = () => (d.pvp && !d.isHost ? botTotal() : myTotal());
  const bottomTotal = () => (d.pvp && !d.isHost ? myTotal() : botTotal());

  function duelNextPitch(now) {
    if (d.pvp) {                            // 상대 이벤트 대기 — 타이머 없음
      d.dp = null; d.botAct = null; d.swung = false;
      d.phase = 'select'; d.selUntil = Infinity;
      if (myBat()) {
        d.awaitingPitchChoice = false;
        d.judgeText = L(`${d.oppNick} 투수가 구종 선택 중…`, `${d.oppNick} is choosing a pitch…`);
      } else {
        d.awaitingPitchChoice = true;
        d.judgeText = L('1 직구·스트  2 직구·볼  3 변화구·스트  4 변화구·볼',
                        '1 fast·strike  2 fast·ball  3 break·strike  4 break·ball');
      }
      return;
    }
    if (!d.halfTop) {                       // 내 수비 — 구종 선택 대기 (1~4)
      d.dp = null; d.botAct = null;
      d.awaitingPitchChoice = true;
      d.phase = 'select'; d.selUntil = Infinity;
      d.judgeText = L('1 직구·스트  2 직구·볼  3 변화구·스트  4 변화구·볼',
                      '1 fast·strike  2 fast·ball  3 break·strike  4 break·ball');
      d.swung = false;
      return;
    }
    // 봇 선택 — 카운트 가중 + 추격률 학습
    let w = [0.32, 0.16, 0.24, 0.28];       // FS FB CS CB
    if (d.dB >= 3) w = [0.46, 0.06, 0.36, 0.12];
    else if (d.dS >= 2) w = [0.16, 0.22, 0.14, 0.48];
    const chase = d.dBallsSeen > 0 ? d.dChases / d.dBallsSeen : 0.3;
    const sh = Math.max(-0.12, Math.min(0.3, (chase - 0.3) * 0.5));
    w[1] += sh * 0.4; w[3] += sh * 0.6; w[0] -= sh * 0.5; w[2] -= sh * 0.5;
    w = w.map((x) => Math.max(0.04, x));
    // 3볼에서 볼 비중 하한 — 볼넷 없는 투수는 선구안을 무의미하게 만든다
    if (d.dB >= 3) {
      const strikeW = w[0] + w[2], ballW = w[1] + w[3];
      const want = 0.28;
      const target = (want * strikeW) / (1 - want);
      if (ballW < target) {
        const k = target / Math.max(0.001, ballW);
        w[1] *= k; w[3] *= k;
      }
    }
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    let pick = 0;
    for (let i = 0; i < 4; i++) { r -= w[i]; if (r <= 0) { pick = i; break } }
    const fast = pick < 2, strike = pick % 2 === 0;
    const revealPct = fast ? lvl().fastReveal : lvl().breakReveal;
    const bh = Math.random() < 0.5;
    const bs = spread(fast, strike, bh);
    d.dp = {
      fast, strike, high: bh, inOff: bs.inOff, miss: bs.miss,
      speed: (fast ? lvl().fastSpeedBase : lvl().breakSpeedBase) + randInt(0, 8),
      flightMs: fast ? lvl().fastFlight : lvl().breakFlight,
      k: 1.5 + ((revealPct - 30) / 55) * 2.3,
      rv: revealPct / 100,
      noise: Math.round((Math.random() * 80 - 40)) / 10,
    };
    d.phase = 'select';
    d.selUntil = now + 650 + Math.random() * 550;
    d.swung = false;
  }

  // 내가 투수: 1~4 로 구종 선택 (검토서 §3.4)
  function choosePitch(fast, strike) {
    if (d.screen !== 'match' || myBat() || !d.awaitingPitchChoice || d.paused) return;
    d.awaitingPitchChoice = false;
    const revealPct = fast ? lvl().fastReveal : lvl().breakReveal;
    const mh = d.pitchCourse === 'random' ? Math.random() < 0.5 : d.pitchCourse === 'high';
    const ms = spread(fast, strike, mh);
    d.dp = {
      fast, strike, high: mh, inOff: ms.inOff, miss: ms.miss,
      speed: (fast ? lvl().fastSpeedBase : lvl().breakSpeedBase) + randInt(0, 8),
      flightMs: fast ? lvl().fastFlight : lvl().breakFlight,
      k: 1.5 + ((revealPct - 30) / 55) * 2.3,
      rv: revealPct / 100,
      noise: Math.round((Math.random() * 80 - 40)) / 10,
    };
    if (d.pvp) d.pvpSend?.('pitch', { ...d.dp });   // 랜덤 요소까지 확정해 전송 — 양쪽이 같은 공
    d.judgeText = '';
    d.phase = 'ready';
    d.readyAt = performance.now() + dCfg().readyMs;
  }

  // 봇 타자 — 판별 정확도는 잔여 반응 시간에 비례 (듀얼 랩 v2 이식)
  function makeBotAct(pt) {
    const rem = pt.flightMs * (1 - pt.rv);
    const acc = Math.min(0.95, Math.max(0.55, 0.55 + rem / 900 + lvl().botEyeBonus));
    let believes = pt.strike;
    if (Math.random() > acc) believes = !believes;
    let swing;
    if (d.dS >= 2) swing = believes || Math.random() < 0.35;
    else if (d.dB >= 3) swing = believes && Math.random() < 0.9;
    else swing = believes ? Math.random() < 0.78 : Math.random() < lvl().botChaseProb;
    if (!swing) return { swing: false, off: 0, at: 0 };
    const off = Math.round(gauss() * BOT_SIGMA + 8);
    return { swing: true, off, at: d.hitAt + Math.max(-60, Math.min(off, 120)) };
  }

  function duelSwing(eventTimeMs) {
    if (d.phase !== 'pitching' || d.swung || d.mode !== 'duel' || d.paused) return;
    d.swung = true;
    d.swingAt = performance.now();
    const off = Math.round(eventTimeMs - d.hitAt);
    if (d.pvp) d.pvpSend?.('result', { sw: true, off });
    duelResolve(true, off);
  }

  function advanceBases(n) {
    let runs = 0;
    const nb = [false, false, false];
    for (let i = 2; i >= 0; i--) {
      if (!d.dBases[i]) continue;
      const t = i + n;
      if (t >= 3) runs += 1; else nb[t] = true;
    }
    if (n >= 4) runs += 1; else nb[n - 1] = true;
    d.dBases = nb;
    return runs;
  }
  function walkAdvance() {
    let runs = 0;
    if (d.dBases[0] && d.dBases[1] && d.dBases[2]) runs += 1;
    else if (d.dBases[0] && d.dBases[1]) d.dBases[2] = true;
    else if (d.dBases[0]) d.dBases[1] = true;
    d.dBases[0] = true;
    return runs;
  }
  function duelAddOut() {
    d.dOuts += 1;
    if (d.dOuts >= 3) endHalf();
  }
  function endHalf() {
    bump(myBat(), (t) => { t.lob += d.dBases.filter(Boolean).length; });   // 잔루
    if (myBat()) d.myInnRuns.push(d.curHalfRuns); else d.botInnRuns.push(d.curHalfRuns);
    d.curHalfRuns = 0;
    d.dBases = [false, false, false]; d.dB = 0; d.dS = 0; d.dOuts = 0;
    // 야구 규칙: 마지막 이닝 초 종료 시 후공이 이미 앞서면 말 공격 생략
    if (d.halfTop && d.dInn >= d.dInnT && bottomTotal() > topTotal()) {
      d.dOver = true; saveMatchResult(); return;
    }
    if (!d.halfTop) {
      d.dInn += 1;
      if (d.dInn > d.dInnT) { d.dOver = true; saveMatchResult(); return; }
    }
    d.halfTop = !d.halfTop;
    d.halfChangePending = true;   // 연출이 끝난 뒤에 교대 카드를 띄운다
  }
  function saveMatchResult() {
    const key = myTotal() > botTotal() ? 'matchW' : myTotal() < botTotal() ? 'matchL' : 'matchD';
    localStorage.setItem(key, +(localStorage.getItem(key) ?? 0) + 1);
    lifeAdd('lifeDuelHits', statHits(d.myStats));
    lifeAdd('lifeDuelHR', d.myStats.hr);
    lifeAdd('lifeDuelSO', d.myStats.so);
    lifeAdd('lifeDuelBB', d.myStats.bb);
    lifeAdd('lifeEyeGood', d.myStats.eyeGood);
    lifeAdd('lifeEyeTotal', d.myStats.eyeTotal);
    d.onMatchResult?.(myTotal(), botTotal());   // 지옥 봇전 온라인 제출 (app.js 가 연결)
  }

  function duelResolve(sw, offset) {
    const pt = d.dp;
    if (!pt) return;
    d.dPitchNo += 1;
    if (!pt.strike && myBat()) d.dBallsSeen += 1;
    const KO = KOref();
    const pi = KO ? `${pt.fast ? '직구' : '변화구'}·${pt.strike ? '스트' : '볼'}`
                  : `${pt.fast ? 'fast' : 'break'}·${pt.strike ? 'strike' : 'ball'}`;
    let msg = '', kind = null, dist = 0;
    let endPA = false;
    const mine = myBat();
    const who = d.pvp ? d.oppNick : L('봇', 'Bot');
    const risp = d.dBases[1] || d.dBases[2];
    const batBefore = mine ? myTotal() : botTotal();
    const fldBefore = mine ? botTotal() : myTotal();
    let playLabel = '', abEnded = false, wasHit = false;
    const core = { index: 0, type: pt.fast ? 'FASTBALL' : 'CURVE', speed: pt.speed,
                   flightMs: pt.flightMs, course: 4, noise: pt.noise };

    if (!sw) {
      if (pt.strike) {
        d.dS += 1;
        msg = mine ? L('스트라이크 (루킹)', 'Called strike') : L(`${who} 루킹 스트라이크`, 'Called strike');
        bump(mine, (t) => { t.eyeTotal += 1; });
      } else {
        d.dB += 1;
        msg = mine ? L('볼', 'Ball') : L(`볼 — ${who}이(가) 참음`, 'Ball');
        bump(mine, (t) => { t.eyeGood += 1; t.eyeTotal += 1; });
      }
    } else if (!pt.strike) {
      d.dS += 1; if (mine) d.dChases += 1;
      bump(mine, (t) => { t.eyeTotal += 1; });
      msg = L(mine ? '헛스윙! (유인구)' : `${who} 헛스윙! 유인 성공`, 'Swing and a miss! (chase)');
    } else {
      const off = offset;
      const a = Math.abs(off);
      bump(mine, (t) => { t.eyeGood += 1; t.eyeTotal += 1; t.offSum += a; t.offN += 1; });
      const j = judge(off, dCfg().thresholds);
      const om = `${a}ms ` + (off < 0 ? L('빠름', 'early') : L('늦음', 'late'));
      if (j === 'MISS') {
        d.dS += 1; msg = L(`헛스윙! (${om})`, `Swing and a miss! (${om})`);
      } else if (j === 'POOR') {
        if (d.dS < 2) d.dS += 1;
        msg = L(`파울 (${om})`, `Foul (${om})`); kind = 'foul'; dist = 40;
      } else if (j === 'GOOD') {
        dist = distanceOf(off, core, 0, dCfg());
        if (a <= lvl().goodWindow) {
          d.curHalfRuns += advanceBases(1); bump(mine, (t) => { t.h1 += 1; });
          playLabel = L('안타', 'Hit'); abEnded = true; wasHit = true; endPA = true;
          msg = L(`${mine ? '' : who + ' '}안타! (${om})`, `Hit! (${om})`); kind = 'fly';
        } else {
          duelAddOut(); abEnded = true; endPA = true;
          msg = L(`${mine ? '' : who + ' '}땅볼 아웃 (${om})`, `Ground out (${om})`); kind = 'ground';
        }
      } else {                       // GREAT · PERFECT
        dist = distanceOf(off, core, 0, dCfg());
        if (j === 'PERFECT') dist = Math.max(dist, dCfg().homerunLine);
        if (dist >= dCfg().homerunLine) {
          const sc = advanceBases(4); d.curHalfRuns += sc; bump(mine, (t) => { t.hr += 1; });
          playLabel = L('홈런', 'HR'); abEnded = true; wasHit = true; endPA = true;
          msg = L(`${mine ? '' : who + ' '}홈런! ${sc}점 (${j})`, `Homer! +${sc} (${j})`); kind = 'hr';
        } else if (dist >= dCfg().homerunLine - 8) {
          d.curHalfRuns += advanceBases(3); bump(mine, (t) => { t.h3 += 1; });
          playLabel = L('3루타', 'Triple'); abEnded = true; wasHit = true; endPA = true;
          msg = L(`${mine ? '' : who + ' '}3루타! 펜스 직격`, 'Triple! Off the wall'); kind = 'fly';
        } else if (dist >= dCfg().homerunLine - 28) {
          d.curHalfRuns += advanceBases(2); bump(mine, (t) => { t.h2 += 1; });
          playLabel = L('2루타', 'Double'); abEnded = true; wasHit = true; endPA = true;
          msg = L(`${mine ? '' : who + ' '}2루타! (${j})`, `Double! (${j})`); kind = 'fly';
        } else {
          // 잘 맞았지만 뻗지 못한 타구 = 뜬공 아웃 (확률이 아니라 비거리 구간)
          duelAddOut(); abEnded = true; endPA = true;
          msg = L(`${mine ? '' : who + ' '}뜬공 아웃 (${dist}m)`, `Fly out (${dist}m)`); kind = 'fly';
        }
      }
    }
    if (d.dS >= 3) {
      bump(mine, (t) => { t.so += 1; }); duelAddOut(); abEnded = true; endPA = true;
      msg += L(' → 삼진!', ' → Strikeout!');
    } else if (d.dB >= 4) {
      d.curHalfRuns += walkAdvance(); bump(mine, (t) => { t.bb += 1; });
      playLabel = L('밀어내기', 'bases-loaded walk'); endPA = true;
      msg += L(' → 볼넷', ' → Walk');
    }
    if (endPA) { d.dB = 0; d.dS = 0; }
    if (abEnded && risp) bump(mine, (t) => { t.rispAB += 1; if (wasHit) t.rispHit += 1; });
    // 결승타 후보 — 이 타격으로 리드를 잡았으면 기록 (마지막 것이 남는다)
    const batAfter = mine ? myTotal() : botTotal();
    const fldAfter = mine ? botTotal() : myTotal();
    if (mine && batAfter > batBefore) d.cheerAt = performance.now();   // 내 득점 축포 (D72)
    if (batBefore <= fldBefore && batAfter > fldAfter && playLabel) {
      const desc = KO ? `${Math.min(d.dInn, d.dInnT)}회${d.halfTop ? '초' : '말'} ${playLabel}`
                      : `${d.halfTop ? 'Top' : 'Bot'} ${Math.min(d.dInn, d.dInnT)} ${playLabel}`;
      bump(mine, (t) => { t.gwDesc = desc; });
    }
    // 야구 규칙: 마지막 이닝 말, 후공(봇)이 앞서는 순간 즉시 종료 (끝내기)
    if (!d.dOver && !d.halfTop && d.dInn >= d.dInnT && bottomTotal() > topTotal()) {
      d.dOver = true;
      saveMatchResult();
      msg += L(' → 끝내기!', ' → Walk-off!');
    }
    d.judgeText = `[${pi}] ${msg}`;
    d.fly = (kind !== null && dist > 0)
      ? { at: performance.now(), dist, kind } : null;
    d.phase = 'resolving';
    d.resolveUntil = performance.now() + 1500;
  }

  // 듀얼 틱 — main.swift tick() 의 duel 분기
  function duelTick(now) {
    switch (d.phase) {
      case 'select':
        if (now >= d.selUntil) {
          d.phase = 'ready'; d.readyAt = now + dCfg().readyMs;
        }
        break;
      case 'ready':
        if (now >= d.readyAt) {
          d.phase = 'pitching'; d.t0 = now;
          d.hitAt = now + d.dp.flightMs;
          d.fly = null;
          if (!d.pvp && !d.halfTop) d.botAct = makeBotAct(d.dp);
        }
        break;
      case 'pitching':
        if (d.pvp) {
          // 타자인 나만 판정 권한 — 노스윙도 이벤트로 알린다. 투수는 result 대기.
          if (!myBat() && d.dp && now > d.hitAt + 20_000 && !d.pvpStatus) {
            d.pvpStatus = L('상대 응답 없음 — Esc 로 나가면 기록됩니다', 'Opponent not responding — press Esc to leave (result is recorded)');
            d.oppAlive = false;
          }
          if (myBat() && d.dp && !d.swung && now > d.hitAt + dCfg().thresholds.poor + 170) {
            d.swung = true;
            d.pvpSend?.('result', { sw: false });
            duelResolve(false, null);
          }
        } else if (!d.halfTop && d.botAct && d.botAct.swing && !d.swung && now >= d.botAct.at) {
          d.swung = true; d.swingAt = now;
          duelResolve(true, d.botAct.off);
        } else if (d.dp && now > d.hitAt + dCfg().thresholds.poor + 170) {
          duelResolve(false, null);
        }
        break;
      case 'resolving':
        if (now < d.resolveUntil) break;
        if (d.halfChangePending) {
          d.halfChangePending = false;
          if (!d.dOver) d.halfChangeAt = now;
        }
        if (d.halfChangeAt > 0 && now - d.halfChangeAt < HALF_CHANGE_MS) return;
        if (d.dOver) { d.phase = 'ended'; d.duelEndedAt = now; }
        else duelNextPitch(now);
        break;
    }
  }

  return { beginDuel, duelNextPitch, choosePitch, duelSwing, duelTick, duelResolve, saveMatchResult,
           myBat, myTotal, botTotal, dCfg, lvl };
}
