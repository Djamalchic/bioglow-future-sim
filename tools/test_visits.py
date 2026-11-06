"""Самопроверка счётчика посещений без сети (Telegram подменён): python tools/test_visits.py"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
os.environ.update(TG_BOT_TOKEN='test', TG_CHAT_ID='1', RENDER_EXTERNAL_URL='https://example.onrender.com')
import server  # noqa: E402

msgs: dict[int, str] = {}
pinned: list[int] = []
sent: list[str] = []


def fake_tg(method, **p):
    if method == 'getChat':
        return {'id': 1, **({'pinned_message': {'message_id': pinned[-1], 'text': msgs[pinned[-1]]}} if pinned else {})}
    if method == 'sendMessage':
        mid = len(msgs) + 1
        msgs[mid] = p['text']
        sent.append(p['text'])
        return {'message_id': mid}
    if method == 'editMessageText':
        msgs[p['message_id']] = p['text']
        return {}
    if method == 'pinChatMessage':
        pinned.append(p['message_id'])
        return True
    raise AssertionError(method)


day = ['2026-11-07']
server.tg = fake_tg
server.local_day = lambda: day[0]
reports = lambda: [t for t in sent if 'Посетителей за день' in t]  # noqa: E731


async def main():
    v = server.Visits()
    for _ in range(3):
        v.hit('1.2.3.4')
    for _ in range(70):
        v.hit('5.6.7.8')                       # накрутка с одного адреса упирается в VISITS_PER_IP
    assert v.count == 3 + server.VISITS_PER_IP, v.count
    await v.tick()                             # первое сохранение: новое сообщение и закрепление
    assert len(pinned) == 1 and '"n":63' in msgs[pinned[-1]]

    v2 = server.Visits()                       # перезапуск в тот же день: счёт продолжается
    v2.hit('9.9.9.9')
    await v2.tick()
    assert v2.count == 64 and '"n":64' in msgs[pinned[-1]] and len(pinned) == 1

    day[0] = '2026-11-08'                      # полночь, сервер не спал
    await v2.tick()
    assert len(reports()) == 1 and 'Посетителей за день: 64' in reports()[0] and '07.11.2026' in reports()[0]
    assert 'https://example.onrender.com/visits.csv' in reports()[0]

    v3 = server.Visits()                       # перезапуск после отчёта — повторного нет
    await v3.tick()
    assert len(reports()) == 1 and v3.hist == {'2026-11-07': 64} and v3.count == 0
    v3.hit('1.1.1.1')
    await v3.tick()

    day[0] = '2026-11-09'                      # сервер проспал полночь: отчёт уходит при следующем старте
    v4 = server.Visits()
    await v4.tick()
    assert len(reports()) == 2 and 'Посетителей за день: 1' in reports()[1]
    assert 'За 7 дней: 65' in reports()[1]
    assert v4.csv() == 'date,visitors\n2026-11-07,64\n2026-11-08,1\n2026-11-09,0\n', v4.csv()


asyncio.run(main())
print('visits: ok')
