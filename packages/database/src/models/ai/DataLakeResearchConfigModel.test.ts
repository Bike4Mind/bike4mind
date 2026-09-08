import { describe, it, expect } from 'vitest';
import type { CreateDataLakeResearchConfigInput } from '@bike4mind/common';
import { dataLakeResearchConfigRepository as repo } from './DataLakeResearchConfigModel';
import { setupMongoTest } from '../../__test__/utils';

const LAKE = 'lake-1';

const input = (overrides: Partial<CreateDataLakeResearchConfigInput> = {}): CreateDataLakeResearchConfigInput => ({
  dataLakeId: LAKE,
  name: 'Weekly sweep',
  trigger: 'on_demand',
  createdByUserId: 'user-1',
  query: 'coastal erosion',
  maxResults: 10,
  maxProposals: 5,
  allowedDomains: [],
  blockedDomains: [],
  minRelevance: 0.6,
  costCeilingMicroUsd: 50_000,
  proposedTags: [],
  ...overrides,
});

/** Advance the wall clock past `createdAt`'s millisecond resolution. */
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

describe('DataLakeResearchConfigRepository', () => {
  setupMongoTest();

  it('stores every lever and defaults the optional ones', async () => {
    const created = await repo.createConfig(input({ recencyDays: 30, model: 'gpt-4.1-mini' }));

    expect(created).toMatchObject({
      dataLakeId: LAKE,
      name: 'Weekly sweep',
      trigger: 'on_demand',
      query: 'coastal erosion',
      recencyDays: 30,
      model: 'gpt-4.1-mini',
      costCeilingMicroUsd: 50_000,
    });
    expect(created.lastRunAt).toBeNull();
  });

  it('lists one lake newest first, and never another lake', async () => {
    // Spaced out: `createdAt` has millisecond resolution, and two inserts inside one millisecond
    // would make the sort this test is about unordered.
    await repo.createConfig(input({ name: 'older' }));
    await tick();
    await repo.createConfig(input({ name: 'newer' }));
    await repo.createConfig(input({ dataLakeId: 'lake-2', name: 'other lake' }));

    const listed = await repo.listByLake(LAKE);

    expect(listed.map(c => c.name)).toEqual(['newer', 'older']);
  });

  describe('lake scoping', () => {
    it('will not read a config through another lake id', async () => {
      const created = await repo.createConfig(input());
      expect(await repo.findByIdInLake(created.id, 'lake-2')).toBeNull();
      expect(await repo.findByIdInLake(created.id, LAKE)).not.toBeNull();
    });

    it('will not update or delete through another lake id', async () => {
      const created = await repo.createConfig(input());

      expect(await repo.updateConfig(created.id, 'lake-2', { name: 'hijacked', lastUpdatedByUserId: 'u2' })).toBeNull();
      expect(await repo.deleteConfig(created.id, 'lake-2')).toBe(false);

      const still = await repo.findByIdInLake(created.id, LAKE);
      expect(still?.name).toBe('Weekly sweep');
    });
  });

  // findOne REJECTS on a non-ObjectId string, so without the catch a junk id is a 500 where the
  // honest answer is "no such config".
  it('answers null on a junk id rather than throwing', async () => {
    expect(await repo.findByIdInLake('not-an-object-id', LAKE)).toBeNull();
    expect(await repo.updateConfig('not-an-object-id', LAKE, { lastUpdatedByUserId: 'u' })).toBeNull();
    expect(await repo.deleteConfig('not-an-object-id', LAKE)).toBe(false);
  });

  it('applies a patch and records who made it', async () => {
    const created = await repo.createConfig(input({ recencyDays: 30 }));

    const updated = await repo.updateConfig(created.id, LAKE, {
      maxProposals: 3,
      lastUpdatedByUserId: 'user-2',
    });

    expect(updated).toMatchObject({ maxProposals: 3, lastUpdatedByUserId: 'user-2', recencyDays: 30 });
  });

  // The clearing case the service writes an explicit null for.
  it('clears recencyDays and model when the patch sets them null', async () => {
    const created = await repo.createConfig(input({ recencyDays: 30, model: 'gpt-4.1-mini' }));

    const updated = await repo.updateConfig(created.id, LAKE, {
      recencyDays: null,
      model: null,
      lastUpdatedByUserId: 'user-2',
    });

    expect(updated?.recencyDays).toBeNull();
    expect(updated?.model).toBeNull();
  });

  it('stamps lastRunAt', async () => {
    const created = await repo.createConfig(input());
    const at = new Date('2026-03-01T12:00:00.000Z');

    await repo.recordRunStarted(created.id, at);

    expect((await repo.findByIdInLake(created.id, LAKE))?.lastRunAt).toEqual(at);
  });

  it('swallows a stamp against a junk id rather than failing the run that just started', async () => {
    await expect(repo.recordRunStarted('not-an-object-id', new Date())).resolves.toBeUndefined();
  });

  it('sweeps only the named lake on delete', async () => {
    await repo.createConfig(input());
    await repo.createConfig(input());
    await repo.createConfig(input({ dataLakeId: 'lake-2' }));

    expect(await repo.deleteForLake(LAKE)).toBe(2);
    expect(await repo.listByLake(LAKE)).toHaveLength(0);
    expect(await repo.listByLake('lake-2')).toHaveLength(1);
  });
});
