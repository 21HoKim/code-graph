"""Processing stages: pure functions plus a stateful aggregator."""
from statistics import mean

from .sources import Frame


def decode(frame: Frame) -> list[int]:
    return list(frame.raw)


def denoise(samples: list[int], window: int = 3) -> list[float]:
    out = []
    for i in range(len(samples)):
        chunk = samples[max(0, i - window + 1) : i + 1]
        out.append(mean(chunk))
    return out


def detect_spikes(values: list[float], threshold: float = 200.0) -> list[int]:
    return [i for i, v in enumerate(values) if v > threshold]


class Aggregator:
    def __init__(self):
        self.count = 0
        self.spikes = 0

    def add(self, spikes: list[int]) -> None:
        self.count += 1
        self.spikes += len(spikes)

    def summary(self) -> dict:
        return {"frames": self.count, "spikes": self.spikes}
