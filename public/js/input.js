// Ввод: клавиатура (KeyboardEvent.code — раскладка не важна), реестр источников (геймпады, сеть) -> TeamInput на команду.
//
// TeamInput = {
//   drive: { fwd, turn },          // −1..1: вперёд (+) / назад, поворот влево (+) / вправо
//   arm,                           // −1..1: рука вверх (+) / вниз — прямой ввод мотора (Technician)
//   tree,                          // −1..1: мотор Grand Tree (Specialist)
//   recycle,                       // true на один опрос: Specialist отправляет фишки в Token Recycler
//   levers: { driver: [L, R], specialist: [L, R] },  // рычаги пультов, −100..100 %
//   slow,                          // медленный режим ручного управления
// }
//
// Схема A (команда, выбранная в шапке): W/S/A/D или стрелки — ехать, R/F — рука, G — дерево (Shift+G — назад),
// H — recycler, Shift — медленно. Пока программа команды работает, клавиши — рычаги пультов:
// Driver: W/S — левый, ↑/↓ — правый; Specialist: R/F — левый, T/G — правый.
// Схема B (вторая команда, включается флажком): I/K/J/L — ехать, U/O — рука, Y — дерево (правый Shift+Y — назад),
// N — recycler, правый Shift — медленно; с программой: I/K — левый рычаг Driver, O/L — правый.
// При двух игроках левый Shift — только схема A, правый — только схема B.
// Клавишу, которую забрал элемент интерфейса в фокусе (стрелки во вкладках и т. п.), робот не получает.
//
// Рука — мотор инструмента Technician (правила 14, 17, 18). В тренировке — любой ввод. В матче без программы:
// пульт Driver (геймпад) руку не двигает; клавиатура и экранный джойстик — прямой ввод Technician, только пока
// робот целиком в зоне Technician (input.armDirect(side), можно заменить). Иначе руку двигает программа.
//
// Источники: input.addSource(fn), где fn(dt) -> { red?: Partial<TeamInput>, blue?: Partial<TeamInput> } | null.
// Источник может вернуть levers сам (геймпад в режиме программы); если levers нет, а программа команды
// работает, рычаги Driver получаются из drive (танковое смешение). Сеть: input.setRemote(side, TeamInput|null).
//
// Геймпады (gamepad.js): input.gamepads — назначение «геймпад -> команда/роль», источник ввода, вибрация.
// Экранные джойстики (только на сенсорных экранах, TouchControls): input.touch — ввод команды из шапки.
// Панель «Геймпады и сенсорный экран» — на вкладке «Миссии», значок 🎮 — на поле, справка — во вкладке «Справка».

import { GamepadManager, radialDeadzone, curve, TEAMS, ROLES, DRIVES } from './gamepad.js';
import { L, toMap, inRect } from './layout.js';

export const SIDES = ['red', 'blue'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const LEVER_RAMP = 400; // %/с — скорость «отклонения» рычага с клавиатуры

/** Пустой TeamInput */
export function emptyInput() {
  return { drive: { fwd: 0, turn: 0 }, arm: 0, tree: 0, recycle: false, levers: { driver: [0, 0], specialist: [0, 0] }, slow: false };
}

/** Фокус в поле ввода/редакторе — клавиши не перехватываем */
export function isTypingTarget(t) {
  if (!t || t === window || t === document) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable || !!(t.closest && t.closest('.CodeMirror'));
}
/** Фокус на кнопке/ссылке — Space/Enter нажмут её, горячие клавиши не трогаем */
export const isControlTarget = (t) => !!(t && t.tagName && (t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'SUMMARY'));

// клавиши, у которых гасим действие браузера (прокрутка страницы)
const NO_SCROLL = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
// составные элементы (ARIA), которым принадлежат стрелки: вкладки, радиогруппы, списки, меню, ползунки
const ARROW_WIDGETS = '[role="tablist"],[role="radiogroup"],[role="listbox"],[role="menu"],[role="menubar"],'
  + '[role="tree"],[role="treegrid"],[role="grid"],[role="slider"],[role="spinbutton"],[role="toolbar"]';

/**
 * Клавишу забрал элемент интерфейса в фокусе — роботу её не отдаём:
 * обработчик элемента уже отменил действие (вкладки по стрелкам, конструктор) или стрелка нажата
 * в составном элементе, который ходит по стрелкам. На обычной кнопке стрелки и WASD по-прежнему ведут робота.
 */
export function isWidgetKey(e) {
  if (!e) return false;
  if (e.defaultPrevented) return true;
  const t = e.target;
  return ARROWS.has(e.code) && !!(t && typeof t.closest === 'function' && t.closest(ARROW_WIDGETS));
}

/** Робот команды side целиком в её зоне Technician (та же проверка, что у inspection) */
export function robotInTechArea(sim, side) {
  const r = sim && sim.robots && sim.robots[side];
  if (!r || typeof r.hullWorld !== 'function') return false;
  try {
    const pts = r.hullWorld();
    if (!pts.length) return false;
    for (const p of pts) if (!inRect(L.techArea, toMap(p.x, p.z, side), 0.5)) return false;
    return true;
  } catch { return false; } // робот пересобирается
}

const SCHEME_A = {
  fwd: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  armUp: ['KeyR'], armDown: ['KeyF'], tree: ['KeyG'], recycle: 'KeyH', slow: ['ShiftLeft', 'ShiftRight'],
  // рычаги в режиме программы
  dL: [['KeyW'], ['KeyS']], dR: [['ArrowUp'], ['ArrowDown']],
  sL: [['KeyR'], ['KeyF']], sR: [['KeyT'], ['KeyG']],
};
const SCHEME_B = {
  fwd: ['KeyI'], back: ['KeyK'], left: ['KeyJ'], right: ['KeyL'],
  armUp: ['KeyU'], armDown: ['KeyO'], tree: ['KeyY'], recycle: 'KeyN', slow: ['ShiftRight'],
  dL: [['KeyI'], ['KeyK']], dR: [['KeyO'], ['KeyL']],
  sL: null, sR: null,
};
/** Коды клавиш, занятые схемами (для подсказок и проверки) */
export const KEYMAP = { A: SCHEME_A, B: SCHEME_B };

export class InputHub {
  constructor(app) {
    this.app = app;
    this.keys = new Set();              // нажатые KeyboardEvent.code
    this.team = 'red';                  // команда схемы A
    this.scheme2 = false;               // схема B для второй команды
    this.frozen = false;                // весь ввод заблокирован (конец матча)
    this.blocked = { red: false, blue: false }; // ввод команды заблокирован политикой
    this.sources = [];
    this.remote = { red: null, blue: null };
    this.last = { red: emptyInput(), blue: emptyInput() };
    this._lev = { red: { driver: [0, 0], specialist: [0, 0] }, blue: { driver: [0, 0], specialist: [0, 0] } };
    this._recycle = { red: 0, blue: 0 };
    // программа команды работает: локально — раннер; у гостя онлайн — состояние хоста в app.state.prog
    this.programMode = (side) => {
      const r = app.runners && app.runners[side];
      if (r && r.running) return true;
      return app.stepAuthority === false && !!(app.state && app.state.prog && app.state.prog[side] === 'running');
    };
    // прямой ввод мотора руки (инструмент Technician) без программы: в тренировке — всегда; в матче — только
    // пока робот целиком в зоне Technician (Technician трогает свой инструмент только в своей зоне, правила 14, 17).
    // Модуль судьи может заменить эту политику.
    this.armDirect = (side) => !this.isMatch() || robotInTechArea(app.sim, side);
    // почему последний опрос погасил руку: { red, blue } = 'driver' | 'area' | false (подсказка на поле)
    this.armDenied = { red: false, blue: false };
    this._onDown = (e) => this.keydown(e);
    this._onUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => this.keys.clear();
    window.addEventListener('keydown', this._onDown);
    window.addEventListener('keyup', this._onUp);
    window.addEventListener('blur', this._onBlur);
    this._onVis = () => { if (document.hidden) this.keys.clear(); };
    document.addEventListener('visibilitychange', this._onVis);
  }

  // ---------- клавиатура ----------
  keydown(e) {
    if (isTypingTarget(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const code = e.code;
    if (!code) return;
    if (isWidgetKey(e)) return; // стрелки во вкладках и т. п. — только элементу интерфейса
    if (NO_SCROLL.has(code) && !isControlTarget(e.target)) e.preventDefault();
    if (!e.repeat) {
      if (code === SCHEME_A.recycle) this._recycle[this.team]++;
      else if (this.scheme2 && code === SCHEME_B.recycle) this._recycle[this.otherTeam]++;
    }
    this.keys.add(code);
  }
  get otherTeam() { return this.team === 'red' ? 'blue' : 'red'; }
  /** Режим матча: действуют ограничения ролей */
  isMatch() { const st = this.app && this.app.state; return !!(st && st.mode === 'match'); }
  down(list) { if (!list) return false; for (const k of list) if (this.keys.has(k)) return true; return false; }
  axis(pos, neg) { return (this.down(pos) ? 1 : 0) - (this.down(neg) ? 1 : 0); }

  /** Установить команду схемы A */
  setTeam(side) { if (SIDES.includes(side) && side !== this.team) { this.team = side; this.keys.clear(); } }
  setScheme2(on) { this.scheme2 = !!on; }

  /** Ввод одной схемы клавиатуры для команды side */
  _keyboard(side, S, dt) {
    const ti = emptyInput();
    // Shift игрока: при двух игроках левый — схема A, правый — схема B (медленно и «дерево назад»)
    const shiftKeys = S === SCHEME_A && this.scheme2 ? ['ShiftLeft'] : S.slow;
    ti.slow = this.down(shiftKeys);
    if (this._recycle[side] > 0) { ti.recycle = true; this._recycle[side] = 0; }
    const lv = this._lev[side];
    if (this.programMode(side)) {
      // рычаги пультов с плавным отклонением
      const ramp = LEVER_RAMP * dt;
      const go = (arr, i, pair) => {
        const target = pair ? 100 * this.axis(pair[0], pair[1]) : 0;
        arr[i] += clamp(target - arr[i], -ramp, ramp);
      };
      go(lv.driver, 0, S.dL); go(lv.driver, 1, S.dR);
      go(lv.specialist, 0, S.sL); go(lv.specialist, 1, S.sR);
      ti.levers = { driver: [lv.driver[0], lv.driver[1]], specialist: [lv.specialist[0], lv.specialist[1]] };
      ti._levers = true;
    } else {
      lv.driver[0] = lv.driver[1] = lv.specialist[0] = lv.specialist[1] = 0;
      ti.drive.fwd = this.axis(S.fwd, S.back);
      ti.drive.turn = this.axis(S.left, S.right);
      ti.arm = this.axis(S.armUp, S.armDown);
      if (this.down(S.tree)) ti.tree = this.down(shiftKeys) ? -1 : 1;
      if (ti.tree) ti.slow = false; // Shift+G (правый Shift+Y) — дерево назад, а не «медленно»
    }
    return ti;
  }

  // ---------- реестр источников ----------
  /** Добавить источник ввода. fn(dt) -> { red?, blue? } частичных TeamInput. Возвращает функцию удаления. */
  addSource(fn) {
    if (typeof fn !== 'function') throw new TypeError('input.addSource: нужна функция');
    this.sources.push(fn);
    return () => { this.sources = this.sources.filter((f) => f !== fn); };
  }
  /** Ввод удалённого игрока (онлайн): TeamInput или null */
  setRemote(side, ti) { if (SIDES.includes(side)) this.remote[side] = ti || null; }

  /** Опрос всех источников -> { red: TeamInput, blue: TeamInput } (вызывается раз в кадр) */
  poll(dt) {
    const res = { red: emptyInput(), blue: emptyInput() };
    const had = { red: false, blue: false };
    const padDenied = { red: false, blue: false };
    const add = (side, p) => {
      if (!p) return;
      mergeInto(res[side], p);
      if (p._levers || hasLevers(p)) had[side] = true;
      if (p._armDenied) padDenied[side] = true;
    };
    // онлайн-хост: командой, за которую играет гость (есть удалённый ввод), клавиатура хоста не управляет
    const kbA = this._keyboard(this.team, SCHEME_A, dt);
    if (!this.remote[this.team]) add(this.team, kbA);
    if (this.scheme2) { const kbB = this._keyboard(this.otherTeam, SCHEME_B, dt); if (!this.remote[this.otherTeam]) add(this.otherTeam, kbB); }
    else this._recycle[this.otherTeam] = 0;
    for (const fn of this.sources) {
      let out = null;
      try { out = fn(dt, this); } catch (e) { console.error('Источник ввода:', e); }
      if (out) for (const s of SIDES) add(s, out[s]);
    }
    const localArm = { red: res.red.arm, blue: res.blue.arm }; // подсказку показываем только своим игрокам
    for (const s of SIDES) add(s, this.remote[s]);
    for (const s of SIDES) {
      const ti = res[s];
      ti.drive.fwd = clamp(ti.drive.fwd, -1, 1); ti.drive.turn = clamp(ti.drive.turn, -1, 1);
      ti.arm = clamp(ti.arm, -1, 1); ti.tree = clamp(ti.tree, -1, 1);
      // рука — инструмент Technician: в матче без программы прямой ввод только в зоне Technician
      let denied = padDenied[s] ? 'driver' : false;
      if (ti.arm && !this.programMode(s) && !this._armAllowed(s)) {
        if (localArm[s]) denied = 'area';
        ti.arm = 0;
      }
      this.armDenied[s] = this.frozen || this.blocked[s] ? false : denied;
      // рычаги из «езды», если источник их не дал, а программа работает
      if (!had[s] && this.programMode(s) && (ti.drive.fwd || ti.drive.turn)) {
        ti.levers.driver = [(ti.drive.fwd - ti.drive.turn) * 100, (ti.drive.fwd + ti.drive.turn) * 100];
      }
      for (const role of ['driver', 'specialist']) ti.levers[role] = ti.levers[role].map((v) => clamp(Math.round(v * 10) / 10, -100, 100));
      if (this.frozen || this.blocked[s]) res[s] = emptyInput();
    }
    this.last = res;
    return res;
  }
  /** Последний результат опроса для команды */
  get(side) { return this.last[side] || emptyInput(); }
  /** Политика armDirect с защитой от ошибок (её могут заменить другие модули) */
  _armAllowed(side) {
    try { return typeof this.armDirect === 'function' ? !!this.armDirect(side) : true; } catch (e) { console.error('Политика руки:', e); return false; }
  }

  dispose() {
    window.removeEventListener('keydown', this._onDown);
    window.removeEventListener('keyup', this._onUp);
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('visibilitychange', this._onVis);
    for (const k of ['panel', 'touch', 'gamepads']) { try { if (this[k]) this[k].dispose(); } catch { /* уже снято */ } this[k] = null; }
  }
}

/** Источник дал рычаги: явный флаг _levers или хотя бы один ненулевой рычаг */
function hasLevers(p) {
  if (!p || !p.levers) return false;
  for (const role of ['driver', 'specialist']) { const l = p.levers[role]; if (Array.isArray(l) && (Number(l[0]) || Number(l[1]))) return true; }
  return false;
}

/** Сложить частичный TeamInput в полный */
export function mergeInto(dst, p) {
  if (!p) return dst;
  if (p.drive) { dst.drive.fwd += Number(p.drive.fwd) || 0; dst.drive.turn += Number(p.drive.turn) || 0; }
  dst.arm += Number(p.arm) || 0;
  dst.tree += Number(p.tree) || 0;
  if (p.recycle) dst.recycle = true;
  if (p.slow) dst.slow = true;
  if (p.levers) for (const role of ['driver', 'specialist']) {
    const l = p.levers[role];
    if (Array.isArray(l)) { dst.levers[role][0] += Number(l[0]) || 0; dst.levers[role][1] += Number(l[1]) || 0; }
  }
  return dst;
}

// ======================= экранные джойстики (телефоны, планшеты) =======================

const TEAM_RU = { red: 'Красная', blue: 'Синяя' };
const TOUCH_MODES = ['auto', 'on', 'off'];
const TOUCH_DZ = 0.08; // палец точнее стика — мёртвая зона меньше

/**
 * Экранные джойстики поверх 3D-поля. Корень .tc пропускает касания (pointer-events: none),
 * ловят только сами джойстики и кнопки — жесты камеры вне них работают как обычно.
 * Без программы: левый — езда (вверх — вперёд, в стороны — поворот), правый — рука (вверх/вниз),
 * кнопки — программа, медленно, дерево ▲/▼, Recycler. С программой: оси Y — рычаги пульта (Driver или Specialist).
 * Джойстики полупрозрачные; кнопка 🕹 слева вверху поля сворачивает их (поле видно целиком).
 */
export class TouchControls {
  constructor(hub, app) {
    this.hub = hub; this.app = app;
    const st = app.store;
    const m = st ? st.get('touchMode', 'auto') : 'auto';
    this.mode = TOUCH_MODES.includes(m) ? m : 'auto';
    this.leverRole = st && st.get('touchLevers', 'driver') === 'specialist' ? 'specialist' : 'driver';
    this.collapsed = !!(st && st.get('touchHidden', false) === true); // свёрнуты кнопкой 🕹
    this.L = { x: 0, y: 0, id: null, dx: 0, dy: 0 };
    this.R = { x: 0, y: 0, id: null, dx: 0, dy: 0 };
    this.hold = { treeF: false, treeB: false };
    this.slow = false;
    this._recycle = 0;
    this._key = '';
    this.listeners = new Set();
    this.mq = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
    this._onMq = () => this.refresh();
    if (this.mq) { if (this.mq.addEventListener) this.mq.addEventListener('change', this._onMq); else if (this.mq.addListener) this.mq.addListener(this._onMq); }
    this._offs = [];
    this.stage = document.querySelector('.stage') || (document.getElementById('viewport') || {}).parentElement || null;
    this.root = this.stage ? this._build() : null;
    this._onBlur = () => this.release();
    window.addEventListener('blur', this._onBlur);
    this._onVis = () => { if (document.hidden) this.release(); };
    document.addEventListener('visibilitychange', this._onVis);
    if (typeof app.on === 'function') {
      this._offs.push(app.on('matchStart', () => this.buzz([200])));
      this._offs.push(app.on('matchEnd', () => this.buzz([200, 120, 400])));
    }
    /** Источник для input.addSource */
    this.source = (dt) => this.poll(dt);
    this.refresh();
  }

  /** Экран сенсорный (основной указатель — палец) */
  get coarse() { return !!(this.mq && this.mq.matches); }
  /** Экранное управление включено (по режиму и типу экрана); свёрнутое — тоже */
  get visible() { return !!this.root && (this.mode === 'on' || (this.mode === 'auto' && this.coarse)); }
  /** Джойстики на поле и управляют роботом (включены и не свёрнуты) */
  get shown() { return this.visible && !this.collapsed; }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  /** Свернуть (true) или вернуть (false) джойстики; поле остаётся видно целиком */
  setCollapsed(on) {
    this.collapsed = !!on;
    if (this.app.store) this.app.store.set('touchHidden', this.collapsed);
    this.refresh();
    return this.collapsed;
  }

  /** 'auto' — только на сенсорных экранах, 'on' — всегда, 'off' — выключены */
  setMode(m) {
    if (!TOUCH_MODES.includes(m)) return this.mode;
    this.mode = m;
    if (this.app.store) this.app.store.set('touchMode', m);
    this.refresh();
    return m;
  }
  setLeverRole(r) {
    this.leverRole = r === 'specialist' ? 'specialist' : 'driver';
    if (this.app.store) this.app.store.set('touchLevers', this.leverRole);
    this._key = '';
    return this.leverRole;
  }
  refresh() {
    const v = this.visible;
    if (this.root) {
      this.root.hidden = !v;
      this.root.classList.toggle('min', this.collapsed);
      const t = this.root.querySelector('.tc-hide');
      if (t) {
        t.querySelector('small').textContent = this.collapsed ? 'джойстики' : 'скрыть';
        t.title = this.collapsed ? 'Показать экранные джойстики' : 'Скрыть экранные джойстики — поле видно целиком';
        t.classList.toggle('on', this.collapsed);
      }
    }
    if (this.stage) this.stage.classList.toggle('touch-on', v);
    if (!this.shown) this.release();
    this._key = '';
    for (const fn of [...this.listeners]) { try { fn(v); } catch (e) { console.error(e); } }
  }
  /** Отпустить всё (палец ушёл с экрана, вкладка скрыта) */
  release() {
    for (const s of [this.L, this.R]) { s.id = null; s.x = s.y = s.dx = s.dy = 0; }
    this.hold.treeF = this.hold.treeB = false;
    if (!this.root) return;
    for (const el of this.root.querySelectorAll('.tc-stick')) { el.classList.remove('on'); this._knob(el, 0, 0); }
    for (const el of this.root.querySelectorAll('[data-hold]')) el.classList.remove('on');
  }

  _build() {
    const root = document.createElement('div');
    root.className = 'tc';
    root.hidden = true;
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Экранное управление роботом');
    root.innerHTML = `
      <div class="tc-stick tc-left" data-stick="L"><span class="tc-cap">Езда</span><i class="tc-knob"></i></div>
      <div class="tc-stick tc-right" data-stick="R"><span class="tc-cap">Рука</span><i class="tc-knob"></i></div>
      <div class="tc-btns">
        <button type="button" class="tc-btn" data-act="run" title="Запустить или остановить программу команды"><b>▶</b><small>прогр.</small></button>
        <button type="button" class="tc-btn" data-act="slow" aria-pressed="false" title="Медленный режим"><b>½</b><small>медл.</small></button>
        <button type="button" class="tc-btn" data-hold="treeF" title="Мотор Grand Tree вперёд (держать)"><b>▲</b><small>дерево</small></button>
        <button type="button" class="tc-btn" data-hold="treeB" title="Мотор Grand Tree назад (держать)"><b>▼</b><small>дерево</small></button>
        <button type="button" class="tc-btn" data-act="recycle" title="Token Recycler: фишки из зоны Specialist"><b>♻</b><small>recycler</small></button>
        <button type="button" class="tc-btn" data-act="role" title="Чей пульт — Driver или Specialist"><b>D</b><small>пульт</small></button>
      </div>
      <button type="button" class="tc-hide" title="Скрыть экранные джойстики — поле видно целиком"><span aria-hidden="true">🕹</span><small>скрыть</small></button>`;
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    root.querySelector('.tc-hide').addEventListener('click', () => this.setCollapsed(!this.collapsed));
    for (const el of root.querySelectorAll('.tc-stick')) this._bindStick(el, el.dataset.stick === 'L' ? this.L : this.R);
    for (const el of root.querySelectorAll('[data-hold]')) this._bindHold(el, el.dataset.hold);
    root.querySelector('[data-act="run"]').addEventListener('click', () => this._toggleProgram());
    root.querySelector('[data-act="slow"]').addEventListener('click', (e) => {
      this.slow = !this.slow;
      e.currentTarget.classList.toggle('on', this.slow);
      e.currentTarget.setAttribute('aria-pressed', String(this.slow));
    });
    root.querySelector('[data-act="recycle"]').addEventListener('click', () => { this._recycle++; });
    root.querySelector('[data-act="role"]').addEventListener('click', () => this.setLeverRole(this.leverRole === 'driver' ? 'specialist' : 'driver'));
    // палец, ушедший за пределы джойстика, ведём по окну (захват указателя может не сработать)
    this._onMove = (e) => { this._move(this.L, e); this._move(this.R, e); };
    this._onUp = (e) => { this._end(this.L, e.pointerId); this._end(this.R, e.pointerId); };
    window.addEventListener('pointermove', this._onMove, { passive: false });
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
    this.stage.appendChild(root);
    return root;
  }
  _knob(el, px, py) {
    const k = el.querySelector('.tc-knob');
    if (k) { k.style.setProperty('--kx', `${px.toFixed(1)}px`); k.style.setProperty('--ky', `${py.toFixed(1)}px`); }
  }
  _bindStick(el, s) {
    s.el = el;
    el.addEventListener('pointerdown', (e) => {
      if (s.id !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      s.id = e.pointerId;
      try { el.setPointerCapture(e.pointerId); } catch { /* синтетическое касание — ведём по окну */ }
      el.classList.add('on');
      e.preventDefault(); e.stopPropagation();
      this._move(s, e);
    });
    el.addEventListener('lostpointercapture', (e) => this._end(s, e.pointerId));
  }
  _move(s, e) {
    if (s.id === null || e.pointerId !== s.id || !s.el) return;
    const r = s.el.getBoundingClientRect();
    const R = Math.max(10, r.width * 0.36);           // ход ручки
    let dx = (e.clientX - (r.left + r.width / 2)) / R, dy = (e.clientY - (r.top + r.height / 2)) / R;
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    const [x, y] = radialDeadzone(dx, dy, TOUCH_DZ);
    s.x = x; s.y = -y; s.dx = dx; s.dy = dy;           // вверх = +
    this._knob(s.el, dx * R, dy * R);
    if (e.cancelable) e.preventDefault();
  }
  _end(s, id) {
    if (s.id === null || id !== s.id) return;
    s.id = null; s.x = s.y = s.dx = s.dy = 0;
    if (s.el) { s.el.classList.remove('on'); this._knob(s.el, 0, 0); }
  }
  _bindHold(el, key) {
    const off = () => { this.hold[key] = false; el.classList.remove('on'); };
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      this.hold[key] = true; el.classList.add('on');
      try { el.setPointerCapture(e.pointerId); } catch { /* синтетическое касание */ }
      e.preventDefault();
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, off);
  }
  _running(side) {
    const app = this.app;
    return !!((app.runners && app.runners[side] && app.runners[side].running) || (app.state && app.state.prog && app.state.prog[side] === 'running'));
  }
  _toggleProgram() {
    const side = this.hub.team, app = this.app;
    if (this.hub.blocked[side]) return;
    try {
      const r = this._running(side) ? app.stopProgram && app.stopProgram(side) : app.runProgram && app.runProgram(side);
      if (r && typeof r.catch === 'function') r.catch((e) => console.error('Программа:', e));
    } catch (e) { console.error('Программа:', e); }
  }
  /** Вибрация телефона (если разрешена после касания) */
  buzz(pattern) {
    if (!this.visible || typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
    try {
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return false;
      return navigator.vibrate(pattern);
    } catch { return false; }
  }
  /** Подписи и кнопки по режиму (программа / ручное), команда — цвет рамок */
  _sync(side, prog, armOk) {
    const running = this._running(side);
    const key = `${side}|${prog}|${running}|${this.leverRole}|${armOk}`;
    if (key === this._key || !this.root) return;
    this._key = key;
    const root = this.root;
    root.classList.toggle('blue', side === 'blue');
    root.classList.toggle('prog', prog);
    const role = this.leverRole === 'driver' ? 'Driver' : 'Specialist';
    root.querySelector('.tc-left .tc-cap').textContent = prog ? `${role}: левый` : 'Езда';
    const right = root.querySelector('.tc-right');
    // в матче вне зоны Technician рука — только программой (правила 14, 17, 18)
    right.querySelector('.tc-cap').textContent = prog ? `${role}: правый` : armOk ? 'Рука' : 'Рука: программой';
    right.classList.toggle('off', !prog && !armOk);
    const run = root.querySelector('[data-act="run"]');
    run.querySelector('b').textContent = running ? '■' : '▶';
    run.classList.toggle('on', running);
    root.querySelector('[data-act="role"] b').textContent = this.leverRole === 'driver' ? 'D' : 'S';
    root.setAttribute('aria-label', `Экранное управление: ${TEAM_RU[side]} команда`);
  }
  /** Опрос (раз в кадр) -> { [команда из шапки]: частичный TeamInput } */
  poll() {
    if (!this.shown) { this._recycle = 0; return null; }
    const side = this.hub.team;
    const prog = !!this.hub.programMode(side);
    this._sync(side, prog, prog || this.hub._armAllowed(side));
    const p = emptyInput();
    if (prog) {
      p.levers[this.leverRole] = [Math.round(this.L.y * 1000) / 10, Math.round(this.R.y * 1000) / 10];
      p._levers = true;
    } else {
      p.drive.fwd = curve(this.L.y); p.drive.turn = curve(-this.L.x);
      p.arm = curve(this.R.y);
      p.tree = (this.hold.treeF ? 1 : 0) - (this.hold.treeB ? 1 : 0);
      p.slow = this.slow;
    }
    if (this._recycle > 0) { p.recycle = true; this._recycle = 0; }
    return { [side]: p };
  }
  dispose() {
    if (this.mq) { if (this.mq.removeEventListener) this.mq.removeEventListener('change', this._onMq); else if (this.mq.removeListener) this.mq.removeListener(this._onMq); }
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('visibilitychange', this._onVis);
    if (this._onMove) { window.removeEventListener('pointermove', this._onMove); window.removeEventListener('pointerup', this._onUp); window.removeEventListener('pointercancel', this._onUp); }
    for (const off of this._offs) { try { off(); } catch { /* уже отписан */ } }
    if (this.root) this.root.remove();
    if (this.stage) this.stage.classList.remove('touch-on');
    this.root = null;
    this.listeners.clear();
  }
}

// ======================= панель «Геймпады и сенсорный экран» =======================

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ROLE_RU = { driver: 'Driver — ходовая и рука', specialist: 'Specialist — дерево и Recycler', off: 'Не использовать' };
const ROLE_SHORT = { driver: 'D', specialist: 'S', off: '–' };
const DRIVE_RU = { split: 'Левый стик + правый стик', arcade: 'Аркада: всё на левом стике' };
const LAYOUT_RU = { standard: 'стандартная раскладка', axes6: 'раскладка угадана (курки на осях)', generic: 'нестандартная раскладка — кнопки могут не совпасть' };
const MAP_RU = {
  driver: (c) => (c.drive === 'arcade'
    ? 'Левый стик — езда (вверх — вперёд, в стороны — поворот), правый стик или RT/LT — рука (только в тренировке), LB — медленно, крестовина — точно, Start — программа.'
    : 'Левый стик ↕ — вперёд/назад, правый стик ↔ — поворот, RT/LT — рука (только в тренировке), LB — медленно, крестовина — точно, Start — программа.'),
  specialist: () => 'RT/LT или левый стик ↕ — мотор Grand Tree, A — Token Recycler, Start — программа.',
  off: () => 'Геймпад ничем не управляет.',
};
const VIZ_BTNS = [['a', 'A'], ['b', 'B'], ['x', 'X'], ['y', 'Y'], ['lb', 'LB'], ['rb', 'RB'], ['back', 'Back'], ['start', 'Start']];

/** Справка по геймпаду и экранным джойстикам (вкладки «Миссии» и «Справка») */
export const CONTROLS_HELP_HTML = `
<ul>
  <li>Подключите геймпад (Xbox, PlayStation или совместимый) по USB или Bluetooth и <b>нажмите на нём любую кнопку</b> — браузер показывает геймпад только после нажатия. Нужен HTTPS или localhost; лучше всего работают Chrome и Edge.</li>
  <li>У каждого геймпада своя команда и роль (вкладка «Миссии» → «Геймпады»). По умолчанию 1-й — Driver команды из шапки, 2-й — Specialist этой команды, 3-й и 4-й — другая команда.</li>
  <li><b>Driver</b> без программы: левый стик вверх/вниз — вперёд/назад, правый стик влево/вправо — поворот (режим «Аркада» — всё на левом стике); <kbd>LB</kbd> — медленно; крестовина — точная езда. <kbd>RT</kbd>/<kbd>LT</kbd> (в «Аркаде» и правый стик) — рука вверх/вниз, <b>только в тренировке</b>.</li>
  <li><b>Рука в матче</b> — мотор инструмента Technician. Пульт Driver им не управляет (правило 14). Руку двигает программа на устройстве Specialist (правило 18) — она может читать рычаги пультов. Клавиши <kbd>R</kbd>/<kbd>F</kbd> и экранный джойстик «Рука» — прямой ввод Technician (правило 17): работают, только пока робот целиком в зоне Technician.</li>
  <li><b>Specialist</b> без программы: <kbd>RT</kbd>/<kbd>LT</kbd> или левый стик вверх/вниз — мотор Grand Tree вперёд/назад; <kbd>A</kbd> — Token Recycler (покоящиеся фишки из зоны Specialist). Driver отправлять фишки в Recycler не может.</li>
  <li>Обе роли: <kbd>Start</kbd> — запустить/остановить программу своей команды, <kbd>Back</kbd>/<kbd>Select</kbd> — вернуть вид камеры, <kbd>RB</kbd> — следующая камера.</li>
  <li>Пока программа команды работает, левый и правый стики (вверх/вниз) — рычаги пульта своей роли: <code>le.Controller()</code> у Driver, <code>connect(device_name='specialist')</code> у Specialist; <code>sensor.leftPercent</code> / <code>sensor.rightPercent</code>, вверх = +100.</li>
  <li>Вибрация (если её поддерживают геймпад и браузер): старт и конец матча, упор робота в борт или рука в упоре.</li>
  <li><b>Телефон и планшет</b>: на поле появляются полупрозрачные экранные джойстики команды из шапки. Левый — езда, правый — рука; кнопки: ▶/■ программа, ½ — медленно, ▲/▼ — дерево (держать), ♻ — Recycler. С программой джойстики — рычаги пульта, кнопка D/S выбирает пульт Driver или Specialist. Касания вне джойстиков вращают и приближают камеру как обычно. Кнопка <b>🕹 скрыть</b> слева вверху поля (под кнопками камер) сворачивает джойстики, чтобы поле было видно целиком; та же кнопка возвращает их.</li>
</ul>`;

export class InputPanel {
  constructor(hub, app) {
    this.hub = hub; this.app = app;
    this.gm = hub.gamepads; this.tc = hub.touch;
    this._offs = [];
    this._vizT = 0;
    this._toastT = 0;
    const pane = (app.ui && app.ui.panel && app.ui.panel('missions')) || document.getElementById('pane-missions');
    this.sec = pane ? this._buildSection(pane) : null;
    this.stage = document.querySelector('.stage');
    if (this.stage) {
      this.badge = document.createElement('button');
      this.badge.type = 'button'; this.badge.className = 'pad-badge'; this.badge.hidden = true;
      this.badge.title = 'Геймпады: назначение команд и ролей';
      this.badge.addEventListener('click', () => this.reveal());
      this.toast = document.createElement('div');
      this.toast.className = 'pad-toast'; this.toast.hidden = true; this.toast.setAttribute('role', 'status');
      this.stage.append(this.badge, this.toast);
    }
    this._addHelp();
    if (this.gm) this._offs.push(this.gm.on((type, slot) => this._onPad(type, slot)));
    if (this.tc) this._offs.push(this.tc.on(() => this._syncTouch()));
    if (typeof app.on === 'function') {
      this._offs.push(app.on('team', () => this.render()));
      this._offs.push(app.on('frame', (dt) => this._frame(dt)));
    }
    this.render();
  }

  _buildSection(pane) {
    const sec = document.createElement('section');
    sec.className = 'pads'; sec.id = 'padsPanel';
    sec.setAttribute('aria-labelledby', 'padsTitle');
    sec.innerHTML = `
      <h3 id="padsTitle">🎮 Геймпады и сенсорный экран</h3>
      <p class="hint" data-r="status"></p>
      <div class="pad-list" data-r="list"></div>
      <div class="pad-touch">
        <label class="field"><span>Экранные джойстики</span>
          <select data-r="touch">
            <option value="auto">Авто — на сенсорных экранах</option>
            <option value="on">Всегда показывать</option>
            <option value="off">Выключены</option>
          </select>
        </label>
        <p class="hint" data-r="touchHint"></p>
      </div>
      <details class="pad-help"><summary>Как управлять геймпадом и с экрана</summary>${CONTROLS_HELP_HTML}</details>`;
    pane.appendChild(sec);
    this.statusEl = sec.querySelector('[data-r="status"]');
    this.listEl = sec.querySelector('[data-r="list"]');
    this.touchSel = sec.querySelector('[data-r="touch"]');
    this.touchHint = sec.querySelector('[data-r="touchHint"]');
    this.touchSel.addEventListener('change', (e) => { if (this.tc) this.tc.setMode(e.target.value); });
    this.listEl.addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-k]'), card = e.target.closest('[data-index]');
      if (!sel || !card || !this.gm) return;
      this.gm.setConfig(Number(card.dataset.index), { [sel.dataset.k]: sel.value });
    });
    this.listEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-k="rumble"]'), card = e.target.closest('[data-index]');
      if (!b || !card || !this.gm) return;
      const ok = this.gm.rumble(Number(card.dataset.index), 'test', [{ ms: 300, strong: 0.9, weak: 0.9 }]);
      b.textContent = ok ? 'вибрация ✓' : 'вибрации нет';
    });
    return sec;
  }
  /** Справка: добавить раздел во вкладку «Справка» после клавиатуры */
  _addHelp() {
    const help = document.getElementById('pane-help');
    if (!help || help.querySelector('.pad-help-ref')) return;
    const box = document.createElement('div');
    box.className = 'pad-help-ref';
    box.innerHTML = `<h3>Геймпад и сенсорный экран</h3>${CONTROLS_HELP_HTML}`;
    const firstList = help.querySelector('h3 ~ ul');
    if (firstList) firstList.after(box); else help.prepend(box);
  }
  /** Открыть вкладку «Миссии» на панели геймпадов */
  reveal() {
    if (this.app.ui && this.app.ui.tab) this.app.ui.tab('missions');
    if (this.sec) { try { this.sec.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch { this.sec.scrollIntoView(); } }
  }
  _teamLabel(v) {
    const team = this.hub.team, other = team === 'red' ? 'blue' : 'red';
    if (v === 'auto') return `Из шапки (${TEAM_RU[team]})`;
    if (v === 'other') return `Другая (${TEAM_RU[other]})`;
    return TEAM_RU[v];
  }
  _onPad(type, slot) {
    if ((type === 'connect' || type === 'disconnect') && slot) {
      const d = this.gm.describe(slot.index);
      if (type === 'connect' && d) this.showToast(`🎮 ${d.name} → ${TEAM_RU[d.side]} · ${d.role === 'off' ? 'не используется' : d.role === 'driver' ? 'Driver' : 'Specialist'}`);
      else if (type === 'disconnect') this.showToast(`🎮 Геймпад ${slot.index + 1} отключён`);
    }
    if (type === 'change') this.render();
  }
  showToast(text) {
    if (!this.toast) return;
    this.toast.textContent = text;
    this.toast.hidden = false;
    this._toastT = 3;
  }
  _syncTouch() {
    if (!this.touchSel || !this.tc) return;
    this.touchSel.value = this.tc.mode;
    this.touchHint.textContent = !this.tc.visible
      ? (this.tc.coarse ? 'Джойстики выключены.' : 'Это не сенсорный экран: в режиме «Авто» джойстики скрыты.')
      : this.tc.collapsed
        ? 'Джойстики свёрнуты: кнопка «🕹 джойстики» слева вверху поля возвращает их.'
        : `Джойстики на поле управляют командой из шапки (${TEAM_RU[this.hub.team].toLowerCase()}). Кнопка «🕹 скрыть» слева вверху поля их сворачивает.`;
  }
  /** Подсказка, почему рука не двигается (в матче — правила 14, 17, 18); раз на нажатие */
  _armHint() {
    const d = this.hub.armDenied || {};
    const side = d[this.hub.team] ? this.hub.team : SIDES.find((s) => d[s]);
    const why = side ? d[side] : false;
    if (why && why !== this._armWhy) {
      this.showToast(why === 'driver'
        ? '🎮 Пульт Driver не управляет рукой — это инструмент Technician (правило 14). В матче руку двигает программа.'
        : `${TEAM_RU[side]}: рука — инструмент Technician. В матче её двигает программа (правило 18); вручную — только пока робот целиком в зоне Technician (правило 17).`);
    }
    this._armWhy = why;
  }
  /** Перерисовать список геймпадов, значок и статус */
  render() {
    const gm = this.gm;
    const list = gm ? gm.list() : [];
    if (this.statusEl) {
      let t;
      if (!gm || !gm.supported) t = gm && gm.insecure ? 'Геймпад работает только по HTTPS или на localhost — откройте сайт по https://.' : 'Этот браузер не поддерживает геймпады (Gamepad API). Клавиатура и экранные джойстики работают.';
      else if (gm.error) t = gm.error;
      else if (!list.length) t = 'Геймпад не найден. Подключите его и нажмите любую кнопку — до первого нажатия браузер геймпад не показывает.';
      else t = `Подключено: ${list.length}. Назначение запоминается по номеру геймпада.`;
      this.statusEl.textContent = t;
    }
    if (this.listEl) {
      this.listEl.innerHTML = list.map((p) => {
        const c = gm.config(p.index);
        const opt = (vals, cur, lab) => vals.map((v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(lab(v))}</option>`).join('');
        return `<div class="pad-card ${p.role === 'off' ? 'off' : p.side}" data-index="${p.index}">
          <div class="pad-head"><span class="pad-num">${p.index + 1}</span><span class="pad-name" title="${esc(p.id)}">${esc(p.name)}</span>
            <span class="pad-tag">${esc(LAYOUT_RU[p.layout] || '')}${p.vibration ? ' · вибрация' : ''}</span></div>
          <div class="pad-row">
            <label class="field"><span>Команда</span><select data-k="team">${opt(TEAMS, c.team, (v) => this._teamLabel(v))}</select></label>
            <label class="field"><span>Роль</span><select data-k="role">${opt(ROLES, c.role, (v) => ROLE_RU[v])}</select></label>
            ${c.role === 'driver' ? `<label class="field"><span>Езда</span><select data-k="drive">${opt(DRIVES, c.drive, (v) => DRIVE_RU[v])}</select></label>` : ''}
          </div>
          <div class="pad-viz">
            <span class="pv-trig" data-v="lt" title="LT" aria-hidden="true"><i></i></span>
            <span class="pv-stick" data-v="l" title="Левый стик" aria-hidden="true"><i></i></span>
            <span class="pv-stick" data-v="r" title="Правый стик" aria-hidden="true"><i></i></span>
            <span class="pv-trig" data-v="rt" title="RT" aria-hidden="true"><i></i></span>
            <span class="pv-btns" aria-hidden="true">${VIZ_BTNS.map(([k, l]) => `<b data-b="${k}">${l}</b>`).join('')}</span>
            <button type="button" class="link" data-k="rumble">проверить вибрацию</button>
          </div>
          <p class="hint">${esc(MAP_RU[c.role](c))}</p>
        </div>`;
      }).join('');
    }
    if (this.badge) {
      this.badge.hidden = !list.length;
      this.badge.innerHTML = `<span aria-hidden="true">🎮</span>${list.map((p) => `<i class="${p.role === 'off' ? 'off' : p.side}" title="${esc(`${p.index + 1}: ${p.name} — ${p.role === 'off' ? 'не используется' : `${TEAM_RU[p.side]}, ${p.role === 'driver' ? 'Driver' : 'Specialist'}`}`)}">${ROLE_SHORT[p.role]}</i>`).join('')}`;
      this.badge.setAttribute('aria-label', `Геймпады: ${list.length}. Открыть назначение`);
    }
    this._syncTouch();
    this._viz(true);
  }
  _frame(dt) {
    this._armHint();
    if (this._toastT > 0) { this._toastT -= dt; if (this._toastT <= 0 && this.toast) this.toast.hidden = true; }
    this._vizT -= dt;
    if (this._vizT <= 0) { this._vizT = 0.1; this._viz(false); }
  }
  /** Живой вид стиков, курков и кнопок (только когда панель видна) */
  _viz(force) {
    if (!this.listEl || !this.gm || (!force && !this.listEl.offsetParent)) return;
    for (const card of this.listEl.querySelectorAll('[data-index]')) {
      const s = this.gm.slots[Number(card.dataset.index)];
      const st = s && s.st;
      if (!st) continue;
      const set = (sel, k, v) => { const el = card.querySelector(sel); if (el) el.style.setProperty(k, v.toFixed(2)); };
      set('[data-v="l"] i', '--x', st.lx); set('[data-v="l"] i', '--y', st.ly);
      set('[data-v="r"] i', '--x', st.rx); set('[data-v="r"] i', '--y', st.ry);
      set('[data-v="lt"] i', '--v', st.lt); set('[data-v="rt"] i', '--v', st.rt);
      for (const b of card.querySelectorAll('[data-b]')) b.classList.toggle('on', !!st.b[b.dataset.b]);
      card.classList.toggle('active', !!s.active);
    }
  }
  dispose() {
    for (const off of this._offs) { try { off(); } catch { /* уже отписан */ } }
    for (const el of [this.sec, this.badge, this.toast]) if (el) el.remove();
    const ref = document.querySelector('#pane-help .pad-help-ref');
    if (ref) ref.remove();
  }
}

/** Подключить стили модуля ввода (index.html не трогаем) -> элемент <link> */
function injectCss() {
  if (typeof document === 'undefined') return null;
  const had = document.querySelector('link[data-input-css]');
  if (had) return had;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = new URL('../css/input.css', import.meta.url).href;
  l.dataset.inputCss = '1';
  document.head.appendChild(l);
  return l;
}
/** Таблица стилей уже применена */
function cssLoaded(link) {
  try { return !!(link && link.sheet && link.sheet.cssRules.length); } catch { return false; }
}

/** Подключить ввод к приложению: app.input (+ геймпады, экранные джойстики, панель) */
export function install(app) {
  const hub = new InputHub(app);
  app.input = hub;
  // дополнения не должны ломать клавиатуру: каждое — в своём try
  let link = null;
  try { link = injectCss(); } catch (e) { console.error('input.css:', e); }
  try { hub.gamepads = new GamepadManager(hub, app); hub.addSource(hub.gamepads.source); } catch (e) { console.error('Геймпады:', e); hub.gamepads = null; }
  try { hub.touch = new TouchControls(hub, app); hub.addSource(hub.touch.source); } catch (e) { console.error('Экранные джойстики:', e); hub.touch = null; }
  // джойстики без стилей не показываем (иначе на миг — голые кнопки поверх поля)
  if (link && hub.touch && hub.touch.root && !cssLoaded(link)) {
    const root = hub.touch.root;
    root.style.visibility = 'hidden';
    const show = () => { root.style.visibility = ''; };
    link.addEventListener('load', show, { once: true });
    link.addEventListener('error', show, { once: true });
  }
  try { hub.panel = new InputPanel(hub, app); } catch (e) { console.error('Панель ввода:', e); hub.panel = null; }
  return hub;
}
