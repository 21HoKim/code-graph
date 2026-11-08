#pragma once
#include <string>

namespace net {

/** A TCP connection carrying text lines. */
class Link {
 public:
  explicit Link(int fd);
  ~Link();
  Link(const Link &) = delete;
  Link &operator=(const Link &) = delete;

  bool sendLine(const std::string &line);
  bool readLine(std::string &line);
  void closeWrite();

 private:
  int fd_;
  std::string pending_;
};

/** Accepts one peer and acknowledges each of its messages until it hangs up. */
class Server {
 public:
  Server(std::string ip, int port);
  int run();

 private:
  void serve(Link &link);
  std::string ip_;
  int port_;
  int handled_ = 0;
};

/** Connects to the peer, sends `rounds` messages and checks the acknowledgements on a reader thread. */
class Client {
 public:
  Client(std::string peerIp, int port, int rounds);
  int run();

 private:
  int connectWithRetry();
  void readAcks(Link &link);
  std::string peerIp_;
  int port_;
  int rounds_;
  int acked_ = 0;
};

}  // namespace net
