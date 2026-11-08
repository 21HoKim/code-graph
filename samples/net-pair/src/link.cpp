#include "link.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <functional>
#include <iostream>
#include <thread>

#include "proto.hpp"

namespace net {

Link::Link(int fd) : fd_(fd) {}

Link::~Link() {
  if (fd_ >= 0) close(fd_);
}

bool Link::sendLine(const std::string &line) {
  const std::string out = line + '\n';
  size_t sent = 0;
  while (sent < out.size()) {
    const ssize_t n = send(fd_, out.data() + sent, out.size() - sent, MSG_NOSIGNAL);
    if (n <= 0) return false;
    sent += static_cast<size_t>(n);
  }
  return true;
}

bool Link::readLine(std::string &line) {
  for (;;) {
    const auto nl = pending_.find('\n');
    if (nl != std::string::npos) {
      line = pending_.substr(0, nl);
      pending_.erase(0, nl + 1);
      return true;
    }
    char buf[512];
    const ssize_t n = recv(fd_, buf, sizeof buf, 0);
    if (n <= 0) return false;
    pending_.append(buf, static_cast<size_t>(n));
  }
}

void Link::closeWrite() { shutdown(fd_, SHUT_WR); }

static sockaddr_in endpoint(const std::string &ip, int port) {
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons(static_cast<uint16_t>(port));
  inet_pton(AF_INET, ip.c_str(), &a.sin_addr);
  return a;
}

Server::Server(std::string ip, int port) : ip_(std::move(ip)), port_(port) {}

int Server::run() {
  const int fd = socket(AF_INET, SOCK_STREAM, 0);
  const int on = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on);
  sockaddr_in a = endpoint(ip_, port_);
  if (bind(fd, reinterpret_cast<sockaddr *>(&a), sizeof a) != 0 || listen(fd, 4) != 0) {
    std::cerr << "[node-b] cannot listen on " << ip_ << ':' << port_ << ": " << std::strerror(errno) << std::endl;
    close(fd);
    return 1;
  }
  std::cout << "[node-b] listening on " << ip_ << ':' << port_ << std::endl;
  const int peer = accept(fd, nullptr, nullptr);
  close(fd);
  if (peer < 0) return 1;
  Link link(peer);
  std::thread worker(&Server::serve, this, std::ref(link));
  worker.join();
  std::cout << "[node-b] peer left after " << handled_ << " messages" << std::endl;
  return handled_ > 0 ? 0 : 1;
}

void Server::serve(Link &link) {
  std::string line;
  while (link.readLine(line)) {
    Message m;
    if (!Message::decode(line, m) || !m.verify()) {
      std::cerr << "[node-b] bad message: " << line << std::endl;
      continue;
    }
    handled_++;
    link.sendLine(Message(m.seq(), "ack").encode());
  }
}

Client::Client(std::string peerIp, int port, int rounds) : peerIp_(std::move(peerIp)), port_(port), rounds_(rounds) {}

int Client::connectWithRetry() {
  for (int attempt = 0; attempt < 100; attempt++) {
    const int fd = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in a = endpoint(peerIp_, port_);
    if (connect(fd, reinterpret_cast<sockaddr *>(&a), sizeof a) == 0) return fd;
    close(fd);
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  return -1;
}

int Client::run() {
  const int fd = connectWithRetry();
  if (fd < 0) {
    std::cerr << "[node-a] cannot reach " << peerIp_ << ':' << port_ << std::endl;
    return 1;
  }
  Link link(fd);
  std::thread reader(&Client::readAcks, this, std::ref(link));
  for (int i = 1; i <= rounds_; i++) {
    link.sendLine(Message(i, "key-request-" + std::to_string(i)).encode());
    std::this_thread::sleep_for(std::chrono::milliseconds(40));
  }
  link.closeWrite();
  reader.join();
  std::cout << "[node-a] " << acked_ << '/' << rounds_ << " acknowledged" << std::endl;
  return acked_ == rounds_ ? 0 : 1;
}

void Client::readAcks(Link &link) {
  std::string line;
  while (link.readLine(line)) {
    Message m;
    if (Message::decode(line, m) && m.verify() && m.body() == "ack") acked_++;
  }
}

}  // namespace net
