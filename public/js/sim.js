// Ядро симулятора: сцена three.js + физика Rapier + механика миссий + подсчёт очков + правила.
// Создаётся асинхронно: const sim = await Sim.create(container, { configs: { red, blue } }).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { initPhysics, Physics, RAPIER, DT as PDT, G, ALL, groups, qYaw, qRot, qMul, upY } from './physics.js';
import { FIELD_W, FIELD_H, WALL_H, WALL_T, L, TOKENS, TOKEN_SIZE, INVASIVE_SPOTS, DEFAULT_INVASIVE_ORDER, toWorld, toMap, sideYaw, other, inRect } from './layout.js';
import { makeMat, matFromImage } from './mat.js';
import { brick, C, mat } from './lego.js';
import { GrandTree, Waterfall, HollowTree, Nest, YoungForest, Hive, Recycler, buildBarriers, keystoneGeometry, keystoneHub, resourceGeometry, invasiveMesh, INVASIVE_SIZE } from './models.js';
import { Robot } from './robot.js';
import { Motor, VirtualDrive, SIM, T_EPS } from './motors.js';
import { PRESETS, normalizeConfig, validateConfig } from './robotConfig.js';

export const DT = PDT;
const SIDES = ['red', 'blue'];
const FW = FIELD_W / 10, FH = FIELD_H / 10; // см
const LIFT_CYCLE = 540;   // градусов мотора дерева на один подъём ресурса
const FALLS_GAP = 0.7;    // с между выпусками из водопада
const REC_GAP = 0.5;      // с между выпусками из Token Recycler
const TOKEN_VMAX = 250;   // см/с — предел скорости фишки (защита от «выстрелов»)
const JAM_SPILL = 1.0;    // с — выход модели занят дольше: фишка выпускается рядом (на кучку у выхода)
const INVASIVE = new Set(['IR', 'IS', 'Q']);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Сидированный ГПСЧ (mulberry32) */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Короткая подпись конфигурации робота (гость сверяет, что собран тот же робот) */
export function cfgSig(cfg) {
  const s = JSON.stringify(cfg || {});
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const WHERE = { field: 0, falls: 1, canopy: 2, rec: 3, removed: 4, lift: 5 };
const WHERE_BY = Object.fromEntries(Object.entries(WHERE).map(([k, v]) => [v, k]));

export class Sim {
  /** Загрузить Rapier и построить симулятор. */
  static async create(container, opts = {}) {
    await initPhysics();
    return new Sim(container, opts);
  }

  constructor(container, opts = {}) {
    this.container = container;
    this.time = 0;
    this.stepCount = 0;
    this.listeners = {};
    this.seed = opts.seed ?? 2026;
    this.rng = mulberry32(this.seed);
    this.invasives = { red: 0, blue: 0 };     // число или список мест (id из INVASIVE_SPOTS)
    this.invasivePlaced = { red: [], blue: [] };
    this.penalties = { red: { n: 0, log: [] }, blue: { n: 0, log: [] } };
    this.courtesy = { red: 0, blue: 0 };
    this.latched = null;
    this.attachment = opts.attachment || 'scoop';
    this.phys = new Physics();
    this.world = this.phys.world;
    this.externals = [];         // строители тел других модулей (addBodies)
    this.initThree();
    const cfgs = opts.configs || {};
    const byAtt = PRESETS.find((p) => p.attachment.type === this.attachment) || PRESETS[0];
    this.robots = {};
    this.phys.own(() => {
      this.buildField();
      this.buildModels();
      for (const s of SIDES) {
        this.robots[s] = new Robot(this, s, cfgs[s] || byAtt);
        this.scene.add(this.robots[s].group);
      }
    });
    this.treeMotors = {}; this.treeDrives = {};
    for (const s of SIDES) {
      this.treeMotors[s] = [new Motor('treeL', { spec: SIM.drive }), new Motor('treeR', { spec: SIM.drive })];
      this.treeDrives[s] = this.treeMotors[s].map((m) => new VirtualDrive(m, { inertia: 1.2, friction: 60 }));
    }
    this.tokens = [];            // фишки в игре (на поле или внутри моделей)
    this.byId = new Map();       // все фишки по id (включая снятые)
    this.freshWorld = true;      // мир только что построен — первый сброс не пересобирает его
    this.resetField();
  }

  /**
   * Пересобрать мир Rapier с нуля (сброс поля = новая загрузка): тот же порядок создания тел, что при
   * загрузке (поле, модели, роботы, фишки), без накопленных контактов, тёплого старта и порядка островов.
   * Визуал, объекты моделей, роботов и моторов сохраняются; меняются только тела.
   */
  rebuildWorld({ keepRobots = false } = {}) {
    const old = this.phys;
    const poses = {};
    for (const s of SIDES) {
      const r = this.robots[s];
      if (keepRobots && r.chassis) { const p = r.chassis.translation(); poses[s] = { x: p.x, z: p.z, yaw: r.yawWorld }; }
    }
    this.clearTokens(false);
    this.phys = new Physics();
    this.world = this.phys.world;
    this.phys.own(() => {
      this.buildFieldPhysics();
      for (const side of SIDES) {
        this.barriers[side].rebuildPhysics();
        for (const k of Object.keys(this.models[side])) this.models[side][k].rebuildPhysics();
      }
      for (const s of SIDES) this.robots[s].rebuildPhysics(poses[s] || null);
    });
    old.free();
  }
  /**
   * Тела других модулей (например, инструмент Operator) в мире sim.phys. build(phys) создаёт их и
   * вызывается сразу и заново после каждой пересборки мира при сбросе поля (после фишек — тот же
   * порядок, что при загрузке). Ссылки на тела из прошлой сборки после сброса недействительны.
   * Тела, созданные в sim.phys напрямую (без addBodies), при сбросе поля пропадают вместе со старым
   * миром: владелец пересоздаёт их сам по событию 'world' / 'reset' (признак — sim.world сменился).
   * -> функция отписки.
   */
  addBodies(build) {
    const e = { build };
    this.externals.push(e);
    this.phys.own(() => build(this.phys));
    return () => { this.externals = this.externals.filter((x) => x !== e); };
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  off(ev, fn) { const a = this.listeners[ev]; if (a) this.listeners[ev] = a.filter((f) => f !== fn); }
  emit(ev, ...a) { for (const f of this.listeners[ev] || []) { try { f(...a); } catch (e) { console.error(e); } } }

  // ---------------- three.js ----------------
  initThree() {
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    this.container.appendChild(r.domElement);
    this.renderer = r;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x13201a);
    scene.fog = new THREE.Fog(0x13201a, 520, 1100);
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 3000);
    this.camera.position.set(0, 150, 175);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.target.set(0, 0, 8);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 15; this.controls.maxDistance = 600;
    scene.add(new THREE.HemisphereLight(0xeaf5ff, 0x2c3b22, 1.15));
    const sun = new THREE.DirectionalLight(0xfff3dd, 2.3);
    sun.position.set(-70, 220, 90);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -140; sc.right = 140; sc.top = 80; sc.bottom = -80; sc.near = 50; sc.far = 500;
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.4;
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbfd8ff, 0.5); fill.position.set(120, 80, -100); scene.add(fill);
    this.resize();
  }
  resize() {
    const w = this.container.clientWidth || 800, h = this.container.clientHeight || 500;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------- поле ----------------
  buildField() {
    this.mat = makeMat(2048);
    this.matTex = new THREE.CanvasTexture(this.mat.canvas);
    this.matTex.colorSpace = THREE.SRGBColorSpace;
    this.matTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(FW, FH), new THREE.MeshStandardMaterial({ map: this.matTex, roughness: 0.85 }));
    plane.rotation.x = -Math.PI / 2; plane.position.y = 0.01; plane.receiveShadow = true;
    this.scene.add(plane);
    const table = new THREE.Mesh(new THREE.BoxGeometry(FW + 30, 3, FH + 30), mat(0x2a2522, { rough: 0.8 }));
    table.position.y = -1.5; table.receiveShadow = true; table.castShadow = true; this.scene.add(table);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), mat(0x1c2a22, { rough: 1 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -75; this.scene.add(floor);
    for (const [w, h, d, x, z] of this.wallBoxes()) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(0x161616, { rough: 0.7 }));
      m.position.set(x, h / 2, z); m.castShadow = true; m.receiveShadow = true; this.scene.add(m);
    }
    // сине-голубая ось Grand Tree <-> Cave Waterfall
    for (const [side, len, x, z] of this.axles()) this.scene.add(brick(len, 0.8, 0.8, C.azure, x, 9.9, z, { ry: sideYaw(side) }));
    this.buildFieldPhysics();
  }
  wallBoxes() {
    const wt = WALL_T / 10, wh = WALL_H / 10;
    return [
      [FW + 2 * wt, wh, wt, 0, -FH / 2 - wt / 2], [FW + 2 * wt, wh, wt, 0, FH / 2 + wt / 2],
      [wt, wh, FH, -FW / 2 - wt / 2, 0], [wt, wh, FH, FW / 2 + wt / 2, 0],
    ];
  }
  axles() {
    return SIDES.map((side) => {
      const a = toWorld(632, 545, side), b = toWorld(790, 545, side);
      return [side, Math.hypot(b.x - a.x, b.z - a.z), (a.x + b.x) / 2, (a.z + b.z) / 2];
    });
  }
  /** Коврик, борта и ось — физика (повторяется при пересборке мира) */
  buildFieldPhysics() {
    const ph = this.phys;
    const fb = ph.body('fixed', { x: 0, y: 0, z: 0 });
    this.fieldBody = fb;
    const wt = WALL_T / 10;
    this.groundCollider = ph.collider(fb, { shape: 'box', w: FW + 2 * wt, h: 1.0, d: FH + 2 * wt, x: 0, y: -0.5, z: 0 },
      { mat: 'mat', group: G.GROUND, filter: ALL, info: { kind: 'ground' } });
    for (const [w, h, d, x, z] of this.wallBoxes()) {
      ph.collider(fb, { shape: 'box', w, h, d, x, y: h / 2, z }, { mat: 'wall', group: G.STATIC, filter: ALL, info: { kind: 'wall', color: 0x161616 } });
    }
    for (const [side, len, x, z] of this.axles()) {
      ph.collider(fb, { shape: 'box', w: len, h: 0.8, d: 0.8, x, y: 9.9, z }, { group: G.STATIC, filter: ALL, info: { kind: 'model', side, model: 'axle', color: C.azure } });
    }
  }

  buildModels() {
    this.models = {};
    this.barriers = {};
    for (const side of SIDES) {
      this.barriers[side] = buildBarriers(this, side, L);
      this.models[side] = {
        tree: new GrandTree(this, side, L.grandTree.x, L.grandTree.y),
        falls: new Waterfall(this, side, L.waterfall.x, L.waterfall.y),
        hollow: new HollowTree(this, side, L.hollowTree.x, L.hollowTree.y),
        nest: new Nest(this, side, L.nest.x, L.nest.y),
        yf: new YoungForest(this, side, L.youngForest.x, L.youngForest.y),
        hive: new Hive(this, side, L.hive.x, L.hive.y),
        rec: new Recycler(this, side, L.recycler.x, L.recycler.y),
      };
    }
  }

  // ---------------- фишки ----------------
  /** Создать фишку. type: K | R | IR | IS | Q. pos — центр (K/R) или низ (инвазивные). */
  addToken(id, type, side, pos, rot = null, opts = {}) {
    const ph = this.phys;
    // тела создаются бодрствующими: у созданных спящими Rapier 0.21 держит устаревшие контакты (фишка проваливается)
    const body = ph.body('dynamic', pos, rot, { ccd: true, linDamp: 0.15, angDamp: 0.4 });
    const info = { kind: 'token', side, type };
    const colliders = [];
    let mesh;
    if (type === 'K') {
      const s = TOKEN_SIZE.K;
      colliders.push(ph.collider(body, { shape: 'cyl', r: s.r, h: s.h, round: 0.25 }, { mat: 'K', group: G.TOKEN, mass: s.mass, info }));
      mesh = new THREE.Group();
      const tire = new THREE.Mesh(keystoneGeometry(), mat(C.yellow, { rough: 0.45 }));
      const hub = new THREE.Mesh(this._hubGeo ||= keystoneHub(), mat(C.red, { rough: 0.4 }));
      tire.castShadow = true; hub.castShadow = true;
      mesh.add(tire, hub);
    } else if (type === 'R') {
      const s = TOKEN_SIZE.R, pts = [];
      const b = -s.h / 2, cyl = s.h - s.r * 0.75;
      for (const [y, rr] of [[b, s.r], [b + cyl, s.r], [b + cyl + 0.3, s.r * 0.86], [b + cyl + 0.5, s.r * 0.6], [s.h / 2, 0.08]]) {
        for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; pts.push(Math.cos(a) * rr, y, Math.sin(a) * rr); }
      }
      colliders.push(ph.collider(body, { shape: 'hull', pts, round: 0.03 }, { mat: 'R', group: G.TOKEN, mass: s.mass, info }));
      mesh = new THREE.Mesh(resourceGeometry(), mat(C.teal, { rough: 0.25 }));
      mesh.castShadow = true;
    } else {
      const s = INVASIVE_SIZE[type];
      let y0 = 0;
      if (s.base) {
        colliders.push(ph.collider(body, { shape: 'cyl', r: s.base, h: s.baseH, y: s.baseH / 2, round: 0.1 }, { mat: 'inv', group: G.TOKEN, mass: s.mass * 0.4, info }));
        y0 = s.baseH;
      }
      colliders.push(ph.collider(body, { shape: 'box', w: s.w, h: s.h, d: s.d, y: y0 + s.h / 2, round: 0.1 }, { mat: 'inv', group: G.TOKEN, mass: s.base ? s.mass * 0.6 : s.mass, info }));
      mesh = invasiveMesh(type);
    }
    mesh.receiveShadow = true;
    const t = { id, type, side, tag: opts.tag || 'field', body, colliders, mesh, alive: true, where: 'field', _eqStep: -1, _eq: false };
    info.token = t;
    mesh.userData.token = t;
    this.scene.add(mesh);
    this.tokens.push(t);
    this.byId.set(id, t);
    this.syncToken(t);
    return t;
  }

  /** Убрать все фишки (сброс поля). removeBodies=false — мир всё равно будет освобождён целиком. */
  clearTokens(removeBodies = true) {
    for (const t of this.byId.values()) {
      if (t.body && removeBodies) this.phys.removeBody(t.body);
      t.body = null; t.alive = false;
      this.scene.remove(t.mesh);
      // подставка инвазивного вида — своя геометрия; общие (фишки, брикеты) не трогаем
      t.mesh.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.type === 'CylinderGeometry' && o.geometry !== this._hubGeo) o.geometry.dispose(); });
    }
    this.tokens = []; this.byId.clear();
  }

  /** Снять фишку из игры («отдать судье»). item — фишка или её id. */
  removeFromPlay(item, why = 'снята из игры') {
    const t = typeof item === 'string' ? this.byId.get(item) : item;
    if (!t || t.where === 'removed') return false;
    t.where = 'removed'; t.alive = false;
    if (t.body) { this.phys.removeBody(t.body); t.body = null; }
    t.mesh.visible = false;
    this.tokens = this.tokens.filter((x) => x !== t);
    for (const s of SIDES) {
      const m = this.models[s];
      m.falls.queue = m.falls.queue.filter((x) => x !== t);
      m.rec.queue = m.rec.queue.filter((x) => x !== t);
      if (m.tree.carry === t) m.tree.carry = null;
    }
    this.emit('event', t.side, `Фишка ${t.id} ${why}`);
    return true;
  }

  /** Убрать фишку внутрь модели (скрытый путь): тело выключено */
  hideToken(t, where) {
    t.where = where;
    t.body.setLinvel({ x: 0, y: 0, z: 0 }, false); t.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    t.body.setEnabled(false);
  }
  /** Вернуть фишку на поле в точку p с поворотом q и скоростью v */
  showToken(t, p, q, v) {
    t.body.setTranslation(p, false); t.body.setRotation(q, false);
    t.body.setLinvel(v || { x: 0, y: 0, z: 0 }, false); t.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    t.body.setEnabled(true); t.body.wakeUp();
    t.where = 'field'; t.mesh.visible = true;
    this.syncToken(t);
  }

  resetField(opts = {}) {
    // каждый сброс, кроме первого (мир только что построен), строит мир Rapier заново: повтор программы
    // после «Сброс поля» даёт тот же результат, что после загрузки страницы
    let rebuilt = false;
    if (this.freshWorld) { this.freshWorld = false; this.clearTokens(); }
    else { this.rebuildWorld({ keepRobots: !!opts.keepRobots }); rebuilt = true; }
    this.phys.own(() => this.placeTokens(opts));
    for (const side of SIDES) {
      if (!opts.keepRobots) this.robots[side].resetPose({ free: false });
      this.treeMotors[side].forEach((mm) => mm.reset());
      this.treeDrives[side].forEach((d) => d.reset());
    }
    // тела других модулей — после фишек, как при загрузке страницы
    if (rebuilt) {
      for (const e of this.externals) { try { this.phys.own(() => e.build(this.phys)); } catch (err) { console.error(err); } }
      this.emit('world', this.world);
    }
    this.lastScore = null;
    this.emit('reset');
  }

  /** Расставить фишки и инвазивные виды, сбросить механику моделей (часть resetField) */
  placeTokens(opts = {}) {
    this.time = this.time || 0;
    this.latched = null;
    this.penalties = { red: { n: 0, log: [] }, blue: { n: 0, log: [] } };
    this.courtesy = { red: 0, blue: 0 };
    this.rng = mulberry32(this.seed);
    if (opts.invasives) for (const s of SIDES) if (opts.invasives[s] !== undefined) this.invasives[s] = opts.invasives[s];
    this.state = {};
    for (const side of SIDES) {
      const m = this.models[side];
      for (const k of Object.keys(m)) m[k].reset();
      this.state[side] = { nestReleased: false, hollowReleased: false };
      let kn = 0, rn = 0;
      const id = (type) => `${side[0]}${type}${String(type === 'K' ? ++kn : ++rn).padStart(2, '0')}`;
      const s = TOKEN_SIZE;
      for (const [type, x, y] of TOKENS) {
        const p = toWorld(x, y, side);
        this.addToken(id(type), type, side, { x: p.x, y: s[type].h / 2 + 0.005, z: p.z }, qYaw(sideYaw(side)), { sleep: true });
      }
      for (const mk of ['tree', 'nest', 'hollow', 'hive']) {
        const mdl = m[mk];
        for (const tk of mdl.tokens()) {
          const tid = tk.type === 'Q' ? `${side[0]}Q` : id(tk.type);
          const t = this.addToken(tid, tk.type, side, mdl.toWorld(tk.lp), mdl.wq(tk.lq), { sleep: tk.sleep, tag: tk.tag });
          if (tk.type === 'Q') this.state[side].queen = t;
        }
      }
      // инвазивные виды (Level Up): выбранные места
      let spots = this.invasives[side];
      if (typeof spots === 'number') spots = DEFAULT_INVASIVE_ORDER.slice(0, clamp(Math.round(spots), 0, 5));
      spots = (Array.isArray(spots) ? spots : []).filter((sid, i, a) => INVASIVE_SPOTS.some((sp) => sp.id === sid) && a.indexOf(sid) === i).slice(0, 5);
      this.invasivePlaced[side] = spots;
      let ni = 0;
      for (const sid of spots) {
        const sp = INVASIVE_SPOTS.find((x) => x.id === sid);
        const mdl = m[sp.model];
        const lp = mdl.spots[sid].lp;
        this.addToken(`${side[0]}I${++ni}`, sp.type, side, mdl.toWorld({ x: lp.x, y: lp.y + 0.01, z: lp.z }), mdl.wq(qYaw(Math.PI / 2)), { sleep: true, tag: sid });
      }
    }
  }

  // ---------------- контакты и состояние фишек ----------------
  /** Есть ли касание коллайдеров (фактический контакт, не только AABB) */
  _touching(c, pred) {
    let hit = false;
    const w = this.world;
    w.contactPairsWith(c, (c2) => {
      if (hit) return;
      const inf = this.phys.info.get(c2.handle);
      if (!pred(inf, c2)) return;
      w.contactPair(c, c2, (man) => {
        for (let i = 0; i < man.numContacts(); i++) if (man.contactDist(i) < 0.06) { hit = true; break; }
      });
    });
    return hit;
  }
  /** Фишка касается оборудования команды (робот, навесное). Фишка, лежащая в ковше/захвате,
   *  касается его дна, даже если физически стоит на коврике (дно ковша чуть ниже коврика). */
  touchingEquipment(t, side = null) {
    if (!t.body || t.where !== 'field') return false;
    if (t._eqStep === this.stepCount && side === null) return t._eq;
    let hit = false;
    for (const c of t.colliders) if (this._touching(c, (inf) => inf && inf.kind === 'robot' && (side === null || inf.side === side))) { hit = true; break; }
    if (!hit) hit = this.inAttachment(t, side);
    if (side === null) { t._eqStep = this.stepCount; t._eq = hit; }
    return hit;
  }
  /** Центр фишки внутри ковша/захвата робота (side или любого) */
  inAttachment(t, side = null) {
    if (!t.body) return false;
    const p = t.body.translation();
    for (const s of SIDES) if ((side === null || side === s) && this.robots[s].inHead(p)) return true;
    return false;
  }
  touchingGround(t) {
    for (const c of t.colliders) if (this._touching(c, (inf) => inf && (inf.kind === 'ground'))) return true;
    return false;
  }
  /** Фишка лежит на инвазивном виде / касается его (крышка на кольце-микробиоме) */
  touchingInvasive(t) {
    for (const c of t.colliders) if (this._touching(c, (inf) => inf && inf.kind === 'token' && INVASIVE.has(inf.type) && inf.token !== t)) return true;
    return false;
  }
  /** Точки оболочки инвазивного вида в мире (по реальной ориентации: стоит, лежит, перевёрнут) */
  invasivePoints(t) {
    const s = INVASIVE_SIZE[t.type], loc = [];
    if (s.base) for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      for (const y of [0, s.baseH]) loc.push({ x: Math.cos(a) * s.base, y, z: Math.sin(a) * s.base });
    }
    const y0 = s.baseH || 0;
    for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) loc.push({ x: sx * s.w / 2, y: y0 + sy * s.h, z: sz * s.d / 2 });
    const p = t.body.translation(), q = t.body.rotation();
    return loc.map((l) => { const r = qRot(q, l); return { x: p.x + r.x, y: p.y + r.y, z: p.z + r.z }; });
  }
  isLoose(t) { return !this.touchingEquipment(t); }
  isResting(t, v = 1.5) {
    if (!t.body || t.where !== 'field') return false;
    if (t.body.isSleeping()) return true;
    const lv = t.body.linvel(), av = t.body.angvel();
    return Math.hypot(lv.x, lv.y, lv.z) < v && Math.hypot(av.x, av.y, av.z) < 1.5;
  }
  pos(t) { return t.body ? t.body.translation() : null; }
  /** Радиус «следа» фишки на коврике, см */
  footR(t) {
    if (t.type === 'K') return TOKEN_SIZE.K.r;
    if (t.type === 'R') return TOKEN_SIZE.R.r;
    const s = INVASIVE_SIZE[t.type];
    return Math.max(s.base || 0, Math.hypot(s.w, s.d) / 2);
  }
  queenDown(side) {
    const q = this.state[side].queen;
    if (!q || q.where === 'removed' || !q.body) return true;
    const hv = this.models[side].hive;
    return upY(q.body.rotation()) < 0.64 || q.body.translation().y < hv.topY - 2.0;
  }

  // ---------------- механика миссий ----------------
  preStep(dt) {
    for (const s of SIDES) this.robots[s].preStep(dt, this.time);
    for (const s of SIDES) {
      this.treeMotors[s].forEach((m) => m.update(dt, this.time));
      this.treeDrives[s].forEach((d) => d.step(dt));
      const m = this.models[s];
      m.hollow.preStep(dt); m.nest.preStep(dt); m.hive.preStep(dt, this.time);
    }
  }

  postStep(dt) {
    for (const s of SIDES) this.robots[s].postStep(dt);
    const slow = this.stepCount % 4 === 0;
    for (const side of SIDES) this.missionStep(side, dt, slow);
    // защита от «выстрелов» и фишки, покинувшие стол
    const off = this.stepCount % 8 === 0;
    for (const t of this.tokens) {
      if (t.where !== 'field' || !t.body || t.body.isSleeping()) continue;
      const v = t.body.linvel(), sp = Math.hypot(v.x, v.y, v.z);
      if (sp > TOKEN_VMAX) { const k = TOKEN_VMAX / sp; t.body.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true); }
      if (off) {
        const p = t.body.translation();
        if (p.y < -3 || Math.abs(p.x) > FW / 2 + 6 || Math.abs(p.z) > FH / 2 + 6) this.pendingRemove = (this.pendingRemove || []).concat([t]);
      }
    }
    if (this.pendingRemove) { for (const t of this.pendingRemove) this.removeFromPlay(t, 'покинула стол — снята из игры'); this.pendingRemove = null; }
  }

  missionStep(side, dt, slow) {
    const m = this.models[side], st = this.state[side];
    // M04: рычаги — срабатывают при повороте за угол срабатывания (не от касания)
    for (const key of ['nest', 'hollow']) {
      const mdl = m[key], lv = mdl.lv;
      lv.angle = mdl.leverAngle(lv);
      lv.max = Math.max(lv.max, Math.abs(lv.angle));
      if (!mdl.open && lv.angle * Math.sign(lv.trigger) >= Math.abs(lv.trigger)) {
        mdl.open = true;
        for (const t of this.tokens) if (t.tag === key && t.body) t.body.wakeUp();
        this.emit('event', side, key === 'nest' ? 'M04: рычаг Nest сработал — лоток наклоняется' : 'M04: рычаг Hollow Tree сработал — створка открыта');
      }
    }
    if (slow) {
      if (!st.nestReleased) {
        const ks = [...this.byId.values()].filter((t) => t.side === side && t.tag === 'nest');
        if (ks.length && ks.every((t) => t.where === 'removed' || (t.body && !m.nest.inBox(m.nest.holdZone, t.body.translation())))) {
          st.nestReleased = true; this.emit('event', side, 'M04: все ключевые виды выпущены из Nest');
        }
      }
      if (!st.hollowReleased) {
        const rs = [...this.byId.values()].filter((t) => t.side === side && t.tag === 'hollow');
        if (rs.length && rs.every((t) => t.where === 'removed' || (t.body && !m.hollow.inBox(m.hollow.cavity, t.body.translation())))) {
          st.hollowReleased = true; this.emit('event', side, 'M04: все ресурсы выпущены из Hollow Tree');
        }
      }
    }
    // M03: водопад — ловим свободные K в верхнем кольце, выпускаем по одному из жёлоба
    const f = m.falls;
    for (const t of this.tokens) {
      if (t.type !== 'K' || t.where !== 'field' || !t.body) continue;
      const p = t.body.translation();
      if (p.y < 8.5 || Math.abs(p.x - f.x) > 8 || Math.abs(p.z - f.z) > 8) continue;
      if (!f.inRing(f.capture, p) || !this.isLoose(t)) continue;
      this.hideToken(t, 'falls');
      t.mesh.visible = false;
      f.queue.push(t);
      f.count++; f.setNeedle();
      if (f.queue.length === 1) f.nextRelease = Math.max(f.nextRelease, this.time + 0.5);
      this.emit('event', side, `M03: водопад, счётчик ${f.display}`);
    }
    if (f.queue.length && this.time >= f.nextRelease - T_EPS) {
      if (this.releaseAt(f, f.queue[0])) { f.queue.shift(); f.nextRelease = this.time + FALLS_GAP; }
      else f.nextRelease = this.time + 0.2;
    }
    // M01: Young Forest — датчик под кольцом видит свободные K внутри кольца (не на стенке и не на
    // инвазивном виде-крышке); 4-й запускает Hive соперника
    if (slow && !m.yf.triggered) {
      let n = 0;
      const z = m.yf.ringZone;
      for (const t of this.tokens) {
        if (t.type !== 'K' || t.where !== 'field' || !t.body) continue;
        const p = t.body.translation();
        if (p.y < z.top && m.yf.inRing(z, p) && this.isLoose(t) && !this.touchingInvasive(t)) n++;
      }
      m.yf.seen = n;
      if (n >= 4) {
        m.yf.triggered = true;
        m.yf.indMat.emissive.setHex(0xf6c21a);
        const o = other(side);
        if (this.models[o].hive.trigger()) {
          const q = this.state[o].queen; if (q && q.body) q.body.wakeUp();
        }
        this.emit('event', side, 'M01: 4-й вид в Young Forest — Hive соперника сработал');
      }
    }
    // M02: Grand Tree — мотор дерева поднимает свободный покоящийся R из base в canopy chamber
    const tr = m.tree, [t0, t1] = this.treeMotors[side];
    const spin = (Math.abs(t0.actual) + Math.abs(t1.actual)) / 2;
    tr.spin = spin;
    if (!tr.carry && spin > 30 && slow) {
      const res = this.tokens.find((t) => t.type === 'R' && t.where === 'field' && t.body && tr.inBox(tr.baseZone, t.body.translation()) && this.isResting(t, 3) && this.isLoose(t));
      if (res) { tr.carry = res; tr.liftAcc = 0; this.hideToken(res, 'lift'); }
    }
    if (tr.carry) {
      if (spin > 30) tr.liftAcc += spin * dt;
      const k = Math.min(1, tr.liftAcc / LIFT_CYCLE);
      tr.lift.position.y = 2.2 + 19 * k;
      const lp = tr.toWorld({ x: 0, y: 2.2 + 19 * k + 0.9, z: 2.6 });
      tr.carry.mesh.position.set(lp.x, lp.y, lp.z);
      if (k >= 1) {
        const t = tr.carry; tr.carry = null; tr.liftAcc = 0;
        tr.canopy++;
        t.where = 'canopy';
        const slot = tr.canopySlots[Math.min(tr.canopy - 1, tr.canopySlots.length - 1)];
        const wp = tr.toWorld(slot);
        t.mesh.position.set(wp.x, wp.y, wp.z); t.mesh.quaternion.set(0, 0, 0, 1);
        this.emit('event', side, `M02: ресурс в canopy chamber (${tr.canopy})`);
      }
    } else if (tr.lift.position.y > 2.2) tr.lift.position.y = Math.max(2.2, tr.lift.position.y - 30 * dt);
    this.treeDrives[side].forEach((d) => { d.load = tr.carry ? 40 : 0; });
    // Token Recycler: выпуск по очереди
    const rc = m.rec;
    if (rc.queue.length && this.time >= rc.nextRelease - T_EPS) {
      if (this.releaseAt(rc, rc.queue[0], (this.rng() - 0.5) * 8)) { rc.queue.shift(); rc.nextRelease = this.time + REC_GAP; }
      else rc.nextRelease = this.time + 0.2;
    }
  }

  /**
   * Выпустить фишку из модели (водопад, recycler). Если выход занят кучкой фишек дольше JAM_SPILL,
   * фишка выпускается на ближайшее свободное место перед выходом (на коврик или поверх кучки) —
   * фишки не застревают внутри модели до конца матча.
   */
  releaseAt(mdl, t, lateral = 0) {
    if (!t.body) return true;
    const p = mdl.toWorld(mdl.exitL), q = mdl.wq(null);
    const s = t.type === 'K' ? TOKEN_SIZE.K : TOKEN_SIZE.R;
    const shape = new RAPIER.Cylinder(s.h / 2 + 0.05, s.r + 0.1);
    const movers = G.TOKEN | G.RED | G.BLUE | G.ATT_RED | G.ATT_BLUE | G.MECH;
    const v = mdl.rotVec({ x: mdl.exitV.x, y: mdl.exitV.y, z: mdl.exitV.z + lateral });
    if (!this.phys.occupied(p, q, shape, groups(ALL, movers))) {
      mdl.jamSince = null;
      this.showToken(t, p, q, v);
      return true;
    }
    if (mdl.jamSince === null || mdl.jamSince === undefined) mdl.jamSince = this.time;
    if (this.time - mdl.jamSince < JAM_SPILL - T_EPS) return false;
    // место у выхода: вдоль направления выпуска и чуть в стороны; сначала свободный коврик (кучка
    // растёт вширь), потом поверх фишек; высота — по поверхности под точкой. Пока выход занят, следующие
    // фишки идут сюда же без новой паузы JAM_SPILL (jamSince не сбрасывается).
    const ev = mdl.exitV, n = Math.hypot(ev.x, ev.z) || 1, dx = ev.x / n, dz = ev.z / n;
    const rayF = groups(ALL, G.GROUND | G.STATIC | G.TOKEN | G.MECH);
    for (const onTop of [false, true]) {
      for (const along of [2.5, 4.5, 6.5, 8.5]) {
        for (const side of [0, 2.2, -2.2, 4.4, -4.4]) {
          const lp = { x: mdl.exitL.x + dx * along - dz * side, y: 0, z: mdl.exitL.z + dz * along + dx * side };
          const w = mdl.toWorld(lp);
          const hit = this.phys.ray({ x: w.x, y: mdl.exitL.y + 6, z: w.z }, { x: 0, y: -1, z: 0 }, mdl.exitL.y + 8, rayF);
          if (!hit || !hit.info || hit.info.kind !== (onTop ? 'token' : 'ground')) continue;
          const y = mdl.exitL.y + 6 - hit.toi + s.h / 2 + 0.08;
          if (y > mdl.exitL.y + 1.5) continue; // кучка уже выше выхода
          const wp = { x: w.x, y, z: w.z };
          if (this.phys.occupied(wp, q, shape, groups(ALL, movers | G.STATIC))) continue;
          this.showToken(t, wp, q, { x: v.x * 0.3, y: 0, z: v.z * 0.3 });
          return true;
        }
      }
    }
    return false;
  }

  /** Specialist: фишки, покоящиеся хотя бы частично в зоне Specialist, -> Token Recycler -> снова на поле */
  recycle(side) {
    const s = L.specArea, rc = this.models[side].rec;
    let n = 0;
    for (const t of [...this.tokens]) {
      if ((t.type !== 'K' && t.type !== 'R') || t.where !== 'field' || !t.body) continue;
      const p = t.body.translation(), mp = toMap(p.x, p.z, side);
      const r = this.footR(t) * 10;
      if (!inRect(s, mp, r)) continue;
      if (!this.isResting(t) || !this.isLoose(t)) continue;
      this.hideToken(t, 'rec'); t.mesh.visible = false;
      rc.queue.push(t); n++;
    }
    if (n && rc.queue.length === n) rc.nextRelease = this.time + 0.4;
    if (n) this.emit('event', side, `Specialist: ${n} фиш. в Token Recycler`);
    return n;
  }

  // ---------------- очки (Game Missions, Future Edition) ----------------
  rawScore(side) {
    const m = this.models[side], st = this.state[side], o = other(side);
    let provisional = false;
    let yf = 0, gt = 0, ht = 0, base = 0, haven = 0, contained = 0;
    const hc = toWorld(L.haven.x, L.haven.y), hr = L.haven.r / 10;
    const cc = toWorld(L.containment.x, L.containment.y, side), cr = L.containment.r / 10;
    for (const t of this.tokens) {
      if (t.where !== 'field' || !t.body) continue;
      const p = t.body.translation();
      if (t.type === 'K') {
        // M01: хотя бы частично в микробиоме (и на стенке кольца — «линия»), свободно (не касается
        // оборудования) и не лежит на инвазивном виде, закрывающем кольцо
        const fr = TOKEN_SIZE.K.r;
        const a = m.yf.overRing(m.yf.ringZone, p, fr), b = m.tree.overRing(m.tree.ringZone, p, fr), c = m.hollow.overRing(m.hollow.ringZone, p, fr);
        if (a || b || c) {
          if (!this.isResting(t)) provisional = true;
          if (this.isLoose(t) && !this.touchingInvasive(t)) { if (a) yf++; if (b) gt++; if (c) ht++; }
        }
      }
      // M02: «Resources in the grand tree base» — условия «не касаться оборудования» в миссии нет
      if (t.type === 'R' && m.tree.inBox(m.tree.baseZone, p)) {
        base++;
        if (!this.isResting(t)) provisional = true;
      }
      // M05: «resting completely in the central haven» — целиком в круге и в покое; робот может
      // касаться (фишка в поднятом ковше не «в покое в круге»: её отсекает высота)
      if (t.type === 'K' || t.type === 'R') {
        const d = Math.hypot(p.x - hc.x, p.z - hc.z);
        if (d < hr + 2) {
          const rr = this.footR(t);
          if (d + rr <= hr && p.y < 3.5) {
            if (this.isResting(t)) haven++; else provisional = true;
          }
        }
      }
      // LUC: инвазивный вид хотя бы частично в зоне (по реальной оболочке, а не по точке у «ног»)
      if (INVASIVE.has(t.type)) {
        const d = Math.hypot(p.x - cc.x, p.z - cc.z);
        if (d < cr + 12 && this.invasivePoints(t).some((q) => Math.hypot(q.x - cc.x, q.z - cc.z) <= cr)) {
          contained++; if (!this.isResting(t)) provisional = true;
        }
      }
    }
    const qDown = this.models[o].hive.hit && this.queenDown(o);
    const bonus = yf >= 3 && qDown;
    if (this.models[o].hive.hit && this.models[o].hive.motor.busy) provisional = true;
    const m01 = 20 * (Math.min(yf, 3) + Math.min(gt, 3) + Math.min(ht, 3)) + (bonus ? 40 : 0);
    const canopy = Math.min(m.tree.canopy, 15);
    const m02 = 5 * base + 10 * canopy;
    const disp = m.falls.display;
    const m03 = 5 * Math.min(disp, 50);
    if (m.falls.queue.length || m.tree.carry || m.rec.queue.length) provisional = true;
    const m04 = (st.nestReleased ? 30 : 0) + (st.hollowReleased ? 20 : 0);
    if ((m.nest.open && !st.nestReleased) || (m.hollow.open && !st.hollowReleased)) provisional = true;
    const m05 = 5 * haven;
    const added = Math.min(5, this.invasivePlaced[side].length);
    const luc = 20 * added + 10 * contained;
    const missions = m01 + m02 + m03 + m04 + m05 + luc;
    return {
      missions, provisional,
      rows: [
        { id: 'M01', pts: m01, detail: `YF ${yf}${yf > 3 ? ' (4-й не в счёт)' : ''} · GT ${gt} · HT ${ht}${bonus ? ' · бонус +40' : ''}` },
        { id: 'M02', pts: m02, detail: `base ${base} · canopy ${m.tree.canopy}` },
        { id: 'M03', pts: m03, detail: `счётчик ${disp}` },
        { id: 'M04', pts: m04, detail: `nest ${st.nestReleased ? '✓' : '—'} · hollow ${st.hollowReleased ? '✓' : '—'}` },
        { id: 'M05', pts: m05, detail: `в круге ${haven}` },
        { id: 'LUC', pts: luc, detail: `добавлено ${added} · в зоне ${contained}` },
      ],
    };
  }

  /** Итог с учётом штрафов: 1-й −10, 2-й ещё −20, 3-й — счёт матча 0; не ниже 0. */
  score(side) {
    const raw = this.latched ? this.latched[side] : this.rawScore(side);
    const n = this.penalties[side].n;
    const penalty = n <= 0 ? 0 : n === 1 ? 10 : n === 2 ? 30 : raw.missions;
    const total = n >= 3 ? 0 : Math.max(0, raw.missions - penalty);
    return {
      missions: raw.missions, penalty, penalties: n, total,
      provisional: this.latched ? false : raw.provisional, latched: !!this.latched,
      rows: raw.rows.map((r) => ({ ...r })),
    };
  }
  setPenalties(side, n, opts = {}) {
    this.penalties[side] = { n: Math.max(0, Math.round(Number(n) || 0)), log: opts.log ? [...opts.log] : (this.penalties[side].log || []), discretionary: !!opts.discretionary };
    return this.score(side);
  }
  /** Заморозить «официальный» счёт (по окончании матча) */
  latchScore() { this.latched = { red: this.rawScore('red'), blue: this.rawScore('blue') }; return { red: this.score('red'), blue: this.score('blue') }; }
  unlatch() { this.latched = null; }

  // ---------------- правила: Courtesy, inspection, руки ----------------
  /** Фишки, которые робот везёт (касаются робота и не стоят на коврике/моделях, либо лежат на везомых) */
  carriedBy(side) {
    const carried = new Set();
    const cand = this.tokens.filter((t) => t.where === 'field' && t.body);
    for (const t of cand) {
      // в ковше/захвате — во владении робота, даже если ковш опущен на коврик
      if (this.inAttachment(t, side)) { carried.add(t); continue; }
      if (this.touchingEquipment(t, side) && !this.touchingGround(t) && !this._touchingStatic(t)) carried.add(t);
    }
    for (let k = 0; k < 2; k++) for (const t of cand) {
      if (carried.has(t) || this.touchingGround(t)) continue;
      for (const c of t.colliders) if (this._touching(c, (inf) => inf && inf.kind === 'token' && carried.has(inf.token))) { carried.add(t); break; }
    }
    return [...carried];
  }
  _touchingStatic(t) {
    for (const c of t.colliders) if (this._touching(c, (inf) => inf && (inf.kind === 'model' || inf.kind === 'wall'))) return true;
    return false;
  }
  /** Courtesy rule: робот -> зона Technician; везомые фишки снимаются из игры, толкаемые остаются */
  courtesyReturn(side) {
    const carried = this.carriedBy(side);
    for (const t of carried) this.removeFromPlay(t, 'снята (Courtesy rule: была в роботе)');
    // свободное место в зоне Technician (не поверх фишек и не на другом роботе)
    const pose = this.robots[side].resetPose();
    this.courtesy[side]++;
    this.emit('event', side, `Courtesy rule: робот возвращён в зону Technician (${this.courtesy[side]}-й раз), снято фишек: ${carried.length}`);
    this.emit('robot', side);
    return { removed: carried.map((t) => t.id), count: this.courtesy[side], flagged: this.courtesy[side] >= 2, placedFree: !!(pose && pose.free) };
  }
  /** Inspection: робот целиком в зоне Technician и не выше 20.3 см */
  inspect(side) {
    const r = this.robots[side], issues = [];
    const pts = r.hullWorld();
    let outside = 0, maxY = -Infinity;
    for (const p of pts) {
      const mp = toMap(p.x, p.z, side);
      if (!inRect(L.techArea, mp, 0.5)) outside++;
      maxY = Math.max(maxY, p.y);
    }
    const inArea = outside === 0;
    if (!inArea) issues.push('Робот не целиком в зоне Technician.');
    const h = maxY;
    if (h > 20.3 + 0.05) issues.push(`Высота ${h.toFixed(1)} см больше 20.3 см.`);
    const v = validateConfig(r.config);
    for (const e of v.errors) issues.push(e);
    return { ok: issues.length === 0, issues, inArea, heightCm: +h.toFixed(1) };
  }
  /**
   * Можно ли игроку взять фишку рукой. role: driver | technician | operator | specialist.
   * Игрок трогает только предметы целиком в своей зоне; Operator — K/R хотя бы частично в retrieval zone;
   * из корней (mangrove roots) — только инструментом.
   */
  handle(side, role, token) {
    const t = typeof token === 'string' ? this.byId.get(token) : token;
    if (!t || t.where !== 'field' || !t.body) return { ok: false, reason: 'Фишка не на поле.' };
    const p = t.body.translation(), mp = toMap(p.x, p.z, side), r = this.footR(t) * 10;
    const area = role === 'technician' ? L.techArea : role === 'operator' ? L.operArea : role === 'specialist' ? L.specArea : null;
    if (!area) return { ok: false, reason: 'Driver работает только пультом и не трогает предметы на поле.' };
    // «дождитесь остановки» — Courtesy rule только для Specialist (Rule 18); Technician и Operator
    // берут любой предмет целиком в своей зоне (Rule 14)
    if (role === 'specialist') {
      if (!this.isResting(t, 3)) return { ok: false, reason: 'Дождитесь, пока фишка остановится.' };
      if (this.touchingEquipment(t)) return { ok: false, reason: 'Фишка касается робота.' };
    }
    if (role === 'operator' && inRect(L.lattice, mp, r)) return { ok: false, reason: 'Фишку из корней (mangrove roots) достают только инструментом.' };
    if (inRect(area, mp, -r)) return { ok: true, reason: 'Фишка целиком в вашей зоне.', area: role };
    if (role === 'operator' && (t.type === 'K' || t.type === 'R') && inRect(L.retrieval, mp, r)) return { ok: true, reason: 'Retrieval zone: можно забрать в зону Operator.', area: 'retrieval' };
    return { ok: false, reason: 'Брать рукой можно только предметы целиком в своей зоне.' };
  }

  // ---------------- робот ----------------
  /** Пересобрать робота команды. Без force — только если робот целиком в зоне Technician. */
  setRobotConfig(side, cfg, { force = false } = {}) {
    const v = validateConfig(cfg);
    if (!v.ok && !force) return { ...v, ok: false };
    const old = this.robots[side];
    const ins = this.inspect(side);
    if (!ins.inArea && !force) return { ...v, ok: false, errors: [...v.errors, 'Менять робота можно, только когда он целиком в зоне Technician.'] };
    const pose = ins.inArea ? { x: old.position.x, z: old.position.z, yaw: old.yawWorld } : null;
    old.dispose();
    const r = this.phys.own(() => new Robot(this, side, v.cfg, pose));
    this.robots[side] = r;
    this.scene.add(r.group);
    // новая геометрия может задеть фишки или другого робота — ближайшее свободное место в зоне
    if (pose && !r.poseFree(pose.x, pose.z, pose.yaw)) {
      const f = r.findFreePose(pose);
      if (f) { r.setPose(f.x, f.z, f.yaw, true); r.resetMotors(); }
    }
    this.emit('robot', side);
    return { ...v, ok: true };
  }

  // ---------------- перетаскивание мышью ----------------
  grabToken(t) {
    if (!t || !t.body || t.where !== 'field') return false;
    t.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    t.grabbed = true;
    return true;
  }
  dragToken(t, x, y, z) {
    if (!t || !t.grabbed || !t.body) return;
    t.body.setNextKinematicTranslation({ x, y, z });
    t.mesh.position.set(x, y, z);
  }
  dropToken(t) {
    if (!t || !t.grabbed || !t.body) return;
    t.grabbed = false;
    const p = t.body.nextTranslation ? t.body.nextTranslation() : t.body.translation();
    t.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    t.body.setTranslation(p, true);
    t.body.setLinvel({ x: 0, y: 0, z: 0 }, true); t.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    t.body.wakeUp();
  }

  // ---------------- датчик цвета ----------------
  /** Цвет под точкой (лучом вниз по физике): коврик из таблицы цветов, фишки и модели — их цвет. */
  colorAt(worldPos) {
    const mp = toMap(worldPos.x, worldPos.z, 'red');
    if (mp.x < 0 || mp.y < 0 || mp.x > FIELD_W || mp.y > FIELD_H) return { r: 0, g: 0, b: 0 };
    const filt = groups(ALL, ALL & ~(G.RED | G.BLUE | G.ATT_RED | G.ATT_BLUE));
    const hit = this.phys.ray({ x: worldPos.x, y: worldPos.y + 0.02, z: worldPos.z }, { x: 0, y: -1, z: 0 }, 6, filt);
    if (!hit) return { r: 0, g: 0, b: 0 };
    const d = hit.toi;
    const k = clamp(1 - Math.max(0, d - 1.2) / 3.0, 0, 1); // дальше ~1 см сигнал слабеет
    let rgb;
    const inf = hit.info;
    if (inf && inf.kind === 'token') {
      rgb = inf.type === 'K' ? [246, 194, 26] : inf.type === 'R' ? [19, 163, 166] : [166, 201, 30];
    } else if (inf && (inf.kind === 'model' || inf.kind === 'wall') && inf.color !== undefined) {
      const c = inf.color; rgb = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
    } else {
      const hx = worldPos.x, hz = worldPos.z;
      const q = toMap(hx, hz, 'red');
      rgb = this.mat.sample(q.x, q.y);
    }
    return { r: rgb[0] * k, g: rgb[1] * k, b: rgb[2] * k };
  }

  setMatImage(img) {
    this.mat = matFromImage(img, 2048);
    this.matTex.image = this.mat.canvas;
    this.matTex.needsUpdate = true;
  }

  // ---------------- состояние (онлайн) ----------------
  /** Компактный снимок: фишки по стабильным id, тела роботов, механизмы, счётчики */
  getState() {
    const tok = [];
    for (const t of this.byId.values()) {
      const w = WHERE[t.where] ?? 0;
      if (t.body && t.where === 'field') {
        const p = t.body.translation(), q = t.body.rotation();
        tok.push([t.id, w, r3(p.x), r3(p.y), r3(p.z), r3(q.x), r3(q.y), r3(q.z), r3(q.w)]);
      } else tok.push([t.id, w]);
    }
    const rob = {}, mech = {};
    for (const s of SIDES) {
      const r = this.robots[s];
      rob[s] = { b: r.getBodyState().map((a) => a.map(r3)), m: [r.left.pos, r.right.pos, r.arm.pos].map(r3), led: r.ledColor, y: r3(r.yawCont), sig: cfgSig(r.config) };
      const m = this.models[s];
      const kin = (b) => { const p = b.translation(), q = b.rotation(); return [p.x, p.y, p.z, q.x, q.y, q.z, q.w].map(r3); };
      mech[s] = {
        nest: [m.nest.open ? 1 : 0, r3(m.nest.tilt), kin(m.nest.lv.body), kin(m.nest.tray.body)],
        hollow: [m.hollow.open ? 1 : 0, r3(m.hollow.openT), kin(m.hollow.lv.body), kin(m.hollow.gate.body)],
        falls: [m.falls.count, m.falls.queue.map((t) => t.id)],
        tree: [m.tree.canopy, r3(m.tree.liftAcc), m.tree.carry ? m.tree.carry.id : null],
        yf: [m.yf.triggered ? 1 : 0], hive: [m.hive.hit ? 1 : 0, r3(m.hive.motor.pos), kin(m.hive.paddle.body)],
        rec: m.rec.queue.map((t) => t.id),
        st: [this.state[s].nestReleased ? 1 : 0, this.state[s].hollowReleased ? 1 : 0],
        inv: this.invasivePlaced[s], pen: this.penalties[s].n,
      };
    }
    return { v: 1, t: r3(this.time), n: this.stepCount, tok, rob, mech, latched: !!this.latched };
  }

  /** Применить снимок у гостя (без шага физики) */
  applyState(s) {
    if (!s || !s.tok) return;
    // поле у хоста сброшено (другие инвазивные виды или вернулись снятые фишки) — сбросить и у гостя
    let needReset = false;
    for (const side of SIDES) {
      const inv = s.mech && s.mech[side] && s.mech[side].inv;
      if (inv && JSON.stringify(inv) !== JSON.stringify(this.invasivePlaced[side])) needReset = true;
    }
    for (const row of s.tok) {
      const t = this.byId.get(row[0]);
      if (!t || (t.where === 'removed' && row[1] !== WHERE.removed)) { needReset = true; break; }
    }
    if (needReset) {
      const inv = {};
      for (const side of SIDES) inv[side] = (s.mech && s.mech[side] && s.mech[side].inv) || [];
      this.resetField({ invasives: inv, keepRobots: true });
    }
    this.time = s.t; this.stepCount = s.n;
    for (const row of s.tok) {
      const t = this.byId.get(row[0]);
      if (!t) continue;
      const where = WHERE_BY[row[1]] || 'field';
      if (where === 'removed') { if (t.where !== 'removed') this.removeFromPlay(t, 'снята из игры'); continue; }
      if (!t.body) continue;
      if (where === 'field') {
        if (!t.body.isEnabled()) t.body.setEnabled(true);
        t.body.setTranslation({ x: row[2], y: row[3], z: row[4] }, false);
        t.body.setRotation({ x: row[5], y: row[6], z: row[7], w: row[8] }, false);
        t.where = 'field'; t.mesh.visible = true;
      } else {
        if (t.body.isEnabled()) t.body.setEnabled(false);
        t.where = where; t.mesh.visible = where === 'canopy' || where === 'lift';
      }
    }
    for (const side of SIDES) {
      const r = this.robots[side], rs = s.rob && s.rob[side];
      if (rs) { r.applyBodyState(rs.b); if (rs.led !== undefined && rs.led !== r.ledColor) r.setLed(rs.led); }
      const ms = s.mech && s.mech[side];
      if (!ms) continue;
      const m = this.models[side];
      const setKin = (b, a) => { b.setTranslation({ x: a[0], y: a[1], z: a[2] }, false); b.setRotation({ x: a[3], y: a[4], z: a[5], w: a[6] }, false); };
      m.nest.open = !!ms.nest[0]; m.nest.tilt = ms.nest[1]; setKin(m.nest.lv.body, ms.nest[2]); setKin(m.nest.tray.body, ms.nest[3]);
      m.hollow.open = !!ms.hollow[0]; m.hollow.openT = ms.hollow[1]; setKin(m.hollow.lv.body, ms.hollow[2]); setKin(m.hollow.gate.body, ms.hollow[3]);
      m.falls.count = ms.falls[0]; m.falls.queue = ms.falls[1].map((id) => this.byId.get(id)).filter(Boolean); m.falls.setNeedle();
      const prevCanopy = m.tree.canopy;
      m.tree.canopy = ms.tree[0]; m.tree.liftAcc = ms.tree[1]; m.tree.carry = ms.tree[2] ? this.byId.get(ms.tree[2]) || null : null;
      if (m.tree.canopy !== prevCanopy) this.layoutCanopy(side);
      m.yf.triggered = !!ms.yf[0]; m.yf.indMat.emissive.setHex(m.yf.triggered ? 0xf6c21a : 0);
      m.hive.hit = !!ms.hive[0]; setKin(m.hive.paddle.body, ms.hive[2]);
      m.rec.queue = ms.rec.map((id) => this.byId.get(id)).filter(Boolean);
      this.state[side].nestReleased = !!ms.st[0]; this.state[side].hollowReleased = !!ms.st[1];
      this.penalties[side].n = ms.pen;
    }
    this.sync();
  }
  /** Расставить видимые фишки в canopy chamber */
  layoutCanopy(side) {
    const tr = this.models[side].tree;
    let i = 0;
    for (const t of this.byId.values()) {
      if (t.side !== side || t.where !== 'canopy') continue;
      const wp = tr.toWorld(tr.canopySlots[Math.min(i++, tr.canopySlots.length - 1)]);
      t.mesh.position.set(wp.x, wp.y, wp.z); t.mesh.visible = true;
    }
  }

  // ---------------- кадр ----------------
  step(dt = DT) {
    this.time += dt;
    this.stepCount++;
    this.preStep(dt);
    this.world.step();
    this.postStep(dt);
  }

  syncToken(t) {
    if (!t.body || t.where !== 'field') return;
    const p = t.body.translation(), q = t.body.rotation();
    t.mesh.position.set(p.x, p.y, p.z);
    t.mesh.quaternion.set(q.x, q.y, q.z, q.w);
  }
  sync() {
    for (const t of this.tokens) if (!t.grabbed) this.syncToken(t);
    for (const s of SIDES) {
      this.robots[s].sync();
      const m = this.models[s];
      m.hollow.sync(); m.nest.sync(); m.hive.sync();
    }
  }
  render() { this.renderer.render(this.scene, this.camera); }
}

/** RGB (0..255) -> показания датчика цвета LEGO */
export function colorReading({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === R) h = ((G - B) / d) % 6; else if (mx === G) h = (B - R) / d + 2; else h = (R - G) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  const s = mx === 0 ? 0 : d / mx, v = mx;
  const refl = Math.round((0.299 * R + 0.587 * G + 0.114 * B) * 100);
  let color;
  if (v < 0.04) color = -1;                   // ничего под датчиком
  else if (v < 0.18) color = 0;               // BLACK
  else if (s < 0.18 && v > 0.75) color = 10;  // WHITE
  else if (s < 0.22) color = v > 0.5 ? 10 : 0;
  else if (h < 15 || h >= 340) color = 9;     // RED
  else if (h < 40) color = 8;                 // ORANGE
  else if (h < 68) color = 7;                 // YELLOW
  else if (h < 160) color = 6;                // GREEN
  else if (h < 186) color = 5;                // TEAL
  else if (h < 206) color = 4;                // AZURE
  else if (h < 250) color = 3;                // BLUE
  else if (h < 290) color = 2;                // PURPLE
  else color = 1;                             // MAGENTA
  return {
    color, reflection: refl,
    rawRed: Math.round(R * 1023), rawGreen: Math.round(G * 1023), rawBlue: Math.round(B * 1023),
    hue: Math.round(h), saturation: Math.round(s * 100), value: Math.round(v * 100),
  };
}
