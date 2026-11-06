// Конструктор робота (вкладка «Конструктор»): параметры RobotConfig, 3D-превью, след в зоне Technician,
// шкала высоты, проверка по правилам железа Future Edition, применение к команде, сохранение,
// экспорт/импорт JSON и код для обмена. install(app) рисует панель в app.ui.panel('builder').
import * as THREE from 'three';
import { brick, C, mat } from './lego.js';
import {
  WHEELS, HOUSING, ATTACHMENTS, LIMITS, PRESETS, BUILDER_PRESETS,
  normalizeConfig, robotGeometry, validateConfig, hullPoints,
} from './robotConfig.js';
import { L as LAYOUT } from './layout.js';
import { SIM } from './motors.js';

const SIDES = ['red', 'blue'];
const TEAM = { red: { ru: 'Красная', gen: 'красной' }, blue: { ru: 'Синяя', gen: 'синей' } };
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const T = LAYOUT.techArea, ST = LAYOUT.robotStart;
/** Зона Technician в мм от её угла у борта; старт робота (центр корпуса), вперёд = +x зоны */
export const AREA = { w: T.x1 - T.x0, h: T.y1 - T.y0, sx: ST.x - T.x0, sy: ST.y - T.y0 };
export const SHARE_PREFIX = 'BGR1.';
const ALL_PRESETS = [...PRESETS, ...BUILDER_PRESETS];
// передаточные числа руки из реальных пар шестерён LEGO
const RATIOS = [[1, '1 : 1 — без редукции'], [1.667, '1 : 1.67 — 12 → 20 зубьев'], [3, '1 : 3 — 12 → 36 (8 → 24)'], [5, '1 : 5 — 8 → 40']];
const COLORS = { white: C.white, lightGrey: C.lightGrey, darkGrey: C.darkGrey, black: C.black, lime: C.lime, green: C.green, orange: C.orange, teal: C.teal, azure: C.azure, yellow: C.yellow, red: C.red, blue: C.blue, tan: C.tan };

// ---------- хранилище (может быть недоступно) ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem('bioglow.builder.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bioglow.builder.' + k, JSON.stringify(v)); return true; } catch { return false; } },
};

// ---------- чистые помощники ----------
const cloneCfg = (c) => JSON.parse(JSON.stringify(normalizeConfig(c)));
/** Одинаковы ли две конфигурации (после нормализации) */
export const sameConfig = (a, b) => JSON.stringify(normalizeConfig(a)) === JSON.stringify(normalizeConfig(b));
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, p, v) { const ks = p.split('.'); let a = o; for (let i = 0; i < ks.length - 1; i++) a = a[ks[i]] ||= {}; a[ks[ks.length - 1]] = v; }
const fmt = (v, n = 1) => (Number.isFinite(v) ? v.toFixed(n) : '—');

function convexHull(pts) {
  const p = pts.map((q) => [q.x, q.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up);
}

/**
 * Разбор конфигурации для конструктора: проверка validateConfig, геометрия, след на старте (мм зоны),
 * радиус разворота на месте, высота с поднятой рукой, скорость, рука, железо.
 */
export function analyze(cfgIn) {
  const v = validateConfig(cfgIn);
  const geo = robotGeometry(v.cfg);
  const pts0 = hullPoints(geo, 0);
  const foot = pts0.map((p) => ({ x: AREA.sx + p.x * 10, y: AREA.sy + p.z * 10 }));
  const hull = convexHull(foot);
  const fitsStart = foot.every((p) => p.x >= -0.5 && p.x <= AREA.w + 0.5 && p.y >= -0.5 && p.y <= AREA.h + 0.5);
  const W = geo.wheels;
  let spinR = 0;
  for (const p of pts0) spinR = Math.max(spinR, Math.hypot(p.x - W.x, p.z));
  const spinWall = AREA.sy - spinR * 10 >= 0;   // разворот у старта не задевает борт стола
  let hMax = v.bbox.heightCm, hMaxDeg = 0;
  if (geo.arm) {
    const a0 = Math.round(geo.arm.aMin * R2D), a1 = Math.round(geo.arm.aMax * R2D);
    for (let d = a0; d <= a1; d += 5) {
      let top = -Infinity;
      for (const p of hullPoints(geo, d * D2R)) top = Math.max(top, p.y);
      const h = top - geo.ground;
      if (h > hMax) { hMax = h; hMaxDeg = d; }
    }
  }
  const speed = Math.min(SIM.maxDegS, SIM.drive.free) / 360 * Math.PI * W.d;
  const arm = geo.arm ? {
    torqueNcm: SIM.single.stall / 100 * geo.arm.ratio, degS: SIM.single.free / geo.arm.ratio,
    minDeg: Math.round(geo.arm.aMin * R2D), maxDeg: Math.round(geo.arm.aMax * R2D), lengthCm: geo.arm.L,
  } : null;
  const A = ATTACHMENTS[v.cfg.attachment.type];
  const hw = { doubleMotors: 1, singleMotors: A.motor ? 1 : 0, colorSensors: v.cfg.sensor.enabled ? 1 : 0 };
  return { v, geo, foot, hull, fitsStart, spinR, spinWall, hMax: +hMax.toFixed(1), hMaxDeg, speed, arm, hw };
}

// ---------- код для обмена и JSON ----------
/** Конфигурация -> короткий код (base64url от JSON) */
export function encodeShare(cfg) {
  const bytes = new TextEncoder().encode(JSON.stringify(cloneCfg(cfg)));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return SHARE_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** Код -> исходная (не нормализованная) конфигурация; бросает понятную ошибку */
export function decodeShare(code) {
  let s = String(code || '').replace(/\s+/g, '');
  if (s.startsWith(SHARE_PREFIX)) s = s.slice(SHARE_PREFIX.length);
  if (!s) throw new Error('Вставьте код робота.');
  if (!/^[A-Za-z0-9_+/=-]+$/.test(s)) throw new Error('В коде робота лишние символы.');
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  let json;
  try { const bin = atob(s); json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); } catch { throw new Error('Код робота повреждён.'); }
  return parseConfigText(json);
}
/** Текст JSON (файл экспорта или «голая» конфигурация) -> конфигурация */
export function parseConfigText(text) {
  const t = String(text || '');
  if (t.length > 200000) throw new Error('Файл слишком большой для конфигурации робота.');
  let o;
  try { o = JSON.parse(t); } catch { throw new Error('Это не JSON.'); }
  const cfg = o && typeof o === 'object' && o.config && typeof o.config === 'object' ? o.config : o;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || !(cfg.wheels || cfg.attachment || cfg.chassis)) throw new Error('Это не конфигурация робота BIOGLOW.');
  return cfg;
}
/** Текст файла экспорта */
export function exportText(cfg) {
  return JSON.stringify({ format: 'bioglow-robot', version: 1, config: cloneCfg(cfg) }, null, 2);
}

// ---------- 3D-модель робота (как robot.js, но без физики) ----------
const geoCache = new Map();
const cached = (k, make) => { if (!geoCache.has(k)) geoCache.set(k, make()); return geoCache.get(k); };
let ledMat = null;

/** three.js-группа робота по конфигурации; низ колёс на y = 0, центр корпуса на x = z = 0. armDeg — угол руки от нижнего упора. */
export function buildRobotModel(cfgIn, side = 'red', armDeg = 0) {
  const geo = robotGeometry(cfgIn), cfg = geo.cfg;
  const root = new THREE.Group();
  root.name = 'builder-robot';
  root.position.y = geo.hc;
  const parts = (g, list) => {
    for (const p of list) {
      if (p.visual === false) continue;
      const col = COLORS[p.color] ?? C.lightGrey;
      if (p.shape === 'ball') {
        const m = new THREE.Mesh(cached('s' + p.r, () => new THREE.SphereGeometry(p.r, 16, 12)), mat(col));
        m.position.set(p.x, p.y, p.z); g.add(m);
      } else {
        g.add(brick(p.w, p.h, p.d, col, p.x, p.y, p.z, { studs: p.name === 'housing' || p.name === 'frame' || p.name === 'singleMotor', rx: p.rx, ry: p.ry, rz: p.rz }));
      }
    }
    return g;
  };
  const ch = parts(new THREE.Group(), geo.chassis);
  const H = HOUSING.H;
  ch.add(brick(7.26, 0.9, 5.66, C.teal, 0, -H / 2 + 0.8, 0));
  ch.add(brick(2.4, 0.5, 5.7, side === 'blue' ? C.blue : C.red, -2.2, H / 2 - 0.2, 0));
  ledMat ||= new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8 });
  const led = new THREE.Mesh(cached('led', () => new THREE.SphereGeometry(0.45, 12, 8)), ledMat);
  led.position.set(-2.4, geo.top + 0.3, 0); ch.add(led);
  if (cfg.sensor.enabled) {
    const lens = new THREE.Mesh(cached('lens', () => new THREE.CylinderGeometry(0.45, 0.45, 0.1, 14)), mat(C.black));
    lens.position.set(cfg.sensor.x, geo.ground + 0.78, cfg.sensor.z); ch.add(lens);
  }
  root.add(ch);
  // колёса
  const W = geo.wheels;
  for (const s of [-1, 1]) {
    const w = new THREE.Group();
    const tire = new THREE.Mesh(cached(`t${W.d}|${W.w}`, () => new THREE.CylinderGeometry(W.d / 2, W.d / 2, W.w, 28)), mat(C.black, { rough: 0.85 }));
    tire.rotation.x = Math.PI / 2;
    const hub = new THREE.Mesh(cached(`h${W.d}|${W.w}`, () => new THREE.CylinderGeometry(W.d * 0.27, W.d * 0.27, W.w + 0.1, 6)), mat(C.lightGrey));
    hub.rotation.x = Math.PI / 2;
    w.add(tire, hub, brick(W.d * 0.46, 0.5, W.w + 0.15, C.darkGrey, 0, 0, 0));
    w.position.set(W.x, W.y, s * W.track / 2);
    root.add(w);
  }
  // навесное: рука вокруг оси Single Motor, голова держит наклон по профилю, створка — по своему профилю
  const A = geo.arm;
  if (A) {
    const a = clamp(armDeg * D2R, A.aMin, A.aMax), phi = A.theta0 + a, ad = a * R2D;
    const arm = parts(new THREE.Group(), A.parts);
    arm.position.set(A.pivot.x, A.pivot.y, A.pivot.z); arm.rotation.z = phi;
    root.add(arm);
    if (A.head) {
      const tip = { x: A.pivot.x + Math.cos(phi) * A.L, y: A.pivot.y + Math.sin(phi) * A.L, z: A.pivot.z };
      const pitch = A.head.profile(ad) * D2R;
      const head = parts(new THREE.Group(), A.head.parts);
      head.position.set(tip.x, tip.y, tip.z); head.rotation.z = pitch;
      root.add(head);
      if (A.head.gate) {
        const g = A.head.gate, c = Math.cos(pitch), s = Math.sin(pitch);
        const gate = parts(new THREE.Group(), g.parts);
        gate.position.set(tip.x + c * g.hinge.x - s * g.hinge.y, tip.y + s * g.hinge.x + c * g.hinge.y, tip.z + g.hinge.z);
        gate.rotation.z = pitch + g.profile(ad);
        root.add(gate);
      }
    }
  }
  return { root, geo };
}
function disposeModel(root) {
  root.traverse((o) => { if (o.isInstancedMesh) o.dispose(); }); // шипы брикетов; общие геометрии и материалы не трогаем
}

// ---------- окно превью: свой рендерер, орбита мышью/пальцами/клавиатурой ----------
class Preview {
  constructor(host) {
    this.host = host;
    this.ok = false;
    this.pending = false;
    this.model = null;
    this.fitR = 0;
    this.view = { theta: 0.8, phi: 0.95, r: 55, tx: 2, ty: 6, tz: 0 };
    this.userZoom = false;
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (e) {
      host.classList.add('bld-noview');
      host.textContent = 'Превью недоступно: браузер не создал WebGL-контекст. Остальные функции конструктора работают.';
      return;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const cv = this.canvas = this.renderer.domElement;
    cv.tabIndex = 0;
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', 'Превью робота. Перетаскивание — вращение, колесо или щипок — масштаб. С клавиатуры: стрелки — вращение, плюс и минус — масштаб, Home — вид по умолчанию.');
    host.appendChild(cv);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1.6, 0.5, 600);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x50604f, 1.7));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7); sun.position.set(25, 50, 30); this.scene.add(sun);
    this.overlay = this.buildOverlay();
    this.scene.add(this.overlay);
    this.bindInput();
    this.theme();
    this.ok = true;
  }

  /** Коврик, зона Technician 419 × 227 мм, борт стола и плоскость предела высоты 20.3 см (в системе робота на старте) */
  buildOverlay() {
    const g = new THREE.Group();
    const x0 = -AREA.sx / 10, x1 = (AREA.w - AREA.sx) / 10, z0 = -AREA.sy / 10, z1 = (AREA.h - AREA.sy) / 10;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, aw = x1 - x0, ah = z1 - z0;
    this.groundMat = new THREE.MeshStandardMaterial({ color: 0xdfe6da, roughness: 0.95 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(aw + 60, ah + 40), this.groundMat);
    ground.rotation.x = -Math.PI / 2; ground.position.set(cx, 0, cz + 10);
    this.areaMat = new THREE.MeshBasicMaterial({ color: 0x0d8775, transparent: true, opacity: 0.16, depthWrite: false });
    const area = new THREE.Mesh(new THREE.PlaneGeometry(aw, ah), this.areaMat);
    area.rotation.x = -Math.PI / 2; area.position.set(cx, 0.03, cz);
    const loop = (y) => new THREE.BufferGeometry().setFromPoints([[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]].map(([x, z]) => new THREE.Vector3(x, y, z)));
    this.lineMat = new THREE.LineBasicMaterial({ color: 0x0d8775 });
    const edge = new THREE.Line(loop(0.05), this.lineMat);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(aw + 8, 7.6, 3.8), mat(C.darkTan));
    wall.position.set(cx, 3.8, z0 - 1.9);
    this.limitMat = new THREE.MeshBasicMaterial({ color: 0xc4332a, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false });
    const lim = new THREE.Mesh(new THREE.PlaneGeometry(aw, ah), this.limitMat);
    lim.rotation.x = -Math.PI / 2; lim.position.set(cx, LIMITS.heightCm, cz);
    this.limitLine = new THREE.LineBasicMaterial({ color: 0xc4332a, transparent: true, opacity: 0.6 });
    const limEdge = new THREE.Line(loop(LIMITS.heightCm), this.limitLine);
    this.limitGroup = new THREE.Group(); this.limitGroup.add(lim, limEdge);
    this.areaGroup = new THREE.Group(); this.areaGroup.add(area, edge);
    g.add(ground, wall, this.areaGroup, this.limitGroup);
    return g;
  }

  /** Цвета из токенов темы (светлая/тёмная) */
  theme() {
    if (!this.renderer) return;
    const cs = getComputedStyle(this.host);
    const col = (name, d) => { const v = cs.getPropertyValue(name).trim(); try { return new THREE.Color(v || d); } catch { return new THREE.Color(d); } };
    this.scene.background = col('--panel-2', '#e6ece1');
    this.groundMat.color = col('--panel', '#f8faf5');
    const acc = col('--accent', '#0d8775'), err = col('--err', '#c4332a');
    this.areaMat.color = acc; this.lineMat.color = acc;
    this.limitMat.color = err; this.limitLine.color = err;
    this.request();
  }

  setOverlay(on) { if (!this.ok) return; this.areaGroup.visible = on; this.limitGroup.visible = on; this.request(); }

  setModel(cfg, side, armDeg) {
    if (!this.ok) return;
    if (this.model) { this.scene.remove(this.model); disposeModel(this.model); }
    const { root, geo } = buildRobotModel(cfg, side, armDeg);
    this.model = root;
    this.scene.add(root);
    // цель камеры — центр габарита; масштаб подбираем, пока пользователь сам не приблизил
    let x0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of hullPoints(geo, clamp(armDeg * D2R, geo.arm ? geo.arm.aMin : 0, geo.arm ? geo.arm.aMax : 0))) {
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); y1 = Math.max(y1, p.y);
    }
    const h = y1 - geo.ground;
    Object.assign(this.view, { tx: (x0 + x1) / 2, ty: Math.max(h * 0.4, 3), tz: (z0 + z1) / 2 });
    this.fitR = 0.5 * Math.hypot(x1 - x0, z1 - z0, h);   // радиус описанной сферы — по нему подбираем дальность
    this.request();
  }

  resetView() { Object.assign(this.view, { theta: 0.8, phi: 0.95 }); this.userZoom = false; }

  request() {
    if (!this.ok || this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.render(); });
  }

  render() {
    if (!this.ok) return false;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (w < 2 || h < 2) return false; // вкладка скрыта
    if (this.w !== w || this.h !== h) {
      this.w = w; this.h = h;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    }
    const v = this.view, s = Math.sin(v.phi);
    if (!this.userZoom && this.fitR) {
      // вписать робота с запасом: по меньшему из углов обзора (узкое окно на телефоне)
      const vf = this.camera.fov * D2R, hf = 2 * Math.atan(Math.tan(vf / 2) * this.camera.aspect);
      v.r = clamp(1.7 * this.fitR / Math.sin(Math.min(vf, hf) / 2), 25, 140);
    }
    this.camera.position.set(v.tx + v.r * s * Math.cos(v.theta), v.ty + v.r * Math.cos(v.phi), v.tz + v.r * s * Math.sin(v.theta));
    this.camera.lookAt(v.tx, v.ty, v.tz);
    this.renderer.render(this.scene, this.camera);
    return true;
  }

  bindInput() {
    const cv = this.canvas, pts = new Map();
    let pinch = 0;
    const rot = (dx, dy) => { this.view.theta += dx; this.view.phi = clamp(this.view.phi + dy, 0.12, 1.52); this.request(); };
    const zoom = (k) => { this.view.r = clamp(this.view.r * k, 14, 160); this.userZoom = true; this.request(); };
    cv.addEventListener('pointerdown', (e) => {
      try { cv.setPointerCapture(e.pointerId); } catch { /* синтетическое событие */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    });
    cv.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      if (pts.size === 1) rot((e.clientX - p.x) * 0.01, -(e.clientY - p.y) * 0.01);
      p.x = e.clientX; p.y = e.clientY;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0 && d > 0) zoom(pinch / d);
        pinch = d;
      }
    });
    const up = (e) => { pts.delete(e.pointerId); pinch = 0; };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => { e.preventDefault(); zoom(Math.exp(clamp(e.deltaY, -200, 200) * 0.0015)); }, { passive: false });
    cv.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.05 : 0.17;
      let used = true;
      switch (e.key) {
        case 'ArrowLeft': rot(-step, 0); break;
        case 'ArrowRight': rot(step, 0); break;
        case 'ArrowUp': rot(0, -step); break;
        case 'ArrowDown': rot(0, step); break;
        case '+': case '=': zoom(0.88); break;
        case '-': case '_': zoom(1 / 0.88); break;
        case 'Home': this.resetView(); this.request(); break;
        default: used = false;
      }
      // стрелки в превью не должны ехать роботом на поле
      if (used) { e.preventDefault(); e.stopPropagation(); }
    });
  }

  dispose() {
    if (!this.ok) return;
    if (this.model) disposeModel(this.model);
    this.renderer.dispose();
    this.canvas.remove();
    this.ok = false;
  }
}

// ---------- SVG: след в зоне Technician и шкала высоты ----------
/** След робота на старте внутри зоны Technician (вид сверху, мм) */
export function footprintSVG(an) {
  const W = an.geo.wheels, cfg = an.v.cfg, f = (n) => (+n).toFixed(1);
  const X = (x) => AREA.sx + x * 10, Y = (z) => AREA.sy + z * 10;
  const poly = an.hull.map(([x, y]) => `${f(x)},${f(y)}`).join(' ');
  const wheels = [-1, 1].map((s) => `<rect class="wheel" x="${f(X(W.x - W.d / 2))}" y="${f(Y(s * W.track / 2 - W.w / 2))}" width="${f(W.d * 10)}" height="${f(W.w * 10)}" rx="3"/>`).join('');
  const caster = cfg.caster.type === 'ball'
    ? `<circle class="caster" cx="${f(X(cfg.caster.x))}" cy="${f(Y(0))}" r="8"/>`
    : `<rect class="caster" x="${f(X(cfg.caster.x - 0.7))}" y="${f(Y(-0.8))}" width="14" height="16" rx="3"/>`;
  const sensor = cfg.sensor.enabled ? `<rect class="sensor" x="${f(X(cfg.sensor.x - 1))}" y="${f(Y(cfg.sensor.z - 1))}" width="20" height="20" rx="3"/><circle class="lens" cx="${f(X(cfg.sensor.x))}" cy="${f(Y(cfg.sensor.z))}" r="4.5"/>` : '';
  const ax = X(W.x), R = an.spinR * 10;
  const housing = `<rect class="housing" x="${f(X(-HOUSING.L / 2))}" y="${f(Y(-HOUSING.W / 2))}" width="${f(HOUSING.L * 10)}" height="${f(HOUSING.W * 10)}" rx="4"/>`;
  return `<svg viewBox="-16 -26 451 276" role="img" aria-label="Вид сверху: робот на старте в зоне Technician ${AREA.w} × ${AREA.h} мм">
<rect class="wall" x="-16" y="-14" width="451" height="14"/>
<text class="lbl" x="4" y="-17">борт стола</text>
<rect class="area" x="0" y="0" width="${AREA.w}" height="${AREA.h}"/>
<circle class="spin${an.spinWall ? '' : ' bad'}" cx="${f(ax)}" cy="${f(AREA.sy)}" r="${f(R)}"/>
<polygon class="hull${an.fitsStart ? '' : ' bad'}" points="${poly}"/>
${housing}${wheels}${caster}${sensor}
<path class="fwd" d="M${f(X(0))} ${f(Y(0))} h22 m-7 -6 l7 6 l-7 6"/>
<circle class="axle" cx="${f(ax)}" cy="${f(AREA.sy)}" r="3"/>
<text class="lbl" x="6" y="${AREA.h - 8}">Technician ${AREA.w} × ${AREA.h} мм</text>
<text class="lbl strong" x="${AREA.w - 6}" y="18" text-anchor="end">${Math.round(an.v.bbox.lengthCm * 10)} × ${Math.round(an.v.bbox.widthCm * 10)} мм</text>
</svg>`;
}
/** Вертикальная шкала высоты: 0…25 см, предел 20.3 см, метка — максимум с поднятой рукой */
export function gaugeSVG(an) {
  const y = (cm) => 214 - clamp(cm, 0, 25) * 8, h = an.v.bbox.heightCm, bad = h > LIMITS.heightCm;
  const ticks = [0, 5, 10, 15, 20, 25].map((c) => `<line class="tick" x1="40" x2="45" y1="${y(c)}" y2="${y(c)}"/><text class="lbl" x="48" y="${y(c) + 3.5}">${c}</text>`).join('');
  const mx = an.hMax > h + 0.05 ? `<path class="maxmark" d="M10 ${f1(y(an.hMax))} h32"/>` : '';
  return `<svg viewBox="0 0 66 226" role="img" aria-label="Высота ${fmt(h)} см, предел ${fmt(LIMITS.heightCm)} см">
<rect class="track" x="16" y="${y(25)}" width="20" height="${25 * 8}" rx="4"/>
<rect class="bar${bad ? ' bad' : ''}" x="16" y="${f1(y(h))}" width="20" height="${f1(214 - y(h))}" rx="4"/>
${mx}
<path class="limit" d="M8 ${f1(y(LIMITS.heightCm))} h38"/>
${ticks}
</svg>`;
}
const f1 = (n) => (+n).toFixed(1);

// ---------- разметка панели ----------
const NUM = {
  'wheels.track': { label: 'Колея (между центрами колёс)', unit: 'см', min: 5.6, max: 18, step: 0.1 },
  'wheels.x': { label: 'Ось колёс от центра корпуса (+ вперёд)', unit: 'см', min: -3.4, max: 3.4, step: 0.1 },
  'chassis.extraLength': { label: 'Рама: длиннее корпуса на', unit: 'см', min: 0, max: 20, step: 0.5 },
  'chassis.extraWidth': { label: 'Рама: шире корпуса на', unit: 'см', min: 0, max: 14, step: 0.5 },
  'caster.x': { label: 'Опора от центра корпуса (+ вперёд)', unit: 'см', min: -14, max: 10, step: 0.1 },
  ballast: { label: 'Балласт', unit: 'г', min: 0, max: 400, step: 5 },
  'sensor.x': { label: 'Датчик: вперёд от центра', unit: 'см', min: -6, max: 12, step: 0.1 },
  'sensor.z': { label: 'Датчик: вбок (+ вправо)', unit: 'см', min: -4, max: 4, step: 0.1 },
  'attachment.length': { label: 'Длина руки (ось мотора → голова)', unit: 'см', min: 5, max: 14, step: 0.5 },
};
const idOf = (key) => 'bld-' + key.replace(/\./g, '-');
function numRow(key) {
  const f = NUM[key], id = idOf(key);
  return `<div class="bld-row" data-key="${key}">
  <label for="${id}">${f.label}</label>
  <div class="bld-ctl"><input type="range" id="${id}-r" min="${f.min}" max="${f.max}" step="${f.step}" aria-label="${f.label}, ползунок" tabindex="-1">
  <input type="number" id="${id}" min="${f.min}" max="${f.max}" step="${f.step}" inputmode="decimal"><span class="bld-unit">${f.unit}</span></div>
</div>`;
}

function template() {
  const wheelOpts = Object.entries(WHEELS).map(([k, w]) => `<option value="${k}">${w.name} мм</option>`).join('');
  const attOpts = Object.entries(ATTACHMENTS).map(([k, a]) => `<option value="${k}">${a.name}${a.motor ? '' : ' — без мотора'}</option>`).join('');
  const ratioOpts = RATIOS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  return `<div class="bld">
<div class="bld-head">
  <div class="seg team-seg bld-team" role="group" aria-label="Команда, для которой собираем робота">
    <button type="button" data-side="red" aria-pressed="false"><i class="dot" aria-hidden="true"></i>Красная</button>
    <button type="button" data-side="blue" aria-pressed="false"><i class="dot" aria-hidden="true"></i>Синяя</button>
  </div>
  <label class="field bld-grow"><span>Шаблон</span><select id="bld-preset"></select></label>
</div>
<p class="hint" id="bld-current"></p>
<label class="field"><span>Название робота</span><input id="bld-name" type="text" maxlength="60" autocomplete="off" spellcheck="false"></label>

<section class="bld-card bld-view" aria-label="Превью робота">
  <div class="bld-canvas" id="bld-canvas"></div>
  <div class="bld-viewbar">
    <label for="bld-armprev">Рука</label>
    <input type="range" id="bld-armprev" min="0" max="0" step="1" value="0">
    <output id="bld-armprev-out" for="bld-armprev">0°</output>
    <label class="chk"><input type="checkbox" id="bld-overlay" checked> зона и 20.3 см</label>
    <button type="button" class="link" id="bld-viewreset">вид по умолчанию</button>
  </div>
</section>

<section class="bld-card bld-footcard" aria-labelledby="bld-foot-h">
  <h4 id="bld-foot-h">Старт: вид сверху и высота</h4>
  <div class="bld-footrow"><div class="bld-foot" id="bld-foot"></div><div class="bld-gauge" id="bld-gauge"></div></div>
  <ul class="bld-legend" aria-hidden="true">
    <li><i class="lg-hull"></i>робот</li><li><i class="lg-wheel"></i>колёса</li><li><i class="lg-spin"></i>разворот на месте</li><li><i class="lg-limit"></i>20.3 см</li><li><i class="lg-max"></i>рука вверх</li>
  </ul>
  <p class="hint" id="bld-foot-note"></p>
</section>

<section class="bld-card bld-checkcard" aria-labelledby="bld-check-h">
  <h4 id="bld-check-h">Проверка по правилам Future Edition</h4>
  <ul class="bld-issues" id="bld-issues"></ul>
  <dl class="bld-stats" id="bld-stats"></dl>
  <table class="bld-hw">
    <caption>Железо команды (лимит Rulebook: по 2 каждого вида вместе с полем)</caption>
    <thead><tr><th scope="col">Устройство</th><th scope="col">На роботе</th><th scope="col">Лимит</th><th scope="col">На поле</th></tr></thead>
    <tbody id="bld-hw"></tbody>
  </table>
</section>

<form class="bld-form" id="bld-form" novalidate>
  <fieldset class="bld-card">
    <legend>Ходовая — Double Motor</legend>
    <label class="field"><span>Колёса</span><select id="bld-wheels-size">${wheelOpts}</select></label>
    ${numRow('wheels.track')}${numRow('wheels.x')}
  </fieldset>
  <fieldset class="bld-card">
    <legend>Рама, опора, балласт</legend>
    ${numRow('chassis.extraLength')}${numRow('chassis.extraWidth')}
    <label class="field"><span>Задняя опора</span><select id="bld-caster-type"><option value="ball">Шаровая опора (малое трение)</option><option value="skid">Полоз</option></select></label>
    ${numRow('caster.x')}${numRow('ballast')}
  </fieldset>
  <fieldset class="bld-card">
    <legend>Датчик цвета — Technician tool</legend>
    <label class="chk"><input type="checkbox" id="bld-sensor-on"> Color Sensor на роботе (смотрит вниз)</label>
    ${numRow('sensor.x')}${numRow('sensor.z')}
  </fieldset>
  <fieldset class="bld-card">
    <legend>Навесное — Single Motor</legend>
    <label class="field"><span>Тип</span><select id="bld-att-type">${attOpts}</select></label>
    <div class="bld-motor">
      <label class="field"><span>Передача мотор → рука</span><select id="bld-att-ratio">${ratioOpts}</select></label>
      ${numRow('attachment.length')}
      <label class="field"><span>Крепление</span><select id="bld-att-mount" disabled><option value="front">Спереди (ось над корпусом)</option></select></label>
    </div>
    <p class="hint" id="bld-att-note"></p>
  </fieldset>
</form>

<section class="bld-card bld-files" aria-labelledby="bld-files-h">
  <h4 id="bld-files-h">Сохранить и поделиться</h4>
  <div class="bld-btns">
    <button type="button" class="btn ghost small" id="bld-save">Сохранить в браузере</button>
    <button type="button" class="btn ghost small" id="bld-del" disabled>Удалить сохранённый</button>
    <button type="button" class="btn ghost small" id="bld-export">Экспорт JSON</button>
    <button type="button" class="btn ghost small" id="bld-import">Импорт JSON…</button>
    <input type="file" id="bld-file" accept=".json,application/json" hidden>
  </div>
  <div class="bld-share">
    <button type="button" class="btn ghost small" id="bld-copy">Копировать код</button>
    <input type="text" id="bld-code" placeholder="Вставьте код робота (BGR1.…)" aria-label="Код робота для обмена" autocomplete="off" spellcheck="false">
    <button type="button" class="btn ghost small" id="bld-paste">Загрузить код</button>
  </div>
</section>

<div class="bld-bar" role="region" aria-label="Применить робота">
  <div class="bld-btns">
    <button type="button" class="btn" id="bld-apply">Применить</button>
    <button type="button" class="btn ghost small" id="bld-undo" disabled>↶ Отменить</button>
    <button type="button" class="btn ghost small" id="bld-revert" title="Вернуть черновик к роботу, который сейчас стоит у команды">Как у робота</button>
  </div>
  <p class="bld-note" id="bld-apply-note"></p>
  <p class="bld-status" id="bld-status" role="status" aria-live="polite"></p>
</div>
</div>`;
}

// ---------- установка ----------
export function install(app) {
  const pane = app.ui.panel('builder');
  if (!pane) return null;
  const sim = app.sim;
  pane.innerHTML = template();
  const $ = (id) => pane.querySelector('#' + id);
  const st = {
    side: SIDES.includes(LS.get('side', null)) ? LS.get('side', null) : (SIDES.includes(app.state?.team) ? app.state.team : 'red'),
    draft: {}, undo: { red: [], blue: [] }, committed: {}, known: {}, armPrev: 0, overlay: LS.get('overlay', true) !== false,
  };
  for (const s of SIDES) { st.draft[s] = cloneCfg(sim.robots[s].config); st.committed[s] = cloneCfg(st.draft[s]); st.known[s] = cloneCfg(st.draft[s]); }
  let cur = null;             // результат analyze() для черновика
  let preview = null;
  const offs = [];
  const draft = () => st.draft[st.side];

  // ---------- статус ----------
  let statusT = 0;
  function say(text, kind = '') {
    const el = $('bld-status');
    el.textContent = text;
    el.className = 'bld-status' + (kind ? ' ' + kind : '');
    clearTimeout(statusT);
    if (text && kind !== 'err') statusT = setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 8000);
  }

  // ---------- история (↶) ----------
  function pushUndo(prev) {
    const u = st.undo[st.side];
    if (u.length && sameConfig(u[u.length - 1], prev)) return;
    u.push(cloneCfg(prev));
    if (u.length > 40) u.shift();
  }
  /** Зафиксировать изменение (конец перетаскивания, выбор в списке): прежнее состояние — в историю */
  function commit() {
    const prev = st.committed[st.side];
    if (!sameConfig(prev, draft())) { pushUndo(prev); st.committed[st.side] = cloneCfg(draft()); }
    refresh();
  }
  /** Заменить черновик целиком (шаблон, импорт, код) с записью в историю */
  function replaceDraft(cfg) {
    const before = cloneCfg(draft());
    st.draft[st.side] = cloneCfg(cfg);
    if (!sameConfig(before, st.draft[st.side])) pushUndo(before);
    st.committed[st.side] = cloneCfg(st.draft[st.side]);
    syncForm();
    refresh();
  }
  function undo() {
    const u = st.undo[st.side];
    if (!u.length) return false;
    st.draft[st.side] = u.pop();
    st.committed[st.side] = cloneCfg(st.draft[st.side]);
    syncForm(); refresh();
    say('Изменение отменено.');
    return true;
  }

  // ---------- форма ----------
  const rows = [...pane.querySelectorAll('.bld-row')];
  function setRowValue(key, v) {
    const n = $(idOf(key)), r = $(idOf(key) + '-r');
    if (document.activeElement !== n) n.value = String(+(+v).toFixed(3));
    r.value = String(v);
  }
  function syncForm() {
    const c = draft();
    $('bld-name').value = c.name;
    $('bld-wheels-size').value = c.wheels.size;
    $('bld-caster-type').value = c.caster.type;
    $('bld-sensor-on').checked = c.sensor.enabled;
    $('bld-att-type').value = c.attachment.type;
    const A = ATTACHMENTS[c.attachment.type];
    // длина руки — в пределах своего навесного
    const lr = $(idOf('attachment.length') + '-r'), ln = $(idOf('attachment.length'));
    if (A.motor) { lr.min = ln.min = A.minLen; lr.max = ln.max = A.maxLen; }
    const sel = $('bld-att-ratio');
    if (![...sel.options].some((o) => Math.abs(+o.value - c.attachment.ratio) < 0.01)) sel.add(new Option(`1 : ${fmt(c.attachment.ratio, 2)} — своя`, String(c.attachment.ratio)));
    sel.value = [...sel.options].find((o) => Math.abs(+o.value - c.attachment.ratio) < 0.01).value;
    for (const row of rows) setRowValue(row.dataset.key, getPath(c, row.dataset.key));
    pane.querySelector('.bld-motor').hidden = !A.motor;
    for (const k of ['sensor.x', 'sensor.z']) { $(idOf(k)).disabled = !c.sensor.enabled; $(idOf(k) + '-r').disabled = !c.sensor.enabled; }
    $('bld-att-note').textContent = A.motor
      ? 'Рука на Single Motor (Technician tool). Python: arm = le.SingleMotor(); arm.connect().'
      : (c.attachment.type === 'plow' ? 'Толкатель закреплён на раме, Single Motor не нужен — его можно оставить в коробке.' : 'Без навесного Single Motor не используется.');
  }
  for (const row of rows) {
    const key = row.dataset.key, n = $(idOf(key)), r = $(idOf(key) + '-r');
    r.addEventListener('input', () => { n.value = r.value; setPath(draft(), key, Number(r.value)); schedule(); });
    r.addEventListener('change', commit);
    n.addEventListener('input', () => {
      if (n.value === '' || !Number.isFinite(Number(n.value))) return;
      r.value = n.value; setPath(draft(), key, Number(n.value)); schedule();
    });
    n.addEventListener('change', () => {
      if (n.value === '' || !Number.isFinite(Number(n.value))) n.value = String(getPath(draft(), key));
      commit();
    });
  }
  $('bld-name').addEventListener('input', (e) => { draft().name = e.target.value.slice(0, 60) || 'Мой робот'; schedule(); });
  $('bld-name').addEventListener('change', commit);
  $('bld-wheels-size').addEventListener('change', (e) => {
    const c = draft(); c.wheels.size = e.target.value;
    const min = +(HOUSING.W + WHEELS[c.wheels.size].w + 0.2).toFixed(1);
    if (c.wheels.track < min) { c.wheels.track = min; say(`Колея увеличена до ${fmt(min)} см, чтобы колёса не задевали корпус.`); }
    syncForm(); commit();
  });
  $('bld-caster-type').addEventListener('change', (e) => { draft().caster.type = e.target.value; commit(); });
  $('bld-sensor-on').addEventListener('change', (e) => { draft().sensor.enabled = e.target.checked; syncForm(); commit(); });
  $('bld-att-type').addEventListener('change', (e) => {
    const type = e.target.value, A = ATTACHMENTS[type];
    draft().attachment = { type, ratio: A.motor ? A.ratio : 1, length: A.motor ? A.length : 0, mount: 'front' };
    st.armPrev = 0;
    syncForm(); commit();
  });
  $('bld-att-ratio').addEventListener('change', (e) => { draft().attachment.ratio = Number(e.target.value); commit(); });
  $('bld-form').addEventListener('submit', (e) => e.preventDefault());

  // ---------- команда и шаблоны ----------
  function setSide(side, persist = true) {
    if (!SIDES.includes(side)) return false;
    st.side = side;
    if (persist) LS.set('side', side);
    pane.querySelectorAll('.bld-team button').forEach((b) => { const on = b.dataset.side === side; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    syncForm(); refresh();
    return true;
  }
  pane.querySelectorAll('.bld-team button').forEach((b) => b.addEventListener('click', () => setSide(b.dataset.side)));

  const saved = () => { const o = LS.get('saved', {}); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; };
  function fillPresets() {
    const sel = $('bld-preset');
    const prev = sel.value;
    sel.innerHTML = '';
    sel.add(new Option('— свой робот —', 'custom'));
    const g1 = document.createElement('optgroup'); g1.label = 'Готовые роботы';
    for (const p of ALL_PRESETS) g1.appendChild(new Option(p.name, 'p:' + p.id));
    sel.appendChild(g1);
    const names = Object.keys(saved()).sort((a, b) => a.localeCompare(b, 'ru'));
    if (names.length) {
      const g2 = document.createElement('optgroup'); g2.label = 'Сохранённые в браузере';
      for (const n of names) g2.appendChild(new Option(n, 's:' + n));
      sel.appendChild(g2);
    }
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
  function matchPreset(c) {
    const s = saved();
    for (const [n, cfg] of Object.entries(s)) if (sameConfig(cfg, c)) return 's:' + n;
    for (const p of ALL_PRESETS) if (sameConfig(p, c)) return 'p:' + p.id;
    return 'custom';
  }
  function loadPreset(value) {
    if (value.startsWith('p:')) {
      const p = ALL_PRESETS.find((x) => x.id === value.slice(2));
      if (!p) return false;
      replaceDraft(p); say(`Шаблон «${p.name}» загружен — нажмите «Применить», чтобы пересобрать робота.`);
      return true;
    }
    if (value.startsWith('s:')) {
      const name = value.slice(2), c = saved()[name];
      if (!c) { say('Сохранённый робот не найден.', 'err'); fillPresets(); return false; }
      replaceDraft({ ...c, name }); say(`Загружен сохранённый робот «${name}».`);
      return true;
    }
    return false;
  }
  $('bld-preset').addEventListener('change', (e) => loadPreset(e.target.value));

  // ---------- сохранение, экспорт, импорт, код ----------
  function saveCurrent(nameIn) {
    const name = String(nameIn || draft().name || 'Мой робот').trim().slice(0, 60) || 'Мой робот';
    const all = saved(), existed = name in all;
    if (!existed && Object.keys(all).length >= 50) { say('Сохранено уже 50 роботов — удалите лишние.', 'err'); return false; }
    all[name] = { ...cloneCfg(draft()), name };
    if (!LS.set('saved', all)) { say('Браузер не дал сохранить (приватный режим или нет места). Используйте «Экспорт JSON».', 'err'); return false; }
    draft().name = name;
    fillPresets(); syncForm(); refresh();
    say(existed ? `Робот «${name}» перезаписан в браузере.` : `Робот «${name}» сохранён в браузере.`, 'ok');
    return true;
  }
  let delArm = 0;
  function removeSaved(name) {
    const all = saved();
    if (!(name in all)) return false;
    delete all[name];
    if (!LS.set('saved', all)) { say('Браузер не дал изменить сохранённые конфигурации.', 'err'); return false; }
    fillPresets(); refresh();
    say(`Сохранённый робот «${name}» удалён.`);
    return true;
  }
  $('bld-save').addEventListener('click', () => saveCurrent());
  $('bld-del').addEventListener('click', (e) => {
    const v = $('bld-preset').value;
    if (!v.startsWith('s:')) return;
    const btn = e.currentTarget;
    if (!delArm) { // двойное нажатие вместо модального confirm
      btn.textContent = 'Точно удалить?'; btn.classList.add('warn');
      delArm = setTimeout(() => { delArm = 0; btn.textContent = 'Удалить сохранённый'; btn.classList.remove('warn'); }, 4000);
      return;
    }
    clearTimeout(delArm); delArm = 0; btn.textContent = 'Удалить сохранённый'; btn.classList.remove('warn');
    removeSaved(v.slice(2));
  });

  function importCfg(raw, from) {
    const pre = validateConfig(raw);
    const notes = pre.errors.filter((m) => m.startsWith('Неизвестн'));
    replaceDraft(raw);
    const an = cur;
    const msg = `${from}: «${draft().name}». ` + (notes.length ? notes.join(' ') + ' Заменено на значения по умолчанию. ' : '')
      + (an.v.ok ? 'Ошибок нет — можно применять.' : `Ошибок: ${an.v.errors.length}, см. «Проверка».`);
    say(msg, an.v.ok && !notes.length ? 'ok' : 'warn');
    return an.v.ok;
  }
  function importText(text) {
    try { return importCfg(parseConfigText(text), 'Импорт'); } catch (e) { say('Импорт не удался: ' + e.message, 'err'); return null; }
  }
  function loadShareCode(code) {
    try { return importCfg(decodeShare(code), 'Код загружен'); } catch (e) { say('Код не загружен: ' + e.message, 'err'); return null; }
  }
  $('bld-export').addEventListener('click', () => {
    const text = exportText(draft());
    const safe = (draft().name || 'robot').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'robot';
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = `bioglow-robot-${safe}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      say(`Файл bioglow-robot-${safe}.json сохранён в загрузки.`, 'ok');
    } catch (e) { say('Не удалось сохранить файл: ' + e.message, 'err'); }
  });
  $('bld-import').addEventListener('click', () => $('bld-file').click());
  $('bld-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 200000) { say('Файл слишком большой для конфигурации робота.', 'err'); return; }
    try { importText(await f.text()); } catch (err) { say('Файл не прочитан: ' + err.message, 'err'); }
  });
  $('bld-copy').addEventListener('click', async () => {
    const code = encodeShare(draft()), inp = $('bld-code');
    inp.value = code;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('нет доступа');
      await navigator.clipboard.writeText(code);
      say(`Код робота скопирован (${code.length} символов). Вставьте его другу в поле «Код робота».`, 'ok');
    } catch {
      inp.focus(); inp.select();
      say('Буфер обмена недоступен — код выделен в поле, скопируйте его Ctrl+C.', 'warn');
    }
  });
  $('bld-paste').addEventListener('click', () => loadShareCode($('bld-code').value));
  $('bld-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadShareCode(e.target.value); } });

  // ---------- применение ----------
  /** Можно ли сейчас пересобрать робота команды -> { ok, force, why } */
  function applyState(side = st.side, an = cur) {
    if (!app.stepAuthority) {
      // онлайн-гость своей команды: конфигурация уходит хосту, он пересобирает робота по тем же правилам
      const net = app.net;
      const mine = !!(net && net.isGuest && net.online && net.role === side && typeof net.requestRobot === 'function');
      if (!mine && net && net.isGuest && SIDES.includes(net.role) && net.role !== side) return { ok: false, why: `Онлайн: вы играете за ${net.role === 'red' ? 'красных' : 'синих'} — переключите конструктор на свою команду.` };
      if (!mine) return { ok: false, why: 'Онлайн, вы гость: робота пересобирает хост. Передайте ему код робота («Копировать код»).' };
      if (!an.v.ok) return { ok: false, why: `Ошибок: ${an.v.errors.length}. С ними робот не пройдёт проверку перед матчем — исправьте параметры.` };
      return { ok: true, remote: true, why: 'Онлайн: робот уйдёт хосту — он пересоберёт его (во время матча — только если робот целиком в зоне Technician).' };
    }
    if (!an.v.ok) return { ok: false, why: `Ошибок: ${an.v.errors.length}. С ними робот не пройдёт проверку перед матчем — исправьте параметры.` };
    let inArea = false;
    try { inArea = !!sim.inspect(side).inArea; } catch { inArea = false; }
    const prog = app.runners && app.runners[side] && app.runners[side].running ? ' Программа команды будет остановлена.' : '';
    if (app.matchLocked()) {
      if (!inArea) return { ok: false, why: 'Идёт матч: Technician меняет робота, только когда тот целиком в зоне Technician. Верните робота (Courtesy rule) или дождитесь его.' };
      return { ok: true, force: false, why: 'Робот целиком в зоне Technician — модификация по правилам разрешена.' + prog };
    }
    return { ok: true, force: true, why: (inArea ? 'Робот останется на своём месте в зоне Technician.' : 'Робот вне зоны Technician — после сборки он встанет на старт.') + prog };
  }
  function apply() {
    const side = st.side, an = analyze(draft());
    const s = applyState(side, an);
    if (!s.ok) { say(s.why, 'err'); refreshApply(); return { ok: false, errors: an.v.errors, why: s.why }; }
    if (s.remote) {
      const sent = app.net.requestRobot(an.v.cfg);
      say(sent ? `Робот «${an.v.cfg.name}» отправлен хосту — ответ придёт в консоль команды.` : 'Нет связи с хостом — робот не отправлен.', sent ? 'ok' : 'err');
      return { ok: !!sent, remote: true, cfg: an.v.cfg };
    }
    const locked = app.matchLocked();
    let res;
    try { res = app.setRobotConfig(side, an.v.cfg, { force: s.force }); } catch (e) { app.ui.showError(e, 'Конструктор'); say('Ошибка при сборке робота: ' + e.message, 'err'); return { ok: false, errors: [e.message] }; }
    if (!res || !res.ok) {
      const errs = (res && res.errors) || ['Робот не пересобран.'];
      say('Не применено: ' + errs.join(' '), 'err');
      refreshApply();
      return { ok: false, errors: errs };
    }
    const b = res.bbox || an.v.bbox;
    app.log(side, `${locked ? 'Technician изменил робота' : 'Конструктор: новый робот'} «${an.v.cfg.name}» (${fmt(b.lengthCm)} × ${fmt(b.widthCm)} × ${fmt(b.heightCm)} см)`, null);
    say(`Робот ${TEAM[side].gen} команды пересобран: «${an.v.cfg.name}», ${fmt(b.lengthCm)} × ${fmt(b.widthCm)} × ${fmt(b.heightCm)} см, ${fmt(res.massKg ?? an.v.massKg, 2)} кг.`, 'ok');
    refresh();
    return { ok: true, cfg: res.cfg || an.v.cfg };
  }
  $('bld-apply').addEventListener('click', () => apply());
  $('bld-undo').addEventListener('click', () => undo());
  $('bld-revert').addEventListener('click', () => {
    replaceDraft(sim.robots[st.side].config);
    say(`Черновик совпадает с роботом ${TEAM[st.side].gen} команды.`);
  });

  // ---------- превью ----------
  function ensurePreview() {
    if (preview || !pane.classList.contains('on')) return;
    preview = new Preview($('bld-canvas'));
    preview.setOverlay(st.overlay);
    updatePreview();
  }
  function updatePreview() {
    if (!preview || !cur) return;
    preview.setModel(draft(), st.side, st.armPrev);
  }
  $('bld-armprev').addEventListener('input', (e) => {
    st.armPrev = Number(e.target.value);
    $('bld-armprev-out').textContent = `${st.armPrev}°`;
    updatePreview();
  });
  $('bld-overlay').checked = st.overlay;
  $('bld-overlay').addEventListener('change', (e) => { st.overlay = e.target.checked; LS.set('overlay', st.overlay); if (preview) preview.setOverlay(st.overlay); });
  $('bld-viewreset').addEventListener('click', () => { if (preview) { preview.resetView(); updatePreview(); } });
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const onTheme = () => { if (preview) preview.theme(); };
  if (mq) { if (mq.addEventListener) mq.addEventListener('change', onTheme); else if (mq.addListener) mq.addListener(onTheme); }
  if (window.ResizeObserver) new ResizeObserver(() => { if (preview) preview.request(); }).observe($('bld-canvas'));

  // ---------- обновление панели ----------
  let sched = 0;
  function schedule() {
    if (sched) return;
    sched = requestAnimationFrame(() => { sched = 0; refresh(); });
    // в фоновой вкладке кадров нет — досчитаем по таймеру
    setTimeout(() => { if (sched) { cancelAnimationFrame(sched); sched = 0; refresh(); } }, 120);
  }
  function refresh() {
    const c = draft();
    cur = analyze(c);
    const an = cur, v = an.v, side = st.side;
    // текущий робот команды
    const rc = sim.robots[side].config, dirty = !sameConfig(rc, c);
    const rb = validateConfig(rc).bbox;
    $('bld-current').textContent = `Сейчас у ${TEAM[side].gen} команды: «${rc.name}», ${fmt(rb.lengthCm)} × ${fmt(rb.widthCm)} × ${fmt(rb.heightCm)} см.` + (dirty ? ' Черновик отличается — нажмите «Применить».' : ' Черновик совпадает.');
    $('bld-current').classList.toggle('dirty', dirty);
    $('bld-preset').value = matchPreset(c);
    $('bld-del').disabled = !$('bld-preset').value.startsWith('s:');
    $('bld-undo').disabled = !st.undo[side].length;
    // рука в превью
    const ar = $('bld-armprev');
    if (an.arm) { ar.disabled = false; ar.min = an.arm.minDeg; ar.max = an.arm.maxDeg; st.armPrev = clamp(st.armPrev, an.arm.minDeg, an.arm.maxDeg); } else { ar.disabled = true; ar.min = 0; ar.max = 0; st.armPrev = 0; }
    ar.value = st.armPrev; $('bld-armprev-out').textContent = `${st.armPrev}°`;
    // след и высота
    $('bld-foot').innerHTML = footprintSVG(an);
    $('bld-gauge').innerHTML = gaugeSVG(an);
    const notes = [];
    notes.push(an.fitsStart ? 'На старте робот целиком в зоне Technician.' : 'На старте робот выходит за зону Technician: проверка перед матчем не пройдёт — укоротите робота или сдвиньте детали.');
    notes.push(`Разворот на месте: радиус ${fmt(an.spinR)} см — ${an.spinWall ? 'у старта не задевает борт.' : `у старта заденет борт (до борта ${fmt(AREA.sy / 10)} см): сначала выезжайте вперёд.`}`);
    if (an.arm && an.hMax > v.bbox.heightCm + 0.05) notes.push(`С поднятой рукой (${an.hMaxDeg}°) высота ${fmt(an.hMax)} см${an.hMax > LIMITS.heightCm ? ' — на старте держите руку внизу' : ''}.`);
    $('bld-foot-note').textContent = notes.join(' ');
    // ошибки и предупреждения
    const ul = $('bld-issues');
    ul.textContent = '';
    const li = (text, cls) => { const e = document.createElement('li'); e.className = cls; e.textContent = text; ul.appendChild(e); };
    for (const e of v.errors) li(e, 'err');
    if (!an.fitsStart) li('В стартовой точке робот не помещается в зону Technician — поставьте его мышью при подготовке к матчу.', 'warn');
    for (const w of v.warnings) li(w, 'warn');
    if (!v.errors.length && !v.warnings.length && an.fitsStart) li('Ошибок и замечаний нет: робот проходит проверку.', 'ok');
    // характеристики
    const stats = [
      ['Масса', `${fmt(v.massKg, 3)} кг`],
      ['Габарит Д × Ш × В', `${fmt(v.bbox.lengthCm)} × ${fmt(v.bbox.widthCm)} × ${fmt(v.bbox.heightCm)} см`],
      ['Клиренс корпуса', `${fmt(an.geo.hc - HOUSING.H / 2)} см`],
      ['Центр масс', `${fmt(v.comX)} см от центра корпуса`],
      ['Скорость на 100 %', `≈ ${fmt(an.speed, 0)} см/с`],
      ['Радиус разворота', `${fmt(an.spinR)} см`],
    ];
    if (an.arm) {
      stats.push(['Рука: ход', `${an.arm.minDeg}…${an.arm.maxDeg}°, длина ${fmt(an.arm.lengthCm)} см`]);
      stats.push(['Рука: момент / скорость', `≈ ${fmt(an.arm.torqueNcm, 0)} Н·см / ${fmt(an.arm.degS, 0)} °/с`]);
    }
    const dl = $('bld-stats');
    dl.textContent = '';
    for (const [k, val] of stats) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = val; dl.append(dt, dd); }
    // железо
    const hw = an.hw, tb = $('bld-hw');
    const rowsHw = [
      ['Double Motor', `${hw.doubleMotors} — ходовая`, '1', 'Grand Tree', hw.doubleMotors === 1],
      ['Single Motor', hw.singleMotors ? '1 — рука' : '0', '≤ 1', 'Hive', hw.singleMotors <= 1],
      ['Color Sensor', hw.colorSensors ? '1 — вниз' : '0', '≤ 1', 'Young Forest', hw.colorSensors <= 1],
      ['Controller', 'в руках', '≤ 2', 'Driver, Specialist', true],
    ];
    tb.textContent = '';
    for (const [name, on, lim, field, ok] of rowsHw) {
      const tr = document.createElement('tr');
      if (!ok) tr.className = 'bad';
      for (const [i, t] of [name, on, lim, field].entries()) { const td = document.createElement(i ? 'td' : 'th'); if (!i) td.scope = 'row'; td.textContent = t; tr.appendChild(td); }
      tb.appendChild(tr);
    }
    const tr = document.createElement('tr'); tr.className = 'sum';
    const td = document.createElement('td'); td.colSpan = 4;
    td.textContent = `Всего у команды: 2 Double Motor, ${hw.singleMotors + 1} Single Motor, ${hw.colorSensors + 1} Color Sensor, до 2 пультов — в пределах лимита 2 / 2 / 2 / 2.`;
    tr.appendChild(td); tb.appendChild(tr);
    // кнопка «Применить»
    $('bld-apply').textContent = `Применить к ${TEAM[side].gen}`;
    refreshApply();
    updatePreview();
  }
  function refreshApply() {
    if (!cur) return;
    const s = applyState();
    $('bld-apply').disabled = !s.ok;
    const note = $('bld-apply-note');
    note.textContent = s.why;
    note.className = 'bld-note' + (s.ok ? '' : ' err');
  }

  // ---------- события приложения ----------
  offs.push(app.on('robotConfig', (side) => {
    // робота поменяли извне (вкладка «Миссии», онлайн): черновик без правок подтягиваем, правки не трогаем
    if (!SIDES.includes(side)) return;
    const now = cloneCfg(sim.robots[side].config);
    if (sameConfig(st.draft[side], st.known[side]) && !sameConfig(st.draft[side], now)) {
      st.draft[side] = cloneCfg(now); st.committed[side] = cloneCfg(now);
      if (side === st.side) syncForm();
    }
    st.known[side] = now;
    if (side === st.side) refresh();
  }));
  offs.push(app.on('tab', (id) => { if (id === 'builder') { ensurePreview(); refresh(); if (preview) preview.request(); } }));
  // онлайн-гость команды: конструктор сам переключается на свою команду (локальный выбор в LS не трогаем),
  // после выхода из комнаты возвращается на выбранную раньше команду
  let guestRole = null;
  function syncGuestSide() {
    const net = app.net;
    const role = net && net.isGuest && SIDES.includes(net.role) ? net.role : null;
    if (role === guestRole) return;
    const was = guestRole;
    guestRole = role;
    if (role) {
      if (st.side !== role) setSide(role, false);
      say(`Онлайн: вы играете за ${role === 'red' ? 'красных' : 'синих'} — конструктор переключён на робота своей команды. «Применить» отправит его хосту.`);
    } else if (was) {
      const own = LS.get('side', null);
      if (SIDES.includes(own) && own !== st.side) setSide(own, false);
    }
  }
  for (const ev of ['net', 'authority', 'team']) offs.push(app.on(ev, () => { try { syncGuestSide(); } catch (e) { app.ui.showError(e, 'Конструктор'); } }));
  for (const ev of ['mode', 'matchStart', 'matchEnd', 'authority', 'programState', 'reset', 'net']) offs.push(app.on(ev, () => refreshApply()));
  let lastPoll = 0;
  offs.push(app.on('frame', () => {
    // пока вкладка открыта — следим, в зоне ли робот (кнопка «Применить» во время матча)
    if (!pane.classList.contains('on')) return;
    const now = performance.now();
    if (now - lastPoll < 300) return;
    lastPoll = now;
    refreshApply();
  }));

  // ---------- старт ----------
  fillPresets();
  setSide(st.side, false);
  syncGuestSide();
  ensurePreview();

  const api = {
    get side() { return st.side; },
    setSide,
    getDraft: () => cloneCfg(draft()),
    setDraft: (cfg) => { replaceDraft(cfg); return cur; },
    analysis: () => cur,
    presets: () => ALL_PRESETS.map((p) => ({ id: p.id, name: p.name })),
    loadPreset: (id) => loadPreset('p:' + id),
    applyState: () => applyState(),
    apply,
    undo,
    exportText: () => exportText(draft()),
    importText,
    shareCode: () => encodeShare(draft()),
    loadShareCode,
    save: saveCurrent,
    load: (name) => loadPreset('s:' + name),
    remove: removeSaved,
    savedNames: () => Object.keys(saved()),
    render: () => { ensurePreview(); updatePreview(); return preview ? preview.render() : false; },
    preview: () => preview,
    dispose() { for (const o of offs) o(); if (preview) preview.dispose(); preview = null; if (mq && mq.removeEventListener) mq.removeEventListener('change', onTheme); },
  };
  app.builder = api;
  return api;
}
