import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { analyzeDockerfile, copiedBy, parseDockerfile, traceDockerfile } from '../src/core/dockerfile';

const PAIR = path.resolve(__dirname, '..', 'samples', 'net-pair');

describe('Dockerfile', () => {
  it('reads instructions across continuations, comments, heredocs and the escape directive', () => {
    const ins = parseDockerfile(
      [
        '# syntax=docker/dockerfile:1',
        'FROM debian AS build',
        'RUN apt-get update \\',
        '  # a comment inside',
        ' && apt-get install -y g++',
        'RUN <<EOF',
        'make all',
        'EOF',
        'COPY . /src',
      ].join('\n'),
    );
    assert.deepEqual(
      ins.map((x) => [x.keyword, x.first, x.last]),
      [
        ['FROM', 1, 1],
        ['RUN', 2, 4],
        ['RUN', 5, 7],
        ['COPY', 8, 8],
      ],
    );
    const win = parseDockerfile(['# escape=`', 'FROM mcr.microsoft.com/windows', 'RUN dir `', '  c:\\'].join('\n'));
    assert.deepEqual(
      win.map((x) => x.keyword),
      ['FROM', 'RUN'],
    );
  });

  it('finds where the sources land and which stages build them (multi-stage sample)', () => {
    const info = analyzeDockerfile(fs.readFileSync(path.join(PAIR, 'docker', 'Dockerfile.image'), 'utf8'), PAIR);
    assert.equal(info.stages, 2);
    assert.deepEqual(info.buildStages, [0]);
    assert.equal(info.contextCopies, 3);
    assert.deepEqual(info.copies, [
      { stage: 0, src: 'makefile', dest: '/src', file: true },
      { stage: 0, src: 'src', dest: '/src/src' },
      { stage: 1, src: 'cfg', dest: '/opt/pair/cfg' },
    ]);
    assert.ok(copiedBy(info.copies, 'src/link.cpp'));
    assert.ok(copiedBy(info.copies, 'makefile'));
    assert.equal(copiedBy(info.copies, 'docker/Dockerfile'), undefined);
    // the toolchain image of the mounted variant copies nothing in
    assert.equal(analyzeDockerfile(fs.readFileSync(path.join(PAIR, 'docker', 'Dockerfile'), 'utf8'), PAIR).contextCopies, 0);
  });

  it('handles COPY flags, JSON form, patterns, URLs, other stages and bind-mounted contexts', () => {
    const info = analyzeDockerfile(
      [
        'FROM python:3.12 AS app',
        'WORKDIR /app',
        'COPY --chown=app:app ["requirements.txt", "./"]',
        'RUN pip install -r requirements.txt',
        'COPY *.py ./',
        'ADD https://example.com/x.tar.gz /opt/',
        'COPY --from=build /out/lib.so /usr/lib/',
        'FROM gcc:13',
        'RUN --mount=type=bind,target=/w,source=native --mount=type=cache,target=/root/.cache make -C /w',
        'RUN --mount=type=bind,from=app,target=/x true',
      ].join('\n'),
    );
    assert.deepEqual(info.buildStages, [0, 1]);
    assert.equal(info.contextCopies, 3);
    assert.deepEqual(info.copies, [
      { stage: 0, src: 'requirements.txt', dest: '/app', file: true },
      { stage: 0, src: '*.py', dest: '/app', file: true },
      { stage: 1, src: 'native', dest: '/w' },
    ]);
    assert.ok(copiedBy(info.copies, 'main.py'));
    assert.equal(copiedBy(info.copies, 'pkg/mod.py'), undefined, 'a pattern does not reach into folders');
    assert.ok(copiedBy(info.copies, 'native/src/a.c'));
  });

  it('inserts the shims before the first instruction that sees the sources, in build stages only', () => {
    const src = fs.readFileSync(path.join(PAIR, 'docker', 'Dockerfile.image'), 'utf8');
    const { text, stages } = traceDockerfile(src, 'codegraph_trace', PAIR);
    assert.equal(stages, 1);
    const lines = text.split('\n');
    const at = lines.indexOf('COPY --from=codegraph_trace / /codegraph/');
    assert.ok(at > 0);
    assert.equal(lines[at + 1], 'RUN ["/bin/sh", "/codegraph/bin/cg-setup", "/tmp/codegraph-bin"]');
    assert.match(lines[at + 2], /^ENV CODE_GRAPH_SHIM_DIRS=.* PATH="\/tmp\/codegraph-bin:\/codegraph\/bin:\$\{PATH:-/);
    assert.equal(lines[at + 3], 'COPY makefile ./', 'right before the first COPY of the build stage');
    assert.ok(lines.indexOf('WORKDIR /src') < at, 'the package layers above stay cached');
    assert.equal(text.split('COPY --from=codegraph_trace').length, 2, 'not in the run stage');
    // a stage that only RUNs on a bind mount of the context
    const mounted = traceDockerfile('FROM gcc:13\nRUN --mount=type=bind,target=/w make -C /w\n', 'cg');
    assert.equal(mounted.stages, 1);
    assert.match(mounted.text, /^FROM gcc:13\n# CodeGraph[^\n]*\nCOPY --from=cg \/ \/codegraph\/\n/);
  });
});
