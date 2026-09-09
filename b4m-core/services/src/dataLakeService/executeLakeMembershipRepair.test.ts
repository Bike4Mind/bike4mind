import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ removeFileFromDataLake: vi.fn(), findById: vi.fn() }));
vi.mock('./removeFileFromDataLake', () => ({ removeFileFromDataLake: h.removeFileFromDataLake }));

import {
  executeLakeMembershipRepair,
  MAX_MEMBERSHIP_REPAIR_REMOVALS,
  type MembershipRepairDecisionInput,
} from './executeLakeMembershipRepair';
import type { RemoveFileFromDataLakeAdapters } from './removeFileFromDataLake';
import {
  groupIdentity,
  planMembershipRepair,
  type DuplicateGroup,
  type MembershipDecisionRecord,
} from '@bike4mind/common';

const AT: Record<string, string> = {
  new: '2026-03-01T00:00:00Z',
  mid: '2026-02-01T00:00:00Z',
  old: '2026-01-01T00:00:00Z',
};
const HEX = 'a3f1c0de5b2740198e6c';

const member = (fabFileId: string, serverTextHash: string | null = null) => ({
  fabFileId,
  userId: 'u1',
  serverTextHash,
  fileSize: 100,
  createdAt: new Date(AT[fabFileId] ?? '2026-01-01T00:00:00Z'),
  arm: 'meta-tag' as const,
});

const group = (
  fileName: string,
  bucket: DuplicateGroup['bucket'],
  members = [member('new'), member('old')]
): DuplicateGroup => ({ fileName, bucket, members, memberCount: members.length });

const actor = { userId: 'u1', isAdmin: false, administeredOrgIds: [] } as unknown as Parameters<
  typeof executeLakeMembershipRepair
>[0];

// The real adapter shape, not `as never`: the interface this module shares with removeFileFromDataLake
// is exercised by nothing if the fixture opts out of it.
const warn = vi.fn();
const adapters = {
  db: { dataLakes: { findById: h.findById } },
  logger: { warn },
} as unknown as RemoveFileFromDataLakeAdapters;

/** A decision carrying the identity of the group as the owner saw it - what the executor requires. */
const decide = (g: DuplicateGroup, over: Partial<MembershipRepairDecisionInput> = {}) =>
  ({
    fileName: g.fileName,
    groupIdentity: groupIdentity(g),
    decision: 'keep-newest',
    ...over,
  }) as MembershipRepairDecisionInput;

const run = (
  groups: DuplicateGroup[],
  decisions: MembershipRepairDecisionInput[] = [],
  prior: MembershipDecisionRecord[] = []
) => executeLakeMembershipRepair(actor, 'lake-1', planMembershipRepair(groups, prior), decisions, adapters);

beforeEach(() => {
  vi.clearAllMocks();
  h.findById.mockResolvedValue({ id: 'lake-1' });
  h.removeFileFromDataLake.mockResolvedValue({ success: true, fileCount: 1, totalSizeBytes: 1 });
});

describe('executeLakeMembershipRepair', () => {
  it('removes through the membership door only, once per member', async () => {
    await run([group('p.pdf', 'proven-identical', [member('new', HEX), member('old', HEX)])]);

    expect(h.removeFileFromDataLake).toHaveBeenCalledTimes(1);
    expect(h.removeFileFromDataLake).toHaveBeenCalledWith(actor, 'lake-1', 'old', adapters);
  });

  it('executes bucket A only when no decisions are supplied', async () => {
    const outcome = await run([
      group('proven.pdf', 'proven-identical', [member('new', HEX), member('old', HEX)]),
      group('differs.pdf', 'differing'),
      group('unknown.pdf', 'unverified'),
    ]);

    expect(outcome.removedFabFileIds).toEqual(['old']);
    expect(outcome.groupsActedOn).toEqual([{ fileName: 'proven.pdf', removedFabFileIds: ['old'] }]);
  });

  it('resolves the lake ONCE and fails fast, rather than per member', async () => {
    // Lake-level faults are invariant across the loop. Discovering them per member issues one
    // findById per removal and returns a success-shaped outcome carrying N copies of one message.
    h.findById.mockResolvedValue(null);

    await expect(
      run([group('p.pdf', 'proven-identical', [member('new', HEX), member('mid', HEX), member('old', HEX)])])
    ).rejects.toThrow(/not found/i);

    expect(h.findById).toHaveBeenCalledTimes(1);
    expect(h.removeFileFromDataLake).not.toHaveBeenCalled();
  });

  describe('a decision is about the group the owner SAW', () => {
    it('refuses a decision whose group changed since it was made, and reports it', async () => {
      // keep-newest on [A(new), B] then a third copy lands: joining on file name alone would remove
      // the copy the owner elected to keep and spare one they never saw, reported as their decision.
      const reviewed = group('f.pdf', 'differing', [member('new'), member('old')]);
      const fresh = group('f.pdf', 'differing', [member('new'), member('mid'), member('old')]);

      const outcome = await run([fresh], [decide(reviewed)]);

      expect(outcome.removedFabFileIds).toEqual([]);
      expect(outcome.ignoredDecisions).toEqual([{ fileName: 'f.pdf', reason: 'group-changed-since-decision' }]);
      expect(h.removeFileFromDataLake).not.toHaveBeenCalled();
    });

    it('applies it when the group is unchanged', async () => {
      const g = group('f.pdf', 'differing', [member('new'), member('mid'), member('old')]);

      const outcome = await run([g], [decide(g)]);

      expect(outcome.removedFabFileIds).toEqual(['mid', 'old']);
      expect(outcome.ignoredDecisions).toEqual([]);
    });
  });

  describe('a decision that changes nothing says why', () => {
    it('applies NOTHING for a duplicated file name, rather than letting array order decide', async () => {
      // [keep-both, keep-newest] removes members and the reverse removes none - a destructive
      // outcome decided by array position. Neither is defensible.
      const g = group('d.pdf', 'differing');

      const outcome = await run([g], [decide(g, { decision: 'keep-both' }), decide(g, { decision: 'keep-newest' })]);

      expect(outcome.removedFabFileIds).toEqual([]);
      expect(outcome.ignoredDecisions).toEqual([{ fileName: 'd.pdf', reason: 'duplicate-file-name' }]);
    });

    it('reports a decision matching no acted-on group', async () => {
      const outcome = await run([group('a.pdf', 'differing')], [decide(group('typo.pdf', 'differing'))]);

      expect(outcome.ignoredDecisions).toEqual([{ fileName: 'typo.pdf', reason: 'no-matching-group' }]);
    });
  });

  it('carries out keep-specific, and removes nothing for keep-both', async () => {
    const both = group('b.pdf', 'differing');
    const specific = group('s.pdf', 'differing', [member('new'), member('old')]);

    const outcome = await run(
      [both, specific],
      [decide(both, { decision: 'keep-both' }), decide(specific, { decision: 'keep-specific', keptFabFileId: 'old' })]
    );

    expect(outcome.removedFabFileIds).toEqual(['new']);
  });

  it('ignores a decision for a group the plan already settled', async () => {
    const g = group('kept.pdf', 'differing');
    const settledBy: MembershipDecisionRecord = {
      dataLakeId: 'lake-1',
      fileName: 'kept.pdf',
      decision: 'keep-newest',
      keptFabFileId: null,
      groupIdentity: groupIdentity(g),
      decidedByUserId: 'u1',
      decidedAt: new Date('2026-02-15T00:00:00Z'),
    };

    const outcome = await run([g], [decide(g)], [settledBy]);

    expect(outcome.removedFabFileIds).toEqual([]);
    expect(h.removeFileFromDataLake).not.toHaveBeenCalled();
  });

  describe('one failure costs only itself', () => {
    it('keeps going when a MIDDLE removal fails', async () => {
      h.removeFileFromDataLake.mockImplementation(async (_a: unknown, _l: unknown, id: string) => {
        if (id === 'mid') throw new Error('write conflict');
        return { success: true, fileCount: 1, totalSizeBytes: 1 };
      });

      const outcome = await run([
        group('p.pdf', 'proven-identical', [member('new', HEX), member('mid', HEX), member('old', HEX)]),
      ]);

      expect(outcome.removedFabFileIds).toEqual(['old']);
      expect(outcome.failures).toEqual([{ fabFileId: 'mid', fileName: 'p.pdf', error: 'write conflict' }]);
    });

    it('keeps going when the LAST removal in a group fails', async () => {
      // The middle-failure case above passes even if the loop rethrows on its final member, so the
      // isolation the comment promises needs this one to be pinned at all.
      h.removeFileFromDataLake.mockImplementation(async (_a: unknown, _l: unknown, id: string) => {
        if (id === 'old') throw new Error('write conflict');
        return { success: true, fileCount: 1, totalSizeBytes: 1 };
      });

      const outcome = await run([
        group('p.pdf', 'proven-identical', [member('new', HEX), member('mid', HEX), member('old', HEX)]),
      ]);

      expect(outcome.removedFabFileIds).toEqual(['mid']);
      expect(outcome.failures).toEqual([{ fabFileId: 'old', fileName: 'p.pdf', error: 'write conflict' }]);
    });

    it('keeps a customer file name out of the log MESSAGE', async () => {
      h.removeFileFromDataLake.mockRejectedValue(new Error('write conflict'));

      await run([group('Q3 acquisition memo.pdf', 'proven-identical', [member('new', HEX), member('old', HEX)])]);

      const [message] = warn.mock.calls[0];
      expect(message).not.toContain('Q3 acquisition memo.pdf');
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ fabFileId: 'old' }));
    });
  });

  it('attributes removals to their OWN group', async () => {
    // Reporting the run-wide list here makes every group after the first claim its predecessors'
    // ids, so a per-file undo would target the wrong files.
    const outcome = await run([
      group('a.pdf', 'proven-identical', [member('new', HEX), member('old', HEX)]),
      group('b.pdf', 'proven-identical', [member('mid', HEX), member('old', HEX)]),
    ]);

    expect(outcome.groupsActedOn).toEqual([
      { fileName: 'a.pdf', removedFabFileIds: ['old'] },
      { fileName: 'b.pdf', removedFabFileIds: ['old'] },
    ]);
  });

  it('removes strictly sequentially, across groups as well as within one', async () => {
    // Two removals in flight race each other's lake-stats recompute and persist a count from a
    // partial view. A Promise.all over the OUTER loop passes an inner-loop-only assertion.
    // Observed, NOT asserted inside the mock: an expect() thrown in there is caught by the
    // executor's own per-member catch and recorded as a removal failure, so the test passes while
    // the fan-out it is meant to catch happens. This is the shape that actually fails on a
    // Promise.all over the outer loop.
    let inFlight = 0;
    let maxInFlight = 0;
    h.removeFileFromDataLake.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight -= 1;
      return { success: true, fileCount: 1, totalSizeBytes: 1 };
    });

    await run([
      group('a.pdf', 'proven-identical', [member('new', HEX), member('mid', HEX), member('old', HEX)]),
      group('b.pdf', 'proven-identical', [member('new', HEX), member('mid', HEX), member('old', HEX)]),
    ]);

    expect(maxInFlight).toBe(1);
    expect(h.removeFileFromDataLake).toHaveBeenCalledTimes(4);
  });

  it('stops at the removal ceiling and says so', async () => {
    // The sibling this is modelled on carries a hard wave cap so a hand-crafted request cannot fan
    // out unbounded work; the planner truncates nothing, so the cap has to live here.
    const members = Array.from({ length: MAX_MEMBERSHIP_REPAIR_REMOVALS + 5 }, (_, i) => member(`f${i}`, HEX));
    const outcome = await run([group('big.pdf', 'proven-identical', members)]);

    expect(outcome.removedFabFileIds).toHaveLength(MAX_MEMBERSHIP_REPAIR_REMOVALS);
    expect(outcome.truncated).toBe(true);
  });

  it('does nothing at all on an empty plan', async () => {
    const outcome = await run([]);

    expect(outcome).toEqual({
      removedFabFileIds: [],
      groupsActedOn: [],
      failures: [],
      ignoredDecisions: [],
      truncated: false,
    });
  });
});
