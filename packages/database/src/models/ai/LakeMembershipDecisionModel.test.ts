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

  it('rejects a second row for the same (lake, name) at the database', async () => {
    // upsertDecision can never collide - it matches on the very key it would collide on - so the
    // suite exercised the index only by asserting it exists. The index is what stops a SECOND
    // writer (BaseRepository.create, the admission door) leaving two contradictory rulings for one
    // name with the plan free to pick either. Raw driver inserts, to bypass the repository.
    await LakeMembershipDecisionModel.collection.insertOne({ ...decision() } as never);

    await expect(LakeMembershipDecisionModel.collection.insertOne({ ...decision() } as never)).rejects.toThrow(
      /E11000/
    );
  });

  it('upsert creates one row, then overwrites it in place on the (lake, name) key', async () => {
    const created = await repo.upsertDecision(decision());
    expect(created.decision).toBe('keep-both');

    const updated = await repo.upsertDecision(
      decision({ decision: 'keep-newest', groupIdentity: 'f1:hash-a|f2:hash-b|f3:hash-c' })
    );

    // Asserted non-undefined FIRST, and not merged into the line below: `toJSON()` only carries `id`
    // when the schema asks for virtuals, and this schema did not - so the identity check under it
    // was `undefined === undefined` and held whether or not the row was reused.
    expect(created.id).toEqual(expect.any(String));
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

  // The pairing guard lives on the SCHEMA, not in `recordMembershipDecision`, because that service
  // is one writer of several. These three go through the doors that bypass it: BaseRepository's
  // inherited `create` and `update`, and a raw findOneAndUpdate. Delete either schema hook and one
  // of them starts passing.
  describe('keptFabFileId/decision pairing', () => {
    it('refuses a keep-specific that names nobody, through BaseRepository.create', async () => {
      await expect(repo.create(decision({ decision: 'keep-specific', keptFabFileId: null }) as never)).rejects.toThrow(
        /keptFabFileId is required/
      );
    });

    it('refuses a kept member on a decision that has no such notion, through BaseRepository.create', async () => {
      await expect(repo.create(decision({ decision: 'keep-newest', keptFabFileId: 'f1' }) as never)).rejects.toThrow(
        /only meaningful for keep-specific/
      );
    });

    it('refuses the same mismatch on the update path, where a required validator cannot see it', async () => {
      const created = await repo.upsertDecision(decision({ decision: 'keep-specific', keptFabFileId: 'f1' }));

      await expect(repo.update({ id: created.id, keptFabFileId: null, decision: 'keep-specific' } as never)).rejects.toThrow(
        /keptFabFileId is required/
      );
    });

    it('lets a partial update that names neither field through', async () => {
      // The guard reads what the write NAMES, so an update touching only groupIdentity changed
      // neither half of the pair and must not be rejected for the row's existing shape.
      const created = await repo.upsertDecision(decision({ decision: 'keep-specific', keptFabFileId: 'f1' }));

      const updated = await repo.update({ id: created.id, groupIdentity: 'f1:hash-z' } as never);

      expect(updated?.groupIdentity).toBe('f1:hash-z');
      expect(updated?.keptFabFileId).toBe('f1');
    });
  });

  it('rejects a decision value the planner cannot act on', async () => {
    await expect(
      repo.upsertDecision(decision({ decision: 'keep-oldest' as ILakeMembershipDecision['decision'] }))
    ).rejects.toThrow();
  });
});
