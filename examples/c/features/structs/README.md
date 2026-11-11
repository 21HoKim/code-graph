# C · structs

Select a struct block (level *Class*, or open `buffer.h`) and read its details panel.

- [ ] `buffer`: members `data`, `len`; *where its objects live*: `pool.free` (written as the typedef `buffer_t`),
      parameters `b` of `buf_init` and `buf_len`
- [ ] *Where members are read and written*: `len` — written by `buf_init`, read by `buf_len`
- [ ] `pool`: `free` written by `pool_init`, `size` read by `main`
