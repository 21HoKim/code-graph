class Peer:
    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port


class Config:
    def __init__(self, peer: Peer) -> None:
        self.peer = peer
