import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OWNER_MIRROR_COVERAGE,
  OWNER_MIRROR_COVERAGE_COMPLETE,
  OWNER_MIRROR_UNINSTRUMENTED_RECORDS,
} from '../../../../packages/database/src/models/content/OwnerMutationLogModel';
import { ACCOUNT_ARCHIVE_METADATA_MODELS } from './accountDataExportCollections';
import { accountArchiveFilter, accountArchiveMetadata } from './accountDataExportCollections';

describe('account archive coverage', () => {
  it('keeps the feed closed until every included write path and deployment fence is covered', () => {
    const exported = readFileSync(new URL('accountDataExport.ts', import.meta.url), 'utf8');
    expect(exported).toContain("completeness: 'partial'");
    expect(ACCOUNT_ARCHIVE_METADATA_MODELS.every(name => OWNER_MIRROR_UNINSTRUMENTED_RECORDS.includes(name))).toBe(
      true
    );
    expect(OWNER_MIRROR_UNINSTRUMENTED_RECORDS.length).toBeGreaterThanOrEqual(ACCOUNT_ARCHIVE_METADATA_MODELS.length);
    expect(OWNER_MIRROR_COVERAGE).toEqual({
      databasePrivilegesEnforced: false,
      accountSnapshotFenced: false,
      immutableByteReferencesFenced: false,
      includedWritersInstrumented: false,
    });
    expect(OWNER_MIRROR_COVERAGE_COMPLETE).toBe(false);
  });

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
