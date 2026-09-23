import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RecordLakeMembershipChangeInput } from '@bike4mind/common';
import { LAKE_MEMBERSHIP_CHANGE_AUDIT_RETENTION_DAYS } from '@bike4mind/common';
import {
  lakeMembershipChangeEventRepository as repo,
  LakeMembershipChangeEventModel,
} from './LakeMembershipChangeEventModel';
import { setupMongoTest } from '../../__test__/utils';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const baseInput = (overrides: Partial<RecordLakeMembershipChangeInput> = {}): RecordLakeMembershipChangeInput => ({
  principalKind: 'user',
  principalId: 'alice',
  dataLakeId: 'lake-1',
  fabFileId: 'file-1',
  action: 'added',
  origin: 'person',
  ...overrides,
});

describe('LakeMembershipChangeEventModel / lakeMembershipChangeEventRepository.record', () => {
  setupMongoTest();
  beforeEach(async () => {
    await LakeMembershipChangeEventModel.ensureIndexes();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('persistence fidelity', () => {
    it('round-trips every input field', async () => {
      const event = await repo.record(
        baseInput({
          principalKind: 'agent',
          principalId: 'agent-1',
          onBehalfOfUserId: 'alice',
          organizationId: 'org-1',
          fabFileId: 'file-42',
          action: 'removed',
          origin: 'connector',
        })
      );

      const stored = await LakeMembershipChangeEventModel.findById(event.id).lean();
      expect(stored).toMatchObject({
        principalKind: 'agent',
        principalId: 'agent-1',
        onBehalfOfUserId: 'alice',
        organizationId: 'org-1',
        dataLakeId: 'lake-1',
        fabFileId: 'file-42',
        action: 'removed',
        origin: 'connector',
      });
    });

    it('rejects a value outside the vocabulary rather than storing it', async () => {
      await expect(repo.record(baseInput({ action: 'reticulate' as never }))).rejects.toThrow();
      await expect(repo.record(baseInput({ origin: 'robot' as never }))).rejects.toThrow();
      await expect(repo.record(baseInput({ principalKind: 'sudo' as never }))).rejects.toThrow();
    });
  });

  describe('retention', () => {
    it('always uses the fixed retention - there is no caller-facing lever', async () => {
      const event = await repo.record(baseInput());
      expect(event.expiresAt.getTime()).toBe(NOW.getTime() + LAKE_MEMBERSHIP_CHANGE_AUDIT_RETENTION_DAYS * DAY_MS);
    });
  });

  describe('append-only shape', () => {
    it('declares a TTL index on expiresAt', async () => {
      const indexes = await LakeMembershipChangeEventModel.collection.indexes();
      const ttl = indexes.find(i => i.key?.expiresAt === 1);
      expect(ttl?.expireAfterSeconds).toBe(0);
    });

    it('serves the by-lake read from the index, sort included - no blocking SORT', async () => {
      const plan = await LakeMembershipChangeEventModel.find({ dataLakeId: 'lake-1' })
        .sort({ createdAt: -1, _id: -1 })
        .limit(3)
        .explain('queryPlanner');
      const winning = JSON.stringify((plan as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan);
      expect(winning).toContain('IXSCAN');
      expect(winning).not.toContain('"stage":"SORT"');
    });

    it('stamps createdAt but never updatedAt - an event has no later version', async () => {
      const event = await repo.record(baseInput());
      const stored = await LakeMembershipChangeEventModel.findById(event.id).lean();
      expect(stored?.createdAt).toBeInstanceOf(Date);
      expect((stored as { updatedAt?: Date })?.updatedAt).toBeUndefined();
    });

    it('leaves expiresAt untouched by an ordinary update, since it is immutable', async () => {
      const event = await repo.record(baseInput());
      const tampered = new Date(NOW.getTime() + 1000);
      await LakeMembershipChangeEventModel.updateOne({ _id: event.id }, { $set: { expiresAt: tampered } });
      const stored = await LakeMembershipChangeEventModel.findById(event.id).lean();
      expect(stored?.expiresAt.getTime()).toBe(event.expiresAt.getTime());
    });

    it('exposes the append-only surface', () => {
      expect(typeof repo.record).toBe('function');
      expect(typeof repo.listByLake).toBe('function');
      // The runtime-vs-type gap this guarantee actually needs is asserted at the type level - see
      // `LakeMembershipChangeEventRepositoryIsAppendOnly` in LakeMembershipChangeEventTypes.ts.
    });
  });

  describe('listByLakeSince', () => {
    const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
    const seed = async () => {
      for (const [offset, fileId] of [
        [0, 'oldest'],
        [1000, 'middle'],
        [2000, 'newest'],
      ] as const) {
        vi.setSystemTime(at(offset));
        await repo.record(baseInput({ fabFileId: fileId }));
      }
      vi.setSystemTime(at(1000));
      await repo.record(baseInput({ dataLakeId: 'lake-2', fabFileId: 'other-lake' }));
    };

    it('returns only events strictly after the bound, newest first', async () => {
      await seed();

      const events = await repo.listByLakeSince('lake-1', at(-1));
      expect(events.map(e => e.fabFileId)).toEqual(['newest', 'middle', 'oldest']);
    });

    it('excludes an event written exactly ON the bound, so adjacent windows do not both claim it', async () => {
      await seed();

      const events = await repo.listByLakeSince('lake-1', at(1000));
      expect(events.map(e => e.fabFileId)).toEqual(['newest']);
    });

    it('scopes to the lake asked for', async () => {
      await seed();

      const events = await repo.listByLakeSince('lake-1', at(-1));
      expect(events.map(e => e.fabFileId)).not.toContain('other-lake');
    });

    it('drops the OLDEST rows when the limit bites, so the newest are always in hand', async () => {
      await seed();

      const events = await repo.listByLakeSince('lake-1', at(-1), { limit: 2 });
      expect(events.map(e => e.fabFileId)).toEqual(['newest', 'middle']);
    });

    it('is empty for a lake with no recorded changes', async () => {
      await seed();

      expect(await repo.listByLakeSince('never-touched', at(-1))).toEqual([]);
    });

    it('is empty when the whole log predates the bound', async () => {
      await seed();

      expect(await repo.listByLakeSince('lake-1', at(9000))).toEqual([]);
    });

    it('serves the windowed read from the index, sort included - no blocking SORT', async () => {
      await seed();

      const plan = await LakeMembershipChangeEventModel.find({ dataLakeId: 'lake-1', createdAt: { $gt: at(-1) } })
        .sort({ createdAt: -1, _id: -1 })
        .limit(2)
        .explain('queryPlanner');
      const winning = JSON.stringify((plan as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan);
      expect(winning).toContain('IXSCAN');
      expect(winning).not.toContain('"stage":"SORT"');
    });
  });

  describe('oldestEventAt', () => {
    it("reports the lake's first retained event - how far back the log can be believed", async () => {
      vi.setSystemTime(new Date(NOW.getTime() + 5000));
      await repo.record(baseInput({ fabFileId: 'later' }));
      vi.setSystemTime(NOW);
      await repo.record(baseInput({ fabFileId: 'first' }));

      expect(await repo.oldestEventAt('lake-1')).toEqual(NOW);
    });

    it('is undefined for a lake with no events - silence, not a zero point', async () => {
      await repo.record(baseInput({ dataLakeId: 'lake-2' }));

      expect(await repo.oldestEventAt('lake-1')).toBeUndefined();
    });
  });

  describe('listByLake', () => {
    it('returns only that lake, newest first', async () => {
      await repo.record(baseInput({ dataLakeId: 'lake-1', fabFileId: 'a' }));
      vi.setSystemTime(new Date(NOW.getTime() + 1000));
      await repo.record(baseInput({ dataLakeId: 'lake-1', fabFileId: 'b' }));
      await repo.record(baseInput({ dataLakeId: 'lake-2', fabFileId: 'c' }));

      const events = await repo.listByLake('lake-1');
      expect(events.map(e => e.fabFileId)).toEqual(['b', 'a']);
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
  });
});
