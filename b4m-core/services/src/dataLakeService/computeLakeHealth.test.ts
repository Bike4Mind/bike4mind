import { describe, it, expect, vi, beforeEach } from 'vitest';

// Isolate the service's own logic (policy selection, member fetch, truncation, capping) from the
// cached platform-settings read. scopeForLake stays real - the service passes it straight through.
const { resolveScopedSetting } = vi.hoisted(() => ({
  resolveScopedSetting: vi.fn(async () => ({ value: 512, source: 'platform' })),
}));
vi.mock('../settings/resolveScopedSetting', async orig => ({
  ...(await (orig() as Promise<object>)),
  resolveScopedSetting,
}));

import { computeLakeHealth } from './computeLakeHealth';

// Mirrors IFabFileRepository.findDataLakeHealthMembers' row shape EXACTLY (incl. vectorizedChunkCount
// + error) - if this drifts from the interface, the in-flight/errored gate silently no-ops in tests.
type Member = {
  fabFileId: string;
  fileName?: string;
  chunkCount: number;
  vectorizedChunkCount: number | null;
  error: string | null;
  chunkedCharCount: number | null;
  maxChunkCharLength: number | null;
  embeddedChunkCount: number | null;
  embeddedCharCount: number | null;
};

const healthyMember = (id: string): Member => ({
  fabFileId: id,
  chunkCount: 3,
  vectorizedChunkCount: 3, // settled, fully vectorized
  error: null,
  chunkedCharCount: 9000,
  maxChunkCharLength: 3000,
  embeddedChunkCount: 3,
  embeddedCharCount: 9000,
});
const brokenMember = (id: string): Member => ({
  fabFileId: id,
  chunkCount: 1,
  vectorizedChunkCount: 1, // oversized chunk reaches terminal -> settled, so P3 genuinely fails
  error: null,
  chunkedCharCount: 20000,
  maxChunkCharLength: 20000, // fails P1
  embeddedChunkCount: 0, // fails P3
  embeddedCharCount: 0,
});

const lake = {
  id: 'lake-1',
  datalakeTag: 'datalake:acme',
  fileTagPrefix: 'acme:',
  createdByUserId: 'u1',
  organizationId: undefined,
  requiredPassageTokenTarget: undefined as number | null | undefined,
};

const makeAdapters = (members: Member[]) => ({
  db: {
    fabFiles: { findDataLakeHealthMembers: vi.fn(async () => members) },
    adminSettings: { findBySettingNames: vi.fn(), findAll: vi.fn() },
    scopedSettings: { findOverrides: vi.fn() },
  },
  logger: { warn: vi.fn() },
});

beforeEach(() => {
  resolveScopedSetting.mockClear();
  resolveScopedSetting.mockResolvedValue({ value: 512, source: 'platform' });
});

describe('computeLakeHealth', () => {
  it('grades an inherited-policy lake against the resolved DefaultChunkSize', async () => {
    const adapters = makeAdapters([healthyMember('a'), healthyMember('b')]);
    const health = await computeLakeHealth({ ...lake, requiredPassageTokenTarget: undefined }, adapters as never);

    expect(health.policy.source).toBe('inherited');
    expect(health.policy.chunkTokenTarget).toBe(512);
    expect(health.reachableShare).toBe(1);
    expect(health.affectedMembers).toHaveLength(0);
    expect(health.scanTruncated).toBe(false);
    expect(adapters.db.fabFiles.findDataLakeHealthMembers).toHaveBeenCalledWith(
      { datalakeTag: 'datalake:acme', fileTagPrefix: 'acme:', creatorUserId: 'u1' },
      25_000
    );
  });

  it('prefers the lake explicit target and flags P4 when it exceeds the serve ceiling', async () => {
    const adapters = makeAdapters([healthyMember('a')]);
    const health = await computeLakeHealth({ ...lake, requiredPassageTokenTarget: 2000 }, adapters as never);

    expect(health.policy.source).toBe('explicit');
    expect(health.policy.chunkTokenTarget).toBe(2000);
    expect(health.predicates.serveCapMeetsPolicy).toBe('fail');
  });

  it('surfaces failing members with their failed predicates', async () => {
    const adapters = makeAdapters([healthyMember('good'), brokenMember('bad')]);
    const health = await computeLakeHealth(lake, adapters as never);

    expect(health.affectedMemberCount).toBe(1);
    expect(health.affectedMembers[0].fabFileId).toBe('bad');
    expect(health.affectedMembers[0].failed).toEqual(['chunkWithinPolicy', 'chunkCountConsistent', 'fullyVectorized']);
  });

  it('caps the returned drill-down list but keeps an exact affectedMemberCount', async () => {
    const many = Array.from({ length: 250 }, (_, i) => brokenMember(`bad${i}`));
    const health = await computeLakeHealth(lake, makeAdapters(many) as never);

    expect(health.affectedMembers).toHaveLength(200);
    expect(health.affectedMemberCount).toBe(250);
  });

  it('flags scanTruncated and logs when a lake exceeds the member scan limit', async () => {
    const overflow = Array.from({ length: 25_001 }, (_, i) => healthyMember(`f${i}`));
    const adapters = makeAdapters(overflow);
    const health = await computeLakeHealth(lake, adapters as never);

    expect(health.scanTruncated).toBe(true);
    expect(health.coverage.membersWithChunks).toBe(25_000); // computed over the first N only
    expect(adapters.logger.warn).toHaveBeenCalled();
  });

  it('reports null reachableShare (not 0%) when the lake is entirely unmeasured', async () => {
    const unmeasured: Member = {
      fabFileId: 'legacy',
      chunkCount: 5,
      vectorizedChunkCount: 5, // legacy: fully vectorized long ago, just never char-backfilled
      error: null,
      chunkedCharCount: null,
      maxChunkCharLength: null,
      embeddedChunkCount: 5,
      embeddedCharCount: null,
    };
    const health = await computeLakeHealth(lake, makeAdapters([unmeasured]) as never);

    expect(health.reachableShare).toBeNull();
    expect(health.coverage).toEqual({ measuredMembers: 0, membersWithChunks: 1 });
    // P3 still grades from vector presence even with no char data.
    expect(health.predicates.fullyVectorized.pass).toBe(1);
  });

  it('excludes a still-vectorizing member from the reachable share (the mid-ingest gate is live end-to-end)', async () => {
    // Char rollups present (measured) but vectorizedChunkCount < chunkCount: chunk-complete stamped the
    // char rollups and zeroed the vector rollups in one write, and the first vectorize batch has not
    // landed. This must NOT read as 0% reachable. If the repo contract dropped vectorizedChunkCount, the
    // gate would silently no-op and this member would drag the share to ~0 - exactly what B2 guards.
    const indexing: Member = {
      fabFileId: 'indexing',
      chunkCount: 3,
      vectorizedChunkCount: 0,
      error: null,
      chunkedCharCount: 9000,
      maxChunkCharLength: 3000,
      embeddedChunkCount: 0,
      embeddedCharCount: 0,
    };
    const health = await computeLakeHealth(lake, makeAdapters([healthyMember('done'), indexing]) as never);

    expect(health.reachableShare).toBe(1); // only the settled file counts
    expect(health.coverage).toEqual({ measuredMembers: 1, membersWithChunks: 2 });
    expect(health.predicates.fullyVectorized.unknown).toBe(1); // the indexing file is pending, not failed
    expect(health.predicates.fullyVectorized.fail).toBe(0);
  });

  it('grades a permanently-FAILED file as unhealthy, not "still indexing" (B1)', async () => {
    // vectorizedChunkCount never reaches chunkCount, but `error` is set: the file is broken, not in
    // flight. It must fail P3 and contribute its real 0 reachable chars, so a lake of failed files
    // reads unhealthy rather than the neutral "not measured".
    const failed: Member = {
      fabFileId: 'failed',
      chunkCount: 4,
      vectorizedChunkCount: 1, // stuck below chunkCount forever
      error: 'embedding provider rejected the request',
      chunkedCharCount: 12000,
      maxChunkCharLength: 3000,
      embeddedChunkCount: 0,
      embeddedCharCount: 0,
    };
    const health = await computeLakeHealth(lake, makeAdapters([failed]) as never);

    expect(health.reachableShare).toBe(0); // measured as broken, not excluded
    expect(health.coverage).toEqual({ measuredMembers: 1, membersWithChunks: 1 });
    expect(health.predicates.fullyVectorized.fail).toBe(1);
    expect(health.affectedMembers[0].failed).toContain('fullyVectorized');
  });
});
