/**
 * Rule Engine — 요구사항 정의서 §4 룰북의 정본(正本) 구현
 *
 * v0.4 (2026-08-25): D1 PERFECT 확정 홈런 · D2 구속 계수 상대화 ·
 *                     D3 클래식 기본 10아웃 · D9 파울 즉시 아웃
 * v0.5 (2026-08-28): D29 홈런레이스 난이도 상향 — NORMAL 비행 700→640ms ·
 *                     구종 구속 격차 확대 · 진행 난이도(heat: 홈런당 +1km/h, 상한 +20)
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  이 파일이 기준이다.                                              │
 * │                                                                  │
 * │  Swift 클라이언트(Game Core)는 이 로직을 그대로 옮겨 구현하고,     │
 * │  §15.3 공유 테스트 벡터로 일치를 강제한다. 두 구현이 어긋나면     │
 * │  정상 기록이 부정 사용으로 판정된다 — §16 R3, 최상위 리스크.       │
 * │                                                                  │
 * │  상수나 산출식을 바꾸면 반드시:                                    │
 * │    1. npm run vectors  로 벡터를 재생성하고                        │
 * │    2. Swift 쪽 PR 과 함께 머지한다                                │
 * └──────────────────────────────────────────────────────────────────┘
 */
// ─────────────────────────────────────────────────────────────────
// 상수 — §12
// ─────────────────────────────────────────────────────────────────
export const K = {
    /** 비거리 기본치(m) */ BASE_DISTANCE: 105,
    /** 난수 편차 ±(m) */ NOISE: 4.0,
    /** 콤보 1회당 보너스 */ COMBO_STEP: 0.01,
    /** FOUL/PASS 연속 허용 횟수 */ FREE_LIMIT: 2,
    /** 클래식 아웃 수 (v0.4 D3) */ CLASSIC_OUTS: 10,
    /** 타임어택 아웃 수 */ TIMEATTACK_OUTS: 5,
    /** 타임어택 제한(ms) */ TIMEATTACK_MS: 90000,
    /** v0.5 D29 — 진행 난이도: 홈런 1개당 구속 증가(km/h) */ HEAT_KMH_STEP: 1,
    /** v0.5 D29 — 진행 난이도 구속 증가 상한(km/h) */ HEAT_KMH_CAP: 20,
};
/** 1.1.0 이하 클라이언트가 쓰던 룰 (D80). 서버가 옛 앱의 제출을 그 앱의 룰로
 *  재현할 때만 쓴다 — 게임 경로에서는 절대 켜지 않는다. Swift 포팅 대상 아님. */
export const LEGACY_110 = { comboCap: 0.15, maxDistance: 155, heatCap: 20 };
export const DIFFICULTY = {
    EASY: {
        readyMs: 1800, flightMs: 900, baseSpeed: 130,
        thresholds: { perfect: 25, great: 55, good: 100, poor: 160 },
        homerunLine: 110, pitchTypes: ['FASTBALL'], courseGrid: 1,
    },
    NORMAL: {
        readyMs: 1200, flightMs: 640, baseSpeed: 140, // v0.5 D29: 700→640
        thresholds: { perfect: 15, great: 40, good: 80, poor: 130 },
        homerunLine: 120, pitchTypes: ['FASTBALL', 'SLIDER', 'CURVE'], courseGrid: 3,
    },
    HARD: {
        readyMs: 900, flightMs: 550, baseSpeed: 150,
        thresholds: { perfect: 10, great: 30, good: 60, poor: 100 },
        homerunLine: 125,
        pitchTypes: ['FASTBALL', 'SLIDER', 'CURVE', 'CHANGEUP'], courseGrid: 9,
    },
};
/** 구종별 기준 구속 대비 증감(km/h) — §FR-2.10.
 *  v0.5 D29: 격차 확대(직구 빠르게, 변화구 느리게) — 실루엣·체감 차이를 키운다 */
export const PITCH_SPEED_DELTA = {
    FASTBALL: 10, SLIDER: -10, CHANGEUP: -22, CURVE: -30,
};
// ─────────────────────────────────────────────────────────────────
// 결정론적 RNG
// ─────────────────────────────────────────────────────────────────
/**
 * mulberry32. Swift 포팅 시 **32비트 랩어라운드 연산을 정확히 재현**해야 한다.
 * Swift 에서는 `&+`, `&*` (오버플로 허용 연산자)를 쓰고 UInt32 를 유지할 것.
 */
export function rng32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** §4.3 — 소수점 셋째 자리 반올림. 클라이언트·서버 부동소수 오차 방지 */
export const round3 = (v) => Math.round(v * 1000) / 1000;
/**
 * 시드는 문자열로 주고받는다(§10.2 — JS Number 정밀도 손실 방지).
 * RNG 입력용 32비트로 접는다.
 */
export function seedToU32(seed) {
    const s = BigInt(seed);
    return Number((s ^ (s >> 32n)) & 0xffffffffn) >>> 0;
}
// ─────────────────────────────────────────────────────────────────
// §4.3 — 투구 생성
// ─────────────────────────────────────────────────────────────────
/**
 * @param heat v0.5 D29 — 진행 난이도. 세션의 현재 홈런 수를 넣으면 구속이
 *             홈런당 +HEAT_KMH_STEP km/h (상한 HEAT_KMH_CAP) 올라 비행이 짧아진다.
 *             구속 상승분만큼 비거리 계수도 미세하게 올라 보상이 함께 커진다.
 */
export function pitchFor(seed, index, difficulty, heat = 0, heatCap = K.HEAT_KMH_CAP) {
    const cfg = DIFFICULTY[difficulty];
    const r = rng32((seedToU32(seed) ^ Math.imul(index + 1, 2654435761)) >>> 0);
    // 구종 선택 — heat 가 오를수록 변화구를 더 자주 던진다.
    // heat 는 모든 구종의 구속을 같은 양만큼 올리는데, 비행 시간은 속도에 반비례하므로
    // 느린 구종일수록 더 많이 짧아진다 → 구종 간 시간 차가 좁혀져(205ms→154ms) 후반에
    // 오히려 타이밍이 안 흔들린다. 느린 구종 비중을 높여 그 차이를 되살린다.
    // (r() 호출은 여전히 한 번 — 소비 횟수가 바뀌면 이후 모든 값이 어긋난다)
    const roll = r();
    const nTypes = cfg.pitchTypes.length;
    let type;
    if (nTypes === 1) {
        type = cfg.pitchTypes[0];
    }
    else {
        const heatRatio = Math.min(heat * K.HEAT_KMH_STEP, heatCap) / heatCap;
        const fastShare = Math.max(0.12, 1 / nTypes - heatRatio * 0.18);
        type = roll < fastShare
            ? cfg.pitchTypes[0]
            : cfg.pitchTypes[1 + Math.min(nTypes - 2, Math.floor((roll - fastShare) / (1 - fastShare) * (nTypes - 1)))];
    }
    // 구속 하한 1 — 0 이 되면 flightMs 가 Infinity 가 되고, Swift 포팅에서는
    // jsRound(±∞) 가 트랩이라 프로세스가 죽는다. 게임 경로에서는 heat ≥ 0 이라
    // 도달하지 않지만 pitchFor 는 공개 API 이므로 양쪽 모두 막아 둔다.
    const speed = Math.max(1, Math.round(cfg.baseSpeed + PITCH_SPEED_DELTA[type] + r() * 8
        + Math.min(heat * K.HEAT_KMH_STEP, heatCap)));
    const flightMs = Math.round(cfg.flightMs * (cfg.baseSpeed / speed));
    const course = cfg.courseGrid === 1 ? 4 // 한가운데
        : cfg.courseGrid === 3 ? 1 + Math.floor(r() * 3) * 3 // 상하 3단
            : Math.floor(r() * 9); // 3×3
    const noise = round3(-K.NOISE + r() * (K.NOISE * 2));
    return { index, type, speed, flightMs, course, noise };
}
// ─────────────────────────────────────────────────────────────────
// §4.2 — 타이밍 판정
// ─────────────────────────────────────────────────────────────────
export function judge(offsetMs, th) {
    if (offsetMs === null)
        return 'NONE';
    const o = Math.abs(offsetMs);
    if (o <= th.perfect)
        return 'PERFECT';
    if (o <= th.great)
        return 'GREAT';
    if (o <= th.good)
        return 'GOOD';
    if (o <= th.poor)
        return 'POOR';
    return 'MISS';
}
// ─────────────────────────────────────────────────────────────────
// §4.3 — 타이밍 계수
// ─────────────────────────────────────────────────────────────────
/**
 * 구간별 선형 보간. 경계에서의 계수(1.25 / 1.18 / 1.00 / 0.70 / 0.40)는 불변이며,
 * 구간 폭만 난이도 임계값을 따른다.
 *
 * PERFECT 구간을 완만하게(−0.07), 그 밖을 가파르게(−0.18 / −0.30 / −0.30) 둔 것이
 * 밸런스의 핵심이다. GREAT 구간이 홈런 기준선에 걸치도록 만들어
 * "PERFECT 는 확정, GREAT 는 조건부" 를 성립시킨다.
 */
export function timingFactor(absOffsetMs, th) {
    const { perfect: P, great: G, good: D, poor: R } = th;
    if (absOffsetMs <= P)
        return round3(1.25 - (absOffsetMs / P) * 0.07);
    if (absOffsetMs <= G)
        return round3(1.18 - ((absOffsetMs - P) / (G - P)) * 0.18);
    if (absOffsetMs <= D)
        return round3(1.0 - ((absOffsetMs - G) / (D - G)) * 0.3);
    if (absOffsetMs <= R)
        return round3(0.7 - ((absOffsetMs - D) / (R - D)) * 0.3);
    return 0;
}
/** v0.4 D2 — 난이도 기준 구속 대비 상대값. 구종 편차 ±22km/h → 비거리 ±4.5%.
 *  절대 기준(130) 방식은 느린 변화구에서 PERFECT 조차 아웃되게 만들었다. */
export const speedFactor = (speedKmh, baseSpeed) => round3(1 + (speedKmh - baseSpeed) / 500);
/** D80: 상한 없음 — 연속 홈런 1개당 +1% 가 끝없이 쌓인다 (예전 상한 0.15) */
export const comboBonus = (combo, cap = Infinity) => round3(1.0 + Math.min(combo * K.COMBO_STEP, cap));
/** §4.3 최종 산출식. 정수 미터로 반올림한다 (D78: 상한 없음 — 155m 클램프 제거).
 *  주의: PERFECT 의 기준선 하한 보정(D1)은 여기가 아니라 resolveAtBat 에서 한다. */
export function distanceOf(offsetMs, pitch, combo, cfg, legacy = false) {
    if (offsetMs === null)
        return 0;
    const tf = timingFactor(Math.abs(offsetMs), cfg.thresholds);
    if (tf === 0)
        return 0;
    const d = K.BASE_DISTANCE * tf * speedFactor(pitch.speed, cfg.baseSpeed)
        * comboBonus(combo, legacy ? LEGACY_110.comboCap : Infinity) + pitch.noise;
    const m = Math.max(0, Math.round(d));
    return legacy ? Math.min(LEGACY_110.maxDistance, m) : m;
}
// ─────────────────────────────────────────────────────────────────
// §4.4 — 결과 판정
// ─────────────────────────────────────────────────────────────────
export function resultOf(judgement, distance, homerunLine) {
    switch (judgement) {
        case 'PERFECT': return 'HOMERUN'; // v0.4 D1 — 비거리 무관 확정
        case 'GREAT': return distance >= homerunLine ? 'HOMERUN' : 'FLYOUT';
        case 'GOOD': return 'GROUNDOUT';
        case 'POOR': return 'FOUL';
        case 'MISS': return 'STRIKEOUT';
        case 'NONE': return 'PASS';
    }
}
/** v0.4 D9 — 파울은 즉시 아웃이다 (버티기 전략 원천 차단) */
export const OUT_RESULTS = new Set(['FLYOUT', 'GROUNDOUT', 'STRIKEOUT', 'FOUL']);
/** 무입력만 연속 3회째 아웃 — "치지 않고 버티기" 방지 (§4.4) */
export const FREE_RESULTS = new Set(['PASS']);
/** 한 타석을 완전히 해석한다. 세션 상태는 SessionState 가 관리한다. */
export function resolveAtBat(input) {
    const cfg = DIFFICULTY[input.difficulty];
    const judgement = judge(input.offsetMs, cfg.thresholds);
    let distance = distanceOf(input.offsetMs, input.pitch, input.combo, cfg, input.legacy === true);
    if (judgement === 'PERFECT')
        distance = Math.max(distance, cfg.homerunLine); // D1 하한
    const result = resultOf(judgement, distance, cfg.homerunLine);
    const isHR = result === 'HOMERUN';
    return {
        judgement, result, distance,
        outAdded: OUT_RESULTS.has(result) ? 1 : 0,
        combo: isHR ? input.combo + 1 : (FREE_RESULTS.has(result) ? input.combo : 0),
    };
}
export class SessionState {
    constructor(seed, difficulty, maxOuts = K.CLASSIC_OUTS, 
    /** 서버 전용 — 1.1.0 이하 클라이언트의 제출을 그 룰로 재현 (D80) */
    legacy = false) {
        this.seed = seed;
        this.difficulty = difficulty;
        this.maxOuts = maxOuts;
        this.legacy = legacy;
        this.outs = 0;
        this.combo = 0;
        this.freeRun = 0;
        this.hr = 0;
        this.best = 0;
        this.total = 0;
        this.maxCombo = 0;
        this.atBats = 0;
        this.errors = [];
        this.jd = { PERFECT: 0, GREAT: 0, GOOD: 0, POOR: 0, MISS: 0 };
    }
    get ended() { return this.outs >= this.maxOuts; }
    get nextIndex() { return this.atBats; }
    get currentCombo() { return this.combo; }
    get currentOuts() { return this.outs; }
    /** v0.5 D29 — 현재 홈런 수가 heat 로 들어가 칠수록 공이 빨라진다.
     *  리플레이도 같은 순서로 홈런이 쌓이므로 결정론이 유지된다. */
    nextPitch() {
        return pitchFor(this.seed, this.atBats, this.difficulty, this.hr, this.legacy ? LEGACY_110.heatCap : K.HEAT_KMH_CAP);
    }
    /** 스윙 하나를 적용하고 결과를 돌려준다. */
    swing(offsetMs, pitch) {
        if (this.ended)
            throw new Error('SESSION_ENDED');
        const p = pitch ?? this.nextPitch();
        const out = resolveAtBat({ offsetMs, pitch: p, combo: this.combo, difficulty: this.difficulty,
            legacy: this.legacy });
        if (offsetMs !== null && out.judgement !== 'NONE') {
            this.jd[out.judgement]++;
            this.errors.push(Math.abs(offsetMs));
        }
        let outAdded = out.outAdded;
        if (FREE_RESULTS.has(out.result)) {
            this.freeRun++;
            if (this.freeRun > K.FREE_LIMIT) {
                outAdded = 1;
                this.freeRun = 0;
            }
        }
        else {
            this.freeRun = 0;
        }
        if (out.result === 'HOMERUN') {
            this.hr++;
            this.total += out.distance;
            if (out.distance > this.best)
                this.best = out.distance;
        }
        this.combo = out.combo;
        if (this.combo > this.maxCombo)
            this.maxCombo = this.combo;
        this.outs += outAdded;
        this.atBats++;
        return { ...out, outAdded: outAdded };
    }
    summary() {
        const swings = this.errors.length;
        return {
            homeruns: this.hr,
            maxDistance: this.best,
            totalDistance: this.total,
            maxCombo: this.maxCombo,
            totalAtBats: this.atBats,
            homerunRate: swings ? round3(this.hr / swings) : 0,
            avgTimingError: swings
                ? round3(this.errors.reduce((a, b) => a + b, 0) / swings) : 0,
            judgementDist: { ...this.jd },
            outs: this.outs,
            ended: this.ended,
        };
    }
}
/**
 * 동률 시 비교 순서:
 *   1. 홈런 수         (많을수록 상위)
 *   2. 최고 비거리      (길수록)
 *   3. 총 비거리        (길수록)
 *   4. 평균 타이밍 오차  (작을수록)
 *   5. 총 타석 수       (적을수록 — 같은 결과를 더 적은 기회로 냈으므로)
 * 전부 같으면 0 을 반환한다. 룸 대전은 이때 서든데스로 넘어간다.
 */
export function compareStandings(a, b) {
    return (b.homeruns - a.homeruns ||
        b.maxDistance - a.maxDistance ||
        b.totalDistance - a.totalDistance ||
        a.avgTimingError - b.avgTimingError ||
        a.totalAtBats - b.totalAtBats);
}
export function rank(standings) {
    const sorted = [...standings].sort(compareStandings);
    return sorted.map((s, i) => ({
        ...s,
        rank: i + 1,
        tied: (i > 0 && compareStandings(sorted[i - 1], s) === 0) ||
            (i < sorted.length - 1 && compareStandings(s, sorted[i + 1]) === 0),
    }));
}
// ─────────────────────────────────────────────────────────────────
// 룸 대전 — §FR-4.13 / 4.14
// ─────────────────────────────────────────────────────────────────
/**
 * 라운드 단위 투구. **같은 라운드의 모든 참가자가 같은 공을 친다.**
 * 따라서 pitchIndex 는 참가자가 아니라 roundIndex 로만 결정된다.
 */
export const roundPitch = (seed, roundIndex, d) => pitchFor(seed, roundIndex, d);
/**
 * 라운드마다 선두 타자를 한 칸씩 순환시킨다.
 * 같은 공을 치므로 앞 타자의 결과가 뒤 타자에게 정보가 된다 —
 * 순서를 고정하면 그 우위가 매 라운드 같은 사람에게 누적된다.
 */
export function turnOrder(players, roundIndex) {
    if (players.length === 0)
        return [];
    const k = roundIndex % players.length;
    return [...players.slice(k), ...players.slice(0, k)];
}
