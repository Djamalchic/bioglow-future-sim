// Судья (вкладка «Судья»): штрафы с эскалацией (правило 21 + Game Update 01), Gracious Professionalism,
// Courtesy rule, «отдать судье», авто-флаги возможного вмешательства (правило 20), правила «рук» (app.canDrag),
// проверка перед матчем, итог матча, история матчей со средним (рейтинг Future Edition) и экспорт CSV.
// Инструмент Operator (правило 16): лоток-катапульта у барьера и крючок для корней (mangrove roots).
// Контракт: install(app) рисует панель в #pane-referee и возвращает app.referee (API — в конце install).
import * as THREE from 'three';
import { L, FIELD_W, toMap, toWorld, inRect, other, MISSIONS } from './layout.js';
import { validateConfig } from './robotConfig.js';
import { G, ALL, groups, qYaw, qMul, qAxis, qConj, qRot } from './physics.js';
import { brick, mat, C } from './lego.js';

const SIDES = ['red', 'blue'];
const FLAG_DT = 0.25;    // с симуляции между проверками вмешательства
const FLAG_GAP = 2.0;    // с: условие пропадало дольше — новый флаг, иначе продлеваем старый
const FLAG_MAX = 40;
const HIST_MAX = 300;
const REST_V = 2;        // см/с — робот «стоит»
const GP_DEFAULT = 3;
const REASONS = [
  { id: 'interference', text: 'Вмешательство (правило 20)', short: 'вмешательство' },
  { id: 'violation', text: 'Явное нарушение правил (Update 01)', short: 'нарушение правил', disc: true },
  { id: 'misuse', text: 'Повторное или стратегическое злоупотребление правилами, в т. ч. Courtesy rule (Update 01)', short: 'злоупотребление правилами', disc: true },
  { id: 'conduct', text: 'Поведение против Core Values (считается вмешательством)', short: 'поведение' },
];
const GP_OPTS = [['4', '4 — превосходит ожидания'], ['3', '3 — соответствует (по умолчанию)'], ['2', '2 — развивается'], ['0', '0 — команда не явилась'], ['', '— не выставлена']];
const MODEL_RU = { tree: 'Grand Tree', falls: 'Cave Waterfall', hollow: 'Hollow Tree', nest: 'Nest', yf: 'Young Forest', hive: 'Hive', rec: 'Token Recycler', barrier: 'барьер зоны игроков', axle: 'ось Grand Tree' };
const AREA_RU = { technician: 'зона Technician', operator: 'зона Operator', specialist: 'зона Specialist', retrieval: 'retrieval zone' };
const TOKEN_RU = { K: 'ключевой вид', R: 'ресурс', IR: 'инвазивный вид', IS: 'инвазивный вид', Q: 'королева' };
const STEP_RU = (n) => (n === 1 ? '−10' : n === 2 ? 'ещё −20 (всего −30)' : n === 3 ? 'счёт матча 0' : 'счёт уже 0');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (t) => { t = Math.max(0, Math.floor(t)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const isRobot = (it) => !!(it && it.chassis && it.bodies);
/** «1 раз», «2 раза», «5 раз» */
const times = (n) => { const d = n % 10, h = n % 100; return `${n} ${d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'раза' : 'раз'}`; };
const OWN_AREAS = [['technician', 'techArea'], ['operator', 'operArea'], ['specialist', 'specArea']];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fin = (v, d, lo, hi) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : d);
/** Насколько точка карты внутри прямоугольника зоны, мм (<0 — снаружи) */
const rectDepth = (a, p) => Math.min(p.x - a.x0, a.x1 - p.x, p.y - a.y0, a.y1 - p.y);
/** Текст узла без лишних изменений DOM */
const setText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };

// Инструмент Operator: механический лоток-катапульта из LEGO (без электроники), см.
// Ось у переднего края основания (x = 0, «вперёд» = к барьеру), плечо L назад до центра чашки.
const OT = {
  L: 7.0, hingeY: 1.6, cup: 4.0, wall: 0.3, wallH: 0.9,  // плечо, высота оси, чашка
  x0: -9.6, x1: 1.6, hw: 2.3,                             // след основания (локально, см)
  rel: Math.PI / 4,                                       // угол выпуска (45°)
  vMin: 90, vMax: 230,                                    // см/с — скорость чашки при выпуске (сила 1…10)
  aimMax: 45, back: 2.5, hold: 0.35,                      // °, рад/с возврата, с паузы у упора
  move: 150, turn: 70,                                    // мм/с и °/с — перестановка лотка
};
// где может стоять основание лотка (мм карты своей стороны): внутри барьеров, левее корней
const TOOL_BOX = { x0: 608, y0: 928, x1: 897, y1: 1141 };
const TOOL_X0 = 848;
const toolRange = (pow) => { const v = OT.vMin + (OT.vMax - OT.vMin) * (pow - 1) / 9; return { v, cm: Math.round(v * v / 981) }; };
/** Курс тела (рад) для прицела a (рад, >0 — вправо от Operator) на стороне side */
function toolYaw(a, side) {
  let fx = Math.sin(a), fz = -Math.cos(a);   // «вперёд» на карте своей стороны — к барьеру (y меньше)
  if (side === 'blue') { fx = -fx; fz = -fz; }
  return Math.atan2(-fz, fx);
}
/** Углы следа основания (мм карты своей стороны) */
function toolCorners(x, y, a, side) {
  const w = toWorld(x, y, side), th = toolYaw(a, side), c = Math.cos(th), s = Math.sin(th);
  return [[OT.x0, -OT.hw], [OT.x0, OT.hw], [OT.x1, -OT.hw], [OT.x1, OT.hw]]
    .map(([lx, lz]) => toMap(w.x + lx * c + lz * s, w.z - lx * s + lz * c, side));
}
/** Поза лотка по месту x (мм) и прицелу (°): целиком в зоне Operator, вплотную к барьеру -> { x, y, a } */
export function toolPose(side, x, aimDeg) {
  const a = clamp(aimDeg, -OT.aimMax, OT.aimMax) * Math.PI / 180;
  let px = x, py = 960;
  const cs = toolCorners(px, py, a, side);
  const xs = cs.map((p) => p.x), ys = cs.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  if (minX < TOOL_BOX.x0) px += TOOL_BOX.x0 - minX; else if (maxX > TOOL_BOX.x1) px -= maxX - TOOL_BOX.x1;
  py += TOOL_BOX.y0 - Math.min(...ys);
  return { x: px, y: py, a };
}

/** Вычет по эскалации: 1-й −10, 2-й ещё −20, 3-й и дальше — весь счёт; итог не ниже 0 */
export function penaltyDeduction(n, missions) {
  if (n <= 0) return 0;
  if (n >= 3) return missions;
  return Math.min(missions, n === 1 ? 10 : 30);
}

/** Среднее по списку итогов (null, если пусто) */
export function average(list) {
  return list.length ? list.reduce((a, v) => a + v, 0) / list.length : null;
}

export function install(app) {
  const pane = app.ui.panel('referee');
  if (!pane) return null;
  const sim = app.sim, S = app.state, store = app.store, T = app.teams;
  const vp = document.getElementById('viewport');
  const stage = vp ? vp.parentElement : null;

  // ---------- состояние ----------
  const names = loadNames();
  let pen = { red: [], blue: [] };           // журнал штрафов текущего матча
  let gp = { red: GP_DEFAULT, blue: GP_DEFAULT };
  let hist = loadHistory();
  let cur = null;                             // запись истории текущего (законченного) матча
  const flags = [];                           // флаги возможного вмешательства, новые сверху
  const active = {};                          // ключ условия -> последний флаг
  let flagSeq = 0, flagAcc = 0;
  let trainFlags = !!store.get('ref.flagsTrain', false);
  let reason = REASONS.some((r) => r.id === store.get('ref.reason', '')) ? store.get('ref.reason', '') : 'interference';
  let lastMissions = null;
  let grab = null, dragging = null;           // разрешение «рук» при захвате и во время перетаскивания
  const pick = { on: false };
  const tool = { on: false };                 // мышь — инструмент Operator (крючок), открыта панель лотка
  let uiAcc = 0, inspAcc = 0, clearArm = 0;
  let inspSnap = null;                        // проверка на старте матча (для показа во время и после матча)

  function loadNames() {
    const n = store.get('ref.names', null);
    return { red: n && typeof n.red === 'string' ? n.red : '', blue: n && typeof n.blue === 'string' ? n.blue : '' };
  }
  function loadHistory() {
    const h = store.get('ref.history', []);
    return Array.isArray(h) ? h.filter((m) => m && m.teams && m.teams.red && m.teams.blue).slice(-HIST_MAX) : [];
  }
  const saveHistory = () => store.set('ref.history', hist);
  const teamName = (side) => (names[side] || '').trim() || T[side].name;
  const authority = () => !!app.stepAuthority;

  /** Время для журнала: в матче — как на табло (осталось), иначе — пометка */
  function clock() {
    if (S.mode === 'match') {
      const ph = S.match.phase;
      if (ph === 'running') return fmt(Math.ceil(Math.max(0, S.match.left) - 1e-6));
      if (ph === 'idle' || ph === 'countdown') return 'до старта';
      return 'после 0:00';
    }
    return 'трен. ' + fmt(sim.time - (S.trainT0 || 0));
  }
  const elapsed = () => (S.mode === 'match' && S.match.startT !== undefined && S.match.phase !== 'idle' ? +(sim.time - S.match.startT).toFixed(2) : null);

  // ---------- разметка ----------
  const teamCard = (s) => `
    <article class="ref-team ${s}" aria-label="${esc(T[s].name)}">
      <header>
        <input id="refName-${s}" class="ref-name" maxlength="40" spellcheck="false" placeholder="${esc(T[s].name)}" aria-label="Название команды (${esc(T[s].ru)} сторона)">
        <div class="ref-total"><b id="refTot-${s}">0</b><small id="refTotSub-${s}">миссии 0</small></div>
      </header>
      <div class="ref-pips" id="refPips-${s}" aria-hidden="true"><i>−10</i><i>−20</i><i>= 0</i></div>
      <p class="ref-pentext" id="refPenText-${s}">Штрафов нет</p>
      <div class="ref-row">
        <button type="button" class="btn small ref-pen" id="refPen-${s}">Штраф −10</button>
        <button type="button" class="btn ghost small" id="refUndo-${s}">Отменить</button>
      </div>
      <ol class="ref-penlog" id="refPenLog-${s}" aria-label="Штрафы: ${esc(T[s].name)}"></ol>
      <label class="field ref-gp"><span>Gracious Professionalism</span>
        <select id="refGP-${s}">${GP_OPTS.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('')}</select>
      </label>
      <div class="ref-row">
        <button type="button" class="btn ghost small" id="refCourt-${s}" title="Робот застрял: Technician возвращает его в зону Technician, перевозимые фишки снимаются из игры">Courtesy rule</button>
        <span class="ref-count" id="refCourtN-${s}" title="Сколько раз за матч">0 раз</span>
      </div>
      <p class="ref-warn" id="refCourtWarn-${s}" hidden></p>
    </article>`;

  pane.innerHTML = `
    <p class="ref-status" id="refStatus"></p>
    <p class="ref-sr" id="refLive" role="status" aria-live="polite"></p>

    <section class="ref-sec" aria-labelledby="refH1">
      <h3 id="refH1">Штрафы, GP и Courtesy rule</h3>
      <label class="field ref-reason"><span>Причина следующего штрафа</span>
        <select id="refReason">${REASONS.map((r) => `<option value="${r.id}">${esc(r.text)}</option>`).join('')}</select>
      </label>
      <div class="ref-teams">${SIDES.map(teamCard).join('')}</div>
      <p class="hint">Эскалация (правило 21): 1-й штраф −10, 2-й — ещё −20, 3-й — счёт матча 0; ниже 0 счёт не опускается. По Game Update 01 судья может штрафовать и за явное нарушение, повторное или стратегическое злоупотребление правилами — по той же шкале. Каждый штраф записывается в «Протокол» со временем матча.</p>
      <p class="hint">GP записывается на каждый матч и <b>не входит в очки</b>. Шкала GP в документах Future Edition не указана — здесь допущение 2 / 3 / 4, как в рубриках FIRST (3 — по умолчанию; не явилась — 0).</p>
    </section>

    <section class="ref-sec" aria-labelledby="refH2">
      <div class="ref-head"><h3 id="refH2">Отдать судье</h3>
        <button type="button" class="btn ghost small" id="refPick" aria-pressed="false">Выбрать на поле</button></div>
      <p class="hint">Щелчок по фишке или модели-фишке (инвазивный вид, королева) снимает её из игры до конца матча: предметы, которые Specialist отдаёт судье из своей зоны, и мешающие сопернику предметы. Щелчок по роботу — вмешательство оборудованием: робот возвращается в зону Technician, перевозимые фишки снимаются. Пустое место — камера. <kbd>Esc</kbd> — выход.</p>
    </section>

    <section class="ref-sec" aria-labelledby="refH3">
      <div class="ref-head"><h3 id="refH3">Возможное вмешательство</h3>
        <label class="chk"><input type="checkbox" id="refFlagsTrain"> и в тренировке</label></div>
      <p class="hint">Автоматические подсказки (раз в 0.25 с): робот касается робота соперника, моделей или фишек на чужой половине (кроме Central Haven), робот стоит в зоне игроков соперника. Сами они не штрафуют — решает судья; при сомнении — в пользу пострадавшей команды.</p>
      <ol class="ref-flags" id="refFlags"></ol>
    </section>

    <section class="ref-sec" aria-labelledby="refH4">
      <div class="ref-head"><h3 id="refH4">Проверка перед матчем</h3>
        <button type="button" class="link" id="refInspect">проверить</button></div>
      <p class="hint" id="refInspNote" hidden>Снимок проверки на старте матча — сейчас роботы уже на поле.</p>
      <ul class="ref-insp" id="refInsp"></ul>
    </section>

    <section class="ref-sec" aria-labelledby="refH5" id="refResultSec" hidden>
      <div class="ref-head"><h3 id="refH5">Итог матча</h3><span class="ref-badge" id="refResBadge"></span></div>
      <div class="ref-scroll" id="refResult"></div>
      <div class="ref-row"><button type="button" class="btn small" id="refConfirm">Команды согласны — результат официальный</button></div>
    </section>

    <section class="ref-sec" aria-labelledby="refH6">
      <div class="ref-head"><h3 id="refH6">История матчей</h3>
        <div class="ref-row">
          <button type="button" class="btn ghost small" id="refCsv">Скачать CSV</button>
          <button type="button" class="btn ghost small" id="refClear">Очистить</button>
        </div></div>
      <p class="hint">Рейтинг Future Edition — по <b>среднему</b> всех матчей команды (минимум 3 официальных), а не по лучшему. Остановленные матчи по умолчанию не в зачёт. Команды различаются по названию в карточках выше.</p>
      <div id="refHist"></div>
    </section>

    <details class="ref-rules">
      <summary>Правила «рук» в режиме матча</summary>
      <ul>
        <li>Мышью играет команда, выбранная в шапке («Команда»). До старта можно только ставить роботов; после 0:00 ничего не трогают.</li>
        <li><b>Driver</b> — только пульт, робота не трогает.</li>
        <li><b>Technician</b> — берёт робота, только когда тот целиком в своей зоне Technician (и отпускает на её границе); фишки — целиком в зоне Technician, наружу их выносит только робот или навесное.</li>
        <li><b>Operator</b> — фишки целиком в зоне Operator; K и R хотя бы частично в retrieval zone (пунктир) — только забрать в зону Operator (отпущенная вне зоны фишка возвращается на место). Наружу K и R уходят только инструментом: кнопка «Operator» на поле — лоток-катапульта у барьера (положите фишку в чашку, «Бросок») и крючок, которым мышь двигает K и R внутри зоны, в том числе из корней (mangrove roots).</li>
        <li><b>Specialist</b> — K и R, покоящиеся хотя бы частично в зоне, — в Token Recycler (клавиша <kbd>H</kbd>); прочие предметы — оставить или отдать судье.</li>
        <li>Трогать можно только покоящиеся фишки, которые не касаются робота. В тренировке ограничений нет.</li>
      </ul>
    </details>`;

  const $ = (id) => document.getElementById(id);
  const el = {
    status: $('refStatus'), live: $('refLive'), reason: $('refReason'), pick: $('refPick'), flags: $('refFlags'),
    flagsTrain: $('refFlagsTrain'), insp: $('refInsp'), inspNote: $('refInspNote'), inspBtn: $('refInspect'), resSec: $('refResultSec'), result: $('refResult'),
    resBadge: $('refResBadge'), confirm: $('refConfirm'), hist: $('refHist'), csv: $('refCsv'), clear: $('refClear'),
  };
  el.reason.value = reason;
  el.flagsTrain.checked = trainFlags;

  // элементы на сцене: полоса режима «отдать судье» и короткие подсказки
  let pickBar = null, toastEl = null, toastT = 0, toastText = '';
  if (stage) {
    pickBar = document.createElement('div');
    pickBar.className = 'ref-pickbar'; pickBar.hidden = true; pickBar.setAttribute('role', 'status');
    pickBar.innerHTML = '<span class="ref-pickdot" aria-hidden="true"></span><span id="refPickText">Судья: щёлкните фишку или робота</span><button type="button" class="ref-pickx">Выйти</button>';
    stage.appendChild(pickBar);
    pickBar.querySelector('.ref-pickx').addEventListener('click', () => setPick(false));
    toastEl = document.createElement('div');
    toastEl.className = 'ref-toast'; toastEl.hidden = true; toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite');
    stage.appendChild(toastEl);
  }
  function toast(text, ms = 2600) {
    if (!toastEl) return;
    const now = performance.now();
    if (text !== toastText || toastEl.hidden) { toastEl.textContent = text; toastText = text; }
    toastEl.hidden = false;
    toastT = now + ms;
  }
  function announce(text) {
    if (app.ui && typeof app.ui.announce === 'function') app.ui.announce(text);
    else el.live.textContent = text;
  }

  // ---------- штрафы ----------
  function syncSimPenalties(side, n) {
    const disc = pen[side].some((e) => e.disc);
    return sim.setPenalties(side, n, { log: pen[side], discretionary: disc });
  }
  function canEditResult() { return authority() && !(cur && cur.confirmed); }

  /** Штраф команде side (эскалация по правилу 21). reasonId — из REASONS. */
  function penalize(side, reasonId = reason, note = '') {
    if (!SIDES.includes(side)) return null;
    if (!authority()) { toast('Судейство ведёт хост'); return null; }
    if (cur && cur.confirmed) { toast('Результат уже подтверждён — штрафы не меняются'); return null; }
    const R = REASONS.find((r) => r.id === reasonId) || REASONS[0];
    const before = sim.score(side);
    const n = (sim.penalties[side].n || 0) + 1;
    pen[side] = pen[side].filter((e) => e.n < n);
    const entry = { n, clock: clock(), elapsed: elapsed(), simT: +sim.time.toFixed(2), reason: R.id, disc: !!R.disc, note: String(note || '') };
    pen[side].push(entry);
    const after = syncSimPenalties(side, n);
    entry.delta = after.total - before.total;
    app.log(side, `Штраф №${n} (${R.short}${entry.note ? ': ' + entry.note : ''}) — ${STEP_RU(n)}`, entry.delta);
    announce(`${teamName(side)}: штраф №${n}, ${STEP_RU(n)}. Счёт ${after.total}.`);
    syncCur();
    renderTeams(); renderResult();
    return { n, penalty: after.penalty, total: after.total, missions: after.missions, delta: entry.delta };
  }
  /** Отменить последний штраф команды */
  function undoPenalty(side) {
    if (!SIDES.includes(side) || !canEditResult()) return null;
    const n = sim.penalties[side].n || 0;
    if (n <= 0) return null;
    const before = sim.score(side);
    pen[side] = pen[side].filter((e) => e.n < n);
    const after = syncSimPenalties(side, n - 1);
    app.log(side, `Штраф №${n} отменён судьёй`, after.total - before.total);
    announce(`${teamName(side)}: штраф №${n} отменён. Счёт ${after.total}.`);
    syncCur();
    renderTeams(); renderResult();
    return { n: n - 1, penalty: after.penalty, total: after.total };
  }
  function setGP(side, v) {
    if (!SIDES.includes(side)) return null;
    if (cur && cur.confirmed) return gp[side];
    const num = v === '' || v === null || v === undefined ? null : Number(v);
    gp[side] = num === null || !Number.isFinite(num) ? null : Math.max(0, Math.min(4, Math.round(num)));
    syncCur();
    renderTeams(); renderResult();
    return gp[side];
  }

  // ---------- Courtesy rule ----------
  function courtesyAllowed() {
    if (!authority()) return false;
    if (S.mode !== 'match') return true;
    return S.match.phase === 'running';
  }
  function courtesy(side) {
    if (!SIDES.includes(side)) return null;
    if (!courtesyAllowed()) { toast(S.mode === 'match' ? 'Courtesy rule — только во время матча' : 'Судейство ведёт хост'); return null; }
    const res = sim.courtesyReturn(side);   // событие в протокол пишет сам симулятор
    if (res.flagged) app.log(side, `Courtesy rule уже ${res.count}-й раз за матч: стратегическое злоупотребление может быть наказано (Update 01)`, null);
    announce(`${teamName(side)}: Courtesy rule, робот в зоне Technician, снято фишек ${res.removed.length}.`);
    syncCur();
    renderTeams();
    return res;
  }

  // ---------- «отдать судье» ----------
  function setPick(on) {
    pick.on = !!on && authority();
    if (pick.on && tool.on) setTool(false);   // судья и Operator мышью одновременно не работают
    if (vp) vp.classList.toggle('ref-picking', pick.on);
    if (pickBar) pickBar.hidden = !pick.on;
    el.pick.setAttribute('aria-pressed', String(pick.on));
    el.pick.textContent = pick.on ? 'Готово' : 'Выбрать на поле';
    el.pick.classList.toggle('on', pick.on);
    return pick.on;
  }
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  /** Предмет под точкой экрана: фишка на поле или робот */
  function pickAt(cx, cy) {
    const rc = sim.renderer.domElement.getBoundingClientRect();
    if (!rc.width || !rc.height) return null;
    ndc.set(((cx - rc.left) / rc.width) * 2 - 1, -((cy - rc.top) / rc.height) * 2 + 1);
    ray.setFromCamera(ndc, sim.camera);
    const objs = sim.tokens.filter((t) => t.where === 'field' && t.mesh.visible).map((t) => t.mesh);
    for (const s of SIDES) objs.push(sim.robots[s].group);
    for (const h of ray.intersectObjects(objs, true)) {
      for (let o = h.object; o; o = o.parent) {
        if (o.userData && o.userData.token) return o.userData.token;
        for (const s of SIDES) if (o === sim.robots[s].group) return sim.robots[s];
      }
    }
    return null;
  }
  /** Робот -> зона Technician (вмешательство оборудованием); перевозимые фишки снимаются */
  function returnRobot(side, why = 'вмешательство оборудованием') {
    if (!SIDES.includes(side) || !authority()) return { ok: false, reason: 'Судейство ведёт хост' };
    const carried = sim.carriedBy(side);
    for (const t of carried) sim.removeFromPlay(t, 'снята судьёй (была в роботе)');
    sim.robots[side].resetPose();
    app.log(side, `Судья вернул робота в зону Technician (${why}); снято фишек: ${carried.length}`, null);
    toast(`${T[side].name}: робот возвращён в зону Technician`);
    return { ok: true, robot: side, removed: carried.map((t) => t.id) };
  }
  /** Снять предмет из игры (фишка) или вернуть робота. item — фишка, её id или Robot. */
  function removeItem(item) {
    if (!authority()) return { ok: false, reason: 'Судейство ведёт хост' };
    if (isRobot(item)) return returnRobot(item.side);
    const t = typeof item === 'string' ? sim.byId.get(item) : item;
    if (!t || t.where !== 'field' || !t.body) return { ok: false, reason: 'Предмет уже не на поле' };
    const p = t.body.translation(), r = sim.footR(t) * 10;
    let why = 'отдана судье — снята из игры', from = null;
    for (const s of SIDES) if (inRect(L.specArea, toMap(p.x, p.z, s), r)) { from = s; why = `отдана судье из зоны Specialist ${T[s].gen} команды — снята из игры`; break; }
    sim.removeFromPlay(t, why);
    toast(`Снята из игры: ${t.id} (${TOKEN_RU[t.type] || 'фишка'})`);
    return { ok: true, id: t.id, from };
  }
  window.addEventListener('pointerdown', (e) => {
    if (!pick.on || e.button !== 0 || !vp || !vp.contains(e.target)) return;
    let hit = null;
    try { hit = pickAt(e.clientX, e.clientY); } catch (err) { app.ui.showError(err, 'Судья'); }
    if (!hit) return; // пустое место — камера как обычно
    e.stopPropagation(); e.preventDefault();
    removeItem(hit);
  }, { capture: true });
  window.addEventListener('keydown', (e) => {
    if (!pick.on || e.code !== 'Escape') return;
    const tg = e.target;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT')) return;
    e.stopPropagation(); e.preventDefault();
    setPick(false);
  }, { capture: true });

  // ---------- руки: app.canDrag ----------
  function robotInTech(r, pad = 0.5) {
    if (!r || !r.bodies || !r.bodies.length) return false;
    for (const p of r.hullWorld()) if (!inRect(L.techArea, toMap(p.x, p.z, r.side), pad)) return false;
    return true;
  }
  /** Может ли игрок команды side взять фишку рукой -> { ok, zone, reason } */
  function handZone(t, side) {
    if (!t || t.where !== 'field' || !t.body) return { ok: false, reason: 'Фишка не на поле.' };
    const reasons = [];
    for (const role of ['technician', 'operator']) {
      const h = sim.handle(side, role, t);
      if (h.ok) return { ok: true, zone: h.area, reason: h.reason };
      reasons.push(h.reason);
    }
    const hs = sim.handle(side, 'specialist', t);
    if (hs.ok) return { ok: false, zone: 'specialist', reason: 'Specialist не перекладывает фишки руками: K и R из своей зоны — только в Token Recycler (клавиша H).' };
    // фишка (хотя бы частично) в зоне игроков соперника
    const p = t.body.translation(), mp = toMap(p.x, p.z, other(side)), r = sim.footR(t) * 10;
    for (const [k, a] of OWN_AREAS) if (inRect(L[a], mp, r)) return { ok: false, reason: `Фишка в зоне игроков соперника (${AREA_RU[k]}) — трогать нельзя.` };
    const pri = ['корн', 'Дождитесь', 'касается'];
    for (const k of pri) { const r = reasons.find((x) => x && x.includes(k)); if (r) return { ok: false, reason: r }; }
    return { ok: false, reason: 'Брать рукой можно только предметы целиком в своей зоне игроков.' };
  }
  /** Крючок Operator может взять фишку: K или R, центр в зоне Operator (в т. ч. в корнях), покоится -> { ok, reason } */
  function toolZone(t, side) {
    if (!t || isRobot(t) || t.where !== 'field' || !t.body) return { ok: false, reason: 'Фишка не на поле.' };
    const p = t.body.translation();
    if (!inRect(L.operArea, toMap(p.x, p.z, side), 0)) return { ok: false, reason: 'Инструмент Operator работает только внутри зоны Operator.' };
    if (t.type !== 'K' && t.type !== 'R') return { ok: false, reason: 'Инструментом Operator двигают только ключевые виды (K) и ресурсы (R).' };
    if (!sim.isResting(t, 3)) return { ok: false, reason: 'Дождитесь, пока фишка остановится.' };
    if (sim.touchingEquipment(t)) return { ok: false, reason: 'Фишка касается робота.' };
    return { ok: true, zone: 'tool', reason: 'Крючок Operator.' };
  }
  /** Перетаскиваемая фишка всё ещё там, где её можно держать рукой (или инструментом) */
  function stillInZone(d) {
    const t = d.item;
    if (!t.body || t.where !== 'field') return false;
    const p = t.body.translation(), mp = toMap(p.x, p.z, d.side), r = sim.footR(t) * 10;
    if (d.zone === 'retrieval') return inRect(L.retrieval, mp, r) || inRect(L.operArea, mp, r);
    // крючок всегда целиком в зоне Operator: фишка на нём остаётся в зоне и не переносится через барьер
    // (наружу — только лотком); лежавшую на краю фишку можно тянуть внутрь, но не дальше к краю
    if (d.zone === 'tool') return rectDepth(L.operArea, mp) >= Math.min(r - 1, (d.m0 ?? r) - 2);
    const area = d.zone === 'technician' ? L.techArea : d.zone === 'operator' ? L.operArea : null;
    return !!area && inRect(area, mp, -r + 1);
  }
  function deny(text) { toast(text, 2200); return false; }
  /** Запомнить разрешённый захват (поза — чтобы вернуть фишку из retrieval zone) */
  function setGrab(item, side, zone) {
    const b = item.body;
    grab = { item, side, zone, p0: b ? { ...b.translation() } : null, q0: b ? { ...b.rotation() } : null };
    // глубина фишки в зоне Operator при захвате крючком (мм)
    if (zone === 'tool' && b) { const p = b.translation(); grab.m0 = rectDepth(L.operArea, toMap(p.x, p.z, side)); }
  }
  /** Политика перетаскивания мышью (правила «рук»). item — фишка или Robot, side — команда игрока.
   *  opts.quiet — без подсказки на поле (проверка «на всякий случай», например колесо мыши над роботом). */
  function canDrag(item, side, opts) {
    if (pick.on) return false;
    if (!authority() || S.paused || !item) return false;
    const cont = dragging && dragging.item === item;  // вызов из шага перетаскивания
    if (S.mode !== 'match') {                          // тренировка: без ограничений
      if (!cont) { grab = null; if (tool.on && !isRobot(item) && toolZone(item, side).ok) setGrab(item, side, 'tool'); }
      return true;
    }
    const no = (text) => (opts && opts.quiet ? false : deny(text));
    const ph = S.match.phase;
    if (isRobot(item)) {
      if (ph === 'idle') return true;                  // подготовка: поставить роботов в зоны Technician
      if (ph !== 'running') return cont ? false : no('Матч не идёт — робота не трогают.');
      if (item.side !== side) return cont ? false : no('Это робот соперника — трогать нельзя.');
      if (robotInTech(item, cont ? 2 : 0.5)) return true;
      return cont ? false : no('Technician берёт робота, только когда он целиком в зоне Technician. Застрял — Courtesy rule на вкладке «Судья».');
    }
    if (ph !== 'running') {
      if (cont) return false;
      return no(ph === 'idle' || ph === 'countdown' ? 'До старта фишки не трогают — можно только поставить роботов.' : 'Время вышло — фишки не трогают.');
    }
    if (cont) return dragging.side === side && stillInZone(dragging);
    // инструмент Operator (крючок): K и R внутри зоны Operator, в т. ч. из корней
    const ht = tool.on ? toolZone(item, side) : null;
    if (ht && ht.ok) { setGrab(item, side, 'tool'); return true; }
    const h = handZone(item, side);
    if (h.ok) { setGrab(item, side, h.zone); return true; }
    if (ht) {
      const p = item.body ? item.body.translation() : null;
      if (p && inRect(L.operArea, toMap(p.x, p.z, side), 0)) return no(ht.reason);
    }
    return no(h.reason);
  }
  app.canDrag = canDrag;
  /** Retrieval zone: фишку только забирают в зону Operator. Отпущена в другом месте — вернуть, откуда взяли. */
  function settleRetrieval(d) {
    const t = d.item;
    if (!authority() || S.mode !== 'match' || !t.body || t.where !== 'field' || !d.p0) return null;
    const p = t.body.translation(), r = sim.footR(t) * 10;
    if (inRect(L.operArea, toMap(p.x, p.z, d.side), -r + 1)) return 'ok';
    const R = sim.phys.R, me = new Set(t.colliders.map((c) => c.handle));
    const busy = sim.phys.occupied(d.p0, d.q0, new R.Ball(sim.footR(t) * 0.85),
      groups(ALL, G.STATIC | G.TOKEN | G.RED | G.BLUE | G.ATT_RED | G.ATT_BLUE | G.MECH), (c) => me.has(c.handle));
    if (!busy) {
      t.body.setTranslation(d.p0, true); t.body.setRotation(d.q0, true);
      t.body.setLinvel({ x: 0, y: 0, z: 0 }, true); t.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      t.body.wakeUp();
      toast('Retrieval zone: K и R отсюда можно только забрать в зону Operator — фишка возвращена на место.', 3200);
      return 'returned';
    }
    // место занято (робот, другая фишка) — решает судья
    addFlag(`hands:${d.side}:${t.id}`, 'hands', d.side, `Operator отпустил ${t.id} вне зоны Operator (retrieval zone)`);
    toast('Фишка отпущена вне зоны Operator — отмечено для судьи.', 3200);
    return 'flagged';
  }
  app.on('drag', (item) => {
    if (!item) {
      const d = dragging;
      dragging = null;
      if (d && d.zone === 'retrieval') { try { settleRetrieval(d); } catch (e) { app.ui.showError(e, 'Судья: retrieval zone'); } }
      return;
    }
    if (isRobot(item)) dragging = { item, side: item.side, zone: 'robot' };
    else dragging = grab && grab.item === item ? grab : { item, side: S.team, zone: null };
    grab = null;
  });

  // ---------- инструмент Operator (правило 16) ----------
  // Механический инструмент из LEGO без электроники, всегда целиком в зоне Operator:
  //  • лоток-катапульта у барьера: K и R кладут в чашку рукой, «Бросок» перекидывает их через барьер
  //    (кинематическое плечо по-настоящему толкает фишку, дальше — обычная физика полёта);
  //  • крючок: в режиме инструмента мышь двигает K и R внутри зоны Operator, в т. ч. из корней.
  const toolCfg = loadToolCfg();
  const tools = {};
  function loadToolCfg() {
    const raw = store.get('ref.tool', null), out = {};
    for (const s of SIDES) {
      const c = raw && typeof raw === 'object' && raw[s] && typeof raw[s] === 'object' ? raw[s] : {};
      out[s] = { x: fin(c.x, TOOL_X0, TOOL_BOX.x0, TOOL_BOX.x1), aim: Math.round(fin(c.aim, 0, -OT.aimMax, OT.aimMax)), pow: Math.round(fin(c.pow, 6, 1, 10)) };
    }
    return out;
  }
  function buildTool(side) {
    const pl = OT.x1 - OT.x0, pc = (OT.x0 + OT.x1) / 2, c = OT.cup, wt = OT.wall, wh = OT.wallH;
    const g = new THREE.Group(), pivot = new THREE.Group();
    const spec = { base: [], arm: [] };   // коллайдеры: [w, h, d, x, y, z, материал]
    const both = (part, m, w, h, d, x, y, z, color, vis, studs = false) => {
      spec[part].push([w, h, d, x, y, z, m]);
      vis.add(brick(w, h, d, color, x, y, z, { studs }));
    };
    // основание: пластина, стойки оси, упор под чашкой
    both('base', 'model', pl, 0.32, OT.hw * 2, pc, 0.16, 0, side === 'red' ? C.red : C.blue, g, true);
    for (const z of [-1.9, 1.9]) both('base', 'model', 0.8, 1.7, 0.6, 0, 1.17, z, C.lightGrey, g);
    both('base', 'model', 2.4, 1.0, 2.4, -OT.L, 0.82, 0, C.lightGrey, g);
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 4.4, 10), mat(C.black));
    axle.rotation.x = Math.PI / 2; axle.position.y = OT.hingeY; g.add(axle);
    // плечо с чашкой (поворачивается вокруг оси)
    pivot.position.y = OT.hingeY;
    g.add(pivot);
    both('arm', 'model', OT.L, 0.4, 1.6, -OT.L / 2, 0, 0, C.darkGrey, pivot);
    both('arm', 'scoop', c, 0.3, c, -OT.L, 0.05, 0, C.yellow, pivot);
    for (const x of [-OT.L - c / 2 + wt / 2, -OT.L + c / 2 - wt / 2]) both('arm', 'scoop', wt, wh, c, x, 0.2 + wh / 2, 0, C.yellow, pivot);
    for (const z of [-(c / 2 - wt / 2), c / 2 - wt / 2]) both('arm', 'scoop', c, wh, wt, -OT.L, 0.2 + wh / 2, z, C.yellow, pivot);
    sim.scene.add(g);
    const cur = { x: toolCfg[side].x, aim: toolCfg[side].aim };
    return { side, spec, base: null, arm: null, world: null, group: g, pivot, cur, pose: toolPose(side, cur.x, cur.aim), phase: 'rest', phi: 0, w: 0, wT: 0, alpha: 0, t: 0 };
  }
  /** Тела лотка в мире ph (кинематические: основание и плечо с чашкой) */
  function makeToolBodies(tl, ph) {
    const info = { kind: 'tool', side: tl.side, model: 'operator', color: C.yellow };
    const opt = (m) => ({ mat: m, group: G.MECH, filter: G.TOKEN | G.RED | G.BLUE | G.ATT_RED | G.ATT_BLUE, info });
    tl.base = ph.body('kinematic', { x: 0, y: 0, z: 0 });
    tl.arm = ph.body('kinematic', { x: 0, y: OT.hingeY, z: 0 });
    for (const part of ['base', 'arm']) for (const [w, h, d, x, y, z, m] of tl.spec[part]) ph.collider(tl[part], { shape: 'box', w, h, d, x, y, z }, opt(m));
    tl.world = ph.world;
    tl.key = null;
    applyToolPose(tl, true);
  }
  /** Тела лотка в текущем мире. Через sim.addBodies симулятор сам создаёт их заново после пересборки
   *  мира при сбросе поля; здесь — запасной путь, если мир сменился без этого. */
  function toolBodies(tl) {
    if (!(tl.base && tl.world === sim.world)) makeToolBodies(tl, sim.phys);
    return tl;
  }
  function applyToolPose(tl, teleport) {
    if (tl.world !== sim.world) { toolBodies(tl); return; }
    // поза не менялась — тела не трогаем (фишки на лотке могут «уснуть»)
    const key = `${tl.pose.x.toFixed(2)}|${tl.pose.y.toFixed(2)}|${tl.pose.a.toFixed(4)}|${tl.phi.toFixed(4)}`;
    if (!teleport && key === tl.key) return;
    tl.key = key;
    const w = toWorld(tl.pose.x, tl.pose.y, tl.side), th = toolYaw(tl.pose.a, tl.side);
    const q = qYaw(th), qa = qMul(q, qAxis(0, 0, 1, -tl.phi));
    const bp = { x: w.x, y: 0, z: w.z }, ap = { x: w.x, y: OT.hingeY, z: w.z };
    if (teleport) { tl.base.setTranslation(bp, true); tl.base.setRotation(q, true); tl.arm.setTranslation(ap, true); tl.arm.setRotation(qa, true); }
    tl.base.setNextKinematicTranslation(bp); tl.base.setNextKinematicRotation(q);
    tl.arm.setNextKinematicTranslation(ap); tl.arm.setNextKinematicRotation(qa);
    tl.group.position.set(w.x, 0, w.z); tl.group.rotation.set(0, th, 0); tl.pivot.rotation.z = -tl.phi;
  }
  /** Шаг лотков (после шага физики: следующая кинематическая поза) */
  function toolStep(dt) {
    for (const s of SIDES) {
      const tl = tools[s];
      if (!tl) continue;
      // перестановка — плавно, чтобы основание толкало фишки, а не «телепортировалось» сквозь них
      const c = toolCfg[s], u = tl.cur;
      const dx = c.x - u.x, mx = OT.move * dt, da = c.aim - u.aim, ma = OT.turn * dt;
      u.x += Math.abs(dx) > mx ? Math.sign(dx) * mx : dx;
      u.aim += Math.abs(da) > ma ? Math.sign(da) * ma : da;
      tl.pose = toolPose(s, u.x, u.aim);
      if (tl.phase === 'fire') {
        // разгон с постоянным ускорением (как резинка): фишка прижата к дну до упора, отрыв — на 45°
        tl.w = Math.min(tl.wT * 1.05, tl.w + tl.alpha * dt);
        tl.phi += tl.w * dt;
        if (tl.phi >= OT.rel) { tl.phi = OT.rel; tl.w = 0; tl.phase = 'hold'; tl.t = OT.hold; }
      } else if (tl.phase === 'hold') {
        tl.t -= dt;
        if (tl.t <= 0) tl.phase = 'back';
      } else if (tl.phase === 'back') {
        tl.phi = Math.max(0, tl.phi - OT.back * dt);
        if (tl.phi === 0) tl.phase = 'rest';
      }
      applyToolPose(tl, false);
    }
  }
  /** Без шагов физики (пауза, онлайн-гость): лоток сразу встаёт на место */
  function toolSnap() {
    for (const s of SIDES) {
      const tl = tools[s], c = toolCfg[s];
      if (!tl || (tl.cur.x === c.x && tl.cur.aim === c.aim)) continue;
      tl.cur.x = c.x; tl.cur.aim = c.aim;
      tl.pose = toolPose(s, c.x, c.aim);
      applyToolPose(tl, true);
    }
  }
  function toolsRest() {
    for (const s of SIDES) {
      const tl = tools[s];
      if (!tl) continue;
      tl.phase = 'rest'; tl.phi = 0; tl.w = 0; tl.t = 0;
      applyToolPose(tl, true);
    }
  }
  /** Фишки в чашке лотка */
  function cupItems(side) {
    const tl = tools[side];
    if (!tl) return [];
    toolBodies(tl);
    const ap = tl.arm.translation(), qi = qConj(tl.arm.rotation()), half = OT.cup / 2;
    return sim.tokens.filter((t) => {
      if (t.where !== 'field' || !t.body) return false;
      const p = t.body.translation();
      const l = qRot(qi, { x: p.x - ap.x, y: p.y - ap.y, z: p.z - ap.z });
      return Math.abs(l.x + OT.L) < half && Math.abs(l.z) < half && l.y > 0 && l.y < 3.5;
    });
  }
  /** Почему сейчас нельзя пользоваться лотком ('' — можно). fire — бросок, иначе перестановка */
  function toolBlock(side, fire) {
    if (!authority()) return 'Онлайн: лоток Operator работает на компьютере хоста.';
    if (S.mode === 'match') {
      const ph = S.match.phase;
      if (ph === 'countdown') return 'Обратный отсчёт — инструмент не трогают.';
      if (ph === 'settling' || ph === 'ended') return 'Время вышло — инструментом больше не пользуются.';
      if (fire && ph === 'idle') return 'Бросок — только во время матча. До старта лоток можно поставить и навести.';
    }
    if (fire && S.paused) return 'Пауза — бросок после «Дальше».';
    if (fire && tools[side] && tools[side].phase !== 'rest') return 'Плечо лотка ещё возвращается.';
    return '';
  }
  /** Поставить и навести лоток: { x (мм вдоль барьера), aim (°, >0 — вправо), pow (1…10) } */
  function setToolCfg(side, o = {}) {
    if (!SIDES.includes(side)) return null;
    const c = toolCfg[side];
    const move = o.x !== undefined || o.aim !== undefined;
    if (move) {
      const why = toolBlock(side, false);
      if (why) return { ok: false, reason: why, ...c };
    }
    if (o.aim !== undefined) c.aim = Math.round(fin(o.aim, c.aim, -OT.aimMax, OT.aimMax));
    if (o.x !== undefined) c.x = fin(o.x, c.x, TOOL_BOX.x0, TOOL_BOX.x1);
    if (move) c.x = 2 * Math.round(toolPose(side, c.x, c.aim).x / 2);   // ближайшее допустимое место (шаг ползунка 2 мм)
    if (o.pow !== undefined) c.pow = Math.round(fin(o.pow, c.pow, 1, 10));
    store.set('ref.tool', toolCfg);
    return { ok: true, ...c };
  }
  /** «Бросок»: плечо лотка резко поднимается до 45° и перекидывает фишки из чашки через барьер */
  function toolLaunch(side = S.team) {
    if (!SIDES.includes(side) || !tools[side]) return { ok: false, reason: 'Нет такой команды.' };
    const why = toolBlock(side, true);
    if (why) { toast(why); return { ok: false, reason: why }; }
    const items = cupItems(side);
    if (items.some((t) => t.type !== 'K' && t.type !== 'R')) {
      const reason = 'Из зоны Operator можно выпускать только ключевые виды (K) и ресурсы (R) — правило 16.';
      toast(reason, 3200);
      return { ok: false, reason };
    }
    const tl = tools[side], { v } = toolRange(toolCfg[side].pow);
    // фишка у передней стенки чашки — радиус ≈ L − 0.8 см
    tl.wT = v / (OT.L - 0.8); tl.alpha = tl.wT * tl.wT / (2 * OT.rel); tl.w = 0; tl.phase = 'fire';
    for (const t of items) t.body.wakeUp();
    app.log(side, `Operator: бросок лотком (сила ${toolCfg[side].pow}${items.length ? ', ' + items.map((t) => t.id).join(', ') : ', чашка пуста'})`, null);
    return { ok: true, items: items.map((t) => t.id), v: Math.round(v) };
  }
  for (const s of SIDES) {
    try { tools[s] = buildTool(s); } catch (e) { app.ui.showError(e, 'Инструмент Operator'); }
  }
  // тела — через sim.addBodies: мир Rapier при сбросе поля пересобирается вместе с ними (повтор программы
  // после сброса = как после загрузки); старый симулятор без addBodies — тела напрямую
  const buildToolBodies = (ph) => { for (const s of SIDES) if (tools[s]) makeToolBodies(tools[s], ph); };
  try {
    if (typeof sim.addBodies === 'function') sim.addBodies(buildToolBodies); else buildToolBodies(sim.phys);
  } catch (e) { app.ui.showError(e, 'Инструмент Operator'); }
  // крючок над фишкой, которую Operator двигает инструментом
  const hook = new THREE.Group();
  hook.add(brick(0.5, 9, 0.5, C.lightGrey, 0, 4.5, 0), brick(1.2, 0.4, 0.5, C.lightGrey, -0.35, 0, 0));
  hook.visible = false;
  sim.scene.add(hook);
  function updateHook() {
    const d = dragging, t = d && d.zone === 'tool' ? d.item : null;
    if (!t || !t.body || t.where !== 'field') { hook.visible = false; return; }
    const p = t.body.translation(), r = sim.footR(t);
    hook.position.set(p.x + r + 0.35, p.y, p.z);
    hook.visible = true;
  }
  app.on('step', (dt) => { try { toolStep(dt); } catch (e) { app.ui.showError(e, 'Инструмент Operator'); } });

  // панель лотка на поле (кнопка «Operator» справа сверху)
  let toolEl = null;
  if (stage) {
    const root = document.createElement('div');
    root.className = 'ref-otool';
    root.innerHTML = `
      <button type="button" class="ref-otool-tg" aria-expanded="false" aria-controls="refToolBox" title="Инструмент Operator: лоток-катапульта у барьера и крючок для корней">Operator</button>
      <div class="ref-otool-box" id="refToolBox" role="group" aria-label="Инструмент Operator" hidden>
        <p class="ref-otool-h"><b>Инструмент Operator</b><span class="ref-otool-team"></span></p>
        <label class="ref-otool-f"><span>Место у барьера</span><input type="range" data-k="x" min="${TOOL_BOX.x0}" max="${TOOL_BOX.x1}" step="2"></label>
        <label class="ref-otool-f"><span>Направление <output data-o="aim"></output></span><input type="range" data-k="aim" min="${-OT.aimMax}" max="${OT.aimMax}" step="1"></label>
        <label class="ref-otool-f"><span>Сила <output data-o="pow"></output></span><input type="range" data-k="pow" min="1" max="10" step="1"></label>
        <div class="ref-otool-row">
          <button type="button" class="ref-otool-fire">Бросок</button>
          <button type="button" class="ref-otool-x">Свернуть</button>
        </div>
        <p class="ref-otool-note"></p>
      </div>`;
    stage.appendChild(root);
    const q = (s) => root.querySelector(s);
    toolEl = {
      root, tg: q('.ref-otool-tg'), box: q('.ref-otool-box'), team: q('.ref-otool-team'), fire: q('.ref-otool-fire'), close: q('.ref-otool-x'),
      note: q('.ref-otool-note'), inp: { x: q('[data-k="x"]'), aim: q('[data-k="aim"]'), pow: q('[data-k="pow"]') }, out: { aim: q('[data-o="aim"]'), pow: q('[data-o="pow"]') },
    };
    toolEl.tg.addEventListener('click', () => setTool(!tool.on));
    toolEl.close.addEventListener('click', () => setTool(false));
    toolEl.fire.addEventListener('click', () => { toolLaunch(S.team); renderTool(); });
    for (const k of ['x', 'aim', 'pow']) {
      const inp = toolEl.inp[k];
      inp.addEventListener('input', () => {
        const r = setToolCfg(S.team, { [k]: Number(inp.value) });
        if (r && !r.ok) toast(r.reason);
        renderTool(true);
      });
      inp.addEventListener('change', () => renderTool());
    }
  }
  const aimText = (a) => (a === 0 ? 'прямо' : `${Math.abs(a)}° ${a > 0 ? 'вправо' : 'влево'}`);
  /** live — во время движения ползунка: его значение не трогаем */
  function renderTool(live = false) {
    if (!toolEl) return;
    const s = S.team, c = toolCfg[s];
    toolEl.root.classList.toggle('blue', s === 'blue');
    toolEl.tg.setAttribute('aria-expanded', String(tool.on));
    toolEl.tg.classList.toggle('on', tool.on);
    toolEl.box.hidden = !tool.on;
    if (vp) vp.classList.toggle('ref-tooling', tool.on);
    if (!tool.on) return;
    setText(toolEl.team, T[s].name);
    const mv = toolBlock(s, false), fw = toolBlock(s, true);
    for (const k of ['x', 'aim', 'pow']) {
      const inp = toolEl.inp[k];
      if (!(live && document.activeElement === inp) && inp.value !== String(c[k])) inp.value = String(c[k]);
      inp.disabled = k === 'pow' ? !authority() : !!mv;
    }
    setText(toolEl.out.aim, aimText(c.aim));
    setText(toolEl.out.pow, `${c.pow} · ≈ ${toolRange(c.pow).cm} см`);
    toolEl.fire.disabled = !!fw;
    const busy = !!fw && tools[s] && tools[s].phase !== 'rest' && !mv;   // плечо возвращается — подсказку не мигаем
    setText(toolEl.note, mv || (fw && !busy ? fw
      : 'Положите K или R в жёлтую чашку лотка рукой и нажмите «Бросок». Пока панель открыта, мышь — крючок: двигает K и R внутри зоны Operator, в том числе из корней.'));
  }
  /** Режим инструмента Operator (панель лотка открыта, мышь — крючок) */
  function setTool(on) {
    tool.on = !!on;
    if (tool.on && pick.on) setPick(false);
    renderTool();
    return tool.on;
  }
  let toolUiAcc = 0, lastFrameStep = -1, noStepT = 0;
  app.on('frame', (real) => {
    try {
      // физика стоит дольше 0.2 с (пауза, онлайн-гость) — лоток встаёт на место сразу
      if (sim.stepCount === lastFrameStep) { noStepT += real; if (noStepT > 0.2) toolSnap(); } else noStepT = 0;
      lastFrameStep = sim.stepCount;
      updateHook();
      if (!tool.on) return;
      toolUiAcc += real;
      if (toolUiAcc < 0.25) return;
      toolUiAcc = 0;
      renderTool(true);
    } catch (e) { app.ui.showError(e, 'Инструмент Operator'); }
  });
  app.on('team', () => renderTool());

  // ---------- авто-флаги вмешательства ----------
  const flagsOn = () => authority() && (S.mode === 'match' ? S.match.phase === 'running' : trainFlags);
  function touching(c, c2) {
    let hit = false;
    sim.world.contactPair(c, c2, (man) => { for (let i = 0; i < man.numContacts(); i++) if (man.contactDist(i) < 0.06) { hit = true; break; } });
    return hit;
  }
  /** Контакты робота: с роботом соперника, моделями соперника, фишками */
  function robotContacts(r) {
    const out = { robot: false, models: new Set(), tokens: new Set() };
    const w = sim.world, info = sim.phys.info, o = other(r.side);
    for (const b of r.bodies) {
      const n = b.numColliders();
      for (let i = 0; i < n; i++) {
        const c = b.collider(i);
        w.contactPairsWith(c, (c2) => {
          const inf = info.get(c2.handle);
          if (!inf) return;
          if (inf.kind === 'robot') {
            if (inf.side !== o || out.robot) return;
            if (touching(c, c2)) out.robot = true;
          } else if (inf.kind === 'model') {
            if (inf.side !== o || out.models.has(inf.model)) return;
            if (touching(c, c2)) out.models.add(inf.model || 'model');
          } else if (inf.kind === 'token' && inf.token && !out.tokens.has(inf.token)) {
            if (touching(c, c2)) out.tokens.add(inf.token);
          }
        });
      }
    }
    return out;
  }
  const onHalf = (p, side) => toMap(p.x, p.z, side).x < FIELD_W / 2;
  /** Фишка на половине соперника o (не у центральной линии и не в Central Haven) */
  function tokenOnHalf(t, o) {
    const p = t.body.translation();
    if (toMap(p.x, p.z, o).x > FIELD_W / 2 - 20) return false;
    const hm = toMap(p.x, p.z, 'red');
    return Math.hypot(hm.x - L.haven.x, hm.y - L.haven.y) > L.haven.r + 30;
  }
  /** Робот (хотя бы частично) стоит в зоне игроков соперника -> название зоны | null */
  function robotInOppArea(r, o) {
    const v = r.chassis.linvel();
    if (Math.hypot(v.x, v.z) > REST_V) return null;
    const areas = [['technician', L.techArea], ['operator', L.operArea], ['specialist', L.specArea]];
    for (const p of r.hullWorld()) {
      const mp = toMap(p.x, p.z, o);
      for (const [k, a] of areas) if (inRect(a, mp, 0)) return k;
    }
    return null;
  }
  /** Одна проверка (вызывается раз в FLAG_DT с симуляции; можно вызвать вручную) */
  function checkFlags() {
    const hits = [];
    const cont = { red: robotContacts(sim.robots.red), blue: robotContacts(sim.robots.blue) };
    if (cont.red.robot || cont.blue.robot) {
      const sus = SIDES.filter((s) => onHalf(sim.robots[s].position, other(s)));
      const side = sus.length === 1 ? sus[0] : null;
      hits.push(['robots', 'robots', side, side ? `Робот касается робота соперника на его половине` : 'Роботы касаются друг друга у центральной линии']);
    }
    for (const s of SIDES) {
      const o = other(s), c = cont[s];
      if (c.models.size) hits.push([`model:${s}`, 'model', s, `Робот касается модели соперника: ${[...c.models].map((m) => MODEL_RU[m] || m).join(', ')}`]);
      const toks = [...c.tokens].filter((t) => t.body && t.where === 'field' && tokenOnHalf(t, o));
      if (toks.length) hits.push([`token:${s}`, 'token', s, `Робот касается фишек на половине соперника: ${toks.map((t) => t.id).join(', ')}`]);
      const area = robotInOppArea(sim.robots[s], o);
      if (area) hits.push([`area:${s}`, 'area', s, `Робот стоит в зоне игроков соперника (${AREA_RU[area]})`]);
    }
    for (const [key, type, side, text] of hits) addFlag(key, type, side, text);
    return hits.length;
  }
  /** Новый флаг (или продление того же условия, если оно пропадало не дольше FLAG_GAP) -> флаг */
  function addFlag(key, type, side, text) {
    const now = sim.time, f = active[key];
    if (f && now - f.last <= FLAG_GAP) { f.last = now; return f; }
    const nf = { id: ++flagSeq, key, type, side, text, t0: now, last: now, clock: clock(), status: 'open', note: '' };
    flags.unshift(nf); active[key] = nf;
    if (flags.length > FLAG_MAX) flags.pop();
    announce(`${type === 'hands' ? 'Правила рук' : 'Возможное вмешательство'}: ${side ? T[side].name + ' — ' : ''}${text}`);
    updateTabBadge();
    return nf;
  }
  app.on('step', (dt) => {
    if (!flagsOn()) { flagAcc = 0; return; }
    flagAcc += dt;
    if (flagAcc + 1e-9 < FLAG_DT) return;
    flagAcc = 0;
    try { checkFlags(); } catch (e) { app.ui.showError(e, 'Судья: флаги'); }
  });
  // счёт соперника упал, пока робот касался его моделей/фишек — пометка к флагу
  app.on('score', (sc) => {
    if (lastMissions && flagsOn()) {
      for (const o of SIDES) {
        const drop = lastMissions[o] - sc[o].missions;
        if (drop <= 0) continue;
        const s = other(o);
        const f = flags.find((x) => x.status === 'open' && x.side === s && x.type !== 'area' && x.type !== 'hands' && sim.time - x.last < 1.5);
        if (f) f.note = `счёт ${T[o].gen} команды упал на ${drop}`;
      }
    }
    lastMissions = { red: sc.red.missions, blue: sc.blue.missions };
    if (visible()) renderTeams(sc);
  });
  function flagAction(id, act) {
    const f = flags.find((x) => x.id === Number(id));
    if (!f) return null;
    if (act === 'dismiss') f.status = 'dismissed';
    else if (act === 'pen-red' || act === 'pen-blue') {
      const side = act.slice(4);
      // в заметку — текст флага со строчной буквы («Робот…» -> «робот…»); id фишек и названия ролей не трогаем
      const note = /^[А-ЯЁ]/.test(f.text) ? f.text.charAt(0).toLowerCase() + f.text.slice(1) : f.text;
      const r = penalize(side, f.type === 'hands' ? 'violation' : 'interference', note);
      if (r) { f.status = 'penalized'; f.penSide = side; }
    } else if (act === 'return' && f.side && f.type !== 'hands') {
      const r = returnRobot(f.side, 'вмешательство');
      if (r.ok) f.returned = true;
    }
    renderFlags(true);
    updateTabBadge();
    return f;
  }
  function clearFlags() { flags.length = 0; for (const k of Object.keys(active)) delete active[k]; flagAcc = 0; updateTabBadge(); renderFlags(true); }
  function updateTabBadge() {
    const tab = document.getElementById('tab-referee');
    if (!tab) return;
    const n = flags.filter((f) => f.status === 'open').length;
    tab.classList.toggle('ref-has-flags', n > 0);
    tab.dataset.flags = n ? String(n) : '';
    tab.setAttribute('aria-label', n ? `Судья, флагов: ${n}` : 'Судья');
  }

  // ---------- проверка (inspection) ----------
  function inspectBoth() {
    const out = {};
    for (const s of SIDES) {
      const ins = sim.inspect(s), r = sim.robots[s];
      let v = null;
      try { v = validateConfig(r.config); } catch (e) { v = null; }
      out[s] = { ...ins, name: r.config.name || '', bbox: v ? v.bbox : null, massKg: v ? v.massKg : null, warnings: v ? v.warnings : [] };
    }
    return out;
  }

  // ---------- итог и история ----------
  function teamResult(side, prev) {
    const sc = sim.score(side);
    return {
      name: teamName(side), missions: sc.missions, penalties: sc.penalties, deducted: sc.missions - sc.total, total: sc.total,
      gp: gp[side], courtesy: sim.courtesy[side] || 0,
      rows: Object.fromEntries(sc.rows.map((r) => [r.id, r.pts])),
      pen: pen[side].map((e) => ({ n: e.n, clock: e.clock, reason: e.reason })),
      counted: prev ? prev.counted : true,
    };
  }
  /** Изменения после конца матча (штрафы, GP, названия) — в запись истории */
  function syncCur() {
    if (!cur) return;
    for (const s of SIDES) cur.teams[s] = teamResult(s, cur.teams[s]);
    if (hist.includes(cur)) saveHistory();
    renderHistory();
  }
  function onMatchEnd(ev) {
    const aborted = !!(ev && ev.aborted);
    cur = { id: 'm' + Date.now().toString(36) + (hist.length + 1), date: new Date().toISOString(), aborted, confirmed: false, teams: {} };
    for (const s of SIDES) cur.teams[s] = teamResult(s, { counted: !aborted });
    // онлайн-гость: итог только показываем — историю и рейтинг ведёт хост (иначе матч хоста попадёт в историю гостя)
    if (authority()) {
      hist.push(cur);
      if (hist.length > HIST_MAX) hist = hist.slice(-HIST_MAX);
      saveHistory();
    }
    setPick(false);
    render();
    const n = hist.indexOf(cur) + 1;
    announce(`Матч${n ? ' ' + n : ''} окончен: ${cur.teams.red.name} ${cur.teams.red.total}, ${cur.teams.blue.name} ${cur.teams.blue.total}.`);
  }
  function confirmResult(on = true) {
    if (!cur || !authority()) return false;
    cur.confirmed = !!on;
    saveHistory();
    app.log(null, on ? 'Судья и команды согласовали итог — результат официальный' : 'Подтверждение итога снято', null);
    render();
    return cur.confirmed;
  }
  function teamStats() {
    const map = new Map();
    hist.forEach((m, i) => {
      for (const s of SIDES) {
        const r = m.teams[s];
        const nm = (r.name || T[s].name).trim();
        const key = nm.toLowerCase();
        let e = map.get(key);
        if (!e) map.set(key, (e = { name: nm, rows: [] }));
        e.rows.push({ m, i, s, r });
      }
    });
    const out = [...map.values()];
    for (const e of out) {
      const c = e.rows.filter((x) => x.r.counted);
      e.n = c.length;
      e.avg = average(c.map((x) => Number(x.r.total) || 0));
    }
    return out.sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || a.name.localeCompare(b.name, 'ru'));
  }
  function setCounted(matchId, side, on) {
    const m = hist.find((x) => x.id === matchId);
    if (!m || !m.teams[side]) return false;
    m.teams[side].counted = !!on;
    saveHistory();
    renderHistory();
    return true;
  }
  const num = (v) => String(Math.round(v * 10) / 10).replace('.', ',');
  /** История в CSV (разделитель «;», десятичная запятая — для Excel с русской локалью) */
  function csv() {
    const q = (v) => { const s = String(v ?? ''); return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const avgOf = new Map(teamStats().map((e) => [e.name.toLowerCase(), e.avg]));
    const head = ['Матч', 'Дата', 'Команда', 'Сторона', ...MISSIONS.map((m) => m.id), 'Миссии', 'Штрафов', 'Вычтено', 'Итог', 'GP', 'Courtesy rule', 'Остановлен', 'Подтверждён', 'В зачёт', 'Среднее команды'];
    const lines = [head.map(q).join(';')];
    hist.forEach((m, i) => {
      for (const s of SIDES) {
        const r = m.teams[s];
        const nm = (r.name || T[s].name).trim();
        const avg = avgOf.get(nm.toLowerCase());
        lines.push([
          i + 1, new Date(m.date).toLocaleString('ru-RU'), nm, T[s].ru,
          ...MISSIONS.map((ms) => (r.rows && r.rows[ms.id] !== undefined ? r.rows[ms.id] : '')),
          r.missions, r.penalties, r.deducted, r.total, r.gp ?? '', r.courtesy ?? 0,
          m.aborted ? 'да' : 'нет', m.confirmed ? 'да' : 'нет', r.counted ? 'да' : 'нет', avg == null ? '' : num(avg),
        ].map(q).join(';'));
      }
    });
    return lines.join('\r\n');
  }
  function exportCsv() {
    const blob = new Blob(['﻿' + csv()], { type: 'text/csv;charset=utf-8' }); // BOM — Excel узнаёт UTF-8
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    a.href = url;
    a.download = `bioglow-matches-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return a.download;
  }
  function clearHistory() {
    hist = []; cur = null;
    saveHistory();
    render();
    return true;
  }

  // ---------- отрисовка ----------
  const visible = () => pane.classList.contains('on');
  function statusText() {
    if (!authority()) return 'Онлайн-гость: судейство ведёт хост, здесь только просмотр.';
    if (S.mode !== 'match') return 'Тренировка: штрафы, GP и Courtesy rule можно попробовать; правила «рук» не действуют — мышью двигается всё.';
    const ph = S.match.phase;
    if (ph === 'idle') return 'Подготовка к матчу: поставьте роботов в зоны Technician и проверьте их ниже. Фишки до старта не трогают.';
    if (ph === 'countdown') return 'Обратный отсчёт…';
    if (ph === 'running') return `Матч идёт, осталось ${clock()}. Мышь играет за команду «${teamName(S.team)}» (выбор в шапке).`;
    if (ph === 'settling') return 'Время! Фишки «успокаиваются» — через 2 с счёт зафиксируется.';
    return 'Матч окончен, счёт зафиксирован. Сверьте итог с командами и подтвердите.';
  }
  function renderTeams(sc) {
    const lock = !canEditResult();
    for (const s of SIDES) {
      const score = sc && sc[s] ? sc[s] : sim.score(s);
      const n = sim.penalties[s].n || 0;
      $(`refTot-${s}`).textContent = score.total;
      $(`refTotSub-${s}`).textContent = n ? `миссии ${score.missions} − ${score.missions - score.total}` : `миссии ${score.missions}`;
      $(`refPips-${s}`).querySelectorAll('i').forEach((p, i) => p.classList.toggle('on', n > i));
      $(`refPenText-${s}`).textContent = n === 0 ? 'Штрафов нет' : n >= 3 ? `Штрафов: ${n} — счёт матча 0` : `Штрафов: ${n} (−${n === 1 ? 10 : 30})`;
      const b = $(`refPen-${s}`);
      b.textContent = n === 0 ? 'Штраф −10' : n === 1 ? 'Штраф: ещё −20' : n === 2 ? 'Штраф: счёт → 0' : 'Штраф (счёт уже 0)';
      b.disabled = lock;
      b.setAttribute('aria-label', `${teamName(s)}: ${b.textContent}`);
      const u = $(`refUndo-${s}`);
      u.disabled = lock || n === 0;
      u.setAttribute('aria-label', `${teamName(s)}: отменить последний штраф`);
      renderPenLog(s, n);
      const g = $(`refGP-${s}`);
      const gv = gp[s] === null ? '' : String(gp[s]);
      if (g.value !== gv && document.activeElement !== g) g.value = gv;
      g.disabled = !!(cur && cur.confirmed);
      const c = sim.courtesy[s] || 0;
      const cb = $(`refCourt-${s}`);
      cb.disabled = !courtesyAllowed();
      cb.setAttribute('aria-label', `${teamName(s)}: Courtesy rule — вернуть застрявшего робота`);
      $(`refCourtN-${s}`).textContent = times(c);
      const w = $(`refCourtWarn-${s}`);
      w.hidden = c < 2;
      if (c >= 2) w.textContent = `Уже ${times(c)} за матч. Стратегическое злоупотребление Courtesy rule может быть наказано (Rulebook, правило 15; Update 01).`;
      const ni = $(`refName-${s}`);
      if (document.activeElement !== ni && ni.value !== names[s]) ni.value = names[s];
    }
  }
  const penSig = { red: '', blue: '' };
  function renderPenLog(s, n) {
    const list = pen[s].filter((e) => e.n <= n);
    const sig = n + ':' + list.map((e) => e.n + e.clock).join(',');
    if (sig === penSig[s]) return;
    penSig[s] = sig;
    const ol = $(`refPenLog-${s}`);
    if (!list.length && n) { ol.innerHTML = `<li><span>Штрафов: ${n} (назначены у хоста)</span></li>`; return; }
    ol.innerHTML = list.map((e) => {
      const R = REASONS.find((r) => r.id === e.reason) || REASONS[0];
      return `<li><time>${esc(e.clock)}</time><span>№${e.n} ${esc(R.short)}${e.note ? ' — ' + esc(e.note) : ''}</span><b>${e.delta === undefined ? '' : e.delta}</b></li>`;
    }).join('');
  }
  // Списки с кнопками перестраиваются только при смене содержания; длительность флага и строки проверки
  // обновляются на месте — фокус и нажатие кнопки (mousedown/mouseup на одном узле) не теряются.
  const durText = (f) => `(≈ ${(f.last - f.t0).toFixed(1)} с)`;
  /** Кнопка в фокусе внутри box -> селектор, чтобы вернуть фокус после перестройки */
  function focusKey(box, attrs) {
    const a = document.activeElement;
    if (!a || !box.contains(a)) return null;
    const parts = attrs.filter((k) => a.hasAttribute(k)).map((k) => `[${k}="${CSS.escape(a.getAttribute(k))}"]`);
    return parts.length ? 'button' + parts.join('') : null;
  }
  function refocus(box, sel) {
    if (!sel) return;
    const b = box.querySelector(sel);
    if (b && !b.disabled && !b.hidden) b.focus({ preventScroll: true });
  }
  let flagSig = '';
  function renderFlags(force = false) {
    const sig = flags.map((f) => `${f.id}${f.status}${f.note}${f.returned ? 1 : 0}${f.penSide || ''}`).join('|')
      + (flagsOn() ? 1 : 0) + authority() + S.mode + teamName('red') + '\n' + teamName('blue');
    if (!force && sig === flagSig) {
      for (const f of flags) {
        const sm = el.flags.querySelector(`li[data-fid="${f.id}"] .ref-dur`);
        if (!sm) continue;
        const show = f.last - f.t0 >= 0.5;
        if (sm.hidden === show) sm.hidden = !show;
        if (show) setText(sm, durText(f));
      }
      return;
    }
    flagSig = sig;
    const fk = focusKey(el.flags, ['data-act', 'data-id']);
    if (!flags.length) {
      el.flags.innerHTML = `<li class="ref-empty">${flagsOn() ? 'Пока ничего подозрительного.' : S.mode === 'match' ? 'Флаги появляются во время матча.' : 'В тренировке флаги выключены (флажок выше).'}</li>`;
      return;
    }
    const can = authority();
    el.flags.innerHTML = flags.map((f) => {
      const dur = f.last - f.t0;
      const who = f.side ? `<b class="ref-who ${f.side}">${esc(teamName(f.side))}</b>` : '<b class="ref-who">обе команды?</b>';
      const st = f.status === 'penalized' ? `<span class="ref-st">штраф: ${esc(teamName(f.penSide))}</span>` : f.status === 'dismissed' ? '<span class="ref-st">отклонено</span>' : '';
      let acts = '';
      if (f.status === 'open' && can) {
        const pens = f.side ? [f.side] : SIDES;
        acts = pens.map((s) => `<button type="button" class="btn small ref-pen" data-act="pen-${s}" data-id="${f.id}">Штраф: ${esc(teamName(s))}</button>`).join('')
          + (f.side && !f.returned && f.type !== 'hands' ? `<button type="button" class="btn ghost small" data-act="return" data-id="${f.id}" title="Правило 20: мешающее оборудование возвращается в зону Technician">Вернуть робота</button>` : '')
          + `<button type="button" class="btn ghost small" data-act="dismiss" data-id="${f.id}">Отклонить</button>`;
      }
      return `<li data-fid="${f.id}" class="${f.side || ''} ${f.status !== 'open' ? 'done' : ''}"><time>${esc(f.clock)}</time><div>${who} ${esc(f.text)} <small class="ref-dur"${dur >= 0.5 ? '' : ' hidden'}>${durText(f)}</small>${f.note ? ` <em>${esc(f.note)}</em>` : ''}${f.returned ? ' <small>робот возвращён</small>' : ''} ${st}</div>${acts ? `<div class="acts">${acts}</div>` : ''}</li>`;
    }).join('');
    refocus(el.flags, fk);
  }
  /** Живая проверка — в тренировке и до старта; после старта — снимок на момент старта */
  const inspLive = () => !(S.mode === 'match' && S.match.phase !== 'idle' && S.match.phase !== 'countdown' && inspSnap);
  /** Строка проверки команды: создаётся один раз, дальше меняются только тексты и видимость */
  function inspItem(s) {
    let li = el.insp.querySelector(`li[data-side="${s}"]`);
    if (!li) {
      li = document.createElement('li');
      li.dataset.side = s;
      li.innerHTML = '<div class="ref-insp-h"><b></b><span class="ref-badge"></span></div><p class="ref-insp-d"></p><ul hidden></ul><p class="ref-warn" hidden></p>'
        + `<button type="button" class="link" data-fix="${s}" hidden>вернуть в зону Technician</button>`;
      el.insp.appendChild(li);
    }
    return li;
  }
  function renderInspect() {
    const live = inspLive();
    const ins = live ? inspectBoth() : inspSnap;
    const locked = app.matchLocked() || !live;
    el.inspNote.hidden = live;
    el.inspBtn.disabled = !live;
    for (const s of SIDES) {
      const r = ins[s], li = inspItem(s);
      const cls = `${s} ${r.ok ? 'ok' : 'bad'}`;
      if (li.className !== cls) li.className = cls;
      setText(li.querySelector('.ref-insp-h b'), teamName(s));
      const badge = li.querySelector('.ref-badge'), bcls = 'ref-badge ' + (r.ok ? 'ok' : 'bad');
      setText(badge, r.ok ? 'готов' : 'не готов');
      if (badge.className !== bcls) badge.className = bcls;
      const b = r.bbox ? `${r.bbox.lengthCm} × ${r.bbox.widthCm} см` : '—';
      setText(li.querySelector('.ref-insp-d'), `${r.name} · высота ${r.heightCm} см (≤ 20.3) · габарит ${b}${r.massKg ? ` · ${r.massKg} кг` : ''} · в зоне Technician: ${r.inArea ? 'да' : 'нет'}`);
      const ul = li.querySelector('ul'), key = r.issues.join('\n');
      if (ul.dataset.k !== key) {
        ul.dataset.k = key;
        ul.replaceChildren(...r.issues.map((x) => { const e = document.createElement('li'); e.textContent = x; return e; }));
      }
      ul.hidden = !r.issues.length;
      const w = li.querySelector('.ref-warn'), wt = r.warnings && r.warnings.length ? r.warnings.join(' ') : '';
      setText(w, wt);
      w.hidden = !wt;
      const fix = li.querySelector('[data-fix]');
      const showFix = !r.ok && r.issues.some((x) => x.includes('зоне Technician')) && authority() && !locked;
      if (fix.hidden === showFix) fix.hidden = !showFix;
    }
    return ins;
  }
  function renderResult() {
    if (!cur) { el.resSec.hidden = true; return; }
    el.resSec.hidden = false;
    const t = cur.teams;
    const row = (label, f, cls = '') => `<tr class="${cls}"><th scope="row">${label}</th>${SIDES.map((s) => `<td class="n ${s}">${f(t[s], s)}</td>`).join('')}</tr>`;
    const mi = hist.indexOf(cur) + 1;
    el.result.innerHTML = `<table class="ref-tbl"><thead><tr><th scope="col">${mi ? 'Матч ' + mi : 'Матч хоста'}</th>${SIDES.map((s) => `<th scope="col" class="n ${s}">${esc(t[s].name)}</th>`).join('')}</tr></thead><tbody>`
      + MISSIONS.map((m) => row(`<span class="ref-mid">${m.id}</span>${esc(m.ru)}`, (r) => (r.rows ? r.rows[m.id] ?? 0 : 0))).join('')
      + row('Миссии', (r) => r.missions)
      + row('Штрафы', (r) => (r.penalties ? `${r.penalties} (−${r.deducted})` : '0'))
      + row('Итог', (r) => `<b>${r.total}</b>`, 'tot')
      + row('GP <small>(не в очках)</small>', (r) => (r.gp === null || r.gp === undefined ? '—' : r.gp))
      + row('Courtesy rule', (r) => r.courtesy || 0)
      + '</tbody></table>';
    el.resBadge.textContent = cur.confirmed ? 'официально' : cur.aborted ? 'остановлен' : 'на проверке';
    el.resBadge.className = 'ref-badge ' + (cur.confirmed ? 'ok' : cur.aborted ? 'bad' : '');
    el.confirm.textContent = cur.confirmed ? 'Снять подтверждение' : 'Команды согласны — результат официальный';
    el.confirm.disabled = !authority();
  }
  function renderHistory() {
    if (!hist.length) { el.hist.innerHTML = '<p class="ref-empty">Матчей пока нет. Итог каждого матча в режиме «Матч» попадает сюда автоматически.</p>'; el.csv.disabled = true; el.clear.disabled = true; return; }
    el.csv.disabled = false; el.clear.disabled = false;
    const st = teamStats();
    const dt = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };
    let h = `<div class="ref-scroll"><table class="ref-tbl ref-rank"><caption class="ref-sr">Средний счёт команд</caption><thead><tr><th scope="col">#</th><th scope="col">Команда</th><th scope="col" class="n">В зачёт</th><th scope="col" class="n">Среднее</th></tr></thead><tbody>`;
    st.forEach((e, i) => {
      h += `<tr><td>${e.avg === null ? '—' : i + 1}</td><th scope="row">${esc(e.name)}</th><td class="n">${e.n} из ${e.rows.length}${e.n < 3 ? ' <small class="ref-few" title="Для рейтинга нужно минимум 3 матча">мало</small>' : ''}</td><td class="n"><b>${e.avg === null ? '—' : num(e.avg)}</b></td></tr>`;
    });
    h += '</tbody></table></div>';
    for (const e of st) {
      h += `<details class="ref-team-hist"${st.length <= 2 ? ' open' : ''}><summary>${esc(e.name)} — среднее ${e.avg === null ? '—' : num(e.avg)} (${e.n} в зачёт)</summary><div class="ref-scroll"><table class="ref-tbl"><thead><tr><th scope="col">Матч</th><th scope="col"><span class="ref-sr">Сторона</span></th><th scope="col" class="n">Миссии</th><th scope="col" class="n">Штрафы</th><th scope="col" class="n">Итог</th><th scope="col" class="n">GP</th><th scope="col" class="c">Зачёт</th></tr></thead><tbody>`;
      for (const x of e.rows) {
        const r = x.r;
        const flagsTxt = (x.m.aborted ? ' <small title="Матч остановлен">стоп</small>' : '') + (x.m.confirmed ? ' <small title="Результат подтверждён">✓</small>' : '');
        h += `<tr class="${r.counted ? '' : 'off'}"><td>${x.i + 1}${flagsTxt}<small class="ref-date">${esc(dt(x.m.date))}</small></td><td><span class="ref-dot ${x.s}" title="${esc(T[x.s].ru)} сторона"></span><span class="ref-sr">${esc(T[x.s].ru)}</span></td><td class="n">${r.missions}</td><td class="n">${r.penalties ? `${r.penalties} (−${r.deducted})` : 0}</td><td class="n"><b>${r.total}</b></td><td class="n">${r.gp ?? '—'}</td>`
          + `<td class="c"><input type="checkbox" data-mid="${esc(x.m.id)}" data-side="${x.s}" ${r.counted ? 'checked' : ''} aria-label="Матч ${x.i + 1}, ${esc(e.name)}: в зачёт"></td></tr>`;
      }
      h += `</tbody><tfoot><tr><th scope="row" colspan="4">Среднее по матчам в зачёт</th><td class="n"><b>${e.avg === null ? '—' : num(e.avg)}</b></td><td colspan="2"></td></tr></tfoot></table></div></details>`;
    }
    // сохранить раскрытые блоки
    const open = new Set([...el.hist.querySelectorAll('details[open] summary')].map((s) => s.textContent.split(' — ')[0]));
    el.hist.innerHTML = h;
    if (open.size) el.hist.querySelectorAll('details').forEach((d) => { if (open.has(d.querySelector('summary').textContent.split(' — ')[0])) d.open = true; });
  }
  function render() {
    el.status.textContent = statusText();
    el.pick.disabled = !authority();
    renderTeams();
    renderFlags(true);
    renderInspect();
    renderResult();
    renderHistory();
  }

  // ---------- события интерфейса ----------
  el.reason.addEventListener('change', () => { reason = el.reason.value; store.set('ref.reason', reason); });
  for (const s of SIDES) {
    $(`refPen-${s}`).addEventListener('click', () => penalize(s, reason));
    $(`refUndo-${s}`).addEventListener('click', () => undoPenalty(s));
    $(`refGP-${s}`).addEventListener('change', (e) => setGP(s, e.target.value));
    $(`refCourt-${s}`).addEventListener('click', () => courtesy(s));
    const ni = $(`refName-${s}`);
    ni.value = names[s];
    ni.addEventListener('change', () => setTeamName(s, ni.value));
  }
  function setTeamName(side, name) {
    if (!SIDES.includes(side)) return '';
    names[side] = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    store.set('ref.names', names);
    syncCur();
    renderTeams(); renderResult(); renderHistory(); renderInspect();
    return teamName(side);
  }
  el.pick.addEventListener('click', () => setPick(!pick.on));
  el.flagsTrain.addEventListener('change', () => { trainFlags = el.flagsTrain.checked; store.set('ref.flagsTrain', trainFlags); renderFlags(true); });
  el.flags.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (b) flagAction(b.dataset.id, b.dataset.act);
  });
  $('refInspect').addEventListener('click', () => renderInspect());
  el.insp.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-fix]');
    if (!b || app.matchLocked() || !inspLive() || !authority()) return;
    const s = b.dataset.fix;
    sim.robots[s].resetPose();
    app.log(s, 'Робот возвращён в зону Technician для проверки', null);
    renderInspect();
    // ссылка скрылась — фокус не теряется, а переходит на «проверить»
    if (b.hidden && document.activeElement === b) el.inspBtn.focus({ preventScroll: true });
    announce(`${teamName(s)}: робот возвращён в зону Technician.`);
  });
  el.confirm.addEventListener('click', () => confirmResult(!(cur && cur.confirmed)));
  el.csv.addEventListener('click', () => exportCsv());
  el.clear.addEventListener('click', () => {
    const now = performance.now();
    if (now < clearArm) { clearArm = 0; el.clear.textContent = 'Очистить'; clearHistory(); return; }
    clearArm = now + 3000;
    el.clear.textContent = 'Точно очистить?';
    setTimeout(() => { if (performance.now() >= clearArm) { clearArm = 0; el.clear.textContent = 'Очистить'; } }, 3100);
  });
  el.hist.addEventListener('change', (e) => {
    const c = e.target;
    if (c && c.matches('input[type="checkbox"][data-mid]')) setCounted(c.dataset.mid, c.dataset.side, c.checked);
  });

  // ---------- события приложения ----------
  app.on('reset', () => {
    pen = { red: [], blue: [] };
    gp = { red: GP_DEFAULT, blue: GP_DEFAULT };
    cur = null; lastMissions = null; dragging = null; grab = null; inspSnap = null;
    toolsRest();
    clearFlags();
    render();
  });
  app.on('matchStart', () => {
    try { inspSnap = inspectBoth(); } catch (e) { inspSnap = null; }
    clearFlags(); lastMissions = null; render();
  });
  app.on('matchEnd', (ev) => { try { onMatchEnd(ev); } catch (e) { app.ui.showError(e, 'Судья: итог матча'); } });
  app.on('mode', (m) => {
    cur = null; inspSnap = null;
    if (m === 'train' && authority()) {
      // штрафы и Courtesy прошлого матча в тренировку не переносим
      for (const s of SIDES) { pen[s] = []; if (sim.penalties[s].n) sim.setPenalties(s, 0, { log: [] }); sim.courtesy[s] = 0; }
      gp = { red: GP_DEFAULT, blue: GP_DEFAULT };
    }
    toolsRest();
    clearFlags();
    render();
  });
  app.on('authority', () => { if (!authority()) setPick(false); render(); renderTool(); });
  app.on('team', () => { el.status.textContent = statusText(); });
  app.on('robotConfig', () => { if (visible()) renderInspect(); });
  app.on('tab', (id) => { if (id === 'referee') render(); });
  app.on('frame', (real) => {
    if (toastEl && !toastEl.hidden && performance.now() > toastT) toastEl.hidden = true;
    if (!visible()) return;
    uiAcc += real; inspAcc += real;
    if (uiAcc < 0.25) return;
    uiAcc = 0;
    el.status.textContent = statusText();
    renderTeams();
    renderFlags();
    const ph = S.match.phase;
    if (inspAcc >= 0.5 && (S.mode !== 'match' || ph === 'idle')) { inspAcc = 0; renderInspect(); }
  });

  render();
  updateTabBadge();
  renderTool();

  const api = {
    penalize, undoPenalty, setGP, gp: (side) => gp[side], courtesy, returnRobot,
    setPickMode: setPick, pickMode: () => pick.on, pickAt, removeItem,
    canDrag, handZone, toolZone, robotInTech,
    /** Инструмент Operator: лоток-катапульта (set/launch) и режим крючка (setMode) */
    tool: {
      setMode: setTool, mode: () => tool.on,
      get: (side) => ({ ...toolCfg[side] }),
      set: (side, o) => { const r = setToolCfg(side, o); renderTool(); return r; },
      launch: (side) => { const r = toolLaunch(side); renderTool(); return r; },
      state: (side) => { const tl = tools[side]; return tl ? { phase: tl.phase, phiDeg: +(tl.phi * 180 / Math.PI).toFixed(1), pose: { ...tl.pose }, cup: cupItems(side).map((t) => t.id) } : null; },
      cupItems: (side) => cupItems(side).map((t) => t.id),
      pose: (side, x, aim) => toolPose(side, x, aim),
    },
    checkFlags, flags: () => flags.map((f) => ({ ...f })), flagAction, clearFlags,
    inspect: inspectBoth,
    current: () => (cur ? JSON.parse(JSON.stringify(cur)) : null), confirmResult,
    history: () => JSON.parse(JSON.stringify(hist)), teamStats, setCounted, csv, exportCsv, clearHistory,
    setTeamName, teamName, penaltyLog: (side) => pen[side].map((e) => ({ ...e })),
    render,
  };
  app.referee = api;
  return api;
}
