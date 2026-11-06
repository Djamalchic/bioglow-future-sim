// Процедурный коврик поля. Разметка зон — по официальной Field Map,
// сам рисунок джунглей стилизованный (официального файла коврика в открытом доступе нет).
// Можно подставить свою картинку коврика: кнопка «Свой коврик» в настройках.
import { FIELD_W, FIELD_H, L } from './layout.js';

function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CANOPY = ['#3f7d2b', '#4f8f2f', '#5e9c34', '#6aa63a', '#7fb544', '#8dbb47', '#a3c45a', '#bcd172'];
const WATER = '#8fc3e3', WATER_DEEP = '#6aaed6', WATER_LIGHT = '#bfe0f2', SAND = '#e7c08e';

// Река красной половины (кубические кривые, мм). Синяя половина — поворот на 180°.
const RIVER = [
  [-30, 330],
  [[110, 280], [230, 370], [330, 330]],
  [[440, 290], [470, 420], [640, 425]],
  [[800, 430], [880, 345], [1000, 395]],
  [[1100, 440], [1080, 560], [1181, 571.5]],
];
const BRANCH = [
  [640, 425],
  [[690, 560], [690, 700], [790, 770]],
  [[870, 830], [960, 800], [1060, 880]],
];
const POOLS = [[150, 720, 75, 42], [1000, 175, 55, 35], [1080, 1010, 80, 46], [520, 330, 40, 26], [330, 860, 46, 30], [860, 690, 42, 30]];
const SANDS = [[160, 520, 120, 70], [560, 250, 110, 60], [950, 520, 90, 120], [420, 1000, 120, 60], [1100, 300, 70, 110], [210, 980, 90, 60]];

function pathFrom(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const [c1, c2, p] = pts[i];
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p[0], p[1]);
  }
}

function drawHalf(ctx, R, side) {
  const team = side === 'red' ? '#d0312d' : '#1f5fbf';
  // песок
  for (const [x, y, rx, ry] of SANDS) {
    ctx.fillStyle = SAND;
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, R() * 3, 0, Math.PI * 2); ctx.fill();
  }
  // кроны деревьев
  for (let i = 0; i < 1500; i++) {
    const x = R() * (FIELD_W / 2 + 20) - 10, y = R() * (FIELD_H + 20) - 10;
    const r = 10 + R() * 30;
    const c = CANOPY[(R() * CANOPY.length) | 0];
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,230,0.18)';
    ctx.beginPath(); ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.45, 0, Math.PI * 2); ctx.fill();
    if (R() < 0.25) { // листья-звёздочки
      ctx.strokeStyle = 'rgba(40,80,25,0.55)'; ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + R(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * r * 0.9, y + Math.sin(a) * r * 0.9); }
      ctx.stroke();
    }
  }
  // река
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const [w, c] of [[96, SAND], [70, WATER], [44, WATER_DEEP], [16, WATER_LIGHT]]) {
    ctx.strokeStyle = c; ctx.lineWidth = w;
    pathFrom(ctx, RIVER); ctx.stroke();
    ctx.lineWidth = w * 0.72; pathFrom(ctx, BRANCH); ctx.stroke();
  }
  for (const [x, y, rx, ry] of POOLS) {
    ctx.fillStyle = SAND; ctx.beginPath(); ctx.ellipse(x, y, rx + 12, ry + 10, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = WATER; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = WATER_LIGHT; ctx.beginPath(); ctx.ellipse(x - rx * 0.2, y - ry * 0.2, rx * 0.4, ry * 0.3, 0, 0, Math.PI * 2); ctx.fill();
  }
  // кувшинки и блики
  for (let i = 0; i < 160; i++) {
    const x = R() * FIELD_W / 2, y = R() * FIELD_H;
    ctx.fillStyle = R() < 0.5 ? 'rgba(255,255,255,0.35)' : 'rgba(120,170,70,0.45)';
    ctx.beginPath(); ctx.arc(x, y, 2 + R() * 4, 0, Math.PI * 2); ctx.fill();
  }

  // зоны Technician / Operator — светлый «камуфляж»
  const area = (a, label) => {
    ctx.save();
    ctx.beginPath(); ctx.rect(a.x0, a.y0, a.x1 - a.x0, a.y1 - a.y0); ctx.clip();
    ctx.fillStyle = '#b8d27c'; ctx.fillRect(a.x0, a.y0, a.x1 - a.x0, a.y1 - a.y0);
    ctx.fillStyle = '#a2c266';
    for (let i = -10; i < 30; i++) {
      ctx.beginPath();
      const x = a.x0 + i * 32;
      ctx.moveTo(x, a.y0 - 10);
      ctx.bezierCurveTo(x + 40, a.y0 + 60, x - 30, a.y0 + 150, x + 60, a.y1 + 10);
      ctx.lineTo(x + 76, a.y1 + 10);
      ctx.bezierCurveTo(x - 14, a.y0 + 150, x + 56, a.y0 + 60, x + 16, a.y0 - 10);
      ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = '#151515'; ctx.lineWidth = 3;
    ctx.strokeRect(a.x0, a.y0, a.x1 - a.x0, a.y1 - a.y0);
    ctx.fillStyle = 'rgba(30,60,20,0.55)';
    ctx.font = '600 22px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(label, (a.x0 + a.x1) / 2, a.y0 + (a.y1 - a.y0) / 2 + 8);
  };
  area(L.techArea, 'TECHNICIAN');
  area(L.operArea, 'OPERATOR');

  // retrieval zone — пунктир
  ctx.setLineDash([12, 10]); ctx.strokeStyle = '#151515'; ctx.lineWidth = 2.5;
  ctx.strokeRect(L.retrieval.x0, L.retrieval.y0, L.retrieval.x1 - L.retrieval.x0, L.retrieval.y1 - L.retrieval.y0);
  ctx.setLineDash([]);

  // Specialist — белая панель
  const s = L.specArea;
  ctx.fillStyle = '#f6f6f1'; ctx.fillRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
  ctx.strokeStyle = '#151515'; ctx.lineWidth = 3; ctx.strokeRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
  ctx.fillStyle = team; ctx.font = '700 34px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('SPECIALIST', (s.x0 + s.x1) / 2, s.y0 + 120);
  ctx.fillStyle = '#5b6b55'; ctx.font = '500 20px sans-serif';
  ctx.fillText(side === 'red' ? 'RED TEAM' : 'BLUE TEAM', (s.x0 + s.x1) / 2, s.y0 + 160);

  // containment (круг у Specialist)
  const c = L.containment;
  ctx.strokeStyle = '#151515'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2); ctx.stroke();

  // цветная кромка своей половины
  ctx.strokeStyle = team; ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(FIELD_W / 2 - 6, 5); ctx.lineTo(5, 5); ctx.lineTo(5, FIELD_H - 5); ctx.lineTo(FIELD_W / 2 - 6, FIELD_H - 5);
  ctx.stroke();
}

export function makeMat(widthPx = 2048) {
  const canvas = document.createElement('canvas');
  const sc = widthPx / FIELD_W;
  canvas.width = widthPx;
  canvas.height = Math.round(FIELD_H * sc);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.scale(sc, sc);
  ctx.fillStyle = '#86b84a'; ctx.fillRect(0, 0, FIELD_W, FIELD_H);

  // красная половина
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, FIELD_W / 2, FIELD_H); ctx.clip();
  drawHalf(ctx, rng(2026), 'red');
  ctx.restore();
  // синяя половина = поворот на 180° (та же раскладка)
  ctx.save();
  ctx.translate(FIELD_W, FIELD_H); ctx.rotate(Math.PI);
  ctx.beginPath(); ctx.rect(0, 0, FIELD_W / 2, FIELD_H); ctx.clip();
  drawHalf(ctx, rng(2026), 'blue');
  ctx.restore();

  // Central Haven — островок и круг
  const h = L.haven;
  ctx.fillStyle = SAND; ctx.beginPath(); ctx.arc(h.x, h.y, h.r + 14, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#7fb544'; ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2); ctx.fill();
  const R = rng(7);
  for (let i = 0; i < 40; i++) {
    const a = R() * Math.PI * 2, d = R() * (h.r - 18);
    ctx.fillStyle = CANOPY[(R() * CANOPY.length) | 0];
    ctx.beginPath(); ctx.arc(h.x + Math.cos(a) * d, h.y + Math.sin(a) * d, 8 + R() * 14, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = '#151515'; ctx.lineWidth = 3.5;
  ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2); ctx.stroke();

  // центральный стык ковриков (чёрные кромки + треугольники выравнивания)
  ctx.fillStyle = '#121212'; ctx.fillRect(FIELD_W / 2 - 6, 0, 12, FIELD_H);
  ctx.fillStyle = '#f2f2f2';
  for (const y of [40, FIELD_H / 2 - 120, FIELD_H / 2 + 120, FIELD_H - 40]) {
    ctx.beginPath(); ctx.moveTo(FIELD_W / 2 - 6, y - 9); ctx.lineTo(FIELD_W / 2 + 6, y); ctx.lineTo(FIELD_W / 2 - 6, y + 9); ctx.fill();
  }

  return wrapMat(canvas);
}

// Сетка цветов для датчика: 2 мм на пиксель, RGB в Uint8Array (выборка без DOM)
export const MAT_MM_PER_PX = 2;

/** Таблица цветов коврика из canvas: { w, h, rgb: Uint8Array } (2 мм/пиксель, красная система координат). */
export function colorTable(canvas) {
  const w = Math.round(FIELD_W / MAT_MM_PER_PX), h = Math.round(FIELD_H / MAT_MM_PER_PX);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const src = ctx.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) { rgb[j] = src[i]; rgb[j + 1] = src[i + 1]; rgb[j + 2] = src[i + 2]; }
  return { w, h, rgb };
}

/** Средний цвет пятна ~6 мм вокруг точки карты (мм) по таблице цветов. Чистая функция. */
export function sampleTable(t, xmm, ymm) {
  const px = Math.round(xmm / MAT_MM_PER_PX), py = Math.round(ymm / MAT_MM_PER_PX);
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = px + dx, y = py + dy;
    if (x < 0 || y < 0 || x >= t.w || y >= t.h) continue;
    const i = (y * t.w + x) * 3;
    r += t.rgb[i]; g += t.rgb[i + 1]; b += t.rgb[i + 2]; n++;
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

/** Обёртка: canvas для текстуры + выборка цвета под датчиком в мм карты (красная система координат). */
export function wrapMat(canvas) {
  let table = colorTable(canvas);
  return {
    canvas,
    get table() { return table; },
    refresh() { table = colorTable(canvas); },
    sample(xmm, ymm) { return sampleTable(table, xmm, ymm); },
  };
}

/** Загрузка пользовательского коврика (картинка 2362x1143 пропорций, красная сторона слева). */
export function matFromImage(img, widthPx = 2048) {
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = Math.round(widthPx * FIELD_H / FIELD_W);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return wrapMat(canvas);
}
