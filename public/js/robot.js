// Робот из конфигурации (RobotConfig): корпус Double Motor — динамическое тело, два колеса на revolute-шарнирах
// с моторами Rapier (ForceBased, предел момента по кривой мотора), шаровая опора/полоз с малым трением,
// навесное на Single Motor — отдельные тела на шарнирах. Энкодеры — угол колеса относительно корпуса,
// IMU — по ориентации корпуса. Оси робота: вперёд = +X, вверх = +Y, правый бок = +Z. Единицы: см.
import * as THREE from 'three';
import { RAPIER, G, ALL, groups, robotGroup, attGroup, robotFilter, qYaw, qMul, qAxis, qRot, yawOf, jointAngle, jointRate, wrapPi } from './physics.js';
import { brick, C, mat } from './lego.js';
import { Motor, SIM, END, T_EPS, trapezoid } from './motors.js';
import { robotGeometry, normalizeConfig, partCorners, hullPoints } from './robotConfig.js';
import { toWorld, toMap, inRect, sideYaw, L as LAYOUT } from './layout.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap180 = (a) => ((a + 180) % 360 + 360) % 360 - 180;
const COLORS = { white: C.white, lightGrey: C.lightGrey, darkGrey: C.darkGrey, black: C.black, lime: C.lime, green: C.green, orange: C.orange, teal: C.teal, azure: C.azure, yellow: C.yellow, red: C.red, blue: C.blue, tan: C.tan };
const KH = 1.2;   // удержание курса при езде прямо
const KY = 6;     // петля по курсу при повороте, 1/с
// Доп. итерации решателя для тел робота: без них моторы руки и колёс (лёгкие тела на тяжёлом корпусе) не
// сходятся — рука держит груз «вполсилы», мощность завышена, стоящий робот ползёт и крутит энкодеры
const ROBOT_ITERS = 16;

export class Robot {
  constructor(sim, side, cfg, pose = null) {
    this.sim = sim;
    this.phys = sim.phys;
    this.side = side;
    this.config = normalizeConfig(cfg);
    this.geo = robotGeometry(this.config);
    this.left = new Motor('L', { spec: SIM.drive });
    this.right = new Motor('R', { spec: SIM.drive });
    this.arm = new Motor('arm', { spec: SIM.single, defaultEnd: END.HOLD }); // рука по умолчанию держит положение
    // упоры руки в градусах мотора (0 = стартовое положение руки): удержание не давит в упор
    const A0 = this.geo.arm;
    if (A0) this.arm.limits = [A0.aMin * R2D * A0.ratio, A0.aMax * R2D * A0.ratio];
    this.moveSpeed = 50; this.steering = 100;
    this.drive = null;
    this.yawCont = 0; this.yawZero = 0; this.yawResetVal = 0; this._yawRaw = 0;
    this.ledColor = C.white;
    this.dragging = false;
    this.bodies = [];
    this.colliderHandles = new Set();
    this.group = new THREE.Group();
    this.group.name = 'robot-' + side;
    this.ownGeo = [];
    this.enc = {};
    const p = pose || this.startPose();
    this.build(p.x, p.z, p.yaw);
    this.resetMotors();
  }

  startPose() {
    const s = LAYOUT.robotStart, p = toWorld(s.x, s.y, this.side);
    return { x: p.x, z: p.z, yaw: s.yaw * D2R + sideYaw(this.side) };
  }

  // ---------- постройка ----------
  /** Тела и шарниры в мире Rapier. visuals=false — только физика (визуал уже есть: пересборка мира). */
  build(x, z, yaw, visuals = true) {
    const ph = this.phys, geo = this.geo, side = this.side;
    const oldWheels = this.wheels || [];
    const q0 = qYaw(yaw), P0 = { x, y: geo.hc + 0.02, z };
    const at = (lp) => { const r = qRot(q0, lp); return { x: P0.x + r.x, y: P0.y + r.y, z: P0.z + r.z }; };
    const rg = robotGroup(side), ag = attGroup(side), filt = robotFilter(side);
    const info = (part, body) => ({ kind: 'robot', side, robot: this, part, body });
    const addCol = (body, p, group, bodyName) => {
      if (p.collide === false) return null;
      let f = filt;
      if (p.noGround) f &= ~G.GROUND;
      const c = ph.collider(body, p, { mat: p.mat || 'robot', group, filter: f, mass: p.mass || 0.001, info: info(p.name, bodyName) });
      this.colliderHandles.add(c.handle);
      return c;
    };
    const extraMass = (parts) => parts.reduce((s, p) => s + (p.collide === false ? (p.mass || 0) : 0), 0);

    // корпус
    const ch = ph.body('dynamic', P0, q0, { canSleep: false, linDamp: 0.02, angDamp: 0.05, pgs: 2, iters: ROBOT_ITERS });
    for (const p of geo.chassis) addCol(ch, p, rg, 'chassis');
    const add = extraMass(geo.chassis) + geo.ballastKg;
    if (add > 0) ch.setAdditionalMass(add, true);
    this.chassis = ch; this.bodies.push(ch);
    if (visuals) this.chassisVis = this.visualFor(geo.chassis, true);

    // колёса
    const W = geo.wheels;
    this.wheels = [];
    for (const s of [-1, 1]) {
      const lp = { x: W.x, y: W.y, z: s * W.track / 2 };
      const wb = ph.body('dynamic', at(lp), q0, { canSleep: false, linDamp: 0, angDamp: 0.02, pgs: 2, iters: ROBOT_ITERS });
      const c = ph.collider(wb, { shape: 'cyl', r: W.d / 2, h: W.w, round: 0.15, q: qAxis(1, 0, 0, Math.PI / 2) },
        { mat: 'tire', group: rg, filter: filt, mass: W.mass, info: info('wheel', s < 0 ? 'wheelL' : 'wheelR') });
      this.colliderHandles.add(c.handle);
      const j = ph.revolute(ch, wb, lp, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
      const ow = oldWheels[this.wheels.length];
      this.wheels.push({ body: wb, joint: j, vis: visuals || !ow ? this.wheelVisual(W) : ow.vis });
      this.bodies.push(wb);
    }
    this.enc.L = { b1: ch, b2: this.wheels[0].body, axis: this.wheels[0].joint.axis, prev: 0, acc: 0, zero: 0, sign: 1, ratio: 1 };
    this.enc.R = { b1: ch, b2: this.wheels[1].body, axis: this.wheels[1].joint.axis, prev: 0, acc: 0, zero: 0, sign: -1, ratio: 1 };

    // навесное
    this.armBody = null; this.headBody = null; this.gateBody = null;
    const A = geo.arm;
    if (A) {
      const qa = qMul(q0, qAxis(0, 0, 1, A.theta0));
      const ab = ph.body('dynamic', at(A.pivot), qa, { canSleep: false, linDamp: 0.02, angDamp: 0.05, pgs: 2, iters: ROBOT_ITERS });
      for (const p of A.parts) addCol(ab, p, ag, 'arm');
      const am = extraMass(A.parts); if (am > 0) ab.setAdditionalMass(am, true);
      const aj = ph.revolute(ch, ab, A.pivot, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { limits: [A.theta0 + A.aMin, A.theta0 + A.aMax] });
      this.armBody = ab; this.armJoint = aj; this.bodies.push(ab);
      if (visuals) this.armVis = this.visualFor(A.parts);
      this.enc.A = { b1: ch, b2: ab, axis: aj.axis, prev: A.theta0, acc: A.theta0, zero: 0, sign: 1, ratio: A.ratio, base: A.theta0 };
      if (A.head) {
        const tip = qRot(qa, { x: A.L, y: 0, z: 0 }), pv = at(A.pivot);
        const hp = { x: pv.x + tip.x, y: pv.y + tip.y, z: pv.z + tip.z };
        const hq = qMul(q0, qAxis(0, 0, 1, A.head.profile(0) * D2R));
        const hb = ph.body('dynamic', hp, hq, { canSleep: false, linDamp: 0.02, angDamp: 0.05, pgs: 2, iters: ROBOT_ITERS });
        for (const p of A.head.parts) addCol(hb, p, ag, 'head');
        const hj = ph.revolute(ab, hb, { x: A.L, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
        hj.setMotorMaxForce(5000);
        this.headBody = hb; this.headJoint = hj; this.bodies.push(hb);
        if (visuals) this.headVis = this.visualFor(A.head.parts);
        if (A.head.gate) {
          const g = A.head.gate, gh = qRot(hq, g.hinge);
          const gq = qMul(hq, qAxis(0, 0, 1, g.profile(0)));
          const gb = ph.body('dynamic', { x: hp.x + gh.x, y: hp.y + gh.y, z: hp.z + gh.z }, gq, { canSleep: false, linDamp: 0.02, angDamp: 0.1, iters: ROBOT_ITERS });
          for (const p of g.parts) addCol(gb, p, ag, 'gate');
          const gj = ph.revolute(hb, gb, g.hinge, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { limits: [-0.05, 1.8] });
          gj.setMotorMaxForce(300);
          this.gateBody = gb; this.gateJoint = gj; this.bodies.push(gb);
          if (visuals) this.gateVis = this.visualFor(g.parts);
        }
      }
    }
    this._yawRaw = yawOf(q0) * R2D;
    this.yawCont = yaw * R2D;
    for (const k of Object.keys(this.enc)) { const e = this.enc[k]; e.prev = jointAngle(e.b1, e.b2, e.axis); e.acc = e.base !== undefined ? e.prev : 0; }
  }

  /** three.js-группа деталей тела (в мире; положение задаётся sync) */
  visualFor(parts, isChassis = false) {
    const g = new THREE.Group();
    for (const p of parts) {
      if (p.visual === false) continue;
      const col = COLORS[p.color] ?? C.lightGrey;
      if (p.shape === 'ball') {
        const geo = new THREE.SphereGeometry(p.r, 16, 12); this.ownGeo.push(geo);
        const m = new THREE.Mesh(geo, mat(col)); m.position.set(p.x, p.y, p.z); m.castShadow = true; g.add(m);
      } else {
        // своя геометрия (не общий кэш lego.js): размеры из конструктора не копятся в памяти, dispose() её освобождает
        g.add(brick(p.w, p.vh ?? p.h, p.d, col, p.x, p.vy ?? p.y, p.z, { studs: p.name === 'housing' || p.name === 'frame' || p.name === 'singleMotor', rx: p.rx, ry: p.ry, rz: p.rz, ownGeo: this.ownGeo }));
      }
    }
    if (isChassis) {
      const H = 4.4, team = this.side === 'red' ? C.red : C.blue;
      g.add(brick(7.26, 0.9, 5.66, C.teal, 0, -H / 2 + 0.8, 0));
      g.add(brick(2.4, 0.5, 5.7, team, -2.2, H / 2 - 0.2, 0));
      const top = this.geo.top;
      const lg = new THREE.SphereGeometry(0.45, 12, 8); this.ownGeo.push(lg);
      this.ledMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8 });
      this.led = new THREE.Mesh(lg, this.ledMat); this.led.position.set(-2.4, top + 0.3, 0); g.add(this.led);
      if (this.config.sensor.enabled) {
        const lgeo = new THREE.CylinderGeometry(0.45, 0.45, 0.1, 14); this.ownGeo.push(lgeo);
        const lens = new THREE.Mesh(lgeo, mat(C.black));
        lens.position.set(this.config.sensor.x, this.geo.ground + 0.78, this.config.sensor.z); g.add(lens);
      }
    }
    this.group.add(g);
    return g;
  }
  wheelVisual(W) {
    const w = new THREE.Group();
    const tg = new THREE.CylinderGeometry(W.d / 2, W.d / 2, W.w, 28), hg = new THREE.CylinderGeometry(W.d * 0.27, W.d * 0.27, W.w + 0.1, 6);
    this.ownGeo.push(tg, hg);
    const tire = new THREE.Mesh(tg, mat(C.black, { rough: 0.85 })); tire.rotation.x = Math.PI / 2; tire.castShadow = true;
    const hub = new THREE.Mesh(hg, mat(C.lightGrey)); hub.rotation.x = Math.PI / 2;
    w.add(tire, hub, brick(W.d * 0.46, 0.5, W.w + 0.15, C.darkGrey, 0, 0, 0, { ownGeo: this.ownGeo }));
    this.group.add(w);
    return w;
  }

  /** Удалить тела и визуал (при пересборке). */
  dispose() {
    this.cancelTurn('aborted');
    for (const m of [this.left, this.right, this.arm]) if (m.cmd && m.cmd.resolve) { const r = m.cmd.resolve; m.cmd.resolve = null; r('aborted'); }
    for (const b of this.bodies) this.phys.removeBody(b);
    this.bodies = [];
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); }); // шипы брикетов
    for (const g of this.ownGeo) g.dispose();
    if (this.ledMat) this.ledMat.dispose();
    this.ownGeo = [];
  }

  /** Пересоздать тела в новом мире Rapier (сброс поля): визуал и объекты моторов прежние,
   *  состояние — как у только что построенного робота (детерминизм «сброс = новая загрузка»). */
  rebuildPhysics(pose = null) {
    this.cancelTurn('aborted');
    for (const m of [this.left, this.right, this.arm]) if (m.cmd && m.cmd.resolve) { const r = m.cmd.resolve; m.cmd.resolve = null; r('aborted'); }
    const p = pose || this.startPose();
    this.phys = this.sim.phys;
    this.bodies = []; this.colliderHandles = new Set(); this.enc = {};
    this.yawCont = 0; this.yawZero = 0; this.yawResetVal = 0; this._yawRaw = 0;
    this.dragging = false;
    this.build(p.x, p.z, p.yaw, false);
    this.resetMotors();
  }

  // ---------- состояние ----------
  resetMotors() {
    for (const m of [this.left, this.right, this.arm]) m.reset();
    for (const k of ['L', 'R']) this.enc[k].zero = this.enc[k].sign * this.enc[k].acc * R2D;
    // рука держит текущее положение (иначе тяжёлое навесное медленно опускается)
    if (this.geo.arm) { this.arm.pos = (this.enc.A.acc - this.enc.A.base) * R2D * this.geo.arm.ratio; this.arm.holdPos = this.arm.pos; this.arm.cmd = { type: 'hold' }; }
    this.drive = null; this.moveSpeed = 50; this.steering = 100;
    this.yawZero = this.yawCont; this.yawResetVal = 0;
    this.setLed(C.white);
  }
  /**
   * Вернуть робота в зону Technician (Courtesy rule, падение со стола). free (по умолчанию) — если стартовое
   * место занято (фишки, другой робот), ищется ближайшее свободное место целиком в зоне Technician.
   * -> { x, z, yaw, free } — где поставлен и было ли место свободно.
   */
  resetPose({ free = true } = {}) {
    let p = this.startPose(), ok = true;
    if (free) {
      const f = this.findFreePose(p);
      if (f) p = f; else ok = false;
    }
    this.setPose(p.x, p.z, p.yaw, true);
    this.resetMotors();
    if (!ok && this.sim.emit) this.sim.emit('event', this.side, 'Зона Technician занята: робот поставлен на старт поверх препятствия — освободите место');
    return { ...p, free: ok };
  }

  /** Позы тел робота для корпуса в (x, z, yaw): [[body, p, q], ...]. armDown — рука на нижнем упоре. */
  posesFor(x, z, yaw, armDown = false) {
    const geo = this.geo, q0 = qYaw(yaw), P0 = { x, y: geo.hc + 0.02, z };
    const at = (lp) => { const r = qRot(q0, lp); return { x: P0.x + r.x, y: P0.y + r.y, z: P0.z + r.z }; };
    const out = [[this.chassis, P0, q0]];
    const W = geo.wheels;
    this.wheels.forEach((w, i) => out.push([w.body, at({ x: W.x, y: W.y, z: (i ? 1 : -1) * W.track / 2 }), q0]));
    const A = geo.arm;
    if (A) {
      const phi = armDown ? A.theta0 : clamp(this.enc.A.acc, A.theta0 + A.aMin, A.theta0 + A.aMax);
      const a = phi - A.theta0;
      const qa = qMul(q0, qAxis(0, 0, 1, phi));
      const pv = at(A.pivot);
      out.push([this.armBody, pv, qa]);
      if (this.headBody) {
        const tip = qRot(qa, { x: A.L, y: 0, z: 0 });
        const hp = { x: pv.x + tip.x, y: pv.y + tip.y, z: pv.z + tip.z };
        const hq = qMul(q0, qAxis(0, 0, 1, A.head.profile(a * R2D) * D2R));
        out.push([this.headBody, hp, hq]);
        if (this.gateBody) {
          const g = A.head.gate, gh = qRot(hq, g.hinge);
          out.push([this.gateBody, { x: hp.x + gh.x, y: hp.y + gh.y, z: hp.z + gh.z }, qMul(hq, qAxis(0, 0, 1, g.profile(a * R2D)))]);
        }
      }
    }
    return out;
  }

  /** Свободно ли место: коллайдеры робота в позе (рука внизу) не пересекают фишки, другого робота, модели */
  poseFree(x, z, yaw) {
    const own = robotGroup(this.side) | attGroup(this.side);
    const filt = groups(ALL, (G.TOKEN | G.RED | G.BLUE | G.ATT_RED | G.ATT_BLUE | G.STATIC | G.MECH) & ~own);
    for (const [b, p, q] of this.posesFor(x, z, yaw, true)) {
      for (let i = 0; i < b.numColliders(); i++) {
        const c = b.collider(i);
        const lo = qRot(q, c.translationWrtParent()), lq = c.rotationWrtParent();
        const wp = { x: p.x + lo.x, y: p.y + lo.y, z: p.z + lo.z };
        if (this.phys.occupied(wp, qMul(q, lq), c.shape, filt)) return false;
      }
    }
    return true;
  }

  /** Ближайшая к p свободная поза, при которой робот целиком в зоне Technician; null — места нет */
  findFreePose(p) {
    const hull = hullPoints(this.geo, 0), T = LAYOUT.techArea;
    const inside = (x, z, yaw) => {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      for (const h of hull) {
        const mp = toMap(x + c * h.x + s * h.z, z - s * h.x + c * h.z, this.side);
        if (!inRect(T, mp, -2)) return false;
      }
      return true;
    };
    const cand = [];
    for (let i = -8; i <= 8; i++) for (let j = -4; j <= 4; j++) cand.push([i * 2, j * 2]);
    cand.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]) || a[0] - b[0] || a[1] - b[1]);
    const sg = this.side === 'blue' ? -1 : 1; // смещения (см) по карте своей стороны -> мир
    for (const [dx, dy] of cand) {
      const x = p.x + sg * dx, z = p.z + sg * dy;
      if (!inside(x, z, p.yaw) && !(dx === 0 && dy === 0)) continue;
      if (this.poseFree(x, z, p.yaw)) return { x, z, yaw: p.yaw };
    }
    return null;
  }

  /** Поставить робота (корпус в точку x,z с курсом yaw, рад). armDown — рука на нижний упор. */
  setPose(x, z, yaw, armDown = false) {
    const place = (b, p, q) => { b.setTranslation(p, false); b.setRotation(q, false); b.setLinvel({ x: 0, y: 0, z: 0 }, false); b.setAngvel({ x: 0, y: 0, z: 0 }, false); b.wakeUp(); };
    const q0 = qYaw(yaw);
    for (const [b, p, q] of this.posesFor(x, z, yaw, armDown)) place(b, p, q);
    // энкодеры: продолжаем счёт без скачка
    for (const k of Object.keys(this.enc)) {
      const e = this.enc[k]; const raw = jointAngle(e.b1, e.b2, e.axis);
      if (e.base !== undefined) { e.acc = raw; } e.prev = raw; e.rate = 0;
    }
    // IMU «чувствует» поворот робота руками: продолжаем непрерывный курс
    const yd = yawOf(q0) * R2D;
    this.yawCont += wrap180(yd - this._yawRaw); this._yawRaw = yd;
    if (this.drive) this.cancelTurn('aborted');
  }

  get position() { return this.chassis.translation(); }
  get yawWorld() { return yawOf(this.chassis.rotation()); }
  get forward() { const y = this.yawWorld; return { x: Math.cos(y), z: -Math.sin(y) }; }
  get imuYaw() { return wrap180(this.yawCont - this.yawZero + this.yawResetVal); }
  get imuPitch() { const q = this.chassis.rotation(); const f = qRot(q, { x: 1, y: 0, z: 0 }); return Math.asin(clamp(f.y, -1, 1)) * R2D; }
  get imuRoll() { const q = this.chassis.rotation(); const r = qRot(q, { x: 0, y: 0, z: 1 }); return -Math.asin(clamp(r.y, -1, 1)) * R2D; }
  get gyroZ() { return this.chassis.angvel().y * R2D; }
  /** Угол руки (°) от нижнего упора */
  get armAngle() { return this.geo.arm ? (this.enc.A.acc - this.geo.arm.theta0) * R2D : 0; }
  /** Совместимость: «тело» как в cannon (только чтение) */
  get body() {
    const c = this.chassis;
    return { position: c.translation(), quaternion: c.rotation(), velocity: c.linvel(), angularVelocity: c.angvel() };
  }

  setLed(color) { this.ledColor = color; if (this.ledMat) { this.ledMat.color.setHex(color); this.ledMat.emissive.setHex(color); } }

  degToCm(degS) { return degS / 360 * Math.PI * this.geo.wheels.d; }
  cmToDeg(cmS) { return cmS / (Math.PI * this.geo.wheels.d) * 360; }
  /** «Вперёд» по колёсам, градусы колеса (левый мотор CW = назад, правый CW = вперёд) */
  get fwdL() { return -this.left.pos; }
  get fwdR() { return this.right.pos; }

  // ---------- шаг ----------
  preStep(dt, now) {
    this.driveUpdate(dt, now);
    this.left.update(dt, now); this.right.update(dt, now); this.arm.update(dt, now);
    this.applyMotor(this.wheels[0].joint, this.left, 1, 1);
    this.applyMotor(this.wheels[1].joint, this.right, -1, 1);
    const A = this.geo.arm;
    if (A) {
      this.applyMotor(this.armJoint, this.arm, 1, A.ratio);
      const a = (this.enc.A.acc - A.theta0) * R2D;
      if (this.headJoint) this.headJoint.configureMotorPosition(A.head.profile(a) * D2R - this.enc.A.acc, 2.5e4, 250);
      if (this.gateJoint) this.gateJoint.configureMotorPosition(A.head.gate.profile(a), 600, 6);
    }
  }
  /** Выход регулятора мотора -> мотор шарнира Rapier (sign — направление, ratio — редукция) */
  applyMotor(j, m, sign, ratio) {
    const o = m.out;
    j.configureMotorVelocity(sign * o.vel * D2R / ratio, o.kd * R2D * ratio * ratio);
    j.setMotorMaxForce(o.max * ratio);
  }

  /** Энкодер: угол шарнира (с разворачиванием) и скорость как производная угла с фильтром ~15 мс
   *  (мгновенная скорость тел дрожит, когда мотор давит в упор — по ней не поймать заклинивание). */
  readEnc(e, dt) {
    const raw = jointAngle(e.b1, e.b2, e.axis);
    const d = wrapPi(raw - e.prev);
    e.acc += d; e.prev = raw;
    const k = dt / (0.015 + dt);
    e.rate = (e.rate || 0) + k * (d / dt - (e.rate || 0));
    return e.rate;
  }

  postStep(dt) {
    const rL = this.readEnc(this.enc.L, dt), rR = this.readEnc(this.enc.R, dt);
    this.left.measure(rL * R2D, dt, this.enc.L.acc * R2D - this.enc.L.zero);
    this.right.measure(-rR * R2D, dt, -this.enc.R.acc * R2D - this.enc.R.zero);
    if (this.geo.arm) {
      const e = this.enc.A, rA = this.readEnc(e, dt);
      this.arm.measure(rA * R2D * e.ratio, dt, (e.acc - e.base) * R2D * e.ratio);
    }
    const y = yawOf(this.chassis.rotation()) * R2D;
    let d = y - this._yawRaw; d -= 360 * Math.round(d / 360);
    this.yawCont += d; this._yawRaw = y;
    this.driveCheck(dt);
    // упал со стола — вернуть в зону Technician (как Courtesy rule)
    if (this.chassis.translation().y < -20) { this.resetPose(); this.sim.emit && this.sim.emit('event', this.side, 'Робот упал со стола — возвращён в зону Technician'); }
  }

  sync() {
    const put = (g, b) => { const t = b.translation(), q = b.rotation(); g.position.set(t.x, t.y, t.z); g.quaternion.set(q.x, q.y, q.z, q.w); };
    put(this.chassisVis, this.chassis);
    this.wheels.forEach((w) => put(w.vis, w.body));
    if (this.armBody) put(this.armVis, this.armBody);
    if (this.headBody) put(this.headVis, this.headBody);
    if (this.gateBody) put(this.gateVis, this.gateBody);
  }
  syncVisual() { this.sync(); }

  // ---------- синхронная ходовая (movement_*) ----------
  cancelTurn(result = 'aborted') {
    const d = this.drive;
    if (!d) return;
    this.drive = null;
    if (d.resolve) { const r = d.resolve; d.resolve = null; r(result); }
  }
  finishDrive(result) {
    const d = this.drive;
    if (!d) return;
    this.drive = null;
    for (const m of [this.left, this.right]) { const c = m.cmd; m.cmd = null; m._applyEnd({ speed: c && c.vel, target: m.pos }); }
    if (d.resolve) { const r = d.resolve; d.resolve = null; r(result); }
  }

  /** Множители колёс для направления (вперёд-градусы колеса на единицу) */
  dirFactors(direction) {
    const st = this.steering / 100;
    switch (direction) {
      case 1: return [-1, -1];
      case 2: return [1 - 2 * st, 1];
      case 3: return [1, 1 - 2 * st];
      default: return [1, 1];
    }
  }

  startDrive(spec) {
    this.cancelTurn('aborted');
    const d = { ...spec, t: 0, u: 0, v: 0, fL0: this.fwdL, fR0: this.fwdR, yaw0: this.yawCont, noProg: 0 };
    const accW = this.left.accelDegS2(this.left.accelPct), decW = this.left.accelDegS2(this.left.decelPct);
    if (d.mode === 'deg') d.prof = trapezoid(d.dist, d.vmax, accW, decW);
    if (d.mode === 'cont' || d.mode === 'time') {
      // плавно продолжаем с текущей скорости
      const vfL = -this.left.actual, vfR = this.right.actual, n = d.kL * d.kL + d.kR * d.kR;
      d.v = n > 0 ? clamp((d.kL * vfL + d.kR * vfR) / n, -Math.abs(d.vmax), Math.abs(d.vmax)) : 0;
      d.acc = accW;
    }
    if (d.mode === 'turn') {
      const geo = this.geo.wheels, kk = Math.abs(d.kR - d.kL);
      const yawPerWheel = kk * geo.d / (2 * geo.track);
      d.prof = trapezoid(Math.abs(d.dYaw), d.vmax * yawPerWheel, accW * yawPerWheel, decW * yawPerWheel);
      d.sgn = Math.sign(d.dYaw) || 1;
      d.target = d.yaw0 + d.dYaw;
    }
    d.cmdL = this.left.track(0); d.cmdR = this.right.track(0);
    this.drive = d;
    if (d.waitable) return new Promise((res) => { d.resolve = res; });
    return Promise.resolve('ok');
  }

  driveUpdate(dt, now) {
    const d = this.drive;
    if (!d) return;
    if (this.left.cmd !== d.cmdL || this.right.cmd !== d.cmdR) { this.cancelTurn('aborted'); return; } // моторам дали другую команду
    const W = this.geo.wheels, maxV = this.left.maxDegS * 1.1;
    if (d.mode === 'turn') {
      d.t += dt;
      const [s, v] = d.prof.at(d.t);
      const yawRef = d.yaw0 + d.sgn * s;
      const rate = d.sgn * v + KY * (yawRef - this.yawCont);
      const w = rate * 2 * W.track / ((d.kR - d.kL) * W.d);
      this.left.track(-clamp(d.kL * w, -maxV, maxV));
      this.right.track(clamp(d.kR * w, -maxV, maxV));
      return;
    }
    if (d.mode === 'deg') { d.t += dt; const [s, v] = d.prof.at(d.t); d.u = s; d.v = v; }
    else {
      if (d.mode === 'time' && now >= d.end - T_EPS) { this.finishDrive('done'); return; }
      const a = d.acc * dt;
      d.v += clamp(d.vmax - d.v, -a, a);
      d.u += d.v * dt; d.t += dt;
    }
    let c = 0;
    if (d.heading) c = clamp(KH * (d.yaw0 - this.yawCont) * W.track / W.d, -120, 120);
    const pL = d.fL0 + d.kL * d.u - c, pR = d.fR0 + d.kR * d.u + c;
    this.left.track(-d.kL * d.v, -pL);
    this.right.track(d.kR * d.v, pR);
  }

  driveCheck(dt) {
    const d = this.drive;
    if (!d) return;
    const stalled = this.left.stallT > SIM.stallTime || this.right.stallT > SIM.stallTime;
    if (d.mode === 'turn') {
      const err = d.target - this.yawCont;
      if (d.t >= d.prof.T && Math.abs(err) < 0.25) { this.finishDrive('done'); return; }
      // время вышло: «готово» только если угол почти достигнут, иначе — заклинивание
      if (d.t >= d.prof.T + SIM.degTimeout) { this.finishDrive(Math.abs(err) < 2 ? 'done' : 'stalled'); return; }
      // нет прогресса (упёрлись, колёса буксуют) — поворот не может зависнуть
      if (d.t > 0.4 && Math.abs(this.gyroZ) < 1.5 && Math.abs(err) > 1) d.noProg += dt; else d.noProg = 0;
      if (d.noProg > 0.6 || (this.left.stallT > SIM.stallTime && this.right.stallT > SIM.stallTime)) this.finishDrive('stalled');
      return;
    }
    if (d.mode === 'deg') {
      const n = d.kL * d.kL + d.kR * d.kR;
      const prog = (d.kL * (this.fwdL - d.fL0) + d.kR * (this.fwdR - d.fR0)) / n;
      const rem = Math.abs(d.dist - prog);
      if (d.t >= d.prof.T && rem < 3) { this.finishDrive('done'); return; }
      if (d.t >= d.prof.T + SIM.degTimeout) { this.finishDrive(rem < SIM.degTol ? 'done' : 'stalled'); return; }
      if (stalled) this.finishDrive('stalled');
      return;
    }
    if (d.mode === 'time' && stalled) this.finishDrive('stalled');
  }

  move(direction, speedPct) {
    const s = this.left.pctToDeg(speedPct);
    const [kL, kR] = this.dirFactors(direction);
    this.startDrive({ mode: 'cont', kL, kR, vmax: s, heading: kL === kR });
    return Promise.resolve('ok');
  }
  moveTank(slPct, srPct) {
    const sl = this.left.pctToDeg(slPct), sr = this.right.pctToDeg(srPct);
    const m = Math.max(Math.abs(sl), Math.abs(sr));
    if (m < 1) { this.cancelTurn('aborted'); this.left.stop(); this.right.stop(); return Promise.resolve('ok'); }
    this.startDrive({ mode: 'cont', kL: sl / m, kR: sr / m, vmax: m, heading: sl === sr });
    return Promise.resolve('ok');
  }
  moveForTime(ms, direction, speedPct, now) {
    const s = this.left.pctToDeg(speedPct);
    if (!(ms > 0) || Math.abs(s) < 1) return Promise.resolve('rejected');
    const [kL, kR] = this.dirFactors(direction);
    return this.startDrive({ mode: 'time', kL, kR, vmax: s, end: (now ?? this.sim.time) + ms / 1000, heading: kL === kR, waitable: true });
  }
  moveForDegrees(deg, direction, speedPct) {
    const s = Math.abs(this.left.pctToDeg(speedPct));
    if (s < 1) return Promise.resolve('rejected');
    if (!Math.abs(deg)) return Promise.resolve('done');
    let [kL, kR] = this.dirFactors(direction);
    if (deg < 0) { kL = -kL; kR = -kR; }
    return this.startDrive({ mode: 'deg', kL, kR, vmax: s, dist: Math.abs(deg), heading: kL === kR, waitable: true });
  }
  moveTankForDegrees(deg, slPct, srPct) {
    const m = Math.max(Math.abs(slPct), Math.abs(srPct));
    if (!m || !Math.abs(deg)) { this.cancelTurn('aborted'); this.left.stop(); this.right.stop(); return Promise.resolve('done'); }
    const sg = deg < 0 ? -1 : 1;
    return this.startDrive({ mode: 'deg', kL: sg * slPct / m, kR: sg * srPct / m, vmax: this.left.pctToDeg(m), dist: Math.abs(deg), heading: slPct === srPct, waitable: true });
  }
  /** Поворот на заданный угол по встроенному IMU. dir: 0 = влево (yaw растёт), 1 = вправо */
  turnForDegrees(deg, dir, speedPct) {
    const s = Math.abs(this.left.pctToDeg(speedPct));
    const st = this.steering / 100;
    if (s < 1 || st <= 0 || !Math.abs(deg)) return Promise.resolve(Math.abs(deg) ? 'rejected' : 'done');
    const left = dir !== 1;
    const kL = left ? 1 - 2 * st : 1, kR = left ? 1 : 1 - 2 * st;
    return this.startDrive({ mode: 'turn', kL, kR, vmax: s, dYaw: (left ? 1 : -1) * Math.abs(deg), waitable: true });
  }
  stopMove() { this.cancelTurn('aborted'); this.left.stop(); this.right.stop(); return Promise.resolve('ok'); }
  get moving() { return !!this.drive || this.left.busy || this.right.busy; }

  // ---------- датчик цвета ----------
  /** Точка под линзой датчика по позе физического тела (мир, см) */
  sensorWorld() {
    const s = this.config.sensor, q = this.chassis.rotation(), t = this.chassis.translation();
    const r = qRot(q, { x: s.x, y: this.geo.ground + 0.78, z: s.z });
    return new THREE.Vector3(t.x + r.x, t.y + r.y, t.z + r.z);
  }

  /** Точка (мир) внутри ковша/захвата: фишка с центром здесь лежит в навесном (касается оборудования) */
  inHead(p) {
    const A = this.geo.arm, hb = this.headBody;
    if (!A || !A.head || !A.head.hold || !hb) return false;
    const t = hb.translation(), q = hb.rotation();
    const l = qRot({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, { x: p.x - t.x, y: p.y - t.y, z: p.z - t.z });
    const h = A.head.hold;
    return l.x >= h.x0 && l.x <= h.x1 && Math.abs(l.z) <= h.z && l.y >= h.y0 && l.y <= h.y1;
  }

  // ---------- габариты (inspection) ----------
  /** Точки оболочки всех деталей в мире */
  hullWorld() {
    const out = [];
    const push = (b, parts) => {
      const t = b.translation(), q = b.rotation();
      for (const p of parts) if (p.collide !== false || p.visual !== false) for (const c of partCorners(p)) { const r = qRot(q, c); out.push({ x: t.x + r.x, y: t.y + r.y, z: t.z + r.z }); }
    };
    push(this.chassis, this.geo.chassis);
    const W = this.geo.wheels;
    for (const w of this.wheels) push(w.body, [{ shape: 'box', w: W.d, h: W.d, d: W.w, x: 0, y: 0, z: 0 }]);
    const A = this.geo.arm;
    if (A) {
      push(this.armBody, A.parts);
      if (this.headBody) push(this.headBody, A.head.parts);
      if (this.gateBody) push(this.gateBody, A.head.gate.parts);
    }
    return out;
  }

  /** Состояние для онлайна: позы тел */
  getBodyState() {
    return this.bodies.map((b) => { const t = b.translation(), q = b.rotation(); return [t.x, t.y, t.z, q.x, q.y, q.z, q.w]; });
  }
  applyBodyState(arr) {
    if (!arr) return;
    this.bodies.forEach((b, i) => {
      const s = arr[i]; if (!s) return;
      b.setTranslation({ x: s[0], y: s[1], z: s[2] }, false); b.setRotation({ x: s[3], y: s[4], z: s[5], w: s[6] }, false);
    });
    const y = yawOf(this.chassis.rotation()) * R2D;
    let d = y - this._yawRaw; d -= 360 * Math.round(d / 360); this.yawCont += d; this._yawRaw = y;
  }
}

export { END };
