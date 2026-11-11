"""What the class panel shows: attribute types, family, where objects live, who reads and writes each attribute."""
from models import Config, Peer
from legacy import Config as LegacyConfig      # the same class name in another module stays apart


class Link:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg                         # the attribute gets the parameter's type
        self.open = False

    def connect(self) -> None:
        if self.cfg.peer.port > 0:             # reads Config.peer → Peer.port
            self.open = True                   # writes Link.open

    def retarget(self, peer: Peer) -> None:
        self.cfg.peer = peer                   # writes Config.peer


def main() -> None:
    link = Link(Config(Peer("localhost", 7000)))
    link.connect()
    link.retarget(Peer("backup", 7001))
    print(link.open, LegacyConfig().name)


if __name__ == "__main__":
    main()
