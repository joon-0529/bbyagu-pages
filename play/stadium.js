// 경기장 테마 (D102) — 배경판 목록·그림 로딩·그리기. 맥 main.swift 의 Stadium 과 1:1.
// 배경판은 themes/<id>.jpg (1888×833) 한 장. 선수·공·HUD 는 코드로 위에 그린다 —
// 그림 안에 판정 요소가 없어야 창 크기·배율이 달라도 게임이 같다.
export const STADIUMS = [];          // themes/themes.json — {id, ko, en, tone, horizon, board}
const plates = {};                   // id → Image
const ground = {};                   // id → 그림 맨 아랫줄 색 (그림보다 캔버스가 길 때 아래를 잇는다)

export const stadiumById = (id) => STADIUMS.find((t) => t.id === id) ?? null;

export async function loadStadiums() {
  try {
    const r = await fetch('themes/themes.json', { cache: 'no-cache' });
    STADIUMS.push(...await r.json());
  } catch { /* 오프라인·구버전 서버 — 기본 배경만 */ }
}

export function plateFor(id) {
  if (!plates[id]) { const im = new Image(); im.src = `themes/${id}.jpg`; plates[id] = im; }
  const im = plates[id];
  return im.complete && im.naturalWidth ? im : null;
}

function groundColor(id, im) {
  if (!ground[id]) {
    const c = document.createElement('canvas'); c.width = 1; c.height = 1;
    const x = c.getContext('2d');
    x.drawImage(im, 0, im.naturalHeight - 3, im.naturalWidth, 2, 0, 0, 1, 1);
    const [r, g, b] = x.getImageData(0, 0, 1, 1).data;
    ground[id] = `rgb(${r},${g},${b})`;
  }
  return ground[id];
}

const skies = {};                    // id → 그림 맨 윗줄 8행을 6×1 로 줄인 띠 (D110, 24칸은 사쿠라 벚꽃이 기둥처럼 번졌다)
function skyStrip(id, im) {
  if (!skies[id]) {
    const c = document.createElement('canvas'); c.width = 6; c.height = 1;
    c.getContext('2d').drawImage(im, 0, 0, im.naturalWidth, 8, 0, 0, 6, 1);
    skies[id] = c;
  }
  return skies[id];
}

// 그림 위 하늘 확장 (D114) — themes/<id>-sky.jpg. 없거나 아직 안 왔으면 예전 띠로
const skyExts = {};
function skyExtFor(id) {
  if (!skyExts[id]) { const im = new Image(); im.src = `themes/${id}-sky.jpg`; skyExts[id] = im; }
  const im = skyExts[id];
  return im.complete && im.naturalWidth ? im : null;
}
// 유리 스코어박스(D114) 뒤에 비칠 흐린 그림 — 1/4 로 줄여 흐리고 채도를 조금 올린다. 테마마다 한 번
const blurs = {};
function blurredOf(key, im) {
  if (!blurs[key]) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(im.naturalWidth / 4)); c.height = Math.max(1, Math.round(im.naturalHeight / 4));
    const x = c.getContext('2d');
    x.filter = 'blur(5px) saturate(1.35)';   // filter 를 모르는 브라우저는 흐림 없이 줄인 그림만
    x.drawImage(im, -8, -8, c.width + 16, c.height + 16);   // 가장자리가 투명하게 번지지 않게 살짝 크게
    blurs[key] = c;
  }
  return blurs[key];
}
/// 유리판 뒤 그림 — drawPlate 가 돌려준 자리에 흐린 그림을 같은 자리에 깐다 (호출 쪽이 clip 해 둔다)
export function drawBlurredBack(ctx, t, m) {
  const im = plateFor(t.id);
  if (!im || !m) return;
  ctx.drawImage(blurredOf(t.id, im), m.dx, m.dy, m.pw * m.s, m.ph * m.s);
  if (m.ext) { const e = skyExtFor(t.id); if (e) ctx.drawImage(blurredOf(t.id + '-sky', e), m.ext.x, m.ext.y, m.ext.w, m.ext.h); }
}

/// 배경판을 캔버스에 맞춘다: 그림의 지평선이 지면 g 에 오고, 가로는 꽉 차며 위도 비지 않는다.
/// 돌려주는 값은 그림→캔버스 변환 (전광판 자리 계산용). 그림이 아직 안 왔으면 null.
export function drawPlate(ctx, t, W, H, g, xOff = 0, anchorX = null) {   // xOff: 상점 슬라이드 (D102)
  const im = plateFor(t.id);
  if (!im) return null;
  const pw = im.naturalWidth, ph = im.naturalHeight;
  let s = Math.max(W / pw, g / (t.horizon * ph)), dx;
  let anchor = anchorX;
  if (anchorX !== null && t.wallEnd) {
    // D108: 그림 속 담장 끝을 게임 담장(홈런선 기둥)에 맞춘다 — 그림이 양쪽 화면 끝을 다 덮도록 배율을 키운다
    s = Math.max(s, anchorX / (t.wallEnd * pw), (W - anchorX) / ((1 - t.wallEnd) * pw));
    // D120: 그림을 줄이지 않는다 (위가 비어 지어낸 하늘이 '블러'처럼 보였다). 전광판이 넘치면 게임 담장을 왼쪽으로 당긴다
    anchor = Math.min(anchorX, W - 4 - (t.board[2] - t.wallEnd) * pw * s);
    dx = anchor - t.wallEnd * pw * s;
  } else {
    dx = pw * s > W + 1 ? W - pw * s : (W - pw * s) / 2;
  }
  dx += xOff;
  const dy = g - t.horizon * ph * s;
  const bottom = dy + ph * s;
  // 4:3 화면 — 그림 위 빈 곳 (D114): 하늘 확장 그림을 윗변에 붙이고, 그래도 남으면 그 맨 윗줄 색으로 잇는다.
  // (D110 은 그림 윗줄을 늘려 채우고 윗단을 섞어 "위가 블러 처리된 것 같다"는 제보가 나왔다)
  let ext = null;
  if (dy > 0) {
    const e = skyExtFor(t.id);
    let fillTop = dy, strip = skyStrip(t.id, im);
    if (e) {
      const eh = e.naturalHeight * pw * s / e.naturalWidth;
      ext = { x: dx, y: dy - eh, w: pw * s, h: eh + 0.5 };
      ctx.drawImage(e, ext.x, ext.y, ext.w, ext.h);
      fillTop = ext.y; strip = skyStrip(t.id + '-sky', e);
    }
    if (fillTop > 0) {
      ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(strip, dx, 0, pw * s, fillTop + 1); ctx.restore();
    }
  }
  if (bottom < H) { ctx.fillStyle = groundColor(t.id, im); ctx.fillRect(dx, bottom - 1, pw * s, H - bottom + 1); }
  ctx.drawImage(im, dx, dy, pw * s, ph * s);
  return { s, dx, dy, pw, ph, ext, anchor };
}

/// 그림 속 전광판(빈 판)의 캔버스 좌표 — 게임이 여기에 문구·후원 그림을 얹는다
export function boardRect(t, m) {
  const [x0, y0, x1, y1] = t.board;
  return { x: m.dx + x0 * m.pw * m.s, y: m.dy + y0 * m.ph * m.s,
           w: (x1 - x0) * m.pw * m.s, h: (y1 - y0) * m.ph * m.s };
}
