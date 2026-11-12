import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_ARCHIVE_METADATA_MODELS } from './accountDataExportCollections';
import { accountArchiveFilter, accountArchiveMetadata } from './accountDataExportCollections';

describe('account archive coverage', () => {
  it('requires an explicit adapter policy for every direct purge-listed model', () => {
    const purge = readFileSync(new URL('../../../client/server/users/purgeAccountContent.ts', import.meta.url), 'utf8');
    const loops = [
      ...purge.matchAll(
        /for \(const model of \[([^\]]*)\]\) \{\s*await assertLease\(\);\s*await collectionFor\(model\)\.deleteMany\((personalFilter|ownerFilter)\(userId/g
      ),
    ];
    expect(loops).toHaveLength(3);
    const models = loops.flatMap(([, body]) => [...body.matchAll(/'([A-Za-z]+)'/g)].map(([, name]) => name));
    expect(new Set(models)).toEqual(new Set(ACCOUNT_ARCHIVE_METADATA_MODELS));
  });

  it('excludes organization-owned content while retaining personal-workspace content', () => {
    const filter = accountArchiveFilter('ToolModel', '665f1c2e8b3a4d0012345678', ['personal-org']);
    expect(filter).toMatchObject({
      $or: [{ organizationId: { $in: [null, ''] } }, { organizationId: { $in: ['personal-org'] } }],
    });
    expect(accountArchiveFilter('UserApiKey', '665f1c2e8b3a4d0012345678', ['personal-org'])).toHaveProperty('userId');
  });

  it('projects credential rows without their secret values', () => {
    expect(accountArchiveMetadata({ _id: 'key-1', createdAt: '2026-01-01', token: 'secret' })).toEqual({
      id: 'key-1',
      createdAt: '2026-01-01',
      updatedAt: undefined,
    });
  });
});
