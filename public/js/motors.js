// Модель мотора LEGO Education Computer Science & AI (как его видит Python API).
// Единицы API: скорость в % (−100..100), позиция в градусах. «По часовой» (CW) = положительное направление.
// Мотор — регулятор: трапециевидный профиль + позиционно-скоростная петля. Выход — целевая скорость вала,
// коэффициент регулятора и предел момента по кривой момент-скорость. Привод (шарнир Rapier или
// виртуальная инерция) применяет выход, а после шага физики сообщает фактический угол и скорость (энкодер).

export const END = { DEFAULT: 0, COAST: 1, BRAKE: 2, HOLD: 3, CONTINUE: 4, SMART_COAST: 5, SMART_BRAKE: 6 };
export const STATE = { READY: 0, RUNNING: 1, STALLED: 2, CMD_ABORTED: 3, REGULATION_ERROR: 4, DISCONNECTED: 5, HOLDING: 6, DC_RUNNING: 7, NOT_ALLOWED: 8 };

// Параметры моторов (можно менять на лету). Момент — в кг·см²/с² (100 = 1 Н·см).
export const SIM = {
  maxDegS: 1000,                         // 100 % скорости в API, °/с
  drive: { stall: 2000, free: 1100 },    // мотор Double Motor: 20 Н·см, холостой ход 1100 °/с
  single: { stall: 1800, free: 1150 },   // Single Motor: 18 Н·см
  kdFull: 40,                            // ошибка скорости (°/с), при которой регулятор даёт полный момент
  kp: 14,                                // позиционная петля, 1/с
  ki: 25,                                // интеграл в режиме удержания, 1/с²
  stallTime: 0.3,                        // с — заклинивание
  degTimeout: 1.5,                       // с сверх расчётного времени профиля
  degTol: 6,                             // ° — допуск «доехал» для команд на угол
  holdDead: 0.5,                         // ° — зона без накопления интеграла в удержании
  limitBleed: 0.3,                       // с — стравливание интеграла удержания, давящего в механический упор
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** Допуск сравнения времени: результат не зависит от накопленной ошибки sim.time */
export const T_EPS = 1e-7;

/** Трапециевидный профиль на расстояние dist (>0): возвращает { T, at(t) -> [s, v] } */
export function trapezoid(dist, vmax, acc, dec) {
  dist = Math.abs(dist); vmax = Math.max(1e-3, Math.abs(vmax)); acc = Math.max(1, acc); dec = Math.max(1, dec);
  let v = vmax, ta = v / acc, td = v / dec, sa = 0.5 * acc * ta * ta, sd = 0.5 * dec * td * td;
  if (sa + sd > dist) { v = Math.sqrt(2 * dist * acc * dec / (acc + dec)); ta = v / acc; td = v / dec; sa = 0.5 * acc * ta * ta; sd = 0.5 * dec * td * td; }
  const tc = v > 0 ? Math.max(0, (dist - sa - sd) / v) : 0;
  const T = ta + tc + td;
  return {
    T, v,
    at(t) {
      if (t <= 0) return [0, 0];
      if (t < ta) return [0.5 * acc * t * t, acc * t];
      if (t < ta + tc) return [sa + v * (t - ta), v];
      if (t < T) { const r = T - t; return [dist - 0.5 * dec * r * r, dec * r]; }
      return [dist, 0];
    },
  };
}

export class Motor {
  constructor(name, { spec = SIM.drive, defaultEnd = END.BRAKE } = {}) {
    this.name = name;
    this.spec = spec;        // { stall, free } — ссылка на объект SIM
    this.defaultEnd = defaultEnd; // что означает END.DEFAULT для этого мотора
    this.limits = null;      // [низ, верх] механических упоров в градусах мотора (рука) — для удержания; упоры задаёт шарнир
    this.reset();
  }
  reset() {
    this.pos = 0;            // энкодер, градусы
    this.relZero = 0;        // для motor_reset_relative_position
    this.actual = 0;         // фактическая скорость, °/с
    this.cmdSpeed = 0;       // опорная скорость профиля, °/с (совместимость)
    this.vRef = 0; this.pRef = 0;
    this.power = 0;
    this.cmd = null;
    this.defaultSpeed = 50;  // % — для speed=UNCHANGED
    this.accelPct = 60; this.decelPct = 60;
    this.endState = END.DEFAULT;
    this.stallT = 0;
    this.state = STATE.READY;
    this.holdPos = 0;
    this.out = { vel: 0, kd: 0, max: 0 }; // выход на привод (вал мотора)
  }
  get maxDegS() { return SIM.maxDegS; }
  get stalled() { return this.state === STATE.STALLED; }
  pctToDeg(p) { return clamp(Number(p) || 0, -100, 100) / 100 * this.maxDegS; }
  accelDegS2(p) { return 300 + (clamp(p, 0, 100) / 100) * 5000; } // 60 % ≈ 3300 °/с²

  _finish(result = 'done') {
    const c = this.cmd;
    if (!c) return;
    this.cmd = null;
    if (c.resolve) { const r = c.resolve; c.resolve = null; r(result); }
    if (result === 'done' || result === 'stalled') this._applyEnd(c, result);
  }
  get end() { return this.endState === END.DEFAULT || this.endState === undefined ? this.defaultEnd : this.endState; }
  _applyEnd(c, result = 'done') {
    const es = this.end;
    if (es === END.CONTINUE && c && c.speed && result !== 'stalled') this.cmd = { type: 'run', speed: c.speed };
    else if (es === END.COAST || es === END.SMART_COAST) this.cmd = { type: 'coast' };
    else if (es === END.HOLD) {
      // держим цель, только если до неё доехали; иначе — где реально остановились (не давим в упор)
      const reached = result === 'done' && c && c.target !== undefined && Math.abs(c.target - this.pos) < 1.5;
      this.holdPos = reached ? c.target : this.pos;
      this.cmd = { type: 'hold' };
    } else this.cmd = { type: 'stop' };
  }
  /** Новая команда. Предыдущая (если ждала завершения) завершается как прерванная. */
  _set(cmd) {
    if (this.cmd && this.cmd.resolve) { const r = this.cmd.resolve; this.cmd.resolve = null; r('aborted'); }
    const prevType = this.cmd ? this.cmd.type : 'stop';
    this.cmd = cmd;
    this.stallT = 0;
    if (this.state === STATE.STALLED) this.state = STATE.RUNNING;
    // профили стартуют от текущего положения и скорости
    if (cmd.type === 'run' || cmd.type === 'time' || cmd.type === 'ext') {
      if (!['run', 'time', 'ext'].includes(prevType)) { this.vRef = this.actual; this.pRef = this.pos; }
    }
    if (cmd.type === 'deg') {
      cmd.p0 = this.pos; cmd.t = 0;
      const a = this.accelDegS2(this.accelPct), d = this.accelDegS2(this.decelPct);
      cmd.prof = trapezoid(cmd.target - this.pos, cmd.speed, a, d);
      cmd.dir = Math.sign(cmd.target - this.pos) || 1;
    }
    if (cmd.waitable) return new Promise((res) => { cmd.resolve = res; });
    return Promise.resolve('ok');
  }

  run(speedDeg) { return this._set({ type: 'run', speed: speedDeg }); }
  duty(pct) { return this._set({ type: 'duty', duty: clamp(Number(pct) || 0, -100, 100) }); }
  stop() {
    const es = this.end;
    if (es === END.HOLD) { this.holdPos = this.pos; return this._set({ type: 'hold' }); }
    if (es === END.COAST || es === END.SMART_COAST) return this._set({ type: 'coast' });
    return this._set({ type: 'stop' });
  }
  runForTime(ms, speedDeg, now) {
    if (!(Math.abs(speedDeg) >= 1) || !(ms > 0)) return Promise.resolve('rejected');
    return this._set({ type: 'time', speed: speedDeg, end: now + ms / 1000, waitable: true });
  }
  runForDegrees(deg, speedDeg) {
    if (!(Math.abs(speedDeg) >= 1)) return Promise.resolve('rejected'); // скорость 0 — команда не выполняется
    const dir = Math.sign(speedDeg) * Math.sign(deg || 1);
    if (!Math.abs(deg)) return Promise.resolve('done');
    return this._set({ type: 'deg', speed: Math.abs(speedDeg), target: this.pos + dir * Math.abs(deg), waitable: true });
  }
  runToPos(targetAbsDeg, speedDeg) {
    if (!(Math.abs(speedDeg) >= 1)) return Promise.resolve('rejected');
    if (Math.abs(targetAbsDeg - this.pos) < 1) return Promise.resolve('done');
    return this._set({ type: 'deg', speed: Math.abs(speedDeg), target: targetAbsDeg, waitable: true });
  }
  /** Внешнее управление (синхронная ходовая): скорость и, при желании, опорное положение */
  track(vel, pos) {
    if (!this.cmd || this.cmd.type !== 'ext') this._set({ type: 'ext', vel: 0 });
    this.cmd.vel = vel; this.cmd.pos = pos;
    return this.cmd;
  }
  get relPos() { return this.pos - this.relZero; }
  get absPos() { let a = ((Math.round(this.pos) % 360) + 360) % 360; if (a > 180) a -= 360; return a; }
  get busy() { return !!(this.cmd && (this.cmd.type === 'time' || this.cmd.type === 'deg' || this.cmd.group)); }

  /** Перед шагом физики: вычислить выход регулятора. */
  update(dt, now) {
    const c = this.cmd;
    const sp = this.spec, kd = sp.stall / SIM.kdFull;
    let vel = 0, k = kd, max = sp.stall, ref = 0;
    const type = c ? c.type : 'stop';
    switch (type) {
      case 'run': case 'time': case 'ext': {
        if (type === 'time' && now >= c.end - T_EPS) { this._finish('done'); return this.update(dt, now); }
        let target = type === 'ext' ? (c.vel || 0) : c.speed;
        target = clamp(target, -this.maxDegS * 1.1, this.maxDegS * 1.1);
        if (type === 'ext') this.vRef = target;
        else {
          const up = Math.abs(target) > Math.abs(this.vRef) && Math.sign(target) === Math.sign(this.vRef || target);
          const a = this.accelDegS2(up ? this.accelPct : this.decelPct) * dt;
          this.vRef += clamp(target - this.vRef, -a, a);
        }
        if (type === 'ext' && c.pos !== undefined && c.pos !== null) this.pRef = c.pos;
        else this.pRef += this.vRef * dt;
        this.pRef = clamp(this.pRef, this.pos - 40, this.pos + 40);
        ref = this.vRef;
        vel = this.vRef + SIM.kp * (this.pRef - this.pos);
        break;
      }
      case 'deg': {
        c.t += dt;
        const [s, v] = c.prof.at(c.t);
        this.pRef = c.p0 + c.dir * s; this.vRef = c.dir * v;
        ref = this.vRef;
        vel = this.vRef + SIM.kp * (this.pRef - this.pos);
        const err = Math.abs(c.target - this.pos);
        if (c.t >= c.prof.T && (err < 2.5 || (err < SIM.degTol && Math.abs(this.actual) < 25))) {
          this._finish('done'); return this.update(dt, now);
        }
        // время вышло, а до цели далеко — это заклинивание, а не «готово»
        if (c.t >= c.prof.T + SIM.degTimeout) {
          if (err >= SIM.degTol) this.state = STATE.STALLED;
          this._finish(err < SIM.degTol ? 'done' : 'stalled'); return this.update(dt, now);
        }
        break;
      }
      case 'duty':
        vel = (c.duty / 100) * sp.free; k = sp.stall / sp.free; max = Math.abs(c.duty) / 100 * sp.stall; ref = vel;
        break;
      case 'coast':
        vel = 0; k = (sp.stall / sp.free) * 0.08; max = sp.stall * 0.04; this.vRef = 0;
        break;
      case 'hold': {
        // ПИ-удержание: интеграл убирает статическую ошибку под нагрузкой (рука с фишками).
        // Защита от накопления: в зоне ±holdDead интеграл не копится, а при насыщении выхода
        // не растёт дальше в ту же сторону (рука на упоре / ковш на коврике не давит 100 %).
        // Мягкая зона нечувствительности и для П-части: ковш, лежащий на коврике на сотые доли градуса
        // выше цели, не прижимается мотором (иначе реакция руки медленно сдвигает робота).
        // Цель за упором недостижима — держим у упора. Интеграл, давящий в упор, на котором рука уже
        // лежит, стравливается: упор держит сам, мотор не жмёт в него до конца матча.
        const lim = this.limits;
        const hp = lim ? clamp(this.holdPos, lim[0] + 0.3, lim[1] - 0.3) : this.holdPos;
        const e = hp - this.pos;
        const eD = Math.sign(e) * Math.max(0, Math.abs(e) - SIM.holdDead);
        const sat = c.sat && Math.sign(c.sat) === Math.sign(e);
        if (eD !== 0 && !sat) c.i = clamp((c.i || 0) + eD * dt, -12, 12);
        if (lim && c.i && ((c.i < 0 && this.pos <= lim[0] + 1) || (c.i > 0 && this.pos >= lim[1] - 1))) c.i *= Math.max(0, 1 - dt / SIM.limitBleed);
        vel = SIM.kp * eD + SIM.ki * (c.i || 0); this.vRef = 0; ref = 0;
        break;
      }
      case 'stop': default:
        vel = 0; k = kd * 0.6; max = sp.stall * 0.6; this.vRef = 0;
        break;
    }
    vel = clamp(vel, -sp.free * 1.25, sp.free * 1.25);
    // кривая момент-скорость: у холостого хода момент падает до нуля
    if (type !== 'coast' && type !== 'duty') {
      const along = Math.sign(vel) * this.actual;
      max = Math.min(max, sp.stall * clamp(1 - Math.max(0, along) / sp.free, 0.1, 1));
    }
    this.cmdSpeed = ref;
    this.out.vel = vel; this.out.kd = k; this.out.max = max;
    const tq = clamp(k * (vel - this.actual), -max, max);
    if (type === 'hold') c.sat = Math.abs(tq) >= max * 0.98 ? Math.sign(tq) : 0;
    this.power = Math.round(tq / sp.stall * 100);
  }

  /** После шага физики: фактическая скорость (°/с) и, если известен, угол энкодера. */
  measure(actualDegS, dt, posDeg) {
    this.actual = actualDegS;
    if (posDeg === undefined) this.pos += actualDegS * dt; else this.pos = posDeg;
    const c = this.cmd;
    const type = c ? c.type : 'stop';
    const moving = type === 'run' || type === 'time' || type === 'deg' || type === 'ext';
    // заклинивание: регулятор требует движения (профиль или догон отставания), а вал почти стоит.
    // Не зависит от фазы профиля: упор в конце торможения тоже ловится.
    const lag = Math.abs(this.pRef - this.pos);
    const want = Math.max(Math.abs(this.vRef), SIM.kp * Math.min(lag, 30));
    const thr = Math.max(Math.min(20, 0.5 * want), 0.15 * Math.abs(this.vRef));
    let blocked = moving && want > 5 && Math.abs(actualDegS) < thr && lag > 3;
    if (blocked && type === 'deg' && Math.abs(c.target - this.pos) < 3) blocked = false;
    if (blocked) this.stallT += dt;
    else this.stallT = Math.max(0, this.stallT - 2 * dt);
    if (this.stallT > SIM.stallTime) {
      this.state = STATE.STALLED;
      if (type === 'deg' || type === 'time') this._finish('stalled');
    } else if (type === 'stop' || type === 'coast') this.state = STATE.READY;
    else if (type === 'hold') this.state = STATE.HOLDING;
    else if (type === 'duty') this.state = STATE.DC_RUNNING;
    else if (c) { if (this.state !== STATE.STALLED || this.stallT === 0) this.state = STATE.RUNNING; }
    else this.state = STATE.READY;
  }
}

/** Виртуальный привод без тела Rapier (моторы Grand Tree, Hive): инерция + трение + внешняя нагрузка. */
export class VirtualDrive {
  constructor(motor, { inertia = 0.6, friction = 40 } = {}) {
    this.m = motor; this.J = inertia; this.fr = friction;
    this.w = 0; this.angle = 0; this.load = 0; // °/с, °, момент нагрузки
  }
  reset() { this.w = 0; this.angle = 0; this.load = 0; }
  step(dt) {
    const o = this.m.out;
    const g = (180 / Math.PI) * dt / this.J; // момент -> приращение °/с
    // неявный шаг регулятора (жёсткая петля устойчива при любом dt), затем насыщение
    const wi = (this.w + g * (o.kd * o.vel - this.load)) / (1 + g * o.kd);
    let tq = clamp(o.kd * (o.vel - wi), -o.max, o.max) - this.load;
    // сухое трение редуктора
    if (Math.abs(this.w) < 2 && Math.abs(tq) <= this.fr) { this.w = 0; }
    else {
      let w = this.w + g * (tq - this.fr * Math.sign(this.w || tq));
      if (this.w !== 0 && Math.sign(w) !== Math.sign(this.w) && Math.abs(tq) <= this.fr) w = 0;
      this.w = w;
    }
    this.angle += this.w * dt;
    this.m.measure(this.w, dt, this.angle);
  }
}
