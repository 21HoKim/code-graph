/**
 * The traced copy of a workspace: everything a build needs (sources, makefiles, config files, data),
 * without version control, package caches and virtualenvs. CMake build folders lose what CMake
 * generated (cache, makefiles, ninja files): those name the original folders by absolute path, so a
 * build in the copy reconfigures with the wrapped compilers instead of building in the workspace.
 * Node-only.
 */
import * as fs from 'fs';
import * as path from 'path';

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache', '.cache']);

export function mirrorWorkspace(root: string, dest: string, skip: string[] = []): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const skipAbs = skip.map((s) => path.resolve(s));
  fs.cpSync(root, dest, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: (src) => {
      const base = path.basename(src);
      if (SKIP_DIRS.has(base) && src !== root) return false;
      if (skipAbs.some((s) => src === s || src.startsWith(s + path.sep))) return false;
      if (base === 'CMakeCache.txt') return false;
      try {
        const st = fs.lstatSync(src);
        if (st.isFile()) {
          if (st.size > 256 * 1024 * 1024) return false;
          files++;
          bytes += st.size;
        }
      } catch {
        return false;
      }
      return true;
    },
  });
  // a CMake build folder configured with /usr/bin/c++ would bypass the shims, and its makefiles would
  // build the original sources in the original folder: only a fresh configure may build in the copy
  const generated = ['CMakeFiles', 'Makefile', 'build.ninja', 'rules.ninja', '.ninja_deps', '.ninja_log', 'cmake_install.cmake', 'CTestTestfile.cmake'];
  const stack = [dest];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.name === 'cmake_install.cmake') || (entries.some((e) => e.name === 'CMakeFiles') && entries.some((e) => e.name === 'Makefile' || e.name === 'build.ninja'))) {
      for (const g of generated) fs.rmSync(path.join(d, g), { recursive: true, force: true });
    }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && e.name !== 'CMakeFiles') stack.push(path.join(d, e.name));
  }
  return { files, bytes };
}
