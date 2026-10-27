import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findDevKey, main, manifestUrlProblem } from './checkDesktopBuild';
import { CURATED_DEV_SEED_TEXT, curatedDevKey } from './devKey';

describe('the curated test key', () => {
  // The same pin as apps/desktop/src/main/models/curated/devKey.test.ts, so the two seed copies cannot drift.
  it('derives the key id Desktop trusts in a flagged build', () => {
    expect(curatedDevKey().keyId).toBe('b132926cb06522d5');
  });
});

describe('curated:check-build', () => {
  let dir: string;
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'curated-build-'));
    await mkdir(path.join(dir, 'main'));
    await writeFile(path.join(dir, 'main', 'index.js'), 'console.log("release")');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes a build without the test key and with an https or empty URL', async () => {
    expect(await main([dir], {}, log)).toBe(0);
    expect(await main([dir], { B4M_CURATED_MANIFEST_URL: 'https://catalog.example.com/latest.json' }, log)).toBe(0);
  });

  it('fails on the seed or key id anywhere in the build, naming the file', async () => {
    await writeFile(path.join(dir, 'main', 'chunk.js'), `const s = "${CURATED_DEV_SEED_TEXT}";`);
    await writeFile(path.join(dir, 'main', 'other.js'), `const id = "${curatedDevKey().keyId}";`);
    expect(await findDevKey(dir)).toEqual(
      expect.arrayContaining([
        { file: path.join('main', 'chunk.js'), marker: 'test key seed' },
        { file: path.join('main', 'other.js'), marker: 'test key id' },
      ])
    );
    expect(await main([dir], {}, log)).toBe(1);
  });

  it('fails on an http list URL', () => {
    expect(manifestUrlProblem('http://127.0.0.1:4321/latest.json')).toMatch(/must be https/);
    expect(manifestUrlProblem('not a url')).toMatch(/must be https/);
    expect(manifestUrlProblem(undefined)).toBeNull();
  });
});
