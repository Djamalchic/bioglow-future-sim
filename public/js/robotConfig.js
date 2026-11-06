// Конфигурация робота (RobotConfig): схема, пресеты, геометрия деталей и проверка по правилам железа
// Future Edition (Rulebook): на роботе ровно 1 Double Motor (ходовая), не больше 1 Single Motor и 1 Color Sensor
// (Technician tool); высота ≤ 20.3 см; робот целиком помещается в зону Technician 419 × 227 мм.
// Система координат шасси: начало — центр корпуса Double Motor; вперёд +X, вверх +Y, правый бок +Z. См, кг.

export const LIMITS = { heightCm: 20.3, areaL: 41.9, areaW: 22.7, massWarnKg: 1.0 };

export const WHEELS = {
  '44x15': { d: 4.4, w: 1.5, mass: 0.015, name: 'Колесо 44 × 15' },
  '56x14': { d: 5.6, w: 1.4, mass: 0.02, name: 'Колесо 56 × 14' },
  '62x20': { d: 6.24, w: 2.0, mass: 0.026, name: 'Колесо 62.4 × 20' },
  '88x14': { d: 8.8, w: 1.4, mass: 0.036, name: 'Колесо 88 × 14' },
};

// Корпус Double Motor (с батареей и IMU). up — насколько центр корпуса выше оси колёс.
export const HOUSING = { L: 7.2, H: 4.4, W: 5.6, mass: 0.25, up: 1.0 };
export const SINGLE_MOTOR = { L: 2.6, H: 2.4, W: 3.4, mass: 0.06 };
export const COLOR_SENSOR = { L: 2.0, H: 1.4, W: 2.0, mass: 0.02, gap: 0.8 }; // gap — низ датчика над ковриком

export const ATTACHMENTS = {
  scoop: { name: 'Ковш (подъём и высыпание)', motor: true, length: 10, ratio: 3, minLen: 7, maxLen: 14 },
  claw: { name: 'Захват-клетка (1 фишка)', motor: true, length: 9, ratio: 3, minLen: 7, maxLen: 13 },
  hammer: { name: 'Молоток (рычаги, удар)', motor: true, length: 10, ratio: 1, minLen: 5, maxLen: 14 },
  plow: { name: 'Толкатель «рога»', motor: false },
  none: { name: 'Без навесного', motor: false },
};

export const DEFAULT_CONFIG = {
  version: 1,
  name: 'Базовый: ковш',
  wheels: { size: '56x14', track: 7.4, x: 3.0 },
  chassis: { extraLength: 0, extraWidth: 0, color: 'white' },
  caster: { type: 'ball', x: -3.0 },
  ballast: 0,
  sensor: { enabled: true, x: 4.6, z: 0 },
  attachment: { type: 'scoop', ratio: 3, length: 10, mount: 'front' },
  teamColor: 'auto',
};

export const PRESETS = [
  { id: 'scoop', ...structuredClone(DEFAULT_CONFIG) },
  {
    id: 'claw', version: 1, name: 'Захват: одна фишка в клетке',
    wheels: { size: '56x14', track: 7.4, x: 3.0 }, chassis: { extraLength: 0, extraWidth: 0, color: 'white' },
    caster: { type: 'ball', x: -3.0 }, ballast: 0, sensor: { enabled: true, x: 4.6, z: 0 },
    attachment: { type: 'claw', ratio: 3, length: 9, mount: 'front' }, teamColor: 'auto',
  },
  {
    id: 'hammer', version: 1, name: 'Молоток: рычаги Nest и Hollow Tree',
    wheels: { size: '62x20', track: 8.2, x: 2.0 }, chassis: { extraLength: 2, extraWidth: 0, color: 'white' },
    caster: { type: 'skid', x: -3.4 }, ballast: 20, sensor: { enabled: true, x: 4.6, z: 0 },
    attachment: { type: 'hammer', ratio: 1, length: 10, mount: 'front' }, teamColor: 'auto',
  },
  {
    id: 'plow', version: 1, name: 'Толкатель (Driver tool)',
    wheels: { size: '56x14', track: 7.4, x: 1.4 }, chassis: { extraLength: 0, extraWidth: 0, color: 'white' },
    caster: { type: 'ball', x: -3.0 }, ballast: 0, sensor: { enabled: true, x: 4.3, z: 0 },
    attachment: { type: 'plow', ratio: 1, length: 0, mount: 'front' }, teamColor: 'auto',
  },
];

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const D2R = Math.PI / 180;

/** Дополнить конфигурацию значениями по умолчанию (без изменения входа). */
export function normalizeConfig(cfg = {}) {
  const d = DEFAULT_CONFIG;
  const att = { ...d.attachment, ...(cfg.attachment || {}) };
  if (!ATTACHMENTS[att.type]) att.type = 'none';
  const A = ATTACHMENTS[att.type];
  if (A.motor) {
    att.length = num(cfg.attachment?.length, A.length);
    att.ratio = num(cfg.attachment?.ratio, A.ratio);
  }
  return {
    version: 1,
    name: String(cfg.name || d.name),
    wheels: { size: WHEELS[cfg.wheels?.size] ? cfg.wheels.size : d.wheels.size, track: num(cfg.wheels?.track, d.wheels.track), x: num(cfg.wheels?.x, d.wheels.x) },
    chassis: { extraLength: Math.max(0, num(cfg.chassis?.extraLength, 0)), extraWidth: Math.max(0, num(cfg.chassis?.extraWidth, 0)), color: cfg.chassis?.color || 'white' },
    caster: { type: cfg.caster?.type === 'skid' ? 'skid' : 'ball', x: num(cfg.caster?.x, d.caster.x) },
    ballast: Math.max(0, num(cfg.ballast, 0)),
    sensor: { enabled: cfg.sensor?.enabled !== false, x: num(cfg.sensor?.x, d.sensor.x), z: num(cfg.sensor?.z, 0) },
    attachment: { type: att.type, ratio: Math.max(1, num(att.ratio, 1)), length: num(att.length, 0), mount: 'front' },
    teamColor: cfg.teamColor || 'auto',
    hardware: cfg.hardware ? { ...cfg.hardware } : undefined,
  };
}

const box = (name, w, h, d, x, y, z, o = {}) => ({ name, shape: 'box', w, h, d, x, y, z, ...o });

/** Профиль наклона ковша (град, относительно шасси) от угла руки a (град). */
export function scoopPitch(a) {
  if (a < 10) return 0.8 * a;
  if (a < 88) return 8;
  return 8 - (a - 88) * (53 / 27);
}
export const clawPitch = (a) => (a < 8 ? 0.75 * a : 6);
/** Створка захвата: угол (рад) относительно головы; 0 — закрыта, 1.75 — поднята */
export const clawGate = (a) => (a <= 2 ? 1.75 : a >= 9 ? 0 : 1.75 * (9 - a) / 7);

/**
 * Геометрия робота из конфигурации: детали шасси, колёса, рука/голова/створка.
 * Все детали — в системе своего тела. Используется robot.js и validateConfig.
 */
export function robotGeometry(cfgIn) {
  const cfg = normalizeConfig(cfgIn);
  const H = HOUSING, wh = WHEELS[cfg.wheels.size];
  const hc = wh.d / 2 + H.up;          // высота центра корпуса над ковриком
  const ground = -hc;
  const frame = cfg.chassis.extraLength > 0 || cfg.chassis.extraWidth > 0;
  const top = H.H / 2 + (frame ? 0.8 : 0);
  const chassis = [];
  chassis.push(box('housing', H.L, H.H, H.W, 0, 0, 0, { mass: H.mass, mat: 'robot', color: 'white' }));
  if (frame) {
    const fl = H.L + cfg.chassis.extraLength, fw = H.W + cfg.chassis.extraWidth;
    chassis.push(box('frame', fl, 0.8, fw, 0, H.H / 2 + 0.4, 0, { mass: 0.00025 * fl * fw, mat: 'robot', color: 'lightGrey' }));
  }
  // задняя опора
  if (cfg.caster.type === 'ball') {
    chassis.push({ name: 'caster', shape: 'ball', r: 0.8, x: cfg.caster.x, y: ground + 0.8, z: 0, mass: 0.012, mat: 'caster', color: 'lightGrey' });
  } else {
    chassis.push(box('skid', 1.4, 0.6, 1.6, cfg.caster.x, ground + 0.3, 0, { round: 0.25, mass: 0.006, mat: 'caster', color: 'darkGrey' }));
  }
  const casterTop = ground + (cfg.caster.type === 'ball' ? 1.6 : 0.6);
  if (casterTop < -H.H / 2) chassis.push(box('casterPost', 1.2, -H.H / 2 - casterTop, 1.2, cfg.caster.x, (casterTop - H.H / 2) / 2, 0, { mass: 0.004, mat: 'robot', color: 'darkGrey', collide: false }));
  // датчик цвета (Technician tool) смотрит вниз
  if (cfg.sensor.enabled) {
    const S = COLOR_SENSOR;
    const sy = ground + S.gap + S.H / 2;
    chassis.push(box('sensor', S.L, S.H, S.W, cfg.sensor.x, sy, cfg.sensor.z, { mass: S.mass, mat: 'robot', color: 'white' }));
    const postH = -H.H / 2 - (sy + S.H / 2);
    if (postH > 0.05) chassis.push(box('sensorPost', 0.8, postH, 0.8, Math.min(cfg.sensor.x, H.L / 2 - 0.4), sy + S.H / 2 + postH / 2, cfg.sensor.z, { mass: 0.002, collide: false, color: 'lightGrey' }));
  }
  const A = ATTACHMENTS[cfg.attachment.type];
  if (A.motor) chassis.push(box('singleMotor', SINGLE_MOTOR.L, SINGLE_MOTOR.H, SINGLE_MOTOR.W, 0.4, top + SINGLE_MOTOR.H / 2, 0, { mass: SINGLE_MOTOR.mass, mat: 'robot', color: 'white' }));
  if (cfg.attachment.type === 'plow') {
    const py = ground + 0.15 + 0.8;
    chassis.push(box('plowBar', 0.8, 1.6, 7.0, 6.2, py, 0, { mass: 0.012, mat: 'robot', color: 'black' }));
    for (const s of [-1, 1]) chassis.push(box('plowHorn', 4.2, 1.6, 0.8, 8.2, py, s * 3.2, { ry: -s * 0.35, mass: 0.009, mat: 'robot', color: 'black' }));
    chassis.push(box('plowMount', 2.6, 0.8, 1.2, 4.6, py + 0.4, 0, { mass: 0.004, collide: false, color: 'darkGrey' }));
  }
  const wheels = { d: wh.d, w: wh.w, mass: wh.mass, x: cfg.wheels.x, y: -H.up, track: cfg.wheels.track };

  // рука на Single Motor
  let arm = null;
  if (A.motor) {
    const L = clamp(cfg.attachment.length, A.minLen, A.maxLen);
    const pivot = { x: H.L / 2 - 0.2, y: top - 1.0, z: 0 };
    const pivotAbs = hc + pivot.y;
    const linkZ = Math.max(3.4, cfg.wheels.track / 2 + WHEELS[cfg.wheels.size].w / 2 + 0.4); // рычаги снаружи колёс
    if (cfg.attachment.type === 'hammer') {
      arm = {
        kind: 'hammer', L, ratio: cfg.attachment.ratio, pivot, theta0: 0, aMin: -22 * D2R, aMax: 100 * D2R,
        parts: [
          box('beam', L, 0.8, 0.8, L / 2, 0, 0, { mass: 0.012, mat: 'robot', color: 'lightGrey' }),
          box('head', 2.0, 2.0, 3.2, L, 0, 0, { mass: 0.03, mat: 'robot', color: 'darkGrey' }),
        ],
        head: null,
      };
    } else {
      const s = clamp(-pivotAbs / L, -0.95, 0.95);
      const theta0 = Math.asin(s);
      const parts = [];
      for (const z of [-linkZ, linkZ]) parts.push(box('link', L, 0.6, 0.5, L / 2, 0, z, { mass: 0.01, mat: 'robot', color: 'lightGrey', noGround: true }));
      parts.push(box('tube', 0.6, 0.6, 2 * linkZ + 0.5, L, 0, 0, { mass: 0.004, collide: false, color: 'darkGrey' }));
      let head;
      // дно: толстое (не продавливается фишкой под нагрузкой), верх на 0.6 мм ниже коврика — ковш
      // подходит под фишку, не цепляя её кромкой; визуально пластина видна на уровне коврика (vy/vh).
      // hold — объём «внутри» навесного (система головы): фишка с центром здесь касается оборудования.
      const FT = -0.06, FH = 0.6;
      if (cfg.attachment.type === 'scoop') {
        const PL = 6.0, PW = 6.4;
        head = {
          kind: 'scoop', profile: scoopPitch,
          hold: { x0: -0.2, x1: PL, z: PW / 2 - 0.3, y0: FT - 0.2, y1: FT + 2.0 },
          parts: [
            box('floor', PL, FH, PW, PL / 2, FT - FH / 2, 0, { mass: 0.009, mat: 'scoop', color: 'lime', noGround: true, vy: -0.12, vh: 0.3 }),
            box('back', 0.4, 2.8, PW, -0.2, 1.4, 0, { mass: 0.005, mat: 'scoop', color: 'lime', noGround: true }),
            box('side', 4.6, 1.6, 0.3, 2.3, 0.8, PW / 2 - 0.15, { mass: 0.003, mat: 'scoop', color: 'green', noGround: true }),
            box('side', 4.6, 1.6, 0.3, 2.3, 0.8, -PW / 2 + 0.15, { mass: 0.003, mat: 'scoop', color: 'green', noGround: true }),
            box('runner', PL, 0.3, 0.3, PL / 2, 0.15, PW / 2 - 0.15, { mass: 0.001, mat: 'caster', color: 'green', visual: false }),
            box('runner', PL, 0.3, 0.3, PL / 2, 0.15, -PW / 2 + 0.15, { mass: 0.001, mat: 'caster', color: 'green', visual: false }),
          ],
          gate: null,
        };
      } else {
        const IL = 3.8, IW = 3.8;
        head = {
          kind: 'claw', profile: clawPitch,
          hold: { x0: -0.2, x1: IL + 0.2, z: IW / 2, y0: FT - 0.2, y1: FT + 2.4 },
          parts: [
            box('floor', IL + 0.4, FH, IW + 0.6, IL / 2, FT - FH / 2, 0, { mass: 0.008, mat: 'scoop', color: 'darkGrey', noGround: true, vy: -0.12, vh: 0.3 }),
            box('back', 0.4, 2.8, IW + 0.6, -0.2, 1.4, 0, { mass: 0.005, mat: 'scoop', color: 'lightGrey', noGround: true }),
            box('side', IL, 2.6, 0.3, IL / 2, 1.3, IW / 2 + 0.15, { mass: 0.003, mat: 'scoop', color: 'lightGrey', noGround: true }),
            box('side', IL, 2.6, 0.3, IL / 2, 1.3, -IW / 2 - 0.15, { mass: 0.003, mat: 'scoop', color: 'lightGrey', noGround: true }),
            box('flare', 1.4, 2.6, 0.3, IL + 0.55, 1.3, IW / 2 + 0.4, { ry: -0.45, mass: 0.001, mat: 'scoop', color: 'lightGrey', noGround: true }),
            box('flare', 1.4, 2.6, 0.3, IL + 0.55, 1.3, -IW / 2 - 0.4, { ry: 0.45, mass: 0.001, mat: 'scoop', color: 'lightGrey', noGround: true }),
            box('topbar', 0.4, 0.4, IW + 0.6, IL - 0.2, 2.8, 0, { mass: 0.002, mat: 'scoop', color: 'darkGrey' }),
            box('runner', IL, 0.3, 0.3, IL / 2, 0.15, IW / 2 + 0.15, { mass: 0.001, mat: 'caster', visual: false }),
            box('runner', IL, 0.3, 0.3, IL / 2, 0.15, -IW / 2 - 0.15, { mass: 0.001, mat: 'caster', visual: false }),
          ],
          gate: {
            hinge: { x: IL + 0.1, y: 2.8, z: 0 },
            parts: [box('gate', 0.3, 2.4, IW + 0.2, 0.1, -1.25, 0, { mass: 0.004, mat: 'scoop', color: 'orange' })],
            profile: clawGate,
          },
        };
      }
      arm = {
        kind: cfg.attachment.type, L, ratio: cfg.attachment.ratio, pivot, theta0,
        aMin: 0, aMax: (cfg.attachment.type === 'scoop' ? 115 : 100) * D2R,
        parts, head, reachesFloor: Math.abs(-pivotAbs / L) <= 0.95,
      };
    }
  }
  return { cfg, hc, ground, top, chassis, wheels, arm, ballastKg: cfg.ballast / 1000 };
}

// ---------- точки оболочки деталей для габаритов ----------
function rotY(p, a) { const c = Math.cos(a), s = Math.sin(a); return { x: c * p.x + s * p.z, y: p.y, z: -s * p.x + c * p.z }; }
function rotZ(p, a) { const c = Math.cos(a), s = Math.sin(a); return { x: c * p.x - s * p.y, y: s * p.x + c * p.y, z: p.z }; }
/** Угловые точки детали в системе её тела */
export function partCorners(p) {
  const out = [];
  if (p.shape === 'ball') {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) out.push({ x: p.x + dx * p.r, y: p.y + dy * p.r, z: p.z + dz * p.r });
    return out;
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    let q = { x: sx * p.w / 2, y: sy * p.h / 2, z: sz * p.d / 2 };
    if (p.rz) q = rotZ(q, p.rz);
    if (p.ry) q = rotY(q, p.ry);
    out.push({ x: q.x + p.x, y: q.y + p.y, z: q.z + p.z });
  }
  return out;
}

/** Все точки оболочки робота в системе шасси при положении руки a (рад от нижнего упора). */
export function hullPoints(geo, a = 0) {
  const pts = [];
  for (const p of geo.chassis) pts.push(...partCorners(p));
  const W = geo.wheels;
  for (const s of [-1, 1]) for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1]) {
    pts.push({ x: W.x + dx * W.d / 2, y: W.y + dy * W.d / 2, z: s * W.track / 2 + dz * W.w / 2 });
  }
  if (geo.arm) {
    const A = geo.arm, phi = A.theta0 + a;
    const toCh = (q, ang, origin) => { const r = rotZ(q, ang); return { x: r.x + origin.x, y: r.y + origin.y, z: r.z + origin.z }; };
    for (const p of A.parts) for (const c of partCorners(p)) pts.push(toCh(c, phi, A.pivot));
    if (A.head) {
      const tip = toCh({ x: A.L, y: 0, z: 0 }, phi, A.pivot);
      const pitch = A.head.profile(a * 180 / Math.PI) * Math.PI / 180;
      for (const p of A.head.parts) for (const c of partCorners(p)) pts.push(toCh(c, pitch, tip));
      if (A.head.gate) {
        const g = A.head.gate, gh = toCh(g.hinge, pitch, tip), ga = g.profile(a * 180 / Math.PI);
        for (const p of g.parts) for (const c of partCorners(p)) pts.push(toCh(c, pitch + ga, gh));
      }
    }
  }
  return pts;
}

/** Масса и центр масс (в системе шасси, рука внизу) */
export function massProps(geo) {
  let m = 0, mx = 0;
  const add = (mass, x) => { m += mass; mx += mass * x; };
  for (const p of geo.chassis) add(p.mass || 0, p.x);
  add(geo.wheels.mass * 2, geo.wheels.x);
  add(geo.ballastKg, 0);
  if (geo.arm) {
    const A = geo.arm, c = Math.cos(A.theta0), s = Math.sin(A.theta0);
    for (const p of A.parts) add(p.mass || 0, A.pivot.x + c * p.x - s * p.y);
    if (A.head) {
      const tx = A.pivot.x + c * A.L;
      for (const p of A.head.parts) add(p.mass || 0, tx + p.x);
      if (A.head.gate) for (const p of A.head.gate.parts) add(p.mass || 0, tx + A.head.gate.hinge.x);
    }
  }
  return { massKg: m, comX: m > 0 ? mx / m : 0 };
}

/**
 * Проверка конфигурации по правилам железа и inspection.
 * -> { ok, errors[], warnings[], bbox:{lengthCm,widthCm,heightCm}, massKg, cfg }
 */
export function validateConfig(cfgIn) {
  const errors = [], warnings = [];
  if (cfgIn && cfgIn.wheels && cfgIn.wheels.size && !WHEELS[cfgIn.wheels.size]) errors.push(`Неизвестное колесо «${cfgIn.wheels.size}».`);
  if (cfgIn && cfgIn.attachment && cfgIn.attachment.type && !ATTACHMENTS[cfgIn.attachment.type]) errors.push(`Неизвестное навесное «${cfgIn.attachment.type}».`);
  const cfg = normalizeConfig(cfgIn);
  const geo = robotGeometry(cfg);
  const A = ATTACHMENTS[cfg.attachment.type];
  // железо: на стороне команды 1 Double Motor (ходовая), 1 Single Motor и 1 Color Sensor (Technician tool), до 2 пультов
  const hw = { doubleMotors: 1, singleMotors: A.motor ? 1 : 0, colorSensors: cfg.sensor.enabled ? 1 : 0, controllers: 0, ...(cfg.hardware || {}) };
  if (hw.doubleMotors !== 1) errors.push('По правилам Future Edition на роботе ровно один Double Motor (ходовая); второй Double Motor стоит в Grand Tree.');
  if (hw.singleMotors > 1) errors.push('По правилам Future Edition у команды один Single Motor для Technician tool (второй — в Hive).');
  if (hw.colorSensors > 1) errors.push('По правилам Future Edition у команды один Color Sensor для Technician tool (второй — в Young Forest).');
  if (hw.controllers > 2) errors.push('По правилам Future Edition не больше двух пультов (Driver и Specialist).');
  // колея: колёса не должны задевать корпус
  const W = geo.wheels;
  const minTrack = HOUSING.W + W.w + 0.2;
  if (cfg.wheels.track < minTrack) errors.push(`Колея ${cfg.wheels.track.toFixed(1)} см меньше минимальной ${minTrack.toFixed(1)} см: колёса упираются в корпус.`);
  if (cfg.wheels.track > 16) warnings.push('Очень широкая колея: робот хуже проходит между моделями.');
  if (Math.abs(cfg.wheels.x) > HOUSING.L / 2 - 0.4) errors.push('Ось колёс должна проходить через корпус Double Motor (|x| ≤ 3.2 см).');
  if (Math.abs(cfg.caster.x - cfg.wheels.x) < 3) errors.push('Опора слишком близко к оси колёс: робот опрокинется.');
  if (cfg.sensor.enabled && (Math.abs(cfg.sensor.z) > 4 || cfg.sensor.x < -6 || cfg.sensor.x > 9)) warnings.push('Датчик цвета далеко от корпуса — проверьте крепление.');
  if (A.motor && (cfg.attachment.length < A.minLen || cfg.attachment.length > A.maxLen)) warnings.push(`Длина руки ограничена ${A.minLen}…${A.maxLen} см.`);
  if (A.motor && (cfg.attachment.ratio < 1 || cfg.attachment.ratio > 5)) warnings.push('Передаточное число руки обычно 1…5.');
  if (geo.arm && geo.arm.reachesFloor === false) warnings.push('Рука коротка: ковш/захват не опускается до коврика.');
  const clearance = geo.hc - HOUSING.H / 2;
  if (clearance < 1.55) warnings.push(`Клиренс корпуса ${clearance.toFixed(1)} см: фишки (до 1.4 см) могут застревать под роботом.`);
  // габариты в стартовом положении (рука внизу)
  const pts = hullPoints(geo, 0);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); y1 = Math.max(y1, p.y); }
  const bbox = { lengthCm: +(x1 - x0).toFixed(1), widthCm: +(z1 - z0).toFixed(1), heightCm: +(y1 - geo.ground).toFixed(1) };
  if (bbox.heightCm > LIMITS.heightCm) errors.push(`Высота ${bbox.heightCm} см больше 20.3 см (inspection).`);
  const fits = (bbox.lengthCm <= LIMITS.areaL && bbox.widthCm <= LIMITS.areaW) || (bbox.lengthCm <= LIMITS.areaW && bbox.widthCm <= LIMITS.areaL);
  if (!fits) errors.push(`Габарит ${bbox.lengthCm} × ${bbox.widthCm} см не помещается в зону Technician 41.9 × 22.7 см.`);
  const mp = massProps(geo);
  if (mp.massKg > LIMITS.massWarnKg) warnings.push(`Масса ${mp.massKg.toFixed(2)} кг — тяжело для одного Double Motor.`);
  const lo = Math.min(cfg.caster.x, W.x), hi = Math.max(cfg.caster.x, W.x);
  if (mp.comX < lo || mp.comX > hi) warnings.push('Центр масс вне опорной базы: робот будет клевать носом (полозья ковша служат опорой).');
  return { ok: errors.length === 0, errors, warnings, bbox, massKg: +mp.massKg.toFixed(3), comX: +mp.comX.toFixed(2), cfg };
}

// ---------- дополнительные пресеты конструктора (builder.js) ----------
// compact — разворачивается на месте у стартовой точки, не задевая дальний борт (радиус < 14 см);
// fast88 — большие колёса: ~77 см/с на 100 % против ~49 см/с у колёс 56.
export const BUILDER_PRESETS = [
  {
    id: 'compact', version: 1, name: 'Компактный: захват, разворот у борта',
    wheels: { size: '56x14', track: 7.4, x: 2.6 }, chassis: { extraLength: 0, extraWidth: 0, color: 'white' },
    caster: { type: 'ball', x: -0.6 }, ballast: 0, sensor: { enabled: true, x: 4.6, z: 0 },
    attachment: { type: 'claw', ratio: 3, length: 7, mount: 'front' }, teamColor: 'auto',
  },
  {
    id: 'fast88', version: 1, name: 'Быстрый: колёса 88, ковш',
    wheels: { size: '88x14', track: 7.6, x: 1.0 }, chassis: { extraLength: 0, extraWidth: 0, color: 'white' },
    caster: { type: 'ball', x: -3.0 }, ballast: 0, sensor: { enabled: true, x: 4.6, z: 0 },
    attachment: { type: 'scoop', ratio: 3, length: 10, mount: 'front' }, teamColor: 'auto',
  },
];
