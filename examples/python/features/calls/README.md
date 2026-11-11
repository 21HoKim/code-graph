# Python · calls

Open this folder (levels: *Packages*, *Modules*, *Class*, *Function*).

- [ ] `main` ✚ `Cart` — imported from `shop`, which re-exports it from `shop/cart.py`
- [ ] `summary` → `discount` through the alias `off`; `main` → `tax` through `import shop.pricing as pricing`
- [ ] `Cart.add` → `Basket.add` through `super()`; `Cart` △ `Basket`
- [ ] `main` is an entry point (the `if __name__ == "__main__":` guard)
