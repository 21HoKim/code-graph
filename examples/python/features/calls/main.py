"""Calls CodeGraph draws for Python: imports in every form, methods, super(), a package that re-exports."""
import json
import shop.pricing as pricing
from shop import Cart                      # re-exported by shop/__init__.py
from shop.pricing import discount as off   # an alias


def summary(cart: Cart) -> str:
    return json.dumps({"total": cart.total(), "after": off(cart.total(), 0.1)})


def main() -> None:
    cart = Cart()
    cart.add("tea", 3.0)
    cart.add("cake", 4.5)
    print(summary(cart), pricing.tax(cart.total()))


if __name__ == "__main__":
    main()
