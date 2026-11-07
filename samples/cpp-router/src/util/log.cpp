#include "util/log.h"

#include <cstdarg>
#include <cstdio>
#include <mutex>

namespace util {
namespace {

std::mutex g_mu;
int g_level = 1;

void writeLine(const char* line) {
  std::fputs(line, stderr);
  std::fputc('\n', stderr);
}

}  // namespace

void setLevel(int level) { g_level = level; }

void log(const char* fmt, ...) {
  if (g_level <= 0) return;
  char buf[512];
  va_list ap;
  va_start(ap, fmt);
  std::vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  std::lock_guard<std::mutex> lock(g_mu);
  writeLine(buf);
}

}  // namespace util
