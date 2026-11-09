import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import darkPlus from 'shiki/dist/themes/dark-plus.mjs';
import { forgetThemes, highlightLines, langOf, setHighlightWasm, type EditorTheme } from '../src/core/highlight';
import { customRules, readThemeFile } from '../src/core/themefile';

setHighlightWasm(path.resolve(__dirname, '..', 'dist', 'wasm', 'onig.wasm'));

const tiny: EditorTheme = {
  name: 'Tiny',
  type: 'dark',
  colors: { 'editor.foreground': '#cccccc' },
  tokenColors: [
    { scope: 'comment', settings: { foreground: '#00ff00', fontStyle: 'italic' } },
    { scope: 'keyword', settings: { foreground: '#ff0000' } },
    { scope: 'string', settings: { foreground: '#0000ff' } },
  ],
};

describe('highlightLines', () => {
  it('colours C++ in the theme given, escaped', async () => {
    const html = await highlightLines(['// see <map> & co', 'return "x";'], 'cpp', tiny);
    assert.ok(html);
    assert.match(html[0], /<span style="color:#00ff00;font-style:italic">[^<]*see &lt;map&gt; &amp; co/);
    assert.match(html[1], /<span style="color:#ff0000">return<\/span>/);
    assert.match(html[1], /color:#0000ff/);
  });

  it('leaves text in the default foreground uncoloured', async () => {
    const html = await highlightLines(['x;'], 'c', tiny);
    assert.ok(html && !html[0].includes('#cccccc'));
  });

  it('colours C++ parameters like the editor does', async () => {
    const t = darkPlus as unknown as { colors: Record<string, string>; tokenColors: unknown[] };
    const theme: EditorTheme = { name: 'Dark+', type: 'dark', colors: t.colors, tokenColors: t.tokenColors };
    const html = await highlightLines(['bool Router::route(const Packet& pkt) {'], 'cpp', theme);
    assert.match(html![0], /color:#4ec9b0">Packet</);
    assert.match(html![0], /color:#9cdcfe">pkt</);
  });

  it('colours Python and C with a real theme (Dark+)', async () => {
    const t = darkPlus as unknown as { colors: Record<string, string>; tokenColors: unknown[] };
    const theme: EditorTheme = { name: 'Dark+', type: 'dark', colors: t.colors, tokenColors: t.tokenColors };
    const py = await highlightLines(['def size(self):', '    return len(self.items)'], 'python', theme);
    assert.match(py![0], /color:#569cd6[^"]*">def</i);
    assert.match(py![1], /color:#c586c0[^"]*">return</i);
    const c = await highlightLines(['static int push(ring *r, int v)'], 'c', theme);
    assert.match(c![0], /color:#dcdcaa[^"]*">push</i);
  });

  it('picks up a changed theme under the same name after forgetThemes', async () => {
    const red = await highlightLines(['return 1;'], 'c', tiny);
    forgetThemes();
    const green = await highlightLines(['return 1;'], 'c', { ...tiny, tokenColors: [{ scope: 'keyword', settings: { foreground: '#00ff00' } }] });
    assert.match(red![0], /#ff0000/);
    assert.match(green![0], /#00ff00/);
  });

  it('knows the language from the file name', () => {
    assert.equal(langOf('src/a.c'), 'c');
    assert.equal(langOf('include/net/queue.h'), 'cpp');
    assert.equal(langOf('pkg/mod.py'), 'python');
    assert.equal(langOf('README.md'), undefined);
  });
});

describe('theme files', () => {
  it('merges the include chain, comments and trailing commas allowed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-theme-'));
    fs.writeFileSync(
      path.join(dir, 'base.json'),
      `{ // base
        "colors": { "editor.foreground": "#111111", "editor.background": "#000000" },
        "tokenColors": [ { "scope": "comment", "settings": { "foreground": "#222222" } }, ],
      }`,
    );
    fs.writeFileSync(
      path.join(dir, 'child.json'),
      `{ "include": "./base.json", /* override */ "colors": { "editor.foreground": "#333333" },
         "tokenColors": [ { "scope": "keyword", "settings": { "foreground": "#444444" } } ] }`,
    );
    const t = readThemeFile(path.join(dir, 'child.json'));
    assert.deepEqual(t.colors, { 'editor.foreground': '#333333', 'editor.background': '#000000' });
    assert.deepEqual(
      (t.tokenColors as { scope: string }[]).map((r) => r.scope),
      ['comment', 'keyword'],
    );
  });

  it('turns tokenColorCustomizations into rules after the theme', () => {
    const rules = customRules({ comments: '#888888', keywords: { foreground: '#ff00ff', fontStyle: 'bold' }, textMateRules: [{ scope: 'string', settings: { foreground: '#00ffff' } }] });
    assert.deepEqual(rules, [
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#888888' } },
      { scope: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'], settings: { foreground: '#ff00ff', fontStyle: 'bold' } },
      { scope: 'string', settings: { foreground: '#00ffff' } },
    ]);
  });
});
