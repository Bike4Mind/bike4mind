import { describe, it, expect } from 'vitest';
import {
  dataLakeArticleListResponseSchema,
  dataLakeBatchListResponseSchema,
  dataLakeBatchResponseSchema,
  dataLakeConfigListResponseSchema,
  dataLakeListResponseSchema,
  dataLakeResponseSchema,
  lakeFindingAssignResponseSchema,
  lakeFindingListResponseSchema,
  lakeFindingRulingResponseSchema,
  lakeOwnershipOfferResponseSchema,
  lakeProposalApproveResponseSchema,
  lakeProposalListResponseSchema,
  lakeProposalReviewResponseSchema,
  researchConfigEnvelopeResponseSchema,
  researchConfigListResponseSchema,
  researchRunEnvelopeResponseSchema,
  researchRunListResponseSchema,
} from './dataLakeResponse';

const RAW_KEYS = { _id: 'raw-object-id', __v: 7, notInSchema: 'secret' };

describe('dataLakeResponseSchema', () => {
  it('keeps lake fields and strips Mongo internals and undeclared keys', () => {
    const lastSyncAt = new Date('2026-10-01T00:00:00Z');
    const lake = { id: 'lake1', name: 'Docs', systemPrompt: 'Be terse.', lastSyncAt, ...RAW_KEYS };

    expect(dataLakeResponseSchema.parse(lake)).toEqual({
      id: 'lake1',
      name: 'Docs',
      systemPrompt: 'Be terse.',
      lastSyncAt,
    });
  });

  it('does not add keys a reader projection left out', () => {
    const reader = { id: 'lake1', name: 'Docs' };

    expect(dataLakeResponseSchema.parse(reader)).not.toHaveProperty('systemPrompt');
  });

  it('strips per row in the archived/deleted list shape', () => {
    const parsed = dataLakeListResponseSchema.parse({ data: [{ id: 'a', ...RAW_KEYS }, { id: 'b' }] });

    expect(parsed).toEqual({ data: [{ id: 'a' }, { id: 'b' }] });
  });
});

describe('dataLakeConfigListResponseSchema', () => {
  it('keeps the manager-only projection fields and the retrievability label', () => {
    const row = {
      id: 'lake1',
      slug: 'docs',
      name: 'Docs',
      fileTagPrefix: 'docs:',
      datalakeTag: 'datalake:docs',
      isOwn: true,
      isCreator: true,
      canPreauthorize: false,
      canRebuild: true,
      canManageSettings: true,
      canManageMemory: false,
      pendingProposalCount: 2,
      retrievable: true,
      ...RAW_KEYS,
    };

    const { _id: _rawId, __v: _version, notInSchema: _extra, ...expected } = row;
    expect(dataLakeConfigListResponseSchema.parse({ data: [row] })).toEqual({ data: [expected] });
  });
});

describe('lake finding response schemas', () => {
  const finding = { id: 'f1', lakeId: 'lake1', status: 'open', resolution: 'kept', ...RAW_KEYS };
  const kept = { id: 'f1', lakeId: 'lake1', status: 'open', resolution: 'kept' };

  it('strips undeclared keys per row in the list shape', () => {
    const parsed = lakeFindingListResponseSchema.parse({
      data: [{ ...finding, supersededFabFileIds: ['a'] }],
      hasMore: true,
    });

    expect(parsed).toEqual({ data: [{ ...kept, supersededFabFileIds: ['a'] }], hasMore: true });
  });

  it('strips undeclared keys from an assigned finding', () => {
    expect(lakeFindingAssignResponseSchema.parse({ data: finding })).toEqual({ data: kept });
  });

  it('keeps the belief outcome beside a stripped ruling', () => {
    const parsed = lakeFindingRulingResponseSchema.parse({
      data: finding,
      beliefRecorded: false,
      beliefSkipReason: 'lake-memory-disabled',
      ...RAW_KEYS,
    });

    expect(parsed).toEqual({ data: kept, beliefRecorded: false, beliefSkipReason: 'lake-memory-disabled' });
  });
});

describe('lake proposal response schemas', () => {
  const proposal = { id: 'p1', dataLakeId: 'lake1', status: 'pending', textHash: 'digest', ...RAW_KEYS };
  const kept = { id: 'p1', dataLakeId: 'lake1', status: 'pending' };

  it('strips undeclared keys and the dedupe digest per row in the list shape', () => {
    expect(lakeProposalListResponseSchema.parse({ data: [proposal] })).toEqual({ data: [kept] });
  });

  it('strips undeclared keys from a declined or restored proposal', () => {
    expect(lakeProposalReviewResponseSchema.parse({ data: proposal })).toEqual({ data: kept });
  });

  it('strips undeclared keys from an approval and from the admitted file summary', () => {
    const parsed = lakeProposalApproveResponseSchema.parse({
      data: proposal,
      fabFile: { id: 'file1', fileName: 'a.md', ...RAW_KEYS },
    });

    expect(parsed).toEqual({ data: kept, fabFile: { id: 'file1', fileName: 'a.md' } });
  });
});

describe('research response schemas', () => {
  const config = { id: 'c1', dataLakeId: 'lake1', name: 'Weekly', cadence: 'weekly', ...RAW_KEYS };
  const keptConfig = { id: 'c1', dataLakeId: 'lake1', name: 'Weekly', cadence: 'weekly' };
  const run = { id: 'r1', configId: 'c1', status: 'queued', ...RAW_KEYS };
  const keptRun = { id: 'r1', configId: 'c1', status: 'queued' };

  it('strips undeclared keys per config and keeps the pending-proposal count', () => {
    expect(researchConfigListResponseSchema.parse({ data: [config], pendingProposals: 3 })).toEqual({
      data: [keptConfig],
      pendingProposals: 3,
    });
  });

  it('strips undeclared keys from a created or updated config', () => {
    expect(researchConfigEnvelopeResponseSchema.parse({ data: config })).toEqual({ data: keptConfig });
  });

  it('strips undeclared keys per run in the history shape', () => {
    expect(researchRunListResponseSchema.parse({ data: [run] })).toEqual({ data: [keptRun] });
  });

  it('strips undeclared keys from a started run', () => {
    expect(researchRunEnvelopeResponseSchema.parse({ data: run })).toEqual({ data: keptRun });
  });
});

describe('lakeOwnershipOfferResponseSchema', () => {
  it('strips undeclared keys and the server-only audit trail', () => {
    const offer = {
      id: 'o1',
      dataLakeId: 'lake1',
      recipientUserId: 'u2',
      status: 'pending',
      auditPrincipal: { principalKind: 'api_key', principalId: 'key1' },
      priorOwnerUserIds: ['u0'],
      offeredVia: 'transfer-route',
      ...RAW_KEYS,
    };

    expect(lakeOwnershipOfferResponseSchema.parse({ offer })).toEqual({
      offer: { id: 'o1', dataLakeId: 'lake1', recipientUserId: 'u2', status: 'pending' },
    });
  });
});

describe('dataLakeBatchResponseSchema', () => {
  it('strips undeclared keys and the server-only billing attribution', () => {
    const batch = {
      id: 'b1',
      dataLakeId: 'lake1',
      status: 'uploading',
      taxonomyStatus: 'none',
      files: [{ fileName: 'a.md' }],
      taxonomyBilling: { organizationId: 'org1', apiKeyId: 'key1' },
      uploaderManageRung: 'owner',
      uploadHistoryRecordedAt: new Date('2026-10-01T00:00:00Z'),
      ...RAW_KEYS,
    };

    expect(dataLakeBatchResponseSchema.parse(batch)).toEqual({
      id: 'b1',
      dataLakeId: 'lake1',
      status: 'uploading',
      taxonomyStatus: 'none',
      files: [{ fileName: 'a.md' }],
    });
  });
});

describe('dataLakeBatchListResponseSchema', () => {
  it('strips undeclared keys and the server-only billing attribution per listed batch', () => {
    const row = {
      id: 'b1',
      status: 'completed',
      taxonomyBilling: { organizationId: 'org1', apiKeyId: 'key1' },
      ...RAW_KEYS,
    };

    expect(dataLakeBatchListResponseSchema.parse({ data: [row] })).toEqual({
      data: [{ id: 'b1', status: 'completed' }],
    });
  });
});

describe('dataLakeArticleListResponseSchema', () => {
  it('strips undeclared keys per file and keeps the membership arm and paging', () => {
    const parsed = dataLakeArticleListResponseSchema.parse({
      data: [{ id: 'a1', fileName: 'a.md', membershipArm: 'tag', ...RAW_KEYS }],
      total: 1,
      hasMore: false,
    });

    expect(parsed).toEqual({
      data: [{ id: 'a1', fileName: 'a.md', membershipArm: 'tag' }],
      total: 1,
      hasMore: false,
    });
  });
});
