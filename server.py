#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""BIOGLOW Future Sim — сервер: статика из ./public + WebSocket /ws (онлайн-комнаты).

Только стандартная библиотека Python 3.11+ (asyncio). Запуск:  python server.py
Переменные окружения: PORT (8080), HOST (0.0.0.0), PUBLIC_DIR, LOG_LEVEL (debug|info|warn|error),
WS_PING_INTERVAL (20 с), WS_GRACE (20 с — сколько держим место отвалившегося участника), WS_MAX_MESSAGE (1 МиБ),
TRUST_PROXY (0 — адрес клиента = адрес TCP-соединения; N — за N своими прокси: берём N-й адрес справа
в X-Forwarded-For; на Render — 2: Cloudflare + прокси Render), WS_MAX_CONNECTIONS (1000), WS_MAX_PER_IP (32), WS_ROOMS_PER_IP (12),
WS_ROOM_IDLE (1800 с — комнату без гостей дольше закрываем).

HTTP:  GET/HEAD статика (MIME, ETag/Last-Modified, gzip для текста, защита от выхода за корень),
       GET /healthz -> 200 ok,  GET /stats -> JSON-счётчики,  GET /ws -> WebSocket (RFC 6455).
       Тело у GET/HEAD не ждём: Content-Length до 64 КБ читаем и выбрасываем, Transfer-Encoding — 400.

Протокол /ws — JSON-тексты {"t": тип, ...}.
  Клиент -> сервер:
    create {side?: red|blue|null, name?, room?, token?}  создать комнату (роль host); room — желаемый код
                                                  (после рестарта); код комнаты, закрытой по host-lost, 2 мин
                                                  отдаётся только прежнему хосту (token)
    join   {room, role: red|blue|spectator, name?} войти гостем (неудачные входы с адреса ограничены)
    resume {room, token}                          вернуться на своё место после обрыва (в течение WS_GRACE);
                                                  прежнее соединение с этим местом закрывается кодом 4001
    side   {side: red|blue|null}                  хост меняет свою команду
    leave  {}                                     выйти (хост — закрыть комнату)
    ping   {c}                                    -> pong {c, s}
    m      {to?, lossy?, d}                       переслать d: хост -> to (guests|all|red|blue|spectator|id),
                                                  гость -> только хосту; lossy — можно заменить более свежим
                                                  от того же отправителя с тем же d.k. Зритель шлёт хосту
                                                  только d.k = hello|ping|needcfg (до 2 КБ).
  Сервер -> клиент:
    hello {v, maxMessage, ping}; welcome {room, role, id, token, name, hostSide, peers, resumed, grace};
    peers {list:[{id, role, name, on}], hostSide, ev}; m {from: роль, id, d}; pong {c, s};
    closed {room, reason: host-left|host-lost|idle}; left {}; error {code, msg, re}
  Коды закрытия: 1008 — злоупотребление, 1009 — слишком большое сообщение, 4001 — место заняла другая вкладка.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import email.utils
import gzip
import hashlib
import html
import ipaddress
import itertools
import json
import re
import os
import secrets
import signal
import struct
import sys
import time
from collections import deque
from urllib.parse import quote, unquote, urlsplit


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# ---------------- настройки ----------------
HOST = os.environ.get('HOST', '0.0.0.0')
PORT = _env_int('PORT', 8080)
ROOT = os.path.realpath(os.environ.get('PUBLIC_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public'))
MAX_MSG = _env_int('WS_MAX_MESSAGE', 1 << 20)           # предел сообщения (сумма фрагментов)
PING_INTERVAL = max(1, _env_int('WS_PING_INTERVAL', 20))
DEAD_AFTER = PING_INTERVAL * 2 + 5                       # тишина дольше — соединение мёртвое
GRACE = max(1, _env_int('WS_GRACE', 20))
TRUST_PROXY = max(0, _env_int('TRUST_PROXY', 0))         # своих прокси перед сервером (дописывают X-Forwarded-For)
MAX_ROOMS = 500
MAX_MEMBERS = 9                                          # host + red + blue + 6 зрителей
MAX_SPECTATORS = 6
MAX_CONNECTIONS = max(1, _env_int('WS_MAX_CONNECTIONS', 1000))
MAX_WS_PER_IP = max(1, _env_int('WS_MAX_PER_IP', 32))     # IPv6 считаем по сети /64
MAX_ROOMS_PER_IP = max(1, _env_int('WS_ROOMS_PER_IP', 12))  # открытых комнат с одного адреса
ROOMS_PER_IP_PER_MIN = 20
ROOM_IDLE = max(10, _env_int('WS_ROOM_IDLE', 1800))      # комната без гостей дольше (с) — закрыть
TOMB_TTL = 120                                           # код комнаты после host-lost держим за прежним хостом
JOIN_FAIL_RATE, JOIN_FAIL_BURST = 1 / 6, 30.0            # неудачных входов с адреса: 10 в минуту, запас 30
MSG_RATE, MSG_BURST = 60.0, 180.0                        # сообщений/с на соединение
BYTE_RATE, BYTE_BURST = 1.5e6, 3.0e6                     # байт/с на соединение
HOST_MSG_RATE, HOST_MSG_BURST = 120.0, 360.0             # хост рассылает снимки, события и ответы гостям
HOST_BYTE_RATE, HOST_BYTE_BURST = 3.0e6, 6.0e6
# гость -> хост (на отправителя): (сообщений/с, запас, байт/с, запас байт)
UPLINK = {'red': (40.0, 120.0, 400e3, 1.5e6), 'blue': (40.0, 120.0, 400e3, 1.5e6), 'spectator': (4.0, 12.0, 8e3, 24e3)}
SPECTATOR_KINDS = frozenset(('hello', 'ping', 'needcfg'))  # зрителю незачем слать хосту что-то ещё
SPECTATOR_MAX = 2048
HOST_BUSY = 1 << 20                                      # очередь хоста длиннее — сообщения гостей не берём
ABUSE_LIMIT = 300                                        # отброшенных за 10 с -> закрыть (1008)
QUEUE_MAX = 8 << 20                                      # очередь отправки: больше — клиент не успевает
LOSSY_MAX = 256 << 10                                    # «снимки» не ставим в очередь длиннее этого
LOSSY_SMALL, LOSSY_SLOTS = 4096, 16                      # ...кроме первого маленького кадра отправителя (ввод гостя)
MAX_FRAGMENTS = 1024                                     # кадров в одном сообщении
FRAME_RATE, FRAME_BURST = 1000.0, 3000.0                 # кадров/с на соединение (любых, включая pong)
WIRE_RATE = 2 * max(BYTE_RATE, HOST_BYTE_RATE)           # байт/с «по проводу», считая каждый кадр сразу
WIRE_BURST = 2 * max(BYTE_BURST, HOST_BYTE_BURST, MAX_MSG)
CLOSE_TIMEOUT = 5                                        # ждём ответный close не дольше (с), потом рвём TCP
HEADER_LIMIT = 16 << 10
BODY_MAX = 64 << 10                                      # тело GET/HEAD читаем и выбрасываем, если не больше
IDLE_TIMEOUT = 30
CACHE_MAX = 64 << 20
CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679'              # без похожих: 0/O, 1/I/L, 2/Z, 5/S, 8/B
ROLES = ('host', 'red', 'blue', 'spectator')
ROLE_RU = {'host': 'Хост', 'red': 'Красные', 'blue': 'Синие', 'spectator': 'Зритель'}
GUID = b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

MIME = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
    '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
    '.py': 'text/x-python; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.pdf': 'application/pdf',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
}
NO_CACHE_EXT = {'.html', '.htm', '.js', '.mjs', '.css', '.json', '.map', '.webmanifest'}  # всегда перепроверять (ETag)
STATUS = {
    101: 'Switching Protocols', 200: 'OK', 301: 'Moved Permanently', 304: 'Not Modified', 400: 'Bad Request',
    403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 413: 'Payload Too Large', 426: 'Upgrade Required',
    429: 'Too Many Requests', 431: 'Request Header Fields Too Large', 500: 'Internal Server Error',
    503: 'Service Unavailable',
}

# ---------------- журнал (JSON-строки) ----------------
_LV = {'debug': 10, 'info': 20, 'warn': 30, 'error': 40}
LOG_LEVEL = _LV.get(os.environ.get('LOG_LEVEL', 'info').lower(), 20)
with contextlib.suppress(Exception):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')


def log(level: str, ev: str, **kw) -> None:
    if _LV[level] < LOG_LEVEL:
        return
    t = time.time()
    rec = {'ts': time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(t)) + '.%03dZ' % (int(t * 1000) % 1000), 'lvl': level, 'ev': ev}
    rec.update(kw)
    with contextlib.suppress(Exception):
        sys.stdout.write(json.dumps(rec, ensure_ascii=False, default=str) + '\n')
        sys.stdout.flush()


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


def _no_constant(name: str):
    raise ValueError('non-JSON constant ' + name)


# ======================= HTTP =======================
class HttpError(Exception):
    def __init__(self, status: int, msg: str = ''):
        super().__init__(msg)
        self.status = status
        self.msg = msg or STATUS.get(status, '')


class Request:
    __slots__ = ('method', 'target', 'path', 'query', 'version', 'headers')


async def read_request(reader: asyncio.StreamReader) -> Request | None:
    """Строка запроса + заголовки. None — клиент закрыл keep-alive соединение."""
    try:
        raw = await reader.readuntil(b'\r\n\r\n')
    except asyncio.LimitOverrunError:
        raise HttpError(431)
    except asyncio.IncompleteReadError as e:
        if not e.partial.strip():
            return None
        raise HttpError(400, 'Неполный запрос')
    if len(raw) > HEADER_LIMIT:
        raise HttpError(431)
    lines = raw.decode('latin-1').lstrip('\r\n').split('\r\n')
    parts = lines[0].split(' ')
    if len(parts) != 3 or not parts[2].startswith('HTTP/1.') or not parts[0].isalpha():
        raise HttpError(400, 'Плохая строка запроса')
    req = Request()
    req.method, req.target, req.version = parts[0].upper(), parts[1], parts[2]
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if not line:
            continue
        k, sep, v = line.partition(':')
        if not sep or not k or k != k.strip():
            raise HttpError(400, 'Плохой заголовок')
        k = k.lower()
        v = v.strip()
        headers[k] = headers[k] + ', ' + v if k in headers else v
    req.headers = headers
    try:
        u = urlsplit(req.target)
        req.path = unquote(u.path, errors='strict') if u.path else '/'
    except (ValueError, UnicodeDecodeError):
        raise HttpError(400, 'Плохой адрес')
    req.query = u.query
    if '\x00' in req.path or not req.path.startswith('/'):
        raise HttpError(400, 'Плохой путь')
    return req


def tokens(value: str) -> list[str]:
    return [t.strip().lower() for t in value.split(',') if t.strip()]


_CL_RE = re.compile(r'[0-9]{1,12}')


def parse_ip(s: str) -> str | None:
    """Адрес из заголовка: '1.2.3.4', '1.2.3.4:5678', '[2001:db8::1]:443', '2001:db8::1' -> строка или None."""
    s = s.strip().strip('"')
    if s.startswith('['):
        s = s[1:].split(']', 1)[0]
    elif s.count(':') == 1:
        s = s.split(':', 1)[0]
    try:
        a = ipaddress.ip_address(s)
    except ValueError:
        return None
    if a.version == 6 and a.ipv4_mapped:
        a = a.ipv4_mapped
    return str(a)


def client_ip(peer: str, headers: dict) -> str:
    """Адрес клиента. Без TRUST_PROXY — адрес TCP-соединения: X-Forwarded-For клиент пишет сам что угодно.
    С TRUST_PROXY=N — N-й адрес справа в X-Forwarded-For: его дописал наш ближайший прокси, клиент его не выбирает."""
    if TRUST_PROXY:
        hops = [h for h in headers.get('x-forwarded-for', '').split(',') if h.strip()]
        if hops:
            ip = parse_ip(hops[max(0, len(hops) - TRUST_PROXY)])
            if ip:
                return ip
    return parse_ip(peer) or peer


def ip_key(ip: str) -> str:
    """Ключ для лимитов: IPv4 — сам адрес, IPv6 — сеть /64 (у абонента обычно целая сеть адресов)."""
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if a.version == 6:
        return str(ipaddress.ip_network(f'{a}/64', strict=False))
    return ip


async def discard_body(req: Request, reader: asyncio.StreamReader) -> None:
    """Тело у GET/HEAD не нужно, но его надо дочитать: иначе оно станет «следующим запросом» (рассинхрон keep-alive)."""
    h = req.headers
    if 'transfer-encoding' in h:
        raise HttpError(400, 'Transfer-Encoding в запросе не поддерживается')
    cl = h.get('content-length')
    if cl is None:
        return
    if not _CL_RE.fullmatch(cl):      # повторный Content-Length склеен через запятую — тоже сюда
        raise HttpError(400, 'Плохой Content-Length')
    n = int(cl)
    if n > BODY_MAX:
        raise HttpError(413, 'Тело запроса слишком большое')
    if n:
        if req.path == '/ws':
            raise HttpError(400, 'У запроса WebSocket не бывает тела')
        await asyncio.wait_for(reader.readexactly(n), 15)


def wants_keepalive(req: Request) -> bool:
    conn = tokens(req.headers.get('connection', ''))
    if req.version == 'HTTP/1.0':
        return 'keep-alive' in conn
    return 'close' not in conn


def accepts_gzip(req: Request) -> bool:
    for part in req.headers.get('accept-encoding', '').split(','):
        name, _, params = part.strip().partition(';')
        if name.strip().lower() in ('gzip', '*'):
            q = 1.0
            for p in params.split(';'):
                k, _, v = p.strip().partition('=')
                if k.strip().lower() == 'q':
                    try:
                        q = float(v)
                    except ValueError:
                        q = 0.0
            return q > 0
    return False


async def respond(writer, status: int, body: bytes = b'', ctype: str | None = None, keep: bool = True,
                  head: bool = False, extra: dict | None = None) -> None:
    lines = [f'HTTP/1.1 {status} {STATUS.get(status, "")}', 'Date: ' + email.utils.formatdate(usegmt=True),
             'Server: bioglow-sim', 'Connection: ' + ('keep-alive' if keep else 'close'),
             'X-Content-Type-Options: nosniff']
    if status != 304:
        lines.append(f'Content-Length: {len(body)}')
    if ctype:
        lines.append('Content-Type: ' + ctype)
    for k, v in (extra or {}).items():
        lines.append(f'{k}: {v}')
    writer.write(('\r\n'.join(lines) + '\r\n\r\n').encode('latin-1') + (b'' if head or status == 304 else body))
    await writer.drain()


def error_page(status: int, text: str) -> bytes:
    return (f'<!doctype html><meta charset="utf-8"><title>{status}</title>'
            f'<body style="font:16px system-ui;padding:2em"><h1>{status} {STATUS.get(status, "")}</h1>'
            f'<p>{html.escape(text)}</p><p><a href="/">На главную</a></p></body>').encode('utf-8')


class Redirect:
    def __init__(self, location: str):
        self.location = location


def resolve(path: str):
    """Путь URL -> файл в ROOT (или Redirect, или None). Выход за корень, скрытые файлы и ':' запрещены."""
    rel = path.replace('\\', '/')
    parts = [p for p in rel.split('/') if p not in ('', '.')]
    for p in parts:
        if p == '..' or p.startswith('.') or ':' in p:
            return None
    full = os.path.realpath(os.path.join(ROOT, *parts))
    root_n = os.path.normcase(ROOT)
    try:
        if os.path.normcase(os.path.commonpath([full, ROOT])) != root_n:
            return None
    except ValueError:      # другой диск (Windows)
        return None
    if os.path.isdir(full):
        if not path.endswith('/'):
            # адрес перенаправления — из разобранных частей: '/\js' или '//js' дали бы ссылку на чужой хост
            return Redirect('/' + ''.join(quote(p, safe='') + '/' for p in parts))
        full = os.path.join(full, 'index.html')
    elif path.endswith('/'):
        return None          # «файл/» — такого адреса нет
    return full if os.path.isfile(full) else None


class FileCache:
    """Файлы в памяти (с проверкой mtime/size) + сжатая gzip-копия для текстовых."""

    def __init__(self):
        self.items: dict[str, list] = {}
        self.bytes = 0

    async def get(self, full: str, want_gz: bool):
        st = os.stat(full)
        ent = self.items.get(full)
        if not ent or ent[0] != st.st_mtime_ns or ent[1] != st.st_size:
            data = await asyncio.to_thread(_read_file, full)
            ent = [st.st_mtime_ns, len(data), data, None, st.st_mtime]
            if len(data) <= 8 << 20:
                if self.bytes > CACHE_MAX:
                    self.items.clear()
                    self.bytes = 0
                old = self.items.get(full)
                if old:
                    self.bytes -= old[1] + len(old[3] or b'')
                self.items[full] = ent
                self.bytes += len(data)
        gz = None
        if want_gz:
            if ent[3] is None:
                ent[3] = await asyncio.to_thread(gzip.compress, ent[2], 6, mtime=0)
                self.bytes += len(ent[3])
            if len(ent[3]) < len(ent[2]):
                gz = ent[3]
        return ent, gz


def _read_file(full: str) -> bytes:
    with open(full, 'rb') as f:
        return f.read()


def compressible(ctype: str) -> bool:
    return ctype.startswith('text/') or ctype.split(';')[0] in (
        'application/json', 'application/javascript', 'image/svg+xml', 'application/wasm',
        'application/manifest+json', 'application/xml')


async def serve_http(req: Request, writer, hub: 'Hub', ip: str) -> bool:
    """Обычный HTTP-запрос. -> держать ли соединение (keep-alive)."""
    keep = wants_keepalive(req) and not hub.closing
    head = req.method == 'HEAD'
    hub.stats['http'] += 1
    if req.method not in ('GET', 'HEAD'):
        await respond(writer, 405, b'Method Not Allowed', 'text/plain; charset=utf-8', False, extra={'Allow': 'GET, HEAD'})
        return False
    if req.path == '/healthz':
        await respond(writer, 200, b'ok', 'text/plain; charset=utf-8', keep, head, {'Cache-Control': 'no-store'})
        return keep
    if req.path == '/stats':
        body = dumps(hub.public_stats()).encode('utf-8')
        await respond(writer, 200, body, 'application/json; charset=utf-8', keep, head, {'Cache-Control': 'no-store'})
        return keep
    if req.path == '/ws':
        body = 'Это адрес WebSocket для онлайн-режима симулятора.'.encode('utf-8')
        await respond(writer, 426, body, 'text/plain; charset=utf-8', keep, head, {'Upgrade': 'websocket', 'Sec-WebSocket-Version': '13'})
        return keep
    target = resolve(req.path)
    if isinstance(target, Redirect):
        loc = target.location + ('?' + req.query if req.query else '')
        await respond(writer, 301, b'', None, keep, head, {'Location': loc})
        return keep
    if target is None:
        log('debug', 'http_404', path=req.path, ip=ip)
        await respond(writer, 404, error_page(404, 'Не найдено: ' + req.path), 'text/html; charset=utf-8', keep, head)
        return keep
    ext = os.path.splitext(target)[1].lower()
    ctype = MIME.get(ext, 'application/octet-stream')
    gz_ok = compressible(ctype) and accepts_gzip(req)
    ent, gz = await hub.files.get(target, gz_ok)
    etag = '"%x-%x%s"' % (ent[0], ent[1], '-gz' if gz else '')
    hdr = {
        'ETag': etag,
        'Last-Modified': email.utils.formatdate(ent[4], usegmt=True),
        'Cache-Control': 'no-cache' if ext in NO_CACHE_EXT else 'public, max-age=3600',
        'Accept-Ranges': 'none',
    }
    if compressible(ctype):
        hdr['Vary'] = 'Accept-Encoding'
    inm = req.headers.get('if-none-match')
    not_modified = False
    if inm is not None:
        tags = {t.strip().removeprefix('W/') for t in inm.split(',')}
        not_modified = '*' in tags or etag in tags
    elif 'if-modified-since' in req.headers:
        with contextlib.suppress(Exception):
            ims = email.utils.parsedate_to_datetime(req.headers['if-modified-since']).timestamp()
            not_modified = int(ent[4]) <= int(ims)
    if not_modified:
        await respond(writer, 304, b'', None, keep, True, hdr)
        return keep
    body = ent[2]
    if gz is not None:
        body = gz
        hdr['Content-Encoding'] = 'gzip'
    await respond(writer, 200, body, ctype, keep, head, hdr)
    log('debug', 'http', path=req.path, status=200, bytes=len(body), ip=ip)
    return keep


# ======================= WebSocket (RFC 6455) =======================
class WSError(Exception):
    def __init__(self, code: int, reason: str = ''):
        super().__init__(reason)
        self.code = code
        self.reason = reason


def ws_frame(op: int, payload: bytes = b'') -> bytes:
    """Кадр сервера: FIN, без маски, минимальная длина."""
    n = len(payload)
    if n < 126:
        hdr = struct.pack('!BB', 0x80 | op, n)
    elif n < 65536:
        hdr = struct.pack('!BBH', 0x80 | op, 126, n)
    else:
        hdr = struct.pack('!BBQ', 0x80 | op, 127, n)
    return hdr + payload


def unmask(data: bytes, mask: bytes) -> bytes:
    n = len(data)
    if not n:
        return data
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, 'little') ^ int.from_bytes(key, 'little')).to_bytes(n, 'little')


def valid_close_code(code: int) -> bool:
    return code in (1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014) or 3000 <= code <= 4999


def ws_accept(key: str) -> str:
    return base64.b64encode(hashlib.sha1(key.strip().encode('ascii') + GUID).digest()).decode('ascii')


class Bucket:
    """Ведро токенов для ограничения частоты."""
    __slots__ = ('rate', 'burst', 'tokens', 't')

    def __init__(self, rate: float, burst: float):
        self.rate, self.burst, self.tokens, self.t = rate, burst, burst, time.monotonic()

    def _fill(self) -> None:
        now = time.monotonic()
        self.tokens = min(self.burst, self.tokens + (now - self.t) * self.rate)
        self.t = now

    def take(self, n: float = 1.0) -> bool:
        self._fill()
        if self.tokens >= n:
            self.tokens -= n
            return True
        return False

    def ready(self, n: float = 1.0) -> bool:
        """Хватит ли на n (ничего не тратит)"""
        self._fill()
        return self.tokens >= n

    def full(self) -> bool:
        self._fill()
        return self.tokens >= self.burst


_ids = itertools.count(1)


class WSConn:
    """Одно WebSocket-соединение: чтение кадров, очередь отправки с обратным давлением, ping."""

    def __init__(self, reader, writer, ip: str, hub: 'Hub'):
        self.id = next(_ids)
        self.reader, self.writer, self.ip, self.hub = reader, writer, ip, hub
        self.key = ip_key(ip)        # ключ для лимитов «на адрес»
        self.q: deque = deque()
        self.qbytes = 0
        self.wake = asyncio.Event()
        self.lossy: dict = {}        # (отправитель, вид) -> ожидающий отправки «заменяемый» кадр (снимок/ввод)
        self.close_sent = False
        self.close_timer = None
        self.done = False
        self.close_code = None
        self.member = None
        self.last_rx = time.monotonic()
        self.opened = time.monotonic()
        self.msgs = Bucket(MSG_RATE, MSG_BURST)
        self.bytes = Bucket(BYTE_RATE, BYTE_BURST)
        # кадры и байты считаем сразу при чтении: поток мелких кадров (пустые фрагменты, pong) или огромных
        # сообщений не будет бесплатным до сборки сообщения
        self.frames = Bucket(FRAME_RATE, FRAME_BURST)
        self.wire = Bucket(WIRE_RATE, WIRE_BURST)
        self.up_msgs = self.up_bytes = None   # гость -> хост (задаются по роли)
        self.abuse: deque = deque()
        self.err_t: dict = {}
        self.rx_msgs = self.tx_msgs = self.rx_bytes = self.tx_bytes = 0
        self.lossy_dropped = 0

    def set_role(self, role: str) -> None:
        """Лимиты по роли: хост рассылает всем, гость шлёт только хосту и в меру."""
        if role == 'host':
            self.msgs = Bucket(HOST_MSG_RATE, HOST_MSG_BURST)
            self.bytes = Bucket(HOST_BYTE_RATE, HOST_BYTE_BURST)
            self.up_msgs = self.up_bytes = None
        else:
            mr, mb, br, bb = UPLINK[role]
            self.up_msgs, self.up_bytes = Bucket(mr, mb), Bucket(br, bb)

    def abused(self) -> bool:
        """Отброшено ещё одно сообщение. -> True, если пора закрыть соединение (1008)"""
        now = time.monotonic()
        self.abuse.append(now)
        while self.abuse and now - self.abuse[0] > 10:
            self.abuse.popleft()
        return len(self.abuse) > ABUSE_LIMIT

    def err_once(self, code: str) -> bool:
        """Ошибку одного вида сообщаем не чаще раза в 2 с"""
        now = time.monotonic()
        if now - self.err_t.get(code, 0.0) < 2:
            return False
        self.err_t[code] = now
        return True

    # ---------- отправка ----------
    def enqueue(self, data: bytes, lossy=None, close: bool = False) -> bool:
        """lossy — ключ (отправитель, вид): новый кадр с тем же ключом заменяет ещё не отправленный старый."""
        if self.close_sent or self.done:
            return False
        if lossy is not None:
            old = self.lossy.get(lossy)
            if self.qbytes > LOSSY_MAX:
                # очередь длинная: если старый кадр того же отправителя ещё ждёт — подменяем его данные на свежие
                # (у получателя остаётся самый новый ввод/снимок); если нет — ставим только маленький кадр
                # (ввод другой команды не теряется), число таких слотов ограничено
                if old is not None:
                    self.lossy_dropped += 1
                    self.qbytes += len(data) - len(old[0])
                    old[0] = data
                    self.wake.set()
                    return True
                if len(data) > LOSSY_SMALL or len(self.lossy) >= LOSSY_SLOTS:
                    self.lossy_dropped += 1
                    return False
            elif old is not None:
                del self.lossy[lossy]
                for i, it in enumerate(self.q):
                    if it is old:
                        del self.q[i]
                        self.qbytes -= len(old[0])
                        self.lossy_dropped += 1
                        break
        elif self.qbytes + len(data) > QUEUE_MAX:
            log('warn', 'ws_slow_consumer', id=self.id, ip=self.ip, queued=self.qbytes)
            self.abort()
            return False
        item = [data, lossy]
        self.q.append(item)
        self.qbytes += len(data)
        if lossy is not None:
            self.lossy[lossy] = item
        if close:
            self.close_sent = True
            # ответный close ждём не дольше CLOSE_TIMEOUT: молчащий клиент не держит место и лимит адреса
            with contextlib.suppress(RuntimeError):
                self.close_timer = asyncio.get_running_loop().call_later(CLOSE_TIMEOUT, self.abort)
        if not close and data[0] & 0x0F == 0x1:
            self.tx_msgs += 1
        self.wake.set()
        return True

    def send_text(self, text: str) -> bool:
        return self.enqueue(ws_frame(0x1, text.encode('utf-8')))

    def send_json(self, obj) -> bool:
        return self.send_text(dumps(obj))

    def start_close(self, code: int = 1000, reason: str = '') -> None:
        if self.close_sent or self.done:
            return
        self.enqueue(ws_frame(0x8, struct.pack('!H', code) + reason.encode('utf-8')[:123]), close=True)

    def abort(self) -> None:
        if self.done:
            return
        self.done = True
        self.wake.set()
        with contextlib.suppress(Exception):
            self.writer.transport.abort()

    async def writer_loop(self) -> None:
        w = self.writer
        try:
            while True:
                while not self.q:
                    if self.close_sent or self.done:
                        return
                    self.wake.clear()
                    await self.wake.wait()
                if self.done:
                    return
                item = self.q.popleft()
                if item[1] is not None and self.lossy.get(item[1]) is item:
                    del self.lossy[item[1]]
                data = item[0]
                self.qbytes -= len(data)
                w.write(data)
                self.tx_bytes += len(data)
                await asyncio.wait_for(w.drain(), 30)
        except (asyncio.TimeoutError, ConnectionError, OSError):
            self.abort()

    async def ping_loop(self) -> None:
        while not self.done and not self.close_sent:
            await asyncio.sleep(PING_INTERVAL)
            if time.monotonic() - self.last_rx > DEAD_AFTER:
                log('info', 'ws_dead', id=self.id, ip=self.ip, silent=round(time.monotonic() - self.last_rx, 1))
                self.abort()
                return
            self.enqueue(ws_frame(0x9, struct.pack('!d', time.time())))

    # ---------- чтение ----------
    async def reader_loop(self) -> None:
        r = self.reader
        frag_op = None
        parts: list[bytes] = []
        size = 0
        while True:
            hdr = await r.readexactly(2)
            b0, b1 = hdr[0], hdr[1]
            fin, op, n = b0 & 0x80, b0 & 0x0F, b1 & 0x7F
            if b0 & 0x70:
                raise WSError(1002, 'RSV bits set')
            if not b1 & 0x80:
                raise WSError(1002, 'client frame must be masked')
            if n == 126:
                n = struct.unpack('!H', await r.readexactly(2))[0]
            elif n == 127:
                n = struct.unpack('!Q', await r.readexactly(8))[0]
                if n >> 63:
                    raise WSError(1002, 'bad length')
            if op >= 0x8:
                if op not in (0x8, 0x9, 0xA):
                    raise WSError(1002, 'unknown opcode')
                if not fin or n > 125:
                    raise WSError(1002, 'bad control frame')
            elif op == 0x0:
                if frag_op is None:
                    raise WSError(1002, 'unexpected continuation')
            elif op in (0x1, 0x2):
                if frag_op is not None:
                    raise WSError(1002, 'expected continuation')
            else:
                raise WSError(1002, 'unknown opcode')
            if op < 0x8:
                if size + n > MAX_MSG:
                    raise WSError(1009, 'message too big')
                # пустые фрагменты не растят size, но занимают память — число кадров в сообщении ограничено
                if len(parts) >= MAX_FRAGMENTS:
                    raise WSError(1009, 'too many fragments')
            if not self.frames.take(1) or not self.wire.take(n):
                log('warn', 'ws_rate_close', id=self.id, ip=self.ip, why='frames')
                raise WSError(1008, 'rate limit')
            mask = await r.readexactly(4)
            data = unmask(await r.readexactly(n), mask) if n else b''
            self.last_rx = time.monotonic()
            self.rx_bytes += n
            if op == 0x8:
                code, payload = 1005, b''
                if n == 1:
                    raise WSError(1002, 'bad close payload')
                if n >= 2:
                    code = struct.unpack('!H', data[:2])[0]
                    if not valid_close_code(code):
                        raise WSError(1002, 'bad close code')
                    try:
                        data[2:].decode('utf-8')
                    except UnicodeDecodeError:
                        raise WSError(1007, 'bad close reason')
                    payload = data[:2]
                self.close_code = code
                if not self.close_sent:
                    self.enqueue(ws_frame(0x8, payload), close=True)
                return
            if op == 0x9:
                # ping-кадры тратят тот же лимит сообщений: поток ping не заставит сервер бесконечно отвечать
                if self.msgs.take(1):
                    self.enqueue(ws_frame(0xA, data))
                elif self.abused():
                    raise WSError(1008, 'rate limit')
                continue
            if op == 0xA:
                continue
            if op != 0x0:
                frag_op = op
            parts.append(data)
            size += n
            if not fin:
                continue
            msg = parts[0] if len(parts) == 1 else b''.join(parts)
            mop, frag_op, parts, size = frag_op, None, [], 0
            if mop == 0x2:
                raise WSError(1003, 'binary messages are not supported')
            try:
                text = msg.decode('utf-8')
            except UnicodeDecodeError:
                raise WSError(1007, 'invalid UTF-8')
            self.rx_msgs += 1
            self.hub.on_text(self, text, len(msg))

    async def run(self) -> None:
        wt = asyncio.create_task(self.writer_loop())
        pt = asyncio.create_task(self.ping_loop())
        try:
            await self.reader_loop()
        except WSError as e:
            log('info', 'ws_protocol_error', id=self.id, ip=self.ip, code=e.code, reason=e.reason)
            self.close_code = e.code
            self.start_close(e.code, e.reason)
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            pass
        except Exception as e:      # любая другая ошибка — закрыть это соединение, а не писать HTTP 500 в сокет
            log('error', 'ws_error', id=self.id, ip=self.ip, err=repr(e)[:300])
            self.close_code = 1011
            self.start_close(1011, 'server error')
        finally:
            pt.cancel()
            self.hub.disconnect(self)
            if not self.done:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(wt, CLOSE_TIMEOUT)
            wt.cancel()
            if self.close_timer:
                self.close_timer.cancel()
            # по RFC сервер закрывает TCP первым
            with contextlib.suppress(Exception):
                self.writer.close()
            self.done = True


# ======================= комнаты =======================
def clean_name(name, role: str) -> str:
    if not isinstance(name, str):
        name = ''
    name = ''.join(ch for ch in name if ch.isprintable()).strip()[:24]
    return name or ROLE_RU.get(role, role)


def norm_code(code) -> str | None:
    if not isinstance(code, str):
        return None
    code = code.strip().upper()
    if len(code) == 4 and all(ch in CODE_ALPHABET for ch in code):
        return code
    return None


class Member:
    __slots__ = ('id', 'role', 'name', 'token', 'conn', 'room', 'lost_at', 'timer')

    def __init__(self, mid: int, role: str, name: str, conn: WSConn, room: 'Room'):
        self.id, self.role, self.name, self.conn, self.room = mid, role, name, conn, room
        self.token = secrets.token_urlsafe(18)
        self.lost_at = None
        self.timer = None


class Room:
    def __init__(self, code: str, owner: str):
        self.code = code
        self.owner = owner                       # ключ адреса создателя (лимит открытых комнат)
        self.created = time.monotonic()
        self.alone_since: float | None = self.created   # с какого момента в комнате нет гостей
        self.members: dict[int, Member] = {}
        self.host: Member | None = None
        self.host_side: str | None = None
        self.relayed = 0

    def has_guests(self) -> bool:
        return any(m.role != 'host' for m in self.members.values())

    def holder(self, role: str) -> Member | None:
        for m in self.members.values():
            if m.role == role:
                return m
        return None

    def taken(self, role: str) -> bool:
        if role in ('red', 'blue'):
            return self.host_side == role or self.holder(role) is not None
        if role == 'spectator':
            return sum(1 for m in self.members.values() if m.role == 'spectator') >= MAX_SPECTATORS
        return self.host is not None

    def peers(self) -> list:
        ms = sorted(self.members.values(), key=lambda m: (ROLES.index(m.role), m.id))
        return [{'id': m.id, 'role': m.role, 'name': m.name, 'on': m.conn is not None} for m in ms]

    def send_all(self, obj) -> None:
        data = ws_frame(0x1, dumps(obj).encode('utf-8'))
        for m in self.members.values():
            if m.conn:
                m.conn.enqueue(data)


class Hub:
    def __init__(self):
        self.rooms: dict[str, Room] = {}
        self.conns: set[WSConn] = set()
        self.by_ip: dict[str, int] = {}            # ключ адреса -> соединений
        self.rooms_by_ip: dict[str, int] = {}      # ключ адреса -> открытых комнат
        self.create_log: dict[str, deque] = {}
        self.join_fail: dict[str, Bucket] = {}     # ключ адреса -> неудачные входы (перебор кодов)
        self.tombs: dict[str, tuple] = {}          # код -> (токен прежнего хоста, до какого времени)
        self.files = FileCache()
        self.tasks: set = set()
        self.closing = False
        self.started = time.monotonic()
        self.stats = {'http': 0, 'ws': 0, 'relayed': 0, 'relayed_bytes': 0, 'rooms_created': 0, 'refused': 0}

    def public_stats(self) -> dict:
        return {'ok': True, 'uptime': round(time.monotonic() - self.started), 'rooms': len(self.rooms),
                'connections': len(self.conns), **self.stats}

    # ---------- соединения ----------
    def can_connect(self, ip: str) -> str:
        """'' — можно; иначе причина отказа"""
        if len(self.conns) >= MAX_CONNECTIONS:
            return 'server-full'
        if self.by_ip.get(ip_key(ip), 0) >= MAX_WS_PER_IP:
            return 'ip-limit'
        return ''

    def connect(self, conn: WSConn) -> None:
        self.conns.add(conn)
        self.by_ip[conn.key] = self.by_ip.get(conn.key, 0) + 1
        self.stats['ws'] += 1

    def disconnect(self, conn: WSConn) -> None:
        """Соединение закончилось. Без «leave» место держим GRACE секунд (обрыв, перезагрузка вкладки)."""
        if conn in self.conns:
            self.conns.discard(conn)
            left = self.by_ip.get(conn.key, 1) - 1
            if left > 0:
                self.by_ip[conn.key] = left
            else:
                self.by_ip.pop(conn.key, None)
        m = conn.member
        conn.member = None
        if not m or m.conn is not conn:
            return
        m.conn = None
        m.lost_at = time.monotonic()
        room = m.room
        if self.closing:
            return
        m.timer = asyncio.get_running_loop().call_later(GRACE, self.expire, m)
        log('info', 'member_lost', room=room.code, role=m.role, id=m.id, code=conn.close_code)
        self.send_peers(room, {'type': 'lost', 'role': m.role, 'id': m.id})

    def expire(self, m: Member) -> None:
        m.timer = None
        if m.conn is None and m.room.members.get(m.id) is m:
            self.remove_member(m, 'timeout')

    # ---------- сообщения ----------
    def on_text(self, conn: WSConn, text: str, nbytes: int) -> None:
        if conn.close_sent or conn.done:
            return
        if not conn.msgs.take(1) or not conn.bytes.take(nbytes):
            if conn.abused():
                log('warn', 'ws_rate_close', id=conn.id, ip=conn.ip)
                conn.start_close(1008, 'rate limit')
            elif conn.err_once('rate'):
                self.err(conn, 'rate', 'Слишком много сообщений — часть отброшена')
            return
        try:
            # NaN/Infinity — не JSON: браузер получателя не разобрал бы пересланное сообщение
            msg = json.loads(text, parse_constant=_no_constant)
        except (ValueError, RecursionError):      # RecursionError — слишком глубокая вложенность [[[[…]]]]
            return self.err(conn, 'bad-json', 'Сообщение не в формате JSON')
        if not isinstance(msg, dict):
            return self.err(conn, 'bad-json', 'Ожидался JSON-объект')
        t = msg.get('t')
        fn = {'ping': self.ping, 'create': self.create, 'join': self.join,
              'resume': self.resume, 'side': self.side, 'leave': self.leave}.get(t)
        if fn is None and t != 'm':
            return self.err(conn, 'bad-type', 'Неизвестный тип сообщения', re=t if isinstance(t, str) else None)
        try:
            if t == 'm':
                self.relay(conn, msg, nbytes)
            else:
                fn(conn, msg)
        except Exception as e:     # ошибка в обработчике не роняет сервер
            log('error', 'handler_error', t=t, err=repr(e)[:300])
            self.err(conn, 'server', 'Ошибка сервера', re=t)

    def err(self, conn: WSConn, code: str, text: str, re=None, **extra) -> None:
        obj = {'t': 'error', 'code': code, 'msg': text}
        if re is not None:
            obj['re'] = re
        obj.update(extra)
        conn.send_json(obj)

    def ping(self, conn: WSConn, msg: dict) -> None:
        c = msg.get('c')
        if not isinstance(c, (int, float)) or isinstance(c, bool) or c != c or c in (float('inf'), float('-inf')):
            c = None      # эхо — только число: строки и 1e999 отправителю не нужны
        conn.send_json({'t': 'pong', 'c': c, 's': int(time.time() * 1000)})

    def code_free(self, code: str, token=None) -> bool:
        """Код свободен; код комнаты, закрытой по host-lost, TOMB_TTL секунд свободен только для прежнего хоста"""
        if code in self.rooms:
            return False
        tomb = self.tombs.get(code)
        if tomb is None:
            return True
        if tomb[1] < time.monotonic():
            del self.tombs[code]
            return True
        return isinstance(token, str) and secrets.compare_digest(tomb[0], token)

    def new_code(self) -> str | None:
        for _ in range(200):
            code = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(4))
            if self.code_free(code):
                return code
        return None

    def add_member(self, room: Room, conn: WSConn, role: str, name) -> Member:
        m = Member(conn.id, role, clean_name(name, role), conn, room)
        room.members[m.id] = m
        conn.member = m
        conn.set_role(role)
        if role != 'host':
            room.alone_since = None
        return m

    def join_blocked(self, conn: WSConn) -> bool:
        b = self.join_fail.get(conn.key)
        return b is not None and not b.ready()

    def join_failed(self, conn: WSConn) -> None:
        """Неудачный вход: перебирать коды комнат с одного адреса можно только медленно"""
        b = self.join_fail.get(conn.key)
        if b is None:
            b = self.join_fail[conn.key] = Bucket(JOIN_FAIL_RATE, JOIN_FAIL_BURST)
        b.take(1)

    def welcome(self, conn: WSConn, m: Member, resumed: bool) -> None:
        room = m.room
        conn.send_json({'t': 'welcome', 'room': room.code, 'role': m.role, 'id': m.id, 'token': m.token, 'name': m.name,
                        'hostSide': room.host_side, 'peers': room.peers(), 'resumed': resumed, 'grace': GRACE})

    def send_peers(self, room: Room, ev: dict) -> None:
        room.send_all({'t': 'peers', 'list': room.peers(), 'hostSide': room.host_side, 'ev': ev})

    def create(self, conn: WSConn, msg: dict) -> None:
        if conn.member:
            return self.err(conn, 'already', 'Вы уже в комнате', re='create')
        if len(self.rooms) >= MAX_ROOMS:
            return self.err(conn, 'full', 'Сервер переполнен — попробуйте позже', re='create')
        if self.rooms_by_ip.get(conn.key, 0) >= MAX_ROOMS_PER_IP:
            return self.err(conn, 'rate', 'С вашего адреса открыто слишком много комнат — закройте лишние', re='create')
        now = time.monotonic()
        dq = self.create_log.setdefault(conn.key, deque())
        while dq and now - dq[0] > 60:
            dq.popleft()
        if len(dq) >= ROOMS_PER_IP_PER_MIN:
            return self.err(conn, 'rate', 'Слишком много новых комнат — подождите минуту', re='create')
        dq.append(now)
        want = norm_code(msg.get('room'))
        code = want if want and self.code_free(want, msg.get('token')) else self.new_code()
        if not code:
            return self.err(conn, 'full', 'Нет свободных кодов комнат', re='create')
        self.tombs.pop(code, None)
        side = msg.get('side') if msg.get('side') in ('red', 'blue') else None
        room = Room(code, conn.key)
        room.host_side = side
        self.rooms[code] = room
        self.rooms_by_ip[conn.key] = self.rooms_by_ip.get(conn.key, 0) + 1
        m = self.add_member(room, conn, 'host', msg.get('name'))
        room.host = m
        self.stats['rooms_created'] += 1
        log('info', 'room_create', room=code, ip=conn.ip, side=side, wanted=want)
        self.welcome(conn, m, False)
        self.send_peers(room, {'type': 'join', 'role': 'host', 'id': m.id})

    def join(self, conn: WSConn, msg: dict) -> None:
        if conn.member:
            return self.err(conn, 'already', 'Вы уже в комнате', re='join')
        if self.join_blocked(conn):
            return self.err(conn, 'rate', 'Слишком много попыток входа с неверным кодом — подождите минуту', re='join')
        code = norm_code(msg.get('room'))
        if not code:
            self.join_failed(conn)
            return self.err(conn, 'bad-code', 'Код комнаты — 4 символа (буквы и цифры)', re='join')
        room = self.rooms.get(code)
        if not room:
            # комната ждёт возвращения хоста (host-lost) — гости переспрашивают её, это не перебор
            if code not in self.tombs:
                self.join_failed(conn)
            return self.err(conn, 'no-room', f'Комнаты {code} нет (хост ещё не создал её или уже закрыл)', re='join')
        role = msg.get('role')
        if role not in ('red', 'blue', 'spectator'):
            return self.err(conn, 'bad-role', 'Роль: red, blue или spectator', re='join')
        if room.taken(role):
            return self.err(conn, 'role-taken', f'Роль «{ROLE_RU[role]}» в комнате {code} уже занята', re='join')
        if len(room.members) >= MAX_MEMBERS:
            return self.err(conn, 'full', 'Комната заполнена', re='join')
        m = self.add_member(room, conn, role, msg.get('name'))
        log('info', 'member_join', room=code, role=role, id=m.id, ip=conn.ip)
        self.welcome(conn, m, False)
        self.send_peers(room, {'type': 'join', 'role': role, 'id': m.id})

    def resume(self, conn: WSConn, msg: dict) -> None:
        if conn.member:
            return self.err(conn, 'already', 'Вы уже в комнате', re='resume')
        room = self.rooms.get(norm_code(msg.get('room')) or '')
        token = msg.get('token')
        m = None
        if room and isinstance(token, str):
            for x in room.members.values():
                if secrets.compare_digest(x.token, token):
                    m = x
                    break
        if not m:
            return self.err(conn, 'no-session', 'Место в комнате не сохранилось', re='resume')
        old = m.conn
        if old is not None and old is not conn:
            # место заняло новое соединение (полуоткрытое старое или вторая вкладка с тем же токеном):
            # 4001 — клиент не переподключается, а сообщает, что место открыто в другой вкладке
            old.member = None
            old.start_close(4001, 'replaced')
        if m.timer:
            m.timer.cancel()
            m.timer = None
        m.conn, m.lost_at = conn, None
        conn.member = m
        conn.set_role(m.role)
        log('info', 'member_resume', room=room.code, role=m.role, id=m.id, ip=conn.ip)
        self.welcome(conn, m, True)
        self.send_peers(room, {'type': 'back', 'role': m.role, 'id': m.id})

    def side(self, conn: WSConn, msg: dict) -> None:
        m = conn.member
        if not m or m.role != 'host':
            return self.err(conn, 'not-host', 'Команду хоста меняет только хост', re='side')
        s = msg.get('side') if msg.get('side') in ('red', 'blue') else None
        room = m.room
        if s and room.holder(s):
            return self.err(conn, 'role-taken', f'За «{ROLE_RU[s]}» уже играет гость', re='side')
        room.host_side = s
        self.send_peers(room, {'type': 'side', 'side': s})

    def leave(self, conn: WSConn, msg: dict) -> None:
        m = conn.member
        if m:
            self.remove_member(m, 'left')
        conn.send_json({'t': 'left'})

    def remove_member(self, m: Member, why: str) -> None:
        room = m.room
        if m.timer:
            m.timer.cancel()
            m.timer = None
        room.members.pop(m.id, None)
        if m.conn is not None:
            m.conn.member = None
        log('info', 'member_leave', room=room.code, role=m.role, id=m.id, why=why)
        if m.role == 'host':
            if why != 'left':
                # гости ждут хоста и переспрашивают код: занять его может только прежний хост (по токену)
                self.tombs[room.code] = (m.token, time.monotonic() + TOMB_TTL)
            self.close_room(room, 'host-left' if why == 'left' else 'host-lost')
        else:
            if not room.has_guests():
                room.alone_since = time.monotonic()
            self.send_peers(room, {'type': 'leave', 'role': m.role, 'id': m.id, 'why': why})

    def close_room(self, room: Room, reason: str) -> None:
        if self.rooms.get(room.code) is room:
            del self.rooms[room.code]
            left = self.rooms_by_ip.get(room.owner, 1) - 1
            if left > 0:
                self.rooms_by_ip[room.owner] = left
            else:
                self.rooms_by_ip.pop(room.owner, None)
        data = ws_frame(0x1, dumps({'t': 'closed', 'room': room.code, 'reason': reason}).encode('utf-8'))
        for x in list(room.members.values()):
            if x.timer:
                x.timer.cancel()
                x.timer = None
            if x.conn is not None:
                x.conn.member = None
                x.conn.enqueue(data)
        room.members.clear()
        log('info', 'room_close', room=room.code, reason=reason, age=round(time.monotonic() - room.created), relayed=room.relayed)

    def relay(self, conn: WSConn, msg: dict, nbytes: int = 0) -> None:
        m = conn.member
        if not m:
            return self.err(conn, 'no-room', 'Сначала создайте комнату или войдите в неё', re='m')
        room = m.room
        d = msg.get('d')
        kind = d.get('k') if isinstance(d, dict) and isinstance(d.get('k'), str) else None
        # заменять можно только более свежим кадром того же отправителя и того же вида
        lossy = (m.id, kind) if msg.get('lossy') else None
        if m.role == 'host':
            to = msg.get('to', 'guests')
            targets = [x for x in room.members.values()
                       if x is not m and x.conn is not None and (to in ('guests', 'all') or x.role == to or x.id == to)]
        else:
            host = room.host
            if host is None or host.conn is None:
                return
            if m.role == 'spectator' and (kind not in SPECTATOR_KINDS or nbytes > SPECTATOR_MAX):
                if conn.err_once('not-allowed'):
                    self.err(conn, 'not-allowed', 'Зритель не отправляет хосту данные', re='m')
                return
            # свой бюджет «гость -> хост»: гости не могут исчерпать лимиты и канал хоста
            if conn.up_msgs is not None and (not conn.up_msgs.take(1) or not conn.up_bytes.take(nbytes)):
                if conn.err_once('rate'):
                    self.err(conn, 'rate', 'Слишком много данных для хоста — часть отброшена', re='m')
                return
            if lossy is None and host.conn.qbytes > HOST_BUSY:
                if conn.err_once('host-busy'):
                    self.err(conn, 'host-busy', 'Хост не успевает принимать данные — повторите чуть позже', re='m')
                return
            targets = [host]
        if not targets:
            return
        data = ws_frame(0x1, dumps({'t': 'm', 'from': m.role, 'id': m.id, 'd': d}).encode('utf-8'))
        for x in targets:
            x.conn.enqueue(data, lossy)
        room.relayed += 1
        self.stats['relayed'] += len(targets)
        self.stats['relayed_bytes'] += len(data) * len(targets)

    # ---------- уборка ----------
    def sweep(self) -> None:
        """Раз в 30 с: комнаты без гостей дольше ROOM_IDLE, просроченные коды, старые счётчики адресов."""
        now = time.monotonic()
        for room in list(self.rooms.values()):
            if room.alone_since is not None and now - room.alone_since > ROOM_IDLE:
                log('info', 'room_idle', room=room.code, alone=round(now - room.alone_since))
                self.close_room(room, 'idle')
        for code in [c for c, t in self.tombs.items() if t[1] < now]:
            del self.tombs[code]
        for k in [k for k, d in self.create_log.items() if not d or now - d[-1] > 60]:
            del self.create_log[k]
        for k in [k for k, b in self.join_fail.items() if b.full()]:
            del self.join_fail[k]

    async def janitor(self) -> None:
        while True:
            await asyncio.sleep(30)
            try:
                self.sweep()
            except Exception as e:
                log('error', 'sweep_error', err=repr(e)[:300])

    # ---------- остановка ----------
    async def shutdown(self, timeout: float = 5.0) -> None:
        self.closing = True
        for c in list(self.conns):
            c.start_close(1001, 'server restart')
        t0 = time.monotonic()
        while self.conns and time.monotonic() - t0 < timeout:
            await asyncio.sleep(0.05)
        for c in list(self.conns):
            c.abort()
        for room in list(self.rooms.values()):
            for x in room.members.values():
                if x.timer:
                    x.timer.cancel()
        self.rooms.clear()


# ======================= соединение =======================
async def websocket(req: Request, reader, writer, hub: Hub, ip: str) -> None:
    h = req.headers
    if req.method != 'GET':
        await respond(writer, 405, b'', None, False, extra={'Allow': 'GET'})
        return
    if 'websocket' not in tokens(h.get('upgrade', '')) or 'upgrade' not in tokens(h.get('connection', '')):
        await respond(writer, 426, 'Нужен WebSocket'.encode('utf-8'), 'text/plain; charset=utf-8', False,
                      extra={'Upgrade': 'websocket', 'Sec-WebSocket-Version': '13'})
        return
    if h.get('sec-websocket-version', '').strip() != '13':
        await respond(writer, 426, b'', None, False, extra={'Sec-WebSocket-Version': '13'})
        return
    key = h.get('sec-websocket-key', '').strip()
    try:
        ok = len(base64.b64decode(key, validate=True)) == 16
    except Exception:
        ok = False
    if not ok:
        await respond(writer, 400, b'Bad Sec-WebSocket-Key', 'text/plain; charset=utf-8', False)
        return
    if hub.closing:
        await respond(writer, 503, b'', None, False, extra={'Retry-After': '5'})
        return
    why = hub.can_connect(ip)
    if why:
        hub.stats['refused'] += 1
        log('warn', 'ws_refused', ip=ip, why=why)
        await respond(writer, 503 if why == 'server-full' else 429, b'', None, False, extra={'Retry-After': '10'})
        return
    writer.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                  f'Sec-WebSocket-Accept: {ws_accept(key)}\r\n\r\n').encode('ascii'))
    await writer.drain()
    conn = WSConn(reader, writer, ip, hub)
    hub.connect(conn)
    # fwd — цепочка X-Forwarded-For: по ней видно, верно ли задан TRUST_PROXY (у разных игроков разные ip)
    log('info', 'ws_open', id=conn.id, ip=ip, fwd=h.get('x-forwarded-for'), origin=h.get('origin'))
    conn.send_json({'t': 'hello', 'v': 1, 'maxMessage': MAX_MSG, 'ping': PING_INTERVAL})
    await conn.run()
    log('info', 'ws_close', id=conn.id, ip=ip, code=conn.close_code, secs=round(time.monotonic() - conn.opened, 1),
        rx_msgs=conn.rx_msgs, tx_msgs=conn.tx_msgs, rx_bytes=conn.rx_bytes, tx_bytes=conn.tx_bytes,
        lossy_dropped=conn.lossy_dropped)


async def handle(reader, writer, hub: Hub) -> None:
    peer = writer.get_extra_info('peername')
    ip = peer[0] if isinstance(peer, tuple) and peer else '?'
    task = asyncio.current_task()
    hub.tasks.add(task)
    try:
        first = True
        for _ in range(200):
            try:
                req = await asyncio.wait_for(read_request(reader), 15 if first else IDLE_TIMEOUT)
            except asyncio.TimeoutError:
                break
            if req is None:
                break
            first = False
            await discard_body(req, reader)
            cip = client_ip(ip, req.headers)
            if req.path == '/ws' and 'upgrade' in req.headers:
                await websocket(req, reader, writer, hub, cip)
                return
            if not await serve_http(req, writer, hub, cip):
                break
    except HttpError as e:
        with contextlib.suppress(Exception):
            await respond(writer, e.status, error_page(e.status, e.msg), 'text/html; charset=utf-8', False)
    except (asyncio.IncompleteReadError, ConnectionError, OSError):
        pass
    except Exception as e:
        log('error', 'http_error', ip=ip, err=repr(e))
        with contextlib.suppress(Exception):
            await respond(writer, 500, error_page(500, 'Внутренняя ошибка сервера'), 'text/html; charset=utf-8', False)
    finally:
        hub.tasks.discard(task)
        with contextlib.suppress(Exception):
            writer.close()


async def main() -> None:
    if not os.path.isfile(os.path.join(ROOT, 'index.html')):
        log('warn', 'no_index', root=ROOT)
    hub = Hub()
    server = await asyncio.start_server(lambda r, w: handle(r, w, hub), HOST, PORT, limit=HEADER_LIMIT * 2, backlog=256)
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()

    def _stop(*_):
        loop.call_soon_threadsafe(stop.set)

    for name in ('SIGTERM', 'SIGINT', 'SIGBREAK'):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError, ValueError):
            with contextlib.suppress(Exception):
                signal.signal(sig, _stop)      # Windows: обработчик через поток цикла
    log('info', 'listen', host=HOST, port=PORT, root=ROOT, python=sys.version.split()[0], pid=os.getpid(),
        trust_proxy=TRUST_PROXY)
    janitor = asyncio.create_task(hub.janitor())
    try:
        await stop.wait()
    finally:
        log('info', 'shutdown', connections=len(hub.conns), rooms=len(hub.rooms))
        janitor.cancel()
        server.close()
        await hub.shutdown(5.0)
        for t in list(hub.tasks):
            t.cancel()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(server.wait_closed(), 3)
        log('info', 'stopped')


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
