# Examples

[한국어](README.ko.md) · [Guide](../docs/GUIDE.md)

Small programs to try every CodeGraph feature on, in every supported language. Open one folder in VS Code (or
`code --extensionDevelopmentPath=<repo> examples/cpp/features/threads` for a development build) and follow the
checklist in its README. The tests run the same examples (`test/examples.test.ts`, `test/analyzer.test.ts`,
`test/trace.test.ts` …), so what a README promises is what CodeGraph does.

```
examples/
├─ c/          C99 / C11 with pthreads
├─ cpp/        C++17
├─ python/     Python 3.9+
└─ compose/    several containers with Docker Compose
```

## Features — one small folder per feature

Each language has the same feature folders, so the same thing can be compared across languages.

| folder | shows | needs |
| --- | --- | --- |
| `<lang>/features/calls` | how calls become wires: across files, namespaces / modules / imports, methods, inheritance, overloads, objects created, calls only a run can see | — |
| `<lang>/features/threads` | every way of starting a thread or a task (⚡ wires), however the API is spelled or imported | — |
| `<lang>/features/classes` (C: `structs`) | the class panel: members, family, where objects live, who reads and writes each member | — |
| `<lang>/features/returns` | calls in `return` / `await` / `yield from`, and returns that belong to a lambda or nested function | — |
| `<lang>/features/trace` | **Run & Trace**: thread lanes, values, an object shared by threads, wires only the run reveals | compiler / Python |
| `<lang>/features/failures` | a crash or an uncaught exception: the function turns red, with every thread's stack | compiler / Python |
| `<lang>/features/live` | runs until **■ Stop**: the live view, live swimlanes, following one thread | compiler / Python |
| `<lang>/features/problems` | broken on purpose: compile errors, what depends on them, code that gets no current | compiler / Python |

## Programs — a few hundred lines that look like real code

| folder | language | what it is | shows best |
| --- | --- | --- | --- |
| `c/ringbuf` | C | producer and consumer threads around a ring buffer | one object shared by threads, `pthread_create` |
| `cpp/router` | C++ | a packet router: interfaces, a route table, rx / tx threads, CMake | namespaces, classes, `vector<thread>`, CMake builds, a C file called from C++ |
| `python/pipeline` | Python | a sensor pipeline: pump threads, a dispatcher, a worker pool (also has a `compose.yaml`) | packages, re-exports, executors, values on the wires |
| `compose/net-pair` | C++ | a client and a server in two containers, built with a makefile; `compose.yaml` mounts the source, `compose.image.yaml` copies it in with a Dockerfile | **Run & Trace with Docker Compose**, container cards, a view per container |

The programs are also what the [README](../README.md) pictures and the demo page (`npm run demo`) show.
