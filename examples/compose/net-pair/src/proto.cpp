#include "proto.hpp"

#include <openssl/evp.h>

#include <sstream>

namespace net {

std::string digest(const std::string &data) {
  unsigned char md[EVP_MAX_MD_SIZE];
  unsigned int len = 0;
  EVP_Digest(data.data(), data.size(), md, &len, EVP_sha256(), nullptr);
  static const char *hex = "0123456789abcdef";
  std::string out;
  for (unsigned int i = 0; i < len && out.size() < 16; i++) {
    out += hex[md[i] >> 4];
    out += hex[md[i] & 15];
  }
  return out;
}

Message::Message(int seq, std::string body) : seq_(seq), body_(std::move(body)) {
  digest_ = digest(std::to_string(seq_) + ' ' + body_);
}

std::string Message::encode() const {
  return std::to_string(seq_) + ' ' + body_ + ' ' + digest_;
}

bool Message::decode(const std::string &line, Message &out) {
  std::istringstream in(line);
  if (!(in >> out.seq_ >> out.body_ >> out.digest_)) return false;
  return true;
}

bool Message::verify() const {
  return digest_ == digest(std::to_string(seq_) + ' ' + body_);
}

}  // namespace net
