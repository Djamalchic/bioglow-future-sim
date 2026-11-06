// Мост между Python-программой команды (Skulpt) и симулятором. Один Bridge на команду.
// Python-модуль legoeducation_<side> вызывает: connect / cmd / get / sleep / now.
// Каждый запуск программы — «прогон» со своим id: ожидания прогона отменяются при остановке,
// старый прогон не может задеть новый (review H6).
// Замок с симуляцией: всё, чего ждёт программа (sleep, команды моторов), идёт по времени симуляции;
// главный цикл не делает следующий шаг, пока программа не дождалась очередного ожидания (см. blocked/mayWake).
// Опрос датчиков и time.time() «стоят» немного времени симуляции — циклы без sleep тоже детерминированы.
import { colorReading } from './sim.js';
import { STATE } from './motors.js';
import { DT } from './physics.js';
import { qRot, qConj } from './physics.js';

const UNCHANGED = -32768;
const R2D = 180 / Math.PI;
const LEGO_HEX = { 0: 0x111111, 1: 0xd0217a, 2: 0x7d3fb5, 3: 0x1f5fd0, 4: 0x2fa8e0, 5: 0x14a3a6, 6: 0x2f9a3d, 7: 0xf6c21a, 8: 0xf08a1c, 9: 0xd8281f, 10: 0xffffff, [-1]: 0x222222 };
/** «Цена» вызовов во времени симуляции, с */
export const COST = { get: 0.0004, now: 0.0004, cmd: 0.001 };
const SIDE_RU = { red: 'красной', blue: 'синей' };

/** Ошибка-сигнал остановки (Python её не видит: раннер обрывает цепочку сам) */
export class StopSignal extends Error {
  constructor() { super('__STOP__'); this.name = 'StopSignal'; this.bioglowStop = true; }
}
/** Понятная ошибка для программы (раннер превращает её в RuntimeError Python) */
export class SimError extends Error {
  constructor(msg) { super(msg); this.name = 'SimError'; this.bioglowUser = true; }
}

function parseArgs(s) {
  const o = {};
  if (!s) return o;
  for (const part of String(s).split(';')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = part.slice(0, i), v = part.slice(i + 1);
    const n = Number(v);
    o[k] = v === '' || Number.isNaN(n) ? v : n;
  }
  return o;
}
// аргументы-числа: строка ('fast', 'nan', 'inf') — ошибка, а не «тихо ничего» (Python-обёртка проверяет раньше)
const NUMERIC = new Set(['speed', 'degrees', 'time_ms', 'position', 'duty_cycle', 'acceleration', 'deceleration',
  'speed_left', 'speed_right', 'steering', 'value', 'frequency', 'count', 'color', 'pattern', 'intensity',
  'direction', 'motor', 'end_state', 'yaw_face']);
function checkNumeric(name, a) {
  for (const k of Object.keys(a)) {
    if (NUMERIC.has(k) && (typeof a[k] !== 'number' || !Number.isFinite(a[k]))) {
      throw new SimError(`${name}(): ${k} должен быть конечным числом, получено «${a[k]}»`);
    }
  }
}

export class Bridge {
  constructor(sim, side) {
    this.sim = sim;
    this.side = side;
    this.levers = { driver: [0, 0], specialist: [0, 0] }; // рычаги пультов (задаёт главный цикл из TeamInput)
    this.run = null;       // текущий прогон: { id, stopped, waits:Set, sleeps:[], devices:{}, debt }
    this.kick = false;     // какое-то ожидание завершилось — программе пора продолжить
    this.audio = null;
    this.say = null;       // (text, cls) — предупреждения в консоль команды
    this.treeMv = { speed: 50, steering: 100 };
  }

  get robot() { return this.sim.robots[this.side]; }
  get tree() { return this.sim.treeMotors[this.side]; }
  /** Программа сейчас ждёт события симуляции (sleep/команда) */
  get blocked() { return !!(this.run && this.run.waits.size > 0); }

  // ---------- прогоны ----------
  begin(id) {
    if (this.run && !this.run.stopped) this.abort(this.run.id);
    this.run = { id, stopped: false, waits: new Set(), sleeps: [], devices: {}, debt: 0 };
    this.treeMv = { speed: 50, steering: 100 };
    this.kick = false;
  }
  /** Остановить прогон id: отменить ожидания и остановить моторы команды */
  abort(id) {
    const run = this.run;
    if (!run || (id !== undefined && run.id !== id)) return false;
    const first = !run.stopped;
    run.stopped = true;
    const waits = [...run.waits];
    run.waits.clear(); run.sleeps = [];
    for (const w of waits) w.rej(new StopSignal());
    if (first) this.stopMotors();
    return true;
  }
  /** Прогон завершён (раннер вызывает в finally) */
  end(id) {
    if (!this.run || this.run.id !== id) return;
    this.abort(id);
    this.run = null;
  }
  stopMotors() {
    const r = this.robot;
    try {
      r.cancelTurn('aborted');
      r.stopMove();
      r.arm.stop();
      for (const m of this.tree) m.stop();
    } catch (e) { console.error(e); }
  }
  _alive() {
    const run = this.run;
    if (!run || run.stopped) throw new StopSignal();
    return run;
  }

  /**
   * Ожидание события симуляции. probe() — синхронная проверка «уже завершилось» (для замка с циклом),
   * until — для сна: момент времени симуляции.
   */
  _wait(p, { probe = null, until } = {}) {
    const run = this._alive();
    run.debt = 0;
    return new Promise((res, rej) => {
      const w = { rej, probe, until };
      run.waits.add(w);
      Promise.resolve(p).then(
        (v) => { if (run.waits.delete(w)) { this.kick = true; res(v); } },
        (e) => { if (run.waits.delete(w)) { this.kick = true; rej(e); } },
      );
    });
  }
  /** Может ли после последнего шага продолжиться программа (нужно отдать ей управление) */
  mayWake() {
    if (this.kick) return true;
    const run = this.run;
    if (!run || run.stopped) return false;
    const t = this.sim.time + 1e-9;
    for (const w of run.waits) {
      if (w.until !== undefined) { if (t >= w.until) return true; }
      else if (!w.probe || w.probe()) return true;
    }
    return false;
  }
  /** «Стоимость» вызова во времени симуляции; накопилось на шаг — ждём, затем читаем свежее значение */
  _charge(cost, read) {
    const run = this.run;
    if (!run || run.stopped) return read();
    run.debt += cost;
    if (run.debt + 1e-12 < DT) return read();
    return this._sleepRaw(run.debt).then(() => read());
  }

  // ---------- подключение (лимиты железа Future Edition) ----------
  connect(kind, name) {
    const run = this._alive();
    const dev = run.devices;
    const nm = String(name || '').trim().toLowerCase();
    let id = '';
    if (kind === 'DoubleMotor') {
      const tree = /tree|дерев|grand/.test(nm);
      id = tree ? 'tree' : 'drive';
      if (dev[id]) {
        throw new SimError(tree
          ? 'Double Motor в Grand Tree уже подключён в этой программе.'
          : "По правилам Future Edition у команды два Double Motor: ходовая робота (уже подключена) и мотор Grand Tree. Мотор дерева подключайте так: tree.connect(device_name='tree').");
      }
    } else if (kind === 'SingleMotor') {
      id = 'arm';
      if (dev.arm) throw new SimError('По правилам Future Edition у команды один Single Motor для Technician tool (второй стоит в Hive, программе он недоступен).');
      if (!this.robot.geo.arm) this.warn('[sim] На роботе нет навесного с Single Motor — команды этого мотора ни на что не влияют (см. «Конструктор»).');
    } else if (kind === 'ColorSensor') {
      id = 'color';
      if (dev.color) throw new SimError('По правилам Future Edition у команды один Color Sensor для Technician tool (второй стоит в Young Forest).');
      if (!this.robot.config.sensor.enabled) this.warn('[sim] На роботе нет датчика цвета — он всегда видит «нет цвета» (см. «Конструктор»).');
    } else if (kind === 'Controller') {
      const role = /spec|специал/.test(nm) ? 'specialist' : 'driver';
      id = 'ctrl:' + role;
      if (dev[id]) {
        throw new SimError(role === 'driver'
          ? "Пульт Driver уже подключён. По правилам Future Edition второй пульт — у Specialist: controller.connect(device_name='specialist')."
          : 'Пульт Specialist уже подключён. По правилам Future Edition у команды не больше двух пультов (Driver и Specialist).');
      }
    } else {
      throw new SimError(`Неизвестное устройство «${kind}».`);
    }
    dev[id] = { kind, connected: true };
    return id;
  }
  disconnect(id) {
    const run = this.run;
    if (!run || !run.devices[id]) return;
    if (id === 'drive') this.robot.stopMove();
    if (id === 'arm') this.robot.arm.stop();
    if (id === 'tree') this.tree.forEach((m) => m.stop());
    delete run.devices[id];
  }
  warn(text) { if (this.say) this.say(text + '\n', 'warn'); }

  motorsOf(id, motor) {
    const r = this.robot;
    if (id === 'arm') return [r.arm];
    const pair = id === 'tree' ? this.tree : [r.left, r.right];
    if (motor === 1) return [pair[0]];
    if (motor === 2) return [pair[1]];
    return pair; // 0 (DEFAULT) или 3 (BOTH)
  }
  speedOf(m, speed) { return speed === UNCHANGED || speed === undefined || speed === '' ? m.defaultSpeed : speed; }
  dirSign(direction) { return direction === 1 ? -1 : 1; }

  /** Запустить команду на моторах и (если блокирующая) ждать их завершения */
  _motors(list, a, start) {
    const ps = list.map((m) => start(m));
    const cmds = list.map((m) => m.cmd).filter((c) => c && c.resolve);
    const all = Promise.all(ps).then((x) => x[0]);
    if (a.blocking === 0) return 'ok';
    return this._wait(all, { probe: () => cmds.every((c) => !c.resolve) });
  }
  /** Ждать синхронную ходовую робота */
  _drive(a, start) {
    const r = this.robot;
    const p = start();
    const d = r.drive;
    const probe = d && d.resolve ? () => !d.resolve : null;
    if (a.blocking === 0) return 'ok';
    return this._wait(p, { probe });
  }

  // ---------- команды ----------
  cmd(id, name, argstr) {
    const run = this._alive();
    const a = parseArgs(argstr);
    if (name === 'disconnect') { this.disconnect(id); return 'ok'; }
    if (!run.devices[id]) throw new SimError('Устройство не подключено: сначала вызовите connect().');
    checkNumeric(name, a);
    const res = this._cmd(id, name, a);
    if (res && typeof res.then === 'function') return res;
    return this._charge(COST.cmd, () => res);
  }

  _cmd(id, name, a) {
    const now = this.sim.time;
    const r = this.robot;
    const isDrive = id === 'drive', isTree = id === 'tree';
    switch (name) {
      // ----- моторы -----
      case 'motor_set_speed': this.motorsOf(id, a.motor).forEach((m) => (m.defaultSpeed = a.speed)); return 'ok';
      case 'motor_run': {
        if (isDrive) r.cancelTurn('aborted');
        this.motorsOf(id, a.motor).forEach((m) => m.run(this.dirSign(a.direction) * m.pctToDeg(this.speedOf(m, a.speed))));
        return 'ok';
      }
      case 'motor_run_for_time':
        if (isDrive) r.cancelTurn('aborted');
        return this._motors(this.motorsOf(id, a.motor), a, (m) => m.runForTime(a.time_ms, this.dirSign(a.direction) * m.pctToDeg(this.speedOf(m, a.speed)), now));
      case 'motor_run_for_degrees':
        if (isDrive) r.cancelTurn('aborted');
        return this._motors(this.motorsOf(id, a.motor), a, (m) => m.runForDegrees(a.degrees, this.dirSign(a.direction) * m.pctToDeg(this.speedOf(m, a.speed))));
      case 'motor_reset_relative_position': this.motorsOf(id, a.motor).forEach((m) => (m.relZero = m.pos - (Number(a.position) || 0))); return 'ok';
      case 'motor_run_to_relative_position':
        if (isDrive) r.cancelTurn('aborted');
        return this._motors(this.motorsOf(id, a.motor), a, (m) => m.runToPos(m.relZero + (Number(a.position) || 0), m.pctToDeg(this.speedOf(m, a.speed))));
      case 'motor_run_to_absolute_position':
        if (isDrive) r.cancelTurn('aborted');
        return this._motors(this.motorsOf(id, a.motor), a, (m) => {
          const cur = m.absPos; let d;
          const cw = ((((Number(a.position) || 0) - cur) % 360) + 360) % 360;
          if (a.direction === 0) d = cw; else if (a.direction === 1) d = cw - 360;
          else { d = cw > 180 ? cw - 360 : cw; if (a.direction === 3) d = d > 0 ? d - 360 : d + 360; }
          return m.runToPos(m.pos + d, m.pctToDeg(this.speedOf(m, a.speed)));
        });
      case 'motor_set_duty_cycle': if (isDrive) r.cancelTurn('aborted'); this.motorsOf(id, a.motor).forEach((m) => m.duty(a.duty_cycle)); return 'ok';
      case 'motor_stop': if (isDrive) r.cancelTurn('aborted'); this.motorsOf(id, a.motor).forEach((m) => m.stop()); return 'ok';
      case 'motor_set_end_state': this.motorsOf(id, a.motor).forEach((m) => (m.endState = a.end_state)); return 'ok';
      case 'motor_set_acceleration': this.motorsOf(id, a.motor).forEach((m) => { m.accelPct = a.acceleration; m.decelPct = a.deceleration ?? a.acceleration; }); return 'ok';
      // ----- IMU -----
      case 'imu_set_yaw_face': return 'ok';
      case 'imu_reset_yaw_axis': if (isDrive) { r.yawZero = r.yawCont; r.yawResetVal = Number(a.value) || 0; } return 'ok';
      // ----- свет и звук -----
      case 'light_color': if (isDrive || id === 'arm') r.setLed(LEGO_HEX[a.color] ?? 0xffffff); return 'ok';
      case 'beep': return a.blocking === 0 ? (this.beep(a.frequency || 440, a.count || 1, a.pattern || 0, false), 'ok') : this.beep(a.frequency || 440, a.count || 1, a.pattern || 0, true);
      case 'stop_beep': return 'ok';
      case 'info': return `${this.run.devices[id]?.kind || id} (симулятор BIOGLOW Future Edition, ${SIDE_RU[this.side]} команды)`;
      default: break;
    }
    if (name.startsWith('movement_')) return isTree ? this._treeMove(name, a, now) : isDrive ? this._driveMove(name, a, now) : 'ok';
    return 'ok';
  }

  mspeed(speed) { return speed === UNCHANGED || speed === undefined || speed === '' ? this.robot.moveSpeed : speed; }

  /** movement_* ходовой: синхронная езда робота */
  _driveMove(name, a, now) {
    const r = this.robot;
    switch (name) {
      case 'movement_move': r.move(a.direction, this.mspeed(a.speed)); return 'ok';
      case 'movement_move_for_time': return this._drive(a, () => r.moveForTime(a.time_ms, a.direction, this.mspeed(a.speed), now));
      case 'movement_move_for_degrees': return this._drive(a, () => r.moveForDegrees(a.degrees, a.direction, this.mspeed(a.speed)));
      case 'movement_move_tank': r.moveTank(a.speed_left, a.speed_right); return 'ok';
      case 'movement_move_tank_for_degrees': return this._drive(a, () => r.moveTankForDegrees(a.degrees, a.speed_left, a.speed_right));
      case 'movement_turn_for_degrees': return this._drive(a, () => r.turnForDegrees(a.degrees, a.direction, this.mspeed(a.speed)));
      case 'movement_stop': r.stopMove(); return 'ok';
      case 'movement_set_speed': r.moveSpeed = a.speed; return 'ok';
      case 'movement_set_end_state': this.motorsOf('drive', 3).forEach((m) => (m.endState = a.end_state)); return 'ok';
      case 'movement_set_acceleration': this.motorsOf('drive', 3).forEach((m) => { m.accelPct = a.acceleration; m.decelPct = a.deceleration ?? a.acceleration; }); return 'ok';
      case 'movement_set_turn_steering': r.steering = Math.max(0, Math.min(100, Number(a.steering) || 0)); return 'ok';
      default: return 'ok';
    }
  }

  /**
   * movement_* мотора Grand Tree — через обычный API моторов (review M10): пара моторов как ходовая
   * (левый «по часовой» = назад), скорость, градусы и время учитываются. У дерева нет колёс и IMU:
   * поворот = встречное вращение моторов на заданные градусы.
   */
  _treeMove(name, a, now) {
    const [L, R] = this.tree, t = this.treeMv;
    const sp = (s) => L.pctToDeg(s === UNCHANGED || s === undefined || s === '' ? t.speed : s);
    const fac = (dir) => {
      const st = t.steering / 100;
      return dir === 1 ? [-1, -1] : dir === 2 ? [1 - 2 * st, 1] : dir === 3 ? [1, 1 - 2 * st] : [1, 1];
    };
    const deg = (m, d, v) => (Math.abs(d) < 0.5 || Math.abs(v) < 1 ? m.stop().then(() => 'done') : m.runForDegrees(Math.abs(d), v));
    switch (name) {
      case 'movement_move': { const s = sp(a.speed), [kL, kR] = fac(a.direction); L.run(-kL * s); R.run(kR * s); return 'ok'; }
      case 'movement_move_for_time': {
        const s = sp(a.speed), [kL, kR] = fac(a.direction);
        return this._motors([L, R], a, (m) => m.runForTime(a.time_ms, (m === L ? -kL : kR) * s, now));
      }
      case 'movement_move_for_degrees': {
        const s = Math.abs(sp(a.speed)), [kL, kR] = fac(a.direction), sg = (Number(a.degrees) || 0) < 0 ? -1 : 1, d = Math.abs(Number(a.degrees) || 0);
        return this._motors([L, R], a, (m) => (m === L ? deg(L, d * kL, -sg * Math.sign(kL) * s) : deg(R, d * kR, sg * Math.sign(kR) * s)));
      }
      case 'movement_move_tank': L.run(-L.pctToDeg(a.speed_left)); R.run(R.pctToDeg(a.speed_right)); return 'ok';
      case 'movement_move_tank_for_degrees': {
        const sl = Number(a.speed_left) || 0, sr = Number(a.speed_right) || 0, m = Math.max(Math.abs(sl), Math.abs(sr));
        if (!m) { L.stop(); R.stop(); return 'ok'; }
        const d = Number(a.degrees) || 0, sg = d < 0 ? -1 : 1;
        return this._motors([L, R], a, (mm) => (mm === L ? deg(L, d * sl / m, -sg * Math.sign(sl) * L.pctToDeg(m)) : deg(R, d * sr / m, sg * Math.sign(sr) * R.pctToDeg(m))));
      }
      case 'movement_turn_for_degrees': {
        const s = Math.abs(sp(a.speed)), d = Math.abs(Number(a.degrees) || 0), left = a.direction !== 1;
        return this._motors([L, R], a, (m) => deg(m, d, (left ? 1 : -1) * s));
      }
      case 'movement_stop': L.stop(); R.stop(); return 'ok';
      case 'movement_set_speed': t.speed = Number(a.speed) || 0; return 'ok';
      case 'movement_set_end_state': L.endState = R.endState = a.end_state; return 'ok';
      case 'movement_set_acceleration': for (const m of [L, R]) { m.accelPct = a.acceleration; m.decelPct = a.deceleration ?? a.acceleration; } return 'ok';
      case 'movement_set_turn_steering': t.steering = Math.max(0, Math.min(100, Number(a.steering) || 0)); return 'ok';
      default: return 'ok';
    }
  }

  beep(freq, count, pattern, wait) {
    const dur = 0.14, gap = 0.08;
    try {
      this.audio ||= new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this.audio;
      for (let i = 0; i < count * (pattern + 1); i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = freq * (pattern === 3 ? [1, 1.25, 1][i % 3] : 1);
        g.gain.value = 0.06;
        o.connect(g); g.connect(ctx.destination);
        const t0 = ctx.currentTime + i * (dur + gap);
        o.start(t0); o.stop(t0 + dur);
      }
    } catch (e) { /* звук недоступен */ }
    return wait ? this.sleep(count * (pattern + 1) * (dur + gap)) : 'ok';
  }

  // ---------- чтение значений ----------
  /** Чтение свойства устройства программы: только подключённого (иначе id '' читал бы чужие данные — ходовую) */
  get(id, key) {
    const run = this._alive();
    if (key !== 'connected' && !run.devices[id]) throw new SimError('Устройство не подключено: сначала вызовите connect().');
    return this._charge(COST.get, () => this.read(id, key));
  }
  /** Предупреждение в консоль команды — один раз за прогон */
  warnOnce(key, text) {
    const run = this.run;
    if (!run) return;
    run.warned ||= new Set();
    if (run.warned.has(key)) return;
    run.warned.add(key);
    this.warn(text);
  }

  read(id, key) {
    const r = this.robot;
    const run = this.run;
    if (key === 'connected') return run && run.devices[id] ? 1 : 0;
    if (!['drive', 'tree', 'arm', 'color', 'ctrl:driver', 'ctrl:specialist'].includes(id)) return 0;
    if (key.startsWith('done')) {
      if (id === 'drive') return r.moving ? 0 : 1;
      return this.motorsOf(id, 3).some((m) => m.busy) ? 0 : 1;
    }
    if (key[0] === 'm' && key[2] === '.') {
      const idx = Number(key[1]);
      const m = this.motorsOf(id, id === 'arm' ? 0 : idx)[0];
      switch (key.slice(3)) {
        case 'position': return Math.round(m.relPos);
        case 'absolutePos': return Math.round(m.absPos);
        case 'speed': return Math.round(m.actual / m.maxDegS * 100);
        case 'power': return m.power;
        case 'motorState': return m.state;
        case 'motorBitMask': return idx === 2 ? 2 : 1;
        default: return 0;
      }
    }
    if (key.startsWith('imu.')) {
      if (id !== 'drive') return key === 'imu.accelerometerZ' ? 1000 : 0;
      const q = r.chassis.rotation();
      switch (key.slice(4)) {
        case 'yaw': return Math.round(r.imuYaw);
        case 'pitch': return Math.round(r.imuPitch);
        case 'roll': return Math.round(r.imuRoll);
        case 'gyroscopeZ': return Math.round(r.gyroZ);
        // гироскоп, °/с: X — скорость крена (roll), Y — тангажа (pitch, нос вверх +), Z — курса (yaw, влево +);
        // знак каждой оси совпадает с ростом своего угла (интеграл gyroscopeY = pitch)
        case 'gyroscopeX': case 'gyroscopeY': {
          const w = qRot(qConj(q), r.chassis.angvel());
          return Math.round((key.endsWith('X') ? w.x : w.z) * R2D);
        }
        case 'accelerometerX': case 'accelerometerY': case 'accelerometerZ': {
          const g = qRot(qConj(q), { x: 0, y: 1, z: 0 }); // «вверх» в системе робота
          const k = key.slice(-1);
          return Math.round(1000 * (k === 'X' ? g.x : k === 'Y' ? -g.z : g.y));
        }
        default: return 0; // orientation, yawFace: DEVICE_FACE_TOP
      }
    }
    if (key.startsWith('c.')) {
      if (!r.config.sensor.enabled) return key === 'c.color' ? -1 : 0;
      const rd = colorReading(this.sim.colorAt(r.sensorWorld()));
      return rd[key.slice(2)] ?? 0;
    }
    if (key.startsWith('k.')) {
      const role = id === 'ctrl:specialist' ? 'specialist' : 'driver';
      const lv = this.levers[role] || [0, 0];
      switch (key.slice(2)) {
        case 'leftPercent': return Math.round(lv[0]);
        case 'rightPercent': return Math.round(lv[1]);
        case 'leftAngle': return Math.round(lv[0] * 0.3);
        case 'rightAngle': return Math.round(lv[1] * 0.3);
        default: return 0;
      }
    }
    return 0;
  }

  // ---------- время ----------
  now() {
    this._alive();
    return this._charge(COST.now, () => this.sim.time + (this.run ? this.run.debt : 0));
  }
  _sleepRaw(sec) {
    const run = this._alive();
    const until = this.sim.time + Math.max(0, Number(sec) || 0);
    let s;
    const p = new Promise((resolve) => { s = { until, resolve }; run.sleeps.push(s); });
    return this._wait(p, { until });
  }
  sleep(sec) { return this._sleepRaw(sec); }
  /** После шага симуляции: разбудить наступившие sleep */
  tick() {
    const run = this.run;
    if (!run || !run.sleeps.length) return;
    const t = this.sim.time + 1e-9;
    const keep = [];
    for (const s of run.sleeps) (t >= s.until ? s.resolve() : keep.push(s));
    run.sleeps = keep;
  }
}

export { STATE };
