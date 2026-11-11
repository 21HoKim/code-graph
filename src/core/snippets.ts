/**
 * Code snippets for the details panel: the whole statement a call sits in, and every `return` of a function.
 * Plain text in, line ranges out. A light scanner, not a parser: it skips comments and strings and counts
 * brackets, which is enough to find where a statement starts and ends.
 */

export interface Snippet {
  /** 1-based first line. */
  first: number;
  /** 1-based last line. */
  last: number;
  lines: string[];
}

type Lang = 'c' | 'cpp' | 'python';

const MAX_LINES = 10;

/**
 * Each line with comments and string/char literal contents blanked to spaces (same length), so that brackets,
 * `;` and keywords can be found by position.
 */
export function codeOnly(lines: string[], lang: Lang): string[] {
  const out: string[] = [];
  let block = false; // inside /* */ (C) or a triple-quoted string (Python)
  let triple = '';
  for (const line of lines) {
    let o = '';
    for (let i = 0; i < line.length; ) {
      const ch = line[i];
      if (lang === 'python') {
        if (block) {
          const end = line.indexOf(triple, i);
          if (end < 0) {
            o += ' '.repeat(line.length - i);
            i = line.length;
          } else {
            o += ' '.repeat(end - i) + triple;
            i = end + 3;
            block = false;
          }
          continue;
        }
        if (ch === '#') {
          o += ' '.repeat(line.length - i);
          break;
        }
        if ((ch === '"' || ch === "'") && line.startsWith(ch.repeat(3), i)) {
          triple = ch.repeat(3);
          o += triple;
          i += 3;
          block = true;
          continue;
        }
      } else {
        if (block) {
          const end = line.indexOf('*/', i);
          if (end < 0) {
            o += ' '.repeat(line.length - i);
            i = line.length;
          } else {
            o += ' '.repeat(end + 2 - i);
            i = end + 2;
            block = false;
          }
          continue;
        }
        if (ch === '/' && line[i + 1] === '/') {
          o += ' '.repeat(line.length - i);
          break;
        }
        if (ch === '/' && line[i + 1] === '*') {
          block = true;
          o += '  ';
          i += 2;
          continue;
        }
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
        o += ch + ' '.repeat(Math.max(0, Math.min(j, line.length) - i - 1)) + (j < line.length ? ch : '');
        i = j + 1;
        continue;
      }
      o += ch;
      i++;
    }
    out.push(o);
  }
  return out;
}

function depthDelta(s: string): number {
  let d = 0;
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') d++;
    else if (ch === ')' || ch === ']' || ch === '}') d--;
  }
  return d;
}

/** C/C++: the line the statement holding `line` (0-based) starts on. */
function cStart(code: string[], line: number, floor: number): number {
  let s = line;
  for (let k = 0; k < 4 && s > floor; k++) {
    const prev = code[s - 1].trim();
    if (!prev || /[;{}:]$/.test(prev) || prev.startsWith('#')) break;
    s--;
  }
  return s;
}

/** C/C++: where a statement starting at `start` (0-based) ends — `;` or an opening `{` at depth 0. */
function cEnd(code: string[], start: number, ceil: number): number {
  // a preprocessor line ends with its line (or its `\` continuations)
  if (code[start].trimStart().startsWith('#')) {
    let i = start;
    while (i < ceil && i < start + MAX_LINES - 1 && code[i].trimEnd().endsWith('\\')) i++;
    return i;
  }
  let d = 0;
  for (let i = start; i <= ceil && i < start + MAX_LINES; i++) {
    for (const ch of code[i]) {
      if (ch === '(' || ch === '[') d++;
      else if (ch === ')' || ch === ']') d--;
      else if (d <= 0 && (ch === ';' || ch === '{')) return i;
    }
  }
  return Math.min(ceil, start + MAX_LINES - 1);
}

/** Python: the line the logical line holding `line` starts on (brackets still open, or a `\` before). */
function pyStart(code: string[], line: number, floor: number): number {
  let s = line;
  for (let k = 0; k < 6 && s > floor; k++) {
    const prev = code[s - 1].trimEnd();
    if (prev.endsWith('\\')) {
      s--;
      continue;
    }
    // open brackets on the previous lines that close on this one
    let d = 0;
    for (let i = s - 1; i >= Math.max(floor, s - 6); i--) {
      d += depthDelta(code[i]);
      if (d > 0) break;
    }
    if (d > 0) s--;
    else break;
  }
  return s;
}

function pyEnd(code: string[], start: number, ceil: number): number {
  let d = 0;
  for (let i = start; i <= ceil && i < start + MAX_LINES; i++) {
    d += depthDelta(code[i]);
    if (d <= 0 && !code[i].trimEnd().endsWith('\\')) return i;
  }
  return Math.min(ceil, start + MAX_LINES - 1);
}

function cut(all: string[], first: number, last: number): Snippet {
  return { first: first + 1, last: last + 1, lines: all.slice(first, last + 1) };
}

/** The whole statement that `line` (1-based) is part of — e.g. a call spread over several lines. */
export function statementAt(text: string, line: number, lang: Lang): Snippet | null {
  const all = text.split(/\r?\n/);
  const i = line - 1;
  if (i < 0 || i >= all.length) return null;
  const code = codeOnly(all, lang);
  if (lang === 'python') {
    const s = pyStart(code, i, 0);
    return cut(all, s, pyEnd(code, s, all.length - 1));
  }
  const s = cStart(code, i, 0);
  return cut(all, s, cEnd(code, s, all.length - 1));
}

/**
 * The `return` statements of a function at `lines` (1-based, from the syntax tree: the function's own returns,
 * not those of lambdas, nested functions or local classes inside it), each as its whole statement.
 */
export function returnStatements(text: string, lines: readonly number[], lang: Lang, max = 20): Snippet[] {
  const all = text.split(/\r?\n/);
  const code = codeOnly(all, lang);
  const kw = lang === 'python' ? /\b(return|yield)\b/ : /\b(co_return|co_yield|return)\b/;
  const out: Snippet[] = [];
  for (const line of lines) {
    const i = line - 1;
    if (i < 0 || i >= all.length || out.length >= max) continue;
    if (out.length && out[out.length - 1].last > i) continue; // already part of the previous statement
    const at = Math.max(0, code[i].search(kw));
    const end = lang === 'python' ? pyEnd(code, i, all.length - 1) : cEndFrom(code, i, at, all.length - 1);
    out.push(cut(all, i, end));
  }
  return out;
}

/** C/C++: where the statement starting at column `col` of line `start` ends (its `;` at depth 0). */
function cEndFrom(code: string[], start: number, col: number, ceil: number): number {
  let d = 0;
  for (let i = start; i <= ceil && i < start + MAX_LINES; i++) {
    const s = i === start ? code[i].slice(col) : code[i];
    for (const ch of s) {
      if (ch === '(' || ch === '[' || ch === '{') d++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (--d < 0) return i; // the block around a one-line `{ return x }` closes
      } else if (d <= 0 && ch === ';') return i;
    }
  }
  return Math.min(ceil, start + MAX_LINES - 1);
}
