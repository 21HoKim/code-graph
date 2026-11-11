from .pricing import discount


class Basket:
    def __init__(self) -> None:
        self.items: list[tuple[str, float]] = []

    def add(self, name: str, price: float) -> None:
        self.items.append((name, price))


class Cart(Basket):
    def add(self, name: str, price: float) -> None:
        super().add(name, discount(price, 0.0))      # super() and a module-level function

    def total(self) -> float:
        return sum(p for _, p in self.items)
