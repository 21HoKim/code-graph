import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { composeFilesOf, loadProjectConfig, parseJsonc, starterConfig } from '../src/core/config';

const SCHEMA = path.resolve(__dirname, '..', 'schemas', 'codegraph.schema.json');

describe('.codegraph.json', () => {
  it('reads JSON with comments and trailing commas, leaving strings alone', () => {
    const v = parseJsonc(`// top
{
  /* block */ "run": { "build": "make // not a comment", "args": ["a,]", "b",], },
  "compose": { "files": "compose.yaml", },
}`) as Record<string, Record<string, unknown>>;
    assert.deepEqual(v.run, { build: 'make // not a comment', args: ['a,]', 'b'] });
    assert.deepEqual(composeFilesOf(v), ['compose.yaml']);
    assert.equal(parseJsonc('"a\\\\"'), 'a\\');
  });

  it('loads the file at the workspace root and says what is wrong with a broken one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-config-'));
    assert.deepEqual(loadProjectConfig(dir), { config: {} });
    fs.writeFileSync(path.join(dir, '.codegraph.json'), '{ "run": { "entry": "main.cpp" } }');
    assert.equal(loadProjectConfig(dir).config.run?.entry, 'main.cpp');
    fs.writeFileSync(path.join(dir, '.codegraph.json'), '{ "run": ');
    const bad = loadProjectConfig(dir);
    assert.deepEqual(bad.config, {});
    assert.match(bad.error!, /^\.codegraph\.json: /);
    fs.writeFileSync(path.join(dir, '.codegraph.json'), '[1]');
    assert.match(loadProjectConfig(dir).error!, /expected an object/);
  });

  it('writes a starter that changes nothing until a line is uncommented, with what was detected', () => {
    const text = starterConfig({
      entries: ['src/main.cpp', 'tools/gen.py'],
      targets: [{ entry: 'src/main.cpp', names: ['node-a', 'node-b'] }],
      composeFiles: ['compose.yaml'],
      services: ['node-a', 'node-b'],
    });
    assert.deepEqual(parseJsonc(text), { run: {}, compose: {} });
    for (const s of ['"entry": "src/main.cpp"', 'found: src/main.cpp, tools/gen.py', '"target": "node-a"', 'makes node-a, node-b from it', '"services": ["node-a","node-b"]'])
      assert.ok(text.includes(s), s);
    // every key of the starter is in the schema, and the schema knows nothing the code does not read
    const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
    for (const [section, keys] of [
      ['run', ['entry', 'target', 'args', 'cwd', 'env', 'build', 'program', 'buildFlags', 'linkFlags', 'timeoutSeconds']],
      ['compose', ['files', 'profiles', 'services', 'build', 'sourcePath', 'env', 'timeoutSeconds', 'startTimeoutSeconds']],
    ] as [string, string[]][]) {
      assert.deepEqual(Object.keys(schema.properties[section].properties).sort(), [...keys].sort(), section);
      for (const k of keys) assert.ok(text.includes(`"${k}"`), `${section}.${k} in the starter`);
    }
  });
});
