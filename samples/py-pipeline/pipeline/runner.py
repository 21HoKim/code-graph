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
        threading.Thread(target=self._dispatch, name="dispatch", daemon=True).start()

    def _pump(self, src: Source) -> None:
        while not self._stop.is_set():
            self.inbox.put(src.read())

    def _dispatch(self) -> None:
        while not self._stop.is_set():
            frame = self.inbox.get()
            fut = self.pool.submit(process_frame, frame)
            fut.add_done_callback(self._collect)

    def _collect(self, fut) -> None:
        spikes = fut.result()
        self.aggregator.add(spikes)
        if spikes:
            self.sink.emit({"spikes": spikes})

    def stop(self) -> dict:
        self._stop.set()
        self.pool.shutdown(wait=False)
        return self.aggregator.summary()
