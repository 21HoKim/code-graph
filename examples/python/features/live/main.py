"""Runs until you press Stop: workers and a flusher, something to watch in the live view."""
import threading
import time

handled = 0


def parse(i):
    return i % 7


def store(v):
    global handled
    handled += v
    time.sleep(0.001)


def handle(i):
    store(parse(i))


def serve(offset):
    i = 0
    while True:
        handle(i + offset)
        i += 1
        if i % 50 == 0:
            time.sleep(0.02)


def flush():
    while True:
        store(-1)
        time.sleep(0.2)


def main():
    for k in range(2):
        threading.Thread(target=serve, args=(k,), daemon=True, name=f"serve-{k}").start()
    flush()


if __name__ == "__main__":
    main()
