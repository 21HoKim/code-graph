#pragma once
#include <string>

namespace net {

/** First 16 hex digits of SHA-256 (OpenSSL libcrypto). */
std::string digest(const std::string &data);

/** One line on the wire: "<seq> <body> <digest>", the digest covering seq and body. */
class Message {
 public:
  Message() = default;
  Message(int seq, std::string body);

  std::string encode() const;
  static bool decode(const std::string &line, Message &out);
  bool verify() const;

  int seq() const { return seq_; }
  const std::string &body() const { return body_; }

 private:
  int seq_ = 0;
  std::string body_;
  std::string digest_;
};

}  // namespace net
