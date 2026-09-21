import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType, type DataLakeMembershipScope } from '@bike4mind/common';
import { createMongoServer } from '../__test__/createMongoServer';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';

/**
 * Forced retrieval calls `db.fabfiles.search` with `restrictToDataLake: true` and one
 * `lakeMemberships` arm per accessible lake (ChatCompletionFeatures.ts). That arm must admit a
 * "prefix-only" member - a file tagged under the lake's `fileTagPrefix` but carrying no
 * `datalake:<...>` meta-tag - and must still refuse a prefix-tagged file owned by someone other
 * than the lake's creator (the ownership conjunct `buildDataLakeMembershipFilter` adds to the
 * prefix arm).
 *
 * ChatCompletionFeatures.test.ts pins the FILTER shape against a mocked `db.fabfiles.search`,
 * which can prove the right query gets built but never that Mongo actually returns the row for
 * it. This runs `fabFileRepository.search` - the method `db.fabfiles.search` resolves to -
 * against a real server instead.
 */

const CREATOR = 'creator-1';
const OUTSIDER = 'outsider-1';
const VIEWER = 'viewer-1';

const scope: DataLakeMembershipScope = {
  kind: 'owned',
  datalakeTag: 'datalake:acme',
  fileTagPrefix: 'acme:',
  creatorUserId: CREATOR,
};

const search = async () => {
  const result = await fabFileRepository.search(
    VIEWER,
    '',
    { tags: [], shared: false },
    { page: 1, limit: 50 },
    { by: 'fileName', direction: 'asc' },
    {
      textSearch: true,
      includeShared: true,
      userGroups: [],
      dataLakeTags: [],
      dataLakeTagPrefixes: [],
      lakeMemberships: [scope],
      restrictToDataLake: true,
      excludeContent: true,
    }
  );
  return result.data.map(f => f.fileName).sort();
};

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await FabFile.create(
    [
      { userId: CREATOR, fileName: 'prefix-only-owned', tags: ['acme:playbook'] },
      { userId: CREATOR, fileName: 'meta-tagged', tags: ['datalake:acme'] },
      { userId: OUTSIDER, fileName: 'prefix-only-outsider', tags: ['acme:playbook'] },
    ].map(f => ({
      userId: f.userId,
      fileName: f.fileName,
      type: KnowledgeType.FILE,
      tags: f.tags.map(name => ({ name, strength: 1 })),
    }))
  );
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);

describe('forced-retrieval lake search against a real database', () => {
  it('returns a prefix-only member owned by the lake creator', async () => {
    await expect(search()).resolves.toContain('prefix-only-owned');
  });

  it('returns a member carrying the meta tag', async () => {
    await expect(search()).resolves.toContain('meta-tagged');
  });

  it('excludes a prefix-tagged file owned by a different user than the lake creator', async () => {
    await expect(search()).resolves.not.toContain('prefix-only-outsider');
  });
});
