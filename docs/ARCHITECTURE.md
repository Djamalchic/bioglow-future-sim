# BIOGLOW Future Sim — архитектура v2

Неофициальный тренажёр FIRST LEGO League **BIOGLOW (2026-27) Future Edition**: общее поле 2362×1143 мм,
красная и синяя команды, миссии M01–M05 + Level Up «Invasive Attack», матч 2:30, железо LEGO Education
Computer Science & AI (Double Motor, Single Motor, Color Sensor, Controller), Python API `legoeducation`.

Язык интерфейса — русский. Комментарии в коде — русские, короткие.

## Цели v2

1. **Правдоподобная физика** на Rapier (`@dimforge/rapier3d-compat@0.21.0`, ES-модуль
   `https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.21.0/dist/rapier.mjs`, `await RAPIER.init()`).
   Колёса — динамические тела на revolute-шарнирах с моторами (ForceBased, ограничение момента),
   резина/коврик с трением, шаровая опора с малым трением, навесное оборудование — отдельные тела,
   которые по-настоящему поднимают фишки (контакт + трение, без «телепортов» фишек).
2. **Две команды одновременно**: у каждой свой робот (своя конфигурация), своя Python-программа,
   свой пульт/джойстик; локально (hot-seat) и онлайн.
3. **Конструктор робота** (параметрический, по правилам железа Future Edition).
4. **Правила по Rulebook**: штрафы, Gracious Professionalism, Courtesy rule, роли и «руки»,
   проверка (inspection) перед матчем, фиксация счёта по окончании матча, история матчей со средним.
5. **Онлайн**: комната по коду, хост-авторитетная симуляция, Python-сервер на стандартной библиотеке
   (статика + WebSocket) для Render.
6. **Джойстик** (Gamepad API) и раскладко-независимая клавиатура (`KeyboardEvent.code`).

## Справочные материалы (только чтение)

- Официальные тексты: `<PAD>/pdf/missions/missions.txt`, `rules/rules.txt`, `map/map.txt`, `updates/updates.txt`,
  картинки страниц `<PAD>/pdf/**.png`, фото полей `<PAD>/pdf/mapimgs/`, сетка в мм `<PAD>/pdf/grid-p02.png`.
- Результаты аудита: `<PAD>/audit/rules.md` (правила и расстановка), `review.md` (баги кода),
  `tech.md` (Rapier API, Gamepad, Render, RFC 6455), `example.md` (сайт-пример Founders Edition;
  его распакованный код — `<PAD>/ref-site/`).
- `<PAD>` = `C:\Users\nural\AppData\Local\Temp\claude\6fb1749534cad175\872094cb-90c5-47c7-beee-4b00f2e7dd7b\scratchpad`

## Структура проекта

```
fll-future-sim/
  server.py            # stdlib asyncio: статика из public/ + WebSocket /ws (комнаты), порт $PORT
  render.yaml          # Render Blueprint (web service, python); в корне репозитория или с rootDir
  Dockerfile           # опционально
  README.md
  docs/ARCHITECTURE.md
  public/
    index.html
    css/app.css, css/builder.css, css/online.css, css/referee.css
    js/
      layout.js        # раскладка поля (мм), фишки, зоны, константы правил
      mat.js           # коврик (canvas) + выборка цвета (Uint8Array, без DOM в выборке)
      lego.js          # визуальные детали three.js
      physics.js       # обёртка Rapier: мир, группы столкновений, материалы, хелперы коллайдеров
      models.js        # миссионные модели: визуал + тела/коллайдеры + механика
      motors.js        # модель мотора LEGO (профиль скорости, регулятор, кривая момент-скорость, заклинивание)
      robot.js         # робот из конфигурации (RobotConfig), колёса/шарниры/навесное, датчики, IMU
      robotConfig.js   # схема конфигурации, пресеты, валидация по правилам железа и inspection
      sim.js           # Sim: мир, поле, модели, фишки, механика миссий, очки, состояние/снимки
      view.js          # (опционально) рендер three.js, камеры
      bridge.js        # мост Python <-> симулятор (по одному на команду)
      python.js        # Skulpt + эмуляция legoeducation, раннер на команду
      input.js         # клавиатура (code) + Gamepad API + роли -> TeamInput
      referee.js       # штрафы, GP, Courtesy, история матчей, руки/роли
      builder.js       # UI конструктора робота
      net.js           # онлайн-клиент (хост/гость)
      main.js          # App: склейка модулей, главный цикл, UI вкладок
```

## Единицы и системы координат

- Мир: **сантиметры**, гравитация −981 см/с², масса в кг. Момент в кг·см²/с² (1 Н·см = 100 ед.).
- Карта: мм, x вправо от красного борта, y вниз от дальнего борта; синяя половина = поворот на 180°.
  `toWorld(xmm, ymm, side)` / `toMap(x, z, side)` в `layout.js`.
- Робот: вперёд = +X, вверх = +Y, правый бок = +Z. Yaw (IMU) растёт при повороте влево (CCW сверху).

## Контракты модулей

### RobotConfig (robotConfig.js)

```js
{
  version: 1,
  name: 'Базовый (Driver + Technician)',
  wheels: { size: '56x14', track: 7.4, x: 0.6 },   // size из WHEELS: '44x?'... ; track — между центрами колёс, см
  chassis: { extraLength: 0, extraWidth: 0, color: 'white' }, // рама вокруг Double Motor (корпус фиксированный)
  caster: { type: 'ball', x: -3.0 },                // 'ball' | 'skid'
  ballast: 0,                                        // г
  sensor: { enabled: true, x: 4.3, z: 0 },           // Color Sensor (Technician tool), смотрит вниз
  attachment: { type: 'scoop', ratio: 3, length: 8, mount: 'front' }, // 'scoop'|'claw'|'hammer'|'plow'|'none'
  teamColor: 'auto'
}
```
- `validateConfig(cfg)` -> `{ ok, errors[], warnings[], bbox:{lengthCm,widthCm,heightCm}, massKg }`.
  Ошибки по правилам: на робота можно поставить ровно 1 Double Motor (ходовая), не больше 1 Single Motor
  и 1 Color Sensor (Technician tool) — остальное железо стоит на поле (Grand Tree / Young Forest / Hive);
  высота ≤ 20.3 см; габарит должен помещаться в зону Technician (419×227 мм) в каком-то повороте.
- `PRESETS` — минимум 3 готовых робота.

### Sim (sim.js) — создаётся асинхронно

```js
const sim = await Sim.create(container, { configs: { red, blue } });
sim.time                      // с, время симуляции
sim.step(dt)                  // фиксированный шаг (DT экспортируется), детерминирован при одинаковом вводе
sim.resetField({ invasives: {red:[spotIds], blue:[...]}, keepRobots: false })
sim.robots.red / .blue        // Robot
sim.treeMotors.red / .blue    // [Motor, Motor] — Double Motor Grand Tree
sim.setRobotConfig(side, cfg) // пересобрать робота (только вне матча или когда робот целиком в зоне Technician)
sim.score(side)               // { missions, penalty, total, rows:[{id,pts,detail}], provisional:boolean }
sim.latchScore()              // по окончании матча: заморозить «официальный» счёт
sim.recycle(side)             // Specialist: фишки из своей зоны -> Token Recycler (только покоящиеся)
sim.courtesyReturn(side)      // Courtesy rule: робот -> зона Technician, перевозимые фишки снимаются
sim.inspect(side)             // { ok, issues[] } — робот целиком в зоне Technician и ≤ 20.3 см
sim.removeFromPlay(item)      // «отдать судье»
sim.handle(side, role, token) // можно ли игроку взять фишку рукой (правила зон)
sim.getState()                // компактный сериализуемый снимок (для онлайна)
sim.applyState(s)             // применить снимок у гостя (без шага физики)
sim.on('event'|'reset'|'robot', fn)
sim.colorAt(worldPos) / colorReading(rgb)
```

### Robot (robot.js)

Сохраняет нынешний API, на который опирается мост: `left`, `right`, `arm` (Motor), `move`, `moveTank`,
`moveForTime`, `moveForDegrees`, `moveTankForDegrees`, `turnForDegrees`, `stopMove`, `cancelTurn`,
`moving`, `steering`, `moveSpeed`, `imuYaw`, `yawCont/yawZero/yawResetVal`, `setLed`, `sensorWorld()`
(по позиции **физического тела**, не визуала), `setPose(x,z,yaw)`, `resetPose()`, `forward`, `yawWorld`.
Плюс: `config`, `bodies[]`, `colliderHandles` (для проверки «касается оборудования»), `group` (three.js).

### Motor (motors.js)

API как сейчас (`run`, `runForTime`, `runForDegrees`, `runToPos`, `duty`, `stop`, `_set`, `pos`, `relPos`,
`absPos`, `actual`, `power`, `state`, `busy`, `defaultSpeed`, `accelPct`, `decelPct`, `endState`).
Новое: трапециевидный профиль, ПИ-регулятор скорости, выход — целевая угловая скорость шарнира и
предел момента по кривой момент-скорость (stall ≈ 18–25 Н·см, холостой ход ≈ 1000–1100 °/с, параметры
в `SIM`), заклинивание: |факт| < max(20 °/с, 0.15·|цель|) дольше 0.3 с → STALLED и завершение команды.
Энкодер — интеграл относительной угловой скорости колеса/руки относительно корпуса.

### Bridge / Python (bridge.js, python.js)

- По одному `Bridge` и `PythonRunner` **на команду**; программы красных и синих выполняются одновременно.
- Модуль `legoeducation` подключается к мосту своей команды (переписывание импорта на
  `legoeducation_red` / `legoeducation_blue` без сдвига номеров строк, либо иной способ).
- Лимиты железа в `connect()`: DoubleMotor #1 = ходовая, DoubleMotor с `device_name='tree'` = Grand Tree,
  SingleMotor ×1, ColorSensor ×1, Controller ×2 (`device_name='driver'|'specialist'`, по умолчанию driver).
  Сверх лимита — понятная ошибка «по правилам Future Edition …».
- Шаг в «замке» с программой: главный цикл после каждого разрешённого ожидания (sleep/команда)
  отдаёт управление Python (макрозадача) прежде чем делать следующий шаг — результат не зависит от FPS.
- У каждого запуска свой `runId`; остановка/перезапуск без гонок (см. review.md H6).

### Ввод (input.js)

`TeamInput` на команду: `{ drive: {fwd, turn}, arm, tree, recycle, levers: {driver:[L,R], specialist:[L,R]}, slow }`.
Источники: клавиатура (`e.code`, раскладка не важна), до 4 геймпадов (назначение «геймпад → команда/роль»),
сеть (вход гостя). Без программы — ручное управление ходовой (роль Driver), рукой (Technician, только
прямой ввод мотора), деревом (Specialist). С программой — стики/клавиши становятся рычагами Controller.

### Онлайн (net.js + server.py)

- Сервер: `GET /` статика из `public/`, `GET /ws` WebSocket. Комнаты по 4-символьному коду.
  Роли: `host`, `red`, `blue`, `spectator`. Сервер только пересылает сообщения (JSON), шлёт ping,
  удаляет пустые комнаты. `GET /healthz` → `ok`. Полный протокол — в шапке `server.py`.
- Хост считает физику и раз в 50 мс рассылает `sim.getState()` + счёт + таймер + консоль.
  Гость присылает свой `TeamInput` (20 Гц) и код программы (`run`/`stop`); хост выполняет программу гостя
  в раннере его команды и пересылает вывод консоли.
- Клиент: `wss://` на HTTPS, переподключение, индикатор задержки.
- `app.net` (net.js): `host({side,name})`, `join(code, role, name)` → Promise welcome; `leave()`;
  `send(d, {to, lossy})` — свои сообщения модулей (у хоста приходят событием `netMessage(d, from, id)`;
  зритель может слать хосту только `hello | ping | needcfg`); `requestRobot(cfg)` — гость своей команды
  просит хоста пересобрать робота; поля `state`, `mode`, `role`, `room`, `peers`, `stats`, `isHost`, `isGuest`,
  `online`; событие app `net` при смене состояния. Экспорт: `normalizeCode`, `wsUrlFor`, `blendState`,
  `sanitizeGuestConfig`.
- Надёжность и защита:
  - `lossy` — сервер заменяет ещё не отправленный кадр только кадром того же отправителя с тем же `d.k`
    (ввод красных не вытесняет ввод синих).
  - Пачка событий хоста ≤ 64 КБ; вывод `print` гостям ≤ 16 000 символов/с на команду (лишнее — строка
    «пропущено N»); строки раннера (запуск, итог, ошибка) идут всегда.
  - Хост вернулся (обрыв, перезагрузка вкладки) — шлёт гостям полный `init`; `stop` для уже не идущей
    программы отвечает гостю её настоящим состоянием.
  - Закрытие 4001 — место заняла другая вкладка с тем же токеном: клиент не переподключается.
  - Робот гостя проверяется по пределам конструктора (`sanitizeGuestConfig`) и `validateConfig`,
    в `localStorage` хоста не сохраняется; после комнаты хосту возвращается его робот (вне матча).
  - Сервер: адрес клиента — адрес TCP-соединения или (при `TRUST_PROXY=N`) N-й справа в `X-Forwarded-For`
    (на Render — 2: Cloudflare + прокси Render); лимиты на адрес (соединения, комнаты, неудачные входы по коду), бюджеты «гость → хост» по ролям,
    при очереди хоста > 1 МБ сообщения гостей не принимаются (`host-busy`), ≤ 1024 фрагментов в сообщении,
    5 с на ответный close, тело у GET/HEAD дочитывается (или 400/413), комната без гостей закрывается
    через `WS_ROOM_IDLE`, код комнаты после `host-lost` 2 мин отдаётся только прежнему хосту.

### Судья и правила (referee.js)

Штрафы за вмешательство: 1-й −10, 2-й ещё −20, 3-й — счёт матча 0 (не ниже 0). Discretionary (Update 01).
GP-оценка (не входит в очки). Courtesy rule (кнопка). Руки: игрок двигает только фишки целиком в своей
зоне; retrieval zone; корни (mangrove roots) только инструментом. Конец матча: стоп программ и моторов,
досчёт механизмов, 2 с на «успокоение», затем `latchScore()` и блокировка ввода. История матчей и среднее.

## Правила кода

- Чистые ES-модули, без сборщика. Версии CDN зафиксированы. three@0.170.0, Rapier 0.21.0, Skulpt 1.2.0,
  CodeMirror 5.65.16.
- Никакого `Math.random` в симуляции — сидированный ГПСЧ (детерминизм для онлайна).
- Ни одна ошибка в кадре не должна останавливать цикл (try/catch + баннер ошибки).
- Интерфейс: тёмная и светлая темы через токены в `css/app.css`; новые панели — в своих css-файлах.

## Физика: добавления последнего прохода

- `Motor.limits` - механические упоры руки в градусах мотора (выставляет Robot); цель удержания за упором обрезается, интеграл, давящий в упор, затухает за `SIM.limitBleed` (0.3 с).
- `PHYS.contactHz` = 120 - жёсткость контактов Rapier; `ROBOT_ITERS` (robot.js) - доп. итерации решателя для тел робота (опция `iters` в physics.js).
- Каждый "Сброс поля" после первого пересобирает мир Rapier. Модули должны перечитывать `sim.phys`, `sim.world`, `robot.bodies` либо пользоваться `sim.addBodies` и событием `'world'` (referee.js и main.js уже так делают).
- Судейство M05: жетоны в опущенном ковше внутри убежища считаются (по официальному тексту); для M01 по-прежнему нужны свободные жетоны.
- `setRobotConfig(side, cfg, {persist:false})` не пишет конфиг в localStorage (используется net.js для робота гостя).
