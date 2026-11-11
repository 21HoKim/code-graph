/**
 * The CodeGraph folder that traced builds run with — mounted at /codegraph in containers, copied into
 * images that build at image build time, or used where it is for a local custom build:
 *
 *   bin/cg-setup   wraps every C/C++ compiler (gcc, g++-12, x86_64-linux-gnu-gcc, clang++-17, cc, …)
 *                  and Python interpreter found on PATH: links named like them in a shim folder
 *   bin/cg-cc      compiler shim: adds the tracer header to every compile and the runtime to every
 *                  program it links, then runs the real compiler with the shim folders off PATH
 *                  (so ccache and friends cannot loop back)
 *   bin/cg-py      Python shim: scripts and modules under a source root run under the tracer
 *   bin/cg-run     entrypoint: wraps the compilers, runs an optional pre-build, then the command
 *   rt/            tracer runtime (C/C++) and tracer (Python)
 *   rt/py/         sitecustomize on PYTHONPATH: every other Python process (started by full path,
 *                  gunicorn, multiprocessing children) traces itself once it runs workspace code
 *   trace/<svc>/   one trace per process: <host>-<pid>.jsonl
 *
 * All POSIX sh, no symlinks in the folder itself (Windows hosts can write it).
 */
import * as crypto from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';

export const MOUNT = '/codegraph';

/** Clean PATH (without the shim folders) and find_real NAME — shared by the shims. */
const FIND_REAL = `shimdirs=":\${CODE_GRAPH_SHIM_DIRS:-/tmp/codegraph-bin:$CG/bin}:"
clean=; _ifs=$IFS; IFS=:
for _d in $PATH; do case "$shimdirs" in *":$_d:"*) ;; *) clean="\${clean:+$clean:}$_d" ;; esac; done
IFS=$_ifs
find_real() {
  _ifs=$IFS; IFS=:
  for _d in $clean \${CODE_GRAPH_REAL_PATH:-}; do
    if [ -n "$_d" ] && [ -x "$_d/$1" ] && [ ! -d "$_d/$1" ]; then IFS=$_ifs; echo "$_d/$1"; return 0; fi
  done
  IFS=$_ifs; return 1
}`;

/** Compiler shim (cg-cc), run under the name of the compiler it stands in for. */
/**
 * `tag` names the runtime build cached in the container (/tmp/codegraph-rt-<tag>): it changes with the
 * runtime's source and the number of functions, so a container kept from an earlier run (or another
 * CodeGraph version) does not link a stale runtime.
 */
export function ccShim(nfn: number, base = MOUNT, tag = String(Math.max(1, nfn))): string {
  const n = Math.max(1, nfn);
  return `#!/bin/sh
# CodeGraph Run & Trace — stands in for the compiler of the same name. Compiles with the tracer header
# and links the tracer runtime into every program, then runs the real compiler.
CG=${base}
self=\${0##*/}
${FIND_REAL}
real=$(find_real "$self") || { echo "codegraph: no $self on PATH" >&2; exit 127; }
PATH=$clean; export PATH
link=1; shared=0; static=0; rpath=0
for a in "$@"; do
  case "$a" in
    --version|-v|-dumpversion|-dumpfullversion|-dumpmachine|-dumpspecs|-print-*|--print-*|-###|--help) exec "$real" "$@" ;;
    -E|-M|-MM) exec "$real" "$@" ;;
    -c|-S) link=0 ;;
    -shared) shared=1 ;;
    -static|-static-pie) static=1 ;;
    -Wl,-rpath*|-Wl,--rpath*|-Wl,-R*|-Wl,*,-rpath*) rpath=1 ;;
  esac
done
[ -n "\${CODE_GRAPH_SERVICE:-}" ] && : > "$CG/trace/$CODE_GRAPH_SERVICE/.compiled" 2>/dev/null
if [ $link = 0 ] || [ $shared = 1 ]; then exec "$real" -include "$CG/rt/cg_trace.h" "$@"; fi

# linking a program: build the runtime once (C++ links also get the C++ part), then link it in
case "$self" in *++*) cxx=1 ;; *) cxx=0 ;; esac
rt=/tmp/codegraph-rt-${tag}; mkdir -p "$rt" 2>/dev/null && [ -w "$rt" ] || rt=$(mktemp -d)
cc=$(find_real gcc || find_real cc || find_real clang) || cc=
if [ $cxx = 1 ]; then rtc="$rt/cg_trace_cpp"; lang=-DCGT_LANG_CPP; else rtc="$rt/cg_trace_c"; lang=; fi
# a static program has no dynamic loader to find the real pthread_create with: no thread-start trampoline
if [ $static = 1 ]; then rtc="$rtc-static.o"; lang="$lang -DCGT_NO_INTERPOSE"; else rtc="$rtc.o"; fi
if [ ! -f "$rtc" ]; then
  if [ -n "$cc" ]; then "$cc" -O2 -c "$CG/rt/cg_trace.c" -o "$rtc.$$" -DCGT_NFN=${n} $lang
  else "$real" -x c -O2 -c "$CG/rt/cg_trace.c" -o "$rtc.$$" -DCGT_NFN=${n} $lang; fi && mv -f "$rtc.$$" "$rtc"
fi
objs="$rtc"
if [ $cxx = 1 ]; then
  if [ ! -f "$rt/cg_trace_cxx.o" ]; then
    "$real" -O2 -std=c++11 -c "$CG/rt/cg_trace_cxx.cpp" -o "$rt/cg_trace_cxx.o.$$" && mv -f "$rt/cg_trace_cxx.o.$$" "$rt/cg_trace_cxx.o"
  fi
  objs="$objs $rt/cg_trace_cxx.o"
fi
# shared libraries built with probes find the runtime in the program
dyn=; [ $static = 0 ] && dyn="-Wl,--dynamic-list=$CG/rt/cgt.dynlist -ldl"
# an -rpath as RPATH, not RUNPATH: libraries found there load theirs from there too (Boost.JSON → Boost.Container)
[ $rpath = 1 ] && [ "$(uname -s 2>/dev/null)" = Linux ] && dyn="$dyn -Wl,--disable-new-dtags"
exec "$real" -include "$CG/rt/cg_trace.h" "$@" $objs -pthread $dyn
`;
}

/** Python shim (cg-py): workspace scripts and modules run under the tracer, everything else as is. */
export function pyShim(base = MOUNT): string {
  return `#!/bin/sh
# CodeGraph Run & Trace — stands in for the Python interpreter of the same name. A script or module
# under a source root (CODE_GRAPH_PY_ROOTS) runs under the tracer; anything else runs as it is.
CG=${base}
self=\${0##*/}
${FIND_REAL}
real=$(find_real "$self") || { echo "codegraph: no $self on PATH" >&2; exit 127; }
PATH=$clean; export PATH
[ -n "\${CODE_GRAPH_TRACE:-}" ] && [ -n "\${CODE_GRAPH_PY_ROOTS:-}" ] || exec "$real" "$@"
opts=; mod=
while [ $# -gt 0 ]; do
  case "$1" in
    -c|-|--version|-V|--help|-h) exec "$real" $opts "$@" ;;
    -m) mod=$2; shift 2; break ;;
    -m*) mod=\${1#-m}; shift; break ;;
    -X|-W|-Q) opts="$opts $1 $2"; shift 2 ;;
    --) shift; break ;;
    -*) opts="$opts $1"; shift ;;
    *) break ;;
  esac
done
root_of() {
  _ifs=$IFS; IFS=:
  for _r in $CODE_GRAPH_PY_ROOTS; do
    case "$1" in "$_r"|"$_r"/*) IFS=$_ifs; echo "$_r"; return 0 ;; esac
  done
  IFS=$_ifs; return 1
}
# (the sitecustomize leaves the process this starts to the tracer; its children trace themselves)
tracer() {
  _root=$1; shift
  CODE_GRAPH_PY_SHIM_PID=$$; export CODE_GRAPH_PY_SHIM_PID
  exec "$real" $opts "$CG/rt/cg_tracer.py" --root "$_root" --out "$CODE_GRAPH_TRACE" --max-events "\${CODE_GRAPH_MAX_EVENTS:-200000}" --values "\${CODE_GRAPH_VALUES:-1}" "$@"
}
if [ -n "$mod" ]; then
  # python -m finds the module from the current folder first, then the roots
  top=\${mod%%.*}
  for r in "$PWD" $(echo "$CODE_GRAPH_PY_ROOTS" | tr ':' ' '); do
    { [ -e "$r/$top" ] || [ -e "$r/$top.py" ]; } || continue
    root=$(root_of "$r") && tracer "$root" --module "$mod" "$@"
  done
  exec "$real" $opts -m "$mod" "$@"
fi
[ $# -gt 0 ] && [ -f "$1" ] || exec "$real" $opts "$@"
case "$1" in /*) script=$1 ;; *) script=$PWD/$1 ;; esac
root=$(root_of "$script") || exec "$real" $opts "$@"
shift
tracer "$root" "$script" "$@"
`;
}

/** Finds the compilers and interpreters on PATH (and in CODE_GRAPH_REAL_PATH) and links the shims under their names. */
export function setupScript(base = MOUNT): string {
  return `#!/bin/sh
# CodeGraph Run & Trace — usage: cg-setup DIR. Links a shim named like every C/C++ compiler and Python
# interpreter on PATH into DIR (only for those that exist, so build scripts that probe still see the truth).
CG=${base}
dir=\${1:-/tmp/codegraph-bin}
mkdir -p "$dir" 2>/dev/null || exit 0
shimdirs=":\${CODE_GRAPH_SHIM_DIRS:-$dir:$CG/bin}:$dir:"
_ifs=$IFS; IFS=:
for d in $PATH \${CODE_GRAPH_REAL_PATH:-}; do
  case "$shimdirs" in *":$d:"*) continue ;; esac
  [ -d "$d" ] || continue
  IFS=$_ifs
  for f in "$d"/*; do
    n=\${f##*/}
    case "$n" in
      *-ar|*-ar-[0-9]*|*-nm|*-nm-[0-9]*|*-ranlib|*-ranlib-[0-9]*|*-config|*-dump|*-cov|*-cov-[0-9]*|*-tool|*-gdb|*-lto-dump*) continue ;;
      cc|c++|gcc|g++|clang|clang++|gcc-[0-9]*|g++-[0-9]*|clang-[0-9]*|clang++-[0-9]*) kind=cc ;;
      *-*-gcc|*-*-g++|*-*-gcc-[0-9]*|*-*-g++-[0-9]*|*-*-clang|*-*-clang++|*-*-c++|*-*-cc) kind=cc ;;
      python|python3|python3.[0-9]|python3.[0-9][0-9]) kind=py ;;
      *) continue ;;
    esac
    [ -x "$f" ] && [ ! -d "$f" ] || continue
    [ -e "$dir/$n" ] && continue
    ln -s "$CG/bin/cg-$kind" "$dir/$n" 2>/dev/null || cp "$CG/bin/cg-$kind" "$dir/$n" 2>/dev/null
  done
  IFS=:
done
IFS=$_ifs
exit 0
`;
}

/** Entrypoint wrapper: compilers wrapped, optional pre-build, then the service's own command. */
export function runScript(base = MOUNT): string {
  return `#!/bin/sh
# CodeGraph Run & Trace — runs the service's own command with its compilers (and Python) wrapped
CG=${base}
# what the build creates in the traced copy stays removable from the host (containers often run as root)
umask 0000
home=\${CODE_GRAPH_SHIM_HOME:-/tmp/codegraph-bin}
CODE_GRAPH_SHIM_DIRS="$home:$CG/bin"; export CODE_GRAPH_SHIM_DIRS
PATH=\${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}
# CC / CXX given as a full path: wrap that compiler by name, and remember where the real one is
for v in CC CXX; do
  eval "p=\\\${$v:-}"
  case "$p" in
    /*) if [ -x "$p" ] && [ "\${p#* }" = "$p" ]; then
          CODE_GRAPH_REAL_PATH="\${CODE_GRAPH_REAL_PATH:+$CODE_GRAPH_REAL_PATH:}\${p%/*}"
          eval "$v=\\\${p##*/}"; export "$v"
        fi ;;
  esac
done
export CODE_GRAPH_REAL_PATH
sh "$CG/bin/cg-setup" "$home"
PATH="$home:$CG/bin:$PATH"; export PATH
# every Python process traces itself (however it is started); the image's PYTHONPATH stays after it
if [ -n "\${CODE_GRAPH_TRACE:-}" ] && [ -n "\${CODE_GRAPH_PY_ROOTS:-}" ]; then
  PYTHONPATH="$CG/rt/py\${PYTHONPATH:+:$PYTHONPATH}"; export PYTHONPATH
fi
if [ -n "\${CODE_GRAPH_PREBUILD:-}" ]; then sh -c "$CODE_GRAPH_PREBUILD" || exit $?; fi
exec "$@"
`;
}

/**
 * Writes the CodeGraph folder: runtime sources, the scripts and one trace folder per service.
 * `base` is where it will be seen by the build (/codegraph in containers, the folder itself locally).
 */
export function writeCodegraphDir(dir: string, runtimeDir: string, nfn: number, services: string[], base = MOUNT): void {
  const rt = path.join(dir, 'rt');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(rt, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const f of ['cg_trace.h', 'cg_trace.c', 'cg_trace_cxx.cpp']) fs.copyFileSync(path.join(runtimeDir, 'c', f), path.join(rt, f));
  fs.copyFileSync(path.join(runtimeDir, 'python', 'cg_tracer.py'), path.join(rt, 'cg_tracer.py'));
  fs.mkdirSync(path.join(rt, 'py'), { recursive: true });
  fs.copyFileSync(path.join(runtimeDir, 'python', 'sitecustomize.py'), path.join(rt, 'py', 'sitecustomize.py'));
  // pthread_create too: libraries the program loads start their threads through the runtime's
  fs.writeFileSync(path.join(rt, 'cgt.dynlist'), '{ cgt_*; pthread_create; };\n');
  const hash = crypto.createHash('sha1');
  for (const f of ['cg_trace.h', 'cg_trace.c', 'cg_trace_cxx.cpp']) hash.update(fs.readFileSync(path.join(rt, f)));
  const scripts: [string, string][] = [
    ['cg-cc', ccShim(nfn, base, `${Math.max(1, nfn)}-${hash.digest('hex').slice(0, 10)}`)],
    ['cg-py', pyShim(base)],
    ['cg-setup', setupScript(base)],
    ['cg-run', runScript(base)],
  ];
  for (const [name, text] of scripts) {
    const p = path.join(bin, name);
    fs.writeFileSync(p, text, { mode: 0o755 });
    fs.chmodSync(p, 0o755);
  }
  const trace = path.join(dir, 'trace');
  fs.mkdirSync(trace, { recursive: true });
  for (const s of services) fs.mkdirSync(path.join(trace, s), { recursive: true });
  // containers may run as another user
  for (const d of [trace, ...services.map((s) => path.join(trace, s))]) {
    try {
      fs.chmodSync(d, 0o777);
    } catch {
      /* not ours to change */
    }
  }
}
