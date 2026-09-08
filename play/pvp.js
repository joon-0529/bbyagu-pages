// 온라인 PvP (방 코드 1:1 · 랜덤 매칭) — main.swift Game 의 PvP 부분 포팅 (H6 5단계)
// 서버는 릴레이만 한다. 판정은 양쪽이 같은 코드(duel.js)로 재현하고, 타자 쪽만
// 결과(result) 이벤트를 보낸다. 투수 쪽은 랜덤 요소까지 확정한 투구(pitch)를 보낸다.
import { DUEL_LEVELS } from './duel.js';

const SWING_MS = 150, SWING_CONTACT = 0.42;   // app.js drawBatter 와 동일 (임팩트 시점 역산)

export function makePvp(game, duel, online, L, { shortDisplay, leaveToHome }) {
  const d = game;
  const now = () => performance.now();
  const opp = () => d.oppNick || L('상대', 'Opponent');
  const p = {};

  // 상대가 보낸 투구는 신뢰하지 않는다 — flightMs=0 같은 값으로 판정을 왜곡할 수 있다
  function dpFrom(x) {
    if (typeof x?.fast !== 'boolean' || typeof x.strike !== 'boolean'
        || !Number.isInteger(x.speed) || !Number.isInteger(x.flightMs)) return null;
    const num = (k, fb, lo, hi) => {
      const v = typeof x[k] === 'number' && Number.isFinite(x[k]) ? x[k] : fb;
      return Math.min(hi, Math.max(lo, v));
    };
    return {
      fast: x.fast, strike: x.strike, high: typeof x.high === 'boolean' ? x.high : true,
      inOff: num('inOff', 0, -14, 14), miss: num('miss', 10, 0, 18),
      speed: Math.min(220, Math.max(80, x.speed)),
      flightMs: Math.min(1500, Math.max(200, x.flightMs)),
      k: num('k', 2.0, 1.0, 6.0), rv: num('rv', 0.6, 0.2, 0.98), noise: num('noise', 0, -4, 4),
    };
  }

  const resetRoomState = () => {
    d.pvp = true; d.lastSeq = 0; d.pendingEvents = []; d.oppAlive = true; d.pvpStatus = '';
  };
  const sendFail = (ok) => { if (!ok) d.pvpStatus = L('전송 실패 — 연결을 확인하세요', 'Send failed — check your connection'); };
  d.pvpSend = (type, data) => { online.sendRoomEvent(d.roomCode, d.playerId, type, data).then(sendFail); };

  p.createRoom = async () => {
    d.pvpStatus = L('방 만드는 중…', 'Creating room…');
    d.isHost = true; d.ranked = false;
    const r = await online.createRoom(d.matchInnings, d.duelLevel, d.physChaos);
    if (!r?.code || !r.playerId) {
      d.pvpStatus = L('서버 연결 실패 — 설정에서 온라인 참여·서버 주소를 확인하세요', 'Server unreachable — check online play / server address in Settings');
      return;
    }
    if (d.screen !== 'pvpMenu') { online.sendRoomEvent(r.code, r.playerId, 'leave'); return; }   // 기다리다 떠났다
    d.roomCode = r.code; d.playerId = r.playerId;
    resetRoomState();
    d.screen = 'pvpLobby';
    startPolling();
  };

  p.joinRoom = async (code) => {
    d.pvpStatus = L('참가 중…', 'Joining…');
    d.isHost = false; d.ranked = false;
    const r = await online.joinRoom(code);
    if (!r?.playerId) { d.pvpStatus = L('참가 실패 — 코드를 다시 확인하세요', 'Join failed — check the code'); return; }
    if (d.screen !== 'pvpMenu') { online.sendRoomEvent(code, r.playerId, 'leave'); return; }
    d.roomCode = code; d.playerId = r.playerId;
    // 호스트 규칙 적용 (D17). 이닝은 화이트리스트, 난이도는 못 읽으면 중단 —
    // 내 설정을 쓰면 양쪽 판정 임계값이 갈려 스코어가 어긋난다
    const s = r.settings ?? {};
    d.matchInnings = [3, 6, 9].includes(s.innings) ? s.innings : 3;
    if (!DUEL_LEVELS[s.level]) {
      d.pvpStatus = L('방 설정을 읽을 수 없습니다 (서버 버전 불일치)', 'Cannot read room settings (server version mismatch)');
      return;
    }
    d.duelLevel = s.level;
    d.physChaos = !!s.chaos;
    d.oppNick = shortDisplay(String(r.hostNick ?? opp()), 8);
    resetRoomState();
    startPolling();
    duel.beginDuel(now());                                   // 게스트 = 말 공격, 먼저 투구
  };

  // 방 코드전 재경기 — 양쪽 동의 시 시작. 랭크전은 매칭으로만 성사되므로 제외
  p.requestRematch = () => {
    if (!d.pvp || d.ranked || !d.dOver || d.rematchMine) return;
    d.rematchMine = true;
    d.pvpSend('rematch', {});
    d.pvpStatus = d.rematchOpp ? '' : L('상대의 수락을 기다리는 중…', 'Waiting for opponent to accept…');
    startRematchIfAgreed();
  };
  function startRematchIfAgreed() {
    if (!d.rematchMine || !d.rematchOpp) return;
    d.rematchMine = false; d.rematchOpp = false; d.pvpStatus = '';
    duel.beginDuel(now());                                   // 방·역할·규칙은 그대로
  }

  p.leave = (goHome = true) => {
    if (d.matchTicket) { online.cancelTicket(d.matchTicket); d.matchTicket = null; }
    // 끝난 경기의 종료 화면을 닫는 것은 탈주가 아니다 — leave 를 보내면 서버가
    // 몰수 처리해 방금 이긴 경기가 패로 뒤집힐 수 있다
    if (d.pvp && !d.dOver) online.sendRoomEvent(d.roomCode, d.playerId, 'leave');
    d.pollActive = false; d.pvp = false; d.ranked = false;
    d.rematchMine = false; d.rematchOpp = false;
    d.pendingEvents = []; d.pvpStatus = '';
    // 게스트·랭크전은 호스트/표준 규칙이 내 설정을 덮었으므로 저장값 복원
    const lv = localStorage.getItem('duelLevel');
    d.duelLevel = DUEL_LEVELS[lv] ? lv : '보통';
    d.physChaos = localStorage.getItem('physChaos') === '1';
    const inn = +(localStorage.getItem('matchInnings') ?? 3);
    d.matchInnings = [3, 6, 9].includes(inn) ? inn : 3;
    if (goHome) leaveToHome();
  };

  // ═══ 랜덤 매칭 (D27) — 표준 규칙: 3이닝 · 어려움 · 물리 준수 ═══
  p.randomMatch = async () => {
    if (!online.identityId) {
      d.pvpStatus = L('서버 연결 필요 — 설정에서 온라인 참여를 확인하세요', 'Server connection required — check online play in Settings');
      return;
    }
    d.pvpStatus = L('매칭 등록 중…', 'Entering matchmaking…');
    const r = await online.matchmake();
    if (!r) { d.pvpStatus = L('서버 연결 실패', 'Server unreachable'); return; }
    if (r.matched === true) startRanked(r);                  // 대기자가 있었다 — 즉시 시작 (게스트)
    else if (r.ticket) {
      d.matchTicket = r.ticket; d.matchmakeStartAt = now();
      d.pvpStatus = ''; d.screen = 'pvpLobby';
      ticketLoop(r.ticket);
    } else d.pvpStatus = L('매칭 실패 — 잠시 후 다시 시도하세요', 'Matchmaking failed — try again shortly');
  };
  async function ticketLoop(tid) {
    while (d.matchTicket === tid) {
      const r = await online.pollTicket(tid);
      if (d.matchTicket !== tid) return;
      if (!r) { await new Promise((res) => setTimeout(res, 1000)); continue; }   // 오류 — 1초 뒤 재시도
      if (r.matched === true) { d.matchTicket = null; startRanked(r); return; }  // 나는 호스트(선공)
    }
  }
  function startRanked(r) {
    if (!r.code || !r.playerId) { d.pvpStatus = L('매칭 실패 — 잠시 후 다시 시도하세요', 'Matchmaking failed — try again shortly'); return; }
    if (d.screen !== 'pvpLobby' && d.screen !== 'pvpMenu') { online.sendRoomEvent(r.code, r.playerId, 'leave'); return; }
    d.roomCode = r.code; d.playerId = r.playerId;
    d.isHost = r.isHost === true;
    d.oppNick = shortDisplay(String(r.oppNick ?? opp()), 8);
    d.oppW = Number.isInteger(r.oppW) ? r.oppW : 0;
    d.oppL = Number.isInteger(r.oppL) ? r.oppL : 0;
    d.matchedAt = now();
    d.ranked = true;
    d.matchInnings = 3; d.duelLevel = '어려움'; d.physChaos = false;   // 표준 규칙
    resetRoomState();
    startPolling();
    duel.beginDuel(now());
  }

  // ═══ 롱폴링 — gen 으로 세션을 구분해 이전 방의 늦은 응답이 새 경기에 섞이지 않게 ═══
  function startPolling() {
    if (d.pollActive) return;
    d.pollActive = true; d.pollFails = 0;
    d.pollGen += 1;
    pollLoop(d.pollGen);
  }
  async function pollLoop(gen) {
    const code = d.roomCode, pid = d.playerId;
    while (d.pollActive && gen === d.pollGen && d.roomCode === code && d.playerId === pid) {
      const r = await online.pollRoom(code, pid, d.lastSeq);
      if (!d.pollActive || gen !== d.pollGen || d.roomCode !== code || d.playerId !== pid) return;
      if (!r) {
        d.pollFails += 1;
        if (d.pollFails >= 15) {                             // 방이 사라졌거나 서버 불통
          d.pollActive = false; d.oppAlive = false;
          d.pvpStatus = L('연결이 끊겼습니다 — Esc 로 나가세요', 'Connection lost — press Esc to leave');
          return;
        }
        await new Promise((res) => setTimeout(res, 1000));
        continue;
      }
      d.pollFails = 0;
      for (const e of r.events ?? []) {
        d.lastSeq = Math.max(d.lastSeq, e.seq | 0);
        if (e.from !== d.playerId) d.pendingEvents.push(e);
      }
      if (r.opp) d.oppAlive = r.opp.alive !== false;
    }
  }

  // 이벤트는 순서 큐 — 지금 소비할 수 없는 선두 이벤트가 있으면 멈춰서 순서를 지킨다
  p.processEvents = (t) => {
    while (d.pendingEvents.length) {
      const e = d.pendingEvents[0];
      const data = e.data ?? {};
      switch (e.type) {
        case 'start':
          d.pendingEvents.shift();
          d.oppNick = String((d.isHost ? data.guestNick : data.hostNick) ?? opp()).slice(0, 6);
          if (d.screen === 'pvpLobby') duel.beginDuel(t);
          break;
        case 'leave': {
          d.pendingEvents.shift();
          d.pollActive = false;
          if (d.screen === 'match') {
            const already = d.dOver;
            d.dOver = true; d.phase = 'ended'; d.duelEndedAt = t;
            if (!already) duel.saveMatchResult();             // 경기 도중 이탈 = 몰수승, 로컬 전적에도
            if (!already) d.pvpStatus = L('상대가 나갔습니다', 'Opponent left');
          } else {
            d.pvp = false; d.screen = 'matchMenu';
            d.pvpStatus = L('상대가 나갔습니다', 'Opponent left');
          }
          break;
        }
        case 'pitch': {
          if (d.screen !== 'match' || d.phase !== 'select' || !duel.myBat()) return;
          d.pendingEvents.shift();
          const pt = dpFrom(data);
          if (!pt) continue;
          d.dp = pt; d.judgeText = '';
          d.phase = 'ready'; d.readyAt = t + duel.dCfg().readyMs;
          d.swung = false;
          break;
        }
        case 'rematch':
          d.pendingEvents.shift();
          d.rematchOpp = true;
          if (!d.rematchMine) d.pvpStatus = L('상대가 재경기를 원합니다 — R', 'Opponent wants a rematch — R');
          startRematchIfAgreed();
          break;
        case 'result': {
          if (d.screen !== 'match' || duel.myBat() || (d.phase !== 'pitching' && d.phase !== 'ready')) return;
          d.pendingEvents.shift();
          const off = Number.isInteger(data.off) ? data.off : null;
          const sw = data.sw === true && off !== null;         // off 없는 스윙은 노스윙으로
          if (sw) {
            // 상대 스윙도 재생한다 — 실제 임팩트 시각(hitAt+오차)에 맞추되 이미 지났으면 지금
            const contactAt = d.hitAt + off;
            d.swingAt = Math.max(contactAt, t) - SWING_MS * SWING_CONTACT;
            d.swung = true;
          }
          duel.duelResolve(sw, off);
          break;
        }
        default:
          d.pendingEvents.shift();
      }
    }
  };

  return p;
}
