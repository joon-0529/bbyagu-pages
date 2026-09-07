// 별별야구 The Game — 웹 클라이언트 (H6)
// 정본은 앱(main.swift)과 엔진(engine/src/rules.ts).
// 이 파일은 main.swift 를 **같은 수치로** 옮긴 것이다 — 값을 바꾸고 싶으면
// 여기서 바꾸지 말고 정본을 바꾼 뒤 다시 옮길 것.
// 화면: home / matchMenu / matchSetup / race / match  (리더보드·기록·PvP 는 다음 단계)
import { DIFFICULTY, SessionState } from './rules.js';
import { makeDuel, DUEL_LEVELS, HALF_CHANGE_MS, statHits, statEyePct, statAvgOff } from './duel.js';
import { makeOnline, TERMS_KO, TERMS_EN } from './online.js';

// ═══ 언어 ═══
let KO = (localStorage.getItem('appLang') ?? (navigator.language || 'ko')).startsWith('ko');
const L = (ko, en) => (KO ? ko : en);

// ═══ 게임 상태 (main.swift Game) ═══
const DIFF = 'NORMAL';
const cfg = DIFFICULTY[DIFF];
const newSeed = () => String(Math.floor(Math.random() * 2 ** 52));

const game = {
  // 온라인 참여를 아직 고르지 않았다면 온보딩부터 — 그 전에는 통신하지 않는다
  screen: localStorage.getItem('onboarded') === '1' ? 'home' : 'onboard',
  mode: 'race',
  homeSel: 0, matchSel: 0, setupSel: 0,
  onboardSel: 0, settingsSel: 0,
  termsScroll: 0, termsFrom: 'settings',
  // 리더보드 v2
  lbPage: 0, lbInnings: 3, lbChaos: false,
  lbMore: false, lbMoreOffset: 0, lbMorePage: 30,
  lbCache: {}, lbInFlight: new Set(), lbFailed: new Set(),
  myRanks: {},
  remoteSessionId: null, sessionStartAt: 0, duelStartAt: 0,
  session: new SessionState(newSeed(), DIFF),
  phase: 'idle',            // idle | select | ready | pitching | resolving | ended
  pitch: null,
  readyAt: 0, t0: 0, hitAt: 0, resolveUntil: 0, selUntil: 0,
  swung: false, swingAt: 0,
  judgeText: '',
  fly: null,                // {at, dist, kind: 'fly'|'hr'|'ground'|'foul'}
  raceOffsets: [],
  raceEndedAt: 0, raceNewHigh: false,
  cheerAt: 0,               // 플레이 중 축포 시각 — 홈런·득점 (D72)
  racePrevBestHR: 0, racePrevBestDist: 0,
  paused: false, pausedAt: 0,
  helpOpen: false, helpPaused: false,
  onlineStatus: '', menuNotice: '',
  // ── 경기 모드 (봇전) ──
  matchInnings: +(localStorage.getItem('matchInnings') ?? 3),
  duelLevel: localStorage.getItem('duelLevel') ?? '보통',
  physChaos: localStorage.getItem('physChaos') === '1',
  pitchCourse: 'random',    // random | high | low
  dp: null, botAct: null, awaitingPitchChoice: false,
  dB: 0, dS: 0, dOuts: 0, dInn: 1, dInnT: 3,
  dBases: [false, false, false],
  dPitchNo: 0, dOver: false, dBallsSeen: 0, dChases: 0,
  halfTop: true, myInnRuns: [], botInnRuns: [], curHalfRuns: 0,
  myStats: null, oppStats: null,
  duelEndedAt: 0, halfChangeAt: 0, halfChangePending: false,
  get canPause() {
    if (this.paused) return true;
    return this.phase !== 'idle' && this.phase !== 'ended' && this.phase !== 'pitching';
  },
};
if (!DUEL_LEVELS[game.duelLevel]) game.duelLevel = '보통';
if (![3, 6, 9].includes(game.matchInnings)) game.matchInnings = 3;
const duel = makeDuel(game, L, () => KO);
const online = makeOnline(L);
if (game.screen === 'home') online.ensureIdentity();

// ── 리더보드 페이지 정의 (main.swift lbPages) ──
const LB_PAGES = [
  { title: () => L('홈런레이스 최다 홈런', 'Homerun Race · Most HR'), unit: () => L('홈런', 'HR'), key: () => 'SESSION_HOMERUNS', hasInnings: false, hasChaos: false },
  { title: () => L('홈런레이스 최장 비거리', 'Homerun Race · Longest HR'), unit: () => 'm', key: () => 'BEST_DISTANCE', hasInnings: false, hasChaos: false },
  { title: () => L('홈런레이스 최다 연속 홈런', 'Homerun Race · Best Streak'), unit: () => L('연속', 'streak'), key: () => 'MAX_COMBO', hasInnings: false, hasChaos: false },
  { title: () => L('지옥 봇전 최다 점수차 승리', 'Hell Bots · Biggest Win Margin'), unit: () => L('점차', 'margin'), key: (i, c) => `DUEL_WIN_MARGIN_${i}_${c ? 'C' : 'N'}`, hasInnings: true, hasChaos: true },
  { title: () => L('지옥 봇전 한 경기 최다 득점', 'Hell Bots · Most Runs, One Game'), unit: () => L('점', 'runs'), key: (i, c) => `DUEL_BEST_RUNS_${i}_${c ? 'C' : 'N'}`, hasInnings: true, hasChaos: true },
  { title: () => L('랭크전 최다승', 'Ranked · Most Wins'), unit: () => L('승', 'wins'), key: () => 'PVP_WINS', hasInnings: false, hasChaos: false },
  { title: () => L('랭크전 최고 승률', 'Ranked · Best Win Rate'), unit: () => '%', key: () => 'PVP_WINRATE', hasInnings: false, hasChaos: false },
];
const lbBoardKey = () => LB_PAGES[game.lbPage].key(game.lbInnings, game.lbChaos);
// 보드별 재진입 차단 — lbFailed 도 넣어야 무한 재귀가 없다 (맥 주석 그대로)
async function lbFetch() {
  const key = lbBoardKey();
  if (game.lbCache[key] || game.lbFailed.has(key) || game.lbInFlight.has(key)) return;
  game.lbInFlight.add(key);
  const top = await online.fetchBoard(key, 100);
  game.lbInFlight.delete(key);
  if (top) { game.lbCache[key] = top; game.lbFailed.delete(key); }
  else game.lbFailed.add(key);
  if (game.screen === 'leaderboard') lbFetch();     // 그 사이 넘어간 페이지 보충
}
function lbOpen() {
  game.lbPage = 0; game.lbInnings = 3; game.lbChaos = false;
  game.lbMore = false; game.lbMoreOffset = 0;
  game.lbCache = {}; game.lbFailed = new Set();
  game.screen = 'leaderboard'; game.menuNotice = '';
  lbFetch();
}
function lbMove(delta) {
  game.lbPage = (game.lbPage + delta + LB_PAGES.length) % LB_PAGES.length;
  game.lbMore = false; game.lbMoreOffset = 0;
  lbFetch();
}
function recordsOpen() {
  game.screen = 'records'; game.menuNotice = '';
  game.myRanks = {};
  const me = online.display;
  if (!me) return;
  for (const key of ['SESSION_HOMERUNS', 'BEST_DISTANCE', 'MAX_COMBO', 'PVP_WINS']) {
    online.fetchBoard(key, 100).then((top) => {
      const e = top?.find((x) => x.display === me);
      if (e && typeof e.rank === 'number') game.myRanks[key] = e.rank;
    });
  }
}
// 표시명 축약 — 식별자(#1234)는 반드시 남긴다 (동명이인 구분 수단)
function shortDisplay(raw, nickMax = 12) {
  const h = raw.lastIndexOf('#');
  if (h < 0) return raw.slice(0, nickMax);
  const name = raw.slice(0, h), disc = raw.slice(h);
  return name.length <= nickMax ? name + disc : name.slice(0, nickMax - 1) + '…' + disc;
}

// ── 설정 항목 실행 (main.swift editSetting) ──
function editSetting(row) {
  switch (row) {
    case 0: {     // 닉네임
      const cur = localStorage.getItem('nickname') ?? '';
      const v = prompt(L('닉네임 (최대 12자)', 'Nickname (max 12 chars)'), cur);
      if (v === null) break;
      const nick = v.trim().slice(0, 12);
      if (!nick) break;
      localStorage.setItem('nickname', nick);
      if (online.enabled()) { online.identityId = null; online.ensureIdentity(); }
      break;
    }
    case 1:       // 온라인 참여 토글
      if (online.enabled()) {
        localStorage.setItem('onlineEnabled', '0');
        online.refreshStatusLine();
      } else {
        localStorage.setItem('onlineEnabled', '1');
        online.ensureIdentity();
      }
      break;
    case 2: {     // 서버 주소 (사설 서버용 고급 옵션)
      const v = prompt(L('서버 주소 (비우면 공식 서버)', 'Server URL (empty = official)'),
                       localStorage.getItem('serverURL') ?? '');
      if (v === null) break;
      if (v.trim()) localStorage.setItem('serverURL', v.trim());
      else localStorage.removeItem('serverURL');
      online.identityId = null; online.nextSeed = null;
      if (online.enabled()) online.ensureIdentity();
      break;
    }
    case 3:       // 내 기록 삭제
      if (!confirm(L('서버에 등록된 내 기록과 프로필을 모두 삭제할까요? 되돌릴 수 없습니다.',
                     'Delete all my records and profile from the server? This cannot be undone.'))) break;
      online.deleteMyRecords().then(({ msg }) => alert(msg));
      break;
    case 4:       // 약관
      game.termsFrom = 'settings'; game.termsScroll = 0; game.screen = 'terms';
      break;
    case 5: {     // 부적절한 닉네임 신고 — 메일로 받는다
      const v = prompt(L('신고할 닉네임(표시명)을 입력하세요', 'Enter the nickname (display name) to report'), '');
      if (!v) break;
      location.href = 'mailto:bbyagucontact@gmail.com?subject='
        + encodeURIComponent(L('[별별야구] 닉네임 신고', '[BB Baseball] Nickname report'))
        + '&body=' + encodeURIComponent(v);
      break;
    }
    case 6:       // 언어 순환: 자동 → 한국어 → English → 자동
      cycleAppLanguage();
      break;
  }
}
function appLanguageLabel() {
  const v = localStorage.getItem('appLang');
  return v === 'ko' ? '한국어' : v === 'en' ? 'English' : L('자동 (시스템)', 'Auto (system)');
}
function cycleAppLanguage() {
  const v = localStorage.getItem('appLang');
  if (v === null || v === 'auto') { localStorage.setItem('appLang', 'ko'); KO = true; }
  else if (v === 'ko') { localStorage.setItem('appLang', 'en'); KO = false; }
  else { localStorage.removeItem('appLang'); KO = (navigator.language || 'ko').startsWith('ko'); }
  online.refreshStatusLine();   // 저장된 상태 문자열은 만들 당시 언어로 굳는다
  updateChrome();
}
// 온보딩 확정 — 참여를 골랐는데 닉네임을 취소하면 동의하지 않은 것으로 본다
function finishOnboard() {
  if (game.onboardSel === 2) {
    game.termsFrom = 'onboard'; game.termsScroll = 0; game.screen = 'terms';
    return;
  }
  if (game.onboardSel === 0) {
    const v = prompt(L('닉네임 (최대 12자)', 'Nickname (max 12 chars)'), '');
    if (v === null) return;                       // 취소 → 온보딩에 남는다
    const nick = v.trim().slice(0, 12);
    if (!nick) return;
    localStorage.setItem('nickname', nick);
    localStorage.setItem('onlineEnabled', '1');
  } else {
    localStorage.setItem('onlineEnabled', '0');
  }
  localStorage.setItem('onboarded', '1');
  game.screen = 'home';
  online.ensureIdentity();
}

// ═══ 레이스 (main.swift Game 레이스 부분) ═══
function startSession() {
  // 서버 시드가 준비돼 있으면 온라인 세션, 아니면 로컬 (NFR-3.1/3.9)
  if (online.nextSeed) {
    game.session = new SessionState(online.nextSeed.seed, DIFF);
    game.remoteSessionId = online.nextSeed.id;
    online.nextSeed = null;
    online.prefetchSeed();
  } else {
    game.session = new SessionState(newSeed(), DIFF);
    game.remoteSessionId = null;
    online.prefetchSeed();
  }
  game.sessionStartAt = performance.now();
  game.onlineStatus = '';
  game.raceOffsets = [];
  game.raceEndedAt = 0; game.raceNewHigh = false;
  game.fly = null; game.judgeText = '';
  game.paused = false;
  nextPitch(performance.now());
}
function nextPitch(now) {
  game.pitch = game.session.nextPitch();
  game.phase = 'ready';
  game.readyAt = now + cfg.readyMs;
  game.swung = false;
}
function release(now) {
  game.phase = 'pitching';
  game.t0 = now;
  game.hitAt = now + game.pitch.flightMs;
  game.fly = null;
}
function swing(eventTimeMs) {
  if (game.phase !== 'pitching' || game.swung) return;
  game.swung = true;
  game.swingAt = performance.now();
  resolveRace(Math.round(eventTimeMs - game.hitAt));
}
function resolveRace(offset) {
  game.raceOffsets.push(offset);
  const out = game.session.swing(offset, game.pitch);
  let dist = out.distance;
  if (out.result !== 'HOMERUN' && dist >= cfg.homerunLine) dist = cfg.homerunLine - 3;
  const label = {
    HOMERUN: L('홈런!', 'Home run!'), FLYOUT: L('뜬공 아웃', 'Flyout'),
    GROUNDOUT: L('범타 아웃', 'Groundout'), FOUL: L('파울 아웃', 'Foul out'),
    STRIKEOUT: L('헛스윙', 'Swing and a miss'), PASS: L('지나감', 'Taken'),
  }[out.result];
  if (offset !== null && out.judgement !== 'PERFECT' && out.judgement !== 'MISS') {
    game.judgeText = `${out.judgement} · ${Math.abs(offset)}ms ${offset < 0 ? L('빠름', 'early') : L('늦음', 'late')} · ${label}`;
  } else {
    game.judgeText = `${offset === null ? 'NO SWING' : out.judgement} · ${label}`;
  }
  game.fly = (dist > 0 && out.result !== 'STRIKEOUT')
    ? { at: performance.now(), dist, kind: out.result === 'HOMERUN' ? 'hr' : 'fly' }
    : null;
  if (out.result === 'HOMERUN') game.cheerAt = performance.now();
  game.phase = 'resolving';
  game.resolveUntil = performance.now() + 1300;   // 맥과 동일 (1500 이었던 건 오기)
}
// 저장 **전**의 개인 최고를 돌려준다 — 신기록 판정 기준 (맥 saveRaceRecord)
function saveRaceRecord(hr, dist) {
  const prev = {
    bestHR: +(localStorage.getItem('bestHR') ?? 0),
    bestDist: +(localStorage.getItem('bestDist') ?? 0),
  };
  localStorage.setItem('bestHR', Math.max(prev.bestHR, hr));
  localStorage.setItem('bestDist', Math.max(prev.bestDist, dist));
  const lifeAdd = (k, v) => localStorage.setItem(k, +(localStorage.getItem(k) ?? 0) + v);
  lifeAdd('lifeSessions', 1); lifeAdd('lifeHR', hr);
  return prev;
}
function raceTick(now) {
  switch (game.phase) {
    case 'ready':
      if (now >= game.readyAt) release(now);
      break;
    case 'pitching':
      if (now > game.hitAt + cfg.thresholds.poor + 170) resolveRace(null);
      break;
    case 'resolving':
      if (now < game.resolveUntil) break;
      if (game.session.ended) {
        game.phase = 'ended';
        const sum = game.session.summary();
        const prev = saveRaceRecord(sum.homeruns, sum.maxDistance);
        game.racePrevBestHR = prev.bestHR;
        game.racePrevBestDist = prev.bestDist;
        game.raceNewHigh = sum.homeruns > prev.bestHR;
        game.raceEndedAt = now;
        if (game.remoteSessionId) {
          const sid = game.remoteSessionId;
          game.remoteSessionId = null;
          game.onlineStatus = L('온라인 제출 중…', 'Submitting…');
          online.submit({
            sessionId: sid, offsets: game.raceOffsets,
            homeruns: sum.homeruns, maxDistance: sum.maxDistance,
            maxCombo: sum.maxCombo, totalAtBats: sum.totalAtBats,
            durationMs: Math.round(performance.now() - game.sessionStartAt),
          }).then((msg) => { game.onlineStatus = msg; });
        } else {
          game.onlineStatus = L('오프라인 세션 — 로컬 기록만', 'Offline session — local record only');
        }
      } else nextPitch(now);
      break;
  }
}
function togglePause() {
  if (game.paused) {
    const dt = performance.now() - game.pausedAt;
    game.readyAt += dt; game.t0 += dt; game.hitAt += dt; game.resolveUntil += dt;
    if (Number.isFinite(game.selUntil)) game.selUntil += dt;
    if (game.fly) game.fly.at += dt;
    if (game.swingAt > 0) game.swingAt += dt;
    if (game.botAct && game.botAct.swing) game.botAct.at += dt;
    game.paused = false;
  } else if (game.canPause) {
    game.pausedAt = performance.now();
    game.paused = true;
  } else if (game.phase === 'pitching') {
    game.judgeText = L('투구 중에는 멈출 수 없습니다', "Can't pause during a pitch");
  }
}
// 안내를 열면 (투구 사이라면) 잠시 멈춘다 — 투구 중은 canPause 가 막는다 (D50·D53)
function openHelp() {
  game.helpOpen = true;
  if (game.canPause && !game.paused) { togglePause(); game.helpPaused = true; }
}
function closeHelp() {
  game.helpOpen = false;
  if (game.helpPaused) { game.helpPaused = false; if (game.paused) togglePause(); }
}

// ═══ 내비게이션 (main.swift enterHome 등) ═══
function enterRace() {
  game.screen = 'race'; game.mode = 'race'; game.menuNotice = '';
  // 같은 실행 안에서는 세션이 살아 있다 — 나갔다 들어오면 이어서 (맥 restoreRace 축소판)
  if (game.session && !game.session.ended && game.session.nextIndex > 0
      && game.raceEndedAt === 0) {
    game.judgeText = L('이어서 계속 - 아웃 ', 'Resume - outs ')
      + game.session.currentOuts + '/' + game.session.maxOuts;
    game.fly = null;
    nextPitch(performance.now());
  } else startSession();
}
function enterHome() {
  switch (game.homeSel) {
    case 0: game.screen = 'matchMenu'; game.menuNotice = ''; break;
    case 1: enterRace(); break;
    case 2: lbOpen(); break;
    case 3: recordsOpen(); break;
    default: game.settingsSel = 0; game.screen = 'settings'; game.menuNotice = '';
  }
}
function leaveToHome() {
  game.paused = false; game.helpOpen = false;
  game.screen = 'home'; game.phase = 'idle'; game.menuNotice = '';
}
function changeDuelSetting(row, back) {
  switch (row) {
    case 0: {
      const opts = [3, 6, 9];
      const i = opts.indexOf(game.matchInnings);
      game.matchInnings = opts[(i + (back ? 2 : 1)) % 3];
      localStorage.setItem('matchInnings', game.matchInnings);
      break;
    }
    case 1: {
      const all = Object.keys(DUEL_LEVELS);
      const i = all.indexOf(game.duelLevel);
      game.duelLevel = all[(i + (back ? all.length - 1 : 1)) % all.length];
      localStorage.setItem('duelLevel', game.duelLevel);
      break;
    }
    default:
      game.physChaos = !game.physChaos;
      localStorage.setItem('physChaos', game.physChaos ? '1' : '0');
  }
}
function startDuel() {
  game.duelStartAt = performance.now();
  duel.beginDuel(performance.now());
}
// duel.js 의 saveMatchResult 가 부른다 — 지옥 봇전만 온라인 보드 제출
game.onMatchResult = (myRuns, botRuns) => {
  if (game.duelLevel !== '지옥') return;
  game.onlineStatus = '';
  online.submitDuel({
    innings: game.dInnT, myRuns, botRuns, chaos: game.physChaos,
    durationMs: Math.round(performance.now() - game.duelStartAt),
  }).then((msg) => { game.onlineStatus = msg; });
};

// ═══ 포즈 (main.swift batterPose/pitcherPose 포팅) ═══
const SWING_MS = 150;
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const easeIn = (t) => t * t;

function batterPose(now) {
  const READY = -1.95, CONTACT = -0.06 - Math.PI * 2;
  const FOLLOW = CONTACT - 0.85, FOLLOW_N = -0.85;
  let t = game.swingAt > 0 ? (now - game.swingAt) / SWING_MS : -1;
  const p = { bat: READY, hx: 0, hy: 0, hip: 0, lean: 0, stride: 0, heel: 0 };
  if (t >= 1.7) { game.swingAt = 0; t = -1; }
  if (t < 0) {
    p.bat = READY + Math.sin(now / 380) * 0.05;
    p.hip = Math.sin(now / 760) * 0.8;
    p.hy = Math.sin(now / 760) * 0.5;
  } else if (t <= 0.12) {
    const u = t / 0.12;
    p.bat = READY - 0.12 * u;
    p.hx = -2.2 * u; p.hip = -1.6 * u; p.stride = -1.5 * u; p.lean = -0.03 * u;
  } else if (t <= 0.42) {
    const u = easeIn((t - 0.12) / 0.30);
    p.bat = (READY - 0.12) + (CONTACT - (READY - 0.12)) * u;
    p.hx = -2.2 + 7.4 * u; p.hy = 1.4 * u;
    p.hip = -1.6 + 5.4 * u; p.lean = -0.03 + 0.12 * u;
    p.stride = -1.5 + 4.8 * u; p.heel = 2.6 * u;
  } else if (t <= 1) {
    const u = easeOut((t - 0.42) / 0.58);
    p.bat = CONTACT + (FOLLOW - CONTACT) * u;
    p.hx = 5.2 - 1.6 * u; p.hy = 1.4 - 2.8 * u;
    p.hip = 3.8; p.lean = 0.09 - 0.02 * u; p.stride = 3.3; p.heel = 2.6;
  } else {
    const u = easeOut((t - 1) / 0.7);
    p.bat = FOLLOW_N + (READY - FOLLOW_N) * u;
    p.hx = 3.6 * (1 - u); p.hy = -1.4 * (1 - u);
    p.hip = 3.8 * (1 - u); p.lean = 0.07 * (1 - u);
    p.stride = 3.3 * (1 - u); p.heel = 2.6 * (1 - u);
  }
  return p;
}
function pitcherPose(now) {
  const p = { arm: 0.55, kick: 0, stride: 0, lean: 0, gather: 0 };
  const readyMs = game.mode === 'duel' ? duel.dCfg().readyMs : cfg.readyMs;
  switch (game.phase) {
    case 'ready': {
      const u = Math.min(1, Math.max(0, (now - (game.readyAt - readyMs)) / readyMs));
      if (u < 0.45) p.gather = u / 0.45;
      else {
        const v = (u - 0.45) / 0.55;
        p.gather = 1;
        p.kick = Math.sin(Math.min(1, v * 1.25) * Math.PI / 2);
        p.arm = 0.55 - easeIn(Math.min(1, v * 1.1)) * 2.0;
        p.lean = -0.06 * v;
      }
      break;
    }
    case 'pitching': {
      const u = Math.min(1, (now - game.t0) / 150);
      p.kick = 1 - easeOut(u); p.stride = easeOut(u);
      p.arm = -1.45 + easeIn(u) * 1.5;
      p.lean = -0.06 + 0.22 * u; p.gather = 1 - u;
      break;
    }
    default: {
      const u = Math.min(1, Math.max(0, (now - game.t0 - 150) / 900));
      p.arm = 0.05 + easeOut(u) * 0.5;
      p.stride = 1 - easeOut(u); p.lean = 0.16 * (1 - u);
    }
  }
  return p;
}

// ═══ 렌더 ═══
const W = 680, H = 300;
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

// 낮 = 순백 + 검정 잉크, 밤 = 0.09 그레이 + 0.92 잉크 (맥 bg()/ink() 그대로)
let isNight = matchMedia('(prefers-color-scheme: dark)').matches;
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  isNight = e.matches; syncPageTheme();
});
const bg = () => (isNight ? 'rgb(23,23,23)' : 'rgb(255,255,255)');
const ink = (a = 1) => (isNight ? `rgba(235,235,235,${a})` : `rgba(0,0,0,${a})`);
const RED = () => (isNight ? 'rgba(255,69,58,' : 'rgba(255,59,48,');
const ORANGE = () => (isNight ? 'rgba(255,159,10,' : 'rgba(255,149,0,');
const GREEN = () => (isNight ? 'rgba(48,209,88,' : 'rgba(52,199,89,');
const mono = (px, weight = 400) =>
  `${weight} ${px}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
const smallFont = mono(9), hudFont = mono(12, 500);

let scale = 1;
function fitCanvas() {
  scale = Math.min(innerWidth / W, (innerHeight - 40) / H, 2.2);
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(W * scale * dpr);
  canvas.height = Math.round(H * scale * dpr);
  canvas.style.width = `${W * scale}px`;
  canvas.style.height = `${H * scale}px`;
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
}
addEventListener('resize', fitCanvas);
fitCanvas();

function drawBatter(x, y, s, now) {
  const P = batterPose(now);
  const hipX = x - 2 * s + P.hip * s;
  const neckX = x + 1 * s + P.hip * 0.5 * s + P.lean * 26 * s;
  const head = [neckX + 1 * s, y - 45 * s + Math.abs(P.lean) * 6 * s];
  const neck = [neckX, y - 38.5 * s];
  const hip = [hipX, y - 19 * s];
  const hand = [x + 9 * s + P.hx * s, y - 33 * s + P.hy * s];
  ctx.strokeStyle = ctx.fillStyle = ink(0.9);
  ctx.lineWidth = 2.1 * s; ctx.lineCap = ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.arc(head[0], head[1], 5.6 * s, 0, 7); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(...neck);
  ctx.quadraticCurveTo(hip[0] - 2 * s, y - 30 * s, ...hip);
  ctx.moveTo(...hip);
  ctx.lineTo(x - 9 * s + P.hip * 0.4 * s, y - 9 * s);
  ctx.lineTo(x - 11 * s, y - P.heel * s);
  ctx.moveTo(...hip);
  ctx.lineTo(x + 7 * s + P.stride * 0.6 * s, y - 10 * s);
  ctx.lineTo(x + 9 * s + P.stride * s, y);
  ctx.moveTo(neck[0], neck[1] + 2 * s); ctx.lineTo(...hand);
  ctx.moveTo(neck[0] - 1 * s, neck[1] + 6 * s); ctx.lineTo(...hand);
  ctx.stroke();
  ctx.save();
  ctx.translate(...hand); ctx.rotate(P.bat);
  const len = 30 * s;
  ctx.beginPath();
  ctx.moveTo(0, -1.4 * s);
  ctx.lineTo(len * 0.45, -2.2 * s);
  ctx.quadraticCurveTo(len * 0.92, -3.5 * s, len, -3.2 * s);
  ctx.quadraticCurveTo(len + 3.2 * s, 0, len, 3.2 * s);
  ctx.quadraticCurveTo(len * 0.92, 3.5 * s, len * 0.45, 2.2 * s);
  ctx.lineTo(0, 1.4 * s);
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(-1.6 * s, 0, 2.1 * s, 0, 7); ctx.fill();
  ctx.restore();
}
function drawPitcher(x, y, s, now) {
  const P = pitcherPose(now);
  const dx = -P.lean * 30 * s;
  const sh = [x - 1 * s + dx, y - 34 * s];
  const hip = [x + dx * 0.4, y - 20 * s];
  ctx.strokeStyle = ctx.fillStyle = ink(0.9);
  ctx.lineWidth = 2 * s; ctx.lineCap = ctx.lineJoin = 'round';
  const headY = y - 42 * s + Math.abs(P.lean) * 5 * s;
  ctx.beginPath(); ctx.arc(sh[0], headY, 5 * s, 0, 7); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(sh[0], y - 36.5 * s); ctx.lineTo(...hip);
  ctx.moveTo(...hip); ctx.lineTo(x + 7 * s, y);
  const knee = [hip[0] - 5 * s - 2 * P.stride * s, hip[1] + 6 * s - 10 * P.kick * s];
  const foot = [x - 4 * s - 3 * P.kick * s - 8 * P.stride * s, y - 15 * P.kick * s];
  ctx.moveTo(...hip); ctx.lineTo(...knee); ctx.lineTo(...foot);
  const glove = [sh[0] - (5 + 5 * P.gather - 3 * P.stride) * s, sh[1] + (2 - 3 * P.gather) * s];
  ctx.moveTo(sh[0], sh[1] + 1 * s); ctx.lineTo(...glove);
  ctx.moveTo(...sh);
  ctx.lineTo(sh[0] - Math.cos(P.arm) * 13 * s, sh[1] - Math.sin(P.arm) * 13 * s);
  ctx.stroke();
}

function text(str, x, y, font, color, align = 'left') {
  ctx.font = font; ctx.fillStyle = color;
  ctx.textAlign = align; ctx.textBaseline = 'top';
  ctx.fillText(str, x, y);
  ctx.textAlign = 'left';
}
function textW(str, font) { ctx.font = font; return ctx.measureText(str).width; }
function roundedRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 클릭 히트 영역 (iOS tapRegions 방식 — 그리는 쪽이 등록, 입력은 소비만)
let regions = [];
const reg = (r, action) => regions.push({ ...r, action });

// ═══ 그리기 본체 ═══
function draw(now) {
  regions = [];
  ctx.fillStyle = bg();
  ctx.fillRect(0, 0, W, H);

  const g = H - 34;
  const hudY = Math.max(10, g - 158);
  const batX = W * 0.13;
  const hitX = batX + 34, hitY = g - 35;
  const pitX = W * 0.40;
  const fieldEnd = W * 0.96;
  const x_of = (m) => hitX + (m / 155) * (fieldEnd - hitX);
  const tickColor = ink(0.45);
  const inMenus = ['home', 'matchMenu', 'matchSetup', 'settings'].includes(game.screen);
  const vcfg = game.mode === 'duel' ? duel.dCfg() : cfg;

  // ── 일시정지 + ? 버튼 (레이스·경기 진행 중에만) ──
  if ((game.screen === 'race' || game.screen === 'match')
      && game.phase !== 'idle' && game.phase !== 'ended') {
    const r = { x: W - 34, y: 10, w: 24, h: 24 };
    reg(r, 'pauseToggle');
    ctx.strokeStyle = ink(0.5); ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.arc(r.x + 12, r.y + 12, 12, 0, 7); ctx.stroke();
    ctx.fillStyle = ink(0.7);
    if (game.paused) {
      ctx.beginPath();
      ctx.moveTo(r.x + 9, r.y + 6.5);
      ctx.lineTo(r.x + 9, r.y + 17.5);
      ctx.lineTo(r.x + 17, r.y + 12);
      ctx.closePath(); ctx.fill();
    } else {
      ctx.fillRect(r.x + 8, r.y + 7, 3, 10);
      ctx.fillRect(r.x + 13.5, r.y + 7, 3, 10);
    }
    const h = { x: W - 64, y: 10, w: 24, h: 24 };
    reg(h, 'helpToggle');
    ctx.strokeStyle = ink(0.5); ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.arc(h.x + 12, h.y + 12, 12, 0, 7); ctx.stroke();
    text('?', h.x + 12, h.y + 5, mono(14, 700), ink(0.7), 'center');
  }

  // ═══ 전용 화면들 — 맥처럼 필드 없이 (지면·담장을 그리기 전에 돌아간다) ═══
  if (game.screen === 'leaderboard') { drawLeaderboard(); return; }
  if (game.screen === 'records') { drawRecords(); return; }
  if (game.screen === 'onboard') { drawOnboardScreen(); return; }
  if (game.screen === 'terms') { drawTermsScreen(); return; }
  // ═══ 메뉴 화면들 ═══
  if (inMenus || game.screen === 'settings') {
    drawMenus(hudY, g, now);
    return;
  }

  // ── 지면 + 눈금 ──
  ctx.strokeStyle = ink(0.25); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, g); ctx.lineTo(W, g); ctx.stroke();
  for (const m of [50, 100, 150]) {
    const x = x_of(m);
    ctx.beginPath(); ctx.moveTo(x, g); ctx.lineTo(x, g + 5); ctx.stroke();
    text(`${m}m`, x - 8, g + 7, smallFont, tickColor);
  }

  // ── 담장 + 관중석 + 전광판 + 홈플레이트 ──
  const fenceX = x_of(vcfg.homerunLine), FH = 44;
  ctx.strokeStyle = ink(0.25);
  ctx.beginPath(); ctx.arc(hitX - 6, g, 30, 0, Math.PI, false); ctx.stroke();
  ctx.strokeStyle = ink(0.15);
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const y0 = g - 14 - i * 12;
    const x0 = fenceX + 12 + i * 10;
    ctx.moveTo(x0, y0); ctx.lineTo(W - 10, y0);
    ctx.moveTo(x0, y0); ctx.lineTo(x0, y0 + 8);
  }
  ctx.stroke();
  ctx.fillStyle = ink(0.06);
  ctx.fillRect(fenceX, g - FH, 7, FH);
  ctx.strokeStyle = ink(0.5); ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(fenceX, g); ctx.lineTo(fenceX, g - FH);
  ctx.lineTo(fenceX + 7, g - FH); ctx.lineTo(fenceX + 7, g);
  ctx.stroke();
  ctx.strokeStyle = RED() + '0.75)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(fenceX - 1, g - FH); ctx.lineTo(fenceX + 8, g - FH); ctx.stroke();
  text(`${vcfg.homerunLine}m`, fenceX - 26, g - FH + 4, smallFont, tickColor);

  const bbw = Math.min(168, Math.max(88, W - 10 - (fenceX + 18)));
  const bbx = Math.min(fenceX + 18, W - 10 - bbw);
  if (bbx > hitX + 40) {
    const br = { x: bbx, y: g - 110, w: bbw, h: 42 };
    ctx.strokeStyle = ink(0.22); ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(br.x + 18, br.y + br.h); ctx.lineTo(br.x + 18, g - 38);
    ctx.moveTo(br.x + br.w - 18, br.y + br.h); ctx.lineTo(br.x + br.w - 18, g - 38);
    ctx.stroke();
    ctx.fillStyle = ink(0.05); ctx.fillRect(br.x, br.y, br.w, br.h);
    ctx.strokeStyle = ink(0.3); ctx.lineWidth = 1.2;
    ctx.strokeRect(br.x, br.y, br.w, br.h);
    const board = online.adBoardRemote ?? '별별야구';
    if (textW(board, mono(15, 700)) < br.w - 8)
      text(board, br.x + br.w / 2, br.y + br.h / 2 - 8, mono(15, 700), ink(0.45), 'center');
  }
  ctx.strokeStyle = ink(0.5); ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(hitX + 8, g + 2); ctx.lineTo(hitX + 8, g + 8);
  ctx.lineTo(hitX - 1, g + 8); ctx.lineTo(hitX - 8, g + 5);
  ctx.lineTo(hitX - 1, g + 2); ctx.closePath(); ctx.stroke();


  // ── 판정 존 (경기 모드 전용 — 변화구 기준 고정, 구종 누설 방지) ──
  if (game.mode === 'duel' && game.phase !== 'idle') {
    const zf = duel.lvl().breakFlight;
    const pxms = (pitX - 15 - hitX) / zf;
    const wG = Math.min(48, vcfg.thresholds.great * pxms);
    const wP = Math.min(wG, vcfg.thresholds.perfect * pxms);
    const zh = 30;
    ctx.fillStyle = GREEN() + (isNight ? '0.22)' : '0.15)');
    ctx.fillRect(hitX - wP, hitY - zh / 2, wP * 2, zh);
    ctx.strokeStyle = ink(0.45); ctx.lineWidth = 1.3;
    ctx.strokeRect(hitX - wG, hitY - zh / 2, wG * 2, zh);
    // 완벽 접점 기준선 — 공이 이 선에 올 때가 PERFECT (박스 가장자리는 great 한계)
    ctx.strokeStyle = ink(0.6); ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hitX, hitY - zh / 2 + 2); ctx.lineTo(hitX, hitY + zh / 2 - 2);
    ctx.stroke();
  }

  // ── HUD ──
  const sum = game.session.summary();
  if (game.mode === 'duel') {
    if (game.phase !== 'idle' && game.phase !== 'ended') {
      drawDuelScoreboard(hudY);
      const note = game.paused
        ? L('일시정지 — P 재개 · Esc 홈', 'Paused — P resume · Esc home')
        : game.judgeText;
      if (note) text(note, 18, hudY + 46, hudFont, ink(0.9));
    }
  } else {
    const lines =
      game.phase === 'idle' ? [L('Space 를 눌러 시작', 'Press Space to start'), '']
      : game.phase === 'ended' ? ['', '']
      : [L(`홈런 ${sum.homeruns}   연속 ${game.session.currentCombo}   최고 ${sum.maxDistance}m   아웃 ${sum.outs}/${game.session.maxOuts}`,
           `HR ${sum.homeruns}   Streak ${game.session.currentCombo}   Best ${sum.maxDistance}m   Outs ${sum.outs}/${game.session.maxOuts}`),
         game.judgeText];
    lines.forEach((line, i) => {
      if (line) text(line, 18, hudY + i * 19, hudFont, ink(0.9));
    });
  }
  // 조작 안내 — 키캡 배지 + 설명 (시안 B)
  if (game.phase !== 'idle' && game.phase !== 'ended') drawGuide(hudY);

  // ── 상대 투수(봇) 선택 중 표시 ──
  if (game.mode === 'duel' && game.phase === 'select' && duel.myBat()) {
    const n = Math.floor(now / 300) % 3 + 1;
    text('·'.repeat(n), pitX - 4, g - 62, smallFont, tickColor);
  }

  // ── 캐릭터 ──
  drawBatter(batX, g, 1.02, now);
  drawPitcher(pitX, g, 0.98, now);

  // ── 공 ──
  const showBall = game.phase === 'pitching' ||
    (game.phase === 'resolving' && now <= game.hitAt + 130);
  if (showBall && game.mode === 'race' && game.pitch) {
    const pt = game.pitch;
    const p = Math.min(1, (now - game.t0) / pt.flightMs);
    const bx2 = (pitX - 15) + (hitX - (pitX - 15)) * p;
    const [aimOff, kExp] = {
      FASTBALL: [-2, 1.6], SLIDER: [-14, 2.4], CHANGEUP: [-4, 1.7], CURVE: [-26, 2.9],
    }[pt.type];
    const start = g - 32;
    const yAim = hitY + aimOff;
    const by = start + (yAim - start) * p + (hitY - yAim) * Math.pow(p, kExp);
    if (p < 0.45) {
      ctx.globalAlpha = 0.8 - p;
      text(`${pt.speed}km/h`, pitX - 34, g - 66, smallFont, tickColor);
      ctx.globalAlpha = 1;
    }
    drawBallAt(bx2, by, p, g);
  }
  if (showBall && game.mode === 'duel' && game.dp) {
    // 물리 준수: 같은 높은 라인에서 출발해 낙하량만 다르다 — 단서는 "얼마나 떨어지나"
    const pt = game.dp;
    const p = Math.min(1, (now - game.t0) / pt.flightMs);
    const bx2 = (pitX - 15) + (hitX - (pitX - 15)) * p;
    const zTop = hitY - 15, zBot = hitY + 15;
    const yStrike = hitY + pt.inOff;
    const yAim = pt.fast ? zTop - 8 : zTop - 18;
    const yBallHigh = Math.max(yAim, zTop - pt.miss);
    const yBall = pt.high ? yBallHigh : zBot + pt.miss;
    const yFinal = pt.strike ? yStrike : yBall;
    const kShape = pt.fast ? 1.7 : pt.k;
    const start = g - 32;
    let by;
    if (game.physChaos) {
      // 물리 위반(병맛): 판별점까지 직진, 짧은 창에서 급조향 + 오버슈트
      const r = pt.rv, w2 = Math.min(0.18, 1 - r);
      const mm = p <= r ? 0 : Math.min(1, (p - r) / w2);
      const c1 = 1.70158, c3 = c1 + 1;
      const e = mm === 0 ? 0 : 1 + c3 * Math.pow(mm - 1, 3) + c1 * Math.pow(mm - 1, 2);
      const yEnd = yAim + (yFinal - yAim) * e;
      by = start + (yEnd - start) * p;
    } else {
      const m0 = yAim - start;
      const c0 = Math.max(0, yFinal - yAim);
      by = start + m0 * p + c0 * Math.pow(p, kShape);
    }
    if (p < 0.45) {
      ctx.globalAlpha = 0.8 - p;
      text(`${pt.speed}km/h`, pitX - 34, g - 66, smallFont, tickColor);
      ctx.globalAlpha = 1;
    }
    drawBallAt(bx2, by, p, g);
  }

  // ── 타구 궤적 ──
  if (game.fly) drawFly(hudY, g, hitX, hitY, x_of, now);
  // ── 플레이 중 축포 — 레이스 홈런·경기 내 득점 (D72) ──
  if (game.cheerAt > 0 && game.phase !== 'ended') drawFireworks(20, now - game.cheerAt, true);

  // ── 종료 화면들 ──
  if (game.mode === 'race' && game.phase === 'ended') drawRaceOver(sum, now);
  if (game.mode === 'duel' && game.screen === 'match' && game.phase !== 'ended'
      && game.halfChangeAt > 0) {
    drawHalfChangeCard(now - game.halfChangeAt);
  }
  if (game.mode === 'duel' && game.phase === 'ended') drawDuelOver(now);

  // ── 조작 안내 오버레이 — 항상 맨 위 ──
  if (game.helpOpen) drawHelp();
}

function drawBallAt(bx2, by, p, g) {
  ctx.fillStyle = ink(0.10 + 0.18 * p);
  ctx.beginPath(); ctx.ellipse(bx2, g + 3, 3.6, 1.3, 0, 0, 7); ctx.fill();
  ctx.fillStyle = ink(0.8);
  const r = 2.8 + p * 1.6;
  ctx.beginPath(); ctx.arc(bx2, by, r, 0, 7); ctx.fill();
}

function drawFly(hudY, g, hitX, hitY, x_of, now) {
  const fly = game.fly;
  if (fly.kind === 'foul') {
    const t = Math.min(1, (now - fly.at) / 700);
    const x = hitX - 70 * t, y = hitY - 50 * t + 32 * t * t;
    ctx.fillStyle = ink(0.8);
    ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
    return;
  }
  if (fly.kind === 'ground') {
    const t = Math.min(1, (now - fly.at) / 900);
    const lx = x_of(fly.dist);
    const x = hitX + (lx - hitX) * t;
    const y = g - Math.abs(Math.sin(t * Math.PI * 3)) * 8 * (1 - t) - 2;
    ctx.fillStyle = ink(0.8);
    ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
    return;
  }
  const t = Math.min(1, (now - fly.at) / 900);
  const lx = x_of(fly.dist);
  const apex = Math.min(hitY - 8, g - 40 - (fly.dist / 155) * (g - 34));
  const endY = fly.kind === 'hr' ? Math.max(hudY + 40, apex * 0.55 + hudY * 0.3) : g;
  ctx.strokeStyle = ink(0.45); ctx.lineWidth = 1.25;
  ctx.beginPath();
  for (let i = 0; i <= 44; i++) {
    const u = (i / 44) * t;
    const x = hitX + (lx - hitX) * u;
    const y = (1 - u) ** 2 * hitY + 2 * (1 - u) * u * apex + u * u * endY;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
  if (t >= 1) {
    ctx.fillStyle = ink(0.8);
    ctx.beginPath(); ctx.arc(lx, endY, 3.2, 0, 7); ctx.fill();
    text(`${fly.dist}m`, lx + 7, endY - 5, smallFont, ink(0.85));
  }
}

// ═══ 메뉴 ═══
function drawMenus(hudY, g, now) {
  text(L('별별야구', 'BB Baseball'), 24, hudY - 42, mono(22, 700), ink(0.92));
  const wmW = textW(L('별별야구', 'BB Baseball'), mono(22, 700));
  text('The Game', 24 + wmW + 10, hudY - 26, mono(11, 600), ink(0.42));
  if (game.screen === 'home') {
    // 서버 미연결이면 어디서 고치는지까지 알려준다 (맥과 같은 규칙)
    const off = online.tried && !online.identityId;
    const failed = off && online.enabled();
    const line = failed
      ? online.statusLine + L('  →  5 설정에서 서버 주소 확인', '  →  check the server address in Settings (5)')
      : online.statusLine;
    text(line, 26, hudY - 14, smallFont, failed ? RED() + '0.85)' : ink(0.45));
  }
  let rows = [];
  switch (game.screen) {
    case 'home':
      rows = [
        [L('1  경기 모드', '1  Game mode'), game.homeSel === 0],
        [L('2  홈런레이스', '2  Homerun Race'), game.homeSel === 1],
        [L('3  리더보드', '3  Leaderboard'), game.homeSel === 2],
        [L('4  나의 기록', '4  My stats'), game.homeSel === 3],
        [L('5  설정 — 닉네임·온라인 참여·약관', '5  Settings — nickname · online · terms'), game.homeSel === 4],
      ];
      break;
    case 'settings': {
      const nick = localStorage.getItem('nickname') ?? online.nickname();
      const srv = localStorage.getItem('serverURL') ?? L('공식 서버 (기본)', 'Official server (default)');
      rows = [
        [L('1  닉네임      ', '1  Nickname    ') + (online.enabled() ? nick : nick + L('  (오프라인)', '  (offline)')), game.settingsSel === 0],
        [L('2  온라인 참여  ', '2  Online play ') + (online.enabled()
            ? L('켜짐 — 리더보드에 닉네임 공개', 'On — nickname shown on leaderboards')
            : L('꺼짐 — 아무것도 전송하지 않음', 'Off — nothing is ever sent')), game.settingsSel === 1],
        [L('3  서버 주소    ', '3  Server      ') + (srv.length > 30 ? srv.slice(0, 30) + '…' : srv), game.settingsSel === 2],
        [L('4  내 기록 삭제 — 서버에서 지웁니다', '4  Delete my records — removed from the server'), game.settingsSel === 3],
        [L('5  약관 및 개인정보 처리방침', '5  Terms & privacy policy'), game.settingsSel === 4],
        [L('6  부적절한 닉네임 신고', '6  Report a nickname'), game.settingsSel === 5],
        [L('7  언어        ', '7  Language    ') + appLanguageLabel(), game.settingsSel === 6],
        [online.statusLine, false],
      ];
      break;
    }
    case 'matchMenu':
      rows = [
        [L('1  봇 대전', '1  vs Bot'), game.matchSel === 0],
        [L('2  온라인 PvP', '2  Online PvP'), game.matchSel === 1],
      ];
      break;
    case 'matchSetup':
      rows = [
        [L('이닝      ', 'Innings   ') + `◂ ${game.matchInnings} ▸`, game.setupSel === 0],
        [L('난이도    ', 'Difficulty ') + `◂ ${DUEL_LEVELS[game.duelLevel].label(L)} ▸`, game.setupSel === 1],
        [L('궤적      ', 'Physics   ') + `◂ ${game.physChaos ? L('물리 위반', 'arcade') : L('물리 준수', 'realistic')} ▸`, game.setupSel === 2],
        ['', false],
        [L('Space 경기 시작', 'Space to start'), false],
      ];
      break;
  }
  const rowH = 20, rowsY = hudY;
  rows.forEach(([label, sel], i) => {
    if (label) {
      text((sel ? '▸ ' : '  ') + label, 28, rowsY + i * rowH, hudFont, ink(sel ? 1 : 0.55));
    }
    reg({ x: 20, y: rowsY + i * rowH - 2, w: W * 0.6, h: rowH }, { row: i });
  });
  const hint =
    game.screen === 'home' ? L('↑↓ 선택 · Space 확인 (클릭도 됩니다)', '↑↓ select · Space confirm (click works too)')
    : game.screen === 'matchMenu' ? L('1/2 선택 · Esc 뒤로', '1/2 select · Esc back')
    : game.screen === 'settings' ? L('1~7 또는 ↑↓+Space 로 변경 · Esc 뒤로', '1–7 or ↑↓+Space to change · Esc back')
    : L('↑↓ 항목 · ◂▸ 변경 · Space 시작 · Esc 뒤로', '↑↓ item · ◂▸ change · Space start · Esc back');
  text(hint, 28, rowsY + Math.max(rows.length, 3) * rowH + 8, smallFont, ink(0.4));
  if (game.menuNotice) {
    text(game.menuNotice, 28, rowsY + Math.max(rows.length, 3) * rowH + 24, smallFont, ink(0.55));
  }
  // 메뉴는 캐릭터를 오른쪽으로 비켜 세운다 (항목과 배트가 안 겹치게)
  drawBatter(W * 0.70, g, 1.02, now);
  drawPitcher(W * 0.90, g, 0.98, now);
}

// ═══ 경기 스코어보드 (main.swift drawDuelScoreboard) ═══
function drawDuelScoreboard(hudY) {
  const oppName = L('봇', 'Bot');
  const cellW = 22, nameW = 34, left = 18;
  const maxCells = Math.max(3, Math.floor((W * 0.46 - nameW - 34) / cellW));
  const shown = Math.min(game.dInnT, maxCells);
  const first = Math.max(0, Math.min(game.dInn, game.dInnT) - shown);
  const truncated = first > 0;
  const colX = (i) => left + nameW + i * cellW + cellW / 2;
  const totalX = colX(shown) + 10;
  const cellText = (arr, live, i) => {
    if (i < arr.length) return `${arr[i]}`;
    if (live && i === arr.length) return `${game.curHalfRuns}`;
    return '-';
  };
  const centered = (t, x, y, font, color) => text(t, x, y, font, color, 'center');

  for (let i = 0; i < shown; i++) {
    centered(`${first + i + 1}`, colX(i), hudY - 12, smallFont, ink(0.45));
  }
  centered('R', totalX, hudY - 12, smallFont, ink(0.6));
  if (truncated) centered('«', left + nameW - 8, hudY - 12, smallFont, ink(0.45));
  ctx.strokeStyle = ink(0.22); ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, hudY + 1); ctx.lineTo(totalX + 16, hudY + 1); ctx.stroke();

  const rows = [
    [L('나', 'Me'), game.myInnRuns, duel.myBat(), duel.myTotal()],
    [oppName, game.botInnRuns, !duel.myBat(), duel.botTotal()],
  ];
  rows.forEach(([name, arr, atBat, total], i) => {
    const y = hudY + 5 + i * 19;
    if (atBat) {
      ctx.fillStyle = ORANGE() + '0.13)';
      ctx.fillRect(left - 4, y - 2, totalX + 20 - left, 18);
      text('▶', left - 2, y + 3, mono(8, 700), ORANGE() + '1)');
    }
    text(name, left + 10, y, hudFont, ink(atBat ? 0.9 : 0.6));
    for (let c = 0; c < shown; c++) {
      centered(cellText(arr, atBat, first + c), colX(c), y, hudFont, ink(0.8));
    }
    centered(`${total}`, totalX, y - 2, mono(15, 900), ink(atBat ? 0.95 : 0.7));
  });

  const rx = totalX + 44;
  const inningText = KO ? `${Math.min(game.dInn, game.dInnT)}회${game.halfTop ? '초' : '말'}`
                        : `${game.halfTop ? 'Top' : 'Bot'} ${Math.min(game.dInn, game.dInnT)}`;
  text(inningText, rx, hudY - 10, mono(13, 700), ink(0.85));
  const sub = `${duel.myBat() ? L('내 공격', 'Offense') : L('내 수비', 'Defense')} · ${DUEL_LEVELS[game.duelLevel].label(L)}`;
  text(sub, rx, hudY + 8, smallFont, ink(0.45));

  const dotRow = (label, n, total, x, y) => {
    text(label, x, y, smallFont, ink(0.5));
    for (let i = 0; i < total; i++) {
      const cx = x + 20 + i * 9, cy = y + 6;
      ctx.beginPath(); ctx.arc(cx, cy, 3.2, 0, 7);
      if (i < n) { ctx.fillStyle = ink(0.82); ctx.fill(); }
      else { ctx.strokeStyle = ink(0.35); ctx.lineWidth = 1; ctx.stroke(); }
    }
  };
  const cx0 = Math.min(rx + 96, W - 130);
  dotRow('B', game.dB, 3, cx0, hudY - 12);
  dotRow('S', game.dS, 2, cx0, hudY + 2);
  dotRow('O', game.dOuts, 3, cx0, hudY + 16);

  // 주자 다이아몬드 (2루 위 · 3루 좌 · 1루 우)
  const dcx = Math.min(cx0 + 78, W - 30), dcy = hudY + 4;
  for (const [ox, oy, idx] of [[0, -11, 1], [-13, 2, 2], [13, 2, 0]]) {
    const px = dcx + ox, py = dcy + oy;
    ctx.beginPath();
    ctx.moveTo(px, py - 5.5); ctx.lineTo(px + 5.5, py);
    ctx.lineTo(px, py + 5.5); ctx.lineTo(px - 5.5, py);
    ctx.closePath();
    if (game.dBases[idx]) { ctx.fillStyle = ink(0.85); ctx.fill(); }
    else { ctx.strokeStyle = ink(0.4); ctx.lineWidth = 1.2; ctx.stroke(); }
  }
}

// 조작 안내 — 키캡 배지 + 설명 (시안 B, main.swift GuideSeg)
function drawGuide(hudY) {
  const gy = hudY - (game.mode === 'duel' ? 30 : 14);
  const keyFont = mono(11, 700), txtFont = mono(10, 600);
  const courseLabel = { random: L('랜덤', 'Random'), high: L('위', 'High'), low: L('아래', 'Low') }[game.pitchCourse];
  const segs = game.mode === 'duel'
    ? (duel.myBat()
       ? [['t', L('공격:', 'Offense:')], ['k', 'Space'], ['t', L('스윙', 'swing')]]
       : [['t', L('수비:', 'Defense:')], ['k', '1'], ['t', '~'], ['k', '4'],
          ['t', L('구종 선택 ·', 'pitch ·')], ['k', '↑↓'],
          ['t', L(`볼 코스 [${courseLabel}]`, `ball course [${courseLabel}]`)]])
    : [['k', 'Space'], ['t', L('— 공에 타이밍을 맞춰 스윙', '— swing in time with the pitch')]];
  let x = 18;
  for (const [kind, s] of segs) {
    if (kind === 'k') {
      const kw = textW(s, keyFont);
      ctx.fillStyle = ink(0.06);
      ctx.strokeStyle = ink(0.55); ctx.lineWidth = 1.1;
      roundedRect(x, gy - 3, kw + 10, 17, 4); ctx.fill();
      roundedRect(x, gy - 3, kw + 10, 17, 4); ctx.stroke();
      text(s, x + 5, gy - 1, keyFont, ink(0.92));
      x += kw + 10 + 4;
    } else {
      text(s, x, gy, txtFont, ink(0.88));
      x += textW(s, txtFont) + 5;
    }
  }
}

// ═══ 종료 화면들 ═══
function drawRaceOver(sum, now) {
  const bestHR = Math.max(game.racePrevBestHR, sum.homeruns);
  const bestDist = Math.max(game.racePrevBestDist, sum.maxDistance);
  const t = game.raceEndedAt > 0 ? now - game.raceEndedAt : 9999;
  const appear = Math.min(1, Math.max(0, t / 260));
  const rise = (1 - appear) * 10;
  ctx.globalAlpha = 0.97;
  ctx.fillStyle = bg(); ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;
  if (game.raceNewHigh && game.raceEndedAt > 0) drawFireworks(40, t, true);
  const cx = W / 2;
  const c = (str, y, font, color) => text(str, cx, y + rise, font, color, 'center');
  c('GAME OVER', 26, mono(26, 800), ink(0.9 * appear));
  c(L('최종 점수', 'Final score'), 74, smallFont, ink(0.5 * appear));
  c(L(`${sum.homeruns}홈런`, `${sum.homeruns} HR`), 88, mono(46, 900), ink(0.95 * appear));
  if (game.raceNewHigh) {
    const pulse = 0.75 + 0.25 * Math.sin(now / 170);
    c('★ NEW HIGH SCORE ★', 146, mono(17, 700), ORANGE() + `${pulse * appear})`);
    c(L(`이전 최고 ${game.racePrevBestHR}홈런`, `Previous best ${game.racePrevBestHR} HR`),
      170, smallFont, ink(0.5 * appear));
  } else {
    c(L('개인 최고', 'Personal best'), 148, smallFont, ink(0.5 * appear));
    c(L(`${bestHR}홈런 · ${bestDist}m`, `${bestHR} HR · ${bestDist}m`),
      164, mono(16, 600), ink(0.75 * appear));
  }
  const tail = L(`최고 비거리 ${sum.maxDistance}m · 타석 ${sum.totalAtBats}`,
                 `Longest ${sum.maxDistance}m · At-bats ${sum.totalAtBats}`)
    + L(` · 평균 오차 ${Math.round(sum.avgTimingError)}ms`, ` · avg error ${Math.round(sum.avgTimingError)}ms`);
  c(tail, H - 52, smallFont, ink(0.5 * appear));
  const hint = (game.onlineStatus ? game.onlineStatus + ' · ' : '')
    + L('Space 새 세션 · Esc 홈', 'Space new session · Esc home');
  c(hint, H - 34, smallFont, ink(0.5 * appear));
}

function drawDuelOver(now) {
  const m = game.myStats, o = game.oppStats;
  const oppName = L('봇', 'Bot');
  const my = duel.myTotal(), bot = duel.botTotal();
  const iWon = my > bot, oppWon = bot > my;
  const t = game.duelEndedAt > 0 ? now - game.duelEndedAt : 9999;
  const appear = Math.min(1, Math.max(0, t / 260));
  const rise = (1 - appear) * 10;
  ctx.globalAlpha = 0.97;
  ctx.fillStyle = bg(); ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;
  if (iWon || oppWon) drawFireworks(34, t, iWon);
  const cx = W / 2;
  const c = (str, y, font, color) => text(str, cx, y + rise, font, color, 'center');
  const verdictColor = iWon ? ORANGE() + `${appear})` : ink((oppWon ? 0.55 : 0.75) * appear);
  c(iWon ? 'YOU WIN' : oppWon ? 'YOU LOSE' : 'DRAW', 18, mono(26, 800), verdictColor);
  c(L(`나 ${my}  :  ${bot} ${oppName}`, `Me ${my}  :  ${bot} ${oppName}`), 52, mono(34, 900), ink(0.95 * appear));
  const scoreRow = (name, arr, total) => {
    const cells = [];
    for (let i = 0; i < game.dInnT; i++) {
      cells.push(i < arr.length ? String(arr[i]).padStart(2) : ' -');
    }
    return `${name} ${cells.join(' ')} │ ${total}`;
  };
  c(`${scoreRow(L('나', 'Me'), game.myInnRuns, my)}    ${scoreRow(oppName, game.botInnRuns, bot)}`,
    92, smallFont, ink(0.5 * appear));

  const risp = (s) => (s.rispAB > 0 ? `${s.rispHit}/${s.rispAB}` : '-');
  const gw = (s, won) => (won && s.gwDesc ? s.gwDesc : '-');
  const rows = [
    ['', L('나', 'Me'), oppName],
    [L('안타·2루·3루·홈런', '1B·2B·3B·HR'), `${m.h1}·${m.h2}·${m.h3}·${m.hr}`, `${o.h1}·${o.h2}·${o.h3}·${o.hr}`],
    [L('삼진 / 볼넷', 'K / BB'), `${m.so} / ${m.bb}`, `${o.so} / ${o.bb}`],
    [L('선구안', 'Eye'), `${statEyePct(m)}%`, `${statEyePct(o)}%`],
    [L('평균 타이밍', 'Avg timing'), `±${statAvgOff(m)}ms`, `±${statAvgOff(o)}ms`],
    [L('잔루', 'LOB'), `${m.lob}`, `${o.lob}`],
    [L('득점권', 'RISP'), risp(m), risp(o)],
    [L('결승타', 'Game winner'), gw(m, iWon), gw(o, oppWon)],
  ];
  const rowH = 14, statTop = 112, hintY = H - 22;
  const fit = Math.max(0, Math.floor((hintY - 8 - statTop) / rowH));
  const px = cx - 155;
  rows.slice(0, fit).forEach(([a, b, c2], i) => {
    const y = statTop + i * rowH + rise;
    text(a, px, y, smallFont, ink(0.5 * appear));
    text(b, px + 150, y, smallFont, ink((i === 0 ? 0.5 : 0.8) * appear));
    text(c2, px + 240, y, smallFont, ink((i === 0 ? 0.5 : 0.8) * appear));
  });
  c((game.onlineStatus ? game.onlineStatus + ' · ' : '')
    + L('Space 새 경기 · Esc 홈', 'Space new game · Esc home'), hintY, smallFont, ink(0.5 * appear));
}

// 공수 교대 알림 (시안 C — 카드형)
function drawHalfChangeCard(t) {
  const dur = HALF_CHANGE_MS;
  if (t < 0 || t >= dur) return;
  const fade = Math.min(1, Math.min(t / 150, (dur - t) / 300));
  const card = { x: W / 2 - 150, y: H / 2 - 38, w: 300, h: 76 };
  ctx.globalAlpha = 0.97 * fade;
  ctx.fillStyle = bg();
  roundedRect(card.x, card.y, card.w, card.h, 10); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = ORANGE() + `${0.9 * fade})`; ctx.lineWidth = 2;
  roundedRect(card.x, card.y, card.w, card.h, 10); ctx.stroke();
  text(L('공수 교대', 'Switch sides'), W / 2, card.y + 12, mono(26, 900), ink(0.9 * fade), 'center');
  const next = duel.myBat()
    ? L('이제 내 공격 — Space 로 스윙', 'You bat now — Space to swing')
    : L('이제 내 수비 — 1~4 로 구종 선택', 'You pitch now — 1–4 to choose');
  text(next, W / 2, card.y + 48, mono(11, 500), ORANGE() + `${fade})`, 'center');
}

// 맥 drawFireworks 포팅 — 좌우 가장자리 방사선 폭죽 (승리 컬러 / 패배 흑백)
function drawFireworks(hudY, t, color) {
  if (t < 0 || t >= 3500) return;
  const palette = ['rgba(255,59,48,', 'rgba(255,149,0,', 'rgba(255,204,0,',
                   'rgba(40,205,65,', 'rgba(255,45,85,', 'rgba(89,173,196,'];
  const grays = [0.60, 0.38, 0.72, 0.45, 0.55, 0.32];
  for (let b = 0; b < 7; b++) {
    const bt = t - b * 340;
    if (bt <= 0 || bt >= 1100) continue;
    const u = bt / 1100;
    const side = b % 2 === 0 ? 0.10 : 0.74;
    const fx = W * (side + ((b * 0.071) % 0.16));
    const fy = hudY + 6 + ((b * 47) % 64);
    const a = (1 - u) * (color ? 1 : 0.7);
    ctx.strokeStyle = color ? palette[b % 6] + a + ')' : ink(grays[b % 6] * a);
    ctx.lineWidth = color ? 1.6 : 1.3;
    const r = easeOut(u) * (color ? 30 : 21);
    ctx.beginPath();
    for (let i = 0; i < 11; i++) {
      const ang = (i / 11) * Math.PI * 2 + b * 0.6;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      ctx.moveTo(fx + dx * r * 0.55, fy + dy * r * 0.55);
      ctx.lineTo(fx + dx * r, fy + dy * r);
    }
    ctx.stroke();
  }
}

// ═══ 리더보드 v2 — 포디움 top3 · 4~10위 · 더보기 (main.swift 포팅) ═══
function drawLeaderboard() {
  const page = LB_PAGES[game.lbPage];
  const entries = game.lbCache[lbBoardKey()];
  const nick = (e) => shortDisplay(e.display ?? '?');
  const score = (e) => {
    const unit = page.unit();
    const glue = (KO || unit === 'm' || unit === '%') ? '' : ' ';
    return `${e.score ?? 0}${glue}${unit}`;
  };
  const inn = page.hasInnings ? L(`  · ${game.lbInnings}이닝(↑↓)`, `  · ${game.lbInnings} innings (↑↓)`) : '';
  const chs = page.hasChaos ? `  · ${game.lbChaos ? L('물리 위반', 'arcade') : L('물리 준수', 'realistic')}(C)` : '';
  const title = `◂  ${page.title()}${inn}${chs}  ▸`;
  text(title, 24, 14, mono(15, 700), ink(0.92));
  if (24 + textW(title, mono(15, 700)) < W - 66)
    text(`${game.lbPage + 1} / ${LB_PAGES.length}`, W - 60, 18, smallFont, ink(0.45));
  reg({ x: 0, y: 0, w: W * 0.30, h: 44 }, 'lbPrev');
  reg({ x: W * 0.30, y: 0, w: W * 0.40, h: 44 }, 'lbNext');
  if (page.hasChaos) reg({ x: W * 0.70, y: 0, w: W * 0.30, h: 44 }, 'lbChaos');

  if (!game.lbMore && entries && entries.length > 10) {
    ctx.strokeStyle = ink(0.4); ctx.lineWidth = 1;
    roundedRect(W - 110, 40, 86, 20, 5); ctx.stroke();
    reg({ x: W - 110, y: 40, w: 86, h: 20 }, 'lbMore');
    text(L('더보기 M ▸', 'More M ▸'), W - 100, 44, smallFont, ink(0.6));
  }

  const footTip = () => {
    const cTip = page.hasChaos ? L(' · C 궤적', ' · C physics') : '';
    return L('◂ ▸ 항목 이동 · M 더보기' + cTip + ' · Esc 홈', '◂ ▸ boards · M more' + cTip + ' · Esc home');
  };
  if (!entries) {
    const failed = game.lbFailed.has(lbBoardKey());
    const msg = !online.enabled()
      ? L("오프라인 모드입니다 — 설정에서 온라인 참여를 켜세요", "You're offline — enable online play in Settings")
      : failed ? L('서버에 연결하지 못했습니다 — R 로 다시 시도', 'Could not reach the server — press R to retry')
      : L('불러오는 중…', 'Loading…');
    text(msg, W / 2, H / 2 - 8, hudFont, ink(0.5), 'center');
    text(footTip(), 24, H - 22, smallFont, ink(0.45));
    return;
  }
  if (!entries.length) {
    text(L('아직 기록이 없습니다 — 첫 주인공이 되어 보세요', 'No records yet — be the first'),
      W / 2, H / 2 - 8, hudFont, ink(0.5), 'center');
    text(footTip(), 24, H - 22, smallFont, ink(0.45));
    return;
  }
  if (game.lbMore) {
    // 더보기: 그리드, ↑↓ 스크롤 — 행·열은 창 크기에서 유도
    const cols = Math.max(1, Math.min(3, Math.floor((W - 60) / 210)));
    const rows = Math.max(3, Math.floor((H - 30 - 52) / 20));
    const perPage = cols * rows;
    const colW = (W - 60) / cols;
    entries.slice(game.lbMoreOffset, game.lbMoreOffset + perPage).forEach((e, i) => {
      const col = Math.floor(i / rows), row = i % rows;
      const x = 30 + col * colW, y = 52 + row * 20;
      let label = `${e.rank ?? 0}. ${nick(e)}`;
      while (textW(label, smallFont) > colW - 70 && label.length > 4) label = label.slice(0, -2) + '…';
      text(label, x, y, smallFont, ink(0.75));
      text(score(e), x + colW - 62, y, smallFont, ink(0.75));
    });
    game.lbMorePage = perPage;
    text(`${game.lbMoreOffset + 1}~${Math.min(entries.length, game.lbMoreOffset + perPage)} / ${entries.length}`
      + L(' · ↑↓ 스크롤 · M/Esc 돌아가기', ' · ↑↓ scroll · M/Esc back'), 24, H - 22, smallFont, ink(0.45));
    return;
  }
  // 포디움 top3
  const cx = W / 2, base = 172;
  const podium = [
    [0, cx, 64, 'rgba(241,186,43,0.92)'],
    [1, cx - 165, 44, ink(0.32)],
    [2, cx + 165, 32, 'rgba(184,115,51,0.75)'],
  ];
  for (const [idx, px, h, color] of podium) {
    if (idx >= entries.length) continue;
    const e = entries[idx];
    ctx.fillStyle = color;
    roundedRect(px - 62, base - h, 124, h, 6); ctx.fill();
    text(`${idx + 1}`, px - 5, base - h + 6, mono(17, 800),
      isNight ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.95)');
    text(score(e), px, base - h - 22, mono(idx === 0 ? 15 : 12, 700), ink(0.92), 'center');
    text(nick(e), px, base - h - 37, smallFont, ink(0.6), 'center');
  }
  // 4~10위 — 두 열
  const twoCols = W >= 620;
  const listTop = 186, listBottom = H - 34;
  const listRows = Math.max(0, Math.floor((listBottom - listTop) / 14));
  const shown = entries.slice(3, 3 + (twoCols ? Math.min(7, listRows * 2) : Math.min(4, listRows)));
  shown.forEach((e, i) => {
    const col = twoCols && i >= listRows;
    const x = col ? W / 2 + 40 : 70;
    const yy = listTop + (col ? i - listRows : i) * 14;
    if (yy + 12 > listBottom) return;
    text(`${e.rank ?? 0}. ${nick(e)}`, x, yy, smallFont, ink(0.7));
    text(score(e), Math.min(x + 190, (col ? W : W / 2) - 56), yy, smallFont, ink(0.7));
  });
  const hidden = Math.max(0, Math.min(entries.length, 10) - 3 - shown.length);
  const cTip = page.hasChaos ? L(' · C 궤적', ' · C physics') : '';
  text(hidden > 0
    ? L(`◂ ▸ 항목 이동 · M 더보기(4위 이하 ${hidden}명 포함)${cTip} · Esc 홈`, `◂ ▸ boards · M more (+${hidden} below top 3)${cTip} · Esc home`)
    : L(`◂ ▸ 항목 이동 · M 더보기${cTip} · Esc 홈`, `◂ ▸ boards · M more${cTip} · Esc home`),
    24, H - 22, smallFont, ink(0.45));
}

// ═══ 나의 기록 ═══
function drawRecords() {
  const li = (k) => +(localStorage.getItem(k) ?? 0);
  text(L('나의 기록', 'My stats'), 24, 14, mono(15, 700), ink(0.92));
  text(online.display ? shortDisplay(online.display, 10) : L('오프라인', 'Offline'),
    W - 150, 18, smallFont, ink(0.45));
  const rank = (key) => (game.myRanks[key] != null ? (KO ? `${game.myRanks[key]}위` : `#${game.myRanks[key]}`) : '-');
  const eyeT = li('lifeEyeTotal');
  const eyePct = eyeT > 0 ? `${Math.round((li('lifeEyeGood') / eyeT) * 100)}%` : '-';
  const left = [
    [L('홈런레이스', 'Homerun Race'), ''],
    [L('세션', 'Sessions'), KO ? `${li('lifeSessions')}회` : `${li('lifeSessions')}`],
    [L('통산 홈런', 'Career HR'), KO ? `${li('lifeHR')}개` : `${li('lifeHR')}`],
    [L('최고 비거리', 'Longest HR'), `${li('bestDist')}m`],
    [L('최다 연속', 'Best streak'), KO ? `${li('lifeBestCombo')}연속` : `${li('lifeBestCombo')} in a row`],
    [L('홈런 보드', 'HR board'), rank('SESSION_HOMERUNS')],
    [L('비거리 보드', 'Distance board'), rank('BEST_DISTANCE')],
  ];
  const right = [
    [L('경기 모드', 'Game mode'), ''],
    [L('봇전 전적', 'vs Bot record'), KO ? `${li('matchW')}승 ${li('matchL')}패 ${li('matchD')}무`
       : `${li('matchW')}W ${li('matchL')}L ${li('matchD')}D`],
    [L('통산 안타', 'Career hits'), KO ? `${li('lifeDuelHits')}개` : `${li('lifeDuelHits')}`],
    [L('통산 홈런', 'Career HR'), KO ? `${li('lifeDuelHR')}개` : `${li('lifeDuelHR')}`],
    [L('삼진 / 볼넷', 'K / BB'), `${li('lifeDuelSO')} / ${li('lifeDuelBB')}`],
    [L('통산 선구안', 'Career eye'), eyePct],
    [L('랭크 보드', 'Ranked board'), rank('PVP_WINS')],
  ];
  const top = 52, footer = H - 30;
  const rowH = Math.min(25, Math.max(16, (footer - top) / Math.max(left.length, right.length)));
  [left, right].forEach((items, col) => {
    const x = col === 0 ? 48 : W / 2 + 36;
    items.forEach(([label, value], i) => {
      const y = top + i * rowH;
      if (!value) {
        text(label, x - 12, y, mono(12, 600), ink(0.85));
        ctx.strokeStyle = ink(0.2); ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - 12, y + rowH * 0.72); ctx.lineTo(x + 230, y + rowH * 0.72); ctx.stroke();
      } else {
        text(label, x, y + 3, smallFont, ink(0.5));
        text(value, x + 110, y, hudFont, ink(0.9));
      }
    });
  });
  text(L('통산 기록은 이 버전부터 집계됩니다 · Esc 홈', 'Career stats start from this version · Esc home'),
    24, H - 22, smallFont, ink(0.45));
}

// ═══ 온보딩 — 온라인 참여를 묻고 나서 통신한다 ═══
function drawOnboardScreen() {
  const x = 26;
  text(L('별별야구', 'BB Baseball'), x, 20, mono(20, 700), ink(0.92));
  const wm = textW(L('별별야구', 'BB Baseball'), mono(20, 700));
  text('The Game', x + wm + 10, 32, mono(11, 600), ink(0.42));
  text(L('온라인 리더보드에 참여하시겠어요?', 'Join the online leaderboards?'),
    x, 62, mono(14, 600), ink(0.9));
  [L('직접 정한 닉네임과 임의 기기 식별자를 리더보드 순위 표시에 씁니다.', 'A nickname you choose and a random device ID show rankings.'),
   L('이름·이메일은 보내지 않습니다. 기록은 언제든 지울 수 있습니다.', 'Your name and email are never sent. Delete anytime.')]
    .forEach((t2, i) => text(t2, x, 90 + i * 18, mono(12), ink(0.72)));
  const opts = [
    L('1  닉네임 정하고 참여', '1  Pick a nickname and join'),
    L('2  오프라인으로 플레이 — 아무것도 전송하지 않음', '2  Play offline — nothing is ever sent'),
    L('3  약관 및 개인정보 처리방침 보기', '3  View terms & privacy policy'),
  ];
  opts.forEach((t2, i) => {
    const sel = game.onboardSel === i;
    const y = 140 + i * 24;
    if (sel) { ctx.fillStyle = ink(0.08); ctx.fillRect(x - 8, y - 4, W - 2 * x + 16, 22); }
    text(t2, x, y, mono(13, sel ? 700 : 400), ink(sel ? 0.95 : 0.6));
    reg({ x: x - 8, y: y - 4, w: W - 2 * x + 16, h: 22 }, { row: i });
  });
  text(L('참여하지 않아도 모든 게임 모드를 그대로 이용할 수 있습니다.', 'Every game mode works fully without joining.'),
    x, H - 34, smallFont, ink(0.45));
}

// ═══ 약관·개인정보 처리방침 전문 ═══
function drawTermsScreen() {
  const x = 26;
  text(L('개인정보 처리방침', 'Privacy policy'), x, 14, mono(15, 700), ink(0.92));
  const lines = KO ? TERMS_KO : TERMS_EN;
  const top = 44, bottom = H - 26, rowH = 16;
  const visible = Math.max(1, Math.floor((bottom - top) / rowH));
  const maxScroll = Math.max(0, lines.length - visible);
  const sc = Math.min(Math.max(0, game.termsScroll), maxScroll);
  game.termsScroll = sc;
  for (let i = 0; i < Math.min(visible, lines.length - sc); i++) {
    const raw = lines[sc + i];
    if (!raw) continue;
    const head = raw.startsWith('# ');
    text(head ? raw.slice(2) : raw, x, top + i * rowH,
      head ? mono(12, 700) : mono(11.5), head ? ink(0.88) : ink(0.68));
  }
  const more = maxScroll > 0
    ? L('↑↓ 스크롤', '↑↓ scroll') + `  (${sc + visible >= lines.length ? L('끝', 'end') : `${Math.round((sc / maxScroll) * 100)}%`})` + L('  ·  Esc 뒤로', '  ·  Esc back')
    : L('Esc 뒤로', 'Esc back');
  text(more, x, H - 20, smallFont, ink(0.45));
}

// 조작 안내 — 불투명 배경 (뒤가 비치면 글이 안 읽힌다)
function drawHelp() {
  ctx.fillStyle = bg(); ctx.fillRect(0, 0, W, H);
  const x = 26;
  const keyF = mono(12, 700), bodyF = mono(11.5);
  text(L('조작 안내', 'Controls'), x, 14, mono(15, 700), ink(0.92));
  const rows = game.mode === 'duel' ? [
    ['', L('내가 공격일 때', 'When batting')],
    ['Space', L('스윙', 'Swing')],
    ['', ''],
    ['', L('내가 수비일 때', 'When pitching')],
    ['1 / 2', L('직구 — 스트라이크 / 볼', 'Fastball — strike / ball')],
    ['3 / 4', L('변화구 — 스트라이크 / 볼', 'Breaking ball — strike / ball')],
    ['↑ ↓', L('볼을 존 위·아래 어디로 뺄지 미리 정해 둔다', 'Pre-set whether a ball misses high or low')],
    ['', L('  한 번 정하면 유지 · 같은 방향 다시 누르면 랜덤', '  Sticks until changed · same key again = random')],
    ['', L('  현재 설정은 화면 왼쪽 위 [ ] 안에 표시된다', '  Current setting shows in [ ] at top left')],
    ['', L('  스트라이크 위치는 조절할 수 없다 — 늘 랜덤', "  Strike locations can't be aimed — always random")],
    ['', ''],
    ['P / R / Esc', L('일시정지(투구 중 제외) · 다시 하기 · 나가기', 'Pause (not mid-pitch) · restart · leave')],
  ] : [
    ['Space', L('공에 타이밍을 맞춰 스윙', 'Swing in time with the pitch')],
    ['Esc', L('홈으로', 'Home')],
    ['', ''],
    ['', L('공의 궤적을 보고 타이밍을 잡는다.', "Time your swing off the ball's flight.")],
    ['', L('홈런을 칠수록 공이 조금씩 빨라진다.', 'Every home run makes the next pitch faster.')],
    ['', ''],
    ['', L('일시정지는 투구 사이에만 된다 — 공이 나는 중에는', 'Pausing works between pitches only — never while')],
    ['', L('화면을 멈춰 타이밍을 읽을 수 없게 막았다.', "a pitch is in flight, so timing can't be studied.")],
  ];
  const top = 44, bottom = H - 30;
  const blanks = rows.filter(([k, t2]) => !k && !t2).length;
  const rowH = Math.min(17, Math.max(12, (bottom - top - blanks * 8) / (rows.length - blanks)));
  let y = top;
  for (const [k, t2] of rows) {
    if (!k && !t2) { y += 8; continue; }
    if (!k) text(t2, x, y, t2.startsWith('  ') ? bodyF : keyF, t2.startsWith('  ') ? ink(0.68) : ink(0.85));
    else {
      text(k, x, y, keyF, ink(0.85));
      text(t2, x + 96, y + 0.5, bodyF, ink(0.68));
    }
    y += rowH;
  }
  text(L('? 또는 H · Esc 로 닫기', '? or H · Esc to close'), x, H - 22, smallFont, ink(0.45));
}

// ═══ 입력 ═══
// 판정은 event.timeStamp — performance.now() 와 같은 시간 기준(입력 발생 시각)이라
// 핸들러 지연이 판정에 섞이지 않는다 (iOS 의 UITouch.timestamp 와 같은 원칙).
addEventListener('keydown', (e) => {
  if (game.helpOpen) {
    if (['Escape', 'KeyH', 'Slash', 'Space', 'Enter'].includes(e.code)) closeHelp();
    e.preventDefault();
    return;
  }
  if ((e.code === 'KeyH' || e.code === 'Slash')
      && (game.screen === 'race' || game.screen === 'match')
      && game.phase !== 'idle' && game.phase !== 'ended') { openHelp(); return; }
  const space = e.code === 'Space' || e.key === ' ';
  if (space) e.preventDefault();

  switch (game.screen) {
    case 'onboard':
      if (e.code === 'ArrowUp') game.onboardSel = (game.onboardSel + 2) % 3;
      else if (e.code === 'ArrowDown') game.onboardSel = (game.onboardSel + 1) % 3;
      else if (/^Digit[1-3]$/.test(e.code)) { game.onboardSel = +e.code[5] - 1; finishOnboard(); }
      else if (space || e.code === 'Enter') finishOnboard();
      break;
    case 'settings':
      if (e.code === 'ArrowUp') game.settingsSel = (game.settingsSel + 6) % 7;
      else if (e.code === 'ArrowDown') game.settingsSel = (game.settingsSel + 1) % 7;
      else if (/^Digit[1-7]$/.test(e.code)) { game.settingsSel = +e.code[5] - 1; editSetting(game.settingsSel); }
      else if (space || e.code === 'Enter') editSetting(game.settingsSel);
      else if (e.code === 'Escape') game.screen = 'home';
      break;
    case 'leaderboard':
      if (e.code === 'ArrowLeft') lbMove(-1);
      else if (e.code === 'ArrowRight') lbMove(1);
      else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        const down = e.code === 'ArrowDown';
        if (game.lbMore) {
          const n = game.lbCache[lbBoardKey()]?.length ?? 0;
          game.lbMoreOffset = Math.max(0, Math.min(Math.max(0, n - game.lbMorePage),
            game.lbMoreOffset + (down ? game.lbMorePage : -game.lbMorePage)));
        } else if (LB_PAGES[game.lbPage].hasInnings) {
          const opts = [3, 6, 9];
          const i = opts.indexOf(game.lbInnings);
          game.lbInnings = opts[(i + (down ? 1 : 2)) % 3];
          lbFetch();
        }
      }
      else if (e.code === 'KeyC' && LB_PAGES[game.lbPage].hasChaos) { game.lbChaos = !game.lbChaos; lbFetch(); }
      else if (e.code === 'KeyM') { game.lbMore = !game.lbMore; game.lbMoreOffset = 0; }
      else if (e.code === 'KeyR') {
        game.lbFailed.delete(lbBoardKey());
        if (!online.identityId) online.retryNowIfOffline();
        lbFetch();
      }
      else if (e.code === 'Escape' || space) {
        if (game.lbMore) game.lbMore = false;
        else game.screen = 'home';
      }
      break;
    case 'records':
      if (e.code === 'Escape' || space) game.screen = 'home';
      break;
    case 'terms':
      if (e.code === 'ArrowUp') game.termsScroll -= 3;
      else if (e.code === 'ArrowDown') game.termsScroll += 3;
      else if (e.code === 'Escape' || space)
        game.screen = game.termsFrom === 'onboard' ? 'onboard' : 'settings';
      break;
    case 'home':
      if (e.code === 'ArrowUp') game.homeSel = (game.homeSel + 4) % 5;
      else if (e.code === 'ArrowDown') game.homeSel = (game.homeSel + 1) % 5;
      else if (/^Digit[1-5]$/.test(e.code)) { game.homeSel = +e.code[5] - 1; enterHome(); }
      else if (space || e.code === 'Enter') enterHome();
      break;
    case 'matchMenu':
      if (e.code === 'Digit1') { game.matchSel = 0; game.screen = 'matchSetup'; }
      else if (e.code === 'Digit2') {
        game.matchSel = 1;
        game.menuNotice = L('웹 버전 PvP는 준비 중입니다', 'PvP is coming soon on web');
      }
      else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') game.matchSel = 1 - game.matchSel;
      else if (space || e.code === 'Enter') {
        if (game.matchSel === 0) game.screen = 'matchSetup';
        else game.menuNotice = L('웹 버전 PvP는 준비 중입니다', 'PvP is coming soon on web');
      }
      else if (e.code === 'Escape') { game.screen = 'home'; game.menuNotice = ''; }
      break;
    case 'matchSetup':
      if (e.code === 'ArrowUp') game.setupSel = (game.setupSel + 2) % 3;
      else if (e.code === 'ArrowDown') game.setupSel = (game.setupSel + 1) % 3;
      else if (e.code === 'ArrowLeft') changeDuelSetting(game.setupSel, true);
      else if (e.code === 'ArrowRight') changeDuelSetting(game.setupSel, false);
      else if (space || e.code === 'Enter') startDuel();
      else if (e.code === 'Escape') game.screen = 'matchMenu';
      break;
    case 'race':
      if (space) {
        if (game.paused) { togglePause(); break; }
        if (game.phase === 'idle' || game.phase === 'ended') startSession();
        else swing(e.timeStamp);
      }
      else if (e.code === 'KeyR') startSession();
      else if (e.code === 'KeyP') togglePause();
      else if (e.code === 'Escape') leaveToHome();
      break;
    case 'match':
      if (space) {
        if (game.phase === 'ended') startDuel();
        else if (duel.myBat()) duel.duelSwing(e.timeStamp);
      }
      else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        // 다음 볼을 뺄 코스 — 같은 방향 다시 누르면 랜덤
        if (duel.myBat() || game.phase === 'ended') break;
        const want = e.code === 'ArrowUp' ? 'high' : 'low';
        game.pitchCourse = game.pitchCourse === want ? 'random' : want;
      }
      else if (e.code === 'Digit1') duel.choosePitch(true, true);
      else if (e.code === 'Digit2') duel.choosePitch(true, false);
      else if (e.code === 'Digit3') duel.choosePitch(false, true);
      else if (e.code === 'Digit4') duel.choosePitch(false, false);
      else if (e.code === 'KeyR') startDuel();
      else if (e.code === 'KeyP') togglePause();
      else if (e.code === 'Escape') leaveToHome();
      break;
  }
});

canvas.addEventListener('pointerdown', (e) => {
  const px = e.offsetX / scale, py = e.offsetY / scale;
  if (game.helpOpen) { closeHelp(); return; }
  const hitR = regions.slice().reverse().find(
    (r) => px >= r.x - 6 && px <= r.x + r.w + 6 && py >= r.y - 6 && py <= r.y + r.h + 6);
  if (hitR) {
    const a = hitR.action;
    if (a === 'helpToggle') { openHelp(); return; }
    if (a === 'pauseToggle') {
      if (game.canPause || game.paused) togglePause();
      else if (game.phase === 'pitching') game.judgeText = L('투구 중에는 멈출 수 없습니다', "Can't pause during a pitch");
      return;
    }
    if (a === 'lbPrev') { lbMove(-1); return; }
    if (a === 'lbNext') { lbMove(1); return; }
    if (a === 'lbChaos') { game.lbChaos = !game.lbChaos; lbFetch(); return; }
    if (a === 'lbMore') { game.lbMore = true; game.lbMoreOffset = 0; return; }
    if (typeof a === 'object' && 'row' in a) {
      const i = a.row;
      if (game.screen === 'onboard') { game.onboardSel = i; finishOnboard(); return; }
      if (game.screen === 'settings') { game.settingsSel = i; if (i <= 6) editSetting(i); return; }
      if (game.screen === 'home') { game.homeSel = i; enterHome(); }
      else if (game.screen === 'matchMenu') {
        game.matchSel = i;
        if (i === 0) game.screen = 'matchSetup';
        else game.menuNotice = L('웹 버전 PvP는 준비 중입니다', 'PvP is coming soon on web');
      } else if (game.screen === 'matchSetup') {
        if (i <= 2) { game.setupSel = i; changeDuelSetting(i, false); }
        else if (i === 4) startDuel();
      }
      return;
    }
  }
  if (game.screen === 'leaderboard') {
    if (game.lbMore) { game.lbMore = false; return; }
    game.lbFailed.delete(lbBoardKey());
    if (!online.identityId) online.retryNowIfOffline();
    lbFetch();
    return;
  }
  if (game.screen === 'records') { game.screen = 'home'; return; }
  // 필드 탭 = 스윙 (맥 Space 에 해당 — iOS handleTouch 와 같은 규칙)
  if (game.screen === 'race') {
    if (game.paused) { togglePause(); return; }
    if (game.phase === 'idle' || game.phase === 'ended') startSession();
    else swing(e.timeStamp);
  } else if (game.screen === 'match') {
    if (game.paused) { togglePause(); return; }
    if (game.phase === 'ended') startDuel();
    else if (duel.myBat()) duel.duelSwing(e.timeStamp);
  }
});

// 언어 토글 (페이지 헤더)
document.getElementById('lang').addEventListener('click', () => {
  KO = !KO;
  localStorage.setItem('appLang', KO ? 'ko' : 'en');
  updateChrome();
});
function syncPageTheme() {
  document.body.style.background = bg();
  document.body.style.color = isNight ? 'rgb(235,235,235)' : 'rgb(0,0,0)';
}
function updateChrome() {
  document.getElementById('title').textContent =
    L('별별야구 : The Game', 'BB Baseball : The Game');
  document.getElementById('hint').textContent =
    L('키보드 ↑↓·Space·1~4 · 클릭/탭도 됩니다', 'Keyboard ↑↓·Space·1–4 · click/tap works too');
  document.getElementById('lang').textContent = KO ? 'English' : '한국어';
  syncPageTheme();
}
updateChrome();

// ═══ 프레임 루프 ═══
function tick(now) {
  // helpOpen 은 틱을 막지 않는다 — 투구 중에 안내를 열면 그 공은 그냥 날아간다
  // (맥과 같은 규칙. canPause 가 막아서 시간을 벌 수 없다)
  if (game.paused) return;
  if (game.screen === 'race') raceTick(now);
  else if (game.screen === 'match') duel.duelTick(now);
}
// 로직 틱은 rAF 와 별개로 돌린다 — 탭이 백그라운드면 rAF 가 멈추는데,
// 게임 진행(타임아웃·다음 투구)까지 멈추면 안 된다 (맥판 pvpKeepAlive 원칙).
setInterval(() => tick(performance.now()), 33);
function frame(t) {
  tick(t);
  draw(game.paused ? game.pausedAt : t);   // 일시정지 중엔 화면도 멈춘다 (맥 now 규칙)
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 디버그/자동화 훅 — 상태 점검용 (게임 조작은 입력 경로로만)
window.__bb = { game, duel, online, startSession, startDuel, lbOpen, recordsOpen, draw, fitCanvas, tick, swing, enterRace,
                get summary() { return game.session.summary(); } };
