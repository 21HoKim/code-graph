#pragma once

namespace net {

struct Peer { int port = 7000; const char* host = "localhost"; };
struct LinkCfg { Peer peer; int retries = 3; };
struct Config { LinkCfg link; bool verbose = false; };

struct Packet { int len = 0; char data[64]; };
using Frame = Packet;                  // another name for Packet

class Endpoint {
public:
  virtual ~Endpoint() = default;
  virtual void send(const Packet& p) = 0;
protected:
  int sent_ = 0;
};

class Link : public Endpoint {
public:
  explicit Link(Config& cfg);
  void open();
  void send(const Packet& p) override;
private:
  Config& cfg_;
  bool open_ = false;
};

}  // namespace net
