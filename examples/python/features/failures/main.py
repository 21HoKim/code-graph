"""An uncaught exception in a thread and one in the main thread: both functions turn red, with the traceback."""
import threading


def average(xs):
    return sum(xs) / len(xs)


def worker(box):
    box.append(average([]))          # ZeroDivisionError in the thread "calc"


def main():
    box = []
    t = threading.Thread(target=worker, args=(box,), name="calc")
    t.start()
    t.join()
    print(box[0])                    # IndexError in the main thread


if __name__ == "__main__":
    main()
