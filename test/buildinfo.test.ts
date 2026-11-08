import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { collectTargets, guessLibraries, libraryFlags, parseMakeDryRun, readMakeTargets, shellCommands, targetsFor } from '../src/core/buildinfo';

const ROOT = path.resolve(__dirname, '..');
const PAIR = path.join(ROOT, 'samples', 'net-pair');

describe('build info: shell words', () => {
  it('splits commands and honours quotes', () => {
    assert.deepEqual(shellCommands(`cd src && g++ -DNAME="a b" 'x y.cpp' -o out; echo done`), [
      ['cd', 'src'],
      ['g++', '-DNAME=a b', 'x y.cpp', '-o', 'out'],
      ['echo', 'done'],
    ]);
  });
});

describe('build info: make dry run', () => {
  // `make -nBwk` of a project whose root makefile runs `$(MAKE) -C src/app all`
  const out = [
    "make: Entering directory '/w'",
    'make -C src/app all',
    "make[1]: Entering directory '/w/src/app'",
    'g++ -o ../../build/app-a -DROLE_A main.cpp link.cpp ../common/utils.cpp -std=c++17 -Wall -I/opt/boost-1.87/include -L/opt/boost-1.87/lib -Wl,-rpath,/opt/boost-1.87/lib -lboost_json -lssl -lcrypto -pthread',
    'g++ -o ../../build/app-b -DROLE_B main.cpp link.cpp ../common/utils.cpp -std=c++17 -Wall -I/opt/boost-1.87/include -L/opt/boost-1.87/lib -Wl,-rpath,/opt/boost-1.87/lib -lboost_json -lssl -lcrypto -pthread',
    "make[1]: Leaving directory '/w/src/app'",
    "make: Leaving directory '/w'",
  ].join('\n');

  it('finds both programs with their flags, libraries and directory', () => {
    const targets = collectTargets(parseMakeDryRun(out, '/w'), 'make');
    assert.deepEqual(
      targets.map((t) => t.name),
      ['app-a', 'app-b'],
    );
    const a = targets[0];
    assert.equal(a.dir, '/w/src/app');
    assert.equal(a.output, '/w/build/app-a');
    assert.deepEqual(
      a.units.map((u) => u.file),
      ['/w/src/app/main.cpp', '/w/src/app/link.cpp', '/w/src/common/utils.cpp'],
    );
    assert.ok(a.units[0].args.includes('-DROLE_A'));
    assert.ok(a.units[0].args.includes('/opt/boost-1.87/include'));
    assert.ok(!a.units[0].args.some((x) => x.startsWith('-l') || x.startsWith('-Wl')), 'no link flags in compile commands');
    assert.deepEqual(a.linkFlags, ['-L/opt/boost-1.87/lib', '-Wl,-rpath,/opt/boost-1.87/lib', '-lboost_json', '-lssl', '-lcrypto', '-pthread']);
    assert.deepEqual(
      targetsFor(targets, '/w/src/app/main.cpp').map((t) => t.name),
      ['app-a', 'app-b'],
    );
  });

  it('follows objects and archives back to their sources', () => {
    const text = [
      'g++ -c -O2 -Iinc src/a.cpp -o build/a.o',
      'g++ -c -O2 -Iinc src/b.cpp -o build/b.o',
      'ar rcs build/libcore.a build/b.o',
      'g++ -c -O2 -DMAIN src/main.cpp -o build/main.o',
      'g++ build/main.o build/a.o -Lbuild -lcore -lm -o app',
    ].join('\n');
    const [t] = collectTargets(parseMakeDryRun(text, '/p'), 'make');
    assert.equal(t.name, 'app');
    assert.deepEqual(t.units.map((u) => path.basename(u.file)).sort(), ['a.cpp', 'b.cpp', 'main.cpp']);
    assert.ok(t.units.find((u) => u.file.endsWith('main.cpp'))!.args.includes('-DMAIN'));
    assert.ok(!t.linkFlags.includes('-lcore'), 'the archive built here became sources');
    assert.ok(t.linkFlags.includes('-lm'));
  });

  it('runs make on the network sample', async () => {
    const { targets } = await readMakeTargets(PAIR);
    const names = targets.map((t) => t.name).sort();
    assert.deepEqual(names, ['node-a', 'node-b']);
    const b = targets.find((t) => t.name === 'node-b')!;
    assert.equal(b.dir, path.join(PAIR, 'src'));
    assert.ok(b.linkFlags.includes('-lcrypto'));
    assert.equal(b.units.length, 4);
  });
});

describe('build info: libraries behind undefined symbols', () => {
  it('recognises OpenSSL and Boost.JSON from a failed link', () => {
    const g = guessLibraries(['SSL_CTX_new', 'EVP_DigestInit_ex', 'ERR_get_error', 'boost::json::value::~value()', 'boost::json::parse(boost::core::basic_string_view<char>)', 'net::Router::send(int)']);
    assert.deepEqual(
      g.map((x) => x.label).sort(),
      ['Boost.JSON', 'OpenSSL (libcrypto)', 'OpenSSL (libssl)'],
    );
    assert.deepEqual(libraryFlags(g, []), ['-lboost_json', '-lssl', '-lcrypto']);
    assert.deepEqual(libraryFlags(g, ['-lssl', '-lcrypto']), ['-lboost_json']);
  });
});
