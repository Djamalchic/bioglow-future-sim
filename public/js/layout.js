// Раскладка поля FLL BIOGLOW Future Edition (сезон 2026-27).
// Источники (официальные): Field Map, Game Missions, Rulebook, Official Table BI (LEGO Education / FIRST).
// Размеры стола взяты из Official Table BI: 2362 x 1143 мм (внутри бортов).
// Координаты моделей сняты с фото на официальной Field Map и сетки в мм, точность примерно ±20…40 мм.
// Подправить расстановку можно здесь — все значения в миллиметрах.
//
// Система координат карты: x вправо от красного (левого) борта, y вниз от дальнего (верхнего) борта.
// Синяя половина = красная, повёрнутая на 180° вокруг центра поля.

export const FIELD_W = 2362; // мм
export const FIELD_H = 1143; // мм
export const WALL_H = 76;    // мм (допуск 64..102)
export const WALL_T = 38;    // мм

export const L = {
  techArea:    { x0: 598, y0: 0,   x1: 1017, y1: 227 },  // зона Technician (старт робота), 419 × 227
  operArea:    { x0: 598, y0: 917, x1: 1017, y1: 1143 }, // зона Operator
  retrieval:   { x0: 598, y0: 757, x1: 900,  y1: 910 },  // retrieval zone (пунктир) над барьером Operator
  lattice:     { x0: 904, y0: 925, x1: 1012, y1: 1143 }, // mangrove roots (решётка 2 × 4 ячейки)
  specArea:    { x0: 0,   y0: 874, x1: 400,  y1: 1143 }, // зона Specialist (белая панель)
  haven:       { x: 1181, y: 571.5, r: 100 },            // M05 Central Haven (общий круг)
  containment: { x: 500,  y: 1030, r: 80 },              // круг у зоны Specialist — containment zone
  grandTree:   { x: 590, y: 560 },
  waterfall:   { x: 845, y: 558 },
  hollowTree:  { x: 292, y: 598 },
  nest:        { x: 330, y: 490 },
  youngForest: { x: 262, y: 160 },
  hive:        { x: 25,  y: 570 },
  recycler:    { x: 18,  y: 805 },
  robotStart:  { x: 680, y: 140, yaw: 0 },
};

// Миссии и очки — по официальному документу Game Missions (Future Edition).
export const MISSIONS = [
  { id: 'M01', name: 'Mighty Microbiomes', ru: 'Микробиомы' },
  { id: 'M02', name: 'Roots of Renewal', ru: 'Корни обновления' },
  { id: 'M03', name: 'Cave Waterfall', ru: 'Пещерный водопад' },
  { id: 'M04', name: 'Rainforest Awakening', ru: 'Пробуждение леса' },
  { id: 'M05', name: 'Central Haven', ru: 'Центральное убежище' },
  { id: 'LUC', name: 'Invasive Attack', ru: 'Level Up: инвазивные виды' },
];

// Размеры фишек (см). K — жёлтое колесо с протектором (фото Game Missions: ≈ 2 купола R в диаметре),
// R — бирюзовый купол 2×2 (16 мм).
export const TOKEN_SIZE = {
  K: { r: 1.4, h: 1.4, mass: 0.006 },
  R: { r: 0.8, h: 1.2, mass: 0.0025 },
};

const grid = (type, cx, cy, nx, ny, step) => {
  const out = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    out.push([type, cx + (i - (nx - 1) / 2) * step, cy + (j - (ny - 1) / 2) * step]);
  }
  return out;
};

// K = keystone species, R = resource. На каждую сторону 20 K и 20 R:
// здесь — фишки на коврике (12 K + 14 R); остальные лежат в моделях (models.js):
// Grand Tree — 5 K в лотке на вершине и 1 R в лотке base, Nest — 3 K, Hollow Tree — 2 R, Hive — 3 R.
export const TOKENS = [
  ...grid('K', 900, 62, 4, 2, 38),                     // 9: Technician area — 8 K
  ['K', 975, 272], ['R', 958, 304], ['R', 992, 304],   // 9a: 1 K + 2 R под углом барьера
  ...grid('R', 730, 1040, 4, 2, 36),                   // 8: Operator area — 8 R
  ['K', 931, 952], ['K', 985, 1062], ['R', 985, 1007], ['R', 931, 1116], // mangrove roots: 2 K + 2 R
  ['K', 365, 735], ['R', 350, 768], ['R', 382, 768],   // 8a: пруд к юго-западу от Grand Tree
];
export const MODEL_TOKENS = { treeStash: 5, treeBase: 1, nest: 3, hollow: 2, hive: 3 };

// Места для инвазивных видов (Level Up, до 5 на команду). Официально (Field Map p3, p5, p6; Missions p8):
// тип «на круглой подставке» — на кольцо Young Forest или Grand Tree; малый тип — у base Grand Tree рядом
// с пандусом (×2) и на опорной плите Nest у рычага (×1).
export const INVASIVE_SPOTS = [
  { id: 'yf-ring', type: 'IR', model: 'yf', name: 'Young Forest: кольцо' },
  { id: 'gt-ring', type: 'IR', model: 'tree', name: 'Grand Tree: кольцо' },
  { id: 'gt-base-l', type: 'IS', model: 'tree', name: 'Grand Tree: у пандуса слева' },
  { id: 'gt-base-r', type: 'IS', model: 'tree', name: 'Grand Tree: у пандуса справа' },
  { id: 'nest-plate', type: 'IS', model: 'nest', name: 'Nest: плита у рычага' },
];
export const DEFAULT_INVASIVE_ORDER = ['gt-base-l', 'gt-base-r', 'nest-plate', 'yf-ring', 'gt-ring'];

/** мм карты -> мир (см). side: 'red' | 'blue' */
export function toWorld(xmm, ymm, side = 'red') {
  if (side === 'blue') { xmm = FIELD_W - xmm; ymm = FIELD_H - ymm; }
  return { x: (xmm - FIELD_W / 2) / 10, z: (ymm - FIELD_H / 2) / 10 };
}

/** мир (см) -> мм карты (в координатах красной стороны, если side = 'red') */
export function toMap(x, z, side = 'red') {
  let xmm = x * 10 + FIELD_W / 2, ymm = z * 10 + FIELD_H / 2;
  if (side === 'blue') { xmm = FIELD_W - xmm; ymm = FIELD_H - ymm; }
  return { x: xmm, y: ymm };
}

/** Прямоугольник зоны (мм) содержит точку карты с отступом pad (мм; >0 — шире, <0 — строже) */
export function inRect(a, p, pad = 0) {
  return p.x >= a.x0 - pad && p.x <= a.x1 + pad && p.y >= a.y0 - pad && p.y <= a.y1 + pad;
}

export const sideYaw = (side) => (side === 'blue' ? Math.PI : 0);
export const other = (side) => (side === 'red' ? 'blue' : 'red');
