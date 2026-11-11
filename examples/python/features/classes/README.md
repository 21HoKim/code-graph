# Python · classes

Level *Class*: select a class and read its details panel.

- [ ] `models.Config`: *where its objects live* — parameter `cfg` of `Link.__init__`, attribute `Link.cfg`;
      `legacy.Config` is a different class (imported as `LegacyConfig`)
- [ ] `Peer.port`: read by `Link.connect` through `self.cfg.peer.port`
- [ ] `Config.peer`: written by `Link.retarget`; `Link.open`: written by `__init__` and `connect`, read by `main`
