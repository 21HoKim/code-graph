"""Every way of starting a thread or a task that CodeGraph recognises, under any import name."""
import asyncio
import threading
import threading as th
from concurrent.futures import ThreadPoolExecutor
from threading import Thread as T


def w1(): pass
def w2(): pass
def w3(): pass
def w4(n): return n * 2
def tick(): pass


class Poller(threading.Thread):
    def run(self):                      # a Thread subclass: start() runs run()
        w1()


async def fetch(n):
    await asyncio.sleep(0)
    return n


async def gather_all():
    t = asyncio.create_task(fetch(1))
    await asyncio.gather(fetch(2), fetch(3))
    await asyncio.to_thread(w2)
    await t


def main():
    threads = [threading.Thread(target=w1), th.Thread(target=w2), T(target=w3), Poller()]
    for t in threads:
        t.start()
    timer = threading.Timer(0.01, tick)
    timer.start()
    with ThreadPoolExecutor(max_workers=2) as pool:
        pool.submit(w4, 1)
        list(pool.map(w4, [2, 3]))
    asyncio.run(gather_all())
    for t in threads:
        t.join()
    timer.join()


if __name__ == "__main__":
    main()
