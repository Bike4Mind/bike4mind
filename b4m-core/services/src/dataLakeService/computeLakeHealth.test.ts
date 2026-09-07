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

// Mirrors IFabFileRepository.findDataLakeHealthMembers' row shape EXACTLY (incl. vectorizedChunkCount,
// error, fileSize, serverTextHash) - if this drifts from the interface, the in-flight/errored gate or
// the duplicate-report fields silently no-op in tests.
type Member = {
  fabFileId: string;
  fileName?: string;
  fileSize: number | null;
  serverTextHash: string | null;
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
  fileSize: null,
  serverTextHash: null,
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
  fileSize: null,
  serverTextHash: null,
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
  userId: string | null;
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
      fileSize: null,
      serverTextHash: null,
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
      fileSize: null,
      serverTextHash: null,
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
      fileSize: null,
      serverTextHash: null,
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

  it('reports duplicateMembers for two upload generations sharing a fileName (#2239)', async () => {
    const older: Member = { ...healthyMember('gen1'), fileName: 'contract.pdf', fileSize: 1000 };
    const newer: Member = { ...healthyMember('gen2'), fileName: 'contract.pdf', fileSize: 1200 };
    const unique: Member = { ...healthyMember('solo'), fileName: 'solo.txt', fileSize: 5 };
    const health = await computeLakeHealth(lake, makeAdapters([older, newer, unique]) as never);

    expect(health.duplicateMembers.memberCount).toBe(2);
    expect(health.duplicateMembers.groupCount).toBe(1);
    expect(health.duplicateMembers.groups).toEqual([
      {
        fileName: 'contract.pdf',
        members: [
          { fabFileId: 'gen1', fileSize: 1000 },
          { fabFileId: 'gen2', fileSize: 1200 },
        ],
        memberCount: 2,
        contentComparison: 'differing',
      },
    ]);
  });

  it('reports an empty duplicateMembers report when no fileName repeats', async () => {
    const health = await computeLakeHealth(lake, makeAdapters([healthyMember('a'), healthyMember('b')]) as never);
    expect(health.duplicateMembers).toEqual({ memberCount: 0, groupCount: 0, groups: [] });
  });

  it('excludes a member the raw scan admits but selectLakeHealthMembers would drop from duplicate grouping', async () => {
    // A chunkless, unmarked row (never had passages) reaches the raw scan only if a caller's own
    // $match is looser than the shared filter - exercised here directly against the pure function to
    // prove findDuplicateMembers is called with the same filtered set summarizeLakeHealth grades, not
    // the raw rows.
    const chunkless: Member = { ...healthyMember('ghost'), fileName: 'contract.pdf', chunkCount: 0 };
    const real: Member = { ...healthyMember('gen1'), fileName: 'contract.pdf' };
    const health = await computeLakeHealth(lake, makeAdapters([chunkless, real]) as never);

    expect(health.duplicateMembers.memberCount).toBe(0);
  });

  it("caps the duplicate-groups list and each group's member list, keeping exact counts", async () => {
    const manyGroups = Array.from({ length: 60 }, (_, g) =>
      Array.from({ length: 3 }, (_, i) => ({ ...healthyMember(`g${g}-m${i}`), fileName: `dup${g}.txt` }))
    ).flat();
    const bigGroup = Array.from({ length: 25 }, (_, i) => ({ ...healthyMember(`big-m${i}`), fileName: 'big.txt' }));
    const health = await computeLakeHealth(lake, makeAdapters([...manyGroups, ...bigGroup]) as never);

    expect(health.duplicateMembers.groupCount).toBe(61);
    expect(health.duplicateMembers.groups).toHaveLength(50);
    expect(health.duplicateMembers.memberCount).toBe(60 * 3 + 25);
    const big = health.duplicateMembers.groups.find(g => g.fileName === 'big.txt');
    expect(big?.memberCount).toBe(25);
    expect(big?.members).toHaveLength(20);
  });
});

describe('computeLakeHealth membership dimension (#2245)', () => {
  const row = (over: Partial<MembershipRow> = {}): MembershipRow => ({
    fabFileId: 'f1',
    fileName: 'report.pdf',
    serverTextHash: null,
    fileSize: 100,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    userId: 'u1',
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

  it('strips the per-member fingerprint and owner from the response', async () => {
    // This handler's read gate admits `public`, and serverTextHash is a stable global content
    // identifier - a confirmation oracle over any document a reader already holds, and a way to
    // correlate one document across lakes under different names. Both fields exist for the repair
    // arm, which reads the report in-process; neither has ever had a client reader.
    const result = await computeLakeHealth(
      lake,
      makeAdapters([], [row({ serverTextHash: 'aaa' }), row({ fabFileId: 'f2', serverTextHash: 'aaa' })]) as never
    );

    const [member] = result.membership.duplicateGroups[0].members;
    expect(member).not.toHaveProperty('serverTextHash');
    expect(member).not.toHaveProperty('userId');
    // The derived verdict survives, which is the part a client needs from the hash comparison.
    expect(result.membership.duplicateGroups[0].bucket).toBe('proven-identical');
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

describe('computeLakeHealth inconsistency surface (#2242)', () => {
  const storedReport = {
    findings: [
      {
        kind: 'relationship-conflict',
        // Lifted verbatim from a member document - an organization name, not a system value.
        subject: 'northwind logistics',
        evidence: [
          { fabFileId: 'f1', fileName: 'deck.pdf', excerpt: 'Northwind Logistics is a customer in production.' },
          { fabFileId: 'f2', fileName: 'crm.pdf', excerpt: 'Northwind Logistics is a prospect evaluating us.' },
        ],
      },
    ],
    countsByKind: {
      'superlative-conflict': 0,
      'metric-disagreement': 0,
      'relationship-conflict': 1,
      'expired-claim': 0,
    },
    sampled: true,
    truncated: false,
    memberSampled: false,
    memberCount: 2,
    documentCount: 2,
  } as never;

  const withReport = (over: Record<string, unknown> = {}) =>
    ({
      ...lake,
      inconsistencyReport: storedReport,
      inconsistencyComputedAt: new Date('2026-06-01T00:00:00Z'),
      ...over,
    }) as never;

  it('carries NO document prose onto the read-gated health response', async () => {
    // The P0 this fixes. GET /health is read-gated (org and public-lake readers reach it) and applies
    // no redaction, while the report is manage-only - redactLakeForActor withholds the stored fields
    // and POST /inconsistencies is write-gated for that reason. Serializing the whole response and
    // searching it is the assertion that survives someone adding a new prose-bearing field later; a
    // per-field check would pass while the new field leaked.
    const result = await computeLakeHealth(withReport(), makeAdapters([], []) as never);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Northwind Logistics');
    expect(serialized).not.toContain('northwind logistics');
    expect(serialized).not.toContain('deck.pdf');
    expect(serialized).not.toContain('excerpt');
    expect(serialized).not.toContain('findings');
  });

  it('still reports the counts, so the surface can say something happened', async () => {
    const result = await computeLakeHealth(withReport(), makeAdapters([], []) as never);

    expect(result.inconsistency).toEqual({
      computedAt: new Date('2026-06-01T00:00:00Z'),
      sampled: true,
      memberSampled: false,
      memberCount: 2,
      findingCount: 1,
      truncated: false,
      countsByKind: {
        'superlative-conflict': 0,
        'metric-disagreement': 0,
        'relationship-conflict': 1,
        'expired-claim': 0,
      },
    });
  });

  it('reports findingCount from the EXACT counts, not the length of a capped list', async () => {
    // The stored list is capped and the counts are not, so reading the array's length put a saturated
    // number beside exact per-kind figures that summed higher. A surface rendering both showed
    // arithmetic that did not add up, and one trusting findingCount under-reported.
    const truncatedReport = {
      findings: [{ kind: 'metric-disagreement', subject: 'uptime', evidence: [], documentCount: 2 }],
      countsByKind: {
        'superlative-conflict': 3,
        'metric-disagreement': 40,
        'relationship-conflict': 7,
        'expired-claim': 200,
      },
      sampled: true,
      truncated: true,
      memberSampled: true,
      memberCount: 200,
    } as never;

    const result = await computeLakeHealth(
      withReport({ inconsistencyReport: truncatedReport }),
      makeAdapters([], []) as never
    );

    expect(result.inconsistency?.findingCount).toBe(250);
    expect(result.inconsistency?.truncated).toBe(true);
  });

  it('carries memberCount so a pass that scanned nothing does not read as a clean lake', async () => {
    const neverScanned = {
      findings: [],
      countsByKind: {
        'superlative-conflict': 0,
        'metric-disagreement': 0,
        'relationship-conflict': 0,
        'expired-claim': 0,
      },
      sampled: true,
      truncated: false,
      memberSampled: false,
      memberCount: 0,
    } as never;

    const result = await computeLakeHealth(
      withReport({ inconsistencyReport: neverScanned }),
      makeAdapters([], []) as never
    );

    // findingCount 0 AND memberCount 0: nothing was read, which is not the same answer as "clean".
    expect(result.inconsistency?.findingCount).toBe(0);
    expect(result.inconsistency?.memberCount).toBe(0);
  });

  it('reports null when detection has never run, which is NOT the same as clean', async () => {
    const result = await computeLakeHealth(lake, makeAdapters([], []) as never);

    expect(result.inconsistency).toBeNull();
  });

  it('carries a stored report with no timestamp as computedAt null rather than dropping it', async () => {
    const result = await computeLakeHealth(
      withReport({ inconsistencyComputedAt: undefined }),
      makeAdapters([], []) as never
    );

    expect(result.inconsistency?.computedAt).toBeNull();
    expect(result.inconsistency?.findingCount).toBe(1);
  });

  it('reads the STORED report rather than computing one', async () => {
    // Detection reads chunk text and this function may not (#1665), so health is a reader here.
    const adapters = makeAdapters([], []);

    await computeLakeHealth(withReport(), adapters as never);

    expect(adapters.db.fabFiles.findDataLakeMembershipMembers).toHaveBeenCalledTimes(1);
  });
});
