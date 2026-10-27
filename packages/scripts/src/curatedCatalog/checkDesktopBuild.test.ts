import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILD_INFO_PATH, buildInfoProblems, findDevKey, main, manifestUrlProblem } from './checkDesktopBuild';
import { CURATED_DEV_SEED_TEXTS, curatedDevKey } from './devKey';

describe('the curated test keys', () => {
  // The same pins as apps/desktop/src/main/models/curated/devKey.test.ts, so the two seed copies cannot drift.
  it('derive the key ids Desktop trusts in a flagged build', () => {
    expect(curatedDevKey().keyId).toBe('b132926cb06522d5');
    expect(curatedDevKey('recovery').keyId).toBe('689f488b0fe321ad');
  });
});

describe('curated:check-build', () => {
  let dir: string;
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const info = (value: unknown) => writeFile(path.join(dir, BUILD_INFO_PATH), JSON.stringify(value));
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'curated-build-'));
    await mkdir(path.join(dir, 'main'));
    await writeFile(path.join(dir, 'main', 'index.js'), 'console.log("release")');
    await info({ devKeys: false, manifestUrl: '' });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes a build without the test keys and with an https or empty URL', async () => {
    expect(await main([dir], {}, log)).toBe(0);
    await info({ devKeys: false, manifestUrl: 'https://catalog.example.com/latest.json' });
    expect(await main([dir], {}, log)).toBe(0);
  });

  it('fails on either seed or key id anywhere in the build, naming the file', async () => {
    await writeFile(path.join(dir, 'main', 'chunk.js'), `const s = "${CURATED_DEV_SEED_TEXTS.signing}";`);
    await writeFile(path.join(dir, 'main', 'other.js'), `const id = "${curatedDevKey().keyId}";`);
    await writeFile(path.join(dir, 'main', 'third.js'), `const r = "${CURATED_DEV_SEED_TEXTS.recovery}";`);
    expect(await findDevKey(dir)).toEqual(
      expect.arrayContaining([
        { file: path.join('main', 'chunk.js'), marker: 'signing test key seed' },
        { file: path.join('main', 'other.js'), marker: 'signing test key id' },
        { file: path.join('main', 'third.js'), marker: 'recovery test key seed' },
      ])
    );
    expect(await main([dir], {}, log)).toBe(1);
  });

  it('fails a flagged build, a non-https baked URL, and a build without its build info', async () => {
    await info({ devKeys: true, manifestUrl: 'http://127.0.0.1:4321/latest.json' });
    expect(await buildInfoProblems(dir)).toEqual([
      'the build was made with B4M_CURATED_DEV_KEYS=1',
      'B4M_CURATED_MANIFEST_URL must be https (baked: http://127.0.0.1:4321/latest.json)',
    ]);
    expect(await main([dir], {}, log)).toBe(1);
    await rm(path.join(dir, BUILD_INFO_PATH));
    expect(await buildInfoProblems(dir)).toEqual([expect.stringMatching(/is missing or unreadable/)]);
    await info({ devKeys: false });
    expect(await buildInfoProblems(dir)).toEqual([expect.stringMatching(/is malformed/)]);
  });

  it('reads an http or unparsable URL as a problem and an empty one as off', () => {
    expect(manifestUrlProblem('http://127.0.0.1:4321/latest.json')).toMatch(/must be https/);
    expect(manifestUrlProblem('not a url')).toMatch(/must be https/);
    expect(manifestUrlProblem(undefined)).toBeNull();
  });
});
