import { describe, it, expect, beforeEach } from 'vitest';
import type { ILakeMembershipDecision } from '@bike4mind/common';
import { lakeMembershipDecisionRepository as repo, LakeMembershipDecisionModel } from './LakeMembershipDecisionModel';
import { setupMongoTest } from '../../__test__/utils';

const decision = (overrides: Partial<ILakeMembershipDecision> = {}): ILakeMembershipDecision => ({
  dataLakeId: 'lake-1',
  fileName: 'policy.md',
  decision: 'keep-both',
  keptFabFileId: null,
  groupIdentity: 'f1:hash-a|f2:hash-b',
  decidedByUserId: 'owner-1',
  decidedAt: new Date('2026-09-01T00:00:00Z'),
  source: 'repair',
  ...overrides,
});

describe('LakeMembershipDecisionRepository', () => {
  setupMongoTest();
  // setupMongoTest's beforeEach dropDatabase()s (indexes included), and this model is not in its
  // one-time ensureIndexes list - rebuild the unique index per test so the collision case is real.
  beforeEach(async () => {
    await LakeMembershipDecisionModel.ensureIndexes();
  });

  it('upsert creates one row, then overwrites it in place on the (lake, name) key', async () => {
    const created = await repo.upsertDecision(decision());
    expect(created.decision).toBe('keep-both');

    const updated = await repo.upsertDecision(
      decision({ decision: 'keep-newest', groupIdentity: 'f1:hash-a|f2:hash-b|f3:hash-c' })
    );

    expect(updated.id).toBe(created.id); // the owner re-answered; they did not answer twice
    expect(updated.decision).toBe('keep-newest');
    expect(updated.groupIdentity).toBe('f1:hash-a|f2:hash-b|f3:hash-c');
    expect(await LakeMembershipDecisionModel.countDocuments({ dataLakeId: 'lake-1', fileName: 'policy.md' })).toBe(1);
  });

  // The stale-kept-id case the repository's `$set` exists for: without writing null unconditionally,
  // a keep-specific ruling later changed to keep-newest would leave the old kept id behind, where a
  // future reader would take it for the owner's current choice.
  it('clears keptFabFileId when a keep-specific ruling is replaced by one that has no kept member', async () => {
    await repo.upsertDecision(decision({ decision: 'keep-specific', keptFabFileId: 'f1' }));
    const updated = await repo.upsertDecision(decision({ decision: 'keep-newest', keptFabFileId: null }));
    expect(updated.keptFabFileId).toBeNull();
  });

  it('scopes rows by (lake, name): the same name in two lakes is two independent rulings', async () => {
    await repo.upsertDecision(decision({ dataLakeId: 'lake-1', decision: 'keep-both' }));
    await repo.upsertDecision(decision({ dataLakeId: 'lake-2', decision: 'keep-newest' }));

    const lake1 = await repo.listByLake('lake-1');
    const lake2 = await repo.listByLake('lake-2');
    expect(lake1.map(d => d.decision)).toEqual(['keep-both']);
    expect(lake2.map(d => d.decision)).toEqual(['keep-newest']);
  });

  it('listByLake returns one lake rulings sorted by name, and nothing for a lake with none', async () => {
    await repo.upsertDecision(decision({ fileName: 'zeta.md' }));
    await repo.upsertDecision(decision({ fileName: 'alpha.md' }));

    expect((await repo.listByLake('lake-1')).map(d => d.fileName)).toEqual(['alpha.md', 'zeta.md']);
    expect(await repo.listByLake('lake-unknown')).toEqual([]);
  });

  it('clearDecision removes one ruling and reports whether it removed anything', async () => {
    await repo.upsertDecision(decision());

    expect(await repo.clearDecision('lake-1', 'policy.md')).toBe(true);
    expect(await repo.listByLake('lake-1')).toEqual([]);
    // Second call is the double-click / already-undone case: no row, no error, and it says so.
    expect(await repo.clearDecision('lake-1', 'policy.md')).toBe(false);
  });

  it('deleteForLake drops the lake rulings and leaves another lake alone; a re-run is a no-op', async () => {
    await repo.upsertDecision(decision({ fileName: 'a.md' }));
    await repo.upsertDecision(decision({ fileName: 'b.md' }));
    await repo.upsertDecision(decision({ dataLakeId: 'lake-2', fileName: 'a.md' }));

    expect(await repo.deleteForLake('lake-1')).toBe(2);
    expect(await repo.listByLake('lake-1')).toEqual([]);
    expect((await repo.listByLake('lake-2')).map(d => d.fileName)).toEqual(['a.md']);
    // Idempotent, because the purge sweep this serves is re-run whole on a DLQ retry.
    expect(await repo.deleteForLake('lake-1')).toBe(0);
  });

  it('rejects a decision value the planner cannot act on', async () => {
    await expect(
      repo.upsertDecision(decision({ decision: 'keep-oldest' as ILakeMembershipDecision['decision'] }))
    ).rejects.toThrow();
  });
});
