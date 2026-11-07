/*
 * CodeGraph runtime tracer for C and C++ — force-included (-include) into
 * the instrumented copy that Run & Trace builds. Never part of your sources.
 *
 * The instrumenter inserts one statement at the top of every function body,
 * on the same line as the opening brace (so compiler line numbers stay the same):
 *
 *   C++   ::cgt::scope cgt_s_(17, this); ::cgt::arg("n", n, 0);
 *   C     __attribute__((cleanup(cgt_cleanup_), unused)) unsigned cgt_f_ = (cgt_enter(17, 0), cgt_arg_i("n", (long long)(n)), 17u);
 *
 * cgt_enter/cgt_leave write per-thread call events; cgt_arg_* attach a short
 * summary of each argument. Pointers and references are recorded with their
 * address so one object can be followed across calls and threads.
 */
#ifndef CODE_GRAPH_TRACE_H
#define CODE_GRAPH_TRACE_H

#ifdef __cplusplus
extern "C" {
#endif

void cgt_enter(unsigned fid, const void *self);
void cgt_leave(unsigned fid);
int cgt_values(void);
void cgt_arg_i(const char *name, long long v);
void cgt_arg_u(const char *name, unsigned long long v);
void cgt_arg_d(const char *name, double v);
void cgt_arg_b(const char *name, int v);
void cgt_arg_s(const char *name, const char *v);
void cgt_arg_p(const char *name, const void *p);
void cgt_arg_c(const char *name, const void *p, unsigned long long size);
void cgt_note_exception(const char *what);

static __inline__ void cgt_cleanup_(unsigned *fid) { cgt_leave(*fid); }

#ifdef __cplusplus
} /* extern "C" */

#if __cplusplus < 201103L && !defined(_MSVC_LANG)
/* C++98/03: calls are traced, argument values are not */
namespace cgt {
struct scope {
  unsigned f;
  scope(unsigned fid, const void *self) : f(fid) { cgt_enter(fid, self); }
  ~scope() { cgt_leave(f); }
};
template <class T> inline void arg(const char *, const T &, int) {}
} /* namespace cgt */
#else
#include <type_traits>

namespace cgt {

struct scope {
  unsigned f;
  scope(unsigned fid, const void *self) : f(fid) { cgt_enter(fid, self); }
  ~scope() { cgt_leave(f); }
  scope(const scope &) = delete;
  scope &operator=(const scope &) = delete;
};

template <int N> struct rank : rank<N - 1> {};
template <> struct rank<0> {};

/* class types, best match first: string-like, smart pointer, container, any object */
template <class T>
inline auto cls(const char *n, const T &v, int, rank<4>) -> decltype((void)v.c_str(), void()) {
  cgt_arg_s(n, v.c_str());
}
template <class T>
inline auto cls(const char *n, const T &v, int, rank<3>) -> decltype((void)(v.get() == nullptr), void()) {
  cgt_arg_p(n, (const void *)v.get());
}
template <class T>
inline auto cls(const char *n, const T &v, int, rank<2>) -> decltype((void)v.size(), (void)v.begin(), void()) {
  cgt_arg_c(n, (const void *)&v, (unsigned long long)v.size());
}
/* by reference: the address is the object's identity; by value it is just a copy */
template <class T> inline void cls(const char *n, const T &v, int byRef, rank<1>) { cgt_arg_p(n, byRef ? (const void *)&v : (const void *)0); }

inline void ptr(const char *n, const char *s) { cgt_arg_s(n, s); }
inline void ptr(const char *n, char *s) { cgt_arg_s(n, s); }
template <class P> inline typename std::enable_if<!std::is_function<P>::value>::type ptr(const char *n, P *p) {
  cgt_arg_p(n, (const void *)p);
}
template <class P> inline typename std::enable_if<std::is_function<P>::value>::type ptr(const char *, P *) {}

template <class T> struct cat {
  static const int value = std::is_same<T, bool>::value ? 1
                           : std::is_integral<T>::value ? (std::is_signed<T>::value ? 2 : 3)
                           : std::is_floating_point<T>::value ? 4
                           : std::is_enum<T>::value ? 5
                           : std::is_pointer<T>::value ? 6
                           : (std::is_class<T>::value || std::is_union<T>::value) ? 7
                                                                                   : 0;
};
template <int C> struct tag {};

template <class T> inline void put(const char *n, const T &v, int, tag<1>) { cgt_arg_b(n, v ? 1 : 0); }
template <class T> inline void put(const char *n, const T &v, int, tag<2>) { cgt_arg_i(n, (long long)v); }
template <class T> inline void put(const char *n, const T &v, int, tag<3>) { cgt_arg_u(n, (unsigned long long)v); }
template <class T> inline void put(const char *n, const T &v, int, tag<4>) { cgt_arg_d(n, (double)v); }
template <class T> inline void put(const char *n, const T &v, int, tag<5>) { cgt_arg_i(n, (long long)v); }
template <class T> inline void put(const char *n, const T &v, int, tag<6>) { ptr(n, v); }
template <class T> inline void put(const char *n, const T &v, int byRef, tag<7>) { cls(n, v, byRef, rank<4>()); }
template <class T> inline void put(const char *, const T &, int, tag<0>) {}

template <class T> inline void arg(const char *n, const T &v, int byRef) {
  if (cgt_values()) put(n, v, byRef, tag<cat<T>::value>());
}

} /* namespace cgt */
#endif /* C++11 */
#endif /* __cplusplus */

#endif /* CODE_GRAPH_TRACE_H */
