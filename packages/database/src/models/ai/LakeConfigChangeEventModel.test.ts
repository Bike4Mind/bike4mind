import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ILakeConfigFieldChange, RecordLakeConfigChangeInput } from '@bike4mind/common';
import {
  LAKE_CONFIG_AUDIT_RETENTION_DEFAULT_DAYS,
  LAKE_CONFIG_AUDIT_RETENTION_FLOOR_DAYS,
  LAKE_CONFIG_AUDIT_RETENTION_MAX_DAYS,
  LAKE_CONFIG_MAX_CHANGES,
  lakeConfigTextFingerprint,
} from '@bike4mind/common';
import { lakeConfigChangeEventRepository as repo, LakeConfigChangeEventModel } from './LakeConfigChangeEventModel';
import { setupMongoTest } from '../../__test__/utils';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const nameChange = (before: string, after: string): ILakeConfigFieldChange => ({
  field: 'name',
  kind: 'literal',
  before,
  after,
});

const baseInput = (overrides: Partial<RecordLakeConfigChangeInput> = {}): RecordLakeConfigChangeInput => ({
  principalKind: 'user',
  principalId: 'alice',
  dataLakeId: 'lake-1',
  manageRung: 'creator',
  action: 'update',
  changes: [nameChange('old', 'new')],
  ...overrides,
});

describe('LakeConfigChangeEventModel / lakeConfigChangeEventRepository.record', () => {
  setupMongoTest();
  // setupMongoTest's beforeEach dropDatabase()s (indexes included) and this model is not in its
  // one-time ensureIndexes list, so the TTL/query indexes are rebuilt per test - otherwise an
  // index-shaped assertion could pass on a prior run's leftover. Fake timers give a deterministic
  // `now` without record() accepting one, which would let a caller backdate an event past its own
  // floor-clamped window.
  beforeEach(async () => {
    await LakeConfigChangeEventModel.ensureIndexes();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Service-level tests all mock this repository, so a field the SCHEMA does not declare is
  // invisible to them: mongoose strict mode drops an unknown key on write without complaint. Only
  // a real round trip catches it, which is what this whole block is for.
  describe('persistence fidelity', () => {
    it('round-trips every input field', async () => {
      const event = await repo.record(
        baseInput({
          principalKind: 'agent',
          principalId: 'agent-1',
          onBehalfOfUserId: 'alice',
          organizationId: 'org-1',
          manageRung: 'platform-admin',
          action: 'visibility',
          changes: [{ field: 'isPublic', kind: 'literal', before: false, after: true }],
        })
      );

      const stored = await LakeConfigChangeEventModel.findById(event.id).lean();
      expect(stored).toMatchObject({
        principalKind: 'agent',
        principalId: 'agent-1',
        onBehalfOfUserId: 'alice',
        organizationId: 'org-1',
        dataLakeId: 'lake-1',
        manageRung: 'platform-admin',
        action: 'visibility',
      });
      expect(stored?.changes).toHaveLength(1);
      expect(stored?.changes[0]).toMatchObject({ field: 'isPublic', kind: 'literal', before: false, after: true });
    });

    it('persists the three scalar shapes a bounded value can take', async () => {
      const event = await repo.record(
        baseInput({
          changes: [
            { field: 'name', kind: 'literal', before: 'old', after: 'new' },
            { field: 'isPublic', kind: 'literal', before: false, after: true },
            { field: 'requiredPassageTokenTarget', kind: 'literal', before: 256, after: 512 },
          ],
        })
      );
      const stored = await LakeConfigChangeEventModel.findById(event.id).lean();
      expect(stored?.changes.map(c => [c.before, c.after])).toEqual([
        ['old', 'new'],
        [false, true],
        [256, 512],
      ]);
    });

    it('persists a fingerprint change without ever storing the prompt', async () => {
      const secret = 'Answer only as the acquiring party';
      const event = await repo.record(
        baseInput({
          changes: [
            {
              field: 'systemPrompt',
              kind: 'fingerprint',
              beforeFingerprint: lakeConfigTextFingerprint(''),
              afterFingerprint: lakeConfigTextFingerprint(secret),
            },
          ],
        })
      );

      const stored = await LakeConfigChangeEventModel.findById(event.id).lean();
      expect(JSON.stringify(stored)).not.toContain('acquiring');
      expect(stored?.changes[0].afterFingerprint).toMatchObject(lakeConfigTextFingerprint(secret));
      expect(stored?.changes[0].before).toBeUndefined();
    });

    it('caps the changes array so one event cannot grow unbounded', async () => {
      const many = Array.from({ length: LAKE_CONFIG_MAX_CHANGES + 5 }, () => nameChange('a', 'b'));
      const event = await repo.record(baseInput({ changes: many }));
      const stored = await LakeConfigChangeEventModel.findById(event.id).lean();
      expect(stored?.changes).toHaveLength(LAKE_CONFIG_MAX_CHANGES);
    });

    it('rejects a value outside the vocabulary rather than storing it', async () => {
      await expect(repo.record(baseInput({ manageRung: 'sudo' as never }))).rejects.toThrow();
      await expect(repo.record(baseInput({ action: 'reticulate' as never }))).rejects.toThrow();
      await expect(
        repo.record(baseInput({ changes: [{ ...nameChange('a', 'b'), field: 'wat' as never }] }))
      ).rejects.toThrow();
    });

    // The never-a-second-copy-of-the-prompt property, enforced at the SCHEMA layer rather than
    // resting on diffLakeConfig being careful. diffLakeConfig is not the only thing that can ever
    // write here, and a verbatim prompt in a three-year-retention collection is precisely the
    // outcome the fingerprinting exists to make impossible.
    it('refuses to store a fingerprinted field as a literal, whoever the writer is', async () => {
      await expect(
        repo.record(
          baseInput({
            changes: [
              { field: 'systemPrompt', kind: 'literal', before: 'Answer only as the acquiring party' } as never,
            ],
          })
        )
      ).rejects.toThrow(/must be recorded as a fingerprint/);
    });

    it('refuses a fingerprinted field carrying a literal value alongside its fingerprint', async () => {
      await expect(
        repo.record(
          baseInput({
            changes: [
              {
                field: 'systemPrompt',
                kind: 'fingerprint',
                beforeFingerprint: lakeConfigTextFingerprint(''),
                afterFingerprint: lakeConfigTextFingerprint('x'),
                after: 'Answer only as the acquiring party',
              } as never,
            ],
          })
        )
      ).rejects.toThrow(/must not carry a literal/);
    });

    it('refuses a literal longer than the stored-value cap, whatever the caller did', async () => {
      await expect(
        repo.record(baseInput({ changes: [{ field: 'description', kind: 'literal', after: 'x'.repeat(5000) }] }))
      ).rejects.toThrow(/exceeds the stored-value cap/);
    });

    it('rejects a fingerprint hash longer than the digest, so the prompt cannot ride in that field', async () => {
      await expect(
        repo.record(
          baseInput({
            changes: [
              {
                field: 'systemPrompt',
                kind: 'fingerprint',
                afterFingerprint: { present: true, length: 5, hash: 'x'.repeat(500) },
              },
            ],
          })
        )
      ).rejects.toThrow();
    });
  });

  describe('retention, resolved inside record() so no caller can bypass it', () => {
    it('uses the platform default when the caller resolved nothing', async () => {
      const event = await repo.record(baseInput());
      expect(event.expiresAt.getTime()).toBe(NOW.getTime() + LAKE_CONFIG_AUDIT_RETENTION_DEFAULT_DAYS * DAY_MS);
    });

    it('ratchets an unclamped low value UP to the floor', async () => {
      const event = await repo.record(baseInput({ retentionDays: 1 }));
      expect(event.expiresAt.getTime()).toBe(NOW.getTime() + LAKE_CONFIG_AUDIT_RETENTION_FLOOR_DAYS * DAY_MS);
    });

    it('clamps an unclamped high value DOWN to the ceiling', async () => {
      const event = await repo.record(baseInput({ retentionDays: 999999 }));
      expect(event.expiresAt.getTime()).toBe(NOW.getTime() + LAKE_CONFIG_AUDIT_RETENTION_MAX_DAYS * DAY_MS);
    });

    it('honors an in-range configured value', async () => {
      const event = await repo.record(baseInput({ retentionDays: 2000 }));
      expect(event.expiresAt.getTime()).toBe(NOW.getTime() + 2000 * DAY_MS);
    });
  });

  describe('append-only shape', () => {
    it('declares a TTL index on expiresAt, without which retention is a stored number and nothing more', async () => {
      const indexes = await LakeConfigChangeEventModel.collection.indexes();
      const ttl = indexes.find(i => i.key?.expiresAt === 1);
      expect(ttl?.expireAfterSeconds).toBe(0);
    });

    it('indexes the owner-facing history query it exists to serve, tie-break included', async () => {
      const indexes = await LakeConfigChangeEventModel.collection.indexes();
      expect(indexes.some(i => i.key?.dataLakeId === 1 && i.key?.createdAt === -1 && i.key?._id === -1)).toBe(true);
    });

    it('stamps createdAt but never updatedAt - an event has no later version', async () => {
      const event = await repo.record(baseInput());
      const stored = await LakeConfigChangeEventModel.findById(event.id).lean();
      expect(stored?.createdAt).toBeInstanceOf(Date);
      expect((stored as { updatedAt?: Date })?.updatedAt).toBeUndefined();
    });

    it('leaves expiresAt untouched by an ordinary update, since it is immutable', async () => {
      const event = await repo.record(baseInput());
      const tampered = new Date(NOW.getTime() + 1000);
      await LakeConfigChangeEventModel.updateOne({ _id: event.id }, { $set: { expiresAt: tampered } });
      const stored = await LakeConfigChangeEventModel.findById(event.id).lean();
      expect(stored?.expiresAt.getTime()).toBe(event.expiresAt.getTime());
    });

    it('exposes the append-only surface', () => {
      expect(typeof repo.record).toBe('function');
      expect(typeof repo.listByLake).toBe('function');
      // NOTE: there is deliberately no assertion here that `update`/`delete` are absent. They are
      // present on the runtime object (BaseRepository defines them) and only the TYPE withholds
      // them, so any runtime check would be either false or a tautology over a hand-written list.
      // That guarantee is asserted where it can actually be evaluated - see
      // `LakeConfigChangeEventRepositoryIsAppendOnly` in LakeConfigChangeEventTypes.ts. It cannot
      // live in this file: the package tsconfig excludes `**/*.test.ts` and vitest transpiles
      // without typechecking, so a `@ts-expect-error` in a spec is never checked by anything.
    });
  });

  describe('listByLake', () => {
    it('returns only that lake, newest first', async () => {
      await repo.record(baseInput({ dataLakeId: 'lake-1', changes: [nameChange('a', 'b')] }));
      vi.setSystemTime(new Date(NOW.getTime() + 1000));
      await repo.record(baseInput({ dataLakeId: 'lake-1', changes: [nameChange('b', 'c')] }));
      await repo.record(baseInput({ dataLakeId: 'lake-2', changes: [nameChange('x', 'y')] }));

      const events = await repo.listByLake('lake-1');
      expect(events).toHaveLength(2);
      expect(events.map(e => e.changes[0].after)).toEqual(['c', 'b']);
    });

    it('honors the limit', async () => {
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(new Date(NOW.getTime() + i * 1000));
        await repo.record(baseInput());
      }
      expect(await repo.listByLake('lake-1', { limit: 2 })).toHaveLength(2);
    });

    it('is empty for a lake with no recorded changes', async () => {
      expect(await repo.listByLake('never-touched')).toEqual([]);
    });

    // `createdAt` alone is a PARTIAL order, so same-millisecond events may come back either way
    // round and the history list can reorder under a reader between two page loads. The instability
    // itself is NOT assertable: nothing in a test can make the engine exercise its freedom to
    // reorder a tie, and repeated reads against a small collection return insertion order whether
    // or not the tie-break is there - such a test passes with the fix reverted. So the sort SPEC is
    // what gets pinned, plus the resulting order on a real tie.
    it('sorts on a total order, so same-createdAt events cannot come back reordered', async () => {
      const findSpy = vi.spyOn(LakeConfigChangeEventModel, 'find');
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const event = await repo.record(baseInput({ changes: [nameChange('a', `v${i}`)] }));
        ids.push(String(event.id));
      }

      const events = await repo.listByLake('lake-1');
      expect(findSpy).toHaveBeenCalledTimes(1);
      expect(findSpy.mock.results[0].value.getOptions().sort).toEqual({ createdAt: -1, _id: -1 });
      findSpy.mockRestore();

      // The tie is real - every event shares one createdAt - so the returned order is decided
      // entirely by the tie-break, newest-inserted first.
      const stored = await LakeConfigChangeEventModel.find({ dataLakeId: 'lake-1' }).lean();
      expect(new Set(stored.map(e => e.createdAt.getTime())).size).toBe(1);
      expect(events.map(e => String(e.id))).toEqual([...ids].reverse());
    });

    // A tie-break the index cannot serve trades an unstable order for a blocking in-memory SORT on
    // a collection whose retention runs years, so the index has to cover the sort, not just exist.
    it('serves the history sort from the index, with no in-memory SORT stage', async () => {
      const plan = await LakeConfigChangeEventModel.find({ dataLakeId: 'lake-1' })
        .sort({ createdAt: -1, _id: -1 })
        .explain('queryPlanner');
      expect(JSON.stringify(plan)).not.toContain('"stage":"SORT"');
      expect(JSON.stringify(plan)).toContain('IXSCAN');
    });
  });
});
