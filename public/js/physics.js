// Обёртка над Rapier 0.21: мир, группы столкновений, материалы, хелперы тел/коллайдеров/шарниров.
// Единицы: см, кг, с. Гравитация −981 см/с². Момент: кг·см²/с² (1 Н·см = 100 ед.).
import RAPIER from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.21.0/dist/rapier.mjs';

let ready = null;
/** Загрузить wasm один раз. */
export function initPhysics() {
  if (!ready) ready = RAPIER.init().then(() => RAPIER);
  return ready;
}
export { RAPIER };

// Шаг физики (подобран тестами: устойчивые фишки, без пролётов при CCD)
export const DT = 1 / 240;
// contactHz — жёсткость контактов (по умолчанию в Rapier 30 Гц): жёсткость мягкого контакта пропорциональна
// массе тела, и лёгкая фишка (6 г) под ковшом робота (сотни граммов) продавливалась на 5 мм; 120 Гц — < 0.5 мм
export const PHYS = { solverIterations: 6, pgsIterations: 1, lengthUnit: 10, ccdSubsteps: 1, contactHz: 120 };

// Группы столкновений (биты)
export const G = {
  GROUND: 1 << 0,
  STATIC: 1 << 1,   // модели и борта
  TOKEN: 1 << 2,    // K, R, инвазивные, королева
  RED: 1 << 3,      // корпус и колёса красного робота
  BLUE: 1 << 4,
  ATT_RED: 1 << 5,  // навесное красного робота
  ATT_BLUE: 1 << 6,
  MECH: 1 << 7,     // подвижные части моделей (рычаги, лотки, лопасть)
};
export const ALL = 0xffff;
/** 32-битная маска групп Rapier: членство << 16 | фильтр */
export const groups = (member, filter) => (((member & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
export const robotGroup = (side) => (side === 'red' ? G.RED : G.BLUE);
export const attGroup = (side) => (side === 'red' ? G.ATT_RED : G.ATT_BLUE);
/** Коллайдеры робота не сталкиваются со своим роботом и своим навесным. */
export const robotFilter = (side) => ALL & ~(robotGroup(side) | attGroup(side));

// Материалы: трение, упругость, правило сочетания
export const MAT = {
  mat: { friction: 0.8, restitution: 0.05 },
  wall: { friction: 0.4, restitution: 0.1 },
  model: { friction: 0.5, restitution: 0.05 },
  slick: { friction: 0.02, restitution: 0.0, combine: 'min' },  // гладкие желоба/лотки
  tire: { friction: 1.0, restitution: 0.0, combine: 'max' },    // резина по коврику
  caster: { friction: 0.02, restitution: 0.0, combine: 'min' }, // шаровая опора
  robot: { friction: 0.4, restitution: 0.05 },
  scoop: { friction: 0.35, restitution: 0.0 },
  K: { friction: 0.6, restitution: 0.08 },
  R: { friction: 0.45, restitution: 0.08 },
  inv: { friction: 0.5, restitution: 0.05 },
};

// ---------- кватернионы и векторы (простые объекты {x,y,z[,w]}) ----------
export const V = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const qYaw = (a) => ({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) });
export const qAxis = (ax, ay, az, a) => { const s = Math.sin(a / 2); return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(a / 2) }; };
export const qIdent = () => ({ x: 0, y: 0, z: 0, w: 1 });
export function qMul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
export const qConj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
/** Поворот вектора кватернионом */
export function qRot(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}
/** Эйлер XYZ (как в three.js) -> кватернион */
export function qEuler(rx = 0, ry = 0, rz = 0) {
  const c1 = Math.cos(rx / 2), c2 = Math.cos(ry / 2), c3 = Math.cos(rz / 2);
  const s1 = Math.sin(rx / 2), s2 = Math.sin(ry / 2), s3 = Math.sin(rz / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}
/** Курс (рад, CCW сверху) по оси +X тела */
export function yawOf(q) {
  const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const fz = 2 * (q.x * q.z - q.w * q.y);
  return Math.atan2(-fz, fx);
}
/** Насколько «вверх» смотрит ось +Y тела (1 = стоит, 0 = лежит на боку) */
export const upY = (q) => 1 - 2 * (q.x * q.x + q.z * q.z);
export const wrapPi = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

/** Угол revolute-шарнира по относительному повороту тел (рад, −π..π). axis — локальная ось тела 1. */
export function jointAngle(b1, b2, axis) {
  const r = qMul(qConj(b1.rotation()), b2.rotation());
  return wrapPi(2 * Math.atan2(r.x * axis.x + r.y * axis.y + r.z * axis.z, r.w));
}
/** Относительная угловая скорость (рад/с) вокруг оси шарнира */
export function jointRate(b1, b2, axis) {
  const a = qRot(b1.rotation(), axis), w1 = b1.angvel(), w2 = b2.angvel();
  return (w2.x - w1.x) * a.x + (w2.y - w1.y) * a.y + (w2.z - w1.z) * a.z;
}

/** Мир Rapier с регистрацией коллайдеров (handle -> info). */
export class Physics {
  constructor() {
    const w = new RAPIER.World({ x: 0, y: -981, z: 0 });
    w.timestep = DT;
    w.numSolverIterations = PHYS.solverIterations;
    w.numInternalPgsIterations = PHYS.pgsIterations;
    w.lengthUnit = PHYS.lengthUnit;
    w.maxCcdSubsteps = PHYS.ccdSubsteps;
    if (w.integrationParameters && 'contact_natural_frequency' in w.integrationParameters) w.integrationParameters.contact_natural_frequency = PHYS.contactHz;
    this.world = w;
    this.R = RAPIER;
    this.info = new Map(); // handle коллайдера -> { kind, side, owner, color }
    this.depth = 0;           // >0 — тела создаёт симулятор (или строитель, зарегистрированный в sim.addBodies)
    this.foreign = new Set(); // тела других модулей, созданные напрямую (при сбросе поля владелец пересоздаёт их сам)
  }
  /** Создание тел «своими» (симулятор знает, как пересоздать их в новом мире) */
  own(fn) { this.depth++; try { return fn(); } finally { this.depth--; } }

  // ---------- тела ----------
  body(type, pos, rot = null, opts = {}) {
    let d;
    if (type === 'fixed') d = RAPIER.RigidBodyDesc.fixed();
    else if (type === 'kinematic') d = RAPIER.RigidBodyDesc.kinematicPositionBased();
    else d = RAPIER.RigidBodyDesc.dynamic();
    d.setTranslation(pos.x, pos.y, pos.z);
    if (rot) d.setRotation(rot);
    if (type === 'dynamic') {
      d.setLinearDamping(opts.linDamp ?? 0.05).setAngularDamping(opts.angDamp ?? 0.1);
      if (opts.ccd) d.setCcdEnabled(true);
      if (opts.canSleep === false) d.setCanSleep(false);
      if (opts.sleeping) d.setSleeping(true);
      if (opts.pgs) d.setAdditionalPgsIterations(opts.pgs);
      if (opts.iters) d.setAdditionalSolverIterations(opts.iters);
    }
    const b = this.world.createRigidBody(d);
    if (this.depth === 0) this.foreign.add(b.handle);
    return b;
  }

  /**
   * Коллайдер по описанию.
   * spec: { shape:'box'|'cyl'|'ball'|'rcyl'|'rbox'|'hull', w,h,d | r,h | pts, x,y,z, rx,ry,rz | q, round }
   * opts: { mat, group, filter, mass, density, sensor, info }
   */
  collider(body, spec, opts = {}) {
    let d;
    const rr = spec.round || 0;
    switch (spec.shape) {
      case 'box': d = rr > 0
        ? RAPIER.ColliderDesc.roundCuboid(Math.max(0.01, spec.w / 2 - rr), Math.max(0.01, spec.h / 2 - rr), Math.max(0.01, spec.d / 2 - rr), rr)
        : RAPIER.ColliderDesc.cuboid(spec.w / 2, spec.h / 2, spec.d / 2); break;
      case 'cyl': d = rr > 0
        ? RAPIER.ColliderDesc.roundCylinder(Math.max(0.01, spec.h / 2 - rr), Math.max(0.01, spec.r - rr), rr)
        : RAPIER.ColliderDesc.cylinder(spec.h / 2, spec.r); break;
      case 'ball': d = RAPIER.ColliderDesc.ball(spec.r); break;
      case 'hull': d = rr > 0 ? RAPIER.ColliderDesc.roundConvexHull(new Float32Array(spec.pts), rr) : RAPIER.ColliderDesc.convexHull(new Float32Array(spec.pts)); break;
      default: throw new Error('unknown shape ' + spec.shape);
    }
    d.setTranslation(spec.x || 0, spec.y || 0, spec.z || 0);
    if (spec.q) d.setRotation(spec.q);
    else if (spec.rx || spec.ry || spec.rz) d.setRotation(qEuler(spec.rx || 0, spec.ry || 0, spec.rz || 0));
    const m = MAT[opts.mat || 'model'] || MAT.model;
    d.setFriction(opts.friction ?? m.friction).setRestitution(m.restitution);
    if (m.combine === 'max') d.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max);
    else if (m.combine === 'min') d.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
    if (opts.mass !== undefined) d.setMass(opts.mass);
    else d.setDensity(opts.density ?? 0.0006);
    if (opts.group !== undefined) d.setCollisionGroups(groups(opts.group, opts.filter ?? ALL));
    if (opts.sensor) d.setSensor(true);
    const c = this.world.createCollider(d, body);
    if (opts.info) this.info.set(c.handle, opts.info);
    return c;
  }

  /** Revolute-шарнир. a1/a2 — точки в локальных системах тел, axis — локальная ось (одна для обоих тел). */
  revolute(b1, b2, a1, a2, axis, opts = {}) {
    const n = Math.hypot(axis.x, axis.y, axis.z) || 1;
    const ax = { x: axis.x / n, y: axis.y / n, z: axis.z / n };
    const j = this.world.createImpulseJoint(RAPIER.JointData.revolute(a1, a2, ax), b1, b2, true);
    j.setContactsEnabled(false);
    if (opts.limits) j.setLimits(opts.limits[0], opts.limits[1]);
    if (opts.motor !== false) {
      j.configureMotorModel(RAPIER.MotorModel.ForceBased);
      j.configureMotorVelocity(0, opts.friction ?? 0);
      j.setMotorMaxForce(opts.maxForce ?? 1e9);
    }
    j.axis = ax;
    return j;
  }

  removeBody(b) {
    if (!b) return;
    for (let i = 0; i < b.numColliders(); i++) this.info.delete(b.collider(i).handle);
    this.foreign.delete(b.handle);
    this.world.removeRigidBody(b);
  }

  /** Информация о коллайдере по handle */
  infoOf(h) { return this.info.get(h); }

  /** Луч вниз/в любую сторону: { collider, toi, info } | null */
  ray(origin, dir, maxToi, filterGroups, excludeBody) {
    const r = new RAPIER.Ray(origin, dir);
    const hit = this.world.castRay(r, maxToi, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, filterGroups, undefined, excludeBody);
    if (!hit) return null;
    return { collider: hit.collider, toi: hit.timeOfImpact ?? hit.toi, info: this.info.get(hit.collider.handle) };
  }

  /** Есть ли твёрдые коллайдеры в объёме формы (для безопасного выпуска фишек) */
  occupied(pos, rot, shape, filterGroups, exclude) {
    let hit = false;
    this.world.intersectionsWithShape(pos, rot, shape, (c) => {
      // коллайдер удалён после последнего шага (снятая фишка, пересобранный робот) — пропустить
      if (!c || !this.info.has(c.handle)) return true;
      if (exclude && exclude(c)) return true;
      hit = true; return false;
    }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, filterGroups);
    return hit;
  }

  step(events) { this.world.step(events); }
  free() { try { this.world.free(); } catch (e) { /* уже освобождён */ } }
}
