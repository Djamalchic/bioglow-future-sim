// Python в браузере (Skulpt) + эмуляция официального модуля `legoeducation`
// (LEGO Education Computer Science & AI, github.com/LEGO/LEGOEducation).
// Программа из симулятора переносится на настоящего робота почти без изменений:
// на реальном железе нужен Python 3.14+ и `pip install legoeducation`, а в connect() — цвет и номер карточки.
//
// Две команды одновременно: Skulpt — глобальный синглтон, поэтому
//  * у каждой команды свой модуль legoeducation_<side> со своим мостом _sim_<side> — импорт в программе
//    переписывается без сдвига строк (`import legoeducation as le` -> `import legoeducation_red as le`);
//  * раннер сам продолжает Python после каждой приостановки и на это время помечает себя «текущим»:
//    print() и модуль time идут к мосту и в консоль именно этой команды;
//  * у каждого запуска свой id; остановка обрывает цепочку без возврата в Python (review H6).
import { StopSignal } from './bridge.js';

const LE_PY = `
import __SIMMOD__ as _sim

UNCHANGED = -32768
DEFAULT_MOTOR = 0

LEGO_COLOR_NOCOLOR = -1
LEGO_COLOR_BLACK = 0
LEGO_COLOR_MAGENTA = 1
LEGO_COLOR_PURPLE = 2
LEGO_COLOR_BLUE = 3
LEGO_COLOR_AZURE = 4
LEGO_COLOR_TEAL = 5
LEGO_COLOR_GREEN = 6
LEGO_COLOR_YELLOW = 7
LEGO_COLOR_ORANGE = 8
LEGO_COLOR_RED = 9
LEGO_COLOR_WHITE = 10

MOTOR_END_STATE_DEFAULT = 0
MOTOR_END_STATE_COAST = 1
MOTOR_END_STATE_BRAKE = 2
MOTOR_END_STATE_HOLD = 3
MOTOR_END_STATE_CONTINUE = 4
MOTOR_END_STATE_SMART_COAST = 5
MOTOR_END_STATE_SMART_BRAKE = 6

MOTOR_MOVE_DIRECTION_CLOCKWISE = 0
MOTOR_MOVE_DIRECTION_COUNTERCLOCKWISE = 1
MOTOR_MOVE_DIRECTION_SHORTEST = 2
MOTOR_MOVE_DIRECTION_LONGEST = 3

MOTOR_STATE_READY = 0
MOTOR_STATE_RUNNING = 1
MOTOR_STATE_STALLED = 2
MOTOR_STATE_CMD_ABORTED = 3
MOTOR_STATE_REGULATION_ERROR = 4
MOTOR_STATE_MOTOR_DISCONNECTED = 5
MOTOR_STATE_HOLDING = 6
MOTOR_STATE_DC_RUNNING = 7
MOTOR_STATE_NOT_ALLOWED_TO_RUN = 8

MOTOR_GESTURE_NO_GESTURE = 0
MOTOR_GESTURE_SLOW_CLOCKWISE = 1
MOTOR_GESTURE_FAST_CLOCKWISE = 2
MOTOR_GESTURE_SLOW_COUNTERCLOCKWISE = 3
MOTOR_GESTURE_FAST_COUNTERCLOCKWISE = 4
MOTOR_GESTURE_WIGGLED = 5

MOTOR_LEFT = 1
MOTOR_RIGHT = 2
MOTOR_BOTH = 3
MOTOR_BITS_LEFT = 1
MOTOR_BITS_RIGHT = 2

MOVEMENT_DIRECTION_FORWARD = 0
MOVEMENT_DIRECTION_BACKWARD = 1
MOVEMENT_DIRECTION_LEFT = 2
MOVEMENT_DIRECTION_RIGHT = 3
MOVEMENT_MOVE_DIRECTION_FORWARD = 0
MOVEMENT_MOVE_DIRECTION_BACKWARD = 1
MOVEMENT_TURN_DIRECTION_LEFT = 0
MOVEMENT_TURN_DIRECTION_RIGHT = 1

DEVICE_FACE_TOP = 0
DEVICE_FACE_FRONT = 1
DEVICE_FACE_RIGHT = 2
DEVICE_FACE_BOTTOM = 3
DEVICE_FACE_BACK = 4
DEVICE_FACE_LEFT = 5

MOTION_GESTURE_NO_GESTURE = 0
MOTION_GESTURE_TAPPED = 1
MOTION_GESTURE_DOUBLE_TAPPED = 2
MOTION_GESTURE_COLLISION = 3
MOTION_GESTURE_SHAKE = 4
MOTION_GESTURE_FREEFALL = 5

LIGHT_PATTERN_SOLID = 0
LIGHT_PATTERN_BREATHE = 1
LIGHT_PATTERN_PULSE = 2
LIGHT_PATTERN_SHORT_BLINK = 3
LIGHT_PATTERN_LONG_BLINK = 4
LIGHT_PATTERN_DOUBLE_BLINK = 5

BUTTON_STATE_RELEASED = 0
BUTTON_STATE_PRESSED = 1

SOUND_PATTERN_BEEP_SINGLE = 0
SOUND_PATTERN_BEEP_DOUBLE = 1
SOUND_PATTERN_BEEP_TRIPLE = 2
SOUND_PATTERN_BEEP_UP_MIDDLE_DOWN = 3

USB_POWER_STATE_USB_NOT_CONNECTED = 0
USB_POWER_STATE_USB_CONNECTED = 1

PROGRAM_ACTION_START = 0
PROGRAM_ACTION_STOP = 1


def _args(d):
    parts = []
    for k in d:
        v = d[k]
        if v is True:
            v = 1
        elif v is False:
            v = 0
        elif v is None:
            v = UNCHANGED
        parts.append(k + "=" + str(v))
    return ";".join(parts)


# Проверка аргументов: ошибка в строке программы, а не «тихо не то» (enum — допустимые значения)
_ENUM = {
    "motor": ((0, 1, 2, 3), "MOTOR_LEFT / MOTOR_RIGHT / MOTOR_BOTH"),
    "end_state": ((0, 1, 2, 3, 4, 5, 6), "MOTOR_END_STATE_*"),
    "color": ((-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10), "LEGO_COLOR_*"),
    "yaw_face": ((0, 1, 2, 3, 4, 5), "DEVICE_FACE_*"),
}
_DIR_MOVE = ((0, 1, 2, 3), "MOVEMENT_DIRECTION_*")
_DIR_MOVE2 = ((0, 1), "MOVEMENT_MOVE_DIRECTION_FORWARD / BACKWARD")
_DIR_TURN = ((0, 1), "MOVEMENT_TURN_DIRECTION_LEFT / RIGHT")
_DIR_MOTOR = ((0, 1, 2, 3), "MOTOR_MOVE_DIRECTION_*")
_DIRS = {
    "movement_move": _DIR_MOVE,
    "movement_move_for_time": _DIR_MOVE,
    "movement_move_for_degrees": _DIR_MOVE2,
    "movement_turn_for_degrees": _DIR_TURN,
}
_PATTERN = {
    "light_color": ((0, 1, 2, 3, 4, 5), "LIGHT_PATTERN_*"),
    "beep": ((0, 1, 2, 3), "SOUND_PATTERN_*"),
}


def _check(fn, d):
    for k in d:
        v = d[k]
        if k == "blocking" or v is None:
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise TypeError(fn + "(): " + k + " должен быть числом, а не " + type(v).__name__)
        if v != v or v > 1e15 or v < -1e15:
            raise ValueError(fn + "(): " + k + " = " + str(v) + " — нужно конечное число")
        en = None
        if k == "direction":
            en = _DIRS.get(fn, _DIR_MOTOR)
        elif k == "pattern":
            en = _PATTERN.get(fn)
        else:
            en = _ENUM.get(k)
        if en is not None and v not in en[0]:
            raise ValueError(fn + "(): " + k + " = " + str(v) + " — допустимы только константы " + en[1])


class MotorNotification:
    pass


class ColorSensorNotification:
    pass


class ControllerNotification:
    pass


class ImuNotification:
    pass


def device_notification_parser(notification_obj):
    return []


class _MotorData:
    def __init__(self, dev, idx):
        self._dev = dev
        self._idx = idx

    def _g(self, name):
        return _sim.get(self._dev._id, "m" + str(self._idx) + "." + name)

    @property
    def position(self):
        return self._g("position")

    @property
    def absolutePos(self):
        return self._g("absolutePos")

    @property
    def speed(self):
        return self._g("speed")

    @property
    def power(self):
        return self._g("power")

    @property
    def motorState(self):
        return self._g("motorState")

    @property
    def motorBitMask(self):
        return self._g("motorBitMask")

    @property
    def gesture(self):
        return self._g("gesture")


class _MotorTable:
    def __init__(self, dev, single):
        self._dev = dev
        self._single = single
        self._left = _MotorData(dev, 1)
        self._right = _MotorData(dev, 2)

    def __getitem__(self, key):
        if self._single or key == MOTOR_LEFT or key == DEFAULT_MOTOR:
            return self._left
        return self._right


class _ImuData:
    def __init__(self, dev):
        self._dev = dev

    def _g(self, name):
        return _sim.get(self._dev._id, "imu." + name)

    @property
    def yaw(self):
        return self._g("yaw")

    @property
    def pitch(self):
        return self._g("pitch")

    @property
    def roll(self):
        return self._g("roll")

    @property
    def orientation(self):
        return self._g("orientation")

    @property
    def yawFace(self):
        return self._g("yawFace")

    @property
    def accelerometerX(self):
        return self._g("accelerometerX")

    @property
    def accelerometerY(self):
        return self._g("accelerometerY")

    @property
    def accelerometerZ(self):
        return self._g("accelerometerZ")

    @property
    def gyroscopeX(self):
        return self._g("gyroscopeX")

    @property
    def gyroscopeY(self):
        return self._g("gyroscopeY")

    @property
    def gyroscopeZ(self):
        return self._g("gyroscopeZ")


class _Gesture:
    def __init__(self, dev):
        self._dev = dev

    @property
    def gesture(self):
        return _sim.get(self._dev._id, "gesture")


class _ColorData:
    def __init__(self, dev):
        self._dev = dev

    def _g(self, name):
        return _sim.get(self._dev._id, "c." + name)

    @property
    def color(self):
        return self._g("color")

    @property
    def reflection(self):
        return self._g("reflection")

    @property
    def rawRed(self):
        return self._g("rawRed")

    @property
    def rawGreen(self):
        return self._g("rawGreen")

    @property
    def rawBlue(self):
        return self._g("rawBlue")

    @property
    def hue(self):
        return self._g("hue")

    @property
    def saturation(self):
        return self._g("saturation")

    @property
    def value(self):
        return self._g("value")


class _CtrlData:
    def __init__(self, dev):
        self._dev = dev

    def _g(self, name):
        return _sim.get(self._dev._id, "k." + name)

    @property
    def leftPercent(self):
        return self._g("leftPercent")

    @property
    def rightPercent(self):
        return self._g("rightPercent")

    @property
    def leftAngle(self):
        return self._g("leftAngle")

    @property
    def rightAngle(self):
        return self._g("rightAngle")


class _Uuid:
    def __init__(self, s):
        self.uuid = s


class _Device:
    _kind = "Device"

    def __init__(self):
        self._id = ""
        self.connected = False

    def search(self, timeout=5, device_name=None, device_mac=None, card_color=None, card_serial=None):
        return [self._kind + " (sim)"]

    def connect(self, device=None, device_name=None, device_mac=None, card_color=None, card_serial=None, device_notification_delay=0):
        if self.connected and self._id:
            return True
        name = ""
        if device_name is not None:
            name = str(device_name)
        elif device is not None:
            name = str(device)
        self._id = _sim.connect(self._kind, name)
        self.connected = self._id != ""
        return self.connected

    def disconnect(self):
        if self._id:
            _sim.cmd(self._id, "disconnect", "")
        self._id = ""
        self.connected = False

    def _c(self, name, d):
        if not self.connected:
            raise RuntimeError(self._kind + " не подключено: сначала вызовите connect()")
        _check(name, d)
        return _sim.cmd(self._id, name, _args(d))

    def done(self, motor=None):
        return _sim.get(self._id, "done") == 1

    def info(self):
        return _sim.cmd(self._id, "info", "")

    def device_uuid(self):
        return _Uuid("sim-" + self._id)

    def set_notification_callback(self, callback):
        print("[sim] set_notification_callback: уведомления в симуляторе не поддерживаются, читайте значения напрямую")

    def device_notification_request(self, delay_ms, blocking=True):
        return None

    def program_flow_notification(self, action, blocking=True):
        return None

    def begin_batch(self):
        return None

    def end_batch(self, blocking=True):
        return None

    def batch(self, blocking=True):
        return None

    def cancel_batch(self):
        return 0

    def light_color(self, color, pattern=0, intensity=100, blocking=True):
        return self._c("light_color", {"color": color, "pattern": pattern, "intensity": intensity, "blocking": blocking})

    def beep(self, pattern=SOUND_PATTERN_BEEP_SINGLE, frequency=440, count=1, blocking=True):
        return self._c("beep", {"pattern": pattern, "frequency": frequency, "count": count, "blocking": blocking})

    def stop_beep(self, blocking=True):
        return self._c("stop_beep", {"blocking": blocking})

    # ----- моторы (Single Motor и Double Motor) -----
    def motor_set_speed(self, speed, motor=DEFAULT_MOTOR, blocking=True):
        return self._c("motor_set_speed", {"speed": speed, "motor": motor, "blocking": blocking})

    def motor_run(self, direction=MOTOR_MOVE_DIRECTION_CLOCKWISE, motor=DEFAULT_MOTOR, speed=UNCHANGED, blocking=True):
        return self._c("motor_run", {"direction": direction, "motor": motor, "speed": speed, "blocking": blocking})

    def motor_run_for_time(self, time_ms, direction=MOTOR_MOVE_DIRECTION_CLOCKWISE, motor=DEFAULT_MOTOR, speed=UNCHANGED, blocking=True):
        return self._c("motor_run_for_time", {"time_ms": time_ms, "direction": direction, "motor": motor, "speed": speed, "blocking": blocking})

    def motor_run_for_degrees(self, degrees, direction=MOTOR_MOVE_DIRECTION_CLOCKWISE, motor=DEFAULT_MOTOR, speed=UNCHANGED, blocking=True):
        return self._c("motor_run_for_degrees", {"degrees": degrees, "direction": direction, "motor": motor, "speed": speed, "blocking": blocking})

    def motor_reset_relative_position(self, motor=DEFAULT_MOTOR, position=0, blocking=True):
        return self._c("motor_reset_relative_position", {"motor": motor, "position": position, "blocking": blocking})

    def motor_run_to_relative_position(self, position, motor=DEFAULT_MOTOR, speed=UNCHANGED, blocking=True):
        return self._c("motor_run_to_relative_position", {"position": position, "motor": motor, "speed": speed, "blocking": blocking})

    def motor_run_to_absolute_position(self, position, direction=MOTOR_MOVE_DIRECTION_SHORTEST, motor=DEFAULT_MOTOR, speed=UNCHANGED, blocking=True):
        return self._c("motor_run_to_absolute_position", {"position": position, "direction": direction, "motor": motor, "speed": speed, "blocking": blocking})

    def motor_set_duty_cycle(self, duty_cycle, motor=DEFAULT_MOTOR, blocking=True):
        return self._c("motor_set_duty_cycle", {"duty_cycle": duty_cycle, "motor": motor, "blocking": blocking})

    def motor_stop(self, motor=DEFAULT_MOTOR, blocking=True):
        return self._c("motor_stop", {"motor": motor, "blocking": blocking})

    def motor_set_end_state(self, end_state, motor=DEFAULT_MOTOR, blocking=True):
        return self._c("motor_set_end_state", {"end_state": end_state, "motor": motor, "blocking": blocking})

    def motor_set_acceleration(self, acceleration, deceleration=None, motor=DEFAULT_MOTOR, blocking=True):
        if deceleration is None:
            deceleration = acceleration
        return self._c("motor_set_acceleration", {"acceleration": acceleration, "deceleration": deceleration, "motor": motor, "blocking": blocking})


class SingleMotor(_Device):
    _kind = "SingleMotor"

    def __init__(self):
        _Device.__init__(self)
        self.motor = _MotorTable(self, True)


class DoubleMotor(_Device):
    _kind = "DoubleMotor"

    def __init__(self):
        _Device.__init__(self)
        self.motor = _MotorTable(self, False)
        self.imu_device = _ImuData(self)
        self.imu_gesture = _Gesture(self)

    def movement_move(self, direction=MOVEMENT_DIRECTION_FORWARD, speed=UNCHANGED, blocking=True):
        return self._c("movement_move", {"direction": direction, "speed": speed, "blocking": blocking})

    def movement_move_for_time(self, time_ms, direction=MOVEMENT_DIRECTION_FORWARD, speed=UNCHANGED, blocking=True):
        return self._c("movement_move_for_time", {"time_ms": time_ms, "direction": direction, "speed": speed, "blocking": blocking})

    def movement_move_for_degrees(self, degrees, direction=MOVEMENT_MOVE_DIRECTION_FORWARD, speed=UNCHANGED, blocking=True):
        return self._c("movement_move_for_degrees", {"degrees": degrees, "direction": direction, "speed": speed, "blocking": blocking})

    def movement_move_tank(self, speed_left, speed_right, blocking=True):
        return self._c("movement_move_tank", {"speed_left": speed_left, "speed_right": speed_right, "blocking": blocking})

    def movement_move_tank_for_degrees(self, degrees, speed_left=50, speed_right=50, blocking=True):
        return self._c("movement_move_tank_for_degrees", {"degrees": degrees, "speed_left": speed_left, "speed_right": speed_right, "blocking": blocking})

    def movement_turn_for_degrees(self, degrees, direction=MOVEMENT_TURN_DIRECTION_LEFT, speed=UNCHANGED, blocking=True):
        return self._c("movement_turn_for_degrees", {"degrees": degrees, "direction": direction, "speed": speed, "blocking": blocking})

    def movement_stop(self, blocking=True):
        return self._c("movement_stop", {"blocking": blocking})

    def movement_set_speed(self, speed, blocking=True):
        return self._c("movement_set_speed", {"speed": speed, "blocking": blocking})

    def movement_set_end_state(self, end_state, blocking=True):
        return self._c("movement_set_end_state", {"end_state": end_state, "blocking": blocking})

    def movement_set_acceleration(self, acceleration, deceleration, blocking=True):
        return self._c("movement_set_acceleration", {"acceleration": acceleration, "deceleration": deceleration, "blocking": blocking})

    def movement_set_turn_steering(self, steering, blocking=True):
        return self._c("movement_set_turn_steering", {"steering": steering, "blocking": blocking})

    def imu_set_yaw_face(self, yaw_face, blocking=True):
        return self._c("imu_set_yaw_face", {"yaw_face": yaw_face, "blocking": blocking})

    def imu_reset_yaw_axis(self, value=0, blocking=True):
        return self._c("imu_reset_yaw_axis", {"value": value, "blocking": blocking})


class ColorSensor(_Device):
    _kind = "ColorSensor"

    def __init__(self):
        _Device.__init__(self)
        self.sensor = _ColorData(self)


class Controller(_Device):
    _kind = "Controller"

    def __init__(self):
        _Device.__init__(self)
        self.sensor = _CtrlData(self)
`;

// ---------- мосты Python <-> JS (по одному модулю на команду) ----------
// SIDE — 'red' | 'blue'; null — мост «текущей» команды (обычный `import legoeducation` без переписывания).
// Модуль команды работает только из программы этой же команды: чужая программа (в т.ч. гостя онлайн)
// не может ни читать, ни двигать робота соперника, даже если добыла ссылку на модуль.
const simJs = (side) => `var $builtinmodule = function () {
  var mod = { __name__: new Sk.builtin.str("${side ? `_sim_${side}` : '_sim'}") };
  var H = window.__BIOGLOW_PY__;
  var SIDE = ${side ? `'${side}'` : 'null'};
  var B = function () {
    var c = H.cur;
    if (!c) throw new Sk.builtin.RuntimeError("Нет активной программы");
    if (SIDE && c.side !== SIDE) throw new Sk.builtin.RuntimeError("Модуль другой команды недоступен: программа управляет только своим роботом");
    return H.bridgeFor(SIDE);
  };
  var js = function (o) { return Sk.ffi.remapToJs(o); };
  var str = function (x) { return new Sk.builtin.str(x === undefined || x === null ? "" : String(x)); };
  var num = function (x) { return Sk.ffi.remapToPy(typeof x === "number" ? x : 0); };
  var call = function (f, conv) {
    var r;
    try { r = f(); } catch (e) { throw H.pyError(e); }
    if (r && typeof r.then === "function") return Sk.misceval.promiseToSuspension(r.then(conv));
    return conv(r);
  };
  mod.connect = new Sk.builtin.func(function (kind, nm) { return call(function () { return B().connect(js(kind), js(nm)); }, str); });
  mod.get = new Sk.builtin.func(function (id, key) { return call(function () { return B().get(js(id), js(key)); }, num); });
  mod.now = new Sk.builtin.func(function () { return call(function () { return B().now(); }, function (v) { return new Sk.builtin.float_(v); }); });
  mod.cmd = new Sk.builtin.func(function (id, nm, args) { return call(function () { return B().cmd(js(id), js(nm), js(args)); }, str); });
  return mod;
};`;

// Свой модуль time: sleep() и time() идут по времени симуляции (пауза, ускорение, замок с программой)
const TIME_JS = `var $builtinmodule = function () {
  var mod = { __name__: new Sk.builtin.str("time") };
  var H = window.__BIOGLOW_PY__;
  var B = function () { return H.bridgeFor(null); };
  var call = function (f, conv) {
    var r;
    try { r = f(); } catch (e) { throw H.pyError(e); }
    if (r && typeof r.then === "function") return Sk.misceval.promiseToSuspension(r.then(conv));
    return conv(r);
  };
  var none = function () { return Sk.builtin.none.none$; };
  var sleepS = function (sec) {
    if (typeof sec !== "number" || !isFinite(sec)) throw new Sk.builtin.TypeError("sleep(): нужно число секунд");
    if (sec < 0) throw new Sk.builtin.ValueError("sleep length must be non-negative");
    return call(function () { return B().sleep(sec); }, none);
  };
  var fl = function (v) { return new Sk.builtin.float_(v); };
  // sleep_ms/ticks_ms есть только в MicroPython: на компьютере (CPython + pip legoeducation) их нет
  var mp = function (nm, alt) { try { B().warnOnce("mp:" + nm, "[sim] time." + nm + "() есть только в MicroPython; в CPython (pip install legoeducation) её нет — используйте " + alt + "."); } catch (e) { /* без программы — молча */ } };
  mod.sleep = new Sk.builtin.func(function (s) { return sleepS(Sk.ffi.remapToJs(s)); });
  mod.sleep_ms = new Sk.builtin.func(function (ms) { mp("sleep_ms", "time.sleep(секунды)"); return sleepS(Sk.ffi.remapToJs(ms) / 1000); });
  mod.time = new Sk.builtin.func(function () { return call(function () { return B().now(); }, fl); });
  mod.monotonic = mod.time;
  mod.perf_counter = mod.time;
  mod.ticks_ms = new Sk.builtin.func(function () { mp("ticks_ms", "time.monotonic()"); return call(function () { return B().now(); }, function (v) { return new Sk.builtin.int_(Math.round(v * 1000)); }); });
  mod.time_ns = new Sk.builtin.func(function () { return call(function () { return B().now(); }, function (v) { return new Sk.builtin.int_(Math.round(v * 1e9)); }); });
  return mod;
};`;

const SIDES = ['red', 'blue'];
const leFor = (side) => LE_PY.replace('__SIMMOD__', side ? `_sim_${side}` : '_sim');
const FILES = {
  'src/lib/legoeducation.py': leFor(null),
  'src/lib/_sim.js': simJs(null),
  'src/lib/time.js': TIME_JS,
};
for (const s of SIDES) {
  FILES[`src/lib/legoeducation_${s}.py`] = leFor(s);
  FILES[`src/lib/_sim_${s}.js`] = simJs(s);
}
// Разрешённые модули стандартной библиотеки Skulpt (без доступа к DOM/JS: document, jseval, webgl, urllib…)
const ALLOWED = new Set(['math', 'random', 'string', 'collections', 'itertools', 'functools', 'operator', 'copy', 're',
  'bisect', 'heapq', 'keyword', 'textwrap', 'abc', 'numbers', 'types', '__future__', 'fractions', 'colorsys', 'array',
  'sys', 'copy_reg', '_abcoll', 'UserDict', 'UserList', 'UserString', 'token', 'tokenize', 'this', 'sets']);
/** Имя модуля другой команды ('legoeducation_blue', '_sim_red'…) для текущей программы — запрещено */
const TEAM_MOD = /^(?:legoeducation|_sim)_(red|blue)$/;
function foreignModule(name) {
  const m = TEAM_MOD.exec(String(name).split('.')[0]);
  return !!(m && (!PY.cur || PY.cur.side !== m[1]));
}
function readFile(path) {
  const nf = () => new Error(`File not found: '${path}'`);
  const base = /^src\/(?:lib|builtin)\/([A-Za-z0-9_]+)/.exec(path);
  if (base && foreignModule(base[1])) throw nf();
  if (FILES[path] !== undefined) return FILES[path];
  if (path === 'src/lib/time.py') throw nf();
  const m = /^src\/(?:lib|builtin)\/([A-Za-z0-9_]+)(?:[./]|$)/.exec(path);
  if (m && !ALLOWED.has(m[1])) throw nf();
  if (Sk.builtinFiles && Sk.builtinFiles.files[path] !== undefined) {
    const src = Sk.builtinFiles.files[path];
    // в sys Skulpt нет exit(): добавляем тот же выход, что у встроенного exit();
    // убираем ручки, которыми программа могла бы отключить сторожа (лимиты времени и уступок)
    if (path === 'src/builtin/sys.js') return `${src}\nvar __bioglowSys = $builtinmodule; $builtinmodule = function (n) { var m = __bioglowSys(n); if (!m.exit) m.exit = Sk.builtins.exit; delete m.setExecutionLimit; delete m.getExecutionLimit; delete m.resetTimeout; delete m.setYieldLimit; return m; };`;
    return src;
  }
  throw nf();
}

// ---------- макрозадача без ограничения таймеров (MessageChannel) ----------
const mc = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
const mq = [];
if (mc) mc.port1.onmessage = () => { const f = mq.shift(); if (f) f(); };
/** Выполнить fn отдельной макрозадачей (после всех микрозадач) */
export function macrotask(fn) { if (mc) { mq.push(fn); mc.port2.postMessage(0); } else setTimeout(fn, 0); }
export const nextTask = () => new Promise((r) => macrotask(r));

// ---------- общий «хозяин» Skulpt ----------
const PY = {
  bridges: {},   // side -> Bridge
  cur: null,     // раннер, чей Python исполняется прямо сейчас
  ready: false,
  bridgeFor(side) {
    if (side) return this.bridges[side];
    if (!this.cur) throw new Error('Нет активной программы');
    return this.cur.bridge;
  },
  /** JS-ошибка моста -> исключение Python */
  pyError(e) {
    if (typeof Sk === 'undefined') return e;
    if (e instanceof Sk.builtin.BaseException) return e;
    if (e && e.bioglowStop) return e; // раннер обрывает цепочку сам
    if (e && e.bioglowUser) return new Sk.builtin.RuntimeError(e.message);
    console.error(e);
    return new Sk.builtin.RuntimeError('Ошибка симулятора: ' + (e && e.message ? e.message : String(e)));
  },
};
if (typeof window !== 'undefined') window.__BIOGLOW_PY__ = PY;

// Сторож главного потока: Skulpt работает в потоке страницы, поэтому один «непрерывный» отрезок Python
// (без приостановки — например, цикл внутри key= у sorted() или огромный range в sum()) ограничен.
// Обычные циклы уступают каждые YIELD_MS и сторожа не задевают.
export const YIELD_MS = 12;
export const SLICE_LIMIT_MS = 1000;   // дольше — TimeLimitError: иначе зависли бы поле и кнопка «Стоп»
const MAX_SEQ = 1000000;              // range()/повтор списка: Skulpt создаёт все элементы сразу (~0.2–0.5 с на миллион)
const MAX_STR = 20000000;             // символов в строке-повторе
const MAX_INT_BITS = 1 << 20;         // ~315 000 цифр: больше — OverflowError (иначе счёт на секунды/минуты)

const tooBig = (what) => new Sk.builtin.OverflowError(`${what}: слишком большое значение для симулятора (вкладка зависла бы)`);
const jsNum = (x) => { try { return Number(Sk.ffi.remapToJs(x)); } catch { return NaN; } };
const bitsOf = (v) => (typeof v === 'bigint' ? (v < 0n ? -v : v).toString(16).length * 4 : Math.log2(Math.abs(v) || 1) + 1);

/** Ограничения «дорогих» встроенных операций, которые не уступают управление */
function hardenSkulpt() {
  const R = Sk.builtins.range;
  if (R && R.prototype && !R.prototype.__bioglow) {
    const orig = R.prototype.tp$new;
    R.prototype.tp$new = function (args, kw) {
      const a = (args || []).map(jsNum);
      let start = 0, stop = a[0], step = 1;
      if (a.length >= 2) { start = a[0]; stop = a[1]; }
      if (a.length >= 3) step = a[2];
      const n = step ? Math.ceil((stop - start) / step) : 0;
      if (Number.isFinite(n) ? n > MAX_SEQ : (a.length && a.every((v) => !Number.isNaN(v)))) {
        throw new Sk.builtin.OverflowError(`range() длиной больше ${MAX_SEQ.toLocaleString('ru')} в симуляторе нельзя: Skulpt создаёт все числа сразу. Для «бесконечного» цикла используйте while True:`);
      }
      return orig.call(this, args, kw);
    };
    R.prototype.__bioglow = true;
  }
  // Повтор и склейка последовательностей. Skulpt держит одну функцию под несколькими слотами
  // (sq$repeat = nb$multiply = nb$reflected_multiply = __mul__/__rmul__…), поэтому подменяем все ссылки на неё.
  const lenOf = (o) => {
    try {
      if (o && o.v && typeof o.v.length === 'number') return o.v.length;
      if (o && typeof o.sq$length === 'function') return Number(o.sq$length()) || 0;
    } catch { /* длина неизвестна */ }
    return 0;
  };
  const seqGuard = (T, max, what) => {
    const p = T && T.prototype;
    if (!p || Object.prototype.hasOwnProperty.call(p, '__bioglowSeq')) return;
    p.__bioglowSeq = true;
    const map = new Map();
    const guard = (orig, check) => {
      if (typeof orig !== 'function' || map.has(orig)) return;
      map.set(orig, function (...a) { check(this, a[0]); return orig.apply(this, a); });
    };
    const rep = (self, n) => { const k = Sk.misceval.isIndex(n) ? jsNum(n) : 0; if (k > 1 && lenOf(self) * k > max) throw tooBig(what + ' * n'); };
    const cat = (self, o) => { if (lenOf(self) + (o === self ? lenOf(self) : lenOf(o)) > max) throw tooBig(what + ' + ' + what); };
    for (const k of ['sq$repeat', 'sq$inplace_repeat']) guard(p[k], rep);
    for (const k of ['sq$concat', 'sq$inplace_concat']) guard(p[k], cat);
    for (const k of Object.getOwnPropertyNames(p)) {
      const d = Object.getOwnPropertyDescriptor(p, k);
      const v = d && d.value;
      if (typeof v === 'function' && map.has(v)) p[k] = map.get(v);
      else if (v && typeof v === 'object' && typeof v.d$wrapped === 'function' && map.has(v.d$wrapped)) v.d$wrapped = map.get(v.d$wrapped);
    }
    // list.extend(x): удвоение x.extend(x) в цикле
    const ext = p.extend;
    if (ext && typeof ext.$meth === 'function') {
      const m = ext.$meth;
      setMeth(ext, function (o) { cat(this, o); return m.call(this, o); });
    }
  };
  // метод встроенного типа: и у дескриптора, и в его описании (из него собирается связанный метод)
  function setMeth(ds, f) {
    ds.$meth = f;
    if (ds.d$def && typeof ds.d$def === 'object') ds.d$def.$meth = f;
  }
  seqGuard(Sk.builtin.list, MAX_SEQ, 'список');
  seqGuard(Sk.builtin.tuple, MAX_SEQ, 'кортеж');
  seqGuard(Sk.builtin.str, MAX_STR, 'строка');
  seqGuard(Sk.builtin.bytes, MAX_STR, 'bytes');
  seqGuard(Sk.builtin.bytearray, MAX_STR, 'bytearray');
  // 'x'.ljust(10**9) и т.п.: ширина выравнивания
  const SP = Sk.builtin.str.prototype;
  for (const k of ['ljust', 'rjust', 'center', 'zfill']) {
    const ds = SP[k];
    if (!ds || typeof ds.$meth !== 'function' || ds.$meth.__bioglow) continue;
    const m = ds.$meth;
    const f = function (w, ...rest) { if (Sk.misceval.isIndex(w) && jsNum(w) > MAX_STR) throw tooBig(`str.${k}()`); return m.call(this, w, ...rest); };
    f.__bioglow = true;
    setMeth(ds, f);
  }
  const I = Sk.builtin.int_ && Sk.builtin.int_.prototype;
  if (I && !I.__bioglow) {
    const pow = I.nb$power, shl = I.nb$lshift, mul = I.nb$multiply;
    I.nb$power = function (e, mod) {
      if (e instanceof Sk.builtin.int_ && (mod === undefined || mod === Sk.builtin.none.none$)) {
        const b = this.v, x = e.v;
        const big = typeof x === 'bigint' ? x > 0n : x > 0;
        const absB = typeof b === 'bigint' ? (b < 0n ? -b : b) : Math.abs(b);
        if (big && absB > 1 && bitsOf(b) * Number(x) > MAX_INT_BITS) throw tooBig('степень');
      }
      return pow.call(this, e, mod);
    };
    I.nb$lshift = function (s) {
      if (s instanceof Sk.builtin.int_ && Number(s.v) > MAX_INT_BITS && this.v !== 0 && this.v !== 0n) throw tooBig('сдвиг <<');
      return shl.call(this, s);
    };
    I.nb$multiply = function (o) {
      if (typeof this.v === 'bigint' && o instanceof Sk.builtin.int_ && typeof o.v === 'bigint' && bitsOf(this.v) + bitsOf(o.v) > MAX_INT_BITS) throw tooBig('умножение');
      return mul.call(this, o);
    };
    I.__bioglow = true;
  }
  // import: модули другой команды не видны; __import__() работает как в CPython
  if (!Sk.builtin.__import__.__bioglow) {
    const imp = Sk.builtin.__import__;
    const wrapped = function (name, globals, locals, fromlist, level) {
      if (foreignModule(name)) throw new Sk.builtin.ImportError('модуль другой команды недоступен: программа управляет только роботом своей команды (пишите import legoeducation)');
      return imp.call(this, name, globals || { __package__: Sk.builtin.none.none$ }, locals, fromlist, level);
    };
    wrapped.__bioglow = true;
    Sk.builtin.__import__ = wrapped;
    Sk.builtins.__import__ = new Sk.builtin.func(function (name, globals, locals, fromlist, level) {
      if (!Sk.builtin.checkString(name)) throw new Sk.builtin.TypeError('__import__() argument 1 must be str');
      const fl = fromlist && fromlist !== Sk.builtin.none.none$ ? Sk.ffi.remapToJs(fromlist) : [];
      const lv = level === undefined ? 0 : jsNum(level);
      return Sk.builtin.__import__(name.v, { __package__: Sk.builtin.none.none$ }, {}, Array.isArray(fl) ? fl : [], lv);
    });
  }
}

function setupSkulpt() {
  if (PY.ready) return;
  Sk.configure({
    output: (t) => { const r = PY.cur; if (r) r.out(String(t)); else console.log(String(t)); },
    read: readFile,
    __future__: Sk.python3,
    yieldLimit: YIELD_MS,     // мс счёта Python без приостановки (интерфейс не замирает, «Стоп» работает)
    execLimit: SLICE_LIMIT_MS, // сторож одного непрерывного отрезка (Sk.execStart сбрасывается в _enter)
    // killable*: Skulpt приостанавливал бы КАЖДУЮ итерацию цикла (в 9 раз медленнее) — уступок по yieldLimit хватает
    killableWhile: false,
    killableFor: false,
    inputfunTakesPrompt: true,
    inputfun: () => { throw new Sk.builtin.RuntimeError('input() в симуляторе недоступен: используйте пульт (Controller) или переменные.'); },
  });
  Sk.timeoutMsg = () => `программа считала без пауз дольше ${SLICE_LIMIT_MS / 1000} с (например, огромный range внутри sum()/sorted() или вечный цикл внутри key=). Вкладка зависла бы — прогон прерван.`;
  Sk.breakpoints = () => false;
  const quit = new Sk.builtin.func(function (code) { throw new Sk.builtin.SystemExit(code === undefined ? Sk.builtin.none.none$ : code); });
  Sk.builtins.exit = quit; Sk.builtins.quit = quit;
  for (const k of ['jseval', 'jsmillis', 'open', 'execfile']) delete Sk.builtins[k];
  if (!Sk.sysmodules) Sk.sysmodules = new Sk.builtin.dict([]);
  PY.baseModules = Sk.sysmodules;
  hardenSkulpt();
  PY.ready = true;
}
/** Убрать модуль из sys.modules (в Skulpt 1.2 удаление — mp$ass_subscript(key, undefined)) */
function delModule(name) {
  const d = Sk.sysmodules, k = new Sk.builtin.str(name);
  if (!d || d.quick$lookup(k) === undefined) return;
  if (typeof d.mp$del_subscript === 'function') d.mp$del_subscript(k);
  else d.mp$ass_subscript(k, undefined);
  if (d.quick$lookup(k) !== undefined) throw new Error(`Не удалось выгрузить модуль ${name}`);
}
/** Как Sk.importMainWithBody, но без сброса sys.modules: программа другой команды может работать */
function importMain(fname, body) {
  if (!Sk.sysmodules) Sk.sysmodules = new Sk.builtin.dict([]);
  Sk.dateSet = false;
  delModule('__main__');
  return Sk.importModuleInternal_(fname, false, '__main__', body, undefined, false, true);
}

/**
 * Переписать импорт legoeducation на модуль команды, не меняя число строк:
 * `import legoeducation as le` -> `import legoeducation_red as le`, `from legoeducation import *` -> `from legoeducation_red import *`.
 */
export function rewriteImports(code, side) {
  const mod = `legoeducation_${side}`;
  const lines = String(code).replace(/\r\n?/g, '\n').split('\n');
  let tq = null; // открытая тройная кавычка
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!tq) {
      let m;
      if ((m = /^(\s*)import(\s+)(.*)$/.exec(ln))) {
        let body = m[3], tail = '';
        const cut = body.search(/[;#]/);
        if (cut >= 0) { tail = body.slice(cut); body = body.slice(0, cut); }
        const items = body.split(',').map((it) => {
          const mm = /^(\s*)legoeducation(?:\s+as\s+([A-Za-z_]\w*))?(\s*)$/.exec(it);
          return mm ? `${mm[1]}${mod} as ${mm[2] || 'legoeducation'}${mm[3]}` : it;
        });
        lines[i] = `${m[1]}import${m[2]}${items.join(',')}${tail}`;
      } else if ((m = /^(\s*)from\s+legoeducation(\s+import\b.*)$/.exec(ln))) {
        lines[i] = `${m[1]}from ${mod}${m[2]}`;
      }
    }
    // грубо отслеживаем многострочные строки """…""" / '''…'''
    const re = /"""|'''/g;
    let t;
    while ((t = re.exec(ln))) { if (!tq) tq = t[0]; else if (tq === t[0]) tq = null; }
  }
  return lines.join('\n');
}

const MAIN = { red: '<main_red>', blue: '<main_blue>' };
const isStop = (e) => !!(e && (e.bioglowStop || (e.nativeError && e.nativeError.bioglowStop)));
let SEQ = 0;

/** Раннер программы одной команды. Программы двух команд работают одновременно. */
export class PythonRunner {
  /**
   * @param side 'red' | 'blue'
   * @param bridge Bridge этой команды
   * @param hooks { out(text, cls), onState(state, info) } — state: running | done | stopped | error
   */
  constructor(side, bridge, { out = () => {}, onState = () => {} } = {}) {
    this.side = side;
    this.bridge = bridge;
    this.out = out;
    this.onState = onState;
    this.cur = null;       // текущий прогон { id, stopped, done }
    this.ticket = 0;
    this.state = 'idle';
    this.since = 0;        // для главного цикла: с какого момента программа считает без ожиданий
    this.lastId = 0;
    PY.bridges[side] = bridge;
    bridge.say = (t, c) => this.out(t, c);
  }

  get available() { return typeof window.Sk !== 'undefined' && !!window.Sk.misceval; }
  get running() { return !!this.cur; }
  /** Программа сейчас считает (не ждёт событий симуляции) — главный цикл ждёт её перед шагом */
  get runnable() { return !!this.cur && !this.cur.stopped && !this.bridge.blocked; }
  get runId() { return this.cur ? this.cur.id : 0; }

  setState(st, info) { this.state = st; try { this.onState(st, info || {}); } catch (e) { console.error(e); } }

  /**
   * Запустить программу (предыдущая этой команды сначала останавливается). -> Promise итога прогона.
   * Если ничего не работает, Python стартует синхронно, внутри вызова (детерминированный момент старта).
   */
  run(code) {
    const ticket = ++this.ticket;
    if (this.cur) {
      this.cur.quiet = true; // перезапуск: старый прогон молча уступает место новому
      return this._halt().then(() => (ticket === this.ticket ? this._start(code) : 'superseded'));
    }
    return this._start(code);
  }
  async _start(code) {
    if (!this.available) {
      this.out('Python (Skulpt) не загрузился — проверьте доступ к cdn.jsdelivr.net.\n', 'err');
      this.setState('error', {});
      return 'error';
    }
    setupSkulpt();
    const id = ++SEQ;
    // свой sys.modules на каждый прогон: модули (time, math, legoeducation, __main__…) у команд не общие —
    // программа не может подменить функции чужой программы или добраться до её переменных
    const run = { id, stopped: false, done: null, modules: new Sk.builtin.dict([]) };
    let finish;
    run.done = new Promise((r) => { finish = r; });
    this.cur = run; this.lastId = id; this.since = 0;
    this.bridge.begin(id);
    this.setState('running', { runId: id });
    const fname = MAIN[this.side];
    const body = rewriteImports(code, this.side);
    let status = 'done', info = {};
    try {
      await Sk.misceval.asyncToPromise(
        () => this._enter(() => importMain(fname, body)),
        { '*': (s) => this._handle(run, s) },
      );
      if (run.stopped) { status = 'stopped'; if (!run.quiet) this.out('\n■ Остановлено\n', 'warn'); }
      else this.out('\n✔ Программа завершена\n', 'ok');
    } catch (e) {
      if (run.stopped || isStop(e)) { status = 'stopped'; if (!run.quiet) this.out('\n■ Остановлено\n', 'warn'); }
      else if (e instanceof Sk.builtin.SystemExit) {
        const c = exitCode(e);
        if (c === 0) this.out('\n✔ exit()\n', 'ok');
        else {
          status = 'error';
          info = formatError(e, fname);
          this.out(`\n✖ Программа завершилась с кодом ${typeof c === 'string' ? JSON.stringify(c) : c}${info.line ? ` (строка ${info.line})` : ''}\n`, 'err');
        }
      } else {
        status = 'error';
        info = formatError(e, fname);
        this.out('\n✖ ' + info.text + '\n', 'err');
      }
    } finally {
      this.bridge.end(id);
      if (this.cur === run) this.cur = null;
      this.since = 0;
      this.setState(status, { ...info, runId: id });
      finish(status);
    }
    return status;
  }

  /** Остановить программу. -> Promise, который выполняется, когда прогон действительно завершился */
  stop() { this.ticket++; return this._halt(); }
  _halt() {
    const run = this.cur;
    if (!run) return Promise.resolve('idle');
    if (!run.stopped) { run.stopped = true; this.bridge.abort(run.id); }
    return run.done;
  }

  /** Выполнить Python-код как «текущий» раннер (print/time идут сюда, sys.modules — этого прогона) */
  _enter(fn) {
    const prev = PY.cur, prevMods = Sk.sysmodules, run = this.cur;
    PY.cur = this;
    if (run && run.modules) Sk.sysmodules = run.modules;
    Sk.execStart = Date.now(); // сторож считает только непрерывный отрезок
    try { return fn(); } finally { PY.cur = prev; Sk.sysmodules = prevMods; }
  }
  /** Обработчик приостановок Skulpt: ждём и продолжаем сами, остановленный прогон не продолжаем */
  _handle(run, susp) {
    return new Promise((resolve, reject) => {
      const go = () => {
        if (run.stopped) { reject(new StopSignal()); return; }
        try { resolve(this._enter(() => susp.resume())); } catch (e) { reject(e); }
      };
      const t = susp.data && susp.data.type;
      if (t === 'Sk.promise') {
        susp.data.promise.then(
          (v) => { susp.data.result = v; go(); },
          (e) => { if (isStop(e)) { run.stopped = true; } susp.data.error = PY.pyError(e); go(); },
        );
      } else if (t === 'Sk.yield') macrotask(go);
      else if (t === 'Sk.delay') {
        // «точка остановки» цикла: уступаем, только если давно не уступали (иначе цикл в разы медленнее)
        if (run.stopped || Date.now() - (Sk.lastYield || 0) > YIELD_MS) { Sk.lastYield = Date.now(); macrotask(go); } else go();
      } else if (susp.optional) go();
      else reject(new Sk.builtin.SuspensionError(`Unhandled non-optional suspension of type '${t}'`));
    });
  }
}

function exitCode(e) {
  try {
    const a = e.args && e.args.v && e.args.v[0];
    if (a === undefined || a === Sk.builtin.none.none$) return 0;
    const v = Sk.ffi.remapToJs(a);
    if (v === null || v === undefined || v === 0 || v === false) return 0;
    return v;
  } catch { return 1; }
}

const RU = {
  NameError: 'NameError (имя не найдено)', SyntaxError: 'SyntaxError (ошибка синтаксиса)',
  AttributeError: 'AttributeError (нет такого атрибута)', TypeError: 'TypeError (неверный тип)',
  IndentationError: 'IndentationError (ошибка отступа)', ZeroDivisionError: 'ZeroDivisionError (деление на ноль)',
  IndexError: 'IndexError (индекс вне списка)', ValueError: 'ValueError (неверное значение)',
  ImportError: 'ImportError (модуль не найден)', KeyError: 'KeyError (нет такого ключа)',
  TimeLimitError: 'TimeLimitError (слишком долгий счёт без пауз)', OverflowError: 'OverflowError (слишком большое значение)',
};
/** Текст ошибки и строка в файле программы (кадр <main_side>.py, а не внутри legoeducation — review M9) */
export function formatError(e, fname) {
  let s;
  try { s = e.toString(); } catch { s = String(e); }
  let line = null;
  const tb = e && e.traceback;
  if (Array.isArray(tb)) {
    const fr = tb.find((f) => f && f.filename === fname + '.py' && f.lineno);
    if (fr) line = fr.lineno;
  }
  if (!line && e && e.$lineno && (!tb || !tb.length)) line = e.$lineno;
  s = s.replace(/ on line \d+$/, '').replace(/legoeducation_(red|blue)/g, 'legoeducation').replace(/<main_(red|blue)>/g, 'программа');
  const head = /^(\w+)/.exec(s);
  if (head && RU[head[1]]) s = RU[head[1]] + s.slice(head[1].length);
  if (/^ExternalError/.test(s)) s = s.replace(/^ExternalError:?\s*/, 'Ошибка симулятора: ');
  if (line) s += ` (строка ${line})`;
  return { text: s, line };
}

// ------------------------------ Примеры ------------------------------
export const EXAMPLES = [
  {
    id: 'square', name: 'Квадрат (официальный пример)', code: `import legoeducation as le

# На реальном роботе: цвет и номер с вашей Connection Card
card_color = le.LEGO_COLOR_AZURE
card_serial = '3683'

doublemotor = le.DoubleMotor()
doublemotor.connect(card_color=card_color, card_serial=card_serial)
if not doublemotor.connected:
    print('Error connecting to hardware.')
    exit(1)

RIGHT = le.MOVEMENT_TURN_DIRECTION_RIGHT
LEFT = le.MOVEMENT_TURN_DIRECTION_LEFT

# Зона Technician огорожена слева и снизу и открыта только к центру поля,
# а робот с ковшом длинный (~22 см). Поэтому сначала выезжаем на свободное место:
# 45 см вперёд, направо, 26 см вперёд, налево.
doublemotor.movement_move_for_degrees(920, speed=50)
doublemotor.movement_turn_for_degrees(90, direction=RIGHT)
doublemotor.movement_move_for_degrees(530, speed=50)
doublemotor.movement_turn_for_degrees(90, direction=LEFT)

# Квадрат: 4 раза «вперёд 1 с» и поворот на 90°.
# В официальном примере поворот влево; здесь вправо — там больше места.
for i in range(4):
    doublemotor.movement_move_for_time(1000, speed=30)
    doublemotor.movement_turn_for_degrees(90, direction=RIGHT)

doublemotor.movement_stop()
doublemotor.disconnect()
`,
  },
  {
    id: 'haven', name: 'Миссия: к Central Haven (робот с ковшом)', code: `import legoeducation as le
import time

# Маршрут и углы руки подобраны для робота «Базовый: ковш» (вкладка «Миссии» -> «Готовый робот»).
# С захватом, молотом или другим навесным робот проедет тот же путь, но фишку не довезёт:
# для них поменяйте шаги 2–3 под своё навесное.

robot = le.DoubleMotor()
robot.connect()
arm = le.SingleMotor()
arm.connect()

CM = 360 / 17.6   # градусов колеса на 1 см (колесо 5.6 см)

def forward(cm, speed=50):
    robot.movement_move_for_degrees(int(abs(cm) * CM), speed=speed,
        direction=le.MOVEMENT_MOVE_DIRECTION_FORWARD if cm > 0 else le.MOVEMENT_MOVE_DIRECTION_BACKWARD)

RIGHT = le.MOVEMENT_TURN_DIRECTION_RIGHT
LEFT = le.MOVEMENT_TURN_DIRECTION_LEFT

robot.imu_reset_yaw_axis(0)

# 1) выезжаем из зоны Technician (она открыта только вправо, к центру)
forward(47)
robot.movement_turn_for_degrees(90, direction=RIGHT, speed=30)
forward(15.3)
robot.movement_turn_for_degrees(90, direction=RIGHT, speed=30)

# 2) ковш внизу — медленно «зачерпываем» кучку 9a (1 вид + 2 ресурса).
# Сначала чуть назад: робот успевает разогнаться до кучки (при разгоне нос приподнимается,
# и кромка ковша толкала бы фишки вместо того, чтобы подойти под них)
forward(-5, speed=20)
forward(16, speed=15)
arm.motor_run_to_relative_position(90, speed=40)   # рука +30° (передача 1:3)

# 3) везём к Central Haven и высыпаем (рука ~110°)
robot.movement_turn_for_degrees(112, direction=LEFT, speed=25)
forward(19.4, speed=30)
arm.motor_run_to_relative_position(330, speed=30)
time.sleep(1)
arm.motor_run_to_relative_position(90, speed=40)
forward(-12)
print('yaw =', robot.imu_device.yaw, '— проверьте M05 во вкладке «Миссии»')
`,
  },
  {
    id: 'controller', name: 'Пульт: танковое управление', code: `import legoeducation as le
import time

doublemotor = le.DoubleMotor()
doublemotor.connect()
controller = le.Controller()
controller.connect()

if not (doublemotor.connected and controller.connected):
    print('Error connecting to hardware.')
    exit(1)

# Пульт Driver на клавиатуре (пока программа работает): W/S — левый рычаг, ↑/↓ — правый.
# Геймпад команды тоже работает как пульт.
print('30 секунд: рычаги управляют моторами')
for i in range(300):
    speed_left = controller.sensor.leftPercent
    speed_right = controller.sensor.rightPercent
    doublemotor.movement_move_tank(speed_left, speed_right)
    time.sleep(0.1)

doublemotor.movement_stop()
`,
  },
  {
    id: 'color', name: 'Датчик цвета: до реки', code: `import legoeducation as le
import time

robot = le.DoubleMotor()
robot.connect()
sensor = le.ColorSensor()
sensor.connect()

robot.movement_move(speed=35)
while True:
    c = sensor.sensor.color
    if c == le.LEGO_COLOR_AZURE or c == le.LEGO_COLOR_BLUE or c == le.LEGO_COLOR_WHITE:
        break
    time.sleep(0.02)
robot.movement_stop()
robot.light_color(le.LEGO_COLOR_BLUE)
robot.beep(count=2)
print('Нашёл воду! отражение =', sensor.sensor.reflection, 'hue =', sensor.sensor.hue)
`,
  },
  {
    id: 'tree', name: 'Specialist: мотор Grand Tree', code: `import legoeducation as le
import time

# Второй Double Motor — встроенный в Grand Tree (device_name='tree')
tree = le.DoubleMotor()
tree.connect(device_name='tree')

# Крутим дерево 6 секунд: ресурсы из лотка base поднимаются в canopy chamber
tree.motor_run_for_time(6000, motor=le.MOTOR_BOTH, speed=100)
print('готово')
`,
  },
  {
    id: 'specialist', name: 'Specialist: пульт крутит дерево', code: `import legoeducation as le
import time

# Пульт Specialist (device_name='specialist') управляет мотором Grand Tree.
# Клавиатура, пока программа работает: R/F — левый рычаг, T/G — правый.
tree = le.DoubleMotor()
tree.connect(device_name='tree')
pad = le.Controller()
pad.connect(device_name='specialist')

print('20 секунд: левый рычаг Specialist крутит дерево')
for i in range(200):
    s = pad.sensor.leftPercent
    if abs(s) > 5:
        tree.movement_move_tank(s, s)
    else:
        tree.movement_stop()
    time.sleep(0.1)
tree.movement_stop()
`,
  },
  {
    id: 'gyro', name: 'Точный поворот по гироскопу', code: `import legoeducation as le
import time

robot = le.DoubleMotor()
robot.connect()
robot.imu_reset_yaw_axis(0)

# выезжаем из зоны Technician (она огорожена), чтобы ковш не задел барьер при повороте
robot.movement_move_for_degrees(960, speed=50)

# поворот направо на 90° «вручную» по гироскопу, с замедлением у цели
target = -90
while True:
    err = target - robot.imu_device.yaw
    if abs(err) < 1:
        break
    s = max(8, min(40, int(abs(err))))
    if err > 0:
        robot.movement_move_tank(-s, s)
    else:
        robot.movement_move_tank(s, -s)
    time.sleep(0.01)
robot.movement_stop()
print('yaw =', robot.imu_device.yaw)
`,
  },
];
