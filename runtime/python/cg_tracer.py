"""CodeGraph runtime tracer for Python (standard library only).

    python cg_tracer.py --root ROOT --out TRACE [--max-events N] [--values 0|1]
                        (--module MOD | SCRIPT) [ARGS...]

Runs SCRIPT (or ``-m MOD``) like ``python`` would and records, for code under
ROOT only, every call / return / exception per thread together with a short
summary of argument and return values and the identity (``id()``) of
non-primitive objects, so the viewer can follow one object across calls and
threads. Python 3.12+ uses ``sys.monitoring`` (code outside ROOT is disabled
after its first call, so libraries cost almost nothing); older versions fall
back to ``sys.setprofile``.

Output: JSON lines (schema code-graph-trace/1), see src/core/trace.ts.
"""
import json
import os
import runpy
import sys
import threading
import time

_now = time.perf_counter_ns  # CLOCK_MONOTONIC on Linux, like the C/C++ runtime
_T0 = _now()
_WALL0 = time.time_ns()
_MISSING = object()
_SKIP_DIRS = {"site-packages", "dist-packages", ".venv", "venv", "env", "__pycache__", "node_modules", ".tox", ".git"}
_PRIM = (int, float, str, bool, type(None))


class Tracer:
    def __init__(self, root, out, max_events, values):
        self.root = os.path.realpath(root) + os.sep
        self.self_file = os.path.realpath(__file__)
        self.max_events = max_events
        self.values = values
        self.out = open(out.replace("{pid}", str(os.getpid())), "w", encoding="utf-8")
        # re-entrant: sys.monitoring also fires for code that the callbacks themselves run (json, os.path …)
        self.lock = threading.RLock()
        self.buf = []
        self.n = 0
        self.dropped = 0
        self.code_fid = {}
        self.nfn = 0
        self.threads = {}
        self.stacks = {}
        self.calls = {}
        self.edges = {}
        self.done = False
        self.write({"k": "h", "schema": "code-graph-trace/1", "lang": "python", "root": self.root[:-1], "clock": "ns",
                    "pid": os.getpid(), "python": sys.version.split()[0], "argv": sys.argv[1:], "mono": _T0, "wall": _WALL0})

    # -- output ---------------------------------------------------------------
    def write(self, obj):
        line = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
        with self.lock:
            self.buf.append(line)
            full = len(self.buf) >= 4000
        if full:
            self.flush()

    def flush(self):
        with self.lock:
            if self.buf and not self.out.closed:
                lines, self.buf = self.buf, []
                self.out.write("\n".join(lines) + "\n")

    # -- identities -----------------------------------------------------------
    def fid(self, code):
        f = self.code_fid.get(code, _MISSING)
        if f is not _MISSING:
            return f
        info = None
        name = code.co_filename
        if name and not name.startswith("<"):
            real = os.path.realpath(name)
            if real.startswith(self.root) and real != self.self_file:
                rel = real[len(self.root):].replace(os.sep, "/")
                if not any(part in _SKIP_DIRS for part in rel.split("/")[:-1]):
                    info = rel
        line = None
        with self.lock:
            f = self.code_fid.get(code, _MISSING)
            if f is not _MISSING:
                return f
            f = None
            if info is not None:
                f = self.nfn
                self.nfn += 1
            self.code_fid[code] = f
        if f is not None:
            line = {"k": "f", "id": f, "file": info, "line": code.co_firstlineno, "name": code.co_name, "q": getattr(code, "co_qualname", code.co_name)}
            self.write(line)
        return f

    def th(self, thread=None):
        ident = threading.get_ident()
        t = self.threads.get(ident)
        if t is None:
            with self.lock:
                t = self.threads.get(ident)
                if t is None:
                    t = len(self.threads) + 1
                    self.threads[ident] = t
                    self.stacks[t] = []
                    new = True
                else:
                    new = False
            if new:
                # threading._active is filled a moment after the thread starts: use the object we were given
                cur = thread or threading._active.get(ident) or threading.current_thread()
                self.write({"k": "t", "id": t, "name": cur.name, "parent": getattr(cur, "_cc_parent", None),
                            "t": _now() - _T0, "daemon": bool(getattr(cur, "daemon", False))})
        return t

    # -- values -----------------------------------------------------------------
    def summ(self, v):
        t = type(v)
        if v is None:
            return ["n", "None"]
        if t is bool:
            return ["b", "True" if v else "False"]
        if t is int:
            return ["i", repr(v) if -10 ** 15 < v < 10 ** 15 else "int(%d bits)" % v.bit_length()]
        if t is float:
            return ["d", repr(v)]
        if t is str:
            return ["s", repr(v[:48]) + ("…" if len(v) > 48 else "")]
        if t is bytes or t is bytearray:
            return ["s", repr(bytes(v[:32])) + ("…" if len(v) > 32 else "")]
        if t in (list, tuple, set, frozenset, dict):
            n = len(v)
            preview = None
            try:
                if t is dict:
                    if n <= 4 and all(type(a) in _PRIM and type(b) in _PRIM for a, b in v.items()):
                        preview = repr(v)
                elif n <= 8 and all(type(x) in _PRIM for x in v):
                    preview = repr(v)
            except Exception:
                preview = None
            if preview is not None and len(preview) > 60:
                preview = preview[:59] + "…"
            return ["c", preview or "%s[%d]" % (t.__name__, n), hex(id(v)), n]
        name = getattr(t, "__qualname__", None) or getattr(t, "__name__", "object")
        return ["o", name, hex(id(v))]

    def args(self, frame, code):
        n = code.co_argcount + code.co_kwonlyargcount
        if code.co_flags & 0x04:
            n += 1
        if code.co_flags & 0x08:
            n += 1
        if not n:
            return None
        out = []
        try:
            loc = frame.f_locals
            for name in code.co_varnames[:n]:
                if name in loc:
                    out.append([name] + self.summ(loc[name]))
        except Exception:
            return None
        return out

    # -- events -----------------------------------------------------------------
    def enter(self, code, frame, fid, args=True):
        t = self.th()
        st = self.stacks[t]
        caller = st[-1] if st else -1
        st.append(fid)
        self.calls[fid] = self.calls.get(fid, 0) + 1
        k = (caller, fid, t)
        self.edges[k] = self.edges.get(k, 0) + 1
        if self.n < self.max_events:
            self.n += 1
            a = self.args(frame, code) if (args and self.values and frame is not None) else None
            self.write(["c", _now() - _T0, t, fid, a])
        else:
            self.dropped += 1

    def leave(self, fid, value=_MISSING, exc=None, line=0):
        t = self.th()
        st = self.stacks[t]
        if st and st[-1] == fid:
            st.pop()
        if self.n < self.max_events:
            self.n += 1
            if exc is not None:
                self.write(["x", _now() - _T0, t, fid, type(exc).__name__, str(exc)[:200], line])
            else:
                self.write(["r", _now() - _T0, t, fid, self.summ(value) if (self.values and value is not _MISSING) else None])
        else:
            self.dropped += 1

    # -- sys.monitoring (3.12+) -------------------------------------------------
    def install_monitoring(self):
        mon = sys.monitoring
        tool = None
        for cand in (mon.PROFILER_ID, 3, 4, 5):
            try:
                mon.use_tool_id(cand, "code-graph")
                tool = cand
                break
            except ValueError:
                continue
        if tool is None:
            return False
        E = mon.events
        DISABLE = mon.DISABLE
        fids = self.code_fid
        getframe = sys._getframe

        def on_start(code, offset):
            fid = fids.get(code, _MISSING)
            if fid is _MISSING:
                fid = self.fid(code)
            if fid is None:
                return DISABLE
            self.enter(code, getframe(1), fid)

        def on_resume(code, offset):
            fid = fids.get(code, _MISSING)
            if fid is _MISSING:
                fid = self.fid(code)
            if fid is None:
                return DISABLE
            self.enter(code, None, fid, args=False)

        def on_throw(code, offset, exc):
            fid = fids.get(code, _MISSING)
            if fid is _MISSING:
                fid = self.fid(code)
            if fid is not None:
                self.enter(code, None, fid, args=False)

        def on_return(code, offset, retval):
            fid = fids.get(code, _MISSING)
            if fid is _MISSING:
                fid = self.fid(code)
            if fid is None:
                return DISABLE
            self.leave(fid, retval)

        def on_unwind(code, offset, exc):
            fid = fids.get(code)
            if fid is not None:
                try:
                    line = getframe(1).f_lineno
                except Exception:
                    line = 0
                self.leave(fid, exc=exc, line=line or 0)

        mon.register_callback(tool, E.PY_START, on_start)
        mon.register_callback(tool, E.PY_RESUME, on_resume)
        mon.register_callback(tool, E.PY_THROW, on_throw)
        mon.register_callback(tool, E.PY_RETURN, on_return)
        mon.register_callback(tool, E.PY_YIELD, on_return)
        mon.register_callback(tool, E.PY_UNWIND, on_unwind)
        mon.set_events(tool, E.PY_START | E.PY_RESUME | E.PY_THROW | E.PY_RETURN | E.PY_YIELD | E.PY_UNWIND)
        self.tool = tool
        return True

    def uninstall(self):
        if getattr(self, "tool", None) is not None:
            try:
                sys.monitoring.set_events(self.tool, 0)
                sys.monitoring.free_tool_id(self.tool)
            except Exception:
                pass
            self.tool = None
        sys.setprofile(None)
        threading.setprofile(None)

    # -- sys.setprofile (3.8 - 3.11) --------------------------------------------
    def install_profile(self):
        fids = self.code_fid

        def prof(frame, event, arg):
            if event == "call":
                code = frame.f_code
                fid = fids.get(code, _MISSING)
                if fid is _MISSING:
                    fid = self.fid(code)
                if fid is not None:
                    self.enter(code, frame, fid)
            elif event == "return":
                fid = fids.get(frame.f_code)
                if fid is not None:
                    self.leave(fid, arg)

        threading.setprofile(prof)
        sys.setprofile(prof)

    # -- threads and exceptions --------------------------------------------------
    def patch_threading(self):
        tracer = self
        orig_start = threading.Thread.start

        def start(thread, *a, **k):
            try:
                thread._cc_parent = tracer.th()
                target = getattr(thread, "_target", None)
                code = getattr(target, "__code__", None)
                tracer.write(["s", _now() - _T0, thread._cc_parent, tracer.fid(code) if code is not None else None, thread.name])
            except Exception:
                pass
            return orig_start(thread, *a, **k)

        threading.Thread.start = start
        orig_hook = threading.excepthook

        def hook(args):
            try:
                tracer.exception(args.exc_value, uncaught=True)
            except Exception:
                pass
            orig_hook(args)

        threading.excepthook = hook
        orig_boot = getattr(threading.Thread, "_bootstrap_inner", None)
        if orig_boot is not None:
            def boot(thread):
                try:
                    tracer.th(thread)
                    orig_boot(thread)
                finally:
                    try:
                        tracer.write(["e", _now() - _T0, tracer.th()])
                    except Exception:
                        pass
            threading.Thread._bootstrap_inner = boot

    def exception(self, exc, uncaught):
        frames = []
        tb = getattr(exc, "__traceback__", None)
        while tb is not None:
            fid = self.fid(tb.tb_frame.f_code)
            if fid is not None:
                frames.append([fid, tb.tb_lineno])
            tb = tb.tb_next
        rec = {"k": "exc", "t": _now() - _T0, "th": self.th(), "type": type(exc).__name__, "msg": str(exc)[:300],
               "frames": frames, "uncaught": uncaught}
        # a module that does not compile has no frame of its own: point at the bad line itself
        if isinstance(exc, SyntaxError) and exc.filename:
            real = os.path.realpath(exc.filename)
            if real.startswith(self.root):
                rec["file"] = real[len(self.root):].replace(os.sep, "/")
                rec["line"] = exc.lineno or 1
                rec["msg"] = str(exc.msg)
        self.write(rec)

    def finish(self, exit_code, stopped=None):
        if self.done:
            return
        self.done = True
        self.uninstall()
        self.write({"k": "agg", "calls": [[f, n] for f, n in self.calls.items()],
                    "edges": [[a, b, t, n] for (a, b, t), n in self.edges.items()]})
        end = {"k": "end", "t": _now() - _T0, "exit": exit_code, "events": self.n, "dropped": self.dropped}
        if stopped:
            end["stopped"] = stopped
        self.write(end)
        self.flush()
        self.out.close()


def main():
    argv = sys.argv[1:]
    opts = {"root": os.getcwd(), "out": "trace.jsonl", "max": 200000, "values": 1}
    module = None
    while argv:
        a = argv[0]
        if a == "--root":
            opts["root"] = argv[1]
            argv = argv[2:]
        elif a == "--out":
            opts["out"] = argv[1]
            argv = argv[2:]
        elif a == "--max-events":
            opts["max"] = int(argv[1])
            argv = argv[2:]
        elif a == "--values":
            opts["values"] = argv[1] not in ("0", "false", "off")
            argv = argv[2:]
        elif a in ("--module", "-m"):
            module = argv[1]
            argv = argv[2:]
            break
        elif a == "--":
            argv = argv[1:]
            break
        else:
            break
    if module is None and not argv:
        sys.stderr.write(__doc__)
        return 2
    target = argv[0] if module is None else module
    sys.argv = ([target] if module is None else [module]) + argv[(1 if module is None else 0):]
    if module is None:
        sys.path[0] = os.path.dirname(os.path.abspath(target))
    else:
        sys.path[0] = os.getcwd()

    tracer = Tracer(opts["root"], opts["out"], opts["max"], opts["values"])
    tracer.patch_threading()

    import signal

    def on_term(signum, _frame):
        tracer.finish(128 + signum, stopped=signal.Signals(signum).name)
        os._exit(128 + signum)

    for s in ("SIGTERM", "SIGINT"):
        if hasattr(signal, s):
            try:
                signal.signal(getattr(signal, s), on_term)
            except (ValueError, OSError):
                pass

    if not (sys.version_info >= (3, 12) and tracer.install_monitoring()):
        tracer.install_profile()
    code = 0
    try:
        if module is None:
            runpy.run_path(target, run_name="__main__")
        else:
            runpy.run_module(module, run_name="__main__", alter_sys=True)
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except BaseException as e:  # noqa: BLE001 - report like the interpreter would
        tracer.exception(e, uncaught=True)
        import traceback

        # hide the tracer's and runpy's own frames, like a plain `python script.py` traceback
        tb = e.__traceback__
        while tb is not None and (os.path.realpath(tb.tb_frame.f_code.co_filename) == tracer.self_file or "runpy" in tb.tb_frame.f_code.co_filename):
            tb = tb.tb_next
        traceback.print_exception(type(e), e, tb)
        code = 1
    # the interpreter waits for non-daemon threads before exiting; so do we
    main_thread = threading.main_thread()
    for t in threading.enumerate():
        if t is not main_thread and not t.daemon:
            try:
                t.join()
            except Exception:
                pass
    tracer.finish(code)
    return code


if __name__ == "__main__":
    sys.exit(main())
