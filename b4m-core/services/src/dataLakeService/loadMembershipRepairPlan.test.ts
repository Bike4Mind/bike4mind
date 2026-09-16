import { describe, expect, it, vi } from 'vitest';
import {
  groupIdentity,
  type ILakeMembershipDecisionDocument,
  type LakeMembershipMemberRow,
  type MembershipDecisionRecord,
  type RepairDecision,
} from '@bike4mind/common';
import { loadMembershipRepairPlan, type LoadMembershipRepairPlanAdapters } from './loadMembershipRepairPlan';

const LAKE = {
  id: 'lake-1',
  datalakeTag: 'datalake:acme',
  fileTagPrefix: 'acme:',
  createdByUserId: 'creator-1',
};

const row = (over: Partial<LakeMembershipMemberRow> & { fabFileId: string }): LakeMembershipMemberRow => ({
  fileName: 'policy.md',
  serverTextHash: null,
  fileSize: 100,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  userId: 'creator-1',
  arm: 'meta-tag',
  relativePath: null,
  driveFileId: null,
  ...over,
});

const PAIR = [row({ fabFileId: 'new-1', createdAt: new Date('2026-03-01T00:00:00Z') }), row({ fabFileId: 'old-1' })];

/** The ruling a manager's answer writes, stamped over the group as it stands. */
const ruling = (
  members: LakeMembershipMemberRow[],
  decision: RepairDecision,
  over: Partial<MembershipDecisionRecord> = {}
) =>
  ({
    dataLakeId: LAKE.id,
    fileName: 'policy.md',
    decision,
    keptFabFileId: null,
    groupIdentity: groupIdentity({ members }),
    decidedByUserId: 'creator-1',
    decidedAt: new Date('2026-03-02T00:00:00Z'),
    ...over,
  }) as unknown as ILakeMembershipDecisionDocument;

const adapters = (members: LakeMembershipMemberRow[], decisions: ILakeMembershipDecisionDocument[] = []) => {
  const findDataLakeMembershipMembers = vi.fn(async () => members);
  const listByLake = vi.fn(async () => decisions);
  return {
    bag: {
      db: { fabFiles: { findDataLakeMembershipMembers }, lakeMembershipDecisions: { listByLake } },
    } as unknown as LoadMembershipRepairPlanAdapters,
    findDataLakeMembershipMembers,
    listByLake,
  };
};

describe('loadMembershipRepairPlan', () => {
  it('offers a duplicate group nobody has answered', async () => {
    const { bag, findDataLakeMembershipMembers } = adapters(PAIR);

    const plan = await loadMembershipRepairPlan(LAKE, bag);

    expect(plan.openGroupCount).toBe(1);
    expect(plan.open[0].fileName).toBe('policy.md');
    expect(plan.open[0].memberCount).toBe(2);
    expect(plan.settledGroupCount).toBe(0);
    // Scanned over this lake's own membership scope, both arms.
    expect(findDataLakeMembershipMembers).toHaveBeenCalledWith(
      { kind: 'owned', datalakeTag: 'datalake:acme', fileTagPrefix: 'acme:', creatorUserId: 'creator-1' },
      expect.any(Number)
    );
  });

  it('suppresses a group a keep-both ruling still answers', async () => {
    // The reason this door exists. `keep-both` leaves the group intact, so the group stays a
    // duplicate forever - without the ruling, the one answer meaning "stop asking" would be re-asked
    // on every render.
    const { bag } = adapters(PAIR, [ruling(PAIR, 'keep-both')]);

    const plan = await loadMembershipRepairPlan(LAKE, bag);

    expect(plan.open).toEqual([]);
    expect(plan.openGroupCount).toBe(0);
    expect(plan.settledGroupCount).toBe(1);
    expect(plan.stalledGroupCount).toBe(0);
  });

  it('re-opens a settled group once one of its copies is replaced', async () => {
    // The ruling was stamped over the old pair; a third generation changes the group identity, which
    // is a new question rather than a suppressed one.
    const answered = ruling(PAIR, 'keep-both');
    const grown = [...PAIR, row({ fabFileId: 'new-2', createdAt: new Date('2026-04-01T00:00:00Z') })];
    const { bag } = adapters(grown, [answered]);

    const plan = await loadMembershipRepairPlan(LAKE, bag);

    expect(plan.openGroupCount).toBe(1);
    expect(plan.settledGroupCount).toBe(0);
  });

  it('keeps offering a keep-newest whose removal never happened, and counts it as stalled', async () => {
    // The decision door records the ruling BEFORE it removes, so a failed removal leaves exactly
    // this state. Re-answering is the recovery, so the group must stay on offer.
    const { bag } = adapters(PAIR, [ruling(PAIR, 'keep-newest')]);

    const plan = await loadMembershipRepairPlan(LAKE, bag);

    expect(plan.openGroupCount).toBe(1);
    expect(plan.stalledGroupCount).toBe(1);
    expect(plan.settledGroupCount).toBe(0);
  });

  it('never reads the rulings for a lake with no duplicate groups', async () => {
    const { bag, listByLake } = adapters([row({ fabFileId: 'only-1' })]);

    const plan = await loadMembershipRepairPlan(LAKE, bag);

    expect(plan.openGroupCount).toBe(0);
    expect(listByLake).not.toHaveBeenCalled();
  });

  it('caps the offered list but reports the exact open count', async () => {
    // 60 distinct duplicated names, one pair each.
    const members = Array.from({ length: 60 }, (_, i) => [
      row({ fabFileId: `new-${i}`, fileName: `doc-${i}.md`, createdAt: new Date('2026-03-01T00:00:00Z') }),
      row({ fabFileId: `old-${i}`, fileName: `doc-${i}.md` }),
    ]).flat();
    const { bag } = adapters(members);

    const plan = await loadMembershipRepairPlan(LAKE, bag);

    expect(plan.openGroupCount).toBe(60);
    expect(plan.open).toHaveLength(50);
  });

  it('keeps the identity signals the grouping reasons over off the wire', async () => {
    const { bag } = adapters([
      row({ fabFileId: 'new-1', relativePath: 'legal/', createdAt: new Date('2026-03-01T00:00:00Z') }),
      row({ fabFileId: 'old-1', relativePath: 'legal/' }),
    ]);

    const plan = await loadMembershipRepairPlan(LAKE, bag);

    const member = plan.open[0].members[0] as Record<string, unknown>;
    expect(member.relativePath).toBeUndefined();
    expect(member.serverTextHash).toBeUndefined();
    expect(member.userId).toBeUndefined();
    // The tier survives, so a surface can say how confidently the copies were matched.
    expect(plan.open[0].tier).toBe('relativePath');
  });
});
