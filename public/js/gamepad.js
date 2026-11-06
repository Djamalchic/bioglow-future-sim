// Геймпады (Gamepad API) -> частичный TeamInput по назначению «геймпад -> команда / роль».
// Опрос каждый кадр: navigator.getGamepads() (объект Gamepad — снимок, между кадрами не храним).
// Стандартная раскладка W3C, радиальная мёртвая зона 0.12 с перемасштабированием, кривая отклика.
//
// Driver (без программы): левый стик Y — вперёд/назад, правый стик X — поворот (или «аркада»: всё на левом),
//   RT/LT — рука вверх/вниз (только в тренировке: в матче пульт Driver не управляет инструментом Technician,
//   правило 14; руку двигает программа на устройстве Specialist, правило 18), LB — медленно, крестовина — точная езда.
// Specialist (без программы): RT/LT или левый стик Y — мотор Grand Tree, A — Token Recycler.
// Обе роли: Start — запустить/остановить программу команды, Back/Select — вернуть вид камеры, RB — следующая камера.
// С работающей программой оси Y левого/правого стика — рычаги пульта своей роли (leftPercent / rightPercent).
// Вибрация: старт и конец матча, упор (мотор STALLED, робот упёрся, рука в упоре).

export const MAX_PADS = 4;
export const DEADZONE = 0.12;
export const TRIGGER_DZ = 0.05;
export const ROLES = ['driver', 'specialist', 'off'];
export const TEAMS = ['auto', 'other', 'red', 'blue'];
export const DRIVES = ['split', 'arcade'];
const CAMS = ['3d', 'top', 'base', 'follow'];
const STALL_T = 0.5;        // с — «упор» дольше этого -> вибрация
const STALL_COOL = 1.5;     // с — пауза между вибрациями упора
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fin = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const wrapPi = (a) => { a = fin(a); while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

/** Радиальная мёртвая зона: |v| < dz -> 0, дальше плавно 0..1 (без «ступеньки» на краю зоны) */
export function radialDeadzone(x, y, dz = DEADZONE) {
  x = clamp(fin(x), -1, 1); y = clamp(fin(y), -1, 1);
  const m = Math.hypot(x, y);
  if (m < dz || m === 0) return [0, 0];
  const s = Math.min(1, (m - dz) / (1 - dz)) / m;
  return [x * s, y * s];
}
/** Мёртвая зона курка 0..1 */
export function triggerDeadzone(v, dz = TRIGGER_DZ) {
  v = clamp(fin(v), 0, 1);
  return v < dz ? 0 : Math.min(1, (v - dz) / (1 - dz));
}
/** Кривая отклика: мягче у нуля, 1 -> 1 (k = 0 — линейная) */
export function curve(v, k = 0.6) {
  v = clamp(fin(v), -1, 1);
  return v * ((1 - k) + k * Math.abs(v));
}

// стандартная раскладка W3C
export const BTN = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9, ls: 10, rs: 11, up: 12, down: 13, left: 14, right: 15 };
// xpad без mapping='standard' (Firefox на Linux и др.): курки — оси 2/5 (покой −1), правый стик — 3/4, крестовина — оси 6/7
const BTN_AX6 = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, back: 6, start: 7, ls: 9, rs: 10 };
const BTN_KEYS = ['a', 'b', 'x', 'y', 'lb', 'rb', 'back', 'start', 'ls', 'rs', 'up', 'down', 'left', 'right'];

// кнопка: объект GamepadButton или число (старые реализации)
function btnValue(b) {
  if (b === null || b === undefined) return 0;
  if (typeof b === 'number') return clamp(fin(b), 0, 1);
  const v = fin(b.value);
  if (v > 0) return clamp(v, 0, 1);
  return b.pressed ? 1 : 0;
}
function btnPressed(b) {
  if (b === null || b === undefined) return false;
  if (typeof b === 'number') return b > 0.5;
  return !!b.pressed || fin(b.value) > 0.5;
}

/** Прочитать снимок геймпада. slot — состояние слота (запоминает угаданную раскладку). */
export function readPad(gp, slot = {}) {
  const axes = (gp && gp.axes) || [], buttons = (gp && gp.buttons) || [];
  const ax = (i) => clamp(fin(axes[i]), -1, 1);
  let layout = 'standard';
  if (gp && gp.mapping !== 'standard') {
    // курки на осях узнаём по покою −1 у осей 2 и 5 одновременно
    if (axes.length >= 6 && ax(2) <= -0.9 && ax(5) <= -0.9) slot.trigAxes = true;
    layout = slot.trigAxes ? 'axes6' : 'generic';
  }
  let rx, ry, lt, rt, B;
  if (layout === 'axes6') {
    rx = ax(3); ry = ax(4); lt = (ax(2) + 1) / 2; rt = (ax(5) + 1) / 2; B = BTN_AX6;
  } else {
    rx = ax(2); ry = ax(3); lt = btnValue(buttons[BTN.lt]); rt = btnValue(buttons[BTN.rt]); B = BTN;
  }
  const b = {};
  for (const k of BTN_KEYS) b[k] = B[k] !== undefined ? btnPressed(buttons[B[k]]) : false;
  if (layout === 'axes6' && axes.length >= 8) { b.left = ax(6) < -0.5; b.right = ax(6) > 0.5; b.up = ax(7) < -0.5; b.down = ax(7) > 0.5; }
  const [lx, ly] = radialDeadzone(ax(0), ax(1));
  const [rx2, ry2] = radialDeadzone(rx, ry);
  return { layout, lx, ly, rx: rx2, ry: ry2, lt: triggerDeadzone(lt), rt: triggerDeadzone(rt), b };
}

/** Пустой частичный ввод */
function blank() {
  return { drive: { fwd: 0, turn: 0 }, arm: 0, tree: 0, recycle: false, slow: false, levers: { driver: [0, 0], specialist: [0, 0] } };
}

/**
 * Ввод одной роли из состояния геймпада. prog — программа команды работает (стики -> рычаги пульта).
 * opts.arm === false — пульт Driver не двигает руку (матч, правило 14): рука = 0, а нажатый курок
 * отмечается флагом _armDenied (подсказка игроку).
 * Возвращает частичный TeamInput (с _levers: true в режиме программы).
 */
export function mapPad(st, cfg, prog, opts = {}) {
  const p = blank();
  if (!st || !cfg || cfg.role === 'off') return p;
  if (prog) {
    // рычаги пульта роли: вверх = +100 %
    p.levers[cfg.role] = [Math.round(-st.ly * 1000) / 10, Math.round(-st.ry * 1000) / 10];
    p._levers = true;
    return p;
  }
  if (cfg.role === 'driver') {
    const arcade = cfg.drive === 'arcade';
    let fwd = curve(-st.ly), turn = curve(-(arcade ? st.lx : st.rx));
    const dF = (st.b.up ? 1 : 0) - (st.b.down ? 1 : 0), dT = (st.b.left ? 1 : 0) - (st.b.right ? 1 : 0);
    if (dF || dT) { fwd += dF; turn += dT; p.slow = true; } // крестовина — точная езда
    p.drive.fwd = clamp(fwd, -1, 1); p.drive.turn = clamp(turn, -1, 1);
    let arm = curve(st.rt) - curve(st.lt);
    if (arcade) arm += curve(-st.ry); // в «аркаде» правый стик свободен — тоже рука
    arm = clamp(arm, -1, 1);
    if (opts && opts.arm === false) { if (arm) p._armDenied = true; } // мотор Technician — не инструмент Driver
    else p.arm = arm;
    if (st.b.lb) p.slow = true;
  } else if (cfg.role === 'specialist') {
    p.tree = clamp(st.rt - st.lt + curve(-st.ly), -1, 1);
  }
  return p;
}

// сложить частичные вводы нескольких геймпадов одной команды
function mergeLocal(dst, p) {
  dst.drive.fwd += p.drive.fwd; dst.drive.turn += p.drive.turn;
  dst.arm += p.arm; dst.tree += p.tree;
  if (p.recycle) dst.recycle = true;
  if (p.slow) dst.slow = true;
  for (const r of ['driver', 'specialist']) { dst.levers[r][0] += p.levers[r][0]; dst.levers[r][1] += p.levers[r][1]; }
  if (p._levers) dst._levers = true;
  if (p._armDenied) dst._armDenied = true;
  return dst;
}

/** Назначение по умолчанию: 1 — Driver команды из шапки, 2 — её Specialist, 3/4 — другая команда */
export function defaultPadConfig(i) {
  const d = [
    { team: 'auto', role: 'driver', drive: 'split' },
    { team: 'auto', role: 'specialist', drive: 'split' },
    { team: 'other', role: 'driver', drive: 'split' },
    { team: 'other', role: 'specialist', drive: 'split' },
  ];
  return { ...(d[i] || d[0]) };
}
export function normalizePadConfig(c, i) {
  const d = defaultPadConfig(i);
  if (!c || typeof c !== 'object') return d;
  return {
    team: TEAMS.includes(c.team) ? c.team : d.team,
    role: ROLES.includes(c.role) ? c.role : d.role,
    drive: DRIVES.includes(c.drive) ? c.drive : d.drive,
  };
}

/** Есть ли у геймпада вибромотор (Chrome/Edge/Safari — vibrationActuator, Firefox — hapticActuators) */
export function hasRumble(gp) {
  try {
    if (!gp) return false;
    if (gp.vibrationActuator && typeof gp.vibrationActuator.playEffect === 'function') return true;
    const ha = gp.hapticActuators && gp.hapticActuators[0];
    return !!(ha && typeof ha.pulse === 'function');
  } catch { return false; }
}
function vibrate(gp, ms, strong, weak) {
  if (!gp) return false;
  try {
    const va = gp.vibrationActuator;
    if (va && typeof va.playEffect === 'function') {
      const pr = va.playEffect('dual-rumble', { startDelay: 0, duration: Math.round(ms), strongMagnitude: clamp(fin(strong), 0, 1), weakMagnitude: clamp(fin(weak), 0, 1) });
      if (pr && typeof pr.catch === 'function') pr.catch(() => { /* эффект прерван или не поддерживается */ });
      return true;
    }
    const ha = gp.hapticActuators && gp.hapticActuators[0];
    if (ha && typeof ha.pulse === 'function') {
      const pr = ha.pulse(clamp(Math.max(fin(strong), fin(weak)), 0, 1), Math.round(ms));
      if (pr && typeof pr.catch === 'function') pr.catch(() => { /* не поддерживается */ });
      return true;
    }
  } catch { /* вибрация недоступна */ }
  return false;
}

/** Короткое имя геймпада из id (Chrome: «… (STANDARD GAMEPAD Vendor: …)», «… (XInput STANDARD GAMEPAD)», Firefox: «045e-028e-Имя») */
export function padName(id, index = 0) {
  let s = String(id || '').trim();
  s = s.replace(/\s*\([^()]*\b(?:STANDARD GAMEPAD|Vendor:)[^()]*\)\s*$/i, '').replace(/^[0-9a-f]{1,4}-[0-9a-f]{1,4}-/i, '').trim();
  return s || `Геймпад ${index + 1}`;
}

export class GamepadManager {
  constructor(hub, app) {
    this.hub = hub;
    this.app = app || {};
    this.slots = new Array(MAX_PADS).fill(null);
    const saved = this.app.store ? this.app.store.get('pads', null) : null;
    this.cfg = Array.from({ length: MAX_PADS }, (_, i) => normalizePadConfig(Array.isArray(saved) ? saved[i] : null, i));
    this.error = '';
    this.rumbleLog = [];      // последние вибрации: { index, reason, ok, t }
    this.listeners = new Set();
    this._timers = new Set();
    this._onConn = () => { try { this.scan(); } catch (e) { console.error('Геймпад:', e); } };
    window.addEventListener('gamepadconnected', this._onConn);
    window.addEventListener('gamepaddisconnected', this._onConn);
    this._offs = [];
    if (typeof this.app.on === 'function') {
      this._offs.push(this.app.on('matchStart', () => this.rumbleAll('matchStart', [{ ms: 350, strong: 1, weak: 0.6 }])));
      this._offs.push(this.app.on('matchEnd', () => this.rumbleAll('matchEnd', [{ ms: 260, strong: 1, weak: 1 }, { delay: 420, ms: 520, strong: 1, weak: 1 }])));
    }
    /** Источник для input.addSource */
    this.source = (dt) => this.poll(dt);
  }

  /** Gamepad API есть в этом браузере (проверяется каждый раз: тесты подменяют getGamepads) */
  get supported() { return typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'; }
  /** Небезопасный контекст (http не localhost): Firefox и новые Chrome геймпады не отдают */
  get insecure() { return typeof window !== 'undefined' && window.isSecureContext === false; }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(type, slot) {
    for (const fn of [...this.listeners]) { try { fn(type, slot); } catch (e) { console.error('Геймпад, обработчик:', e); } }
    // событие приложения: 'gamepad' (type, описание); у отключённого — только номер, id и имя
    if (type !== 'change' && typeof this.app.emit === 'function') {
      const d = slot ? (type === 'disconnect' ? { index: slot.index, id: slot.id, name: slot.name } : this.describe(slot.index)) : null;
      this.app.emit('gamepad', type, d);
    }
  }

  _snapshot() {
    if (!this.supported) return [];
    try {
      const l = navigator.getGamepads();
      this.error = '';
      return l ? Array.from(l) : [];
    } catch (e) {
      this.error = `Браузер не разрешил Gamepad API на этой странице (${(e && e.name) || 'ошибка'}).`;
      return [];
    }
  }

  /** Обновить список подключённых геймпадов -> массив снимков по индексу (null — пусто) */
  scan() {
    const list = this._snapshot();
    const now = new Array(MAX_PADS).fill(null);
    for (let i = 0; i < list.length; i++) {
      const gp = list[i];
      if (!gp || gp.connected === false) continue;          // Chrome: дырки null, Firefox: connected=false
      const idx = Number.isInteger(gp.index) ? gp.index : i;
      if (idx < 0 || idx >= MAX_PADS || now[idx]) continue;
      now[idx] = gp;
    }
    let changed = false;
    for (let i = 0; i < MAX_PADS; i++) {
      const gp = now[i], s = this.slots[i];
      const id = gp ? String(gp.id || '') : '';
      if (gp && (!s || s.id !== id)) {
        if (s) this._emit('disconnect', s);                 // индекс занят другим геймпадом
        this.slots[i] = {
          index: i, id, name: padName(id, i), mapping: gp.mapping || '', layout: gp.mapping === 'standard' ? 'standard' : 'generic',
          fresh: true, prev: {}, st: null, trigAxes: false, active: false, vib: hasRumble(gp),
          stall: { push: 0, arm: 0, tree: 0, cool: 0, was: false, pos: null, yaw: 0, cmd: null, t: null },
        };
        changed = true;
        this._emit('connect', this.slots[i]);
      } else if (!gp && s) {
        this.slots[i] = null; changed = true;
        this._emit('disconnect', s);
      }
    }
    if (changed) this._emit('change', null);
    return now;
  }

  /** Команда, которой отдан геймпад ('red' | 'blue') */
  sideOf(cfg) {
    const t = cfg && cfg.team;
    if (t === 'red' || t === 'blue') return t;
    const team = this.hub && this.hub.team === 'blue' ? 'blue' : 'red';
    return t === 'other' ? (team === 'red' ? 'blue' : 'red') : team;
  }
  /** Режим матча (ограничения ролей действуют только в нём) */
  isMatch() {
    if (this.hub && typeof this.hub.isMatch === 'function') return this.hub.isMatch();
    return !!(this.app.state && this.app.state.mode === 'match');
  }
  config(i) { return { ...this.cfg[i] }; }
  /** Изменить назначение геймпада i: { team?, role?, drive? } */
  setConfig(i, patch) {
    if (!(i >= 0 && i < MAX_PADS)) return null;
    this.cfg[i] = normalizePadConfig({ ...this.cfg[i], ...(patch || {}) }, i);
    if (this.app.store) this.app.store.set('pads', this.cfg);
    const s = this.slots[i];
    if (s) { s.prev = s.st ? { ...s.st.b } : {}; s.stall.pos = null; }
    this._emit('change', s);
    return this.config(i);
  }
  /** Описание слота для интерфейса и сети */
  describe(i) {
    const s = this.slots[i], c = this.cfg[i];
    if (!s) return null;
    return { index: i, id: s.id, name: s.name, mapping: s.mapping, layout: s.layout, vibration: s.vib, active: s.active, team: c.team, side: this.sideOf(c), role: c.role, drive: c.drive };
  }
  /** Подключённые геймпады */
  list() { const r = []; for (let i = 0; i < MAX_PADS; i++) { const d = this.describe(i); if (d) r.push(d); } return r; }
  get count() { return this.slots.filter(Boolean).length; }

  /** Опрос (раз в кадр) -> { red?, blue? } частичных TeamInput */
  poll(dt) {
    const pads = this.scan();
    const hub = this.hub, out = {};
    dt = Math.max(0, fin(dt));
    let relabel = false;
    for (let i = 0; i < MAX_PADS; i++) {
      const gp = pads[i], s = this.slots[i];
      if (!gp || !s) continue;
      const st = readPad(gp, s);
      if (st.layout !== s.layout) relabel = true;           // раскладку угадали по первому снимку
      s.st = st; s.mapping = gp.mapping || ''; s.layout = st.layout;
      // кнопки, зажатые в момент подключения (браузер «будит» геймпад нажатием), — не нажатие
      if (s.fresh) { s.prev = { ...st.b }; s.fresh = false; }
      const edge = (k) => st.b[k] && !s.prev[k];
      s.active = !!(st.lx || st.ly || st.rx || st.ry || st.lt || st.rt || BTN_KEYS.some((k) => st.b[k]));
      const cfg = this.cfg[i];
      if (cfg.role !== 'off') {
        const side = this.sideOf(cfg);
        const prog = !!(hub && hub.programMode && hub.programMode(side));
        // в матче пульт Driver руку не двигает (правило 14); в тренировке — можно
        const p = mapPad(st, cfg, prog, { arm: !this.isMatch() });
        if (cfg.role === 'specialist' && edge('a')) p.recycle = true;
        mergeLocal(out[side] || (out[side] = blank()), p);
        const blocked = !!(hub && hub.blocked && hub.blocked[side]);
        if (edge('start') && !blocked) this.toggleProgram(side);
        if (edge('back')) this.resetView();
        if (edge('rb')) this.nextCam();
        try { this._stall(s, side, cfg.role, p, prog, dt); } catch (e) { /* робот пересобирается */ }
      }
      s.prev = { ...st.b };
    }
    if (relabel) this._emit('change', null);
    return out;
  }

  // ---------- действия кнопок ----------
  /** Start: запустить или остановить программу команды */
  toggleProgram(side) {
    const app = this.app;
    const running = !!((app.runners && app.runners[side] && app.runners[side].running) || (app.state && app.state.prog && app.state.prog[side] === 'running'));
    try {
      const r = running ? app.stopProgram && app.stopProgram(side) : app.runProgram && app.runProgram(side);
      if (r && typeof r.catch === 'function') r.catch((e) => console.error('Программа:', e));
    } catch (e) { console.error('Программа:', e); }
  }
  /** Back/Select: вернуть вид текущей камеры */
  resetView() { const app = this.app; if (app.ui && app.ui.setCam) app.ui.setCam((app.state && app.state.cam) || '3d'); }
  /** RB: следующая камера */
  nextCam() {
    const app = this.app;
    if (!app.ui || !app.ui.setCam) return;
    const c = (app.state && app.state.cam) || '3d';
    app.ui.setCam(CAMS[(CAMS.indexOf(c) + 1) % CAMS.length]);
  }

  // ---------- вибрация ----------
  /** Упор: мотор STALLED (программа) или ручная команда без движения дольше STALL_T */
  _stall(s, side, role, p, prog, dt) {
    const app = this.app, sim = app.sim, z = s.stall;
    z.cool = Math.max(0, z.cool - dt);
    const live = sim && app.stepAuthority !== false && !(app.state && app.state.paused) && !(this.hub && this.hub.frozen);
    const r = live && sim.robots ? sim.robots[side] : null;
    if (!r) { z.push = z.arm = z.tree = 0; z.pos = null; z.t = null; z.was = false; return; }
    // время симуляции между опросами (скорость 1×/4×, кадры без шагов — не в счёт)
    const t = fin(sim.time), sdt = z.t === null || z.t === undefined ? 0 : t - z.t;
    z.t = t;
    let hit = false;
    const cross = (prev, now) => prev < STALL_T && now >= STALL_T;
    if (role === 'driver') {
      const st = [r.left, r.right, r.arm].some((m) => m && m.stalled);
      if (st && !z.was) hit = true;
      z.was = st;
      const pos = r.position, yaw = r.yawWorld;
      if (prog || r.dragging || !z.pos || !z.cmd || sdt < 0) { z.push = 0; z.arm = 0; }
      else if (sdt > 1e-4) {
        // колёса проскальзывают об борт/робота: команда есть, а корпус почти не едет и не поворачивается
        const v = Math.hypot(pos.x - z.pos.x, pos.z - z.pos.z) / sdt;
        const w = Math.abs(wrapPi(yaw - z.yaw)) / sdt * 180 / Math.PI;
        const cmd = Math.abs(z.cmd.fwd) + Math.abs(z.cmd.turn);
        const prev = z.push;
        z.push = cmd > 0.35 && v < 2 && w < 10 ? z.push + sdt : 0;
        if (cross(prev, z.push)) hit = true;
        const pa = z.arm;
        z.arm = Math.abs(z.cmd.arm) > 0.3 && r.arm && Math.abs(fin(r.arm.actual)) < 15 ? z.arm + sdt : 0;
        if (cross(pa, z.arm)) hit = true;
      }
      z.pos = { x: pos.x, z: pos.z }; z.yaw = yaw;
      z.cmd = { fwd: p.drive.fwd, turn: p.drive.turn, arm: p.arm };
    } else {
      const tm = (sim.treeMotors && sim.treeMotors[side]) || [];
      const st = tm.some((m) => m && m.stalled);
      if (st && !z.was) hit = true;
      z.was = st;
      if (prog || !z.cmd || !tm[0] || sdt < 0) z.tree = 0;
      else if (sdt > 1e-4) {
        const prev = z.tree;
        z.tree = Math.abs(z.cmd.tree) > 0.3 && Math.abs(fin(tm[0].actual)) < 15 ? z.tree + sdt : 0;
        if (cross(prev, z.tree)) hit = true;
      }
      z.cmd = { tree: p.tree };
    }
    if (hit && z.cool <= 0) { this.rumble(s.index, 'stall', [{ ms: 180, strong: 0.35, weak: 0.8 }]); z.cool = STALL_COOL; }
  }

  /** Вибрация геймпада index: pulses = [{ ms, strong, weak, delay? }]. -> true, если вибромотор есть */
  rumble(index, reason = 'test', pulses = [{ ms: 220, strong: 0.8, weak: 0.8 }]) {
    const get = () => {
      if (!this.supported) return null;
      try { const l = navigator.getGamepads(); return l ? l[index] || null : null; } catch { return null; }
    };
    let ok = false;
    for (const pl of pulses) {
      if (pl.delay > 0) {
        const t = setTimeout(() => { this._timers.delete(t); vibrate(get(), pl.ms, pl.strong, pl.weak); }, pl.delay);
        this._timers.add(t);
      } else ok = vibrate(get(), pl.ms, pl.strong, pl.weak) || ok;
    }
    this.rumbleLog.push({ index, reason, ok, t: performance.now() });
    if (this.rumbleLog.length > 30) this.rumbleLog.shift();
    return ok;
  }
  /** Вибрация всех назначенных геймпадов */
  rumbleAll(reason, pulses) {
    let n = 0;
    for (let i = 0; i < MAX_PADS; i++) if (this.slots[i] && this.cfg[i].role !== 'off' && this.rumble(i, reason, pulses)) n++;
    return n;
  }

  dispose() {
    window.removeEventListener('gamepadconnected', this._onConn);
    window.removeEventListener('gamepaddisconnected', this._onConn);
    for (const off of this._offs) { try { off(); } catch { /* уже отписан */ } }
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    this.listeners.clear();
  }
}
