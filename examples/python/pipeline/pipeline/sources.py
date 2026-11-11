"""Sensor sources produce raw frames."""
import random
import time
from dataclasses import dataclass


@dataclass
class Frame:
    sensor: str
    ts: float
    raw: bytes


class Source:
    """Base class for all sources."""

    def __init__(self, name: str):
        self.name = name

    def read(self) -> Frame:
        raise NotImplementedError

    def frames(self, n: int):
        for _ in range(n):
            yield self.read()


class SensorSource(Source):
    def __init__(self, name: str, rate_hz: float = 50.0):
        super().__init__(name)
        self.rate_hz = rate_hz

    def read(self) -> Frame:
        time.sleep(1.0 / self.rate_hz)
        return Frame(self.name, time.time(), bytes(random.getrandbits(8) for _ in range(16)))


class ReplaySource(Source):
    def __init__(self, path: str):
        super().__init__("replay")
        self._fh = open(path, "rb")

    def read(self) -> Frame:
        return Frame(self.name, time.time(), self._fh.read(16))
