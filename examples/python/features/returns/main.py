"""Calls in return, await and yield from are calls of the function; nested functions and lambdas return for themselves."""
import asyncio


def base(x):
    return x + 1


def pick(x):
    return base(x) if x > 0 else base(-x)


def numbers(n):
    yield from (base(i) for i in range(n))


async def later(x):
    return await asyncio.sleep(0, result=base(x))


def outer(x):
    def inner(y):
        return pick(y)          # inner's return, not outer's
    f = lambda y: base(y)       # the lambda's
    print(inner(x), f(x))


if __name__ == "__main__":
    outer(pick(-2))
    print(list(numbers(3)), asyncio.run(later(1)))
