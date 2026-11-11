"""Run & Trace: threads, argument and return values, one object shared by two threads, a callback seen at run time."""
import threading


class Ledger:
    def __init__(self):
        self.lock = threading.Lock()
        self.entries = []

    def add(self, who, amount):
        with self.lock:
            self.entries.append((who, amount))
        return len(self.entries)


def on_total(n):
    return n * 2


def work(ledger, who, report):
    for i in range(10):
        report(ledger.add(who, i))       # `report` is whatever was passed: on_total


def main():
    ledger = Ledger()
    ts = [threading.Thread(target=work, args=(ledger, name, on_total), name=name) for name in ("alice", "bob")]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    print(len(ledger.entries))


if __name__ == "__main__":
    main()
