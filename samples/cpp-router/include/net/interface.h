#pragma once
#include <string>

#include "net/packet.h"

namespace net {

class Interface {
 public:
  explicit Interface(std::string name) : name_(std::move(name)) {}
  virtual ~Interface() = default;
  virtual bool send(const Packet& pkt) = 0;
  const std::string& name() const { return name_; }

 protected:
  std::string name_;
};

class EthInterface : public Interface {
 public:
  explicit EthInterface(std::string name);
  bool send(const Packet& pkt) override;

 private:
  int fd_ = -1;
};

class LoopbackInterface : public Interface {
 public:
  LoopbackInterface() : Interface("lo") {}
  bool send(const Packet& pkt) override;
};

}  // namespace net
