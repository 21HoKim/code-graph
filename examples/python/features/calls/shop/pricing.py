def discount(amount: float, rate: float) -> float:
    return round(amount * (1 - rate), 2)


def tax(amount: float) -> float:
    return round(amount * 0.08, 2)
