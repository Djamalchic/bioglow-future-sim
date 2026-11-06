// App: склейка модулей, главный цикл (фиксированный шаг + замок с Python), вкладки, редактор двух команд,
// матч (проверка, отсчёт, 2:30, «успокоение», фиксация счёта), мышь, камеры, очки, протокол, телеметрия.
// Публичный объект — window.bioglow (см. app ниже); модули builder/referee/net/input получают его в install(app).
import * as THREE from 'three';
import { Sim, DT, colorReading } from './sim.js';
import { PRESETS, normalizeConfig } from './robotConfig.js';
import { Bridge } from './bridge.js';
import { PythonRunner, EXAMPLES, nextTask } from './python.js';
import { SIM } from './motors.js';
import { MISSIONS, INVASIVE_SPOTS, DEFAULT_INVASIVE_ORDER, FIELD_W, FIELD_H, WALL_T, WALL_H } from './layout.js';
import { groups, ALL, qRot, wrapPi } from './physics.js';
import { install as installInput, isTypingTarget, isControlTarget } from './input.js';

const $ = (id) => document.getElementById(id);
const SIDES = ['red', 'blue'];
const TEAM = {
  red: { side: 'red', name: 'Красные', ru: 'красная', gen: 'красной' },
  blue: { side: 'blue', name: 'Синие', ru: 'синяя', gen: 'синей' },
};
const MATCH_LEN = 150, COUNTDOWN = 3, SETTLE = 2;   // с (время симуляции)
const FREE_RUN_MS = 400;     // программа считает без ожиданий дольше — физика идёт без неё
const PUMP_SLICE_MS = 12;    // непрерывный счёт шагов до передышки для интерфейса
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clampInt = (v, a, b) => clamp(Math.round(Number(v) || 0), a, b);
const store = {
  get(k, d) { try { const v = localStorage.getItem('bioglow.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bioglow.' + k, JSON.stringify(v)); } catch { /* хранилище недоступно */ } },
  del(k) { try { localStorage.removeItem('bioglow.' + k); } catch { /* хранилище недоступно */ } },
};
const params = new URLSearchParams(location.search);

// Посещаемость: одно обращение в сутки с устройства, без cookies и личных данных (сервер считает только число)
{
  const day = new Date().toLocaleDateString('sv'); // ГГГГ-ММ-ДД по местному времени
  if (location.protocol !== 'file:' && store.get('visitDay', '') !== day) {
    store.set('visitDay', day);
    fetch('/api/visit', { cache: 'no-store', keepalive: true }).catch(() => { /* офлайн — не считаем */ });
  }
}

let sim = null, app = null;
const bridges = {}, runners = {};
const consoles = {};

// ---------- состояние ----------
const freshMatch = () => ({ phase: 'idle', left: MATCH_LEN, cd: 0, settle: 0, aborted: false, final: null });
const S = {
  mode: 'train',
  team: SIDES.includes(store.get('team', 'red')) ? store.get('team', 'red') : 'red', // команда клавиатуры, камеры, телеметрии
  edit: 'red',                // команда, чью программу редактируем
  speed: 1, paused: params.has('pause'), cam: '3d',
  match: freshMatch(),
  trainT0: 0,
  sel: { red: 'mine', blue: 'mine' },     // 'mine' | 'prev' | id примера
  prog: { red: 'idle', blue: 'idle' },    // состояние программ
  autorun: { red: false, blue: false, ...store.get('autorun', {}) },
  scheme2: !!store.get('scheme2', false),
};
S.edit = SIDES.includes(store.get('editSide', S.team)) ? store.get('editSide', S.team) : S.team;

// ---------- ошибки ----------
let errShown = '', errT = 0, errRepeat = 0;
function showError(e, where = '') {
  const msg = (where ? where + ': ' : '') + (e && e.message ? e.message : String(e));
  const now = performance.now();
  // одна и та же ошибка (например, в обработчике каждого шага) — в консоль не чаще раза в 3 с
  if (msg === errShown && now - errT < 3000) { errRepeat++; return; }
  if (errRepeat) console.warn(`[bioglow] предыдущая ошибка повторилась ещё ${errRepeat} раз`);
  errRepeat = 0;
  console.error(e);
  errShown = msg; errT = now;
  const bar = $('errbar');
  if (!bar) return;
  $('errText').textContent = msg;
  bar.hidden = false;
}
function fatal(title, detail) {
  if (typeof window.__bootFail === 'function') window.__bootFail(title, detail);
  else { document.body.textContent = title + ': ' + detail; }
}

// ---------- запуск (вызывается в конце модуля, когда все объявления готовы) ----------
async function boot() {
  // WebGL нужен для 3D-поля
  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2') || probe.getContext('webgl');
  if (!gl) throw new Error('WebGL недоступен: включите аппаратное ускорение в браузере или обновите драйвер видеокарты.');
  try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* контекст освободит сборщик мусора */ }
  const vp = $('viewport');
  sim = await Sim.create(vp, { configs: { red: loadConfig('red'), blue: loadConfig('blue') } });
  buildApp();
  installInput(app);
  app.input.setTeam(S.team);
  app.input.setScheme2(S.scheme2);
  for (const s of SIDES) {
    bridges[s] = new Bridge(sim, s);
    runners[s] = new PythonRunner(s, bridges[s], {
      out: (text, cls) => printOut(s, text, cls),
      onState: (st, info) => onProgramState(s, st, info),
    });
  }
  initEditor();
  initUI();
  initMouse(vp);
  sim.on('event', (side, text) => app.log(side, text, null));
  sim.on('reset', () => { prevSig = ''; prevRows = null; app.emit('reset'); });
  sim.on('robot', (side) => { syncAttachmentSelect(); app.emit('robotConfig', side); });
  new ResizeObserver(() => { sim.resize(); refitCam(); }).observe(vp);
  // поле с выбранными инвазивными видами
  sim.invasives.red = invSel.red.slice(); sim.invasives.blue = invSel.blue.slice();
  if (sim.invasives.red.length || sim.invasives.blue.length) sim.resetField({ keepRobots: false });
  setMode('train');
  setCam('3d');
  for (const s of SIDES) onProgramState(s, 'idle', {});
  if (!runners.red.available) for (const s of SIDES) printOut(s, 'Python (Skulpt) не загрузился: нет доступа к cdn.jsdelivr.net. Ручное управление работает.\n', 'err');
  if (S.paused) $('btnPause').textContent = 'Дальше';
  window.bioglow = app;
  startLoop();
  // необязательные модули: ошибка в одном не ломает приложение
  for (const name of ['builder', 'referee', 'net']) {
    try {
      const m = await import(`./${name}.js`);
      if (m && typeof m.install === 'function') await m.install(app);
    } catch (e) {
      showError(e, `Модуль ${name}.js`);
      const pane = app.ui.panel(name === 'net' ? 'online' : name);
      if (pane) pane.innerHTML = `<p class="hint">Модуль «${name}» не загрузился: ${escapeHtml(e && e.message ? e.message : String(e))}</p>`;
    }
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

function loadConfig(side) {
  const c = store.get('config.' + side, null);
  if (c && typeof c === 'object') return c;
  const att = store.get('attachment', 'scoop');
  return PRESETS.find((p) => p.attachment.type === att) || PRESETS[0];
}

// ---------- App ----------
function buildApp() {
  const listeners = {};
  app = {
    sim,
    state: S,
    teams: TEAM,
    runners,
    bridges,
    input: null,
    net: null,
    stepAuthority: true,
    on(ev, fn) { (listeners[ev] ||= []).push(fn); return () => app.off(ev, fn); },
    off(ev, fn) { const a = listeners[ev]; if (a) listeners[ev] = a.filter((f) => f !== fn); },
    emit(ev, ...a) {
      const arr = listeners[ev];
      if (!arr) return;
      for (const f of [...arr]) { try { f(...a); } catch (e) { showError(e, `Обработчик «${ev}»`); } }
    },
    /** Запись в протокол: side — 'red' | 'blue' | null, delta — изменение очков или null */
    log(side, text, delta) { addLog(side, text, delta); },
    ui: {
      tab(id) { return selectTab(id); },
      panel(id) { return $('pane-' + id); },
      showError,
      banner(t, sub) { if (t) showBanner(t, sub); else hideBanner(); },
      setCam(c) { setCam(c); },
      /** Сообщение для экранного диктора (живая область вне вкладок — слышно при любой открытой вкладке) */
      announce(text) { announce(text); },
    },
    /** Политика перетаскивания мышью (заменяется модулем судьи). item — фишка или Robot, side — команда игрока. */
    canDrag(item, side) {
      if (!app.stepAuthority || S.paused) return false;
      if (S.mode === 'train') return true;
      if (S.match.phase === 'idle') return isRobot(item); // подготовка к матчу: только поставить робота
      return false;
    },
    /** true — эта вкладка считает физику (хост/локально); false — гость: только показывает снимки хоста */
    setStepAuthority(isHost) {
      const v = !!isHost;
      if (v === app.stepAuthority) return;
      app.stepAuthority = v;
      if (!v) { endDrag(); for (const s of SIDES) if (runners[s].running) runners[s].stop(); }
      loop.owed = 0; loop.forced = 0;
      updateLocks();
      app.emit('authority', v);
    },
    codeOf(side) { return codeOf(side); },
    setCode(side, code, { select = 'mine' } = {}) { setTeamCode(side, code, select); },
    runProgram(side, code) { return runProgram(side, code); },
    stopProgram(side) { return stopProgram(side); },
    runBoth() { return runBoth(); },
    stopAll() { return stopAll(); },
    /** «По старту матча»: состояние, флажок и хранилище вместе (используйте вместо S.autorun[side] = v) */
    setAutorun(side, v) { setAutorun(side, v); },
    /** Очистить консоль команды (вместе с ещё не выведенным буфером) */
    clearConsole(side) { if (SIDES.includes(side)) clearConsole(side); },
    /** Пересобрать робота команды; конфигурация сохраняется. -> результат sim.setRobotConfig */
    setRobotConfig(side, cfg, opts = {}) { return setRobotConfig(side, cfg, opts); },
    resetField() { return resetField(); },
    setMode(m) { setMode(m); },
    startMatch(opts) { return startMatch(opts); },
    endMatch(aborted = true) { return abortMatch(aborted); },
    newMatch() { return newMatch(); },
    matchLocked() { return matchLocked(); },
    setSpeed(v) { setSpeed(v); },
    setPaused(p) { setPaused(p); },
    setTeam(side) { setTeam(side); },
    loop: null,
    store,
  };
  app.loop = loop;
}
const isRobot = (item) => !!(item && item.chassis && item.bodies);

// ---------- редактор: своя программа у каждой команды ----------
let editor = null;
const docs = {};      // side -> CodeMirror.Doc
const plain = {};     // side -> текст (без CodeMirror)
let silent = 0;       // программная замена текста — не сохранять как «Мой код» (review C2)
const errLine = { red: null, blue: null };

// «Мой код» и его прежние версии: правка примера делает его «Моим кодом», а прежний «Мой код» уходит
// в историю (до HIST_MAX версий). Версии, полученные из примеров, вытесняются первыми — свой код живёт дольше.
const HIST_MAX = 6;
const PROMOTE_EDITS = 20;   // столько правок поверх примера — и это уже свой код
const editsOnMine = { red: 0, blue: 0 };
const isHistSel = (v) => typeof v === 'string' && v.startsWith('hist:');
function hist(side) {
  const h = store.get('codeHist.' + side, []);
  return Array.isArray(h) ? h.filter((x) => x && typeof x.code === 'string') : [];
}
function pushHist(side, code, from) {
  if (!code || !code.trim()) return;
  const h = hist(side).filter((x) => x.code !== code);
  h.unshift({ code, from: from || 'mine', t: Date.now() });
  while (h.length > HIST_MAX) {
    let i = -1;
    for (let k = h.length - 1; k >= 1; k--) if (h[k].from !== 'mine') { i = k; break; }
    h.splice(i >= 0 ? i : h.length - 1, 1);
  }
  store.set('codeHist.' + side, h);
}
/** Новый текст «Моего кода» (прежний — в историю) */
function setMine(side, code, from) {
  const prev = store.get('code.' + side, '') || '';
  if (prev.trim() && prev !== code) pushHist(side, prev, store.get('codeFrom.' + side, 'mine'));
  store.set('code.' + side, String(code));
  store.set('codeFrom.' + side, from || 'mine');
  editsOnMine[side] = 0;
}
let tabOut = false;   // Esc в редакторе: следующий Tab/Shift+Tab уводит фокус (без ловушки клавиатуры)

function initEditor() {
  // перенос старого единственного «Моего кода» в слот красных
  const legacy = store.get('code', null);
  if (legacy && store.get('code.red', null) === null) store.set('code.red', legacy);
  for (const s of SIDES) {
    // старый одноуровневый резерв -> история
    const prev = store.get('codePrev.' + s, null);
    if (typeof prev === 'string' && prev.trim()) pushHist(s, prev, 'mine');
    if (prev !== null) store.del('codePrev.' + s);
    const mine = store.get('code.' + s, null);
    let sel = store.get('sel.' + s, null);
    if (sel === 'prev') sel = 'hist:0';
    // по умолчанию у команд разные примеры: одинаковые квадраты двух роботов сходятся у центра поля
    if (!sel || (sel !== 'mine' && !isHistSel(sel) && !EXAMPLES.some((e) => e.id === sel))) sel = mine && mine.trim() ? 'mine' : (s === 'red' ? 'square' : 'gyro');
    if (isHistSel(sel) && !hist(s)[Number(sel.slice(5))]) sel = 'mine';
    S.sel[s] = sel;
  }
  const ta = $('code');
  const CM = window.CodeMirror;
  if (CM) {
    for (const s of SIDES) docs[s] = new CM.Doc(textFor(s, S.sel[s]), 'python');
    // Esc: следующий Tab/Shift+Tab — обычный переход фокуса браузера. Клавиша со значением false в добавленной
    // раскладке CodeMirror не обрабатывает вовсе (CM.Pass не годится: дальше сработал бы Tab базовой раскладки).
    const tabOutMap = { Tab: false, 'Shift-Tab': false };
    const endTabOut = () => { if (tabOut) { tabOut = false; editor.removeKeyMap(tabOutMap); } };
    editor = CM.fromTextArea(ta, {
      mode: 'python', lineNumbers: true, indentUnit: 4, tabSize: 4, indentWithTabs: false, smartIndent: true,
      screenReaderLabel: 'Программа на Python. Esc, затем Tab — выйти из редактора',
      extraKeys: {
        Tab: (cm) => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('    ', 'end')),
        'Shift-Tab': (cm) => cm.indentSelection('subtract'),
        Esc: (cm) => { if (!tabOut) { tabOut = true; cm.addKeyMap(tabOutMap); } },
        'Ctrl-Enter': () => runProgram(S.edit), 'Cmd-Enter': () => runProgram(S.edit),
      },
    });
    editor.on('keydown', (cm, e) => { if (e.key !== 'Escape' && e.key !== 'Tab' && e.key !== 'Shift') endTabOut(); });
    editor.on('blur', endTabOut);
    editor.swapDoc(docs[S.edit]);
    editor.on('change', onEdit);
  } else {
    for (const s of SIDES) plain[s] = textFor(s, S.sel[s]);
    ta.value = plain[S.edit];
    ta.addEventListener('input', () => { plain[S.edit] = ta.value; onEdit(); });
    ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runProgram(S.edit); } });
  }
  $('examples').addEventListener('change', (e) => {
    const side = S.edit, v = e.target.value;
    S.sel[side] = v; store.set('sel.' + side, v);
    setEditorText(side, textFor(side, v));
  });
  fillExamples();
}
function textFor(side, v) {
  if (v === 'mine') return store.get('code.' + side, '') || '';
  if (v === 'prev') v = 'hist:0';
  if (isHistSel(v)) return (hist(side)[Number(v.slice(5))] || { code: '' }).code;
  return (EXAMPLES.find((e) => e.id === v) || EXAMPLES[0]).code;
}
function codeOf(side) { return editor ? docs[side].getValue() : (plain[side] ?? ''); }
function setEditorText(side, text) {
  silent++;
  try {
    if (editor) docs[side].setValue(text);
    else { plain[side] = text; if (S.edit === side) $('code').value = text; }
  } finally { silent--; }
  clearErrLine(side);
}
/** Правка пользователем: текст становится «Моим кодом» команды; прежний «Мой код» — в историю */
function onEdit() {
  if (silent) return;
  const side = S.edit;
  clearErrLine(side);
  const v = S.sel[side];
  if (v !== 'mine') {
    const from = isHistSel(v) ? ((hist(side)[Number(v.slice(5))] || {}).from || 'mine') : v;
    setMine(side, codeOf(side), from);
    S.sel[side] = 'mine'; store.set('sel.' + side, 'mine');
    fillExamples();
    return;
  }
  store.set('code.' + side, codeOf(side));
  // много правок поверх примера — это уже своя программа (её история бережёт дольше)
  if (store.get('codeFrom.' + side, 'mine') !== 'mine' && ++editsOnMine[side] >= PROMOTE_EDITS) store.set('codeFrom.' + side, 'mine');
}
/** Поставить программу команде извне (онлайн, конструктор). select: 'mine' | id примера | 'hist:N' */
function setTeamCode(side, code, select = 'mine') {
  if (!SIDES.includes(side)) return;
  if (select === 'prev') select = 'hist:0';
  if (select === 'mine') setMine(side, String(code), 'mine');
  S.sel[side] = select; store.set('sel.' + side, select);
  setEditorText(side, select === 'mine' ? String(code) : textFor(side, select));
  if (side === S.edit) fillExamples();
}
/** Короткая подпись версии: время и первая содержательная строка */
function histLabel(x) {
  const d = new Date(x.t || 0);
  const when = Number.isFinite(d.getTime()) && x.t ? d.toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const line = (x.code.split('\n').map((l) => l.trim()).find((l) => l && !/^(import|from)\s/.test(l)) || '').replace(/^#\s*/, '');
  const ex = x.from !== 'mine' ? EXAMPLES.find((e) => e.id === x.from) : null;
  return `↶ ${when}${ex ? ' · из примера' : ''} — ${line.length > 34 ? line.slice(0, 33) + '…' : line || '(пусто)'}`;
}
function fillExamples() {
  const side = S.edit, sel = $('examples');
  const h = hist(side);
  sel.innerHTML = '';
  sel.add(new Option(`Мой код — ${TEAM[side].name.toLowerCase()} (сохраняется)`, 'mine'));
  if (h.length) {
    const g = document.createElement('optgroup'); g.label = 'Прежние версии «Моего кода»';
    h.forEach((x, i) => g.appendChild(new Option(histLabel(x), 'hist:' + i)));
    sel.appendChild(g);
  }
  const grp = document.createElement('optgroup'); grp.label = 'Примеры';
  for (const e of EXAMPLES) grp.appendChild(new Option(e.name, e.id));
  sel.appendChild(grp);
  const v = S.sel[side];
  sel.value = [...sel.options].some((o) => o.value === v) ? v : 'mine';
}
function clearErrLine(side) {
  const l = errLine[side];
  if (l === null) return;
  if (editor) try { docs[side].removeLineClass(l, 'background', 'cm-error-line'); } catch { /* строки уже нет */ }
  errLine[side] = null;
}
function markErrLine(side, line) {
  clearErrLine(side);
  if (!editor || !line) return;
  const l = clamp(line - 1, 0, docs[side].lineCount() - 1);
  docs[side].addLineClass(l, 'background', 'cm-error-line');
  errLine[side] = l;
  if (side === S.edit) editor.scrollIntoView({ line: l, ch: 0 }, 60);
}
function setEditSide(side) {
  if (!SIDES.includes(side)) return;
  S.edit = side; store.set('editSide', side);
  if (editor) { editor.swapDoc(docs[side]); setTimeout(() => editor.refresh(), 0); }
  else $('code').value = plain[side] ?? '';
  fillExamples();
  document.querySelectorAll('#editTeam button').forEach((b) => { const on = b.dataset.side === side; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  for (const s of SIDES) consoles[s].hidden = s !== side;
  consoles[side].scrollTop = consoles[side].scrollHeight;
  $('consoleTitle').textContent = `Консоль · ${TEAM[side].name.toLowerCase()}`;
  $('autorun').checked = !!S.autorun[side];
  document.querySelector(`#editTeam button[data-side="${side}"]`)?.classList.remove('unread');
  renderProgState();
}

// ---------- консоли команд ----------
// Вывод копится и выводится пачкой не чаще раза в CON_FLUSH_MS (один reflow вместо reflow на каждый print).
const CON_MAX_SPANS = 800, CON_CHUNK = 2048, CON_PEND_MAX = 1500, CON_FLUSH_MS = 40;
const pend = { red: [], blue: [] }, dropped = { red: 0, blue: 0 };
let lastFlush = 0;
function printOut(side, text, cls) {
  if (!consoles[side]) return;
  // новый запуск (у гостя консоль очищает net.js) — недоведённый вывод прошлого прогона не нужен
  if (typeof text === 'string' && text.startsWith('▶ Запуск')) { pend[side].length = 0; dropped[side] = 0; }
  const p = pend[side], c = cls || '', last = p[p.length - 1];
  if (last && last.cls === c && last.text.length + text.length <= CON_CHUNK) last.text += text;
  else p.push({ text: String(text), cls: c });
  if (p.length > CON_PEND_MAX) { dropped[side] += p.length - CON_PEND_MAX; p.splice(0, p.length - CON_PEND_MAX); }
}
function flushConsoles() {
  lastFlush = performance.now();
  for (const side of SIDES) {
    const p = pend[side], el = consoles[side];
    if (!el || (!p.length && !dropped[side])) continue;
    const frag = document.createDocumentFragment();
    const add = (text, cls) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text; frag.appendChild(s); };
    if (dropped[side]) { add(`… пропущено ${dropped[side]} фрагментов вывода (программа печатает слишком быстро) …\n`, 'warn'); dropped[side] = 0; }
    for (const x of p) add(x.text, x.cls);
    el.appendChild(frag);
    for (let n = el.childNodes.length - CON_MAX_SPANS; n > 0; n--) el.removeChild(el.firstChild);
    if (!el.hidden) el.scrollTop = el.scrollHeight;
    if (side !== S.edit) document.querySelector(`#editTeam button[data-side="${side}"]`)?.classList.add('unread');
    const out = p.splice(0);
    for (const x of out) app.emit('console', side, x.text, x.cls);
  }
}
function clearConsole(side) {
  pend[side].length = 0; dropped[side] = 0;
  if (consoles[side]) consoles[side].textContent = '';
}

// ---------- программы ----------
const ranText = { red: null, blue: null }; // последний запущенный текст программы команды
const STATE_RU = { idle: 'готов', running: 'работает', done: 'готово', stopped: 'остановлено', error: 'ошибка', remote: 'у хоста' };
function onProgramState(side, st, info = {}) {
  flushConsoles(); // строки программы — раньше, чем её итог (так же уходят и гостям)
  S.prog[side] = st;
  // строку подсвечиваем, только если запускали текст из редактора (а не код извне — онлайн, тесты)
  if (st === 'error' && info.line && ranText[side] === codeOf(side)) markErrLine(side, info.line);
  renderProgState();
  if (st !== 'running') { bridges[side].levers = { driver: [0, 0], specialist: [0, 0] }; }
  app.emit('programState', side, st, info);
}
function renderProgState() {
  const st = S.prog[S.edit];
  const pill = $('runState');
  pill.textContent = STATE_RU[st] || st;
  pill.className = 'pill ' + (st === 'running' ? 'running' : st === 'error' ? 'error' : '');
  const why = app.stepAuthority ? runBlockedReason() : '';
  $('btnRun').disabled = st === 'running' || !!why;
  $('btnStop').disabled = st !== 'running';
  $('btnRunBoth').disabled = !!why;
  $('btnStopAll').disabled = !SIDES.some((s) => S.prog[s] === 'running');
  // почему кнопки неактивны — видно сразу (подсказка и строка под кнопками)
  $('btnRun').title = why || 'Запустить программу этой команды (Ctrl+Enter)';
  $('btnRunBoth').title = why || 'Запустить программы красных и синих одновременно';
  const hint = $('runHint');
  if (hint) { if (hint.textContent !== why) hint.textContent = why; hint.hidden = !why; }
  const ar = $('autorun');
  if (ar && ar.checked !== !!S.autorun[S.edit]) ar.checked = !!S.autorun[S.edit];
  for (const s of SIDES) {
    const b = document.querySelector(`#editTeam button[data-side="${s}"]`);
    if (b) b.dataset.state = S.prog[s];
  }
}
/** «По старту матча» для команды: состояние + хранилище + флажок */
function setAutorun(side, v) {
  if (!SIDES.includes(side)) return;
  S.autorun[side] = !!v;
  store.set('autorun', { red: !!S.autorun.red, blue: !!S.autorun.blue });
  renderProgState();
}
/** Почему программы сейчас нельзя запустить ('' — можно) */
function runBlockedReason() {
  if (S.mode !== 'match') return '';
  const ph = S.match.phase;
  if (ph === 'idle') return 'Матч ещё не начался: программы запускаются после «Старт» — включите «по старту матча», и программа команды запустится сама.';
  if (ph === 'countdown') return 'Идёт обратный отсчёт.';
  if (ph === 'settling' || ph === 'ended') return 'Матч окончен — программы не запускаются.';
  return '';
}
async function runProgram(side, code) {
  if (!SIDES.includes(side)) return 'bad-side';
  if (code === undefined || code === null) code = codeOf(side);
  code = String(code);
  if (!app.stepAuthority) { app.emit('remoteRun', side, code); printOut(side, '▶ Программа отправлена хосту\n', 'ok'); return 'remote'; }
  const why = runBlockedReason();
  if (why) { printOut(side, why + '\n', 'warn'); return 'blocked'; }
  const r = runners[side];
  if (r.running) await r.stop();
  clearErrLine(side);
  clearConsole(side);
  printOut(side, `▶ Запуск (${TEAM[side].ru} команда)\n`, 'ok');
  releaseManual(side); // моторы — программе: ручные команды (W/R/G) не должны ехать дальше сами
  // фокус с кнопки — на поле: Space не нажмёт кнопку повторно, клавиши сразу работают как рычаги
  if (document.activeElement && document.activeElement.tagName === 'BUTTON') $('viewport').focus({ preventScroll: true });
  ranText[side] = code;
  return r.run(code);
}
function stopProgram(side) {
  if (!SIDES.includes(side)) return Promise.resolve('bad-side');
  if (!app.stepAuthority) { app.emit('remoteStop', side); return Promise.resolve('remote'); }
  return runners[side].stop();
}
function runBoth() { return Promise.all(SIDES.map((s) => runProgram(s))); }
function stopAll() { return Promise.all(SIDES.map((s) => (runners[s].running ? stopProgram(s) : Promise.resolve('idle')))); }

// ---------- робот ----------
function setRobotConfig(side, cfg, opts = {}) {
  if (!SIDES.includes(side)) return { ok: false, errors: ['Неизвестная команда'] };
  const locked = matchLocked();
  if (runners[side].running && !opts.keepProgram) runners[side].stop();
  if (drag && drag.kind === 'robot' && drag.r.side === side) endDrag();
  const res = sim.setRobotConfig(side, cfg, { force: !!opts.force && !locked });
  if (res.ok && opts.persist !== false) store.set('config.' + side, res.cfg);
  return res;
}
/** Ключ конфигурации для сравнения «тот же робот» (без имени и цвета) */
const cfgKey = (c) => { try { const n = normalizeConfig(c || {}); n.name = ''; n.teamColor = ''; delete n.hardware; return JSON.stringify(n); } catch { return ''; } };
/** Готовый робот для обеих команд: показываем пресет, только если ОБА робота точно такие; иначе «свой / разные» */
function syncAttachmentSelect() {
  const sel = $('attachment');
  if (!sel || !sim) return;
  const kr = cfgKey(sim.robots.red.config), kb = cfgKey(sim.robots.blue.config);
  const p = kr === kb ? PRESETS.find((x) => cfgKey(x) === kr) : null;
  const ph = sel.querySelector('option[value=""]');
  if (ph) ph.textContent = kr === kb ? '— свой робот (из конструктора) —' : '— у команд разные роботы —';
  sel.value = p ? p.attachment.type : '';
}

// ---------- вкладки ----------
const TABS = ['code', 'missions', 'builder', 'referee', 'online', 'log', 'help'];
function selectTab(id) {
  if (!TABS.includes(id)) return false;
  document.querySelectorAll('.tabs [role="tab"]').forEach((b) => {
    const on = b.dataset.tab === id;
    b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.side .pane').forEach((p) => p.classList.toggle('on', p.id === 'pane-' + id));
  if (id === 'code' && editor) setTimeout(() => editor.refresh(), 0);
  store.set('tab', id);
  app.emit('tab', id);
  return true;
}

// ---------- интерфейс ----------
function initUI() {
  for (const s of SIDES) consoles[s] = $('console-' + s);
  // вкладки (+ стрелки по ARIA)
  const tabBtns = [...document.querySelectorAll('.tabs [role="tab"]')];
  tabBtns.forEach((b, i) => {
    b.addEventListener('click', () => selectTab(b.dataset.tab));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const n = tabBtns[(i + (e.key === 'ArrowRight' ? 1 : tabBtns.length - 1)) % tabBtns.length];
      selectTab(n.dataset.tab); n.focus();
    });
  });
  selectTab(TABS.includes(store.get('tab', 'code')) ? store.get('tab', 'code') : 'code');

  // программы
  document.querySelectorAll('#editTeam button').forEach((b) => b.addEventListener('click', () => setEditSide(b.dataset.side)));
  $('btnRun').addEventListener('click', () => runProgram(S.edit));
  $('btnStop').addEventListener('click', () => stopProgram(S.edit));
  $('btnRunBoth').addEventListener('click', () => runBoth());
  $('btnStopAll').addEventListener('click', () => stopAll());
  $('btnClear').addEventListener('click', () => clearConsole(S.edit));
  $('autorun').addEventListener('change', (e) => setAutorun(S.edit, e.target.checked));
  setEditSide(S.edit);

  // шапка
  $('team').value = S.team;
  $('team').addEventListener('change', (e) => setTeam(e.target.value));
  $('speed').addEventListener('change', (e) => setSpeed(Number(e.target.value)));
  $('btnPause').addEventListener('click', () => setPaused(!S.paused));
  $('btnReset').addEventListener('click', () => resetField());
  $('modeTrain').addEventListener('click', () => setMode('train'));
  $('modeMatch').addEventListener('click', () => setMode('match'));
  $('btnMatch').addEventListener('click', matchButton);
  $('errClose').addEventListener('click', () => { $('errbar').hidden = true; });
  $('chkCancel').addEventListener('click', hideCheck);
  $('chkFix').addEventListener('click', () => {
    for (const s of SIDES) if (!sim.inspect(s).ok) { sim.robots[s].resetPose(); app.log(s, 'Робот возвращён в зону Technician для проверки', null); }
    const ins = { red: sim.inspect('red'), blue: sim.inspect('blue') };
    if (ins.red.ok && ins.blue.ok) hideCheck(); else showCheck(ins);
  });
  $('chkForce').addEventListener('click', () => { hideCheck(); startMatch({ force: true }); });

  // настройки поля и робота
  const att = $('attachment');
  att.innerHTML = '';
  att.add(new Option('— свой робот (из конструктора) —', ''));
  for (const p of PRESETS) att.add(new Option(p.name, p.attachment.type));
  syncAttachmentSelect();
  att.addEventListener('change', (e) => {
    const type = e.target.value;
    const preset = PRESETS.find((p) => p.attachment.type === type);
    if (!preset) { syncAttachmentSelect(); return; } // «свой / разные» — только показ состояния
    store.set('attachment', type);
    for (const s of SIDES) {
      const res = setRobotConfig(s, preset, { force: true });
      if (res.ok) app.log(s, `Робот: «${preset.name}»`, null);
      else app.log(s, 'Робота не пересобрать: ' + (res.errors || []).join(' '), null);
    }
    syncAttachmentSelect();
  });
  $('maxDeg').value = store.get('maxDeg', 1000);
  SIM.maxDegS = clampInt($('maxDeg').value, 200, 2000);
  $('maxDeg').addEventListener('change', (e) => { SIM.maxDegS = clampInt(e.target.value, 200, 2000); e.target.value = SIM.maxDegS; store.set('maxDeg', SIM.maxDegS); });
  $('matFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => { try { sim.setMatImage(img); } catch (err) { showError(err, 'Коврик'); } URL.revokeObjectURL(img.src); };
    img.onerror = () => showError(new Error('Не удалось открыть картинку коврика'));
    img.src = URL.createObjectURL(f);
  });
  buildInvasivePicker();
  $('scheme2').checked = S.scheme2;
  $('scheme2').addEventListener('change', (e) => { S.scheme2 = e.target.checked; store.set('scheme2', S.scheme2); app.input.setScheme2(S.scheme2); renderKeys(); });
  renderKeys();

  // камеры
  document.querySelectorAll('.cam button').forEach((b) => b.addEventListener('click', () => setCam(b.dataset.cam)));

  // таблица миссий
  $('missionRows').innerHTML = MISSIONS.map((m) => `<tr data-id="${m.id}"><td><span class="mid">${m.id}</span>${m.name}<small>${m.ru}</small></td><td class="r"><b>0</b><small></small></td><td class="b"><b>0</b><small></small></td></tr>`).join('');

  // Кнопка, получившая фокус мышью/касанием: Space на ней — горячая клавиша «программа», а не повторное
  // нажатие (иначе Space после щелчка по «Старт/Стоп» останавливал матч). Фокус с клавиатуры (Tab) —
  // Space нажимает кнопку, как обычно.
  let ptrDown = false, ptrBtn = null, spaceEaten = false;
  window.addEventListener('pointerdown', (e) => { ptrDown = true; ptrBtn = e.target && e.target.closest ? e.target.closest('button, a, summary') : null; }, true);
  for (const ev of ['pointerup', 'pointercancel']) window.addEventListener(ev, () => { ptrDown = false; }, true);
  window.addEventListener('focusin', () => { if (!ptrDown) ptrBtn = null; }, true);
  window.addEventListener('keyup', (e) => { if (e.code === 'Space' && spaceEaten) { spaceEaten = false; e.preventDefault(); } }, true);
  /** Esc/Space «за свою клавиатуру»: команда из шапки (+ вторая, если за клавиатурой второй игрок) */
  const keyboardTeams = () => (S.scheme2 ? SIDES : [S.team]);
  const fieldTarget = (t) => !t || t === document.body || t === document.documentElement || t === $('viewport');

  // горячие клавиши (KeyboardEvent.code — работает в русской раскладке)
  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    switch (e.code) {
      case 'Space':
        if (isControlTarget(e.target) && e.target !== ptrBtn) return; // фокус с клавиатуры — нажать кнопку
        e.preventDefault();
        spaceEaten = isControlTarget(e.target);
        if (runners[S.team].running) stopProgram(S.team); else runProgram(S.team);
        break;
      case 'Escape': {
        // в матче (и у онлайн-хоста) Esc не трогает программу соперника
        const own = S.mode === 'match' || !!(app.net && app.net.isHost) ? keyboardTeams() : SIDES;
        for (const s of own) if (runners[s].running) stopProgram(s);
        break;
      }
      case 'KeyP': setPaused(!S.paused); break;
      // сброс поля — только когда фокус на поле (не на кнопке/вкладке)
      case 'Backspace': if (S.mode === 'train' && fieldTarget(e.target)) { e.preventDefault(); resetField(); } break;
      case 'Digit1': setCam('3d'); break;
      case 'Digit2': setCam('top'); break;
      case 'Digit3': setCam('base'); break;
      case 'Digit4': setCam('follow'); break;
      default: break;
    }
  });
}

function renderKeys() {
  const a = '<span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> ехать</span><span><kbd>R</kbd>/<kbd>F</kbd> рука (в матче — только в зоне Technician)</span><span><kbd>G</kbd> Grand Tree</span><span><kbd>H</kbd> — Token Recycler</span><span><kbd>Shift</kbd> медленно</span><span><kbd>Space</kbd> программа</span>';
  const b = S.scheme2 ? `<span class="k2">${TEAM[S.team === 'red' ? 'blue' : 'red'].name}: <kbd>I</kbd><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd> <kbd>U</kbd>/<kbd>O</kbd> рука <kbd>Y</kbd> Grand Tree <kbd>N</kbd> — Token Recycler, правый <kbd>Shift</kbd> — медленно, правый <kbd>Shift</kbd>+<kbd>Y</kbd> — дерево назад</span>` : '';
  $('keys').innerHTML = a + b;
}

function setTeam(side) {
  if (!SIDES.includes(side)) return;
  S.team = side; store.set('team', side);
  $('team').value = side;
  app.input.setTeam(side);
  setEditSide(side);
  syncAttachmentSelect();
  if (S.cam === 'base') setCam('base');
  renderKeys();
  app.emit('team', side);
}
function setSpeed(v) {
  if (matchLocked()) { $('speed').value = '1'; return; }
  S.speed = [0.25, 0.5, 1, 2, 4].includes(v) ? v : 1;
  $('speed').value = String(S.speed);
}
function setPaused(p) {
  if (matchLocked()) p = false;
  S.paused = !!p;
  $('btnPause').textContent = S.paused ? 'Дальше' : 'Пауза';
  $('btnPause').setAttribute('aria-pressed', String(S.paused));
  if (S.paused) endDrag();
}

// ---------- режимы и матч ----------
function matchLocked() { return S.mode === 'match' && ['countdown', 'running', 'settling'].includes(S.match.phase); }
function inputFrozen() { return S.mode === 'match' && S.match.phase !== 'running'; }

function setMode(m) {
  if (m !== 'train' && m !== 'match') return;
  if (matchLocked()) return;
  S.mode = m;
  S.match = freshMatch();
  hideCheck(); hideBanner();
  if (m === 'match') { resetField(); app.log(null, 'Режим матча: поставьте роботов в зоны Technician и нажмите «Старт»', null); }
  else { sim.unlatch(); S.trainT0 = sim.time; }
  updateLocks();
  app.emit('mode', m);
}
function updateLocks() {
  const lock = matchLocked();
  $('modeTrain').classList.toggle('on', S.mode === 'train');
  $('modeMatch').classList.toggle('on', S.mode === 'match');
  $('modeTrain').setAttribute('aria-pressed', String(S.mode === 'train'));
  $('modeMatch').setAttribute('aria-pressed', String(S.mode === 'match'));
  for (const id of ['modeTrain', 'modeMatch', 'speed', 'btnPause', 'btnReset', 'attachment']) $(id).disabled = lock || !app.stepAuthority;
  const b = $('btnMatch');
  if (S.mode === 'train') { b.textContent = 'Сброс таймера'; b.title = 'Сбросить таймер тренировки (поле не трогает)'; b.disabled = false; }
  else {
    const ph = S.match.phase;
    b.textContent = ph === 'idle' ? 'Старт' : ph === 'ended' ? 'Новый матч' : 'Стоп';
    b.title = ph === 'idle' ? 'Проверка роботов, отсчёт и матч 2:30' : ph === 'ended' ? 'Сбросить поле для нового матча' : 'Остановить матч';
    b.disabled = ph === 'settling' || !app.stepAuthority;
  }
  if (app.input) app.input.frozen = inputFrozen();
  renderProgState();
}
function matchButton() {
  if (S.mode === 'train') { S.trainT0 = sim.time; return; }
  const ph = S.match.phase;
  if (ph === 'idle') startMatch();
  else if (ph === 'countdown' || ph === 'running') abortMatch(true);
  else if (ph === 'ended') newMatch();
}
/** Старт матча: проверка роботов (inspection) обеих команд, затем отсчёт. opts: { force, autorun } */
function startMatch(opts = {}) {
  if (!app.stepAuthority) return { ok: false, reason: 'Матчем управляет хост' };
  if (S.mode !== 'match') setMode('match');
  if (S.match.phase !== 'idle') return { ok: false, reason: 'Матч уже идёт' };
  const ins = { red: sim.inspect('red'), blue: sim.inspect('blue') };
  if (!opts.force && (!ins.red.ok || !ins.blue.ok)) { showCheck(ins); return { ok: false, inspect: ins }; }
  hideCheck();
  endDrag();
  if (opts.autorun) for (const s of SIDES) setAutorun(s, opts.autorun === true || (Array.isArray(opts.autorun) && opts.autorun.includes(s)));
  setSpeed(1); S.speed = 1; $('speed').value = '1';
  setPaused(false);
  S.match.phase = 'countdown'; S.match.cd = COUNTDOWN; S.match.left = MATCH_LEN;
  app.log(null, 'Матч: обратный отсчёт', null);
  announce('Матч: обратный отсчёт 3 секунды');
  updateLocks();
  return { ok: true, inspect: ins };
}
/** Шаг часов матча (по времени симуляции) */
function matchStep(dt) {
  if (S.mode !== 'match') return;
  const m = S.match;
  if (m.phase === 'countdown') {
    m.cd -= dt;
    if (m.cd <= 1e-9) {
      m.phase = 'running'; m.left = MATCH_LEN; m.startT = sim.time;
      updateLocks();
      app.log(null, 'Матч начался (2:30)', null);
      announce('Старт! Матч начался, 2 минуты 30 секунд');
      app.emit('matchStart', { time: sim.time });
      for (const s of SIDES) if (S.autorun[s]) runProgram(s);
    }
  } else if (m.phase === 'running') {
    m.left -= dt;
    if (m.left <= 1e-9) { m.left = 0; finishMatch(false); }
  } else if (m.phase === 'settling') {
    m.settle -= dt;
    if (m.settle <= 1e-9) latchMatch();
  }
}
/** 0:00 (или «Стоп»): программы и моторы стоп, ввод заморожен, физика досчитывает ~2 с */
function finishMatch(aborted) {
  const m = S.match;
  m.phase = 'settling'; m.settle = SETTLE; m.aborted = !!aborted;
  endDrag();
  for (const s of SIDES) { if (runners[s].running) runners[s].stop(); stopTeamMotors(s); manual[s].drive = manual[s].arm = manual[s].tree = false; }
  updateLocks();
  showBanner(aborted ? 'Матч остановлен' : 'Время!', 'досчитываем положение фишек…');
  app.log(null, aborted ? 'Матч остановлен судьёй' : 'Время! Программы и моторы остановлены', null);
  announce(aborted ? 'Матч остановлен' : 'Время! Программы и моторы остановлены');
}
function latchMatch() {
  const m = S.match;
  const fin = sim.latchScore();
  m.phase = 'ended'; m.final = fin;
  updateLocks();
  showBanner(m.aborted ? 'Матч остановлен' : 'Итог матча', `Красные ${fin.red.total} · Синие ${fin.blue.total}`, { result: true });
  app.log(null, `Итог матча${m.aborted ? ' (остановлен)' : ''}: красные ${fin.red.total}, синие ${fin.blue.total}`, null);
  announce(`Матч окончен. Итог: красные ${fin.red.total}, синие ${fin.blue.total}. Подробности — во вкладке «Судья».`);
  updateScores(true);
  app.emit('matchEnd', { red: fin.red, blue: fin.blue, aborted: m.aborted, time: sim.time });
}
function abortMatch(aborted = true) {
  const ph = S.match.phase;
  if (ph === 'countdown') { S.match = freshMatch(); hideBanner(); updateLocks(); app.log(null, 'Старт отменён', null); return 'cancelled'; }
  if (ph === 'running') { finishMatch(aborted); return 'settling'; }
  return ph;
}
function newMatch() {
  if (matchLocked()) return false;
  S.match = freshMatch();
  resetField();
  updateLocks();
  return true;
}
function stopTeamMotors(side) {
  const r = sim.robots[side];
  r.cancelTurn('aborted'); r.stopMove(); r.arm.stop();
  sim.treeMotors[side].forEach((m) => m.stop());
}
function resetField() {
  if (matchLocked() || !app.stepAuthority) return false;
  endDrag();
  for (const s of SIDES) if (runners[s].running) runners[s].stop();
  sim.invasives.red = invSel.red.slice();
  sim.invasives.blue = invSel.blue.slice();
  sim.resetField();
  S.trainT0 = sim.time;
  prevRows = null; prevSig = '';
  // протокол не стираем — только черта «поле сброшено» (сброс отменить нельзя, а записи могут понадобиться)
  logSeparator(S.mode === 'match' ? 'Поле сброшено — новый матч' : 'Поле сброшено');
  if (S.mode === 'match') S.match = freshMatch();
  hideBanner(); hideCheck();
  updateLocks();
  return true;
}
function logSeparator(text) {
  const log = $('log');
  if (log.firstChild && log.firstChild.classList && log.firstChild.classList.contains('sep')) log.firstChild.remove();
  if (!log.firstChild) return;
  const li = document.createElement('li'); li.className = 'sep';
  li.textContent = `${new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })} · ${text}`;
  log.prepend(li);
}

// ---------- баннер на поле и сообщения диктору ----------
let bannerKey = '', bannerT = 0;
/** opts.result — итог матча: кнопки «Подробно»/«×», через 4 с баннер уходит в угол и не закрывает поле */
function showBanner(t, sub, opts = {}) {
  const el = $('banner');
  const key = `${t}|${sub || ''}|${opts.result ? 1 : 0}`;
  if (key === bannerKey && !el.hidden) return; // без пересоздания каждые 150 мс (отсчёт)
  bannerKey = key;
  clearTimeout(bannerT);
  el.innerHTML = '';
  el.classList.toggle('result', !!opts.result);
  el.classList.remove('corner');
  const h = document.createElement('span'); h.className = 'banner-t'; h.textContent = t; el.append(h);
  if (sub) { const s = document.createElement('small'); s.textContent = sub; el.append(s); }
  if (opts.result) {
    const bar = document.createElement('span'); bar.className = 'banner-btns';
    const more = document.createElement('button'); more.type = 'button'; more.className = 'btn small'; more.textContent = 'Подробно — вкладка «Судья»';
    more.addEventListener('click', () => { app.ui.tab('referee'); el.classList.add('corner'); });
    const x = document.createElement('button'); x.type = 'button'; x.className = 'banner-x'; x.textContent = '×';
    x.setAttribute('aria-label', 'Скрыть итог матча'); x.title = 'Скрыть итог (поле видно целиком)';
    x.addEventListener('click', hideBanner);
    bar.append(more, x); el.append(bar);
    bannerT = setTimeout(() => el.classList.add('corner'), 4000);
  }
  el.hidden = false;
}
function hideBanner() { clearTimeout(bannerT); bannerKey = ''; $('banner').hidden = true; }
let announceT = 0;
function announce(text) {
  const el = $('srLive');
  if (!el) return;
  // очистка и запись в следующей задаче — диктор прочтёт и повтор того же текста
  el.textContent = '';
  clearTimeout(announceT);
  announceT = setTimeout(() => { el.textContent = String(text); }, 60);
}

// ---------- Level Up: какие инвазивные виды и куда (решает команда — Missions p8) ----------
const INV_TYPES = [
  { type: 'IR', title: 'Вид на подставке-кольце', where: 'Young Forest и Grand Tree' },
  { type: 'IS', title: 'Малый вид', where: 'Grand Tree и Nest' },
];
const invSel = loadInvasives();
function loadInvasives() {
  const ok = (a) => (Array.isArray(a) ? a.filter((id, i) => INVASIVE_SPOTS.some((s) => s.id === id) && a.indexOf(id) === i).slice(0, 5) : []);
  const saved = store.get('invasives', null);
  if (saved && typeof saved === 'object') return { red: ok(saved.red), blue: ok(saved.blue) };
  // старый формат — число на команду
  const r = { red: DEFAULT_INVASIVE_ORDER.slice(0, clampInt(store.get('invRed', 0), 0, 5)), blue: DEFAULT_INVASIVE_ORDER.slice(0, clampInt(store.get('invBlue', 0), 0, 5)) };
  store.del('invRed'); store.del('invBlue');
  if (r.red.length || r.blue.length) store.set('invasives', r);
  return r;
}
function buildInvasivePicker() {
  const box = $('invPick');
  if (!box) return;
  box.innerHTML = '';
  for (const side of SIDES) {
    const fs = document.createElement('fieldset'); fs.className = 'inv-team ' + side;
    const lg = document.createElement('legend'); fs.append(lg);
    const upd = () => { lg.textContent = `${TEAM[side].name}: ${invSel[side].length} из 5 (+${invSel[side].length * 20})`; };
    for (const T of INV_TYPES) {
      const g = document.createElement('div'); g.className = 'inv-group';
      const h = document.createElement('div'); h.className = 'inv-type';
      h.innerHTML = `<b>${escapeHtml(T.title)}</b><small>${escapeHtml(T.where)}</small>`;
      g.append(h);
      for (const sp of INVASIVE_SPOTS.filter((x) => x.type === T.type)) {
        const lab = document.createElement('label'); lab.className = 'chk';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = sp.id;
        cb.checked = invSel[side].includes(sp.id);
        cb.addEventListener('change', () => {
          const cur = invSel[side].filter((id) => id !== sp.id);
          if (cb.checked) cur.push(sp.id);
          invSel[side] = INVASIVE_SPOTS.map((x) => x.id).filter((id) => cur.includes(id));
          store.set('invasives', { red: invSel.red, blue: invSel.blue });
          upd();
        });
        lab.append(cb, ' ' + sp.name);
        g.append(lab);
      }
      fs.append(g);
    }
    upd();
    box.append(fs);
  }
}
function showCheck(ins) {
  const box = $('chkList');
  box.innerHTML = '';
  for (const s of SIDES) {
    const li = document.createElement('li');
    li.className = s + (ins[s].ok ? ' ok' : '');
    const b = document.createElement('b'); b.textContent = TEAM[s].name + ': ';
    li.append(b, ins[s].ok ? `готов (высота ${ins[s].heightCm} см)` : ins[s].issues.join(' '));
    box.appendChild(li);
  }
  $('matchCheck').hidden = false;
}
function hideCheck() { $('matchCheck').hidden = true; }

// ---------- ввод -> роботы ----------
const manual = { red: { drive: false, arm: false, tree: false }, blue: { drive: false, arm: false, tree: false } };
/** Остановить моторы, которые крутил ручной ввод команды, и отдать их программе */
function releaseManual(side) {
  const man = manual[side], robot = sim.robots[side];
  try {
    if (man.drive) { robot.cancelTurn('aborted'); robot.stopMove(); }
    if (man.arm) robot.arm.stop();
    if (man.tree) sim.treeMotors[side].forEach((m) => m.stop());
  } catch (e) { showError(e, 'Ручное управление'); }
  man.drive = man.arm = man.tree = false;
}
function applyInput(dt) {
  const inp = app.input;
  inp.frozen = inputFrozen();
  const all = inp.poll(dt);
  if (!app.stepAuthority) return; // гость: ввод отправляет net.js
  for (const side of SIDES) {
    const ti = all[side], br = bridges[side], man = manual[side];
    br.levers = { driver: ti.levers.driver.slice(), specialist: ti.levers.specialist.slice() };
    const robot = sim.robots[side];
    // клавиши — рычаги пульта (review M13); ручные команды гасит runProgram до старта Python
    if (runners[side].running) { man.drive = man.arm = man.tree = false; }
    else if (!(drag && drag.kind === 'robot' && drag.r === robot)) {
      const slow = ti.slow ? 0.35 : 1;
      const f = ti.drive.fwd, t = ti.drive.turn;
      if (f || t) {
        const lf = (f * 70 - t * 45) * slow, rf = (f * 70 + t * 45) * slow;
        robot.cancelTurn('aborted');
        robot.left.run(-robot.left.pctToDeg(lf)); robot.right.run(robot.right.pctToDeg(rf));
        man.drive = true;
      } else if (man.drive) { robot.stopMove(); man.drive = false; }
      if (ti.arm) { robot.arm.run(robot.arm.pctToDeg(ti.arm * 70 * slow)); man.arm = true; }
      else if (man.arm) { robot.arm.stop(); man.arm = false; }
      const tm = sim.treeMotors[side];
      if (ti.tree) { tm[0].run(-SIM.maxDegS * ti.tree); tm[1].run(SIM.maxDegS * ti.tree); man.tree = true; }
      else if (man.tree) { tm.forEach((m) => m.stop()); man.tree = false; }
    }
    if (ti.recycle) sim.recycle(side);
  }
}

// ---------- мышь: перетаскивание с учётом столкновений (review M7) ----------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let drag = null;   // { kind:'token'|'robot', t|r, tx,ty,tz, yaw, offx, offz, auto }
const LIFT = 0.4;  // см — робот чуть над ковриком (не трётся колёсами), но барьеры и фишки на пути упираются
const DRAG_ACC = 1200;  // см/с² — предел горизонтального ускорения «рукой»: упор в препятствие останавливает робота
const DRAG_HOLD = 4000; // см/с² — удержание высоты (робот не «перекатывается» через низкий барьер)
const TOKEN_HALF = { K: 0.7, R: 0.6 };

function initMouse(vp) {
  vp.addEventListener('pointerdown', (e) => {
    vp.focus({ preventScroll: true });
    if (e.button !== 0) return;
    const hit = pick(e);
    if (!hit) return;
    const item = hit.token || hit.robot;
    if (!app.canDrag(item, S.team)) return;
    e.stopPropagation(); e.preventDefault();
    beginDrag(hit);
    if (drag) {
      sim.controls.enabled = false;
      try { vp.setPointerCapture(e.pointerId); } catch { /* указатель уже отпущен */ }
    }
  }, { capture: true });
  vp.addEventListener('pointermove', (e) => {
    if (!drag || drag.auto) return;
    const p = planePoint(e, drag.kind === 'robot' ? 3 : drag.ty);
    if (!p) return;
    drag.tx = clamp(p.x + drag.offx, -116.5, 116.5);
    drag.tz = clamp(p.z + drag.offz, -55.5, 55.5);
    if (drag.kind === 'token') drag.ty = tokenHeightAt(drag.t, drag.tx, drag.tz);
  });
  const up = () => { if (drag && !drag.auto) endDrag(); };
  vp.addEventListener('pointerup', up);
  vp.addEventListener('pointercancel', up);
  vp.addEventListener('wheel', (e) => {
    let r = drag && drag.kind === 'robot' ? drag.r : null;
    if (!r) {
      const hit = pick(e);
      // quiet: колесо над роботом — обычно масштаб камеры, подсказку «нельзя» не показываем
      if (!hit || !hit.robot || drag || !app.canDrag(hit.robot, S.team, { quiet: true })) return;
      beginDrag({ robot: hit.robot, point: hit.robot.position });
      if (!drag) return;
      drag.auto = performance.now() + 600;
      r = hit.robot;
    }
    e.preventDefault(); e.stopPropagation();
    drag.yaw += (e.deltaY > 0 ? -1 : 1) * (e.shiftKey ? 1 : 7.5) * Math.PI / 180;
    if (drag.auto) drag.auto = performance.now() + 600;
  }, { capture: true, passive: false });
}
function pick(e) {
  const rc = sim.renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1);
  ray.setFromCamera(ndc, sim.camera);
  const objs = [...sim.tokens.filter((t) => t.mesh.visible).map((t) => t.mesh), sim.robots.red.group, sim.robots.blue.group];
  for (const h of ray.intersectObjects(objs, true)) {
    let o = h.object;
    while (o) {
      if (o.userData && o.userData.token) return { token: o.userData.token, point: h.point };
      if (o === sim.robots.red.group) return { robot: sim.robots.red, point: h.point };
      if (o === sim.robots.blue.group) return { robot: sim.robots.blue, point: h.point };
      o = o.parent;
    }
  }
  return null;
}
function planePoint(e, y) {
  const rc = sim.renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1);
  ray.setFromCamera(ndc, sim.camera);
  const p = new THREE.Vector3();
  return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p) ? p : null;
}
/** Высота, на которой держим фишку: поверхность под курсором (луч вниз) + зазор */
function tokenHeightAt(t, x, z) {
  const hit = sim.phys.ray({ x, y: 60, z }, { x: 0, y: -1, z: 0 }, 80, groups(ALL, ALL), t.body);
  const top = hit ? 60 - hit.toi : 0;
  return Math.max(0, top) + (TOKEN_HALF[t.type] ?? 0.05) + 1.2;
}
function beginDrag(hit) {
  endDrag();
  if (hit.token) {
    const t = hit.token;
    if (!t.body || t.where !== 'field' || !t.body.isEnabled()) return;
    const p = t.body.translation();
    t.body.setGravityScale(0, true); t.body.wakeUp();
    drag = { kind: 'token', t, tx: p.x, tz: p.z, ty: 0, offx: p.x - hit.point.x, offz: p.z - hit.point.z };
    drag.ty = Math.max(p.y, tokenHeightAt(t, p.x, p.z));
  } else if (hit.robot) {
    const r = hit.robot, p = r.position;
    for (const b of r.bodies) { b.setGravityScale(0, true); b.wakeUp(); }
    r.dragging = true;
    drag = { kind: 'robot', r, tx: p.x, tz: p.z, ty: r.geo.hc + LIFT, yaw: r.yawWorld, offx: p.x - hit.point.x, offz: p.z - hit.point.z };
  }
  app.emit('drag', drag ? (drag.t || drag.r) : null);
}
function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  try {
    if (d.kind === 'token' && d.t.body) {
      d.t.body.setGravityScale(1, true);
      const v = d.t.body.linvel();
      d.t.body.setLinvel({ x: v.x * 0.2, y: Math.min(0, v.y), z: v.z * 0.2 }, true);
      d.t.body.wakeUp();
    } else if (d.kind === 'robot') {
      for (const b of d.r.bodies) { b.setGravityScale(1, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true); b.wakeUp(); }
      d.r.dragging = false;
    }
  } catch (e) { /* тело уже удалено (сброс/пересборка) */ }
  if (sim) sim.controls.enabled = S.cam !== 'follow';
  app.emit('drag', null);
}
/** Перед шагом физики: тянуть схваченное к цели скоростью (стенки и модели не проходятся) */
function dragStep() {
  const d = drag;
  if (!d) return;
  if (d.auto && performance.now() > d.auto) { endDrag(); return; }
  const item = d.t || d.r;
  if (!app.canDrag(item, S.team)) { endDrag(); return; }
  // по горизонтали — к курсору с ограничением скорости; по высоте — жёстко держим высоту,
  // чтобы упор в барьер не «выталкивал» схваченное наверх
  const hv = (p, gain, max) => {
    let vx = (d.tx - p.x) * gain, vz = (d.tz - p.z) * gain;
    const sp = Math.hypot(vx, vz);
    if (sp > max) { vx *= max / sp; vz *= max / sp; }
    return [vx, vz];
  };
  if (d.kind === 'token') {
    const b = d.t.body;
    if (!b || d.t.where !== 'field' || !b.isEnabled()) { endDrag(); return; }
    const p = b.translation();
    const [vx, vz] = hv(p, 14, 80);
    b.setLinvel({ x: vx, y: clamp((d.ty - p.y) * 40, -60, 60), z: vz }, true);
    const w = b.angvel(); b.setAngvel({ x: w.x * 0.85, y: w.y * 0.85, z: w.z * 0.85 }, true);
  } else {
    // робот — несколько тел на шарнирах: тянем корпус ограниченной силой («рука»), чтобы упор колёс
    // или навесного в борт/модель через шарниры останавливал весь робот
    const r = d.r;
    if (!r.bodies.length || sim.robots[r.side] !== r) { endDrag(); return; }
    const ch = r.chassis, p = ch.translation(), v = ch.linvel(), w = ch.angvel();
    const M = d.mass || (d.mass = r.bodies.reduce((s, b) => s + b.mass(), 0));
    const [vx, vz] = hv(p, 10, 50);
    const vy = clamp((d.ty - p.y) * 20, -40, 40);
    let ix = 0.5 * M * (vx - v.x), iz = 0.5 * M * (vz - v.z);
    const n = Math.hypot(ix, iz), maxI = M * DRAG_ACC * DT;
    if (n > maxI) { ix *= maxI / n; iz *= maxI / n; }
    const iy = clamp(0.5 * M * (vy - v.y), -M * DRAG_HOLD * DT, M * DRAG_HOLD * DT);
    ch.applyImpulse({ x: ix, y: iy, z: iz }, true);
    const u = qRot(ch.rotation(), { x: 0, y: 1, z: 0 });   // держим «вверх» (крен/тангаж) и курс
    const wy = clamp(wrapPi(d.yaw - r.yawWorld) * 6, -3, 3);
    const I = M * 36; // ≈ M·(6 см)²
    const tilt = (a) => clamp(a, -I * 120 * DT, I * 120 * DT);
    const ax = tilt(0.5 * I * (-10 * u.z - w.x)), az = tilt(0.5 * I * (10 * u.x - w.z));
    const ay = clamp(0.5 * I * (wy - w.y), -I * 40 * DT, I * 40 * DT);
    ch.applyTorqueImpulse({ x: ax, y: ay, z: az }, true);
  }
}

// ---------- камеры ----------
// Готовые виды подбирают расстояние под форму окна: весь стол (2362×1143 мм + борта) в кадре при любом
// соотношении сторон (как превью конструктора). В портретной ориентации «Сверху» и «3D» смотрят вдоль стола.
const TABLE_HX = FIELD_W / 20 + WALL_T / 10, TABLE_HZ = FIELD_H / 20 + WALL_T / 10, TABLE_TOP = WALL_H / 10;
const CAM_MARGIN = 0.94;     // доля кадра (NDC), в которую вписываем углы стола
let camUser = false;         // пользователь сам крутил камеру — при изменении окна вид не трогаем
let camHooked = false;
/** Расстояние вдоль dir (единичный вектор от цели к камере), при котором все углы стола в кадре */
function fitDistance(cam, target, dir, ext) {
  const corners = [];
  for (const x of [ext.x0, ext.x1]) for (const z of [-TABLE_HZ, TABLE_HZ]) for (const y of [0, TABLE_TOP]) corners.push(new THREE.Vector3(x, y, z));
  // базис камеры как в three.js lookAt (up = +Y): x = up × z, y = z × x, z — от цели к камере
  const f = dir.clone().negate();
  const r = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
  const u = new THREE.Vector3().crossVectors(dir, r).normalize();
  const tv = Math.tan((cam.fov * Math.PI / 180) / 2), th = tv * cam.aspect;
  const fits = (d) => {
    const eye = target.clone().addScaledVector(dir, d);
    for (const c of corners) {
      const v = c.clone().sub(eye);
      const z = v.dot(f);
      if (z <= cam.near) return false;
      if (Math.abs(v.dot(r) / z) > th * CAM_MARGIN || Math.abs(v.dot(u) / z) > tv * CAM_MARGIN) return false;
    }
    return true;
  };
  let lo = 20, hi = 2000;
  if (!fits(hi)) return hi;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
  return hi;
}
function setCam(c) {
  S.cam = c;
  camUser = false;
  document.querySelectorAll('.cam button').forEach((b) => { const on = b.dataset.cam === c; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  const cam = sim.camera, ctl = sim.controls;
  if (!camHooked) { camHooked = true; ctl.addEventListener('start', () => { camUser = true; }); }
  ctl.enabled = c !== 'follow' && !drag;
  const s = S.team === 'red' ? -1 : 1;
  const portrait = cam.aspect < 0.95;
  let ext = { x0: -TABLE_HX, x1: TABLE_HX };
  let dir = null, target = null;
  if (c === '3d') {
    // ландшафт: с длинной стороны стола; портрет: со стороны своей команды (стол «уходит вдаль»)
    dir = portrait ? new THREE.Vector3(s * 0.75, 1, 0) : new THREE.Vector3(0, 150, 167);
    target = new THREE.Vector3(0, 0, portrait ? 0 : 6);
  } else if (c === 'top') {
    // строго сверху; в портрете длинная ось стола — вдоль экрана, своя сторона внизу
    dir = portrait ? new THREE.Vector3(s * 0.002, 1, 0) : new THREE.Vector3(0, 1, 0.002);
    target = new THREE.Vector3(0, 0, 0);
  } else if (c === 'base') {
    // со стороны своей команды: в кадре своя половина стола целиком
    dir = new THREE.Vector3(s * 155, 95, 0);
    target = new THREE.Vector3(s * 20, 0, 0);
    ext = s < 0 ? { x0: -TABLE_HX, x1: 0 } : { x0: 0, x1: TABLE_HX };
  }
  if (dir) {
    dir.normalize();
    const dist = fitDistance(cam, target, dir, ext);
    ctl.maxDistance = Math.max(600, dist * 1.4);
    ctl.target.copy(target);
    cam.position.copy(target).addScaledVector(dir, dist);
  }
  ctl.update();
}
/** Окно изменилось — заново вписать готовый вид (если камеру не крутили руками) */
function refitCam() {
  if (!sim || camUser || drag) return;
  if (S.cam === '3d' || S.cam === 'top' || S.cam === 'base') setCam(S.cam);
}
const camTmp = { p: new THREE.Vector3(), t: new THREE.Vector3() };
function followCam(dt) {
  if (S.cam !== 'follow') return;
  const r = sim.robots[S.team];
  const f = r.forward, p = r.position;
  camTmp.p.set(p.x - f.x * 40, 28, p.z - f.z * 40);
  camTmp.t.set(p.x + f.x * 22, 2, p.z + f.z * 22);
  const k = 1 - Math.exp(-dt * 6);
  sim.camera.position.lerp(camTmp.p, k);
  sim.controls.target.lerp(camTmp.t, k);
  sim.camera.lookAt(sim.controls.target);
}

// ---------- очки и протокол ----------
let prevRows = null, prevSig = '';
function clockText() {
  let t;
  if (S.mode === 'match') {
    const ph = S.match.phase;
    t = ph === 'running' ? Math.ceil(Math.max(0, S.match.left) - 1e-6) : ph === 'settling' || ph === 'ended' ? 0 : MATCH_LEN;
  } else t = Math.floor(sim.time - S.trainT0);
  t = Math.max(0, t);
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}
function addLog(side, text, delta) {
  const li = document.createElement('li');
  if (side) li.className = side;
  const tm = document.createElement('time'); tm.textContent = clockText();
  const tx = document.createElement('span'); tx.textContent = (side ? TEAM[side].name + ' · ' : '') + text;
  const d = document.createElement('b'); d.textContent = delta == null ? '' : (delta > 0 ? '+' : '') + delta;
  li.append(tm, tx, d);
  const log = $('log');
  log.prepend(li);
  while (log.childNodes.length > 300) log.removeChild(log.lastChild);
}
function updateScores(force = false) {
  const sc = { red: sim.score('red'), blue: sim.score('blue') };
  const sig = JSON.stringify([sc.red.total, sc.blue.total, sc.red.provisional, sc.blue.provisional, sc.red.penalties, sc.blue.penalties, sc.red.latched, sc.red.rows.map((r) => r.pts + r.detail), sc.blue.rows.map((r) => r.pts + r.detail)]);
  if (sig === prevSig && !force) return;
  prevSig = sig;
  $('scoreRed').textContent = sc.red.total; $('scoreBlue').textContent = sc.blue.total;
  for (const [side, id] of [['red', 'scoreRed'], ['blue', 'scoreBlue']]) {
    const box = $(id).parentElement;
    box.classList.toggle('prov', sc[side].provisional);
    box.title = TEAM[side].name + (sc[side].provisional ? ' — ≈ счёт ещё может измениться (фишки или механизмы в движении)' : '');
  }
  $('totRed').textContent = sc.red.total; $('totBlue').textContent = sc.blue.total;
  for (const tr of $('missionRows').children) {
    const id = tr.dataset.id;
    for (const [side, cls] of [['red', '.r'], ['blue', '.b']]) {
      const row = sc[side].rows.find((x) => x.id === id);
      if (!row) continue;
      const cell = tr.querySelector(cls);
      cell.querySelector('b').textContent = row.pts;
      cell.querySelector('small').textContent = row.detail;
    }
  }
  if (prevRows && !sc.red.latched) {
    for (const side of SIDES) for (const row of sc[side].rows) {
      const old = prevRows[side].rows.find((x) => x.id === row.id);
      if (old && old.pts !== row.pts) addLog(side, `${row.id} ${MISSIONS.find((m) => m.id === row.id)?.name || ''}`, row.pts - old.pts);
    }
  }
  prevRows = sc;
  app.emit('score', sc);
}

// ---------- телеметрия ----------
const COLOR_NAMES = { [-1]: 'нет', 0: 'чёрный', 1: 'пурпурный', 2: 'фиолетовый', 3: 'синий', 4: 'голубой', 5: 'бирюзовый', 6: 'зелёный', 7: 'жёлтый', 8: 'оранжевый', 9: 'красный', 10: 'белый' };
function updateTele() {
  const r = sim.robots[S.team];
  $('tYaw').textContent = `${r.imuYaw.toFixed(1)}°`;
  $('tLR').textContent = `${Math.round(r.left.relPos)} / ${Math.round(r.right.relPos)}`;
  $('tArm').textContent = `${Math.round(r.armAngle)}°`;
  if (r.config.sensor.enabled) {
    const rgb = sim.colorAt(r.sensorWorld());
    const rd = colorReading(rgb);
    $('tSwatch').style.background = `rgb(${rgb.r | 0},${rgb.g | 0},${rgb.b | 0})`;
    $('tColorName').textContent = `${COLOR_NAMES[rd.color]} · ${rd.reflection}%`;
  } else { $('tSwatch').style.background = 'transparent'; $('tColorName').textContent = 'нет датчика'; }
  $('tele').classList.toggle('blue', S.team === 'blue');
}
function hud() {
  updateScores(); updateTele();
  const ar = $('autorun'); // флажок «по старту матча» следует за состоянием, кто бы его ни менял
  if (ar.checked !== !!S.autorun[S.edit]) ar.checked = !!S.autorun[S.edit];
  const tEl = $('timer');
  tEl.textContent = clockText();
  tEl.classList.toggle('low', S.mode === 'match' && S.match.phase === 'running' && S.match.left <= 30);
  if (S.mode === 'match' && S.match.phase === 'countdown') showBanner(String(Math.max(1, Math.ceil(S.match.cd - 1e-6))), 'приготовиться');
  else if (S.mode === 'match' && S.match.phase === 'running' && sim.time - (S.match.startT ?? -9) < 0.8) showBanner('Старт!');
  else if (S.mode === 'match' && S.match.phase === 'running' && !$('banner').hidden) hideBanner();
}

// ---------- главный цикл: фиксированный шаг, замок с Python ----------
const loop = {
  last: performance.now(), lastTick: 0, owed: 0, forced: 0, pumping: false, raf: 0, hudT: 0, first: true, inTick: false, fromTimer: false,
  stepsDone: 0, workerTicks: 0,
  /** Тест/отладка: прогнать sec секунд (с учётом скорости) и дождаться окончания счёта.
   *  Отдельный счётчик forced: кадры (tick) ограничивают owed и не «съедают» заказанные шаги. */
  async advance(sec) {
    loop.forced += Math.max(0, sec) * effSpeed() / DT;
    await pump();
    while (loop.pumping) await nextTask();
    return sim.stepCount;
  },
  pump: () => pump(),
};
const effSpeed = () => (matchLocked() ? 1 : S.speed);
const canStep = () => app.stepAuthority && !S.paused;

// Вкладка в фоне: rAF не идёт, а таймеры страницы браузер душит (1 раз/с, потом 1 раз/мин). Тикаем из
// маленького выделенного Worker — его таймеры не душатся, симуляция (и снимки онлайн-хоста) идут в реальном
// времени. Видимая вкладка — обычный rAF.
const TICK_MS = 16;
let tickWorker = null;
function timerTick() { loop.fromTimer = true; try { tick(performance.now()); } finally { loop.fromTimer = false; } }
function startTickWorker() {
  if (tickWorker !== null) return;
  try {
    const src = 'let t=0;onmessage=(e)=>{clearInterval(t);t=e.data>0?setInterval(()=>postMessage(0),e.data):0;};';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    tickWorker = new Worker(url);
    tickWorker.onmessage = () => { loop.workerTicks++; if (document.hidden) timerTick(); };
    tickWorker.onerror = () => { tickWorker = false; };
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch { tickWorker = false; } // нет Worker/Blob — остаётся запасной setInterval
}
function onVisibility() {
  if (document.hidden) startTickWorker();
  if (tickWorker) tickWorker.postMessage(document.hidden ? TICK_MS : 0);
  if (!document.hidden) loop.last = performance.now(); // без «догонялок» после возврата
}
function startLoop() {
  loop.last = performance.now();
  loop.raf = requestAnimationFrame(frame);
  document.addEventListener('visibilitychange', onVisibility);
  if (document.hidden) onVisibility();
  // запасной таймер: если браузер не отдаёт кадры и Worker недоступен, симуляция не замирает
  setInterval(() => {
    if (performance.now() - loop.lastTick > 250) timerTick();
  }, 100);
}
function frame(now) {
  loop.raf = requestAnimationFrame(frame); // сначала заказываем следующий кадр (review M12)
  tick(now);
}
function tick(now) {
  if (loop.inTick) return;
  loop.inTick = true;
  try {
    const real = Math.min(loop.fromTimer ? 1 : 0.1, Math.max(0, (now - loop.last) / 1000));
    loop.last = now; loop.lastTick = performance.now();
    applyInput(real);
    if (canStep()) {
      loop.owed = Math.min(loop.owed + real * effSpeed() / DT, Math.ceil((loop.fromTimer ? 1 : 0.25) * effSpeed() / DT) + 1);
      if (!loop.pumping) pump();
    } else { loop.owed = 0; loop.forced = 0; }
    if (performance.now() - lastFlush >= CON_FLUSH_MS) flushConsoles();
    sim.sync();
    const hidden = document.hidden;
    if (!hidden) {
      followCam(real);
      if (S.cam !== 'follow') sim.controls.update();
      sim.render();   // невидимую вкладку не рисуем — только считаем
    }
    loop.hudT -= real;
    if (loop.hudT <= 0) { loop.hudT = 0.15; hud(); }
    if (loop.first) { loop.first = false; $('loading').hidden = true; }
    app.emit('frame', real);
  } catch (e) {
    showError(e, 'Кадр');
  } finally { loop.inTick = false; }
}
/** Программа считает (не ждёт симуляцию) — шаг откладываем; дольше FREE_RUN_MS — считаем без неё */
function holdsStep() {
  const now = performance.now();
  let hold = false;
  for (const s of SIDES) {
    const r = runners[s];
    if (!r.runnable) { r.since = 0; continue; }
    if (!r.since) r.since = now;
    if (now - r.since < FREE_RUN_MS) hold = true;
  }
  return hold;
}
function stepOnce() {
  dragStep();
  sim.step(DT);
  bridges.red.tick(); bridges.blue.tick();
  matchStep(DT);
  loop.stepsDone++;
  app.emit('step', DT);
}
async function pump() {
  if (loop.pumping) return;
  loop.pumping = true;
  try {
    let t0 = performance.now();
    while ((loop.owed >= 1 || loop.forced >= 1) && canStep()) {
      if (holdsStep()) { await nextTask(); t0 = performance.now(); continue; }
      stepOnce();
      if (loop.forced >= 1) loop.forced -= 1; else loop.owed -= 1;
      // что-то дождалось (sleep, команда) — отдать управление Python до следующего шага (review H3)
      if (bridges.red.mayWake() || bridges.blue.mayWake()) {
        await nextTask();
        bridges.red.kick = false; bridges.blue.kick = false;
        t0 = performance.now();
        continue;
      }
      if (performance.now() - t0 > PUMP_SLICE_MS) { await nextTask(); t0 = performance.now(); }
    }
  } catch (e) {
    loop.owed = 0; loop.forced = 0;
    showError(e, 'Шаг симуляции');
  } finally { loop.pumping = false; }
}

// ---------- старт ----------
try {
  await boot();
} catch (e) {
  console.error(e);
  fatal('Не удалось запустить симулятор', e && e.message ? e.message : String(e));
}
