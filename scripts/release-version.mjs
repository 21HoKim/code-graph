#!/usr/bin/env node
// Picks the version the Publish workflow releases and prints it for $GITHUB_OUTPUT:
//   version=0.2.3
//   vsix=code-graph-vscode-0.2.3.vsix
//
// package.json holds the version line. If its exact version has never been released, it is used as is,
// so raising the major or minor number by hand releases that version. Otherwise the next patch after
// the newest release is used, so every push to main ships as a patch update. Releases are the v* git
// tags the workflow creates plus the versions already on the Marketplace (which also covers uploads
// made by hand).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const id = `${pkg.publisher}.${pkg.name}`;
const parse = (v) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const released = [];
const add = (v) => {
  const p = parse(String(v).trim());
  if (p) released.push(p);
};

for (const tag of execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n')) add(tag.trim().slice(1));
try {
  const out = execFileSync('npx', ['--no-install', 'vsce', 'show', id, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  for (const v of JSON.parse(out)?.versions ?? []) add(v.version);
} catch {
  // not on the Marketplace yet, or the lookup failed: the tags still count
}

const base = parse(pkg.version);
if (!base) throw new Error(`package.json version "${pkg.version}" is not major.minor.patch`);
const newest = released.sort(cmp).at(-1);
const next = !newest || cmp(base, newest) > 0 ? base : [newest[0], newest[1], newest[2] + 1];
const version = next.join('.');

console.log(`version=${version}`);
console.log(`vsix=${pkg.name}-${version}.vsix`);
console.error(`${id}: package.json ${pkg.version}, newest release ${newest ? newest.join('.') : 'none'} -> ${version}`);
