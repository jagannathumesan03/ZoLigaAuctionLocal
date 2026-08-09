"""Simple in-memory SSE broadcaster shared across the app."""
import asyncio
import json


class Broadcaster:
    def __init__(self):
        self._subscribers: list[asyncio.Queue] = []

    async def subscribe(self):
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self._subscribers:
            self._subscribers.remove(q)

    async def publish(self, event: str, data: dict):
        payload = json.dumps(data)
        for q in list(self._subscribers):
            await q.put((event, payload))


broadcaster = Broadcaster()


async def event_stream(request):
    q = await broadcaster.subscribe()
    try:
        # initial comment to open the stream promptly
        yield ": connected\n\n"
        while True:
            if await request.is_disconnected():
                break
            try:
                event, payload = await asyncio.wait_for(q.get(), timeout=15)
                yield f"event: {event}\ndata: {payload}\n\n"
            except asyncio.TimeoutError:
                yield ": keep-alive\n\n"
    finally:
        broadcaster.unsubscribe(q)
