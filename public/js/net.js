// Онлайн (вкладка «Онлайн»): комнаты на server.py (/ws), хост-авторитетная симуляция.
//
// Хост считает физику и раз в 50 мс рассылает снимок sim.getState(): ключевой кадр раз в секунду (без потерь)
// и разности к нему (заменяемые: медленному гостю сервер отдаёт самый свежий), плюс часы матча и счёт.
// Без потерь и по порядку идут события: конфигурации роботов, фаза матча и зафиксированный счёт,
// состояние программ, строки консоли. Ввод гостя -> app.input.setRemote(side, TeamInput); его Run/Stop ->
// app.runProgram/stopProgram(side) в раннере его команды (до старта матча — запуск по сигналу старта).
// Гость: app.setStepAuthority(false), снимки показываются с интерполяцией по времени симуляции хоста
// (задержка подстраивается: ~120 мс при ровных шагах хоста), свой ввод — 20 Гц.
// Обрыв — переподключение с паузой (backoff); перезагрузка вкладки — возврат на своё место (sessionStorage).
// Выход или закрытие комнаты — снова локальный режим.
//
// Сообщения между хостом и гостями (поле d в {t:'m'}): k = hello | init | ev | snap | in | run | stop | needcfg | cfgset | ping | pong;
// cfgset — робот из конструктора гостя (хост проверяет пределы конструктора, validateConfig и правила зоны
// Technician; в localStorage хоста робот гостя не сохраняется, после комнаты хосту возвращается его робот).
// ev.l — список событий { k: con | clr | prog | cfg | match }. Неизвестные k — событие app 'netMessage'(d, from, id).
// Зритель шлёт хосту только hello | ping | needcfg (сервер отбрасывает остальное).
// Пачка событий хоста — не больше BATCH_MAX; вывод print гостям — по бюджету символов (лишнее: «пропущено N строк»).
// После возвращения хоста (обрыв, перезагрузка вкладки) гости получают полный init: программы, роботы, матч.

import { cfgSig } from './sim.js';
import { validateConfig, WHEELS, ATTACHMENTS, DEFAULT_CONFIG } from './robotConfig.js';
import { emptyInput, isTypingTarget, isControlTarget } from './input.js';

const SIDES = ['red', 'blue'];
const ROLE_RU = { host: 'Хост', red: 'Красные', blue: 'Синие', spectator: 'Зритель' };
const SIDE_GEN = { red: 'красных', blue: 'синих' };
const SNAP_MS = 50;              // период снимков хоста
const KEY_EVERY = 20;            // ключевой кадр раз в 20 снимков (1 с)
const INPUT_MS = 50;             // период отправки ввода гостя (20 Гц)
const PING_MS = 2000;
const STALE_MS = 600;            // ввод гостя старее — отпускаем его управление
const SEND_BUFFER_MAX = 256 * 1024; // в буфере сокета больше — снимок пропускаем (обратное давление)
const MAX_CODE = 200 * 1024;
const GUEST_WAIT_MS = 90000;     // сколько гость ждёт хоста после обрыва
const FIRST_TRIES = 3;           // попыток первого подключения
const CODE_CHARS = 'ACDEFGHJKMNPQRTUVWXY34679';
// кириллица, похожая на латиницу (код набрали в русской раскладке «на глаз»)
const LOOK = { А: 'A', В: 'B', С: 'C', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', Т: 'T', Х: 'X', У: 'Y', З: '3' };
const SESSION_KEY = 'bioglow.net.session';
const SESSION_TTL = 10 * 60 * 1000;
const BATCH_MAX = 64 * 1024;     // пачка событий хоста (символов JSON): сервер режет сообщения > 1 МиБ и > 3 МБ/с
const OUTBOX_MAX = 3000;         // событий в очереди хоста; сверх — выбрасываем старые строки консоли
const CON_RATE = 16000, CON_BURST = 48000; // вывод print гостям: символов/с на команду и запас
const CON_LINE_MAX = 4096;       // длиннее — обрезаем (main.js склеивает вывод в куски до 2 КБ; длиннее — одна строка print)
const REPLY_MS = 2000;           // ответ init/needcfg одному гостю — не чаще
const CLOSE_REPLACED = 4001;     // сервер: место заняло другое соединение (вторая вкладка)
// пределы полей конструктора (builder.js): робот гостя вне них хост не собирает
const CFG_RANGE = {
  'wheels.track': [5.6, 18, 'Колея'], 'wheels.x': [-3.4, 3.4, 'Ось колёс'],
  'chassis.extraLength': [0, 20, 'Удлинение рамы'], 'chassis.extraWidth': [0, 14, 'Расширение рамы'],
  'caster.x': [-14, 10, 'Опора'], ballast: [0, 400, 'Балласт'], 'sensor.x': [-6, 12, 'Датчик (вперёд)'],
  'sensor.z': [-4, 4, 'Датчик (вбок)'], 'attachment.length': [5, 14, 'Длина руки'],
};
const CFG_RATIOS = [1, 1.667, 3, 5];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, u) => a + (b - a) * u;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function rand01() { try { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] / 4294967296; } catch { return 0.5; } }
const kb = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + ' КБ' : n + ' Б');

/** Код комнаты из ввода: верхний регистр, похожая кириллица -> латиница, только допустимые символы */
export function normalizeCode(s) {
  return [...String(s || '').toUpperCase()].map((c) => LOOK[c] || c).filter((c) => CODE_CHARS.includes(c)).join('').slice(0, 4);
}
/** Адрес WebSocket этого же сайта: wss:// на HTTPS, ws:// на HTTP ('' для file://) */
export function wsUrlFor(loc = location) {
  if (!/^https?:$/.test(loc.protocol)) return '';
  const u = new URL('ws', loc.href);
  u.protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  u.search = ''; u.hash = '';
  return u.href;
}

// ---------- интерполяция снимков ----------
/** Поза [x,y,z,qx,qy,qz,qw] с отступом o: линейно + нормированный lerp кватерниона; скачок > 30 см — без сглаживания */
function lerpPose(a, b, u, o = 0) {
  if (!a || !b || a.length < o + 7 || b.length < o + 7) return b;
  const dx = b[o] - a[o], dy = b[o + 1] - a[o + 1], dz = b[o + 2] - a[o + 2];
  if (dx * dx + dy * dy + dz * dz > 900) return b;
  const out = b.slice();
  out[o] = a[o] + dx * u; out[o + 1] = a[o + 1] + dy * u; out[o + 2] = a[o + 2] + dz * u;
  const s = a[o + 3] * b[o + 3] + a[o + 4] * b[o + 4] + a[o + 5] * b[o + 5] + a[o + 6] * b[o + 6] < 0 ? -1 : 1;
  const x = lerp(a[o + 3], s * b[o + 3], u), y = lerp(a[o + 4], s * b[o + 4], u), z = lerp(a[o + 5], s * b[o + 5], u), w = lerp(a[o + 6], s * b[o + 6], u);
  const n = Math.hypot(x, y, z, w) || 1;
  out[o + 3] = x / n; out[o + 4] = y / n; out[o + 5] = z / n; out[o + 6] = w / n;
  return out;
}
/** Состояние между снимками A и B (u = 0..1): фишки, тела роботов, подвижные части моделей */
export function blendState(A, B, u) {
  if (!A || u >= 1) return B;
  if (u <= 0) return A;
  const out = { ...B, t: lerp(A.t, B.t, u), rob: {}, mech: {} };
  const am = new Map();
  for (const r of A.tok) am.set(r[0], r);
  out.tok = B.tok.map((rb) => { const ra = am.get(rb[0]); return ra && ra.length === 9 && rb.length === 9 && ra[1] === rb[1] ? lerpPose(ra, rb, u, 2) : rb; });
  for (const s of SIDES) {
    const ra = A.rob && A.rob[s], rb = B.rob && B.rob[s];
    out.rob[s] = ra && rb && ra.sig === rb.sig && ra.b.length === rb.b.length
      ? { ...rb, b: rb.b.map((p, i) => lerpPose(ra.b[i], p, u)), m: rb.m.map((v, i) => lerp(ra.m[i] ?? v, v, u)) }
      : rb;
    const ma = A.mech && A.mech[s], mb = B.mech && B.mech[s];
    out.mech[s] = ma && mb ? {
      ...mb,
      nest: [mb.nest[0], lerp(ma.nest[1], mb.nest[1], u), lerpPose(ma.nest[2], mb.nest[2], u), lerpPose(ma.nest[3], mb.nest[3], u)],
      hollow: [mb.hollow[0], lerp(ma.hollow[1], mb.hollow[1], u), lerpPose(ma.hollow[2], mb.hollow[2], u), lerpPose(ma.hollow[3], mb.hollow[3], u)],
      hive: [mb.hive[0], lerp(ma.hive[1], mb.hive[1], u), lerpPose(ma.hive[2], mb.hive[2], u)],
    } : mb;
  }
  return out;
}

/** TeamInput гостя (сжатый) -> TeamInput */
function decodeInput(d) {
  const ti = emptyInput();
  const n = (v, a = -1, b = 1) => clamp(Number(v) || 0, a, b);
  ti.drive.fwd = n(d.f); ti.drive.turn = n(d.t); ti.arm = n(d.a); ti.tree = n(d.tr); ti.slow = !!d.s;
  if (Array.isArray(d.lv)) {
    ti.levers.driver = [n(d.lv[0], -100, 100), n(d.lv[1], -100, 100)];
    ti.levers.specialist = [n(d.lv[2], -100, 100), n(d.lv[3], -100, 100)];
  }
  if (d.L) ti._levers = true;
  return ti;
}

const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const word = (v, def) => (typeof v === 'string' && /^[A-Za-z][A-Za-z0-9]{0,15}$/.test(v) ? v : def);
/**
 * Робот, присланный гостем по сети: собираем заново только известные поля и проверяем их по пределам
 * конструктора (колёса и навесное — только свои ключи таблиц, без 'constructor'/'__proto__').
 * -> { cfg, errors[] }; с ошибками хост робота не собирает.
 */
export function sanitizeGuestConfig(raw) {
  const errors = [];
  const src = plain(raw), D = DEFAULT_CONFIG;
  const W = plain(src.wheels), C = plain(src.chassis), K = plain(src.caster), S = plain(src.sensor), A = plain(src.attachment);
  const num = (path, v, def) => {
    if (v === undefined || v === null || v === '') return def;
    const [lo, hi, ru] = CFG_RANGE[path];
    const x = Number(v);
    if (!Number.isFinite(x) || x < lo - 1e-9 || x > hi + 1e-9) {
      errors.push(`${ru}: ${String(v).slice(0, 14)} вне пределов конструктора ${lo}…${hi}.`);
      return def;
    }
    return x;
  };
  const size = W.size === undefined ? D.wheels.size : W.size;
  if (!own(WHEELS, size)) errors.push(`Неизвестное колесо «${String(size).slice(0, 20)}».`);
  const type = A.type === undefined ? D.attachment.type : A.type;
  if (!own(ATTACHMENTS, type)) errors.push(`Неизвестное навесное «${String(type).slice(0, 20)}».`);
  const motor = own(ATTACHMENTS, type) && !!ATTACHMENTS[type].motor;
  let ratio = 1, length = 0;
  if (motor) {
    ratio = A.ratio === undefined ? ATTACHMENTS[type].ratio : Number(A.ratio);
    if (!CFG_RATIOS.some((r) => Math.abs(r - ratio) < 0.01)) {
      errors.push(`Передаточное число ${String(A.ratio).slice(0, 14)}: в конструкторе только ${CFG_RATIOS.join(', ')}.`);
      ratio = ATTACHMENTS[type].ratio;
    }
    length = num('attachment.length', A.length, ATTACHMENTS[type].length);
  }
  const name = (typeof src.name === 'string' ? src.name : '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  const cfg = {
    version: 1,
    name: name || 'Робот гостя',
    wheels: { size: own(WHEELS, size) ? size : D.wheels.size, track: num('wheels.track', W.track, D.wheels.track), x: num('wheels.x', W.x, D.wheels.x) },
    chassis: { extraLength: num('chassis.extraLength', C.extraLength, 0), extraWidth: num('chassis.extraWidth', C.extraWidth, 0), color: word(C.color, 'white') },
    caster: { type: K.type === 'skid' ? 'skid' : 'ball', x: num('caster.x', K.x, D.caster.x) },
    ballast: num('ballast', src.ballast, 0),
    sensor: { enabled: S.enabled !== false, x: num('sensor.x', S.x, D.sensor.x), z: num('sensor.z', S.z, 0) },
    attachment: { type: own(ATTACHMENTS, type) ? type : 'none', ratio, length, mount: 'front' },
    teamColor: word(src.teamColor, 'auto'),
  };
  return { cfg, errors };
}

// =====================================================================================
class Net {
  constructor(app, pane) {
    this.app = app;
    this.pane = pane;
    this.ws = null;
    this.state = 'off';            // off | connecting | online | reconnecting
    this.mode = null;              // 'host' | 'guest' | null — в каком режиме сейчас приложение
    this.role = null; this.room = null; this.id = null; this.token = null;
    this.peers = []; this.hostSide = null;
    this.intent = null;            // запрос после подключения: create/join
    this.wantRole = null; this.wantSide = null;
    this.everWelcomed = false; this.gotHello = false;
    this.attempt = 0; this.retryT = 0; this.rejoinT = 0; this.helloT = 0; this.lostAt = 0;
    this.waitingHost = false;
    this.waiters = [];
    this.rttServer = null; this.rttHost = null;
    this.name = String(app.store.get('net.name', '') || '').slice(0, 24);
    this.customUrl = String(app.store.get('net.url', '') || '');
    // хост
    this.outbox = []; this.key = null; this.keyId = 0; this.keyAt = 0; this.snapN = 0; this.forceKey = true;
    this.lastTick = 0; this.lastMatchSig = ''; this.lastSc = [0, 0]; this.lastSentN = -1;
    this.lastIn = { red: 0, blue: 0 }; this.recycle = { red: false, blue: false };
    this.remoteRan = { red: false, blue: false }; this.pending = { red: null, blue: null };
    this.con = { red: { tok: CON_BURST, t: 0, skip: 0 }, blue: { tok: CON_BURST, t: 0, skip: 0 } }; // бюджет вывода print
    this.replyAt = new Map(); this.replyLater = new Map();   // ответы init/needcfg гостям (не чаще REPLY_MS)
    this.own = { red: null, blue: null }; this.guestSig = { red: '', blue: '' }; // робот хоста до робота гостя
    // гость
    this.buf = []; this.hist = []; this.gkey = null; this.play = null; this.playT = 0; this.lastApplied = '';
    this.rateNow = 1; this.lagNow = 0;
    this.remoteProg = { red: 'idle', blue: 'idle' };
    this.cfgFor = { red: '', blue: '' }; this.cfgAskT = 0;
    this.lat = null; this.rcLatch = false; this.saved = null; this.hostScore = [0, 0]; this.hostPaused = false;
    // счётчики
    this.cnt = { snapOut: 0, keyOut: 0, snapIn: 0, keyIn: 0, inOut: 0, inIn: 0, bytesOut: 0, bytesIn: 0, skipped: 0 };
    this.rate = { snapOut: 0, snapIn: 0, inOut: 0, inIn: 0, bytesOut: 0, bytesIn: 0 };
    this.size = { key: 0, delta: 0, input: 0 };
    this.statT = performance.now(); this.statPrev = { ...this.cnt };
    this.el = {};
  }

  // ---------- публичное ----------
  /** Адрес сервера: свой (из «Сервер») или этот же сайт */
  get url() { return this.customUrl || wsUrlFor(); }
  get online() { return this.state === 'online' && !!this.room; }
  get isHost() { return this.mode === 'host'; }
  get isGuest() { return this.mode === 'guest'; }
  /** Сводка для интерфейса и тестов */
  get stats() {
    return {
      state: this.state, mode: this.mode, role: this.role, room: this.room, rttServer: this.rttServer, rttHost: this.rttHost,
      ...this.cnt, rate: { ...this.rate }, size: { ...this.size }, buffered: this.buf.length,
      playRate: r3(this.rateNow), playLagMs: Math.round(this.lagNow * 1000), queue: this.ws ? this.ws.bufferedAmount : 0,
    };
  }

  /** Создать комнату (роль host). side — команда, за которую играет хост (или null — судья). -> Promise<welcome> */
  host({ side = this.app.state.team, name = this.name, room = null } = {}) {
    if (this.state !== 'off') return Promise.reject(new Error('Уже подключено — сначала выйдите из комнаты'));
    this.wantRole = 'host';
    this.wantSide = SIDES.includes(side) ? side : null;
    this.intent = { t: 'create', side: this.wantSide, name, room };
    return this.start();
  }
  /** Войти в комнату гостем: role = red | blue | spectator. -> Promise<welcome> */
  join(code, role, name = this.name) {
    if (this.state !== 'off') return Promise.reject(new Error('Уже подключено — сначала выйдите из комнаты'));
    const room = normalizeCode(code);
    if (room.length !== 4) return Promise.reject(new Error('Код комнаты — 4 символа'));
    if (!['red', 'blue', 'spectator'].includes(role)) return Promise.reject(new Error('Роль: red, blue или spectator'));
    this.wantRole = role;
    this.intent = { t: 'join', room, role, name };
    this.room = room;
    return this.start();
  }
  /** Выйти из комнаты (хост закрывает её) и вернуться в локальный режим */
  leave(msg = '') {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { if (this.room) ws.send(JSON.stringify({ t: 'leave' })); } catch { /* сокет уже закрыт */ }
      setTimeout(() => { try { ws.close(1000, 'leave'); } catch { /* уже закрыт */ } }, 250);
    } else if (ws) { try { ws.close(1000, 'leave'); } catch { /* уже закрыт */ } }
    this.ws = null;
    this.finish(msg || 'Вы вышли из комнаты.', 'ok');
  }
  /** Переслать данные: хост -> to (guests | red | blue | spectator | id), гость -> хосту. lossy — можно заменить свежим */
  send(d, { to = 'guests', lossy = false } = {}) { return this.relay(d, to, lossy); }
  /** Гость своей команды: попросить хоста пересобрать робота (конструктор). -> число отправленных байт (0 — не ушло) */
  requestRobot(cfg) {
    if (!this.isGuest || !SIDES.includes(this.role) || !cfg || typeof cfg !== 'object') return 0;
    return this.relay({ k: 'cfgset', cfg }, 'host', false);
  }

  // ---------- подключение ----------
  start() {
    this.everWelcomed = false; this.attempt = 0; this.lostAt = 0; this.token = null;
    if (!this.url) {
      const e = new Error('Онлайн работает, когда сайт открыт с сервера (python server.py или Render), а не из файла.');
      this.showMsg(e.message, 'err');
      return Promise.reject(e);
    }
    const p = new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    this.connect();
    return p;
  }
  settle(err, val) {
    const w = this.waiters; this.waiters = [];
    for (const x of w) { if (err) x.reject(err); else x.resolve(val); }
  }
  connect() {
    clearTimeout(this.retryT); this.retryT = 0;
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) {
      this.settle(e);
      this.finish('Неверный адрес сервера: ' + this.url, 'err');
      return;
    }
    this.ws = ws;
    this.gotHello = false;
    this.setState(this.everWelcomed ? 'reconnecting' : 'connecting');
    ws.onopen = () => {
      clearTimeout(this.helloT);
      this.helloT = setTimeout(() => { if (this.ws === ws && !this.gotHello) { try { ws.close(4000, 'no hello'); } catch { /* уже закрыт */ } } }, 5000);
    };
    ws.onmessage = (e) => { if (this.ws === ws) this.onMessage(e.data); };
    ws.onclose = (e) => { if (this.ws === ws) this.onSocketClose(e); };
    ws.onerror = () => { /* следом придёт onclose */ };
  }
  onSocketClose(e) {
    this.ws = null;
    clearTimeout(this.helloT);
    if (!this.intent && !this.token) { this.setState('off'); return; }
    if (e && e.code === CLOSE_REPLACED) {
      // место заняло другое соединение с нашим токеном (копия вкладки): не переподключаемся, иначе вкладки
      // будут выбивать друг друга бесконечно
      const err = new Error('Это место в комнате открыто в другой вкладке — здесь вы снова играете локально.');
      this.settle(err);
      this.finish(err.message, 'warn');
      return;
    }
    const now = performance.now();
    if (!this.everWelcomed) {
      // attempt — сколько попыток уже не удалось (увеличивает scheduleReconnect): FIRST_TRIES попыток всего
      if (this.attempt + 1 >= FIRST_TRIES) {
        const err = new Error(`Не удалось подключиться к серверу онлайна (${this.url}). Онлайн работает, когда сайт запущен через server.py (локально: python server.py) или на Render.`);
        this.settle(err);
        this.finish(err.message, 'err');
        return;
      }
      this.scheduleReconnect(e);
      return;
    }
    if (!this.lostAt) this.lostAt = now;
    if (this.mode === 'guest' && now - this.lostAt > GUEST_WAIT_MS) { this.finish('Связь с хостом потеряна — вы снова играете локально.', 'warn'); return; }
    this.scheduleReconnect(e);
  }
  scheduleReconnect() {
    const d = Math.min(10000, 500 * 2 ** Math.min(this.attempt, 5)) * (0.8 + 0.4 * rand01());
    this.attempt++;
    this.retryAt = performance.now() + d;
    this.setState('reconnecting');
    this.retryT = setTimeout(() => this.connect(), d);
  }
  wsSend(obj) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return 0;
    const s = JSON.stringify(obj);
    try { ws.send(s); } catch { return 0; }
    this.cnt.bytesOut += s.length;
    return s.length;
  }
  relay(d, to, lossy) {
    if (!this.online || this.waitingHost) return 0;
    return this.wsSend(this.isHost ? { t: 'm', to, lossy: lossy ? 1 : 0, d } : { t: 'm', lossy: lossy ? 1 : 0, d });
  }

  // ---------- входящие ----------
  onMessage(text) {
    this.cnt.bytesIn += text.length;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    try {
      switch (msg.t) {
        case 'hello': this.onHello(msg); break;
        case 'welcome': this.onWelcome(msg); break;
        case 'peers': this.onPeers(msg); break;
        case 'm': this.onRelay(msg); break;
        case 'pong': if (typeof msg.c === 'number') this.rttServer = Math.max(0, performance.now() - msg.c); break;
        case 'closed': this.onClosed(msg); break;
        case 'error': this.onError(msg); break;
        case 'left': break;
        default: break;
      }
    } catch (e) {
      this.app.ui.showError(e, 'Онлайн');
    }
  }
  onHello() {
    this.gotHello = true;
    clearTimeout(this.helloT);
    if (this.token && this.room) this.wsSend({ t: 'resume', room: this.room, token: this.token });
    else if (this.intent) this.wsSend(this.intent);
  }
  onWelcome(m) {
    this.room = m.room; this.role = m.role; this.id = m.id; this.token = m.token;
    this.hostSide = m.hostSide ?? null; this.peers = m.peers || [];
    this.everWelcomed = true; this.attempt = 0; this.lostAt = 0; this.waitingHost = false;
    clearTimeout(this.rejoinT);
    this.intent = m.role === 'host' ? { t: 'create', side: this.hostSide, name: this.name, room: m.room } : { t: 'join', room: m.room, role: m.role, name: this.name };
    this.saveSession();
    this.setState('online');
    if (m.role === 'host') {
      if (this.mode !== 'host') this.startHost();
      this.forceKey = true;
      // хост вернулся (обрыв, перезагрузка вкладки, рестарт сервера): гости могли пропустить события —
      // события состояния в очереди устарели, всем гостям — полное состояние (программы, роботы, матч)
      this.outbox = this.outbox.filter((e) => e.k === 'con' || e.k === 'clr');
      this.lastMatchSig = this.matchSig();
      this.sendInit('guests');
      this.showMsg(m.resumed ? 'Связь восстановлена.' : `Комната ${m.room} создана. Скажите код друзьям.`, 'ok');
    } else {
      if (this.mode !== 'guest') this.startGuest();
      this.relay({ k: 'hello', name: this.name, v: 1 }, 'host', false);
      this.showMsg(m.resumed ? 'Связь восстановлена.' : `Вы в комнате ${m.room}: ${ROLE_RU[m.role].toLowerCase()}.`, 'ok');
    }
    this.settle(null, m);
    this.render();
  }
  onPeers(m) {
    this.peers = m.list || [];
    this.hostSide = m.hostSide ?? null;
    const ev = m.ev || {};
    if (this.isHost) {
      if (ev.type === 'leave' && SIDES.includes(ev.role)) this.dropRemote(ev.role, true);
      if (ev.type === 'lost' && SIDES.includes(ev.role)) this.app.input.setRemote(ev.role, null);
      if ((ev.type === 'join' || ev.type === 'leave') && ev.role !== 'host') {
        const team = SIDES.includes(ev.role);
        const what = ev.type === 'join' ? (team ? 'вошли в комнату' : 'вошёл в комнату') : (team ? 'вышли из комнаты' : 'вышел из комнаты');
        this.app.log(team ? ev.role : null, `Онлайн: ${team ? ROLE_RU[ev.role] : 'зритель'} ${what}`, null);
      }
    } else if (this.isGuest) {
      if (ev.role === 'host' && ev.type === 'lost') this.showMsg('Хост отключился — ждём его возвращения…', 'warn');
      if (ev.role === 'host' && ev.type === 'back') this.showMsg('Хост снова в сети.', 'ok');
    }
    this.render();
  }
  onClosed(m) {
    if (this.isGuest && m.reason === 'host-lost') {
      // хост пропал дольше grace — ждём: он может пересоздать комнату с тем же кодом
      this.token = null;
      this.waitingHost = true;
      if (!this.lostAt) this.lostAt = performance.now();
      this.showMsg('Хост пропал — ждём, пока он вернётся…', 'warn');
      this.scheduleRejoin();
      this.render();
      return;
    }
    const why = { 'host-left': 'Хост закрыл комнату — вы снова играете локально.', idle: 'Комната закрыта: долго не было гостей.' }[m.reason];
    this.finish(why || 'Комната закрыта.', 'warn');
  }
  onError(m) {
    const re = m.re;
    if (re === 'resume' && m.code === 'no-session') {
      // место не сохранилось (рестарт сервера, долгий обрыв) — заново тем же кодом и ролью;
      // хост предъявляет прежний токен: код комнаты, которую ждут гости, сервер отдаёт только ему
      const token = this.token;
      this.token = null;
      if (this.wantRole === 'host') this.wsSend({ t: 'create', side: this.wantSide, name: this.name, room: this.room, token });
      else this.wsSend({ t: 'join', room: this.room, role: this.wantRole, name: this.name });
      return;
    }
    if (re === 'join' && (m.code === 'no-room' || m.code === 'rate') && this.isGuest && performance.now() - (this.lostAt || 0) < GUEST_WAIT_MS) {
      this.waitingHost = true;
      this.scheduleRejoin(m.code === 'rate');
      this.render();
      return;
    }
    if (re === 'join' || re === 'create' || re === 'resume') {
      this.settle(Object.assign(new Error(m.msg || m.code), { code: m.code }));
      this.finish(m.msg || 'Не удалось войти в комнату.', 'err');
      return;
    }
    if (re === 'side') { this.render(); this.showMsg(m.msg, 'err'); return; }
    if (m.code === 'rate') { this.cnt.rateErrors = (this.cnt.rateErrors || 0) + 1; return; }
    if (m.code === 'host-busy') { this.showMsg('Хост не успевает принимать данные — последнее действие (программа, робот) могло не дойти. Повторите чуть позже.', 'warn'); return; }
    if (re === 'm' || re === 'ping') return; // пересылка в момент смены комнаты, служебное зрителя — не важно
    this.showMsg(m.msg || m.code, 'warn');
  }
  scheduleRejoin(slow = false) {
    clearTimeout(this.rejoinT);
    this.rejoinT = setTimeout(() => {
      if (!this.isGuest || this.state !== 'online' && this.state !== 'reconnecting') return;
      if (performance.now() - (this.lostAt || 0) > GUEST_WAIT_MS) { this.finish('Хост не вернулся — вы снова играете локально.', 'warn'); return; }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.wsSend({ t: 'join', room: this.room, role: this.wantRole, name: this.name });
    }, (slow ? 8000 : 2500) + 1500 * rand01());
  }
  onRelay(msg) {
    const d = msg.d;
    if (!d || typeof d !== 'object' || typeof d.k !== 'string') return;
    if (this.isHost) this.hostRecv(d, msg.from, msg.id);
    else if (this.isGuest && msg.from === 'host') this.guestRecv(d);
  }

  // ---------- завершение ----------
  /** Всё сбросить и вернуться в локальный режим */
  finish(msg, cls = 'warn') {
    clearTimeout(this.retryT); clearTimeout(this.rejoinT); clearTimeout(this.helloT);
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(1000, 'bye'); } catch { /* уже закрыт */ } }
    this.clearSession();
    if (this.mode === 'host') this.stopHost();
    if (this.mode === 'guest') this.stopGuest();
    this.mode = null; this.role = null; this.room = null; this.id = null; this.token = null; this.intent = null;
    this.peers = []; this.hostSide = null; this.waitingHost = false; this.rttServer = null; this.rttHost = null;
    this.setState('off');
    if (msg) this.showMsg(msg, cls);
    if (this.waiters.length) this.settle(new Error(msg || 'Отменено'));
    this.render();
  }
  saveSession() {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ room: this.room, token: this.token, role: this.role, side: this.wantSide, name: this.name, url: this.customUrl, t: Date.now() }));
    } catch { /* хранилище недоступно */ }
  }
  clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* хранилище недоступно */ } }
  /** Вкладку перезагрузили, будучи в комнате, — вернуться на своё место */
  restoreSession() {
    let s = null;
    try { s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { s = null; }
    if (!s || !s.room || !s.role || Date.now() - (s.t || 0) > SESSION_TTL) { this.clearSession(); return false; }
    if (s.url !== this.customUrl) return false;
    this.room = s.room; this.token = s.token; this.wantRole = s.role; this.wantSide = s.side ?? null;
    if (s.name) this.name = s.name;
    this.intent = s.role === 'host' ? { t: 'create', side: this.wantSide, name: this.name, room: s.room } : { t: 'join', room: s.room, role: s.role, name: this.name };
    this.everWelcomed = false; this.attempt = 0; this.lostAt = performance.now();
    const p = new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    p.catch(() => { /* ошибка показана в панели */ });
    this.showMsg(`Возвращаемся в комнату ${s.room}…`, 'warn');
    this.connect();
    return true;
  }

  // ======================= хост =======================
  startHost() {
    this.mode = 'host';
    this.outbox = []; this.key = null; this.forceKey = true; this.lastMatchSig = ''; this.lastSentN = -1;
    this.lastIn = { red: 0, blue: 0 }; this.remoteRan = { red: false, blue: false }; this.pending = { red: null, blue: null };
    for (const s of SIDES) this.con[s] = { tok: CON_BURST, t: performance.now(), skip: 0 };
    this.own = { red: null, blue: null }; this.guestSig = { red: '', blue: '' };
    this.lastSc = this.scoreNow();
    if (this.wantSide && this.app.state.team !== this.wantSide) this.app.setTeam(this.wantSide);
    this.app.log(null, `Онлайн: комната ${this.room} — этот компьютер считает физику для всех`, null);
  }
  stopHost() {
    const app = this.app;
    for (const s of SIDES) this.dropRemote(s, true);
    this.outbox = []; this.key = null;
    for (const t of this.replyLater.values()) clearTimeout(t);
    this.replyLater.clear(); this.replyAt.clear();
    // робот, присланный гостем, был только на время комнаты — вернуть хосту его робота (не во время матча)
    for (const s of SIDES) {
      const own = this.own[s];
      if (!own || !this.guestSig[s] || this.guestSig[s] !== cfgSig(app.sim.robots[s].config) || app.matchLocked()) continue;
      const had = app.store.get('config.' + s, null);
      try {
        const res = app.setRobotConfig(s, own, { force: true, persist: false });
        if (res && res.ok) app.log(s, 'Онлайн: комната закрыта — вернули робота этого компьютера', null);
      } catch (e) { app.ui.showError(e, 'Онлайн: робот хоста'); }
      this.restoreStored(s, had);
    }
    this.own = { red: null, blue: null }; this.guestSig = { red: '', blue: '' };
  }
  /**
   * Сохранённый робот команды — как был до пересборки (app.setRobotConfig сохраняет всегда, если не знает
   * opts.persist). had = null — сохранённого не было: убираем записанное значение.
   */
  restoreStored(side, had) {
    const app = this.app;
    app.store.set('config.' + side, had);
    if (had === null) {
      try { if (localStorage.getItem('bioglow.config.' + side) === 'null') localStorage.removeItem('bioglow.config.' + side); } catch { /* хранилище недоступно */ }
    }
  }
  /** Текущий счёт [красные, синие] (событие app 'score' приходит только при изменении) */
  scoreNow() {
    try { return [this.app.sim.score('red').total, this.app.sim.score('blue').total]; } catch { return [0, 0]; }
  }
  /** Гость команды ушёл: отпустить управление, остановить его программу */
  dropRemote(side, stopProgram) {
    this.app.input.setRemote(side, null);
    this.lastIn[side] = 0; this.recycle[side] = false; this.pending[side] = null;
    if (stopProgram && this.remoteRan[side] && this.app.runners[side].running) this.app.stopProgram(side);
    this.remoteRan[side] = false;
  }
  guestsOnline() { return this.peers.some((p) => p.role !== 'host' && p.on); }
  matchInfo() {
    const S = this.app.state, M = S.match;
    return { mo: S.mode, ph: M.phase, left: r3(M.left), cd: r3(M.cd), se: r3(M.settle), st: M.startT ?? null, ab: !!M.aborted, t0: r3(S.trainT0), pa: !!S.paused, sp: S.speed };
  }
  matchSig() {
    const S = this.app.state;
    return `${S.mode}|${S.match.phase}|${!!S.match.aborted}|${!!this.app.sim.latched}|${!!S.paused}|${S.speed}`;
  }
  /** Каждые 50 мс: события (без потерь) и снимок */
  hostTick() {
    if (!this.isHost || !this.online) return;
    const now = performance.now();
    if (now - this.lastTick < SNAP_MS - 4) return;
    this.lastTick = now;
    for (const s of SIDES) if (this.lastIn[s] && now - this.lastIn[s] > STALE_MS) { this.app.input.setRemote(s, null); this.lastIn[s] = 0; }
    const sig = this.matchSig();
    if (sig !== this.lastMatchSig) { this.lastMatchSig = sig; this.pushEv({ k: 'match', m: this.matchInfo(), lat: this.app.sim.latched || null }); }
    if (!this.guestsOnline()) { this.outbox.length = 0; this.forceKey = true; return; }
    this.flushOutbox();
    this.hostSnap(now);
  }
  /** Событие для гостей (без потерь). Очередь ограничена: сверх OUTBOX_MAX выбрасываем старые строки консоли */
  pushEv(e) {
    this.outbox.push(e);
    if (this.outbox.length <= OUTBOX_MAX) return;
    let drop = this.outbox.length - OUTBOX_MAX;
    this.outbox = this.outbox.filter((x) => {
      if (drop > 0 && x.k === 'con' && SIDES.includes(x.side)) { drop--; this.con[x.side].skip++; return false; }
      return true;
    });
  }
  /**
   * События — пачкой не больше BATCH_MAX символов; из очереди убираем только то, что ушло в сокет.
   * Канал занят (bufferedAmount) — ждём: события без потерь, просто позже.
   */
  flushOutbox() {
    const ws = this.ws;
    if (!this.outbox.length || !ws || ws.bufferedAmount > SEND_BUFFER_MAX) return;
    let n = 0, size = 0;
    while (n < this.outbox.length) {
      let s = 0;
      try { s = JSON.stringify(this.outbox[n]).length + 1; } catch { s = 0; }
      if (n > 0 && size + s > BATCH_MAX) break;
      size += s; n++;
    }
    const sent = this.relay({ k: 'ev', l: this.outbox.slice(0, n) }, 'guests', false);
    if (sent) this.outbox.splice(0, n);
  }
  /** Полное состояние для гостя (или всех гостей): программы, роботы, матч */
  sendInit(to) {
    const app = this.app, sim = app.sim;
    return this.relay({
      k: 'init', v: 1, hostSide: this.hostSide,
      cfg: { red: sim.robots.red.config, blue: sim.robots.blue.config },
      sig: { red: cfgSig(sim.robots.red.config), blue: cfgSig(sim.robots.blue.config) },
      prog: { red: app.state.prog.red, blue: app.state.prog.blue }, m: this.matchInfo(), lat: sim.latched || null,
    }, to, false);
  }
  /** Ответ гостю на hello/needcfg — не чаще REPLY_MS на гостя: частые просьбы не перегрузят канал хоста */
  replyTo(id, kind, fn) {
    const key = id + ':' + kind, now = performance.now();
    const wait = REPLY_MS - (now - (this.replyAt.get(key) || -Infinity));
    if (wait <= 0) { this.replyAt.set(key, now); fn(); return; }
    if (this.replyLater.has(key)) return;
    this.replyLater.set(key, setTimeout(() => {
      this.replyLater.delete(key);
      if (!this.isHost || !this.online) return;
      this.replyAt.set(key, performance.now());
      fn();
    }, wait));
    if (this.replyAt.size > 500) this.replyAt.clear();
  }
  hostSnap(now) {
    const ws = this.ws;
    if (!ws || ws.bufferedAmount > SEND_BUFFER_MAX) { this.cnt.skipped++; return; }
    const sim = this.app.sim;
    this.snapN++;
    const isKey = !this.key || this.forceKey || this.snapN - this.keyAt >= KEY_EVERY;
    // пауза: шагов не было — разность не нужна (ключевой кадр раз в секунду всё равно уйдёт)
    if (!isKey && sim.stepCount === this.lastSentN) { this.cnt.idle = (this.cnt.idle || 0) + 1; return; }
    const st = sim.getState();
    const msg = { k: 'snap', ts: Math.round(now * 10) / 10, m: this.matchInfo(), sc: this.lastSc };
    if (isKey) {
      const map = new Map();
      for (const r of st.tok) map.set(r[0], JSON.stringify(r));
      this.key = { id: ++this.keyId, map };
      this.keyAt = this.snapN; this.forceKey = false;
      msg.key = this.key.id; msg.st = st;
    } else {
      const tok = [];
      for (const r of st.tok) if (this.key.map.get(r[0]) !== JSON.stringify(r)) tok.push(r);
      msg.base = this.key.id; msg.st = { ...st, tok };
    }
    const n = this.relay(msg, 'guests', !isKey);
    if (!n) { if (isKey) this.forceKey = true; return; }
    this.lastSentN = st.n;
    this.cnt.snapOut++;
    if (isKey) { this.cnt.keyOut++; this.size.key = n; } else this.size.delta = n;
  }
  hostRecv(d, from, id) {
    const app = this.app;
    const team = SIDES.includes(from) ? from : null;
    switch (d.k) {
      case 'in':
        if (!team) return;
        app.input.setRemote(team, decodeInput(d));
        this.lastIn[team] = performance.now();
        if (d.rc) this.recycle[team] = true;
        this.cnt.inIn++;
        break;
      case 'hello':
        this.replyTo(id, 'init', () => { this.sendInit(id); this.forceKey = true; });
        break;
      case 'needcfg':
        this.replyTo(id, 'cfg', () => {
          const sim = app.sim;
          this.relay({ k: 'ev', l: SIDES.map((s) => ({ k: 'cfg', side: s, cfg: sim.robots[s].config, sig: cfgSig(sim.robots[s].config) })) }, id, false);
          this.forceKey = true;
        });
        break;
      case 'run': {
        if (!team) return;
        const code = typeof d.code === 'string' ? d.code : '';
        if (!code.trim() || code.length > MAX_CODE) { this.toTeam(team, '✖ Программа пустая или слишком большая\n', 'err'); return; }
        const S = app.state;
        if (S.mode === 'match' && (S.match.phase === 'idle' || S.match.phase === 'countdown')) {
          // до старта — запустим по сигналу старта (автозапуск хоста для этой команды выключаем)
          this.pending[team] = code;
          if (S.autorun[team]) { if (app.setAutorun) app.setAutorun(team, false); else S.autorun[team] = false; app.log(team, 'Автозапуск хоста отключён: программу прислали игроки команды', null); }
          this.toTeam(team, '⏳ Программа у хоста — запустится по сигналу старта матча\n', 'ok');
          return;
        }
        this.remoteRan[team] = true;
        Promise.resolve(app.runProgram(team, code)).catch((e) => app.ui.showError(e, 'Программа гостя'));
        break;
      }
      case 'stop':
        if (!team) return;
        if (this.pending[team]) { this.pending[team] = null; this.toTeam(team, '■ Запуск по старту отменён\n', 'warn'); }
        if (app.runners[team].running) app.stopProgram(team);
        // программа уже не идёт (например, хост перезагрузил вкладку), а гость считает её запущенной — поправить
        else this.relay({ k: 'ev', l: [{ k: 'prog', side: team, st: app.state.prog[team] || 'idle', info: {} }] }, id, false);
        break;
      case 'cfgset': this.hostRobotRequest(team, d.cfg); break;
      case 'ping':
        this.relay({ k: 'pong', c: d.c }, id, false);
        break;
      default:
        app.emit('netMessage', d, from, id);
    }
  }
  /** Строка в консоль команды и её гостю (через событие console) */
  toTeam(side, text, cls) { this.app.runners[side].out(text, cls); }
  /** Робот из конструктора гостя: проверка по правилам и пересборка у хоста (те же правила, что у кнопки «Применить») */
  hostRobotRequest(team, cfg) {
    if (!team) return;
    const app = this.app;
    let size = 0;
    try { size = JSON.stringify(cfg).length; } catch { size = Infinity; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || size > 16 * 1024) { this.toTeam(team, '✖ Робот не принят: повреждённая конфигурация\n', 'err'); return; }
    // по сети — только поля и пределы конструктора (validateConfig на многое лишь предупреждает)
    const clean = sanitizeGuestConfig(cfg);
    if (clean.errors.length) { this.toTeam(team, `✖ Робот не принят: ${clean.errors.join(' ')}\n`, 'err'); return; }
    const v = validateConfig(clean.cfg);
    if (!v.ok) { this.toTeam(team, `✖ Робот не принят: ${v.errors.join(' ')}\n`, 'err'); return; }
    const S = app.state;
    if (S.mode === 'match' && S.match.phase === 'settling') { this.toTeam(team, '✖ Матч окончен — робота не меняют\n', 'err'); return; }
    // сейчас на поле робот хоста — запомнить, чтобы вернуть его после комнаты
    const cur = app.sim.robots[team].config;
    if (this.guestSig[team] !== cfgSig(cur)) this.own[team] = cur;
    // app.setRobotConfig сохраняет робота в localStorage — робот гостя хосту сохранять незачем: вернём как было
    const had = app.store.get('config.' + team, null);
    let res;
    try {
      // вне матча — всегда (робот встанет на старт); во время матча — только робот целиком в зоне Technician
      res = app.setRobotConfig(team, v.cfg, { force: !app.matchLocked(), persist: false });
    } finally { this.restoreStored(team, had); }
    if (!res || !res.ok) { this.toTeam(team, `✖ Хост не пересобрал робота: ${((res && res.errors) || []).join(' ')}\n`, 'err'); return; }
    this.guestSig[team] = cfgSig(app.sim.robots[team].config);
    app.log(team, `Онлайн: игроки команды прислали робота «${v.cfg.name}»`, null);
    this.toTeam(team, `✔ Хост пересобрал робота «${v.cfg.name}»\n`, 'ok');
  }
  /**
   * Вывод консоли команды -> гостям (событие app 'console': строка или склеенный кусок вывода).
   * Строки раннера и хоста (запуск, итог, ошибки — с классом) идут всегда, вывод print — в пределах
   * CON_RATE символов/с на команду; пропущенное отмечается строкой «… пропущено фрагментов вывода: N».
   */
  onConsole(side, text, cls) {
    if (!this.isHost || !SIDES.includes(side)) return;
    let t = String(text);
    const c = this.con[side], now = performance.now();
    c.tok = Math.min(CON_BURST, c.tok + (now - c.t) / 1000 * CON_RATE); c.t = now;
    // main.js очищает консоль команды перед строкой «▶ Запуск …» — гость очищает свою там же
    if (t.startsWith('▶ Запуск')) { this.pushEv({ k: 'clr', side }); c.skip = 0; }
    if (t.length > CON_LINE_MAX) t = t.slice(0, CON_LINE_MAX) + '…\n';
    if (!cls && c.tok < t.length) { c.skip++; return; }
    c.tok = Math.max(-CON_BURST, c.tok - t.length);
    if (c.skip) { this.pushEv({ k: 'con', side, text: `… пропущено фрагментов вывода: ${c.skip} (слишком частый print для онлайна)\n`, cls: 'warn' }); c.skip = 0; }
    this.pushEv({ k: 'con', side, text: t, cls: cls || '' });
  }
  onMatchStartHost() {
    if (!this.isHost) return;
    for (const s of SIDES) {
      const code = this.pending[s];
      if (!code) continue;
      this.pending[s] = null;
      this.remoteRan[s] = true;
      Promise.resolve(this.app.runProgram(s, code)).catch((e) => this.app.ui.showError(e, 'Программа гостя'));
    }
  }
  /** Хост меняет свою команду (или становится судьёй) */
  setHostSide(side) {
    const s = SIDES.includes(side) ? side : null;
    this.wantSide = s;
    if (this.online && this.isHost) this.wsSend({ t: 'side', side: s });
    if (s && this.app.state.team !== s) this.app.setTeam(s);
    this.saveSession();
  }
  /** Источник ввода хоста: Recycler гостя — событие одного опроса */
  recycleSource() {
    if (!this.isHost || (!this.recycle.red && !this.recycle.blue)) return null;
    const out = {};
    for (const s of SIDES) if (this.recycle[s]) { out[s] = { recycle: true }; this.recycle[s] = false; }
    return out;
  }

  // ======================= гость =======================
  startGuest() {
    const app = this.app;
    this.mode = 'guest';
    this.saved = {
      team: app.state.team, paused: !!app.state.paused, speed: app.state.speed,
      cfg: { red: app.sim.robots.red.config, blue: app.sim.robots.blue.config },
      programMode: app.input.programMode,
    };
    this.hostPaused = !!app.state.paused;
    this.buf = []; this.hist = []; this.gkey = null; this.play = null; this.playT = 0; this.lastApplied = ''; this.lat = null;
    this.cfgFor = { red: cfgSig(app.sim.robots.red.config), blue: cfgSig(app.sim.robots.blue.config) };
    this.remoteProg = { red: 'idle', blue: 'idle' };
    app.setStepAuthority(false);
    if (SIDES.includes(this.role) && app.state.team !== this.role) app.setTeam(this.role);
    // клавиши — рычаги пульта, пока программа команды работает у хоста
    const orig = this.saved.programMode;
    app.input.programMode = (side) => this.remoteProg[side] === 'running' || (typeof orig === 'function' && orig(side));
  }
  stopGuest() {
    const app = this.app, sv = this.saved;
    this.mode = null;
    if (sv && sv.programMode) app.input.programMode = sv.programMode;
    for (const s of SIDES) {
      if (this.remoteProg[s] === 'running') { try { app.runners[s].onState('stopped', {}); } catch { /* раннер без хука */ } }
      this.remoteProg[s] = 'idle';
    }
    app.setStepAuthority(true);
    // своё поле: обычная тренировка, свои роботы, чистое поле
    app.state.match.phase = 'idle';
    app.setMode('train');
    if (this.app.sim.latched) app.sim.unlatch();
    if (sv) { app.setPaused(sv.paused); app.setSpeed(sv.speed); }
    for (const s of SIDES) {
      const own = sv && sv.cfg[s];
      if (own && cfgSig(own) !== cfgSig(app.sim.robots[s].config)) app.sim.setRobotConfig(s, own, { force: true });
      try { app.sim.robots[s].stopMove(); app.sim.robots[s].arm.stop(); } catch { /* робот пересобран */ }
    }
    app.resetField();
    app.ui.banner(null);
    this.buf = []; this.hist = []; this.play = null; this.gkey = null; this.lat = null; this.saved = null;
  }
  guestRecv(d) {
    switch (d.k) {
      case 'snap': this.onSnap(d); break;
      case 'ev': for (const e of Array.isArray(d.l) ? d.l : []) this.guestEvent(e); break;
      case 'init': this.onInit(d); break;
      case 'pong': if (typeof d.c === 'number') this.rttHost = Math.max(0, performance.now() - d.c); break;
      default: this.app.emit('netMessage', d, 'host', null);
    }
  }
  onInit(d) {
    if (d.cfg) for (const s of SIDES) if (d.cfg[s]) this.applyCfg(s, d.cfg[s], d.sig && d.sig[s]);
    if (d.prog) for (const s of SIDES) this.applyProg(s, d.prog[s] || 'idle', {});
    this.applyMatch(d.m, d.lat, true);
    this.render();
  }
  guestEvent(e) {
    if (!e || typeof e !== 'object') return;
    const app = this.app;
    switch (e.k) {
      case 'con': if (SIDES.includes(e.side)) app.runners[e.side].out(String(e.text), e.cls || ''); break;
      case 'clr': if (SIDES.includes(e.side)) { const el = document.getElementById('console-' + e.side); if (el) el.textContent = ''; } break;
      case 'prog': if (SIDES.includes(e.side)) this.applyProg(e.side, e.st, e.info || {}); break;
      case 'cfg': if (SIDES.includes(e.side) && e.cfg) this.applyCfg(e.side, e.cfg, e.sig); break;
      case 'match': this.applyMatch(e.m, e.lat, false); break;
      default: app.emit('netMessage', e, 'host', null);
    }
  }
  applyCfg(side, cfg, sig) {
    const hostSig = sig || cfgSig(cfg);
    if (this.cfgFor[side] === hostSig && cfgSig(this.app.sim.robots[side].config) === hostSig) return;
    const res = this.app.sim.setRobotConfig(side, cfg, { force: true });
    this.cfgFor[side] = hostSig;
    if (!res || !res.ok) this.app.log(side, 'Онлайн: робот хоста не собрался — ' + ((res && res.errors) || []).join(' '), null);
    this.lastApplied = '';
  }
  applyProg(side, st, info) {
    const prev = this.remoteProg[side];
    this.remoteProg[side] = st;
    if (prev === st && st !== 'running') return;
    try { this.app.runners[side].onState(st, info || {}); } catch (e) { console.error(e); }
  }
  /** Фаза матча, режим и зафиксированный счёт хоста (события без потерь) */
  applyMatch(m, lat, init) {
    if (!m) return;
    const app = this.app, S = app.state, sim = app.sim;
    this.lat = lat || null;
    if (this.lat) sim.latched = this.lat; else if (sim.latched) sim.unlatch();
    if (m.mo !== S.mode) { S.match.phase = 'idle'; app.setMode(m.mo); }
    const prev = S.match.phase;
    Object.assign(S.match, { phase: m.ph, left: m.left, cd: m.cd, settle: m.se, startT: m.st ?? undefined, aborted: !!m.ab });
    S.trainT0 = m.t0;
    if (m.pa !== this.hostPaused) { this.hostPaused = !!m.pa; app.setPaused(this.hostPaused); }
    if (m.sp !== S.speed) app.setSpeed(m.sp);
    if (prev === m.ph && !init) return;
    if (m.ph === 'running' && prev !== 'running') {
      if (!init) { app.log(null, 'Матч начался (2:30)', null); app.emit('matchStart', { time: sim.time }); }
    } else if (m.ph === 'settling') {
      app.ui.banner(m.ab ? 'Матч остановлен' : 'Время!', 'досчитываем положение фишек…');
    } else if (m.ph === 'ended') {
      const sc = { red: sim.score('red'), blue: sim.score('blue') };
      app.ui.banner(m.ab ? 'Матч остановлен' : 'Итог матча', `Красные ${sc.red.total} · Синие ${sc.blue.total}`);
      if (!init && (prev === 'settling' || prev === 'running')) {
        app.log(null, `Итог матча${m.ab ? ' (остановлен)' : ''}: красные ${sc.red.total}, синие ${sc.blue.total}`, null);
        app.emit('matchEnd', { red: sc.red, blue: sc.blue, aborted: !!m.ab, time: sim.time });
      }
    } else if (m.ph === 'idle' || m.mo === 'train') {
      app.ui.banner(null);
    }
  }
  onSnap(d) {
    let st = d.st;
    if (!st || !Array.isArray(st.tok)) return;
    if (d.key) {
      const rows = new Map();
      for (const r of st.tok) rows.set(r[0], r);
      this.gkey = { id: d.key, rows };
      this.cnt.keyIn++;
    } else {
      if (!this.gkey || this.gkey.id !== d.base) { this.cnt.skipped++; return; } // ключевой кадр ещё не пришёл
      const rows = new Map(this.gkey.rows);
      for (const r of st.tok) rows.set(r[0], r);
      st = { ...st, tok: [...rows.values()] };
    }
    this.cnt.snapIn++;
    const ts = Number(d.ts) || 0, t = Number(st.t) || 0;
    const last = this.buf[this.buf.length - 1];
    if (last && (t < last.t - 0.5 || ts < last.ts - 1500)) { this.buf = []; this.hist = []; this.play = null; } // хост перезапущен
    else if (last && ts <= last.ts) return;
    this.hist.push([ts, t]);
    if (this.hist.length > 40) this.hist.shift();
    this.buf.push({ ts, t, st, m: d.m });
    if (this.buf.length > 60) this.buf.splice(0, this.buf.length - 60);
    if (Array.isArray(d.sc)) this.hostScore = d.sc;
  }
  /**
   * Показ по времени симуляции хоста: «часы показа» идут с темпом хоста (сим-с за с), отставая от свежего
   * снимка на самый большой недавний скачок времени + 50 мс. Так движение плавное и при ровных шагах хоста,
   * и когда хост считает рывками (фоновая вкладка, медленный компьютер), и при скорости 4×; пауза — без отставания.
   */
  applyInterp(force = false) {
    const buf = this.buf;
    if (!buf.length) return false;
    const now = performance.now();
    const dt = this.playT ? Math.min(0.25, (now - this.playT) / 1000) : 0;
    this.playT = now;
    const last = buf[buf.length - 1], h = this.hist;
    let rate = 1, gap = 0;
    if (h.length >= 2) {
      const span = h[h.length - 1][0] - h[0][0];
      if (span > 200) rate = clamp((h[h.length - 1][1] - h[0][1]) / (span / 1000), 0, 8);
      for (let i = 1; i < h.length; i++) gap = Math.max(gap, h[i][1] - h[i - 1][1]);
    }
    const lag = rate < 0.02 ? 0 : Math.min(2, gap + 0.05 * rate);
    const want = last.t - lag;
    if (this.play === null || Math.abs(want - this.play) > Math.max(1, 3 * lag)) this.play = want;
    else { this.play += rate * dt; this.play += (want - this.play) * Math.min(1, dt * 2); }
    if (this.play > last.t || last.t - this.play < 1e-4) this.play = last.t;
    this.rateNow = rate; this.lagNow = rate > 0.02 ? lag / rate : 0;
    const D = this.play;
    let i = buf.length - 1;
    while (i > 0 && buf[i].t > D) i--;
    if (i > 0) buf.splice(0, i);
    const a = buf[0], b = buf[1];
    let st = a.st, m = a.m, key = String(a.ts);
    if (b && D > a.t && b.t > a.t) {
      const u = clamp((D - a.t) / (b.t - a.t), 0, 1);
      try { st = blendState(a.st, b.st, u); } catch { st = b.st; }
      m = b.m && a.m && a.m.ph === b.m.ph ? { ...b.m, left: lerp(a.m.left, b.m.left, u), cd: lerp(a.m.cd, b.m.cd, u), se: lerp(a.m.se, b.m.se, u) } : b.m;
      key = a.ts + ':' + u.toFixed(4);
    }
    if (key === this.lastApplied && !force) return false;
    this.lastApplied = key;
    this.applySnap(st, m);
    return true;
  }
  applySnap(st, m) {
    const app = this.app, sim = app.sim;
    const st2 = { ...st, rob: { ...(st.rob || {}) } };
    for (const s of SIDES) {
      const rs = st2.rob[s];
      if (rs && rs.sig !== this.cfgFor[s]) {
        delete st2.rob[s]; // робот у хоста другой — ждём его конфигурацию
        const now = performance.now();
        if (now - this.cfgAskT > 2000) { this.cfgAskT = now; this.relay({ k: 'needcfg' }, 'host', false); }
      }
    }
    try { sim.applyState(st2); } catch (e) { app.ui.showError(e, 'Онлайн: снимок хоста'); return; }
    for (const s of SIDES) {
      const rs = st2.rob[s];
      if (rs && Array.isArray(rs.m)) { const r = sim.robots[s]; r.left.pos = rs.m[0]; r.right.pos = rs.m[1]; r.arm.pos = rs.m[2]; }
    }
    // зафиксированный счёт — только из событий хоста (сброс поля в applyState его снимает)
    if (this.lat && !sim.latched) sim.latched = this.lat;
    else if (!this.lat && sim.latched) sim.unlatch();
    if (m) {
      const M = app.state.match;
      if (m.ph === M.phase && m.mo === app.state.mode) { M.left = m.left; M.cd = m.cd; M.settle = m.se; }
    }
  }
  guestFrame() {
    if (!this.isGuest) return;
    if (SIDES.includes(this.role) && this.app.input.get(this.role).recycle) this.rcLatch = true;
    this.applyInterp();
  }
  sendInput() {
    if (!this.isGuest || !this.online || !SIDES.includes(this.role)) return;
    const ti = this.app.input.get(this.role);
    const lv = ti.levers || { driver: [0, 0], specialist: [0, 0] };
    const d = {
      k: 'in', f: r2(ti.drive.fwd), t: r2(ti.drive.turn), a: r2(ti.arm), tr: r2(ti.tree), s: ti.slow ? 1 : 0,
      lv: [r2(lv.driver[0]), r2(lv.driver[1]), r2(lv.specialist[0]), r2(lv.specialist[1])],
      L: this.remoteProg[this.role] === 'running' ? 1 : 0, rc: this.rcLatch ? 1 : 0,
    };
    this.rcLatch = false;
    const n = this.relay(d, 'host', !d.rc);
    if (n) { this.cnt.inOut++; this.size.input = n; }
  }
  onRemoteRun(side, code) {
    if (!this.isGuest) return;
    const out = (t, c) => setTimeout(() => this.app.runners[side].out(t, c), 0); // после строки main.js
    if (this.role === 'spectator') { out('Зритель не запускает программы.\n', 'warn'); return; }
    if (side !== this.role) { out(`…но вы играете за ${SIDE_GEN[this.role]} — программа ${SIDE_GEN[side]} не отправлена.\n`, 'warn'); return; }
    if (!this.online) { out('Нет связи с хостом — программа не отправлена.\n', 'err'); return; }
    if (code.length > MAX_CODE) { out('Программа слишком большая для отправки.\n', 'err'); return; }
    this.relay({ k: 'run', code }, 'host', false);
  }
  onRemoteStop(side) {
    if (!this.isGuest || side !== this.role) return;
    this.relay({ k: 'stop' }, 'host', false);
  }
  onKeyCapture(e) {
    // Space у гостя: программа работает у хоста — остановить (main.js видит только локальный раннер)
    if (!this.isGuest || e.code !== 'Space' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target) || isControlTarget(e.target)) return;
    const side = this.app.state.team;
    if (side === this.role && this.remoteProg[side] === 'running') {
      e.preventDefault(); e.stopImmediatePropagation();
      this.app.stopProgram(side);
    }
  }

  // ======================= таймеры =======================
  ping() {
    if (this.state !== 'online') return;
    const c = performance.now();
    this.wsSend({ t: 'ping', c });
    if (this.isGuest && this.room) this.relay({ k: 'ping', c }, 'host', false);
  }
  tickStats() {
    const now = performance.now(), dt = (now - this.statT) / 1000;
    if (dt <= 0) return;
    const p = this.statPrev, c = this.cnt;
    for (const k of Object.keys(this.rate)) this.rate[k] = Math.round(((c[k] || 0) - (p[k] || 0)) / dt * 10) / 10;
    this.statT = now; this.statPrev = { ...c };
    if (this.state === 'online') this.saveSession();
    this.renderLive();
  }

  // ======================= интерфейс =======================
  setState(st) {
    this.state = st;
    this.app.emit('net', { state: st, role: this.role, room: this.room, mode: this.mode });
    this.renderLive();
  }
  showMsg(text, cls = '') {
    const el = this.el.msg;
    if (!el) return;
    el.textContent = text || '';
    el.className = 'net-msg ' + (cls || '');
  }
  build() {
    const pane = this.pane;
    pane.innerHTML = `
<div class="net">
  <div class="net-bar">
    <span class="net-status" data-state="off"><i aria-hidden="true"></i><span data-ref="status">Не подключено</span></span>
    <span class="net-ping" data-ref="ping"></span>
  </div>
  <section class="net-lobby" data-ref="lobby">
    <label class="field net-name">Имя или название команды
      <input data-ref="name" maxlength="24" autocomplete="nickname" placeholder="например, «Светлячки»"></label>
    <div class="net-card">
      <h3>Создать комнату</h3>
      <p class="hint">Этот компьютер будет считать физику для всех. Друзья входят по коду комнаты.</p>
      <div class="net-row">
        <label class="field">Хост играет за
          <select data-ref="hostSide"><option value="red">Красных</option><option value="blue">Синих</option><option value="">Никого (судья)</option></select></label>
        <button type="button" class="btn" data-ref="create">Создать комнату</button>
      </div>
    </div>
    <div class="net-card">
      <h3>Войти по коду</h3>
      <div class="net-row">
        <input class="net-code-in" data-ref="code" maxlength="4" placeholder="КОД" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Код комнаты (4 символа)">
      </div>
      <p class="hint" data-ref="codeHint">Код — 4 символа. Буквы O, I, L, S, Z, B и цифры 0, 1, 2, 5, 8 в кодах не встречаются.</p>
      <div class="net-roles" role="group" aria-label="Войти как">
        <button type="button" class="btn net-role red" data-role="red">Красная</button>
        <button type="button" class="btn net-role blue" data-role="blue">Синяя</button>
        <button type="button" class="btn ghost net-role" data-role="spectator">Зритель</button>
      </div>
    </div>
    <details class="net-adv">
      <summary>Сервер</summary>
      <label class="field">Адрес WebSocket <input data-ref="url" spellcheck="false" placeholder=""></label>
      <p class="hint">Пусто — этот же сайт (<code data-ref="defUrl"></code>). Локально: <code>python server.py</code> и откройте http://localhost:8080.</p>
    </details>
  </section>
  <section class="net-roomv" data-ref="roomv" hidden>
    <div class="net-codebox">
      <div><span>Комната</span><b data-ref="roomCode">····</b></div>
      <div class="net-copy">
        <button type="button" class="btn ghost small" data-ref="copy">Копировать код</button>
        <button type="button" class="btn ghost small" data-ref="copyLink">Ссылка</button>
      </div>
    </div>
    <p class="net-you" data-ref="you"></p>
    <label class="field net-hostside" data-ref="hostSideBox">Хост играет за
      <select data-ref="hostSide2"><option value="red">Красных</option><option value="blue">Синих</option><option value="">Никого (судья)</option></select></label>
    <h3>Участники</h3>
    <ul class="net-peers" data-ref="peers"></ul>
    <dl class="net-stats" data-ref="stats"></dl>
    <button type="button" class="btn stop" data-ref="leave">Покинуть комнату</button>
  </section>
  <p class="net-msg" data-ref="msg" role="status" aria-live="polite"></p>
  <details class="net-help">
    <summary>Как играть онлайн</summary>
    <ul>
      <li>Хост создаёт комнату и говорит код. Его компьютер считает поле, роботов и программы обеих команд.</li>
      <li>Гость выбирает команду: его клавиатура и геймпад управляют своим роботом, «Запустить» отправляет программу хосту, консоль приходит обратно.</li>
      <li>Пока программа команды работает, клавиши — рычаги пульта Controller (как в локальном режиме).</li>
      <li>До старта матча программа гостя ждёт у хоста и запускается по сигналу старта.</li>
      <li>Матч, сброс поля, штрафы и скорость — у хоста. При обрыве связь восстановится сама.</li>
    </ul>
  </details>
</div>`;
    pane.querySelectorAll('[data-ref]').forEach((n) => { this.el[n.dataset.ref] = n; });
    this.el.statusBox = pane.querySelector('.net-status');
    const el = this.el;
    el.name.value = this.name;
    el.name.addEventListener('change', () => { this.name = el.name.value.trim().slice(0, 24); this.app.store.set('net.name', this.name); });
    const side0 = this.app.state.team;
    el.hostSide.value = SIDES.includes(side0) ? side0 : 'red';
    el.create.addEventListener('click', () => this.host({ side: el.hostSide.value || null, name: this.nameNow() }).catch(() => { /* сообщение уже в панели */ }));
    // код: клавиша по физической позиции (KeyboardEvent.code) — работает в русской раскладке
    el.code.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); return; }
      const mm = /^(?:Key([A-Z])|Digit([0-9])|Numpad([0-9]))$/.exec(e.code || '');
      if (!mm || e.key === 'Tab') return;
      e.preventDefault();
      const ch = mm[1] || mm[2] || mm[3];
      const t = e.target, s0 = t.selectionStart ?? t.value.length, s1 = t.selectionEnd ?? t.value.length;
      t.value = t.value.slice(0, s0) + ch + t.value.slice(s1);
      this.normCodeInput(ch);
    });
    el.code.addEventListener('input', () => this.normCodeInput());
    pane.querySelectorAll('.net-role').forEach((b) => b.addEventListener('click', () => {
      const code = normalizeCode(el.code.value);
      if (code.length !== 4) { this.showMsg('Введите код комнаты из 4 символов.', 'err'); el.code.focus(); return; }
      this.join(code, b.dataset.role, this.nameNow()).catch(() => { /* сообщение уже в панели */ });
    }));
    el.defUrl.textContent = wsUrlFor() || '—';
    el.url.placeholder = wsUrlFor() || 'wss://…/ws';
    el.url.value = this.customUrl;
    el.url.addEventListener('change', () => {
      const v = el.url.value.trim();
      if (v && !/^wss?:\/\/[^\s]+$/i.test(v)) { this.showMsg('Адрес должен начинаться с ws:// или wss://', 'err'); return; }
      this.customUrl = v; this.app.store.set('net.url', v);
      this.showMsg(v ? 'Сервер: ' + v : 'Сервер: этот же сайт', 'ok');
    });
    el.copy.addEventListener('click', () => this.copy(this.room || '', 'Код скопирован'));
    el.copyLink.addEventListener('click', () => this.copy(this.inviteLink(), 'Ссылка скопирована'));
    el.hostSide2.addEventListener('change', () => this.setHostSide(el.hostSide2.value || null));
    el.leave.addEventListener('click', () => this.leave());
    // точка состояния на кнопке вкладки
    const tab = document.getElementById('tab-online');
    if (tab && !tab.querySelector('.net-tabdot')) { const dot = document.createElement('i'); dot.className = 'net-tabdot'; dot.setAttribute('aria-hidden', 'true'); tab.appendChild(dot); }
    this.el.tabDot = tab ? tab.querySelector('.net-tabdot') : null;
  }
  nameNow() {
    const v = (this.el.name && this.el.name.value || '').trim().slice(0, 24);
    if (v !== this.name) { this.name = v; this.app.store.set('net.name', v); }
    return v;
  }
  normCodeInput(typed) {
    const el = this.el.code;
    const v = normalizeCode(el.value);
    const dropped = typed ? !CODE_CHARS.includes(typed) : v.length < el.value.replace(/\s/g, '').length;
    if (v !== el.value) el.value = v;
    this.el.codeHint.classList.toggle('warn', !!dropped);
  }
  inviteLink() {
    if (!this.room) return '';
    const u = new URL(location.href);
    u.search = ''; u.hash = '';
    u.searchParams.set('room', this.room);
    return u.href;
  }
  copy(text, ok) {
    if (!text) return;
    const done = () => this.showMsg(ok + ': ' + text, 'ok');
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch { this.showMsg('Скопируйте вручную: ' + text, 'warn'); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }
  render() {
    const el = this.el;
    if (!el.lobby) return;
    const inRoom = !!this.mode || (this.state !== 'off' && !!this.room && this.everWelcomed);
    el.lobby.hidden = inRoom;
    el.roomv.hidden = !inRoom;
    const busy = this.state !== 'off';
    for (const b of this.pane.querySelectorAll('.net-lobby button, .net-lobby input, .net-lobby select')) b.disabled = busy;
    if (inRoom) {
      el.roomCode.textContent = this.room || '····';
      const you = this.role === 'host'
        ? `Вы — хост${this.hostSide ? `, играете за ${SIDE_GEN[this.hostSide]}` : ' (судья)'}. Матч, сброс поля и штрафы — здесь.`
        : this.role === 'spectator' ? 'Вы — зритель: смотрите поле и консоли обеих команд.'
          : this.role ? `Вы играете за ${SIDE_GEN[this.role]}: клавиатура и геймпад управляют вашим роботом, «Запустить» отправляет программу хосту.` : '';
      el.you.textContent = you;
      el.hostSideBox.hidden = this.role !== 'host';
      el.hostSide2.value = this.hostSide || '';
      for (const o of el.hostSide2.options) o.disabled = !!o.value && this.peers.some((p) => p.role === o.value);
      const rows = [];
      for (const p of this.peers) {
        const me = p.id === this.id ? ' <em>(вы)</em>' : '';
        const extra = p.role === 'host' && this.hostSide ? ` · за ${SIDE_GEN[this.hostSide]}` : '';
        rows.push(`<li class="${p.role}${p.on ? '' : ' off'}"><span class="net-chip">${ROLE_RU[p.role] || esc(p.role)}</span><b>${esc(p.name)}</b>${me}${extra}${p.on ? '' : ' <small>нет связи</small>'}</li>`);
      }
      for (const s of SIDES) if (this.hostSide !== s && !this.peers.some((p) => p.role === s)) rows.push(`<li class="${s} free"><span class="net-chip">${ROLE_RU[s]}</span><small>свободно</small></li>`);
      el.peers.innerHTML = rows.join('');
    }
    this.renderLive();
  }
  renderLive() {
    const el = this.el;
    if (!el.status) return;
    const st = this.state;
    let text = 'Не подключено', dot = st;
    if (st === 'connecting') text = 'Подключение…';
    else if (st === 'reconnecting') {
      const left = this.retryAt ? Math.max(0, Math.ceil((this.retryAt - performance.now()) / 1000)) : 0;
      // связи ещё не было (первое подключение) — «потеряна» было бы неправдой
      if (!this.everWelcomed) text = this.ws ? 'Подключение…' : `Сервер не отвечает — повтор через ${left} с`;
      else text = this.ws ? 'Переподключение…' : `Связь потеряна — повтор через ${left} с`;
    } else if (st === 'online') {
      text = `Комната ${this.room} · ${this.role === 'host' ? 'хост' : (ROLE_RU[this.role] || '').toLowerCase()}`;
      if (this.isGuest && (this.waitingHost || this.peers.some((p) => p.role === 'host' && !p.on))) { text += ' · ждём хоста'; dot = 'reconnecting'; }
    }
    el.statusBox.dataset.state = dot;
    el.status.textContent = text;
    if (el.tabDot) el.tabDot.dataset.state = st === 'off' ? '' : dot;
    const ping = [];
    if (st === 'online' && this.rttServer !== null) ping.push(`сервер ${Math.round(this.rttServer)} мс`);
    if (st === 'online' && this.isGuest && this.rttHost !== null) ping.push(`хост ${Math.round(this.rttHost)} мс`);
    el.ping.textContent = ping.join(' · ');
    if (!el.stats || el.roomv.hidden) return;
    const R = this.rate, rows = [];
    if (this.isHost) {
      const g = this.peers.filter((p) => p.role !== 'host' && p.on).length;
      rows.push(['Гостей в сети', String(g)]);
      rows.push(['Снимки', g ? `${R.snapOut}/с · ключ ${kb(this.size.key)}, разность ${kb(this.size.delta)}` : 'ждут гостей']);
      rows.push(['Ввод гостей', `${R.inIn}/с`]);
      rows.push(['Отправлено', `${kb(Math.round(R.bytesOut))}/с`]);
    } else if (this.isGuest) {
      rows.push(['Снимки', `${R.snapIn}/с · показ с задержкой ${Math.round(this.lagNow * 1000)} мс`]);
      if (SIDES.includes(this.role)) rows.push(['Ваш ввод', `${R.inOut}/с`]);
      rows.push(['Получено', `${kb(Math.round(R.bytesIn))}/с`]);
      rows.push(['Счёт у хоста', `красные ${this.hostScore[0] ?? 0} · синие ${this.hostScore[1] ?? 0}`]);
      if (this.hostPaused) rows.push(['Хост', 'пауза']);
    }
    el.stats.innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  }

  // ======================= запуск модуля =======================
  boot() {
    const app = this.app;
    this.build();
    app.on('frame', () => { if (this.isHost) this.hostTick(); else if (this.isGuest) this.guestFrame(); });
    app.on('console', (side, text, cls) => this.onConsole(side, text, cls));
    app.on('programState', (side, st, info) => {
      if (this.isHost && SIDES.includes(side)) this.pushEv({ k: 'prog', side, st, info: { line: (info && info.line) || 0 } });
    });
    app.on('robotConfig', (side) => {
      if (!this.isHost || !SIDES.includes(side)) return;
      const cfg = app.sim.robots[side].config;
      this.pushEv({ k: 'cfg', side, cfg, sig: cfgSig(cfg) });
      this.forceKey = true;
    });
    app.on('reset', () => { if (this.isHost) this.forceKey = true; });
    app.on('mode', () => { if (this.isHost) this.pending = { red: null, blue: null }; });
    app.on('matchStart', () => this.onMatchStartHost());
    // первое событие 'score' было ещё до загрузки этого модуля — начальный счёт берём сами
    this.lastSc = this.scoreNow();
    app.on('score', (sc) => { if (sc && sc.red && sc.blue) this.lastSc = [sc.red.total, sc.blue.total]; });
    app.on('remoteRun', (side, code) => this.onRemoteRun(side, code));
    app.on('remoteStop', (side) => this.onRemoteStop(side));
    app.input.addSource(() => this.recycleSource());
    window.addEventListener('keydown', (e) => this.onKeyCapture(e), true);
    // таймеры работают и в фоновой вкладке (кадры там редкие)
    setInterval(() => this.hostTick(), SNAP_MS);
    setInterval(() => this.sendInput(), INPUT_MS);
    setInterval(() => this.ping(), PING_MS);
    setInterval(() => this.tickStats(), 1000);
    window.addEventListener('pagehide', () => { if (this.state === 'online') this.saveSession(); });
    this.render();
    // ?room=КОД[&role=red|blue|spectator] — приглашение
    const q = new URLSearchParams(location.search);
    if (q.has('room') || q.has('role')) {
      // параметры приглашения убираем из адреса: перезагрузка не войдёт в комнату повторно
      try { const u = new URL(location.href); u.searchParams.delete('room'); u.searchParams.delete('role'); history.replaceState(history.state, '', u.href); } catch { /* адрес не меняем */ }
    }
    if (this.restoreSession()) { this.render(); return; }
    const code = normalizeCode(q.get('room') || '');
    if (code.length === 4) {
      this.el.code.value = code;
      app.ui.tab('online');
      const role = q.get('role');
      if (['red', 'blue', 'spectator'].includes(role)) this.join(code, role, this.nameNow()).catch(() => { /* сообщение уже в панели */ });
      else this.showMsg(`Приглашение в комнату ${code}: выберите команду.`, 'ok');
    }
  }
}

export function install(app) {
  const pane = app.ui.panel('online');
  if (!pane) return null;
  const net = new Net(app, pane);
  app.net = net;
  net.boot();
  return net;
}
