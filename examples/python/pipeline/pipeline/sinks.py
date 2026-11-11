import json
import threading


class ConsoleSink:
    def __init__(self):
        self._lock = threading.Lock()

    def emit(self, record: dict) -> None:
        with self._lock:
            print(json.dumps(record))


class FileSink(ConsoleSink):
    def __init__(self, path: str):
        super().__init__()
        self.path = path

    def emit(self, record: dict) -> None:
        with self._lock, open(self.path, "a") as fh:
            fh.write(json.dumps(record) + "\n")
