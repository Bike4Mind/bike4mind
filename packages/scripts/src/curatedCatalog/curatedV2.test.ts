import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { curatedV2FromV3 } from '@bike4mind/common';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_PATH, REPO_ROOT } from './cli';
import { bumpCuratedV2, CATALOG_V3_PATH, checkCuratedV2, curatedV2Sha256, generateCuratedV2 } from './curatedV2';

type Doc = Record<string, any>; // any: the fixtures edit arbitrary parts of a JSON document

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

  async function editV3(root: string, edit: (doc: Doc) => void): Promise<void> {
    const file = path.join(root, CATALOG_V3_PATH);
    const doc = JSON.parse(await readFile(file, 'utf8'));
    edit(doc);
    await writeFile(file, JSON.stringify(doc));
  }

  it('passes for the committed v2 file', async () => {
    expect(await checkCuratedV2()).toBeNull();
  });

  it('reports a missing or stale v2 file', async () => {
    const root = await scratchRoot();
    expect(await checkCuratedV2(root)).toMatch(/missing/);
    const { text } = await generateCuratedV2(root);
    await writeFile(path.join(root, CATALOG_PATH), text.replace('"sequence": 4', '"sequence": 5'));
    expect(await checkCuratedV2(root)).toMatch(/stale; run pnpm --filter @bike4mind\/scripts curated:v2/);
    await writeFile(path.join(root, CATALOG_PATH), text);
    expect(await checkCuratedV2(root)).toBeNull();
  });

  it('fails a v2 content change until --bump moves the sequence and records its hash', async () => {
    const root = await scratchRoot();
    const v3File = path.join(root, CATALOG_V3_PATH);
    const item = (sequence: number) => ({
      sequence,
      date: '2026-11-05',
      added: [],
      removed: [],
      changed: ['qwen3-5-4b'],
      notes: 'Moved the 8 GB picks.',
    });
    await editV3(root, doc => {
      doc.v2Channel.tiers[2].picks[0] = { slot: 'best', entry: 'qwen3-5-4b', build: 'q4-k-m' };
      doc.v2Channel.tiers[2].picks[1] = { slot: 'fast', entry: 'qwen3-5-0-8b', build: 'q8-0' };
    });
    const changed = await generateCuratedV2(root);
    expect(changed.problem).toMatch(
      /no longer matches the hash recorded for v2Channel sequence 4; add a v2Channel.changelog item for sequence 5, then run pnpm --filter @bike4mind\/scripts curated:v2 --bump/
    );
    expect(await checkCuratedV2(root)).toBe(changed.problem);
    await expect(bumpCuratedV2(root)).rejects.toThrow(/add a v2Channel.changelog item for sequence 5 first/);

    await editV3(root, doc => doc.v2Channel.changelog.unshift(item(5)));
    const before = await readFile(v3File, 'utf8');
    expect(await bumpCuratedV2(root)).toBe(5);
    expect(await checkCuratedV2(root)).toBeNull();
    const bumped: Doc = JSON.parse(await readFile(v3File, 'utf8'));
    expect(bumped.v2Channel).toMatchObject({ sequence: 5, updatedAt: '2026-11-05T00:00:00Z' });
    expect(bumped.v2Channel.contentSha256['5']).toBe(curatedV2Sha256(curatedV2FromV3(bumped as never)));
    expect(Object.keys(bumped.v2Channel.contentSha256)).toEqual(['4', '5']);
    expect(JSON.parse(before).entries).toEqual(bumped.entries);

    // The hash covers content only, so a changelog edit regenerates without another bump.
    await editV3(root, doc => (doc.v2Channel.changelog[0].notes = 'Moved the 8 GB best and fast picks.'));
    expect(await checkCuratedV2(root)).toMatch(/stale/);
    await writeFile(path.join(root, CATALOG_PATH), (await generateCuratedV2(root)).text);
    expect(await checkCuratedV2(root)).toBeNull();

    await editV3(root, doc => doc.v2Channel.changelog.unshift(item(6)));
    await expect(bumpCuratedV2(root)).rejects.toThrow(/has not changed since sequence 5/);
    await editV3(root, doc => {
      doc.v2Channel.changelog.shift();
      Object.assign(doc.v2Channel.tiers[2].picks[0], { entry: 'gemma-4-12b', build: 'qat-q4-0' });
    });
    expect(await checkCuratedV2(root)).toMatch(/sequence 5; add a v2Channel.changelog item for sequence 6/);
  });

  it('rejects a missing or invalid v3 file instead of generating from nothing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'curated-v2-'));
    dirs.push(root);
    await expect(checkCuratedV2(root)).rejects.toMatchObject({ code: 'ENOENT' });
    const scratch = await scratchRoot();
    await editV3(scratch, doc => (doc.entries[0].license.label = ''));
    await expect(checkCuratedV2(scratch)).rejects.toThrow();
  });
});
