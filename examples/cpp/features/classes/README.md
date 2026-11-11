# C++ · classes

Level *Class*: select a class and read its details panel.

- [ ] `Packet`: also known as `Frame`; *where its objects live*: parameter `p` of `Endpoint::send` / `Link::send`
- [ ] `Peer.port`: written by `Link::open` (through `cfg_.link.peer.port`), read by `main` (through `cfg.link.peer.port`)
- [ ] `Endpoint.sent_`: written by `Link::send` — a member of the base class
- [ ] `Link` △ `Endpoint`; `Config` holds `LinkCfg` holds `Peer` (*where its objects live*: members of other classes)
