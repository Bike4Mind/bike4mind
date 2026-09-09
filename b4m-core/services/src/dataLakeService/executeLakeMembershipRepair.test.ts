import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ removeFileFromDataLake: vi.fn() }));
vi.mock('./removeFileFromDataLake', () => ({ removeFileFromDataLake: h.removeFileFromDataLake }));

import { executeLakeMembershipRepair } from './executeLakeMembershipRepair';
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
  serverTextHash,
  fileSize: 100,
  createdAt: new Date(AT[fabFileId] ?? '2026-01-01T00:00:00Z'),
  userId: 'u1',
  arm: 'meta-tag' as const,
});

const group = (fileName: string, bucket: DuplicateGroup['bucket'], members = [member('new'), member('old')]) => ({
  fileName,
  bucket,
  members,
  memberCount: members.length,
});

const actor = { userId: 'u1', isAdmin: false } as never;
const adapters = { db: {}, logger: { warn: vi.fn() } } as never;

const run = (
  groups: DuplicateGroup[],
  decisions: Parameters<typeof executeLakeMembershipRepair>[3] = [],
  prior: MembershipDecisionRecord[] = []
) => executeLakeMembershipRepair(actor, 'lake-1', planMembershipRepair(groups, prior), decisions, adapters);

beforeEach(() => {
  vi.clearAllMocks();
  h.removeFileFromDataLake.mockResolvedValue({ success: true, fileCount: 1, totalSizeBytes: 1 });
});

describe('executeLakeMembershipRepair', () => {
  it('removes membership ONLY - never the file, its chunks, or another lake', async () => {
    // The property that makes this operation recoverable, and the issue asks for it asserted rather
    // than assumed. `removeFileFromDataLake` pulls this lake's tags off the FabFile and nothing else,
    // so the whole guarantee reduces to: that is the only mutation this executor performs.
    await run([group('p.pdf', 'proven-identical', [member('new', HEX), member('old', HEX)])]);

    expect(h.removeFileFromDataLake).toHaveBeenCalledTimes(1);
    expect(h.removeFileFromDataLake).toHaveBeenCalledWith(actor, 'lake-1', 'old', adapters);
  });

  it('executes bucket A only when no decisions are supplied', async () => {
    // #2245's headline behaviour, and it holds as a property of the PLAN rather than a rule this
    // executor remembers: a `decide` group carries an empty `removeFabFileIds` by construction.
    const plan = [
      group('proven.pdf', 'proven-identical', [member('new', HEX), member('old', HEX)]),
      group('differs.pdf', 'differing'),
      group('unknown.pdf', 'unverified'),
    ];

    const outcome = await run(plan);

    expect(outcome.removedFabFileIds).toEqual(['old']);
    expect(outcome.groupsActedOn).toEqual([{ fileName: 'proven.pdf', removedFabFileIds: ['old'] }]);
  });

  it('keeps the newest of a collapsible group', async () => {
    const outcome = await run([
      group('p.pdf', 'proven-identical', [member('new', HEX), member('mid', HEX), member('old', HEX)]),
    ]);

    expect(outcome.removedFabFileIds).toEqual(['mid', 'old']);
    expect(h.removeFileFromDataLake).not.toHaveBeenCalledWith(actor, 'lake-1', 'new', adapters);
  });

  it('carries out a keep-newest decision on a group the plan only asked about', async () => {
    const outcome = await run(
      [group('d.pdf', 'differing', [member('new'), member('mid'), member('old')])],
      [{ fileName: 'd.pdf', decision: 'keep-newest' }]
    );

    expect(outcome.removedFabFileIds).toEqual(['mid', 'old']);
  });

  it('carries out keep-specific, and removes nothing for keep-both', async () => {
    const both = group('b.pdf', 'differing');
    const specific = group('s.pdf', 'differing', [member('new'), member('old')]);

    const outcome = await run(
      [both, specific],
      [
        { fileName: 'b.pdf', decision: 'keep-both' },
        { fileName: 's.pdf', decision: 'keep-specific', keptFabFileId: 'old' },
      ]
    );

    expect(outcome.removedFabFileIds).toEqual(['new']);
  });

  it('removes nothing for a keep-specific naming a member no longer in the group', async () => {
    // The read-time posture `membersRemovedByDecision` already takes: a stale decision must not fall
    // back to a default the owner did not choose - the fallback would delete the copy they kept.
    const outcome = await run(
      [group('s.pdf', 'differing')],
      [{ fileName: 's.pdf', decision: 'keep-specific', keptFabFileId: 'gone' }]
    );

    expect(outcome.removedFabFileIds).toEqual([]);
    expect(h.removeFileFromDataLake).not.toHaveBeenCalled();
  });

  it('withholds a ruling whose group moved since the owner reviewed it', async () => {
    // The sharp case for keep-newest, which is positional: the owner rules on [mid, old] electing to
    // keep `mid`, a newer copy lands before the POST, and applying the ruling to [new, mid, old]
    // removes `mid` - the copy they kept - and leaves the one they never saw.
    const reviewed = group('d.pdf', 'differing', [member('mid'), member('old')]);
    const moved = group('d.pdf', 'differing', [member('new'), member('mid'), member('old')]);

    const outcome = await run(
      [moved],
      [{ fileName: 'd.pdf', decision: 'keep-newest', groupIdentity: groupIdentity(reviewed) }]
    );

    expect(outcome.removedFabFileIds).toEqual([]);
    expect(h.removeFileFromDataLake).not.toHaveBeenCalled();
    expect(outcome.staleDecisions).toEqual([
      {
        fileName: 'd.pdf',
        reviewedGroupIdentity: groupIdentity(reviewed),
        currentGroupIdentity: groupIdentity(moved),
      },
    ]);
  });

  it('applies a ruling whose group identity still matches, and one that carries none at all', async () => {
    // The other side of the gate: it withholds on mismatch, not on presence. A caller with no
    // identity to offer is unchanged, which is what keeps the field optional.
    const g = group('d.pdf', 'differing', [member('new'), member('old')]);

    const matched = await run([g], [{ fileName: 'd.pdf', decision: 'keep-newest', groupIdentity: groupIdentity(g) }]);
    expect(matched.removedFabFileIds).toEqual(['old']);
    expect(matched.staleDecisions).toEqual([]);

    const unqualified = await run([g], [{ fileName: 'd.pdf', decision: 'keep-newest' }]);
    expect(unqualified.removedFabFileIds).toEqual(['old']);
    expect(unqualified.staleDecisions).toEqual([]);
  });

  it('ignores a decision for a group the plan already settled', async () => {
    // A settled group carries a prior decision that suppressed it. Its `outstandingRemovalFabFileIds`
    // says work was never carried out; acting on that here would let a tombstone remove membership
    // with no owner in the loop.
    const g = group('kept.pdf', 'differing', [member('new'), member('old')]);
    const settledBy: MembershipDecisionRecord = {
      dataLakeId: 'lake-1',
      fileName: 'kept.pdf',
      decision: 'keep-newest',
      keptFabFileId: null,
      groupIdentity: '',
      decidedByUserId: 'u1',
      decidedAt: new Date('2026-02-15T00:00:00Z'),
    };
    const plan = planMembershipRepair([g], [{ ...settledBy, groupIdentity: groupIdentity(g) }]);
    expect(plan.settled).toHaveLength(1);

    const outcome = await executeLakeMembershipRepair(
      actor,
      'lake-1',
      plan,
      [{ fileName: 'kept.pdf', decision: 'keep-newest' }],
      adapters
    );

    expect(outcome.removedFabFileIds).toEqual([]);
    expect(h.removeFileFromDataLake).not.toHaveBeenCalled();
  });

  it('one failed removal costs only itself, and is reported', async () => {
    // A repair that abandons the rest of the plan on one failure leaves the lake in a state neither
    // the owner nor the next plan can reason about. Half-applied and re-runnable is recoverable.
    h.removeFileFromDataLake.mockImplementation(async (_a: unknown, _l: unknown, id: string) => {
      if (id === 'mid') throw new Error('write conflict');
      return { success: true, fileCount: 1, totalSizeBytes: 1 };
    });

    const outcome = await run([
      group('p.pdf', 'proven-identical', [member('new', HEX), member('mid', HEX), member('old', HEX)]),
    ]);

    expect(outcome.removedFabFileIds).toEqual(['old']);
    expect(outcome.failures).toEqual([{ fabFileId: 'mid', fileName: 'p.pdf', error: 'write conflict' }]);
    // Two attempts, not three: the group keeps its newest member. `old` went out AFTER `mid` threw,
    // which is the isolation this asserts.
    expect(h.removeFileFromDataLake).toHaveBeenCalledTimes(2);
  });

  it('removes sequentially, because every removal recomputes the lake stats', async () => {
    // Concurrent removals would race each other's recompute and persist a count from a partial view.
    const order: string[] = [];
    let inFlight = 0;
    h.removeFileFromDataLake.mockImplementation(async (_a: unknown, _l: unknown, id: string) => {
      expect(inFlight).toBe(0);
      inFlight += 1;
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight -= 1;
      order.push(id);
      return { success: true, fileCount: 1, totalSizeBytes: 1 };
    });

    await run([group('p.pdf', 'proven-identical', [member('new', HEX), member('mid', HEX), member('old', HEX)])]);

    expect(order).toEqual(['mid', 'old']);
  });

  it('does nothing at all on an empty plan', async () => {
    const outcome = await run([]);

    expect(outcome).toEqual({ removedFabFileIds: [], groupsActedOn: [], failures: [], staleDecisions: [] });
    expect(h.removeFileFromDataLake).not.toHaveBeenCalled();
  });
});
