import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guard on where npm publishes come from and what they publish.
 *
 * The registry rejects a publish once a package's metadata document passes 100 MB, and every
 * published version adds its manifest to that document for good: a version can only be removed
 * while the package has a single maintainer and nothing depends on it. Per-branch snapshot
 * publishes add a version on every green branch build, which is what fills the document. So
 * the only publish path is the release workflow, and it publishes release versions only.
 *
 * Branch builds that need to be installable belong somewhere disposable (a CI artifact), not in
 * a published package's history. scripts/check-npm-metadata-size.mjs is the runtime half of this
 * guard: it measures the documents on a schedule.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GITHUB_DIR = path.join(REPO_ROOT, '.github');

const RELEASE_WORKFLOW = '.github/workflows/release.yaml';

const PUBLISH = /\b(?:npm|pnpm|yarn)\s+publish\b|\bchangeset(?::|\s+)publish\b/;
const SNAPSHOT = /--snapshot\b|\b(?:npm|pnpm)\s+dist-tag\s+add\b/;

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

/** Lines that can execute: YAML and shell comments are dropped, so prose may name a command. */
function codeLines(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => !line.trim().startsWith('#'));
}

const automationFiles = listFiles(GITHUB_DIR).filter(file => /\.(?:ya?ml|sh|mjs|js|ts)$/.test(file));
const relative = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join('/');

function filesMatching(pattern: RegExp): string[] {
  return automationFiles.filter(file => codeLines(file).some(line => pattern.test(line))).map(relative);
}

describe('npm publish sources', () => {
  it('scans the workflows it is meant to guard', () => {
    expect(automationFiles.map(relative)).toContain(RELEASE_WORKFLOW);
  });

  it('publishes to npm from the release workflow only', () => {
    expect(filesMatching(PUBLISH)).toEqual([RELEASE_WORKFLOW]);
  });

  it('never publishes a snapshot version or moves a dist-tag from automation', () => {
    expect(filesMatching(SNAPSHOT)).toEqual([]);
  });

  it('keeps the root publish script a plain release publish', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(scripts['changeset:publish']).toBe('changeset publish');
    const publishScripts = Object.entries(scripts)
      .filter(([, command]) => PUBLISH.test(command))
      .map(([name]) => name);
    expect(publishScripts).toEqual(['changeset:publish']);
    const snapshotScripts = Object.entries(scripts)
      .filter(([, command]) => SNAPSHOT.test(command))
      .map(([name]) => name);
    expect(snapshotScripts).toEqual([]);
  });
});
