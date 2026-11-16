import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DATA_HOLDER_REGISTRY } from '@server/dataSubject/registry';
import { ACCOUNT_ARCHIVE_METADATA_MODELS } from './accountDataExportCollections';
import { accountArchiveFilter, accountArchiveMetadata } from './accountDataExportCollections';

describe('account archive coverage', () => {
  it('archives every metadata model as a record the erasure registry deletes with its owner', () => {
    for (const model of ACCOUNT_ARCHIVE_METADATA_MODELS) {
      const holder = DATA_HOLDER_REGISTRY[model];
      expect(holder?.kind, model).toBe('holder');
      const actions = holder?.kind === 'holder' ? holder.references.map(reference => reference.action) : [];
      expect(actions, model).toContain('deleteDocument');
    }
  });

  it('requires an explicit adapter policy for every model the purge deletes by personal workspace', () => {
    const purge = readFileSync(
      new URL('../../../../packages/server-utils/src/users/purgeAccountContent.ts', import.meta.url),
      'utf8'
    );
    const loops = [
      ...purge.matchAll(
        /for \(const model of \[([^\]]*)\]\) \{\s*await assertLease\(\);\s*await collectionFor\(model\)\.deleteMany\(\{ organizationId: \{ \$in: personalOrganizationIds \} \}\)/g
      ),
    ];
    expect(loops).toHaveLength(1);
    const models = loops.flatMap(([, body]) => [...body.matchAll(/'([A-Za-z]+)'/g)].map(([, name]) => name));
    expect(models.length).toBeGreaterThan(0);
    expect(ACCOUNT_ARCHIVE_METADATA_MODELS).toEqual(expect.arrayContaining(models));
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
  it('exports only metadata for private notes, including expired rows awaiting TTL cleanup', () => {
    const row = {
      _id: 'note-1',
      createdAt: '2026-01-01',
      body: 'Private note body',
      author: { id: 'admin', name: 'Admin' },
      expiresAt: new Date(0),
    };
    expect(accountArchiveMetadata(row)).toEqual({ id: 'note-1', createdAt: '2026-01-01', updatedAt: undefined });
    const userId = 'ABCDEFABCDEFABCDEFABCDEF';
    expect(accountArchiveFilter('FeedbackNote', userId, ['other-org'])).toMatchObject({
      userId: { $in: expect.arrayContaining([userId.toLowerCase()]) },
    });
  });
});
