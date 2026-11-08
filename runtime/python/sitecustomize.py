"""CodeGraph Run & Trace: traces every Python process of a traced container, however it is started
(``python app.py``, ``/usr/local/bin/python …``, gunicorn, multiprocessing children). Put on
PYTHONPATH by /codegraph/bin/cg-run; does nothing without CODE_GRAPH_TRACE. The image's own
sitecustomize, if it has one, runs right after."""
import os
import sys


def _codegraph():
    here = os.path.dirname(os.path.abspath(__file__))
    if os.environ.get("CODE_GRAPH_TRACE") and os.environ.get("CODE_GRAPH_PY_ROOTS"):
        # cg_tracer.py is next to this file, or one folder up (/codegraph/rt/py → /codegraph/rt)
        rt = here if os.path.isfile(os.path.join(here, "cg_tracer.py")) else os.path.dirname(here)
        sys.path.insert(0, rt)
        try:
            import cg_tracer

            cg_tracer.start_auto()
        except Exception as e:  # noqa: BLE001 - never break the program
            sys.stderr.write("codegraph: Python tracer not started: %s\n" % e)
        finally:
            try:
                sys.path.remove(rt)
            except ValueError:
                pass
    # the sitecustomize this one hides
    try:
        import importlib.machinery
        import importlib.util

        paths = [p for p in sys.path if os.path.abspath(p or ".") != here]
        spec = importlib.machinery.PathFinder.find_spec("sitecustomize", paths)
        if spec is not None and spec.loader is not None and spec.origin and os.path.abspath(spec.origin) != os.path.abspath(__file__):
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("codegraph: the image's sitecustomize failed: %s\n" % e)


_codegraph()
del _codegraph
