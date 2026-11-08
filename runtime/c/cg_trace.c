/*
 * CodeGraph runtime tracer for C and C++ programs (Linux, macOS; gcc or clang).
 *
 * Linked into the instrumented build made by Run & Trace. Inactive unless the
 * environment variable CODE_GRAPH_TRACE names an output file, so the
 * instrumented binary behaves exactly like the original otherwise.
 *
 *   CODE_GRAPH_TRACE       output path (JSON lines, schema code-graph-trace/1); "{pid}" and "{host}"
 *                          in it become the process id and host name, so several processes (and
 *                          containers) can share one setting; an existing file is never overwritten
 *   CODE_GRAPH_MAX_EVENTS  detailed events to record (default 200000); call counts continue after that
 *   CODE_GRAPH_VALUES      0 = do not record argument values
 *   CODE_GRAPH_LIVE        1 = every 200 ms, append what runs right now (each thread's call stack, call
 *                          counts, caller → callee counts) so a viewer can follow the program while it runs
 *
 * Every thread buffers its own events and appends them to the file under one
 * mutex. A per-thread shadow stack (fids of the active calls) lets a crash be
 * attributed to the function that was running, in every thread. The header
 * records the monotonic and wall clock at time 0, so traces of processes that
 * ran side by side (e.g. containers of one Compose project) can be lined up.
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#ifndef CGT_NFN
#define CGT_NFN 1
#endif

#define CGT_BUF (64 * 1024)
#define CGT_DEPTH 256
#define CGT_MAX_THREADS 1024

typedef struct cgt_ts {
  int id;
  int depth;
  int open; /* 0: no open call line · 1: open, no args yet · 2: open with args */
  int done;
  unsigned stack[CGT_DEPTH];
  char name[64];
  size_t len;
  char buf[CGT_BUF];
} cgt_ts;

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
static cgt_ts *g_threads[CGT_MAX_THREADS];
static int g_nthreads;
static unsigned long long g_calls[CGT_NFN];
static char g_exc[256];
static int g_live;
/* live mode: caller → callee call counts, an open-addressing table (key 0 = empty) */
#define CGT_EDGES 16384
static uint64_t g_ekey[CGT_EDGES];
static unsigned long long g_ecnt[CGT_EDGES];
static __thread cgt_ts *t_ts;
static __thread int t_busy;

static uint64_t cgt_now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec - g_t0;
}

static void cgt_write_locked(const char *s, size_t n) {
  if (g_out && n) fwrite(s, 1, n, g_out);
}

static void cgt_flush(cgt_ts *ts) {
  if (!ts->len) return;
  pthread_mutex_lock(&g_mu);
  cgt_write_locked(ts->buf, ts->len);
  pthread_mutex_unlock(&g_mu);
  ts->len = 0;
}

static void cgt_put(cgt_ts *ts, const char *s, size_t n) {
  if (ts->len + n >= CGT_BUF) cgt_flush(ts);
  if (n >= CGT_BUF) return;
  memcpy(ts->buf + ts->len, s, n);
  ts->len += n;
}

static void cgt_putf(cgt_ts *ts, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
#include <stdarg.h>
static void cgt_putf(cgt_ts *ts, const char *fmt, ...) {
  char tmp[512];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(tmp, sizeof tmp, fmt, ap);
  va_end(ap);
  if (n > 0) cgt_put(ts, tmp, (size_t)(n < (int)sizeof tmp ? n : (int)sizeof tmp - 1));
}

/* JSON string body: quotes, backslashes and control characters escaped, at most `max` bytes */
static void cgt_put_str(cgt_ts *ts, const char *s, size_t max) {
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
  cgt_put(ts, tmp, o);
}

static void cgt_close(cgt_ts *ts) {
  if (ts->open) {
    cgt_put(ts, "]]\n", 3);
    ts->open = 0;
  }
}

static void cgt_thread_exit(void *p) {
  cgt_ts *ts = (cgt_ts *)p;
  if (!ts || ts->done) return;
  if (g_on) {
    cgt_close(ts);
    cgt_putf(ts, "[\"e\",%llu,%d]\n", (unsigned long long)cgt_now(), ts->id);
    cgt_flush(ts);
  }
  ts->done = 1;
}

static void cgt_finish(void);
static void cgt_finish_impl(int lock);
static void cgt_on_signal(int sig);
static char g_main_name[64];
static void *cgt_live_loop(void *arg);

/* CODE_GRAPH_TRACE with "{pid}" and "{host}" (the container's name, by default) replaced */
static void cgt_trace_path(const char *in, char *out, size_t cap) {
  size_t n = 0;
  char host[128] = "host";
  if (gethostname(host, sizeof host - 1) != 0) strcpy(host, "host");
  host[sizeof host - 1] = 0;
  char *dot = strchr(host, '.');
  if (dot) *dot = 0;
  for (const char *p = in; *p && n + 1 < cap;) {
    if (strncmp(p, "{pid}", 5) == 0) {
      n += (size_t)snprintf(out + n, cap - n, "%d", (int)getpid());
      p += 5;
    } else if (strncmp(p, "{host}", 6) == 0) {
      n += (size_t)snprintf(out + n, cap - n, "%s", host);
      p += 6;
    } else
      out[n++] = *p++;
    if (n >= cap) n = cap - 1;
  }
  out[n] = 0;
}

/* a new file: path, or path.1, path.2 … when another process already wrote there */
static FILE *cgt_open_new(const char *path) {
  char p[1100];
  for (int i = 0; i < 1000; i++) {
    if (i == 0) snprintf(p, sizeof p, "%s", path);
    else snprintf(p, sizeof p, "%s.%d", path, i);
    int fd = open(p, O_WRONLY | O_CREAT | O_EXCL, 0666);
    if (fd >= 0) return fdopen(fd, "w");
    if (errno != EEXIST) break;
  }
  return fopen(path, "w");
}

/* program file name, for telling processes apart ("" when unknown) */
static void cgt_exe_name(char *out, size_t cap) {
  out[0] = 0;
#ifdef __linux__
  char buf[512];
  ssize_t n = readlink("/proc/self/exe", buf, sizeof buf - 1);
  if (n <= 0) return;
  buf[n] = 0;
  const char *base = strrchr(buf, '/');
  base = base ? base + 1 : buf;
  size_t k = 0;
  for (; *base && k + 1 < cap; base++)
    if ((*base >= 'a' && *base <= 'z') || (*base >= 'A' && *base <= 'Z') || (*base >= '0' && *base <= '9') || strchr("._+-", *base)) out[k++] = *base;
  out[k] = 0;
#endif
}

static void cgt_init(void) {
  const char *path = getenv("CODE_GRAPH_TRACE");
  if (!path || !*path) return;
  const char *m = getenv("CODE_GRAPH_MAX_EVENTS");
  if (m && *m) g_max = atoll(m);
  const char *v = getenv("CODE_GRAPH_VALUES");
  if (v && (*v == '0' || *v == 'f' || *v == 'o')) g_values = 0;
  char file[1024];
  cgt_trace_path(path, file, sizeof file);
  g_out = cgt_open_new(file);
  if (!g_out) return;
  struct timespec ts, wall;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  clock_gettime(CLOCK_REALTIME, &wall);
  g_t0 = (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
  char exe[128];
  cgt_exe_name(exe, sizeof exe);
  fprintf(g_out,
          "{\"k\":\"h\",\"schema\":\"code-graph-trace/1\",\"lang\":\"%s\",\"clock\":\"ns\",\"pid\":%d,\"fns\":%d,\"mono\":%llu,\"wall\":%llu,\"exe\":\"%s\"}\n",
#ifdef CGT_LANG_CPP
          "cpp",
#else
          "c",
#endif
          (int)getpid(), CGT_NFN, (unsigned long long)g_t0,
          (unsigned long long)wall.tv_sec * 1000000000ull + (unsigned long long)wall.tv_nsec, exe);
  pthread_key_create(&g_key, cgt_thread_exit);
  atexit(cgt_finish);
  int sigs[] = {SIGSEGV, SIGFPE, SIGILL, SIGABRT, SIGTERM, SIGINT,
#ifdef SIGBUS
                SIGBUS,
#endif
  };
  for (size_t i = 0; i < sizeof sigs / sizeof sigs[0]; i++) signal(sigs[i], cgt_on_signal);
  const char *live = getenv("CODE_GRAPH_LIVE");
  g_live = live && *live && *live != '0';
  g_on = 1;
  if (g_live) {
    pthread_t th;
    if (pthread_create(&th, 0, cgt_live_loop, 0) == 0) pthread_detach(th);
  }
}

static cgt_ts *cgt_thread(void) {
  cgt_ts *ts = t_ts;
  if (ts) return ts;
  pthread_once(&g_once, cgt_init);
  if (!g_on) return 0;
  ts = (cgt_ts *)calloc(1, sizeof(cgt_ts));
  if (!ts) return 0;
  pthread_mutex_lock(&g_mu);
  ts->id = ++g_nthreads;
  if (ts->id <= CGT_MAX_THREADS) g_threads[ts->id - 1] = ts;
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
  memcpy(ts->name, name, sizeof ts->name);
  cgt_putf(ts, "{\"k\":\"t\",\"id\":%d,\"t\":%llu,\"name\":", ts->id, (unsigned long long)cgt_now());
  cgt_put_str(ts, name, 60);
  cgt_put(ts, "}\n", 2);
  return ts;
}

static int cgt_take_event(void) {
  long long n = __atomic_add_fetch(&g_events, 1, __ATOMIC_RELAXED);
  if (n <= g_max) return 1;
  __atomic_add_fetch(&g_dropped, 1, __ATOMIC_RELAXED);
  return 0;
}

/* live mode: one more call from `caller` (UINT_MAX = a thread's first) to `callee` */
static void cgt_edge(unsigned caller, unsigned callee) {
  uint64_t key = ((uint64_t)(caller + 1u) << 32) | (uint64_t)(callee + 1u);
  unsigned h = (unsigned)((key * 0x9E3779B97F4A7C15ull) >> 40) & (CGT_EDGES - 1);
  for (int i = 0; i < 64; i++) {
    unsigned slot = (h + (unsigned)i) & (CGT_EDGES - 1);
    uint64_t k = __atomic_load_n(&g_ekey[slot], __ATOMIC_RELAXED);
    if (k == 0) {
      uint64_t empty = 0;
      if (__atomic_compare_exchange_n(&g_ekey[slot], &empty, key, 0, __ATOMIC_RELAXED, __ATOMIC_RELAXED)) k = key;
      else k = empty;
    }
    if (k == key) {
      __atomic_add_fetch(&g_ecnt[slot], 1, __ATOMIC_RELAXED);
      return;
    }
  }
}

void cgt_enter(unsigned fid, const void *self) {
  if (t_busy) return;
  cgt_ts *ts = cgt_thread();
  if (!ts || !g_on || ts->done) return;
  t_busy = 1;
  if (fid < CGT_NFN) __atomic_add_fetch(&g_calls[fid], 1, __ATOMIC_RELAXED);
  if (g_live) cgt_edge(ts->depth > 0 && ts->depth <= CGT_DEPTH ? ts->stack[ts->depth - 1] : 0xFFFFFFFFu, fid);
  if (ts->depth < CGT_DEPTH) ts->stack[ts->depth] = fid;
  ts->depth++;
  cgt_close(ts);
  if (cgt_take_event()) {
    if (self)
      cgt_putf(ts, "[\"c\",%llu,%d,%u,\"%p\",[", (unsigned long long)cgt_now(), ts->id, fid, self);
    else
      cgt_putf(ts, "[\"c\",%llu,%d,%u,null,[", (unsigned long long)cgt_now(), ts->id, fid);
    ts->open = 1;
  }
  t_busy = 0;
}

void cgt_leave(unsigned fid) {
  if (t_busy) return;
  cgt_ts *ts = t_ts;
  if (!ts || !g_on || ts->done) return;
  t_busy = 1;
  if (ts->depth > 0) ts->depth--;
  cgt_close(ts);
  if (cgt_take_event()) cgt_putf(ts, "[\"r\",%llu,%d,%u]\n", (unsigned long long)cgt_now(), ts->id, fid);
  t_busy = 0;
}

int cgt_values(void) { return g_values && t_ts && t_ts->open; }

static cgt_ts *cgt_arg_begin(const char *name) {
  cgt_ts *ts = t_ts;
  if (!ts || !ts->open || !g_values) return 0;
  if (ts->open == 2) cgt_put(ts, ",", 1);
  ts->open = 2;
  cgt_putf(ts, "[\"%s\",", name);
  return ts;
}

void cgt_arg_i(const char *name, long long v) {
  cgt_ts *ts = cgt_arg_begin(name);
  if (ts) cgt_putf(ts, "\"i\",\"%lld\"]", v);
}
void cgt_arg_u(const char *name, unsigned long long v) {
  cgt_ts *ts = cgt_arg_begin(name);
  if (ts) cgt_putf(ts, "\"i\",\"%llu\"]", v);
}
void cgt_arg_d(const char *name, double v) {
  cgt_ts *ts = cgt_arg_begin(name);
  if (ts) cgt_putf(ts, "\"d\",\"%.6g\"]", v);
}
void cgt_arg_b(const char *name, int v) {
  cgt_ts *ts = cgt_arg_begin(name);
  if (ts) cgt_putf(ts, "\"b\",\"%s\"]", v ? "true" : "false");
}
void cgt_arg_s(const char *name, const char *s) {
  cgt_ts *ts = cgt_arg_begin(name);
  if (!ts) return;
  if ((uintptr_t)s < 4096) {
    cgt_put(ts, "\"n\",\"NULL\"]", 11);
    return;
  }
  cgt_put(ts, "\"s\",", 4);
  cgt_put_str(ts, s, 48);
  cgt_putf(ts, ",\"%p\"]", (const void *)s);
}
void cgt_arg_p(const char *name, const void *p) {
  cgt_ts *ts = cgt_arg_begin(name);
  if (!ts) return;
  if (!p)
    cgt_put(ts, "\"n\",\"null\"]", 11);
  else
    cgt_putf(ts, "\"o\",\"%p\",\"%p\"]", p, p);
}
void cgt_arg_c(const char *name, const void *p, unsigned long long size) {
  cgt_ts *ts = cgt_arg_begin(name);
  if (ts) cgt_putf(ts, "\"c\",\"size %llu\",\"%p\",%llu]", size, p, size);
}

void cgt_note_exception(const char *what) {
  if (!what) return;
  strncpy(g_exc, what, sizeof g_exc - 1);
  g_exc[sizeof g_exc - 1] = 0;
}

/* a JSON string straight to the trace file (caller holds g_mu) */
static void cgt_fput_str(const char *s) {
  fputc('"', g_out);
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') fputc('\\', g_out);
    if (c >= 0x20) fputc(c, g_out);
  }
  fputc('"', g_out);
}

/*
 * Live mode: what runs right now, every 200 ms — each thread's call stack (read without its owner's
 * help: a momentary mix of two moments at worst), the call counts and the caller → callee counts so
 * far. Written under g_mu as one line, then flushed, so a viewer tailing the file sees it at once.
 */
static void *cgt_live_loop(void *arg) {
  (void)arg;
  struct timespec pause = {0, 50 * 1000 * 1000}; /* the first one soon: short programs are seen too */
  for (;;) {
    nanosleep(&pause, 0);
    pause.tv_nsec = 200 * 1000 * 1000;
    if (!g_on) return 0;
    pthread_mutex_lock(&g_mu);
    if (!g_out || !g_on) {
      pthread_mutex_unlock(&g_mu);
      return 0;
    }
    fprintf(g_out, "{\"k\":\"live\",\"t\":%llu,\"th\":[", (unsigned long long)cgt_now());
    int n = g_nthreads < CGT_MAX_THREADS ? g_nthreads : CGT_MAX_THREADS, first = 1;
    for (int i = 0; i < n; i++) {
      cgt_ts *ts = g_threads[i];
      if (!ts || ts->done) continue;
      fprintf(g_out, "%s[%d,", first ? "" : ",", ts->id);
      cgt_fput_str(ts->name);
      fputs(",[", g_out);
      int d = ts->depth < CGT_DEPTH ? ts->depth : CGT_DEPTH;
      for (int j = 0; j < d; j++) fprintf(g_out, "%s%u", j ? "," : "", ts->stack[j]);
      fputs("]]", g_out);
      first = 0;
    }
    fputs("],\"calls\":[", g_out);
    first = 1;
    for (unsigned i = 0; i < CGT_NFN; i++) {
      unsigned long long c = __atomic_load_n(&g_calls[i], __ATOMIC_RELAXED);
      if (!c) continue;
      fprintf(g_out, "%s[%u,%llu]", first ? "" : ",", i, c);
      first = 0;
    }
    fputs("],\"edges\":[", g_out);
    first = 1;
    for (unsigned i = 0; i < CGT_EDGES; i++) {
      uint64_t k = __atomic_load_n(&g_ekey[i], __ATOMIC_RELAXED);
      if (!k) continue;
      long long caller = (long long)(k >> 32) - 1, callee = (long long)(k & 0xFFFFFFFFu) - 1;
      fprintf(g_out, "%s[%lld,%lld,%llu]", first ? "" : ",", caller < 0xFFFFFFFFll ? caller : -1, callee, __atomic_load_n(&g_ecnt[i], __ATOMIC_RELAXED));
      first = 0;
    }
    fputs("]}\n", g_out);
    fflush(g_out);
    pthread_mutex_unlock(&g_mu);
  }
}

static void cgt_finish(void) { cgt_finish_impl(1); }

static void cgt_finish_impl(int lock) {
  if (!g_on) return;
  g_on = 0;
  if (lock) pthread_mutex_lock(&g_mu);
  int n = g_nthreads < CGT_MAX_THREADS ? g_nthreads : CGT_MAX_THREADS;
  for (int i = 0; i < n; i++) {
    cgt_ts *ts = g_threads[i];
    if (!ts) continue;
    if (ts->open) {
      memcpy(ts->buf + (ts->len < CGT_BUF - 4 ? ts->len : CGT_BUF - 4), "]]\n", 3);
      ts->len = (ts->len < CGT_BUF - 4 ? ts->len : CGT_BUF - 4) + 3;
      ts->open = 0;
    }
    cgt_write_locked(ts->buf, ts->len);
    ts->len = 0;
  }
  if (g_out) {
    fputs("{\"k\":\"agg\",\"calls\":[", g_out);
    int first = 1;
    for (unsigned i = 0; i < CGT_NFN; i++) {
      if (!g_calls[i]) continue;
      fprintf(g_out, "%s[%u,%llu]", first ? "" : ",", i, g_calls[i]);
      first = 0;
    }
    fprintf(g_out, "]}\n{\"k\":\"end\",\"t\":%llu,\"events\":%lld,\"dropped\":%lld}\n", (unsigned long long)cgt_now(),
            g_events < g_max ? g_events : g_max, g_dropped);
    fclose(g_out);
    g_out = 0;
  }
  if (lock) pthread_mutex_unlock(&g_mu);
}

static const char *cgt_signame(int sig) {
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

static const char *cgt_sigtext(int sig) {
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
static void cgt_on_signal(int sig) {
  signal(sig, SIG_DFL);
  if (g_on && g_out) {
    int locked = pthread_mutex_trylock(&g_mu) == 0;
    uint64_t t = cgt_now();
    cgt_ts *me = t_ts;
    int n = g_nthreads < CGT_MAX_THREADS ? g_nthreads : CGT_MAX_THREADS;
    for (int i = 0; i < n; i++) {
      cgt_ts *ts = g_threads[i];
      if (!ts || ts->done) continue;
      if (ts->open) {
        cgt_write_locked(ts->buf, ts->len);
        ts->len = 0;
        cgt_write_locked("]]\n", 3);
        ts->open = 0;
      } else {
        cgt_write_locked(ts->buf, ts->len);
        ts->len = 0;
      }
      int d = ts->depth < CGT_DEPTH ? ts->depth : CGT_DEPTH;
      fprintf(g_out, "{\"k\":\"stack\",\"th\":%d,\"t\":%llu,\"fids\":[", ts->id, (unsigned long long)t);
      for (int j = 0; j < d; j++) fprintf(g_out, "%s%u", j ? "," : "", ts->stack[j]);
      fputs("]}\n", g_out);
    }
    if (me) {
      int d = me->depth < CGT_DEPTH ? me->depth : CGT_DEPTH;
      unsigned top = d > 0 ? me->stack[d - 1] : 0;
      const char *msg = g_exc[0] && sig == SIGABRT ? g_exc : cgt_sigtext(sig);
      fprintf(g_out, "[\"x\",%llu,%d,%u,\"%s\",", (unsigned long long)t, me->id, top, cgt_signame(sig));
      fputc('"', g_out);
      for (const char *p = msg; *p; p++) {
        if (*p == '"' || *p == '\\') fputc('\\', g_out);
        if ((unsigned char)*p >= 0x20) fputc(*p, g_out);
      }
      fputs("\",0]\n", g_out);
    }
    fprintf(g_out, "{\"k\":\"%s\",\"sig\":\"%s\",\"th\":%d}\n", sig == SIGTERM || sig == SIGINT ? "stopped" : "crash", cgt_signame(sig),
            me ? me->id : 0);
    cgt_finish_impl(0);
    if (locked) pthread_mutex_unlock(&g_mu);
  }
  /* PID 1 (a container's main process) ignores signals left at their default action:
     end the way a shell would report it instead of waiting to be killed */
  if (getpid() == 1 && (sig == SIGTERM || sig == SIGINT)) _exit(128 + sig);
  raise(sig);
}
