"""Wires sources -> stages -> sinks: one pump thread per source plus a worker pool."""
import queue
import threading
from concurrent.futures import ThreadPoolExecutor

from . import stages
from .sinks import ConsoleSink
from .sources import Frame, Source
from .stages import Aggregator


def process_frame(frame: Frame) -> list[int]:
    samples = stages.decode(frame)
    smooth = stages.denoise(samples)
    return stages.detect_spikes(smooth)


class Runner:
    def __init__(self, sources: list[Source], workers: int = 4):
        self.sources = sources
        self.inbox: "queue.Queue[Frame]" = queue.Queue(maxsize=256)
        self.aggregator = Aggregator()
        self.sink = ConsoleSink()
        self.pool = ThreadPoolExecutor(max_workers=workers)
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        for src in self.sources:
            t = threading.Thread(target=self._pump, args=(src,), name=f"pump-{src.name}", daemon=True)
            t.start()
            self._threads.append(t)
        d = threading.Thread(target=self._dispatch, name="dispatch", daemon=True)
        d.start()
        self._threads.append(d)

    def _pump(self, src: Source) -> None:
        while not self._stop.is_set():
            try:
                self.inbox.put(src.read(), timeout=0.1)
            except queue.Full:
                continue

    def _dispatch(self) -> None:
        while not self._stop.is_set():
            try:
                frame = self.inbox.get(timeout=0.1)
            except queue.Empty:
                continue
            fut = self.pool.submit(process_frame, frame)
            fut.add_done_callback(self._collect)

    def _collect(self, fut) -> None:
        spikes = fut.result()
        self.aggregator.add(spikes)
        if spikes:
            self.sink.emit({"spikes": spikes})

    def stop(self) -> dict:
        # let every thread see the stop and finish before the pool goes: nothing may still be
        # running (or printing) while the interpreter shuts down
        self._stop.set()
        for t in self._threads:
            t.join(timeout=2.0)
        self.pool.shutdown(wait=True)
        return self.aggregator.summary()
