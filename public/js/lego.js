// Простые «LEGO-подобные» детали для моделей: брикеты со шипами, кольца, листва.
// Все размеры в сантиметрах (1 шип = 0.8 см).
import * as THREE from 'three';

export const C = {
  brown: 0x6b3a22, darkBrown: 0x3f2416, tan: 0xd8bf8a, darkTan: 0x9b8659,
  lime: 0xa6c91e, green: 0x2f8f3d, darkGreen: 0x1d5c2b, sand: 0x7aa36a,
  lightGrey: 0xa4a8ab, darkGrey: 0x5f6367, white: 0xf3f4f2, black: 0x1c1c1c,
  azure: 0x34a9d6, teal: 0x13a3a6, yellow: 0xf6c21a, red: 0xc72a1f, blue: 0x1662b5, orange: 0xe8811c,
};

const mats = new Map();
export function mat(color, { opacity = 1, emissive = 0, rough = 0.42 } = {}) {
  const key = `${color}|${opacity}|${emissive}|${rough}`;
  if (!mats.has(key)) {
    mats.set(key, new THREE.MeshStandardMaterial({
      color, roughness: rough, metalness: 0.02,
      transparent: opacity < 1, opacity, emissive, emissiveIntensity: emissive ? 0.6 : 0,
    }));
  }
  return mats.get(key);
}

const studGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.18, 12);
const boxGeoCache = new Map();
function boxGeo(w, h, d) {
  const k = `${w}|${h}|${d}`;
  if (!boxGeoCache.has(k)) boxGeoCache.set(k, new THREE.BoxGeometry(w, h, d));
  return boxGeoCache.get(k);
}

function shadowed(o) { o.castShadow = true; o.receiveShadow = true; return o; }

/**
 * Брикет. Возвращает Object3D. center = центр брикета.
 * opts: studs (шипы сверху), rx/ry/rz (рад), opacity,
 *       ownGeo — массив: геометрия создаётся отдельно (не в общем кэше) и кладётся туда; владелец сам
 *       вызывает dispose() (детали робота из конструктора — размеры меняются, кэш рос бы без конца).
 */
export function brick(w, h, d, color, x = 0, y = 0, z = 0, opts = {}) {
  const g = new THREE.Group();
  let geo;
  if (opts.ownGeo) { geo = new THREE.BoxGeometry(w, h, d); opts.ownGeo.push(geo); } else geo = boxGeo(w, h, d);
  const m = shadowed(new THREE.Mesh(geo, mat(color, opts)));
  g.add(m);
  if (opts.studs && w >= 0.7 && d >= 0.7) {
    const nx = Math.max(1, Math.round(w / 0.8)), nz = Math.max(1, Math.round(d / 0.8));
    const inst = new THREE.InstancedMesh(studGeo, mat(color, opts), nx * nz);
    const tmp = new THREE.Object3D();
    let i = 0;
    for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
      tmp.position.set((a - (nx - 1) / 2) * 0.8, h / 2 + 0.09, (b - (nz - 1) / 2) * 0.8);
      tmp.updateMatrix(); inst.setMatrixAt(i++, tmp.matrix);
    }
    inst.castShadow = true; inst.receiveShadow = true;
    g.add(inst);
  }
  g.position.set(x, y, z);
  g.rotation.set(opts.rx || 0, opts.ry || 0, opts.rz || 0);
  return g;
}

/** Кольцо-микробиом (как на моделях Future Edition): лаймовый «бублик» с дном. y = низ кольца. */
export function ringMesh(rIn, rOut, h, color = C.lime, floorColor = C.brown) {
  const g = new THREE.Group();
  const pts = [
    new THREE.Vector2(rIn, 0), new THREE.Vector2(rOut, 0),
    new THREE.Vector2(rOut + 0.25, h * 0.55), new THREE.Vector2(rOut, h),
    new THREE.Vector2(rIn + 0.2, h), new THREE.Vector2(rIn, h * 0.6), new THREE.Vector2(rIn, 0),
  ];
  const lathe = shadowed(new THREE.Mesh(new THREE.LatheGeometry(pts, 28), mat(color)));
  g.add(lathe);
  const floor = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(rIn + 0.05, rIn + 0.05, 0.3, 24), mat(floorColor)));
  floor.position.y = 0.15;
  g.add(floor);
  return g;
}

/** Листва: облако зелёных «пластин» (как ветки-листья LEGO). */
export function foliage(radius, count, seed = 1, colors = [C.green, C.darkGreen, C.lime]) {
  let s = seed;
  const R = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const g = new THREE.Group();
  const geo = new THREE.IcosahedronGeometry(1, 0);
  for (let i = 0; i < count; i++) {
    const m = shadowed(new THREE.Mesh(geo, mat(colors[(R() * colors.length) | 0], { rough: 0.6 })));
    const a = R() * Math.PI * 2, d = R() * radius;
    m.position.set(Math.cos(a) * d, (R() - 0.3) * radius * 0.45, Math.sin(a) * d);
    const sc = 0.9 + R() * 1.4;
    m.scale.set(sc, sc * 0.45, sc);
    m.rotation.set(R(), R() * 3, R());
    g.add(m);
  }
  return g;
}

/** Описание коллайдеров (в локальной системе модели). */
export const P = {
  box: (w, h, d, x, y, z, ry = 0, extra = {}) => ({ shape: 'box', w, h, d, x, y, z, ry, ...extra }),
  cyl: (r, h, x, y, z) => ({ shape: 'cyl', r, h, x, y, z }),
  /** Кольцо из сегментов + дно. y0 = низ кольца. */
  ring(rIn, rOut, h, x, y0, z, segs = 14, floor = true) {
    const out = [];
    const rm = (rIn + rOut) / 2, t = rOut - rIn;
    const len = (2 * Math.PI * rm / segs) * 1.12;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      out.push(P.box(t, h, len, x + Math.cos(a) * rm, y0 + h / 2, z + Math.sin(a) * rm, -a));
    }
    if (floor) out.push(P.cyl(rIn + 0.1, 0.3, x, y0 + 0.15, z));
    return out;
  },
};
