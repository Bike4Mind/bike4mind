import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_PATH, REPO_ROOT } from './cli';
import { CATALOG_V3_PATH, checkCuratedV2, curatedV2Text } from './curatedV2';

describe('checkCuratedV2', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  async function scratchRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'curated-v2-'));
    dirs.push(root);
    await mkdir(path.join(root, path.dirname(CATALOG_V3_PATH)), { recursive: true });
    await copyFile(path.join(REPO_ROOT, CATALOG_V3_PATH), path.join(root, CATALOG_V3_PATH));
    return root;
  }

  it('passes for the committed v2 file', async () => {
    expect(await checkCuratedV2()).toBeNull();
  });

  it('reports a missing or stale v2 file', async () => {
    const root = await scratchRoot();
    expect(await checkCuratedV2(root)).toMatch(/missing/);
    const text = await curatedV2Text(root);
    await writeFile(path.join(root, CATALOG_PATH), text.replace('"sequence": 4', '"sequence": 5'));
    expect(await checkCuratedV2(root)).toMatch(/stale; run pnpm --filter @bike4mind\/scripts curated:v2/);
    await writeFile(path.join(root, CATALOG_PATH), text);
    expect(await checkCuratedV2(root)).toBeNull();
  });

  it('rejects a missing or invalid v3 file instead of generating from nothing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'curated-v2-'));
    dirs.push(root);
    await expect(checkCuratedV2(root)).rejects.toMatchObject({ code: 'ENOENT' });
    const scratch = await scratchRoot();
    const v3 = JSON.parse(await readFile(path.join(scratch, CATALOG_V3_PATH), 'utf8'));
    v3.entries[0].license.label = '';
    await writeFile(path.join(scratch, CATALOG_V3_PATH), JSON.stringify(v3));
    await expect(checkCuratedV2(scratch)).rejects.toThrow();
  });
});
