/*
 * CodeGraph: C++ part of the runtime tracer. Records the type and what() of
 * an uncaught exception before std::terminate aborts, so the crash report says
 * "std::out_of_range: vector::_M_range_check …" instead of just SIGABRT.
 */
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <typeinfo>
#if defined(__GNUC__) || defined(__clang__)
#include <cxxabi.h>
#endif

extern "C" void cgt_note_exception(const char *what);

namespace {
std::terminate_handler g_prev = nullptr;

void on_terminate() {
  if (std::exception_ptr e = std::current_exception()) {
    char msg[240];
    try {
      std::rethrow_exception(e);
    } catch (const std::exception &ex) {
      const char *type = typeid(ex).name();
#if defined(__GNUC__) || defined(__clang__)
      int st = 0;
      char *dem = abi::__cxa_demangle(type, nullptr, nullptr, &st);
      std::snprintf(msg, sizeof msg, "uncaught %s: %s", st == 0 && dem ? dem : type, ex.what());
      std::free(dem);
#else
      std::snprintf(msg, sizeof msg, "uncaught %s: %s", type, ex.what());
#endif
      cgt_note_exception(msg);
    } catch (...) {
      cgt_note_exception("uncaught exception (not derived from std::exception)");
    }
  }
  if (g_prev) g_prev();
  std::abort();
}

struct Init {
  Init() { g_prev = std::set_terminate(on_terminate); }
} init;
}  // namespace
