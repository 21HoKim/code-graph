#!/usr/bin/env node
// Release notes for the Publish workflow, from the "## Unreleased" sections of CHANGELOG.md (English) and
// CHANGELOG.ko.md (Korean):
//
//   node scripts/release-notes.mjs <version> <notes-file>
//
// - writes <notes-file>: the English notes, then the Korean ones folded under "한국어";
// - renames each "## Unreleased" to "## <version>" and puts an empty "## Unreleased" above it, so the
//   packaged CHANGELOG.md (the Marketplace's Changelog tab) and the repository show the version;
// - with nothing under "Unreleased", lists the commit subjects since the previous release instead.
//
// Entries go under "### Added", "### Changed" and "### Fixed" (Korean: 추가 / 변경 / 수정).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [version, out] = process.argv.slice(2);
if (!version || !out) throw new Error('usage: release-notes.mjs <version> <notes-file>');

const HEAD = '## Unreleased';

/** The text under "## Unreleased" (up to the next "## "), and the file with that section released. */
function release(file) {
  if (!existsSync(file)) return { body: '' };
  const text = readFileSync(file, 'utf8');
  const at = text.search(/^## Unreleased[ \t]*$/m);
  if (at < 0) return { body: '' };
  const start = text.indexOf('\n', at) + 1;
  const next = text.slice(start).search(/^## /m);
  const end = next < 0 ? text.length : start + next;
  const body = text.slice(start, end).trim();
  if (!body) return { body: '' };
  const released = `${text.slice(0, at)}${HEAD}\n\n## ${version}\n\n${body}\n\n${text.slice(end).replace(/^\n+/, '')}`;
  writeFileSync(file, released);
  return { body };
}

function commitsSincePreviousRelease() {
  let range = 'HEAD';
  try {
    const prev = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD'], { encoding: 'utf8' }).trim();
    range = `${prev}..HEAD`;
  } catch {
    // no earlier release
  }
  const subjects = execFileSync('git', ['log', '--no-merges', '--format=%s', range], { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !/^Changelog: v\d/.test(s));
  return subjects.map((s) => `- ${s}`).join('\n');
}

const en = release('CHANGELOG.md').body;
const ko = release('CHANGELOG.ko.md').body;
let notes = en || (commitsSincePreviousRelease() ? `### Changes\n\n${commitsSincePreviousRelease()}` : '');
if (ko) notes += `\n\n<details><summary>한국어</summary>\n\n${ko}\n\n</details>`;
writeFileSync(out, notes.trim() + '\n');
console.error(`release notes for ${version}: ${en ? 'CHANGELOG.md' : 'commit subjects'}${ko ? ' + CHANGELOG.ko.md' : ''}`);
