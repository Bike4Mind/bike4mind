import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DEFAULT_CONVERGENCE_WAVE,
  planLakeConvergenceRun,
  redactCrossLakeIdentities,
  type ConvergenceLake,
  type LakeConvergencePlanReport,
} from './convergeLakePolicy';

const lake: ConvergenceLake = {
  id: 'lake-1',
  name: 'Lake One',
  datalakeTag: 'datalake:lake-one',
  fileTagPrefix: 'lake-one:',
  createdByUserId: 'owner-1',
  organizationId: undefined,
  requiredPassageTokenTarget: 512,
};

/** A settled, measured member whose chunks were built at `target`. */
const member = (fabFileId: string, target: number | null, over: Record<string, unknown> = {}) => ({
  fabFileId,
  userId: 'owner-1',
  fileName: `${fabFileId}.pdf`,
  tags: [{ name: 'datalake:lake-one' }],
  chunkCount: 4,
  vectorizedChunkCount: 4,
  error: null,
  notes: null,
  maxChunkCharLength: 1000,
  chunkedPassageTokenTarget: target,
  ...over,
});

const makeAdapters = (
  members: ReturnType<typeof member>[],
  opts: { chunkSizePct?: number; sharePct?: number; otherLakes?: Record<string, unknown>[] } = {}
) => ({
  db: {
    fabFiles: { findLakeConvergenceMembers: vi.fn().mockResolvedValue(members) },
    dataLakes: {
      // The file's own lake, plus whatever disagreeing lake a test wires in.
      findByDatalakeTag: vi.fn(async (tag: string) =>
        tag === 'datalake:lake-one'
          ? { id: 'lake-1', name: 'Lake One', datalakeTag: tag, requiredPassageTokenTarget: 512 }
          : (opts.otherLakes ?? []).find(l => l.datalakeTag === tag) ?? null
      ),
      find: vi.fn().mockResolvedValue([]),
    },
    adminSettings: { findBySettingNames: vi.fn().mockResolvedValue([]), findAll: vi.fn().mockResolvedValue([]) },
    scopedSettings: { findOverrides: vi.fn().mockResolvedValue([]) },
  },
  embeddingModel: 'text-embedding-3-small',
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
});

describe('planLakeConvergenceRun', () => {
  beforeEach(() => vi.clearAllMocks());

  // Epic decision 5, and the "gate the work, not the use" rule: the refusal must land BEFORE the
  // member read, or a lake that can never converge still pays for a full scan on every check.
  it('refuses an inherited-policy lake without reading a single member', async () => {
    const adapters = makeAdapters([member('a', 2100)]);

    const { report, wave } = await planLakeConvergenceRun({ ...lake, requiredPassageTokenTarget: undefined }, adapters);

    expect(report.refusal).toBe('policyInherited');
    expect(wave).toEqual([]);
    expect(adapters.db.fabFiles.findLakeConvergenceMembers).not.toHaveBeenCalled();
  });

  it('plans the non-conformant members of an explicit-policy lake', async () => {
    const adapters = makeAdapters([member('a', 2100), member('b', 512), member('c', 2100)]);

    const { report, wave } = await planLakeConvergenceRun(lake, adapters);

    expect(report.refusal).toBeNull();
    expect(report.membersConsidered).toBe(3);
    expect(report.convergeableCount).toBe(2);
    expect(wave.map(w => w.fabFileId)).toEqual(['a', 'c']);
    expect(report.skipped.conformant).toBe(1);
  });

  // Chunks are shared by every consumer of a file. Repairing a member at THIS lake's target when
  // another lake requires a different one makes the two take turns rewriting it forever.
  it('refuses a member another lake requires a different target for', async () => {
    const adapters = makeAdapters(
      [member('shared', 2100, { tags: [{ name: 'datalake:lake-one' }, { name: 'datalake:lake-two' }] })],
      {
        otherLakes: [
          { id: 'lake-2', name: 'Lake Two', datalakeTag: 'datalake:lake-two', requiredPassageTokenTarget: 1024 },
        ],
      }
    );

    const { report, wave } = await planLakeConvergenceRun(lake, adapters);

    expect(wave).toEqual([]);
    expect(report.crossLakeConflictCount).toBe(1);
    expect(report.crossLakeConflicts[0]).toMatchObject({
      fabFileId: 'shared',
      conflictingLakes: [{ lakeId: 'lake-2', name: 'Lake Two' }],
    });
    // The defect a live run exposed: `convergeableCount` counts whole-lake drift BEFORE this check,
    // so it stays 1 while nothing can actually run. A caller that labels an action with it shows a
    // count that repairs nothing on every click, forever - `waveSize` is the honest number.
    expect(report.convergeableCount).toBe(1);
    expect(report.waveSize).toBe(0);
  });

  it('reports waveSize as what would actually run, not the pre-refusal drift count', async () => {
    const adapters = makeAdapters(
      [
        member('a', 2100),
        member('b', 2100),
        member('shared', 2100, { tags: [{ name: 'datalake:lake-one' }, { name: 'datalake:lake-two' }] }),
      ],
      {
        otherLakes: [
          { id: 'lake-2', name: 'Lake Two', datalakeTag: 'datalake:lake-two', requiredPassageTokenTarget: 1024 },
        ],
      }
    );

    const { report, wave } = await planLakeConvergenceRun(lake, adapters);

    expect(report.convergeableCount).toBe(3);
    expect(report.waveSize).toBe(2);
    expect(wave).toHaveLength(2);
  });

  it('caps waveSize by the wave bound, so it never overstates one run', async () => {
    const members = Array.from({ length: 40 }, (_, i) => member(`f${i}`, 2100));

    const { report } = await planLakeConvergenceRun(lake, makeAdapters(members), 5);

    expect(report.convergeableCount).toBe(40);
    expect(report.waveSize).toBe(5);
  });

  // The conflict record #1662 stores lists only the lakes currently VIOLATED, so a lake the file
  // happens to satisfy today is absent from it. Convergence must check every member lake that
  // DECLARES a requirement, or it silently breaks the lake the file was already fine for.
  it('refuses a member for a lake it currently SATISFIES but would be broken for', async () => {
    const adapters = makeAdapters(
      // Stamped at 1024: satisfies lake-two (1024) today, violates lake-one (512).
      [member('shared', 1024, { tags: [{ name: 'datalake:lake-one' }, { name: 'datalake:lake-two' }] })],
      {
        otherLakes: [
          { id: 'lake-2', name: 'Lake Two', datalakeTag: 'datalake:lake-two', requiredPassageTokenTarget: 1024 },
        ],
      }
    );

    const { report, wave } = await planLakeConvergenceRun(lake, adapters);

    expect(wave).toEqual([]);
    expect(report.crossLakeConflictCount).toBe(1);
  });

  it('converges a member whose other lake requires the SAME effective target', async () => {
    const adapters = makeAdapters(
      [member('shared', 2100, { tags: [{ name: 'datalake:lake-one' }, { name: 'datalake:lake-two' }] })],
      {
        otherLakes: [
          { id: 'lake-2', name: 'Lake Two', datalakeTag: 'datalake:lake-two', requiredPassageTokenTarget: 512 },
        ],
      }
    );

    const { report, wave } = await planLakeConvergenceRun(lake, adapters);

    expect(wave.map(w => w.fabFileId)).toEqual(['shared']);
    expect(report.crossLakeConflictCount).toBe(0);
  });

  // A member lake that declares no requirement constrains nothing - only a DIFFERENT declared
  // target is a conflict, or every file in a second, policy-less lake would be unrepairable.
  it('ignores a member lake that declares no requirement', async () => {
    const adapters = makeAdapters(
      [member('shared', 2100, { tags: [{ name: 'datalake:lake-one' }, { name: 'datalake:lake-two' }] })],
      { otherLakes: [{ id: 'lake-2', name: 'Lake Two', datalakeTag: 'datalake:lake-two' }] }
    );

    const { wave } = await planLakeConvergenceRun(lake, adapters);

    expect(wave.map(w => w.fabFileId)).toEqual(['shared']);
  });

  it('bounds the wave without shrinking the share the bulk-change guard reads', async () => {
    const members = Array.from({ length: 40 }, (_, i) => member(`f${i}`, 2100));
    const adapters = makeAdapters(members);

    const { report, wave } = await planLakeConvergenceRun(lake, adapters, 5);

    expect(wave).toHaveLength(5);
    // 40 of 40 would be rewritten - the guard must see 100%, not 5/40.
    expect(report.convergeableCount).toBe(40);
    expect(report.changeShare).toBe(1);
    expect(report.requiresConfirmation).toBe(true);
  });

  it('does not require confirmation for a small, ordinary drift', async () => {
    const members = [...Array.from({ length: 38 }, (_, i) => member(`ok${i}`, 512)), member('bad', 2100)];
    const adapters = makeAdapters(members);

    const { report } = await planLakeConvergenceRun(lake, adapters);

    expect(report.requiresConfirmation).toBe(false);
    expect(report.bulkChangeShareThreshold).toBe(0.25);
  });

  // An absent datalakeTag would serialize to null in the membership $match and degrade the query to
  // "files with no tags" across every tenant. Same guard computeLakeHealth carries.
  it('refuses to plan over an unscoped match when the lake carries no datalakeTag', async () => {
    const adapters = makeAdapters([member('a', 2100)]);

    const { report, wave } = await planLakeConvergenceRun({ ...lake, datalakeTag: '' as never }, adapters);

    expect(wave).toEqual([]);
    expect(report.membersConsidered).toBe(0);
    expect(adapters.db.fabFiles.findLakeConvergenceMembers).not.toHaveBeenCalled();
  });

  it('defaults the wave bound when the caller passes none', async () => {
    const members = Array.from({ length: DEFAULT_CONVERGENCE_WAVE + 10 }, (_, i) => member(`f${i}`, 2100));

    const { wave } = await planLakeConvergenceRun(lake, makeAdapters(members));

    expect(wave).toHaveLength(DEFAULT_CONVERGENCE_WAVE);
  });

  // The cross-lake check is per-member and DB-backed, on an endpoint the manager panel opens with.
  // Members of one lake share an owner and a tag set, so the reads must collapse - uncached this is
  // one findByDatalakeTag per meta-tag per member plus an owner query each, up to the wave bound.
  it('reads each lake once per run rather than once per member', async () => {
    const members = Array.from({ length: 20 }, (_, i) => member(`f${i}`, 2100));
    const adapters = makeAdapters(members);

    const { wave } = await planLakeConvergenceRun(lake, adapters, 20);

    expect(wave).toHaveLength(20);
    expect(adapters.db.dataLakes.findByDatalakeTag).toHaveBeenCalledTimes(1);
    expect(adapters.db.dataLakes.find).toHaveBeenCalledTimes(1);
  });
});

// The read gate is deliberately wider than manage - assertLakeAccess has a public arm that crosses
// orgs - while the conflicting lakes named here are resolved by membership with no access filter at
// all. So a member tagged into both a public lake and a stranger's private one would otherwise hand
// every reader of the public lake the private lake's id, name and policy.
describe('redactCrossLakeIdentities', () => {
  const planWithConflict = (): LakeConvergencePlanReport =>
    ({
      refusal: null,
      policy: { requiredTarget: 512, effectiveRequiredTarget: 512, policyChars: 3072 },
      membersConsidered: 3,
      convergeableCount: 1,
      waveSize: 0,
      changeShare: 0.33,
      requiresConfirmation: false,
      bulkChangeShareThreshold: 0.25,
      skipped: { conformant: 2, unmeasured: 0, indexingInFlight: 0, previouslyFailed: 0, irreducibleOvershoot: 0 },
      crossLakeConflicts: [
        {
          fabFileId: 'shared',
          fileName: 'shared.pdf',
          conflictingLakes: [{ lakeId: 'lake-2', name: 'Acme Q3 Diligence', effectiveRequiredTarget: 1024 }],
        },
      ],
      crossLakeConflictCount: 1,
      scanTruncated: false,
    }) as LakeConvergencePlanReport;

  it('strips the conflicting lake id and name, keeping the target that explains the refusal', () => {
    const redacted = redactCrossLakeIdentities(planWithConflict());

    expect(redacted.crossLakeConflicts[0].conflictingLakes).toEqual([{ effectiveRequiredTarget: 1024 }]);
  });

  it('leaves the counts and the caller-visible file identity intact', () => {
    const redacted = redactCrossLakeIdentities(planWithConflict());

    expect(redacted.crossLakeConflictCount).toBe(1);
    expect(redacted.convergeableCount).toBe(1);
    expect(redacted.crossLakeConflicts[0]).toMatchObject({ fabFileId: 'shared', fileName: 'shared.pdf' });
  });

  it('does not mutate the report it was given, so the manage path still has the identities', () => {
    const plan = planWithConflict();
    redactCrossLakeIdentities(plan);

    expect(plan.crossLakeConflicts[0].conflictingLakes[0]).toMatchObject({ lakeId: 'lake-2' });
  });
});
