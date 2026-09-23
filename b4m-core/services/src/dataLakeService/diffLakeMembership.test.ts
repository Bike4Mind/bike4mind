import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeDocument, ILakeMembershipChangeEventDocument } from '@bike4mind/common';
import {
  diffLakeMembership,
  clampLakeMembershipDiffLimit,
  LAKE_MEMBERSHIP_DIFF_LIMIT,
  LAKE_MEMBERSHIP_DIFF_MAX_LIMIT,
} from './diffLakeMembership';

const FROM = new Date('2026-06-01T00:00:00Z');
const TO = new Date('2026-07-01T00:00:00Z');
const NOW = new Date('2026-08-01T00:00:00Z');

const lake = (over: Partial<IDataLakeDocument> = {}) =>
  ({
    id: 'lake1',
    name: 'Ops Lake',
    datalakeTag: 'datalake:ops',
    fileTagPrefix: 'ops/',
    createdByUserId: 'creator1',
    ...over,
  }) as IDataLakeDocument;

let seq = 0;
const event = (over: Partial<ILakeMembershipChangeEventDocument> = {}) =>
  ({
    id: `evt${++seq}`,
    createdAt: new Date('2026-06-15T00:00:00Z'),
    principalKind: 'user',
    principalId: '000000000000000000000001',
    dataLakeId: 'lake1',
    fabFileId: 'file1',
    action: 'added',
    origin: 'person',
    ...over,
  }) as ILakeMembershipChangeEventDocument;

/** The repository hands back newest-first; these helpers keep the fixtures readable in time order. */
const newestFirst = (events: ILakeMembershipChangeEventDocument[]) =>
  [...events].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

const adapters = (
  events: ILakeMembershipChangeEventDocument[],
  over: {
    memberIds?: string[];
    oldestEventAt?: Date;
    findByIds?: ReturnType<typeof vi.fn>;
    limit?: number;
    to?: Date;
  } = {}
) => {
  const listByLakeSince = vi.fn().mockResolvedValue(newestFirst(events));
  const oldestEventAt = vi
    .fn()
    .mockResolvedValue(
      'oldestEventAt' in over
        ? over.oldestEventAt
        : events.length > 0
          ? newestFirst(events).at(-1)!.createdAt
          : undefined
    );
  const findLiveIdsByDataLakeTag = vi.fn().mockResolvedValue(over.memberIds ?? []);
  const findByIds = over.findByIds ?? vi.fn().mockResolvedValue([]);
  return {
    listByLakeSince,
    oldestEventAt,
    findLiveIdsByDataLakeTag,
    findByIds,
    adapters: {
      db: {
        lakeMembershipChangeEvents: { listByLakeSince, oldestEventAt },
        fabFiles: { findLiveIdsByDataLakeTag } as never,
        users: { findByIds } as never,
      },
      from: FROM,
      to: over.to ?? TO,
      limit: over.limit,
      now: NOW,
    },
  };
};

describe('clampLakeMembershipDiffLimit', () => {
  it('defaults, floors and ceilings', () => {
    expect(clampLakeMembershipDiffLimit(undefined)).toBe(LAKE_MEMBERSHIP_DIFF_LIMIT);
    expect(clampLakeMembershipDiffLimit(Number.NaN)).toBe(LAKE_MEMBERSHIP_DIFF_LIMIT);
    expect(clampLakeMembershipDiffLimit(0)).toBe(1);
    expect(clampLakeMembershipDiffLimit(999999)).toBe(LAKE_MEMBERSHIP_DIFF_MAX_LIMIT);
  });
});

describe('diffLakeMembership', () => {
  describe('added and removed', () => {
    it('classifies a join and a leave inside the window', async () => {
      const { adapters: a } = adapters(
        [
          event({ fabFileId: 'joined', action: 'added', createdAt: new Date('2026-06-10T00:00:00Z') }),
          event({ fabFileId: 'left', action: 'removed', createdAt: new Date('2026-06-20T00:00:00Z') }),
        ],
        { memberIds: ['joined'], oldestEventAt: new Date('2026-05-01T00:00:00Z') }
      );

      const view = await diffLakeMembership(lake(), a);

      expect(view.added.map(e => e.fabFileId)).toEqual(['joined']);
      expect(view.removed.map(e => e.fabFileId)).toEqual(['left']);
    });

    it('reports a file that left and rejoined as ONE unchanged file, not an add and a remove', async () => {
      const { adapters: a } = adapters(
        [
          event({ fabFileId: 'churned', action: 'removed', createdAt: new Date('2026-06-10T00:00:00Z') }),
          event({ fabFileId: 'churned', action: 'added', createdAt: new Date('2026-06-20T00:00:00Z') }),
        ],
        { memberIds: ['churned'], oldestEventAt: new Date('2026-05-01T00:00:00Z') }
      );

      const view = await diffLakeMembership(lake(), a);

      expect(view.added).toEqual([]);
      expect(view.removed).toEqual([]);
      expect(view.unchangedCount).toBe(1);
    });

    it('folds repeated flips into one entry and reports how many there were', async () => {
      const { adapters: a } = adapters(
        [
          event({ fabFileId: 'f1', action: 'added', createdAt: new Date('2026-06-05T00:00:00Z') }),
          event({ fabFileId: 'f1', action: 'removed', createdAt: new Date('2026-06-06T00:00:00Z') }),
          event({ fabFileId: 'f1', action: 'added', createdAt: new Date('2026-06-07T00:00:00Z'), origin: 'connector' }),
        ],
        { memberIds: ['f1'], oldestEventAt: new Date('2026-05-01T00:00:00Z') }
      );

      const view = await diffLakeMembership(lake(), a);

      expect(view.added).toHaveLength(1);
      expect(view.added[0]).toMatchObject({ fabFileId: 'f1', flips: 3, origin: 'connector' });
    });

    it('ignores events after the window end when classifying, but rewinds membership through them', async () => {
      // `late` joins AFTER `to`, so it is not an addition in this window and must not be counted as
      // a member that sat through it either.
      const { adapters: a } = adapters(
        [event({ fabFileId: 'late', action: 'added', createdAt: new Date('2026-07-15T00:00:00Z') })],
        { memberIds: ['late'], oldestEventAt: new Date('2026-05-01T00:00:00Z') }
      );

      const view = await diffLakeMembership(lake(), a);

      expect(view.added).toEqual([]);
      expect(view.removed).toEqual([]);
      expect(view.unchangedCount).toBe(0);
    });

    it('counts a file removed after the window as a member that sat through it', async () => {
      const { adapters: a } = adapters(
        [event({ fabFileId: 'gone', action: 'removed', createdAt: new Date('2026-07-15T00:00:00Z') })],
        { memberIds: [], oldestEventAt: new Date('2026-05-01T00:00:00Z') }
      );

      const view = await diffLakeMembership(lake(), a);

      expect(view.removed).toEqual([]);
      expect(view.unchangedCount).toBe(1);
    });
  });

  describe('tombstones are not members', () => {
    // A soft delete leaves the lake tags in place, so a tombstone still matches the membership
    // filter; only the live-only read keeps it out of the sat-through count.
    it('does not count a file soft-deleted BEFORE the window as having sat through it', async () => {
      // The lake holds two tagged files and no events in the window; `dead` was soft-deleted before
      // `from`, so the live read names only `steady`. A tombstone-inclusive read would answer 2.
      const { adapters: a } = adapters([], {
        memberIds: ['steady'],
        oldestEventAt: new Date('2026-05-01T00:00:00Z'),
      });

      const view = await diffLakeMembership(lake(), a);

      expect(view.unchangedCount).toBe(1);
    });

    it('reads LIVE members only, so a tombstone never reaches the rewind', async () => {
      const { adapters: a, findLiveIdsByDataLakeTag } = adapters([], {
        memberIds: [],
        oldestEventAt: new Date('2026-05-01T00:00:00Z'),
      });

      await diffLakeMembership(lake(), a);

      expect(findLiveIdsByDataLakeTag).toHaveBeenCalledTimes(1);
    });

    it('never counts a file that left inside the window as having sat through it', async () => {
      // Belt and braces: even if the live read still named this file (a tombstone that kept its
      // tags), a file the window shows leaving is not a member at both ends.
      const { adapters: a } = adapters(
        [event({ fabFileId: 'left', action: 'removed', createdAt: new Date('2026-06-10T00:00:00Z') })],
        { memberIds: ['left'], oldestEventAt: new Date('2026-05-01T00:00:00Z') }
      );

      const view = await diffLakeMembership(lake(), a);

      expect(view.removed.map(e => e.fabFileId)).toEqual(['left']);
      expect(view.unchangedCount).toBe(0);
    });
  });

  describe('ordering', () => {
    it('takes the end state from the last event of a same-millisecond tie, not the first', async () => {
      // The page arrives {createdAt desc, _id desc}, so a re-sort on createdAt alone leaves a tie in
      // _id-DESCENDING order and the wrong row names the end state. Here `readd` is the later of the
      // two tied rows: the file ends the window inside the lake.
      const early = new Date('2026-06-10T00:00:00Z');
      const tie = new Date('2026-06-20T00:00:00Z');
      const first = event({ id: 'evtA', fabFileId: 'tie', action: 'added', createdAt: early });
      const pull = event({ id: 'evtB', fabFileId: 'tie', action: 'removed', createdAt: tie });
      const readd = event({ id: 'evtC', fabFileId: 'tie', action: 'added', createdAt: tie });
      const listByLakeSince = vi.fn().mockResolvedValue([readd, pull, first]);
      const a = {
        db: {
          lakeMembershipChangeEvents: {
            listByLakeSince,
            oldestEventAt: vi.fn().mockResolvedValue(new Date('2026-05-01T00:00:00Z')),
          },
          fabFiles: { findLiveIdsByDataLakeTag: vi.fn().mockResolvedValue(['tie']) } as never,
          users: { findByIds: vi.fn().mockResolvedValue([]) } as never,
        },
        from: FROM,
        to: TO,
        now: NOW,
      };

      const view = await diffLakeMembership(lake(), a);

      expect(view.added.map(e => e.eventId)).toEqual(['evtC']);
      expect(view.removed).toEqual([]);
    });
  });

  describe('unchanged is a measurement, not a guess', () => {
    it('is UNKNOWN when the window starts before the lake log has rows', async () => {
      const { adapters: a } = adapters([], { memberIds: ['m1', 'm2'], oldestEventAt: undefined });

      const view = await diffLakeMembership(lake(), a);

      expect(view.unchangedCount).toBeUndefined();
      expect(view.unchangedUnknownReason).toBe('window-predates-log');
      expect(view.added).toEqual([]);
      expect(view.removed).toEqual([]);
    });

    it('is UNKNOWN when the window predates the oldest retained event', async () => {
      const { adapters: a } = adapters([event({ fabFileId: 'f1', createdAt: new Date('2026-06-10T00:00:00Z') })], {
        memberIds: ['f1', 'm2'],
        oldestEventAt: new Date('2026-06-05T00:00:00Z'),
      });

      const view = await diffLakeMembership(lake(), a);

      expect(view.unchangedCount).toBeUndefined();
      expect(view.unchangedUnknownReason).toBe('window-predates-log');
      // The moves the log DOES hold are still reported - only the sat-through set is unknowable.
      expect(view.added.map(e => e.fabFileId)).toEqual(['f1']);
      expect(view.logStartsAt).toEqual(new Date('2026-06-05T00:00:00Z'));
    });

    it('is UNKNOWN when the read hit its cap', async () => {
      const events = [
        event({ fabFileId: 'a', createdAt: new Date('2026-06-10T00:00:00Z') }),
        event({ fabFileId: 'b', createdAt: new Date('2026-06-11T00:00:00Z') }),
      ];
      const { adapters: a } = adapters(events, {
        memberIds: ['a', 'b', 'c'],
        oldestEventAt: new Date('2026-05-01T00:00:00Z'),
        limit: 1,
      });

      const view = await diffLakeMembership(lake(), a);

      expect(view.truncated).toBe(true);
      expect(view.unchangedCount).toBeUndefined();
      expect(view.unchangedUnknownReason).toBe('window-truncated');
    });

    it('counts members that sat through a fully covered window', async () => {
      const { adapters: a } = adapters(
        [event({ fabFileId: 'joined', action: 'added', createdAt: new Date('2026-06-10T00:00:00Z') })],
        { memberIds: ['joined', 'steady1', 'steady2'], oldestEventAt: new Date('2026-05-01T00:00:00Z') }
      );

      const view = await diffLakeMembership(lake(), a);

      expect(view.unchangedCount).toBe(2);
      expect(view.unchangedUnknownReason).toBeUndefined();
    });
  });

  describe('attribution', () => {
    it('carries the principal, the on-behalf human and the origin of the final move', async () => {
      const findByIds = vi.fn().mockResolvedValue([{ id: '000000000000000000000009', name: 'Dana' }]);
      const { adapters: a } = adapters(
        [
          event({
            fabFileId: 'f1',
            action: 'added',
            origin: 'connector',
            principalKind: 'apiKey',
            principalId: 'key-1',
            onBehalfOfUserId: '000000000000000000000009',
            createdAt: new Date('2026-06-10T00:00:00Z'),
          }),
        ],
        { memberIds: ['f1'], oldestEventAt: new Date('2026-05-01T00:00:00Z'), findByIds }
      );

      const view = await diffLakeMembership(lake(), a);

      expect(view.added[0]).toMatchObject({
        origin: 'connector',
        principalKind: 'apiKey',
        principalId: 'key-1',
        onBehalfOfUserId: '000000000000000000000009',
        onBehalfOfName: 'Dana',
      });
      // A non-user principal id names no user record, so it is never put through the lookup.
      expect(findByIds).toHaveBeenCalledWith(['000000000000000000000009']);
    });

    it('never puts a non-ObjectId principal id through the user lookup', async () => {
      const findByIds = vi.fn().mockResolvedValue([]);
      const { adapters: a } = adapters([event({ fabFileId: 'f1', principalKind: 'system', principalId: 'system' })], {
        memberIds: ['f1'],
        oldestEventAt: new Date('2026-05-01T00:00:00Z'),
        findByIds,
      });

      await diffLakeMembership(lake(), a);

      expect(findByIds).not.toHaveBeenCalled();
    });
  });

  describe('window plumbing', () => {
    it('asks the repository for events after `from` and one row past the page, as a truncation probe', async () => {
      const { adapters: a, listByLakeSince } = adapters([], {
        memberIds: [],
        oldestEventAt: new Date('2026-05-01T00:00:00Z'),
        limit: 10,
      });

      await diffLakeMembership(lake(), a);

      expect(listByLakeSince).toHaveBeenCalledWith('lake1', FROM, { limit: 11 });
    });

    it('never reports a window end in the future', async () => {
      const { adapters: a } = adapters([], {
        memberIds: [],
        oldestEventAt: new Date('2026-05-01T00:00:00Z'),
        to: new Date('2030-01-01T00:00:00Z'),
      });

      const view = await diffLakeMembership(lake(), a);

      expect(view.to).toEqual(NOW);
    });

    it("refuses a `from` after now, rather than counting today's members for a window that already ended", async () => {
      // No `to`: the window end clamps to now, which is BEFORE `from`. Nothing is readable about
      // such a span, so an `unchangedCount` over it would be a confident wrong number.
      const { adapters: a } = adapters([], {
        memberIds: ['m1', 'm2', 'm3'],
        oldestEventAt: new Date('2026-05-01T00:00:00Z'),
      });

      await expect(
        diffLakeMembership(lake(), { ...a, from: new Date('2030-01-01T00:00:00Z'), to: undefined })
      ).rejects.toThrow(/must not be in the future/i);
    });

    it('refuses a window whose end clamps below its start even when `to` is supplied', async () => {
      const { adapters: a } = adapters([], {
        memberIds: ['m1', 'm2', 'm3'],
        oldestEventAt: new Date('2026-05-01T00:00:00Z'),
      });

      await expect(
        diffLakeMembership(lake(), {
          ...a,
          from: new Date('2030-01-01T00:00:00Z'),
          to: new Date('2031-01-01T00:00:00Z'),
        })
      ).rejects.toThrow(/must not be in the future/i);
    });

    it('serves an instantaneous window where `to` equals `from`', async () => {
      const { adapters: a } = adapters([], {
        memberIds: ['steady'],
        oldestEventAt: new Date('2026-05-01T00:00:00Z'),
      });

      const view = await diffLakeMembership(lake(), { ...a, to: FROM });

      expect(view.to).toEqual(FROM);
      expect(view.added).toEqual([]);
      expect(view.removed).toEqual([]);
      expect(view.unchangedCount).toBe(1);
    });

    it('resolves membership against the lake scope, prefix arm included', async () => {
      const { adapters: a, findLiveIdsByDataLakeTag } = adapters([], {
        memberIds: [],
        oldestEventAt: new Date('2026-05-01T00:00:00Z'),
      });

      await diffLakeMembership(lake(), a);

      expect(findLiveIdsByDataLakeTag).toHaveBeenCalledWith({
        kind: 'owned',
        datalakeTag: 'datalake:ops',
        fileTagPrefix: 'ops/',
        creatorUserId: 'creator1',
      });
    });
  });
});
