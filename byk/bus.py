"""极简进程内事件总线，把回合进展推给 SSE 订阅者。"""
from __future__ import annotations

import queue
import threading
from collections import defaultdict
from typing import Any


class EventBus:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subs: dict[str, list[queue.Queue]] = defaultdict(list)

    def subscribe(self, key: str) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=1000)
        with self._lock:
            self._subs[key].append(q)
        return q

    def unsubscribe(self, key: str, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subs.get(key, []):
                self._subs[key].remove(q)
            if not self._subs.get(key):
                self._subs.pop(key, None)

    def publish(self, key: str, event: str, data: Any) -> None:
        with self._lock:
            subs = list(self._subs.get(key, []))
        for q in subs:
            try:
                q.put_nowait((event, data))
            except queue.Full:
                # 订阅者太慢时丢弃最旧的一帧，保证发布方永不阻塞
                try:
                    q.get_nowait()
                    q.put_nowait((event, data))
                except Exception:
                    pass
