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

type MembershipRow = {
  fabFileId: string;
  fileName?: string;
  serverTextHash: string | null;
  fileSize: number | null;
  createdAt: Date | null;
  arm: 'meta-tag' | 'prefix';
};

const makeAdapters = (members: Member[], membershipRows: MembershipRow[] = []) => ({
  db: {
    fabFiles: {
      findDataLakeHealthMembers: vi.fn(async () => members),
      // A SEPARATE read from the health one, and the tests keep them separate too: the two admit
      // different populations on purpose (health drops chunkless members, membership keeps them),
      // so reusing one fixture for both would hide exactly that difference.
      findDataLakeMembershipMembers: vi.fn(async () => membershipRows),
    },
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
      { kind: 'owned', datalakeTag: 'datalake:acme', fileTagPrefix: 'acme:', creatorUserId: 'u1' },
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

describe('computeLakeHealth membership dimension (#2245)', () => {
  const row = (over: Partial<MembershipRow> = {}): MembershipRow => ({
    fabFileId: 'f1',
    fileName: 'report.pdf',
    serverTextHash: null,
    fileSize: 100,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    arm: 'meta-tag',
    ...over,
  });

  it('reads membership from its OWN query, not from the health rows', async () => {
    // The two populations differ deliberately - health excludes chunkless members, membership keeps
    // them - so a "reuse the rows we already have" refactor is the regression this pins.
    const adapters = makeAdapters([], [row(), row({ fabFileId: 'f2' })]);

    const result = await computeLakeHealth(lake, adapters as never);

    expect(adapters.db.fabFiles.findDataLakeMembershipMembers).toHaveBeenCalledTimes(1);
    expect(result.membership.totalMembers).toBe(2);
    expect(result.membership.duplicateNameCount).toBe(1);
  });

  it('scopes the membership read to the same lake scope health uses', async () => {
    const adapters = makeAdapters([], []);

    await computeLakeHealth(lake, adapters as never);

    expect(adapters.db.fabFiles.findDataLakeMembershipMembers).toHaveBeenCalledWith(
      expect.objectContaining({ datalakeTag: 'datalake:acme', fileTagPrefix: 'acme:', creatorUserId: 'u1' }),
      expect.any(Number)
    );
  });

  it('discloses the principal every membership number was computed as', async () => {
    // #2243's lesson: a membership count with no principal attached is the defect, not a
    // presentation gap - "Reachable 100%" was true as the creator and said so nowhere.
    const result = await computeLakeHealth(lake, makeAdapters([], [row()]) as never);

    expect(result.membership.scope).toEqual({ creatorUserId: 'u1', fileTagPrefix: 'acme:' });
  });

  it('returns a well-formed membership section on the null-datalakeTag guard', async () => {
    // That guard returns early WITHOUT querying; a consumer must still get a real section rather
    // than undefined, or every reader needs its own optional-chaining.
    const adapters = makeAdapters([], [row()]);

    const result = await computeLakeHealth({ ...lake, datalakeTag: '' } as never, adapters as never);

    expect(adapters.db.fabFiles.findDataLakeMembershipMembers).not.toHaveBeenCalled();
    expect(result.membership.totalMembers).toBe(0);
    expect(result.membership.duplicateGroups).toEqual([]);
    expect(result.membership.scope).toEqual({ creatorUserId: 'u1', fileTagPrefix: 'acme:' });
  });

  it('scopes a REGISTRY lake as registry, and discloses the arm that actually ran', async () => {
    // The defect this pins: a hardcoded DATA_LAKES lake has no backing document, so its synthetic
    // one carries createdByUserId ''. An `owned` scope therefore fails closed to meta-tag-only in
    // buildDataLakeMembershipFilter - dropping the prefix arm, which on a registry lake is the OPEN
    // one those lakes are largely made of - while a disclosure read off the lake document still
    // named `opti:`. The report then read as "there is a prefix arm and nothing came through it".
    const registryLake = {
      ...lake,
      id: 'opti-knowledge',
      datalakeTag: 'datalake:opti-knowledge',
      fileTagPrefix: 'opti:',
      createdByUserId: '',
    };
    const adapters = makeAdapters([], [row({ arm: 'prefix' })]);

    const result = await computeLakeHealth(registryLake, adapters as never);

    for (const read of [
      adapters.db.fabFiles.findDataLakeMembershipMembers,
      adapters.db.fabFiles.findDataLakeHealthMembers,
    ]) {
      expect(read).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'registry', datalakeTag: 'datalake:opti-knowledge', fileTagPrefix: 'opti:' }),
        expect.any(Number)
      );
    }
    // '' is neither documented state for creatorUserId; a registry lake has no creator to anchor to.
    expect(result.membership.scope).toEqual({ creatorUserId: null, fileTagPrefix: 'opti:' });
  });

  it('discloses no prefix arm when the membership filter would drop the one the lake carries', async () => {
    // A reserved-namespace prefix is dropped by buildDataLakeMembershipFilter because it would match
    // every OTHER lake's membership tag. Deriving the disclosure from the lake document would claim
    // an arm that never ran - the same class of lie as the registry case, reached a different way.
    const reservedPrefixLake = { ...lake, fileTagPrefix: 'datalake:' };

    const result = await computeLakeHealth(reservedPrefixLake, makeAdapters([], [row()]) as never);

    expect(result.membership.scope).toEqual({ creatorUserId: 'u1', fileTagPrefix: null });
  });

  it('runs the health and membership reads concurrently', async () => {
    // Independent reads over one scope; sequencing them doubled the wall clock on a lake near the
    // scan bound. Pinned by observing that the second read starts before the first resolves.
    let healthStarted = false;
    let membershipStartedBeforeHealthResolved = false;
    const adapters = makeAdapters([], []);
    adapters.db.fabFiles.findDataLakeHealthMembers = vi.fn(async () => {
      healthStarted = true;
      await new Promise(resolve => setTimeout(resolve, 5));
      return [];
    });
    adapters.db.fabFiles.findDataLakeMembershipMembers = vi.fn(async () => {
      membershipStartedBeforeHealthResolved = healthStarted;
      return [];
    });

    await computeLakeHealth(lake, adapters as never);

    expect(membershipStartedBeforeHealthResolved).toBe(true);
  });

  it('caps a duplicate group members array but keeps an exact memberCount', async () => {
    // maxGroups bounds the group LIST; without a per-group cap one shared file name could ship up to
    // MEMBER_SCAN_LIMIT member objects. The sibling drill-down (affectedMembers) already caps at 200
    // with an exact count beside it, and this must not imply fewer members than there are.
    const rows = Array.from({ length: 250 }, (_, i) =>
      row({ fabFileId: `f${i}`, createdAt: new Date(2026, 0, 1, 0, 0, i) })
    );

    const result = await computeLakeHealth(lake, makeAdapters([], rows) as never);

    const group = result.membership.duplicateGroups[0];
    expect(group.members).toHaveLength(200);
    expect(group.memberCount).toBe(250);
    expect(result.membership.duplicateMemberCount).toBe(250);
  });

  it('flags membership.scanTruncated and logs which end was cut when the scan is bounded', async () => {
    // The membership truncation path had no coverage: the existing truncation test passes HEALTH
    // members while membershipRows defaults to [], so membership.scanTruncated was false everywhere.
    const rows = Array.from({ length: 25_001 }, (_, i) => row({ fabFileId: `f${i}`, fileName: `f${i}.pdf` }));
    const adapters = makeAdapters([], rows);

    const result = await computeLakeHealth(lake, adapters as never);

    expect(result.membership.scanTruncated).toBe(true);
    expect(result.membership.totalMembers).toBe(25_000);
    // The bias is directional and adverse, so the warning has to say so - the members outside an
    // _id-ascending window are the newest, which is the generation a re-upload creates.
    expect(adapters.logger.warn).toHaveBeenCalledWith(expect.stringContaining('OLDEST'));
  });

  it('never auto-collapses two chunkless members carrying null hashes', async () => {
    // End-to-end guard on the trap: two images share serverTextHash null, and they are also exactly
    // the members health drops. If membership ever reused the health rows OR compared nulls, this
    // pair would be reported as safe to collapse.
    const result = await computeLakeHealth(
      lake,
      makeAdapters(
        [],
        [row({ fabFileId: 'a', serverTextHash: null }), row({ fabFileId: 'b', serverTextHash: null })]
      ) as never
    );

    expect(result.membership.duplicateGroups[0].bucket).toBe('unverified');
    expect(result.membership.bucketCounts['proven-identical']).toBe(0);
  });
});
