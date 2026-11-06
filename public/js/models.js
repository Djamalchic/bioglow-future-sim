// Миссионные модели BIOGLOW Future Edition: визуал (упрощённые LEGO-формы по фото Field Map) +
// неподвижные коллайдеры + механика (рычаги на шарнирах с пружиной, створки, лотки, лопасть Hive).
// Локальная система модели: см, y = 0 на коврике, поворот вокруг Y на yaw (синие — +180°).
import * as THREE from 'three';
import { brick, ringMesh, foliage, C, mat } from './lego.js';
import { RAPIER, G, ALL, qYaw, qMul, qAxis, qRot, qConj, qEuler, jointAngle } from './physics.js';
import { toWorld, sideYaw, TOKEN_SIZE } from './layout.js';
import { Motor, VirtualDrive, SIM } from './motors.js';

const D = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const MECH_FILTER = ALL & ~(G.STATIC | G.GROUND | G.MECH);

/** Общая основа модели: неподвижное тело, визуал, перевод координат. */
class Model {
  constructor(sim, side, key, xmm, ymm, extraYaw = 0) {
    this.sim = sim; this.phys = sim.phys; this.side = side; this.key = key;
    const p = toWorld(xmm, ymm, side);
    this.x = p.x; this.z = p.z; this.yaw = sideYaw(side) + extraYaw;
    this.q = qYaw(this.yaw);
    this.group = new THREE.Group();
    this.group.position.set(p.x, 0, p.z); this.group.rotation.y = this.yaw;
    sim.scene.add(this.group);
    // создание тел и коллайдеров записывается и повторяется в новом мире при сбросе поля (rebuildPhysics)
    this.ops = [];
    this.op(() => { this.body = this.phys.body('fixed', { x: p.x, y: 0, z: p.z }, this.q); });
    this.ownGeo = [];
  }
  /** Выполнить и запомнить шаг создания физики */
  op(fn) { this.ops.push(fn); return fn(); }
  /** Пересоздать тела модели в текущем мире sim.phys (тот же порядок, что при загрузке) */
  rebuildPhysics() { this.phys = this.sim.phys; for (const f of this.ops) f(); }
  /** Локальная точка -> мир */
  toWorld(lp) { const r = qRot(this.q, lp); return { x: this.x + r.x, y: r.y, z: this.z + r.z }; }
  toLocal(p) { const r = qRot(qConj(this.q), { x: p.x - this.x, y: p.y, z: p.z - this.z }); return r; }
  rotVec(lv) { return qRot(this.q, lv); }
  /** Мировой кватернион из локального */
  wq(lq) { return qMul(this.q, lq || { x: 0, y: 0, z: 0, w: 1 }); }
  info(extra = {}) { return { kind: 'model', side: this.side, model: this.key, ...extra }; }
  col(spec, opts = {}) {
    return this.op(() => this.phys.collider(this.body, spec, { mat: opts.mat || 'model', group: G.STATIC, filter: ALL, info: this.info({ color: opts.color }) }));
  }
  /** Брикет: визуал + коллайдер (collide:false — только визуал) */
  block(w, h, d, x, y, z, color, o = {}) {
    const vw = o.vw ?? w, vh = o.vh ?? h, vd = o.vd ?? d;
    if (o.visual !== false) this.group.add(brick(vw, vh, vd, color, x, y, z, { studs: o.studs, rx: o.rx, ry: o.ry, rz: o.rz, opacity: o.opacity }));
    if (o.collide !== false) this.col({ shape: 'box', w, h, d, x, y, z, rx: o.rx, ry: o.ry, rz: o.rz }, { mat: o.mat, color });
  }
  /** Кольцо-микробиом: стенка из сегментов, y0 — низ кольца; floor — своё дно */
  ring(cx, y0, cz, rIn, wall, h, { floor = false, color = C.lime, floorColor = C.brown, segs = 16 } = {}) {
    const g = ringMesh(rIn, rIn + wall, h, color, floorColor);
    g.position.set(cx, y0, cz); this.group.add(g);
    const rm = rIn + wall / 2, len = 2 * rm * Math.tan(Math.PI / segs) * 1.08;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      this.col({ shape: 'box', w: wall, h, d: len, x: cx + Math.cos(a) * rm, y: y0 + h / 2, z: cz + Math.sin(a) * rm, ry: -a }, { color });
    }
    if (floor) this.col({ shape: 'cyl', r: rIn + wall, h: 0.5, x: cx, y: y0 - 0.25, z: cz }, { color: floorColor });
    return { cx, cz, rIn, wall, y0, top: y0 + h, y1: y0 + h + 3.0 };
  }
  /** Точка (мир) внутри кольца-микробиома (центр над отверстием) — для механики (водопад, датчик) */
  inRing(zone, p) {
    if (p.y < zone.y0 - 0.3 || p.y > zone.y1) return false;
    const l = this.toLocal(p);
    return Math.hypot(l.x - zone.cx, l.z - zone.cz) <= zone.rIn - 0.2;
  }
  /** Фишка со следом радиуса fr хотя бы частично в микробиоме: над отверстием или на стенке кольца
   *  («линии и воздух над зоной считаются "в"», Rulebook) — для подсчёта M01 */
  overRing(zone, p, fr) {
    if (p.y < zone.y0 - 0.3 || p.y > zone.y1) return false;
    const l = this.toLocal(p);
    return Math.hypot(l.x - zone.cx, l.z - zone.cz) - fr < zone.rIn + zone.wall / 2;
  }
  inBox(z, p) {
    if (p.y < z.y0 || p.y > z.y1) return false;
    const l = this.toLocal(p);
    return l.x >= z.x0 && l.x <= z.x1 && l.z >= z.z0 && l.z <= z.z1;
  }
  /** Подвижная часть на шарнире-рычаге с пружиной */
  lever(hingeL, axisL, parts, { limits, trigger, k = 1000, c = 30, color = C.black }) {
    const vis = new THREE.Group();
    for (const p of parts) vis.add(brick(p.w, p.h, p.d, p.color ?? color, p.x, p.y, p.z, { studs: p.studs }));
    this.sim.scene.add(vis);
    const lv = { body: null, joint: null, vis, axis: axisL, trigger, k, c, hinge: hingeL, angle: 0, max: 0 };
    this.op(() => {
      const ph = this.phys;
      const lb = ph.body('dynamic', this.toWorld(hingeL), this.q, { canSleep: true, linDamp: 0.1, angDamp: 0.5 });
      for (const p of parts) ph.collider(lb, { shape: 'box', ...p }, { mat: 'model', group: G.MECH, filter: MECH_FILTER, mass: p.mass ?? 0.01, info: this.info({ part: 'lever', color }) });
      const j = ph.revolute(this.body, lb, hingeL, { x: 0, y: 0, z: 0 }, axisL, { limits });
      j.configureMotorPosition(0, k, c);
      j.setMotorMaxForce(1e6);
      lv.body = lb; lv.joint = j;
    });
    return lv;
  }
  leverAngle(lv) { return jointAngle(this.body, lv.body, lv.axis); }
  resetLever(lv) {
    lv.body.setTranslation(this.toWorld(lv.hinge), false); lv.body.setRotation(this.q, false);
    lv.body.setLinvel({ x: 0, y: 0, z: 0 }, false); lv.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    lv.angle = 0; lv.max = 0;
  }
  /** Кинематическое тело (створка, лоток, лопасть) */
  kinematic(originL, parts, color) {
    const vis = new THREE.Group();
    for (const p of parts) vis.add(brick(p.w, p.h, p.d, p.color ?? color, p.x, p.y, p.z, { studs: p.studs, rx: p.rx, ry: p.ry, rz: p.rz }));
    this.sim.scene.add(vis);
    const k = { body: null, vis, origin: originL };
    this.op(() => {
      const ph = this.phys;
      const kb = ph.body('kinematic', this.toWorld(originL), this.q);
      for (const p of parts) ph.collider(kb, { shape: 'box', ...p }, { mat: p.mat || 'model', group: G.MECH, filter: ALL & ~(G.STATIC | G.GROUND), info: this.info({ part: 'mech', color: p.color ?? color }) });
      k.body = kb;
    });
    return k;
  }
  /** Задать позу кинематического тела в локальных координатах модели */
  moveKinematic(k, posL, rotL, teleport = false) {
    const p = this.toWorld(posL), q = this.wq(rotL);
    if (teleport) { k.body.setTranslation(p, false); k.body.setRotation(q, false); }
    else { k.body.setNextKinematicTranslation(p); k.body.setNextKinematicRotation(q); }
  }
  syncBody(vis, b) { const t = b.translation(), r = b.rotation(); vis.position.set(t.x, t.y, t.z); vis.quaternion.set(r.x, r.y, r.z, r.w); }
  tokens() { return []; }
  reset() {}
  preStep() {}
  postStep() {}
  sync() {}
}

// ---------- 1. Grand Tree (M01 микробиом, M02 base -> canopy chamber, 5 K на вершине, 1 R в base) ----------
export class GrandTree extends Model {
  constructor(sim, side, xmm, ymm) {
    super(sim, side, 'tree', xmm, ymm);
    // опора и ствол
    this.block(12, 0.8, 10, 0, 0.4, -2.5, C.darkGrey, { studs: true });
    this.block(8, 29.2, 8, 0, 15.4, -2.5, C.brown);
    for (let i = 0; i < 6; i++) this.group.add(brick(8.1, 0.25, 8.1, C.darkBrown, 0, 4 + i * 5, -2.5));
    // лоток base (дно на 1.6 см) и пандус спереди (+Z)
    this.block(9, 1.6, 6, 0, 0.8, 4.5, C.darkGrey, { studs: true });
    for (const s of [-1, 1]) this.block(0.8, 2.0, 6, s * 4.9, 2.6, 4.5, C.lightGrey);
    const ra = Math.atan2(1.6, 5.0);
    this.block(9, 0.4, Math.hypot(5, 1.6), 0, 0.8 - 0.2 * Math.cos(ra), 10 - 0.2 * Math.sin(ra), C.darkGrey, { rx: ra, mat: 'model' });
    // Double Motor дерева сзади (Specialist)
    this.block(5.2, 3.6, 4.4, 0, 3.0, -8.9, C.white, { studs: true });
    // ветка и кольцо-микробиом (центр ≈ (470, 523) мм на карте)
    this.block(4.2, 1.2, 1.6, -5.9, 9.4, -3.4, C.brown);
    this.ringZone = this.ring(-12, 10.0, -3.7, 3.6, 1.2, 1.6, { floor: true });
    this.group.add(brick(1.0, 6, 1.0, C.darkBrown, -12, 6.6, -3.7)); // подвес (только визуал)
    // canopy chamber справа сверху (прозрачная стенка спереди)
    this.group.add(brick(7, 0.6, 7, C.brown, 8.5, 21.3, -2.5));
    this.group.add(brick(7, 5.4, 0.5, C.brown, 8.5, 24.3, -5.75));
    this.group.add(brick(0.5, 5.4, 7, C.brown, 11.75, 24.3, -2.5));
    this.group.add(brick(7, 5.4, 0.4, C.azure, 8.5, 24.3, 0.8, { opacity: 0.35 }));
    this.group.add(brick(7.2, 0.6, 7.2, C.green, 8.5, 27.3, -2.5, { studs: true }));
    this.col({ shape: 'box', w: 7, h: 6.6, d: 7, x: 8.5, y: 24.3, z: -2.5 });
    // лоток с 5 K на вершине ствола
    this.block(10, 0.6, 10, 0, 30.3, -2.5, C.darkBrown, { studs: true });
    for (const s of [-1, 1]) {
      this.block(10, 1.0, 0.4, 0, 31.1, -2.5 + s * 4.8, C.brown);
      this.block(0.4, 1.0, 10, s * 4.8, 31.1, -2.5, C.brown);
    }
    const crown = foliage(10, 46, 11); crown.position.set(0, 37, -2.5); this.group.add(crown);
    this.group.add(brick(1.4, 8, 1.4, C.brown, -3, 34, -2.5, { rz: 0.5 }));
    this.group.add(brick(1.4, 8, 1.4, C.brown, 3, 34, -2.5, { rz: -0.5 }));
    // лифт (визуал) по передней стороне ствола
    this.lift = brick(4, 0.5, 2.2, C.lightGrey, 0, 2.2, 2.6);
    this.group.add(this.lift);
    // стопка ресурсов в камере (визуал, «прокачанные» фишки)
    this.canopySlots = [];
    for (let i = 0; i < 24; i++) this.canopySlots.push(new THREE.Vector3(6.2 + (i % 3) * 2.2, 22.2 + Math.floor(i / 9) * 1.3, -4.7 + (Math.floor(i / 3) % 3) * 2.2));
    this.baseZone = { x0: -4.5, x1: 4.5, z0: 1.4, z1: 7.7, y0: 1.3, y1: 6.5 };
    this.spots = {
      // инвазивный вид на круглой плите лежит на кольце и закрывает микробиом (фото Field Map p6)
      'gt-ring': { lp: { x: -12, y: this.ringZone.top, z: -3.7 } },
      'gt-base-l': { lp: { x: -6.9, y: 0, z: 10.5 } },
      'gt-base-r': { lp: { x: 6.9, y: 0, z: 10.5 } },
    };
    this.reset();
  }
  tokens() {
    const out = [];
    const kr = TOKEN_SIZE.K;
    const slots = [[-3, -4.1], [0, -4.1], [3, -4.1], [-1.5, -1.0], [1.5, -1.0]];
    for (const [x, z] of slots) out.push({ type: 'K', lp: { x, y: 30.6 + kr.h / 2 + 0.02, z }, tag: 'stash', sleep: true });
    out.push({ type: 'R', lp: { x: 0, y: 1.6 + TOKEN_SIZE.R.h / 2 + 0.02, z: 3.4 }, tag: 'base' });
    return out;
  }
  reset() {
    this.liftAcc = 0; this.carry = null; this.canopy = 0; this.spin = 0;
    for (const m of this.canopyMeshes || []) this.sim.scene.remove(m);
    this.canopyMeshes = [];
    this.lift.position.y = 2.2;
  }
}

// ---------- 3. Cave Waterfall (M03, счётчик 64 деления) ----------
export class Waterfall extends Model {
  constructor(sim, side, xmm, ymm) {
    super(sim, side, 'falls', xmm, ymm);
    this.block(11, 9, 10, 0, 4.5, 0, C.darkGrey);
    this.group.add(brick(11.1, 1.0, 10.1, C.lightGrey, 0, 8.6, 0));
    this.group.add(brick(6, 4, 0.4, C.lightGrey, -1.5, 5.8, 5.05));
    this.capture = this.ring(0, 9.0, 0, 3.6, 1.2, 1.6, { color: C.lime, floorColor: C.darkGrey });
    this.capture.y1 = 12.8;
    this.group.add(brick(2.2, 6, 0.5, C.azure, 2.8, 4.0, 5.1, { opacity: 0.7 }));
    // выходной жёлоб (гладкий) спереди
    // длинный пологий жёлоб: фишка уезжает от точки выпуска, следующая не упирается в неё
    // конец жёлоба на 7 мм над ковриком: фишка спрыгивает плашмя и отъезжает
    const ra = Math.atan2(1.7, 6.6);
    this.block(4.6, 0.4, Math.hypot(6.6, 1.7), 2.8, 1.55 - 0.2 * Math.cos(ra), 8.3 - 0.2 * Math.sin(ra), C.azure, { rx: ra, mat: 'slick' });
    for (const s of [-1, 1]) this.block(0.3, 1.2, 6.6, 2.8 + s * 2.45, 1.9, 8.3, C.azure, { rx: ra });
    this.block(0.6, 0.7, 0.6, 2.8, 0.35, 11.0, C.azure, { collide: false });
    // циферблат: 64 деления, подписи 0, 8, … 56
    const tex = makeDialTexture(); this.dialTex = tex;
    const dgeo = new THREE.CircleGeometry(2.6, 48); this.ownGeo.push(dgeo);
    const dial = new THREE.Mesh(dgeo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 }));
    dial.position.set(-2.4, 4.6, 5.07); this.group.add(dial);
    this.needle = new THREE.Group();
    const nm = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.1, 0.15), mat(C.green));
    nm.position.y = 0.95; this.needle.add(nm);
    this.needle.position.set(-2.4, 4.6, 5.2); this.group.add(this.needle);
    this.exitL = { x: 2.8, y: 2.8, z: 6.6 };
    this.exitV = { x: 0, y: 0, z: 18 };
    this.reset();
  }
  reset() { this.count = 0; this.queue = []; this.nextRelease = 0; this.jamSince = null; this.needle.rotation.z = 0; }
  get display() { return this.count % 64; }
  setNeedle() { this.needle.rotation.z = -(this.display / 64) * Math.PI * 2; }
}

function makeDialTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#f4f4ee'; x.beginPath(); x.arc(128, 128, 126, 0, Math.PI * 2); x.fill();
  x.strokeStyle = '#2f8f3d'; x.lineWidth = 10; x.beginPath(); x.arc(128, 128, 116, 0, Math.PI * 2); x.stroke();
  x.fillStyle = '#2f8f3d'; x.font = 'bold 24px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2 - Math.PI / 2;
    const major = i % 8 === 0;
    const r1 = major ? 86 : 100;
    x.lineWidth = major ? 5 : 2;
    x.beginPath(); x.moveTo(128 + Math.cos(a) * r1, 128 + Math.sin(a) * r1); x.lineTo(128 + Math.cos(a) * 108, 128 + Math.sin(a) * 108); x.stroke();
    if (major) x.fillText(String(i), 128 + Math.cos(a) * 64, 128 + Math.sin(a) * 64);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------- 2. Hollow Tree (M01 микробиом, M04: 2 R в среднем отсеке за створкой) ----------
// Локальная +X смотрит на юг (к пруду 8a): там выход отсека. Рычаг — на боковой грани +Z.
export class HollowTree extends Model {
  constructor(sim, side, xmm, ymm) {
    super(sim, side, 'hollow', xmm, ymm, -Math.PI / 2);
    this.block(7, 1.6, 7, 0, 0.8, 0, C.brown); // ниже наклонного дна: ресурсы опираются только на гладкое дно
    // наклонное гладкое дно отсека (к выходу +X)
    this.slope = -0.2;
    this.block(6.4, 0.6, 5.0, 0.3, 2.3, 0, C.darkBrown, { rz: this.slope, mat: 'slick' });
    this.block(1.0, 3.0, 7, -3.0, 3.5, 0, C.brown);
    for (const s of [-1, 1]) this.block(6.0, 3.0, 1.0, 0.5, 3.5, s * 3.0, C.brown);
    this.block(7, 5, 7, 0, 7.5, 0, C.brown);
    this.group.add(brick(7.2, 1.0, 7.2, C.green, 0, 6.5, 0));
    this.ringZone = this.ring(0, 10.0, 0, 3.6, 1.2, 1.6);
    // створка отсека (кинематическая)
    this.gate = this.kinematic({ x: 3.75, y: 3.5, z: 0 }, [{ w: 0.5, h: 3.0, d: 5.0, x: 0, y: 0, z: 0, color: C.tan, studs: false }], C.tan);
    this.cavity = { x0: -2.6, x1: 3.7, z0: -2.6, z1: 2.6, y0: 1.8, y1: 5.2 };
    // рычаг: на южной грани рядом с выходом, шарнир внизу, ось Z; толкать к стволу (на север, −X)
    this.lv = this.lever({ x: 5.0, y: 0.9, z: 2.9 }, { x: 0, y: 0, z: 1 }, [
      { w: 1.2, h: 6.4, d: 1.2, x: 0, y: 3.2, z: 0, mass: 0.012 },
      { w: 0.8, h: 2.2, d: 3.0, x: 0.5, y: 4.8, z: 0, mass: 0.006, color: C.tan, studs: true },
    ], { limits: [0, 0.55], trigger: 0.33, k: 500, c: 16, color: C.darkBrown });
    this.reset();
  }
  tokens() {
    const rr = TOKEN_SIZE.R, s = this.slope;
    const surf = (x) => 2.3 + 0.3 / Math.cos(s) + Math.tan(s) * (x - 0.3);
    return [2.6, 0.9].map((x) => ({ type: 'R', lp: { x, y: surf(x) + rr.h / 2 + 0.03, z: 0 }, lq: qAxis(0, 0, 1, s), tag: 'hollow' }));
  }
  reset() {
    this.open = false; this.openT = 0; this.released = false;
    this.moveKinematic(this.gate, this.gate.origin, null, true);
    this.resetLever(this.lv);
  }
  preStep(dt) {
    if (this.open && this.openT < 1) {
      this.openT = Math.min(1, this.openT + dt / 0.5);
      this.moveKinematic(this.gate, { x: 3.75, y: 3.5 + 3.6 * this.openT, z: 0 });
    }
  }
  sync() { this.syncBody(this.gate.vis, this.gate.body); this.syncBody(this.lv.vis, this.lv.body); }
}

// ---------- Nest (M04: 3 K в верхнем лотке, рычаг наклоняет лоток) ----------
// Локальная +X смотрит на север (к реке).
export class Nest extends Model {
  constructor(sim, side, xmm, ymm) {
    super(sim, side, 'nest', xmm, ymm, Math.PI / 2);
    this.block(4, 13, 4, -1.5, 6.5, 0, C.brown);
    this.block(9, 0.6, 8, 0.5, 0.3, 0, C.tan, { studs: true });
    // декоративное «гнездо»-кольцо сбоку и листва
    const rg = ringMesh(2.4, 3.6, 1.4); rg.position.set(-1.5, 10.0, 5.6); this.group.add(rg);
    this.col({ shape: 'cyl', r: 3.6, h: 1.4, x: -1.5, y: 10.7, z: 5.6 });
    this.group.add(brick(1.6, 0.6, 3.0, C.brown, -1.5, 9.7, 3.0));
    const leaves = foliage(4.5, 18, 5); leaves.position.set(-2.0, 19.5, 0); this.group.add(leaves);
    // верхний лоток (кинематический, наклоняется вперёд вокруг передней кромки)
    this.pivotL = { x: 2.4, y: 13.0, z: 0 };
    this.tray = this.kinematic(this.pivotL, [
      { w: 9.4, h: 0.5, d: 4.2, x: -4.7, y: 0.25, z: 0, mat: 'slick', color: C.darkBrown, studs: true },
      { w: 0.4, h: 1.4, d: 4.2, x: -9.2, y: 1.0, z: 0, color: C.brown },
      { w: 9.4, h: 1.2, d: 0.4, x: -4.7, y: 0.9, z: 2.3, color: C.brown },
      { w: 9.4, h: 1.2, d: 0.4, x: -4.7, y: 0.9, z: -2.3, color: C.brown },
    ], C.darkBrown);
    // рычаг у плиты: шарнир внизу, ось Z; толкать с севера (вершина уходит к −X)
    this.lv = this.lever({ x: 3.6, y: 1.0, z: -2.6 }, { x: 0, y: 0, z: 1 }, [
      { w: 1.2, h: 9.0, d: 1.6, x: 0, y: 4.5, z: 0, mass: 0.014 },
      { w: 2.2, h: 2.2, d: 2.2, x: 0.6, y: 2.2, z: 0, mass: 0.006, color: C.tan },
    ], { limits: [0, 0.6], trigger: 0.34, k: 550, c: 18, color: C.black });
    this.holdZone = { x0: -7.5, x1: 3.0, z0: -2.5, z1: 2.5, y0: 12.6, y1: 17 };
    this.spots = { 'nest-plate': { lp: { x: 2.6, y: 0.6, z: 2.7 } } };
    this.reset();
  }
  tokens() {
    const kr = TOKEN_SIZE.K;
    // три K в ряд с зазором 1.5 мм: от задней стенки (−6.6) до передней кромки лотка (2.4)
    return [-7.45, -4.5, -1.55].map((x) => ({ type: 'K', lp: { x: this.pivotL.x + x, y: 13.5 + kr.h / 2 + 0.01, z: 0 }, tag: 'nest', sleep: true }));
  }
  reset() {
    this.open = false; this.tilt = 0; this.released = false;
    this.moveKinematic(this.tray, this.pivotL, null, true);
    this.resetLever(this.lv);
  }
  preStep(dt) {
    if (this.open && this.tilt < 0.62) {
      this.tilt = Math.min(0.62, this.tilt + dt * 0.9);
      this.moveKinematic(this.tray, this.pivotL, qAxis(0, 0, 1, -this.tilt));
    }
  }
  sync() { this.syncBody(this.tray.vis, this.tray.body); this.syncBody(this.lv.vis, this.lv.body); }
}

// ---------- 4. Young Forest (M01 микробиом + Color Sensor -> Hive соперника) ----------
export class YoungForest extends Model {
  constructor(sim, side, xmm, ymm) {
    super(sim, side, 'yf', xmm, ymm);
    this.block(8, 9.0, 8, 0, 4.5, 0, C.tan);
    this.group.add(brick(8.1, 2.4, 8.1, C.lightGrey, 0, 1.2, 0));
    this.group.add(brick(6, 4, 0.3, C.darkGrey, 0, 4.5, 4.05));
    this.ringZone = this.ring(0, 9.0, 0, 3.6, 1.2, 1.6, { floorColor: C.darkGrey });
    this.group.add(brick(2.0, 1.2, 2.0, C.white, 2.6, 3.0, 4.2)); // датчик цвета (визуал)
    this.indMat = new THREE.MeshStandardMaterial({ color: 0x334433, emissive: 0x000000 });
    const ig = new THREE.SphereGeometry(0.55, 12, 8); this.ownGeo.push(ig);
    const ind = new THREE.Mesh(ig, this.indMat); ind.position.set(2.6, 3.0, 5.25); this.group.add(ind);
    for (const [x, z, s] of [[-3.0, -6.2, 3], [3.0, -6.4, 7]]) {
      this.block(0.8, 12, 0.8, x, 6, z, C.white);
      const f = foliage(2.6, 12, s); f.position.set(x, 13.5, z); this.group.add(f);
    }
    // инвазивный вид на круглой плите лежит на кольце и закрывает микробиом (фото Field Map p6)
    this.spots = { 'yf-ring': { lp: { x: 0, y: this.ringZone.top, z: 0 } } };
    this.reset();
  }
  reset() { this.triggered = false; this.seen = 0; this.indMat.emissive.setHex(0x000000); }
}

// ---------- 5. Hive (Single Motor -> лопасть сбивает королеву; 3 R на уступе) ----------
export class Hive extends Model {
  constructor(sim, side, xmm, ymm) {
    super(sim, side, 'hive', xmm, ymm);
    this.block(5, 6, 11, 0.5, 3, 0, C.tan);
    this.group.add(brick(5.1, 1.2, 11.1, C.brown, 0.5, 1.0, 0));
    this.group.add(brick(3.0, 3.0, 3.6, C.white, -0.5, 7.5, -4.2, { studs: true })); // Single Motor
    this.col({ shape: 'box', w: 3.0, h: 3.0, d: 3.6, x: -0.5, y: 7.5, z: -4.2 });
    this.block(3, 1.2, 11, 4.5, 0.6, 0, C.azure, { studs: true }); // уступ с тремя R
    this.block(0.4, 0.8, 11, 5.8, 1.6, 0, C.azure);
    this.topY = 6.0;
    this.queenL = { x: 0.5, z: 2.4 };
    this.pivotL = { x: 0.5, y: 8.4, z: -1.8 }; // выше борта (7.6 см): лопасть проходит над ним
    // лопасть на валу мотора (кинематическая, следует за углом мотора)
    this.paddle = this.kinematic(this.pivotL, [
      { w: 6.2, h: 1.2, d: 0.8, x: 3.1, y: 0, z: 0, color: C.lime },
      { w: 1.2, h: 1.6, d: 1.2, x: 0, y: 0, z: 0, color: C.darkGrey },
    ], C.lime);
    this.motor = new Motor('hive', { spec: SIM.single });
    this.drive = new VirtualDrive(this.motor, { inertia: 0.3, friction: 20 });
    this.reset();
  }
  tokens() {
    const rr = TOKEN_SIZE.R;
    const out = [-3.4, 0, 3.4].map((z) => ({ type: 'R', lp: { x: 4.3, y: 1.2 + rr.h / 2 + 0.02, z }, tag: 'hive', sleep: true }));
    out.push({ type: 'Q', lp: { x: this.queenL.x, y: this.topY + 0.02, z: this.queenL.z }, lq: qYaw(Math.PI / 2), tag: 'queen', sleep: true });
    return out;
  }
  // покой: лопасть смотрит на −Z (от королевы); поворот +: через −X (над бортом) к +Z — удар по королеве в сторону поля
  paddleAngle() { return Math.PI / 2 + this.motor.pos * D; }
  reset() {
    this.hit = false; this.motor.reset(); this.drive.reset();
    this.moveKinematic(this.paddle, this.pivotL, qAxis(0, 1, 0, this.paddleAngle()), true);
  }
  trigger() {
    if (this.hit) return false;
    this.hit = true;
    this.motor.runForDegrees(360, 420);
    return true;
  }
  preStep(dt, now) {
    this.motor.update(dt, now);
    this.drive.step(dt);
    this.moveKinematic(this.paddle, this.pivotL, qAxis(0, 1, 0, this.paddleAngle()));
  }
  sync() { this.syncBody(this.paddle.vis, this.paddle.body); }
}

// ---------- 6. Token Recycler ----------
export class Recycler extends Model {
  constructor(sim, side, xmm, ymm) {
    super(sim, side, 'rec', xmm, ymm);
    this.block(6, 10, 6, 0, 5, 0, C.brown);
    this.group.add(brick(7, 1, 7, C.tan, 0, 10.5, 0, { studs: true }));
    this.group.add(brick(3, 2, 0.3, C.darkBrown, 0, 8, 3.05));
    const leaves = foliage(2.5, 10, 9); leaves.position.set(-1.5, 12, -1.5); this.group.add(leaves);
    const ra = Math.atan2(2.0, 4.4);
    this.block(Math.hypot(4.4, 2.0), 0.4, 3.6, 5.2 - 0.2 * Math.sin(ra), 1.0 - 0.2 * Math.cos(ra), 0, C.lightGrey, { rz: -ra, mat: 'slick' });
    this.exitL = { x: 4.6, y: 3.1, z: 0 };
    this.exitV = { x: 12, y: 0, z: 0 };
    this.reset();
  }
  reset() { this.queue = []; this.nextRelease = 0; this.jamSince = null; }
}

// ---------- барьеры Technician / Operator и решётка «mangrove roots» ----------
export function buildBarriers(sim, side, L) {
  const m = new Model(sim, side, 'barrier', 0, 0, 0);
  // модель в точке (0,0) карты без поворота: используем мировые координаты через toWorld
  const wall = (x0, y0, x1, y1, h, t, color, posts = true, vt = t) => {
    const a = toWorld(x0, y0, side), b = toWorld(x1, y1, side), o = toWorld(0, 0, side);
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const yaw = -Math.atan2(b.z - a.z, b.x - a.x);
    // локальные координаты модели = мировые минус начало (поворот модели учитывается в m.q)
    const lc = m.toLocal({ x: (a.x + b.x) / 2, y: h / 2, z: (a.z + b.z) / 2 });
    const ry = yaw - m.yaw;
    m.block(len, h, t, lc.x, h / 2, lc.z, color, { ry, studs: true, vd: vt });
    if (posts) {
      const n = Math.max(2, Math.round(len / 14));
      for (let i = 0; i <= n; i++) {
        const k = i / n;
        const lp = m.toLocal({ x: a.x + (b.x - a.x) * k, y: 0, z: a.z + (b.z - a.z) * k });
        m.group.add(brick(2.0, h + 0.8, 2.0, C.brown, lp.x, (h + 0.8) / 2, lp.z, { ry }));
      }
    }
    return o;
  };
  const T = L.techArea, O = L.operArea, Lt = L.lattice;
  wall(T.x0, T.y0 + 8, T.x0, T.y1, 3.2, 1.6, C.lime);
  wall(T.x0, T.y1, T.x1 - 8, T.y1, 3.2, 1.6, C.lime);
  wall(O.x0, O.y0, O.x1, O.y0, 3.2, 1.6, C.lime);
  wall(O.x0, O.y0, O.x0, O.y1 - 8, 3.2, 1.6, C.lime);
  // корни: 2 столбца × 4 ряда; коллайдер 1.2 см (визуально тоньше)
  for (const x of [Lt.x0, (Lt.x0 + Lt.x1) / 2, Lt.x1]) wall(x, Lt.y0, x, Lt.y1 - 6, 2.2, 1.2, C.brown, false, 0.7);
  for (const y of [980, 1035, 1090]) wall(Lt.x0, y, Lt.x1, y, 2.2, 1.2, C.darkBrown, false, 0.7);
  for (const [x, y, s] of [[1012, 905, 3], [606, 905, 4], [1012, 232, 5]]) {
    const lp = m.toLocal({ ...toWorld(x, y, side), y: 0 });
    m.group.add(brick(1.2, 6, 1.2, C.brown, lp.x, 3, lp.z));
    const f = foliage(2.4, 9, s); f.position.set(lp.x, 6.6, lp.z); m.group.add(f);
  }
  return m;
}

// ---------- фишки (визуал) ----------
let _kg = null, _rg = null;
export function keystoneGeometry() {
  if (_kg) return _kg;
  // жёлтое колесо с протектором: зубчатый профиль, лежит плашмя; центр в середине высоты
  const { r, h } = TOKEN_SIZE.K;
  const shape = new THREE.Shape();
  const teeth = 14, r1 = r, r0 = r * 0.88;
  for (let i = 0; i <= teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const rr = i % 2 === 0 ? r1 : r0;
    if (i === 0) shape.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); else shape.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  const hole = new THREE.Path(); hole.absarc(0, 0, r * 0.32, 0, Math.PI * 2, true); shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h - 0.12, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 1, curveSegments: 6 });
  geo.rotateX(-Math.PI / 2); geo.translate(0, -(h - 0.12) / 2, 0);
  _kg = geo; return geo;
}
export function keystoneHub() {
  return new THREE.CylinderGeometry(TOKEN_SIZE.K.r * 0.55, TOKEN_SIZE.K.r * 0.55, TOKEN_SIZE.K.h * 0.9, 18);
}
export function resourceGeometry() {
  if (_rg) return _rg;
  const { r, h } = TOKEN_SIZE.R;
  const pts = [];
  const b = -h / 2, cyl = h - r * 0.75;
  pts.push(new THREE.Vector2(0, b), new THREE.Vector2(r, b), new THREE.Vector2(r, b + cyl));
  for (let i = 0; i <= 10; i++) { const a = (i / 10) * Math.PI / 2; pts.push(new THREE.Vector2(Math.cos(a) * r, b + cyl + Math.sin(a) * r * 0.75)); }
  _rg = new THREE.LatheGeometry(pts, 22);
  return _rg;
}

/** Размеры инвазивных видов: IR — на круглой плите (крышка кольца-микробиома: шире отверстия 3.6 см,
 *  лежит на стенке кольца), IS — малый, Q — королева */
export const INVASIVE_SIZE = {
  IR: { base: 4.3, baseH: 0.6, w: 2.2, h: 3.4, d: 2.0, mass: 0.016 },
  IS: { base: 0, baseH: 0, w: 1.6, h: 2.6, d: 1.6, mass: 0.006 },
  Q: { base: 0, baseH: 0, w: 2.6, h: 6.0, d: 2.2, mass: 0.02 },
};

/** Инвазивный вид или королева (визуал). Начало — низ фигурки. */
export function invasiveMesh(type) {
  const s = INVASIVE_SIZE[type];
  const g = new THREE.Group();
  let y0 = 0;
  if (s.base) {
    const bg = new THREE.CylinderGeometry(s.base, s.base, s.baseH, 20);
    const b = new THREE.Mesh(bg, mat(C.green)); b.position.y = s.baseH / 2; b.castShadow = true; g.add(b);
    y0 = s.baseH;
  }
  const h = s.h;
  g.add(brick(s.w * 0.92, 0.6, s.d * 0.92, C.teal, 0, y0 + 0.3, 0));
  g.add(brick(s.w, h - 1.2, s.d, C.lime, 0, y0 + 0.6 + (h - 1.2) / 2, 0));
  g.add(brick(s.w, 0.6, s.d * 1.02, type === 'Q' ? C.darkBrown : C.black, 0, y0 + h - 0.3, 0, { studs: true }));
  const eyes = type === 'Q' ? [-0.6, 0.6] : [0];
  for (const ex of eyes) {
    g.add(brick(0.9, 0.9, 0.12, C.white, ex, y0 + h - 1.5, s.d / 2 + 0.05));
    g.add(brick(0.4, 0.4, 0.14, C.black, ex, y0 + h - 1.5, s.d / 2 + 0.1));
  }
  if (type === 'Q') for (const ex of [-0.7, 0.7]) g.add(brick(0.4, 0.9, 0.4, C.green, ex, y0 + h + 0.45, 0));
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

export { Model, D };
