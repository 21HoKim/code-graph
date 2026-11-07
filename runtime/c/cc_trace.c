/*
 * CodeCurrent runtime tracer for C and C++ programs (Linux, macOS; gcc or clang).
 *
 * Linked into the instrumented build made by Run & Trace. Inactive unless the
 * environment variable CODE_CURRENT_TRACE names an output file, so the
 * instrumented binary behaves exactly like the original otherwise.
 *
 *   CODE_CURRENT_TRACE       output path (JSON lines, schema code-current-trace/1)
 *   CODE_CURRENT_MAX_EVENTS  detailed events to record (default 200000); call counts continue after that
 *   CODE_CURRENT_VALUES      0 = do not record argument values
 *
 * Every thread buffers its own events and appends them to the file under one
 * mutex. A per-thread shadow stack (fids of the active calls) lets a crash be
 * attributed to the function that was running, in every thread.
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#ifndef CCT_NFN
#define CCT_NFN 1
#endif

#define CCT_BUF (64 * 1024)
#define CCT_DEPTH 256
#define CCT_MAX_THREADS 1024

typedef struct cct_ts {
  int id;
  int depth;
  int open; /* 0: no open call line · 1: open, no args yet · 2: open with args */
  int done;
  unsigned stack[CCT_DEPTH];
  size_t len;
  char buf[CCT_BUF];
} cct_ts;

static FILE *g_out;
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t g_once = PTHREAD_ONCE_INIT;
static pthread_key_t g_key;
static volatile int g_on;
static int g_values = 1;
static long long g_max = 200000;
static long long g_events;
static long long g_dropped;
static uint64_t g_t0;
static cct_ts *g_threads[CCT_MAX_THREADS];
static int g_nthreads;
static unsigned long long g_calls[CCT_NFN];
static char g_exc[256];
static __thread cct_ts *t_ts;
static __thread int t_busy;

static uint64_t cct_now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec - g_t0;
}

static void cct_write_locked(const char *s, size_t n) {
  if (g_out && n) fwrite(s, 1, n, g_out);
}

static void cct_flush(cct_ts *ts) {
  if (!ts->len) return;
  pthread_mutex_lock(&g_mu);
  cct_write_locked(ts->buf, ts->len);
  pthread_mutex_unlock(&g_mu);
  ts->len = 0;
}

static void cct_put(cct_ts *ts, const char *s, size_t n) {
  if (ts->len + n >= CCT_BUF) cct_flush(ts);
  if (n >= CCT_BUF) return;
  memcpy(ts->buf + ts->len, s, n);
  ts->len += n;
}

static void cct_putf(cct_ts *ts, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
#include <stdarg.h>
static void cct_putf(cct_ts *ts, const char *fmt, ...) {
  char tmp[512];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(tmp, sizeof tmp, fmt, ap);
  va_end(ap);
  if (n > 0) cct_put(ts, tmp, (size_t)(n < (int)sizeof tmp ? n : (int)sizeof tmp - 1));
}

/* JSON string body: quotes, backslashes and control characters escaped, at most `max` bytes */
static void cct_put_str(cct_ts *ts, const char *s, size_t max) {
  char tmp[400];
  size_t o = 0, i = 0;
  tmp[o++] = '"';
  for (; s[i] && i < max && o < sizeof tmp - 12; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"' || c == '\\') {
      tmp[o++] = '\\';
      tmp[o++] = (char)c;
    } else if (c < 0x20) {
      o += (size_t)snprintf(tmp + o, sizeof tmp - o, "\\u%04x", c);
    } else
      tmp[o++] = (char)c;
  }
  if (s[i]) {
    memcpy(tmp + o, "\xe2\x80\xa6", 3); /* … */
    o += 3;
  }
  tmp[o++] = '"';
  cct_put(ts, tmp, o);
}

static void cct_close(cct_ts *ts) {
  if (ts->open) {
    cct_put(ts, "]]\n", 3);
    ts->open = 0;
  }
}

static void cct_thread_exit(void *p) {
  cct_ts *ts = (cct_ts *)p;
  if (!ts || ts->done) return;
  if (g_on) {
    cct_close(ts);
    cct_putf(ts, "[\"e\",%llu,%d]\n", (unsigned long long)cct_now(), ts->id);
    cct_flush(ts);
  }
  ts->done = 1;
}

static void cct_finish(void);
static void cct_finish_impl(int lock);
static void cct_on_signal(int sig);
static char g_main_name[64];

static void cct_init(void) {
  const char *path = getenv("CODE_CURRENT_TRACE");
  if (!path || !*path) return;
  const char *m = getenv("CODE_CURRENT_MAX_EVENTS");
  if (m && *m) g_max = atoll(m);
  const char *v = getenv("CODE_CURRENT_VALUES");
  if (v && (*v == '0' || *v == 'f' || *v == 'o')) g_values = 0;
  g_out = fopen(path, "w");
  if (!g_out) return;
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  g_t0 = (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
  fprintf(g_out, "{\"k\":\"h\",\"schema\":\"code-current-trace/1\",\"lang\":\"%s\",\"clock\":\"ns\",\"pid\":%d,\"fns\":%d}\n",
#ifdef CCT_LANG_CPP
          "cpp",
#else
          "c",
#endif
          (int)getpid(), CCT_NFN);
  pthread_key_create(&g_key, cct_thread_exit);
  atexit(cct_finish);
  int sigs[] = {SIGSEGV, SIGFPE, SIGILL, SIGABRT, SIGTERM, SIGINT,
#ifdef SIGBUS
                SIGBUS,
#endif
  };
  for (size_t i = 0; i < sizeof sigs / sizeof sigs[0]; i++) signal(sigs[i], cct_on_signal);
  g_on = 1;
}

static cct_ts *cct_thread(void) {
  cct_ts *ts = t_ts;
  if (ts) return ts;
  pthread_once(&g_once, cct_init);
  if (!g_on) return 0;
  ts = (cct_ts *)calloc(1, sizeof(cct_ts));
  if (!ts) return 0;
  pthread_mutex_lock(&g_mu);
  ts->id = ++g_nthreads;
  if (ts->id <= CCT_MAX_THREADS) g_threads[ts->id - 1] = ts;
  pthread_mutex_unlock(&g_mu);
  t_ts = ts;
  pthread_setspecific(g_key, ts);
  char name[64] = "";
#if defined(__linux__) || defined(__APPLE__)
  pthread_getname_np(pthread_self(), name, sizeof name);
#endif
  if (ts->id == 1) {
    /* threads inherit the process name until they set their own */
    memcpy(g_main_name, name, sizeof g_main_name);
    snprintf(name, sizeof name, "main");
  } else if (!name[0] || strcmp(name, g_main_name) == 0)
    snprintf(name, sizeof name, "thread-%d", ts->id);
  cct_putf(ts, "{\"k\":\"t\",\"id\":%d,\"t\":%llu,\"name\":", ts->id, (unsigned long long)cct_now());
  cct_put_str(ts, name, 60);
  cct_put(ts, "}\n", 2);
  return ts;
}

static int cct_take_event(void) {
  long long n = __atomic_add_fetch(&g_events, 1, __ATOMIC_RELAXED);
  if (n <= g_max) return 1;
  __atomic_add_fetch(&g_dropped, 1, __ATOMIC_RELAXED);
  return 0;
}

void cct_enter(unsigned fid, const void *self) {
  if (t_busy) return;
  cct_ts *ts = cct_thread();
  if (!ts || !g_on || ts->done) return;
  t_busy = 1;
  if (fid < CCT_NFN) __atomic_add_fetch(&g_calls[fid], 1, __ATOMIC_RELAXED);
  if (ts->depth < CCT_DEPTH) ts->stack[ts->depth] = fid;
  ts->depth++;
  cct_close(ts);
  if (cct_take_event()) {
    if (self)
      cct_putf(ts, "[\"c\",%llu,%d,%u,\"%p\",[", (unsigned long long)cct_now(), ts->id, fid, self);
    else
      cct_putf(ts, "[\"c\",%llu,%d,%u,null,[", (unsigned long long)cct_now(), ts->id, fid);
    ts->open = 1;
  }
  t_busy = 0;
}

void cct_leave(unsigned fid) {
  if (t_busy) return;
  cct_ts *ts = t_ts;
  if (!ts || !g_on || ts->done) return;
  t_busy = 1;
  if (ts->depth > 0) ts->depth--;
  cct_close(ts);
  if (cct_take_event()) cct_putf(ts, "[\"r\",%llu,%d,%u]\n", (unsigned long long)cct_now(), ts->id, fid);
  t_busy = 0;
}

int cct_values(void) { return g_values && t_ts && t_ts->open; }

static cct_ts *cct_arg_begin(const char *name) {
  cct_ts *ts = t_ts;
  if (!ts || !ts->open || !g_values) return 0;
  if (ts->open == 2) cct_put(ts, ",", 1);
  ts->open = 2;
  cct_putf(ts, "[\"%s\",", name);
  return ts;
}

void cct_arg_i(const char *name, long long v) {
  cct_ts *ts = cct_arg_begin(name);
  if (ts) cct_putf(ts, "\"i\",\"%lld\"]", v);
}
void cct_arg_u(const char *name, unsigned long long v) {
  cct_ts *ts = cct_arg_begin(name);
  if (ts) cct_putf(ts, "\"i\",\"%llu\"]", v);
}
void cct_arg_d(const char *name, double v) {
  cct_ts *ts = cct_arg_begin(name);
  if (ts) cct_putf(ts, "\"d\",\"%.6g\"]", v);
}
void cct_arg_b(const char *name, int v) {
  cct_ts *ts = cct_arg_begin(name);
  if (ts) cct_putf(ts, "\"b\",\"%s\"]", v ? "true" : "false");
}
void cct_arg_s(const char *name, const char *s) {
  cct_ts *ts = cct_arg_begin(name);
  if (!ts) return;
  if ((uintptr_t)s < 4096) {
    cct_put(ts, "\"n\",\"NULL\"]", 11);
    return;
  }
  cct_put(ts, "\"s\",", 4);
  cct_put_str(ts, s, 48);
  cct_putf(ts, ",\"%p\"]", (const void *)s);
}
void cct_arg_p(const char *name, const void *p) {
  cct_ts *ts = cct_arg_begin(name);
  if (!ts) return;
  if (!p)
    cct_put(ts, "\"n\",\"null\"]", 11);
  else
    cct_putf(ts, "\"o\",\"%p\",\"%p\"]", p, p);
}
void cct_arg_c(const char *name, const void *p, unsigned long long size) {
  cct_ts *ts = cct_arg_begin(name);
  if (ts) cct_putf(ts, "\"c\",\"size %llu\",\"%p\",%llu]", size, p, size);
}

void cct_note_exception(const char *what) {
  if (!what) return;
  strncpy(g_exc, what, sizeof g_exc - 1);
  g_exc[sizeof g_exc - 1] = 0;
}

static void cct_finish(void) { cct_finish_impl(1); }

static void cct_finish_impl(int lock) {
  if (!g_on) return;
  g_on = 0;
  if (lock) pthread_mutex_lock(&g_mu);
  int n = g_nthreads < CCT_MAX_THREADS ? g_nthreads : CCT_MAX_THREADS;
  for (int i = 0; i < n; i++) {
    cct_ts *ts = g_threads[i];
    if (!ts) continue;
    if (ts->open) {
      memcpy(ts->buf + (ts->len < CCT_BUF - 4 ? ts->len : CCT_BUF - 4), "]]\n", 3);
      ts->len = (ts->len < CCT_BUF - 4 ? ts->len : CCT_BUF - 4) + 3;
      ts->open = 0;
    }
    cct_write_locked(ts->buf, ts->len);
    ts->len = 0;
  }
  if (g_out) {
    fputs("{\"k\":\"agg\",\"calls\":[", g_out);
    int first = 1;
    for (unsigned i = 0; i < CCT_NFN; i++) {
      if (!g_calls[i]) continue;
      fprintf(g_out, "%s[%u,%llu]", first ? "" : ",", i, g_calls[i]);
      first = 0;
    }
    fprintf(g_out, "]}\n{\"k\":\"end\",\"t\":%llu,\"events\":%lld,\"dropped\":%lld}\n", (unsigned long long)cct_now(),
            g_events < g_max ? g_events : g_max, g_dropped);
    fclose(g_out);
    g_out = 0;
  }
  if (lock) pthread_mutex_unlock(&g_mu);
}

static const char *cct_signame(int sig) {
  switch (sig) {
  case SIGSEGV: return "SIGSEGV";
#ifdef SIGBUS
  case SIGBUS: return "SIGBUS";
#endif
  case SIGFPE: return "SIGFPE";
  case SIGILL: return "SIGILL";
  case SIGABRT: return "SIGABRT";
  case SIGTERM: return "SIGTERM";
  case SIGINT: return "SIGINT";
  default: return "signal";
  }
}

static const char *cct_sigtext(int sig) {
  switch (sig) {
  case SIGSEGV: return "segmentation fault (invalid memory access)";
#ifdef SIGBUS
  case SIGBUS: return "bus error (misaligned or unmapped memory)";
#endif
  case SIGFPE: return "arithmetic error (e.g. integer division by zero)";
  case SIGILL: return "illegal instruction";
  case SIGABRT: return "aborted";
  case SIGTERM: return "stopped (time limit)";
  case SIGINT: return "interrupted";
  default: return "signal";
  }
}

/*
 * Crash / stop: record which function every thread was in, flush, then let the
 * default action happen. Not async-signal-safe in theory; good enough for a
 * diagnostic run whose process is about to die anyway.
 */
static void cct_on_signal(int sig) {
  signal(sig, SIG_DFL);
  if (g_on && g_out) {
    int locked = pthread_mutex_trylock(&g_mu) == 0;
    uint64_t t = cct_now();
    cct_ts *me = t_ts;
    int n = g_nthreads < CCT_MAX_THREADS ? g_nthreads : CCT_MAX_THREADS;
    for (int i = 0; i < n; i++) {
      cct_ts *ts = g_threads[i];
      if (!ts || ts->done) continue;
      if (ts->open) {
        cct_write_locked(ts->buf, ts->len);
        ts->len = 0;
        cct_write_locked("]]\n", 3);
        ts->open = 0;
      } else {
        cct_write_locked(ts->buf, ts->len);
        ts->len = 0;
      }
      int d = ts->depth < CCT_DEPTH ? ts->depth : CCT_DEPTH;
      fprintf(g_out, "{\"k\":\"stack\",\"th\":%d,\"t\":%llu,\"fids\":[", ts->id, (unsigned long long)t);
      for (int j = 0; j < d; j++) fprintf(g_out, "%s%u", j ? "," : "", ts->stack[j]);
      fputs("]}\n", g_out);
    }
    if (me) {
      int d = me->depth < CCT_DEPTH ? me->depth : CCT_DEPTH;
      unsigned top = d > 0 ? me->stack[d - 1] : 0;
      const char *msg = g_exc[0] && sig == SIGABRT ? g_exc : cct_sigtext(sig);
      fprintf(g_out, "[\"x\",%llu,%d,%u,\"%s\",", (unsigned long long)t, me->id, top, cct_signame(sig));
      fputc('"', g_out);
      for (const char *p = msg; *p; p++) {
        if (*p == '"' || *p == '\\') fputc('\\', g_out);
        if ((unsigned char)*p >= 0x20) fputc(*p, g_out);
      }
      fputs("\",0]\n", g_out);
    }
    fprintf(g_out, "{\"k\":\"%s\",\"sig\":\"%s\",\"th\":%d}\n", sig == SIGTERM || sig == SIGINT ? "stopped" : "crash", cct_signame(sig),
            me ? me->id : 0);
    cct_finish_impl(0);
    if (locked) pthread_mutex_unlock(&g_mu);
  }
  raise(sig);
}
