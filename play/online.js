// 온라인 계층 — main.swift Online 포팅 (H6 3단계)
// 약속: 온라인 참여를 끄면 어떤 요청도 보내지 않는다 (삭제 요청만 예외).
// 실패 시 지수 백오프로 조용히 재시도한다 (H4).

export const DEFAULT_BASE = 'https://byeolbyeol-baseball.fly.dev';

export function makeOnline(L) {
  const o = {
    identityId: null,
    display: null,
    nextSeed: null,          // {id, seed}
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

  o.ensureIdentity = async () => {
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
  };

  o.retryNowIfOffline = () => {
    if (enabled() && !o.identityId && !o.connecting) o.ensureIdentity();
  };

  o.prefetchSeed = async () => {
    if (!o.identityId) return;
    const r = await request('/sessions', 'POST',
      { identityId: o.identityId, difficulty: 'NORMAL' });
    if (r && r.sessionId && r.seed) o.nextSeed = { id: r.sessionId, seed: r.seed };
  };

  o.submit = async ({ sessionId, offsets, homeruns, maxDistance, maxCombo, totalAtBats, durationMs }) => {
    const r = await request(`/sessions/${sessionId}/submit`, 'POST', {
      atBats: offsets.map((offsetMs) => ({ offsetMs })),
      summary: { homeruns, maxDistance, maxCombo, totalAtBats },
      durationMs,
    });
    if (!r) return L('서버에 연결하지 못함 — 로컬 기록만', 'Could not reach server — local record only');
    if (typeof r.rank === 'number') return L(`온라인 등재 — 홈런 보드 ${r.rank}위`, `Listed online — #${r.rank} on the HR board`);
    if (r.verified === false) return L('기록 미등재 — 검증을 통과하지 못했습니다', 'Not listed — failed verification');
    return L('온라인 제출됨 — 순위권 밖', 'Submitted — outside the rankings');
  };

  o.fetchBoard = async (board, limit = 10) => {
    const r = await request(`/leaderboard?board=${board}&limit=${limit}`, 'GET', null,
      { timeout: 8000, retries: 1 });
    return r?.top ?? null;
  };

  // 지옥 봇전 결과 제출 — 서버는 타당성 검사만
  o.submitDuel = async ({ innings, myRuns, botRuns, chaos, durationMs }) => {
    if (!o.identityId) return L('오프라인 — 로컬 기록만', 'Offline — local record only');
    const r = await request('/duels', 'POST', {
      identityId: o.identityId, level: '지옥', innings, myRuns, botRuns, chaos, durationMs,
    });
    if (!r) return L('서버에 연결하지 못함 — 로컬 기록만', 'Could not reach server — local record only');
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
  '아무에게도 넘기지 않습니다. 광고·분석 도구를 넣지 않았습니다.',
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
  'No one. There are no ads or analytics tools in this app.',
  'We never collect names, emails, addresses, or payment details.',
  '',
  '# Where it lives',
  'One server in Tokyo, Japan. All traffic is encrypted over HTTPS.',
  '',
  '# Contact',
  'Privacy officer · contact: bbyagucontact@gmail.com',
  'Deletion/correction requests and bug reports both welcome here.',
];
