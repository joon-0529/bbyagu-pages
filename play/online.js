// 온라인 계층 — main.swift Online 포팅 (H6 3단계)
// 약속: 온라인 참여를 끄면 어떤 요청도 보내지 않는다 (삭제 요청만 예외).
// 실패 시 지수 백오프로 조용히 재시도한다 (H4).

export const DEFAULT_BASE = 'https://byeolbyeol-baseball.fly.dev';

export function makeOnline(L) {
  const o = {
    identityId: null,
    display: null,
    nextSeed: null,          // {id, seed}
    nextSeedAt: 0,           // D79: 받은(받으러 간) 시각 ms
    prefetchingSeed: false,
    statusLine: '',
    tried: false,
    connecting: false,
    reconnectAttempt: 0,
    reconnectScheduled: false,
  };
  const enabled = () => localStorage.getItem('onlineEnabled') === '1';
  const base = () => localStorage.getItem('serverURL') || DEFAULT_BASE;
  const defaultNick = () => L('플레이어', 'Player');
  const nickname = () => (localStorage.getItem('nickname') || defaultNick()).slice(0, 12);

  o.enabled = enabled;
  o.base = base;
  o.nickname = nickname;

  o.refreshStatusLine = () => {
    if (!enabled()) {
      o.statusLine = L('오프라인 모드 — 설정에서 온라인 참여를 켤 수 있습니다',
                       'Offline mode — enable online play in Settings');
    } else if (o.identityId) {
      o.statusLine = L('온라인 - ', 'Online — ') + (o.display ?? defaultNick());
    } else if (o.connecting) {
      o.statusLine = L('서버 연결 중… (첫 접속은 10초쯤 걸립니다)', 'Connecting… (first contact can take ~10s)');
    } else if (o.tried) {
      o.statusLine = L('오프라인 - 로컬 기록만 (자동으로 다시 시도합니다)', 'Offline — local records only (retrying automatically)');
    } else {
      o.statusLine = L('오프라인 - 서버 연결 대기', 'Offline — waiting for server');
    }
  };
  o.refreshStatusLine();

  // 상태 코드를 봐야 한다 — 4xx 본문을 성공으로 취급하면 무한 재시도가 된다.
  // 서버가 자동 정지에서 깨는 데 ~10초 — 5xx·네트워크 오류만 재시도.
  async function request(path, method, body, { timeout = 2500, retries = 0 } = {}) {
    if (!enabled() && !path.endsWith('/delete')) return null;
    for (let attempt = 0; ; attempt++) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeout);
        const resp = await fetch(base() + path, {
          method, signal: ctl.signal,
          body: body ? JSON.stringify(body) : undefined,
        });
        clearTimeout(t);
        if (resp.ok) return await resp.json();
        if (resp.status < 500) return null;              // 4xx 는 재시도 무의미
      } catch { /* 네트워크 오류 — 재시도 후보 */ }
      if (attempt >= retries) return null;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  function scheduleReconnect() {
    if (!enabled() || o.identityId || o.reconnectScheduled) return;
    o.reconnectScheduled = true;
    const delay = Math.min(120_000, 10_000 * 2 ** o.reconnectAttempt);   // 10·20·40·80·120초
    o.reconnectAttempt += 1;
    setTimeout(() => {
      o.reconnectScheduled = false;
      if (!enabled() || o.identityId || o.connecting) return;
      o.ensureIdentity();
    }, delay);
  }

  // 서버가 내려주는 전광판 문구 — 후원사 교체를 업데이트 없이 (D74). 참여 끈 사용자에겐 요청 안 함
  o.adBoardRemote = null;
  o.adBoardImg = null;      // 전광판 그림 (D76) — 우리 서버 /board.png 만
  o.fetchConfig = async () => {
    const r = await request('/config', 'GET', null, { timeout: 8000, retries: 1 });
    const t = typeof r?.adBoard === 'string' ? r.adBoard.slice(0, 12) : '';
    o.adBoardRemote = t || null;
    if (r?.adBoardImage > 0) {
      const img = new Image();
      img.onload = () => { o.adBoardImg = img; };
      img.src = `${base()}/board.png?v=${r.adBoardImage}`;
    } else o.adBoardImg = null;
  };
  o.ensureIdentity = async () => {
    o.fetchConfig();
    if (!enabled()) {
      o.tried = true;
      o.refreshStatusLine();
      return;
    }
    let deviceId = localStorage.getItem('deviceId');
    if (!deviceId) { deviceId = crypto.randomUUID(); localStorage.setItem('deviceId', deviceId); }
    o.connecting = true;
    o.refreshStatusLine();
    const r = await request('/identities', 'POST',
      { deviceId, nickname: nickname() }, { timeout: 12_000, retries: 2 });
    o.tried = true;
    o.connecting = false;
    if (!r || !r.identityId) {
      o.refreshStatusLine();
      scheduleReconnect();
      return;
    }
    o.reconnectAttempt = 0;
    o.identityId = r.identityId;
    localStorage.setItem('identityId', r.identityId);   // 오프라인 상태에서도 삭제 가능하게
    o.display = r.displayName ?? null;
    o.refreshStatusLine();
    o.prefetchSeed();
    o.flushPending();   // D94: 오프라인 동안 쌓인 결과
  };

  o.retryNowIfOffline = () => {
    if (enabled() && !o.identityId && !o.connecting) o.ensureIdentity();
  };

  o.prefetchSeed = async () => {
    if (!o.identityId || o.prefetchingSeed) return;
    o.prefetchingSeed = true;
    o.nextSeedAt = Date.now();
    const r = await request('/sessions', 'POST',
      { identityId: o.identityId, difficulty: 'NORMAL' });
    o.prefetchingSeed = false;
    if (r && r.sessionId && r.seed) { o.nextSeed = { id: r.sessionId, seed: r.seed }; o.nextSeedAt = Date.now(); }
  };
  // D79: 30분 넘게 묵은 시드(서버 만료 24h)·없는 시드(1분 뒤)는 다시 받는다 — main.swift 동일
  o.refreshSeedIfStale = () => {
    if (o.identityId && !o.flushing && Date.now() - o.lastFlushTry > 30_000) o.flushPending();   // D94
    if (!o.identityId || o.prefetchingSeed) return;
    const age = Date.now() - o.nextSeedAt;
    if (age > (o.nextSeed ? 30 * 60_000 : 60_000)) o.prefetchSeed();
  };
  // 레이스용 시드를 꺼내고 다음 것을 미리 받는다. 20시간 넘은 시드는 없는 것으로 (→ 로컬)
  o.takeSeed = () => {
    const ns = o.nextSeed;
    const fresh = ns && Date.now() - o.nextSeedAt < 20 * 3600_000;
    o.nextSeed = null; o.prefetchSeed();
    return fresh ? ns : null;
  };

  o.submit = async ({ sessionId, offsets, homeruns, maxDistance, maxCombo, totalAtBats, durationMs, seed, queueable }) => {
    o.lastChallengeCode = null;
    const r = await request(`/sessions/${sessionId}/submit`, 'POST', {
      atBats: offsets.map((offsetMs) => ({ offsetMs })),
      summary: { homeruns, maxDistance, maxCombo, totalAtBats },
      durationMs,
    }, { timeout: 8000, retries: 2 });   // D79: 서버가 멱등이라 재시도 안전
    if (!r) {   // D94: 끊겨도 버리지 않는다 — 대기열 (도전 판 제외)
      if (queueable && enabled()) {
        o.enqueue({ kind: 'race', seed, offsets, homeruns, maxDistance, maxCombo, totalAtBats });
        return L('서버에 연결하지 못함 — 연결되면 자동으로 올립니다', 'Could not reach server — will submit when back online');
      }
      return L('서버에 연결하지 못함 — 로컬 기록만', 'Could not reach server — local record only');
    }
    const verified = r.verified !== false;
    if (verified && !r.challenge) o.createChallenge(sessionId, homeruns, maxDistance);   // D89 공유 문구용
    o.lastChallengeResult = r.challenge ?? null;
    if (r.challenge) return verified ? L('도전 결과 기록됨', 'Challenge result recorded') : L('기록 미등재 — 검증을 통과하지 못했습니다', 'Not listed — failed verification');
    if (typeof r.rank === 'number') return L(`온라인 등재 — 홈런 보드 ${r.rank}위`, `Listed online — #${r.rank} on the HR board`);
    if (!verified) return L('기록 미등재 — 검증을 통과하지 못했습니다', 'Not listed — failed verification');
    return L('온라인 제출됨 — 순위권 밖', 'Submitted — outside the rankings');
  };

  o.fetchBoard = async (board, limit = 10) => {
    const r = await request(`/leaderboard?board=${board}&limit=${limit}`, 'GET', null,
      { timeout: 8000, retries: 1 });
    return r?.top ?? null;
  };

  // 지옥 봇전 결과 제출 — 서버는 타당성 검사만
  o.submitDuel = async ({ innings, myRuns, botRuns, chaos, durationMs }) => {
    // D94: 오프라인·전송 실패면 대기열에 넣고 연결되면 올린다
    const queued = () => {
      if (!enabled()) return L('오프라인 — 로컬 기록만', 'Offline — local record only');
      o.enqueue({ kind: 'duel', innings, myRuns, botRuns, chaos, durationMs });
      return L('오프라인 — 연결되면 자동으로 올립니다', 'Offline — will submit when back online');
    };
    if (!o.identityId) return queued();
    const r = await request('/duels', 'POST', {
      identityId: o.identityId, level: '지옥', innings, myRuns, botRuns, chaos, durationMs,
    });
    if (!r) return queued();
    return r.verified === false
      ? L('기록 미등재 — 검증을 통과하지 못했습니다', 'Not listed — failed verification')
      : L('지옥 봇전 보드 제출됨', 'Submitted to the Hell bot board');
  };

  // 개인정보보호법 제36조 — 성공하면 로컬 신원도 버려 완전히 새 사람이 된다
  o.deleteMyRecords = async () => {
    const id = o.identityId ?? localStorage.getItem('identityId');
    const deviceId = localStorage.getItem('deviceId');
    if (!id || !deviceId) {
      return { ok: true, msg: L('서버에 등록된 기록이 없습니다', 'No records on the server') };
    }
    const r = await request(`/identities/${id}/delete`, 'POST', { deviceId }, { timeout: 8000 });
    if (!r || r.deleted !== true) {
      return { ok: false, msg: L('삭제 실패 — 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
                                  'Delete failed — could not reach the server. Please try again shortly.') };
    }
    for (const k of ['deviceId', 'identityId', 'nickname']) localStorage.removeItem(k);
    o.identityId = null; o.display = null; o.nextSeed = null;
    o.statusLine = L('기록이 삭제되었습니다', 'Your records were deleted');
    const n = r.removedEntries ?? 0;
    return { ok: true,
      msg: L(`삭제 완료 — 리더보드 등재 ${n}건과 프로필이 서버에서 제거되었습니다. `
             + '백업에 남은 사본은 최대 30일 안에 함께 사라집니다.',
             `Done — ${n} leaderboard entries and your profile were removed from the server. `
             + 'Copies in backups disappear within 30 days.') };
  };

  // ── 오프라인·전송 실패 결과 대기열 (D94) — 온라인 참여를 켠 사람만. 연결되면 자동 제출 ──
  const PKEY = 'pendingResults';
  const readQ = () => { try { return JSON.parse(localStorage.getItem(PKEY) ?? '[]'); } catch { return []; } };
  const writeQ = (q) => localStorage.setItem(PKEY, JSON.stringify(q.slice(-20)));
  o.flushing = false; o.lastFlushTry = 0;
  o.enqueue = (item) => { if (enabled()) writeQ([...readQ(), { ...item, tries: 0 }]); };
  // 맨 앞 것부터. 서버가 받으면(등재 여부와 무관) 빼고 다음 것, 연결 실패면 멈춘다 — 8번 실패하면 버림
  o.flushPending = async () => {
    o.lastFlushTry = Date.now();
    if (!o.identityId || o.flushing) return;
    o.flushing = true;
    try {
      for (;;) {
        const it = readQ()[0];
        if (!it) return;
        const r = it.kind === 'race'
          ? await request('/sessions/offline', 'POST', { identityId: o.identityId, seed: it.seed,
              atBats: it.offsets.map((offsetMs) => ({ offsetMs })),
              summary: { homeruns: it.homeruns, maxDistance: it.maxDistance, maxCombo: it.maxCombo, totalAtBats: it.totalAtBats },
              durationMs: 0 }, { timeout: 10_000 })
          : await request('/duels', 'POST', { identityId: o.identityId, level: '지옥', innings: it.innings,
              myRuns: it.myRuns, botRuns: it.botRuns, chaos: it.chaos, durationMs: it.durationMs }, { timeout: 10_000 });
        const q = readQ();
        if (r) { q.shift(); writeQ(q); continue; }
        if (q[0]) { q[0].tries = (q[0].tries | 0) + 1; if (q[0].tries >= 8) q.shift(); writeQ(q); }
        return;
      }
    } finally { o.flushing = false; }
  };

  // ── 친구 (D91) ──
  o.fetchFriends = () => (o.identityId ? request(`/friends?identityId=${o.identityId}`, 'GET', null, { timeout: 6000 }) : Promise.resolve(null));
  o.addFriend = (display) => (o.identityId ? request('/friends', 'POST', { identityId: o.identityId, display }, { timeout: 6000 }) : Promise.resolve(null));
  o.removeFriend = (friendId) => (o.identityId ? request('/friends', 'DELETE', { identityId: o.identityId, friendId }, { timeout: 6000 }) : Promise.resolve(null));
  o.inviteFriend = async (friendId, code, playerId) =>
    !!(o.identityId && await request('/friends/invite', 'POST', { identityId: o.identityId, friendId, code, playerId }, { timeout: 6000 }));

  // ── 같은 시드 도전 (D89) ──
  o.lastChallengeCode = null;
  o.createChallenge = async (sessionId, hr, dist) => {
    if (!o.identityId) return;
    const r = await request('/challenges', 'POST', { identityId: o.identityId, sessionId, hr, dist });
    if (r?.code) o.lastChallengeCode = r.code;
  };
  o.challengeSession = async (code) => {
    if (!o.identityId) return null;
    const r = await request('/sessions', 'POST', { identityId: o.identityId, challenge: code }, { timeout: 8000, retries: 1 });
    if (!r?.sessionId || !r.seed || !r.challenge) return null;
    return { id: r.sessionId, seed: r.seed, display: String(r.challenge.display ?? '?'), hr: r.challenge.hr | 0, dist: r.challenge.dist | 0 };
  };

  // ── PvP 방 · 랜덤 매칭 (main.swift Online 의 PvP 부분) ──
  o.createRoom = (innings, level, chaos) =>
    request('/rooms', 'POST', { nickname: nickname(), settings: { innings, level, chaos } });
  o.joinRoom = (code) => request(`/rooms/${code}/join`, 'POST', { nickname: nickname() });
  // 전송이 실패하면 상대는 영원히 기다린다 — 턴제라 다음 기회가 없어 짧게 몇 번 재시도
  o.sendRoomEvent = async (code, pid, type, data = {}) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await request(`/rooms/${code}/events`, 'POST', { playerId: pid, type, data });
      if (r) return true;
      await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
    return false;
  };
  o.pollRoom = (code, pid, since) =>
    request(`/rooms/${code}/events?playerId=${pid}&since=${since}`, 'GET', null, { timeout: 30_000 });
  o.matchmake = () => (o.identityId ? request('/matchmake', 'POST', { identityId: o.identityId }) : Promise.resolve(null));
  o.pollTicket = (tid) => request(`/matchmake/${tid}`, 'GET', null, { timeout: 30_000 });
  o.cancelTicket = (tid) => request(`/matchmake/${tid}`, 'DELETE', null);
  o.submitPvpResult = async (code, pid, my, opp) => {
    const r = await request(`/rooms/${code}/result`, 'POST', { playerId: pid, my, opp });
    if (!r || typeof r.w !== 'number') return '';
    return L(`랭크 전적 ${r.w}승 ${r.l}패`, `Ranked record ${r.w}W ${r.l}L`);
  };

  return o;
}

// 약관·개인정보 처리방침 전문 — 맥 termsLines 와 조항 단위 1:1
export const TERMS_KO = [
  '# 무엇을 저장하나요',
  '· 닉네임 — 직접 입력한 것만. 계정 이름을 쓰지 않습니다.',
  '· 기기 식별자 — 앱이 임의로 만든 번호. 기기나 사람을 추적하지 않습니다.',
  '· 게임 기록 — 홈런 수·비거리·승패 등 리더보드에 필요한 값.',
  '',
  '# 왜 저장하나요',
  '· 리더보드 순위를 표시하려고',
  '· 같은 사람의 기록을 이어 붙이려고',
  '· 조작된 기록을 걸러내려고 (입력 로그 재현 검증)',
  '',
  '# 얼마나 보관하나요',
  '삭제를 요청하면 서버에서 즉시 지웁니다 (설정 → 내 기록 삭제).',
  '다만 기록을 되살리기 위한 백업에는 남아 있다가 함께 지워집니다 —',
  '서버 백업은 최대 3일, 운영자가 따로 보관하는 사본은 최대 30일입니다.',
  '그 뒤에는 어디에도 남지 않습니다.',
  '',
  '# 동의하지 않아도 되나요',
  '됩니다. 거부해도 모든 게임 모드를 그대로 이용할 수 있습니다.',
  '온라인 리더보드에만 오르지 않습니다. 언제든 설정에서 켜고 끌 수 있습니다.',
  '',
  '# 부적절한 닉네임을 봤다면',
  '설정 → 부적절한 닉네임 신고 를 눌러 알려 주세요. 확인 후 변경하거나',
  '삭제합니다. 명백한 욕설·사칭은 등록 단계에서 자동으로 걸러집니다.',
  '',
  '# 누구에게 넘기나요',
  '아무에게도 넘기지 않습니다. 추적·분석 도구를 넣지 않았습니다.',
  '이름·이메일·주소·결제 정보를 받지 않습니다.',
  '',
  '# 어디에 저장되나요',
  '일본 도쿄 리전의 서버 한 대. 통신은 HTTPS 로 암호화됩니다.',
  '',
  '# 문의',
  '개인정보 보호책임자 · 문의: bbyagucontact@gmail.com',
  '기록 삭제·정정 요청, 오류 신고를 이 주소로 받습니다.',
];
export const TERMS_EN = [
  '# What we store',
  '· Nickname — only what you typed. Your account name is never used.',
  "· Device ID — a random number the app made up. It doesn't track you or your device.",
  '· Game records — HR counts, distances, win/loss; what leaderboards need.',
  '',
  '# Why we store it',
  '· To show leaderboard rankings',
  '· To connect records from the same person',
  '· To filter out fabricated records (replay verification of input logs)',
  '',
  '# How long we keep it',
  "Ask for deletion and it's removed from the server immediately",
  '(Settings → Delete my records). Copies remain in recovery backups',
  'until they expire — server backups up to 3 days, operator copies up',
  'to 30 days. After that, nothing remains anywhere.',
  '',
  '# Can I decline?',
  "Yes. Every game mode works fully if you decline — you just won't",
  'appear on online leaderboards. Toggle it in Settings anytime.',
  '',
  '# Saw an inappropriate nickname?',
  'Settings → Report a nickname. We review, then rename or remove it.',
  'Obvious slurs and impersonations are filtered at registration.',
  '',
  '# Who we share it with',
  'No one. There are no tracking or analytics tools in this app.',
  'We never collect names, emails, addresses, or payment details.',
  '',
  '# Where it lives',
  'One server in Tokyo, Japan. All traffic is encrypted over HTTPS.',
  '',
  '# Contact',
  'Privacy officer · contact: bbyagucontact@gmail.com',
  'Deletion/correction requests and bug reports both welcome here.',
];
