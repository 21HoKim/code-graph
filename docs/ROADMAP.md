# Roadmap

## v0.1 — static circuit (this release)

C/C++/Python extraction, cross-file linking with confidence, five abstraction levels, files/symbols grouping,
circuit/network layouts, electric flow (arguments and return values), static thread-spawn detection, search,
focus, follow-cursor, incremental re-analysis, CLI.

## v0.2 — precision

- **Language-server confirmation**: for the selected block (or in the background), ask the active language
  server through `vscode.prepareCallHierarchy` / `vscode.provideOutgoingCalls` (clangd, Microsoft C/C++,
  Pylance). Matching results upgrade `guess`/`likely` links to `exact`; new ones are added. Map
  `CallHierarchyItem` back to entities by file + `selectionRange`.
- **Virtual dispatch fan-out**: optional dashed wires from a call to `Base::send` to every override
  (`EthInterface::send`, `LoopbackInterface::send`).
- **Callbacks & function pointers**: `signal(SIGINT, onSignal)`, `std::function` members, Python
  `add_done_callback(self._collect)`, registration tables — as a separate `ref` relation kind.
- **Macros**: honour `compile_commands.json` defines for `#if` branches.

## v0.3 — dynamic analysis (threads and data)

The static graph is the map; a runtime trace is the traffic on it.

### Trace format

Defined in [`src/core/trace.ts`](../src/core/trace.ts) — JSON Lines, one header then events:

```jsonc
{"kind":"header","schema":"code-current-trace/0","lang":"python","root":"/work/proj","clock":"us","pid":4242,"started":"…"}
{"kind":"thread_start","t":120,"tid":7,"parent":1,"name":"pump-imu0","entry":{"file":"pipeline/runner.py","line":35,"name":"_pump"}}
{"kind":"call","t":131,"tid":7,"fn":{"file":"pipeline/sources.py","line":33,"name":"read"},"caller":{"file":"pipeline/runner.py","line":37,"name":"_pump"}}
{"kind":"return","t":10260,"tid":7,"fn":{"file":"pipeline/sources.py","line":33,"name":"read"},"value":{"type":"Frame","size":16,"id":"0x7f3a…"}}
```

Frames are matched to static entities by file + line range, so traces need no symbol database.
`ValueSummary.id` (Python `id()`, a C pointer) is what makes **data tracking** possible: pick a value and the
view highlights every wire that the same object travelled on, across threads.

### Tracers

| target | mechanism | notes |
| --- | --- | --- |
| Python ≥ 3.12 | `sys.monitoring` (PEP 669) `PY_START`/`PY_RETURN` | low overhead; filter to workspace files |
| Python < 3.12 | `sys.setprofile` + `threading.setprofile` | fallback |
| C/C++ (rebuild) | `-finstrument-functions` + small runtime lib: per-thread lock-free ring buffer, `gettid()`, `dladdr` | addresses symbolised offline (DWARF / `addr2line`) |
| C/C++ (no rebuild, Linux) | eBPF uprobes/uretprobes (libbpf / bpftrace) | attach to a running process |
| C/C++ (low overhead) | LLVM XRay | patch/unpatch at runtime |
| any | Debug Adapter Protocol (cppdbg, lldb, debugpy) | stop-and-sample "probe" mode with variable values |

Transport: a file (JSONL, later a compact binary) or a local socket streamed live through the extension host.

### Viewer

- **Replay**: timeline with play/pause/speed; each `call` fires `FlowLayer.pulse(edge, threadColour)` along the
  projected wire, `return` fires an amber pulse back. Works at every abstraction level because pulses use the same
  lifting as static wires.
- **Thread lanes**: swimlane strip below the circuit (one row per `tid`, spans per active function), synchronised
  with the canvas; blocks glow in their thread's colour while active.
- **Data tracking**: select a value (`id`) in the details panel → its path is drawn as a bright trace with
  timestamps.
- **Contention**: `lock` events as red pulses on a mutex pseudo-block; time-waiting heat on blocks.

## v0.4 — live

Live streaming from a debug session, breakpoints from the circuit, hot-path heatmap (sampled call counts).

## More languages

Rust, Go, Java, TypeScript via tree-sitter adapters (one extractor file + linker rules each).
