import { describe, it, expect } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, fabFileRepository } from './FabFileModel';
import { setupMongoTest } from '../../__test__/utils';

const LAKE_TAG = 'datalake:lake-1';

const makeFile = (overrides: {
  serverTextHash?: string | null;
  tags?: string[];
  status?: string;
  deleted?: boolean;
  archived?: boolean;
  fileName?: string;
}) =>
  FabFile.create({
    userId: 'user-1',
    fileName: overrides.fileName ?? 'doc',
    type: KnowledgeType.TEXT,
    tags: (overrides.tags ?? [LAKE_TAG]).map(name => ({ name })),
    serverTextHash: overrides.serverTextHash,
    status: overrides.status ?? 'complete',
    ...(overrides.deleted ? { deletedAt: new Date() } : {}),
    ...(overrides.archived ? { archivedAt: new Date() } : {}),
  });

describe('FabFileRepository.findByServerTextHashesInDataLake', () => {
  setupMongoTest();

  it('finds a live member by its server-verified text hash', async () => {
    await makeFile({ serverTextHash: 'hash-a' });

    const found = await fabFileRepository.findByServerTextHashesInDataLake(['hash-a'], LAKE_TAG);

    expect(found).toHaveLength(1);
  });

  it('is scoped to the lake meta-tag - the same text in another lake is not a match', async () => {
    await makeFile({ serverTextHash: 'hash-a', tags: ['datalake:other'] });

    expect(await fabFileRepository.findByServerTextHashesInDataLake(['hash-a'], LAKE_TAG)).toHaveLength(0);
  });

  it('ignores deleted, archived and never-completed members', async () => {
    await makeFile({ serverTextHash: 'hash-a', deleted: true, fileName: 'deleted' });
    await makeFile({ serverTextHash: 'hash-a', archived: true, fileName: 'archived' });
    // An orphan 'pending' ingest is not a live member; treating it as one would suppress a
    // legitimate proposal for content the lake does not actually hold.
    await makeFile({ serverTextHash: 'hash-a', status: 'pending', fileName: 'pending' });

    expect(await fabFileRepository.findByServerTextHashesInDataLake(['hash-a'], LAKE_TAG)).toHaveLength(0);
  });

  it('never matches a file that has no hash yet', async () => {
    await makeFile({ serverTextHash: undefined });

    expect(await fabFileRepository.findByServerTextHashesInDataLake(['hash-a'], LAKE_TAG)).toHaveLength(0);
  });

  it('returns nothing for an empty hash list instead of querying', async () => {
    await makeFile({ serverTextHash: 'hash-a' });

    expect(await fabFileRepository.findByServerTextHashesInDataLake([], LAKE_TAG)).toEqual([]);
  });
});
