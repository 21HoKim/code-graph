/**
 * A few lines of source for a hover preview: the comment right above a definition, its header and the
 * start of its body — or just the line of a call. Pure text in, lines out (no Node or VS Code APIs).
 */

export interface PeekOptions {
  /** 1-based last line of the definition: the preview never runs past it. */
  endLine?: number;
  /** Lines from `line` on (header + start of the body). */
  count?: number;
  /** Comment / decorator lines taken from right above `line`. */
  lead?: number;
  /** Longer lines end in '…'. */
  width?: number;
}

export interface Peek {
  /** 1-based number of `lines[0]`. */
  first: number;
  lines: string[];
  /** The definition goes on below the last line shown. */
  more: boolean;
}

const PREPROCESSOR = /^#\s*(include|import|define|undef|if|ifdef|ifndef|elif|else|endif|pragma|error|warning|line)\b/;

/** A line that belongs to what follows it: a comment, a doc-comment line or a decorator. */
function leading(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (s.startsWith('#')) return !PREPROCESSOR.test(s);
  return s.startsWith('//') || s.startsWith('/*') || s.startsWith('*') || s.startsWith('@') || s.endsWith('*/');
}

function expandTabs(s: string): string {
  let out = '';
  for (const ch of s) out += ch === '\t' ? ' '.repeat(4 - (out.length % 4)) : ch;
  return out;
}

export function peekLines(text: string, line: number, opts: PeekOptions = {}): Peek {
  const all = text.split(/\r?\n/);
  const count = Math.max(1, opts.count ?? 6);
  const width = opts.width ?? 100;
  const at = Math.min(Math.max(1, line), all.length);
  const end = Math.min(all.length, Math.max(at, opts.endLine ?? all.length));
  let first = at;
  for (let n = opts.lead ?? 4; n > 0 && first > 1 && leading(all[first - 2]); n--) first--;
  const last = Math.min(end, at + count - 1);
  const lines = all.slice(first - 1, last).map(expandTabs);
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return {
    first,
    lines: lines.map((l) => {
      const s = l.slice(cut).trimEnd();
      return s.length > width ? s.slice(0, width - 1) + '…' : s;
    }),
    more: last < end,
  };
}
