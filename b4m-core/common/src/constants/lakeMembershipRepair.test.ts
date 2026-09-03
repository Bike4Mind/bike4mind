import { describe, it, expect } from 'vitest';
import {
  groupIdentity,
  membersRemovedByDecision,
  planMembershipRepair,
  type MembershipDecisionRecord,
} from './lakeMembershipRepair';
import type { DuplicateBucket, DuplicateGroup } from './lakeMembershipHealth';

/**
 * Distinct timestamps for the three stock ids, so "newest first" is a real ordering rather than
 * `byNewestFirst`'s id tie-break. The planner and `membersRemovedByDecision` both re-sort
 * defensively, so a fixture where every member shared a `createdAt` would test the tie-break
 * instead of the intent.
 */
const CREATED_AT: Record<string, string> = {
  new: '2026-03-01T00:00:00Z',
  mid: '2026-02-01T00:00:00Z',
  old: '2026-01-01T00:00:00Z',
};

/** A real hex fingerprint, so a fixture labelled `proven-identical` is one the producer could emit. */
const HEX = 'a3f1c0de5b2740198e6c';

const member = (fabFileId: string, serverTextHash: string | null = null) => ({
  fabFileId,
  serverTextHash,
  fileSize: 100,
  createdAt: new Date(CREATED_AT[fabFileId] ?? '2026-01-01T00:00:00Z'),
  arm: 'meta-tag' as const,
});

/** Two members that really do agree on hash and size - what `classifyGroup` needs to say proven. */
const provenMembers = () => [member('new', HEX), member('old', HEX)];

const group = (
  fileName: string,
  bucket: DuplicateBucket,
  members = [member('new'), member('old')]
): DuplicateGroup => ({
  fileName,
  bucket,
  members,
  // Exact by construction here: these fixtures are never capped, so the count is the array length.
  memberCount: members.length,
});

const decision = (g: DuplicateGroup, overrides: Partial<MembershipDecisionRecord> = {}): MembershipDecisionRecord => ({
  dataLakeId: 'lake-1',
  fileName: g.fileName,
  decision: 'keep-both',
  groupIdentity: groupIdentity(g),
  decidedByUserId: 'owner-1',
  decidedAt: new Date('2026-02-15T00:00:00Z'),
  ...overrides,
});

describe('groupIdentity', () => {
  it('is stable regardless of member order', () => {
    const a = groupIdentity(group('f.pdf', 'differing', [member('x', 'h1'), member('y', 'h2')]));
    const b = groupIdentity(group('f.pdf', 'differing', [member('y', 'h2'), member('x', 'h1')]));

    expect(a).toBe(b);
  });

  it('changes when a member is added or removed', () => {
    const two = groupIdentity(group('f.pdf', 'differing', [member('x'), member('y')]));
    const three = groupIdentity(group('f.pdf', 'differing', [member('x'), member('y'), member('z')]));

    expect(two).not.toBe(three);
  });

  it('changes when a member is re-chunked to different text', () => {
    // Why the hash is in the key: without it, replacing a document under a settled decision would
    // stay suppressed forever.
    const before = groupIdentity(group('f.pdf', 'differing', [member('x', 'h1'), member('y', 'h2')]));
    const after = groupIdentity(group('f.pdf', 'differing', [member('x', 'h1'), member('y', 'h9')]));

    expect(before).not.toBe(after);
  });

  it('changes when a member is re-exported at a different size', () => {
    // Why the size is in the key: same extracted text, different bytes is the change `classifyGroup`
    // singles out as material (it drops the group out of `proven-identical`). An identity blind to it
    // would leave a re-export suppressed under a decision made about the file it replaced.
    const before = groupIdentity(group('f.pdf', 'proven-identical', [member('x', 'h1'), member('y', 'h1')]));
    const after = groupIdentity(
      group('f.pdf', 'differing', [member('x', 'h1'), { ...member('y', 'h1'), fileSize: 999999 }])
    );

    expect(before).not.toBe(after);
  });

  it('does not collide between groups whose members all lack a fingerprint', () => {
    // Why the ids are in the key: most of an existing backlog has no hash at all.
    const a = groupIdentity(group('f.pdf', 'unverified', [member('x'), member('y')]));
    const b = groupIdentity(group('g.pdf', 'unverified', [member('p'), member('q')]));

    expect(a).not.toBe(b);
  });
});

describe('planMembershipRepair', () => {
  it('offers collapse ONLY for a proven-identical group', () => {
    const plan = planMembershipRepair([
      group('proven.pdf', 'proven-identical', provenMembers()),
      group('differs.pdf', 'differing'),
      group('unknown.pdf', 'unverified'),
    ]);

    expect(plan.collapsible.map(g => g.fileName)).toEqual(['proven.pdf']);
    expect(plan.needsDecision.map(g => g.fileName)).toEqual(['unknown.pdf', 'differs.pdf']);
  });

  it('keeps the newest and removes the rest when collapsing', () => {
    const plan = planMembershipRepair([
      group('p.pdf', 'proven-identical', [member('new', HEX), member('mid', HEX), member('old', HEX)]),
    ]);

    expect(plan.collapsible[0].removeFabFileIds).toEqual(['mid', 'old']);
    expect(plan.removalCount).toBe(2);
  });

  it('collapses by age even if the members arrive out of order', () => {
    // Removal is positional, so the plan re-sorts rather than trusting the caller: a wrong order here
    // would delete the newest copy with no type error to catch it.
    const plan = planMembershipRepair([
      group('p.pdf', 'proven-identical', [member('old', HEX), member('new', HEX), member('mid', HEX)]),
    ]);

    expect(plan.collapsible[0].members.map(m => m.fabFileId)).toEqual(['new', 'mid', 'old']);
    expect(plan.collapsible[0].removeFabFileIds).toEqual(['mid', 'old']);
  });

  it('removes NOTHING for a group needing a decision', () => {
    // This is what makes "POST with no decisions executes bucket A only" a property of the plan
    // rather than a rule the executor has to remember.
    const plan = planMembershipRepair([group('d.pdf', 'differing'), group('u.pdf', 'unverified')]);

    expect(plan.needsDecision.every(g => g.removeFabFileIds.length === 0)).toBe(true);
    expect(plan.removalCount).toBe(0);
  });

  it('suppresses a group a prior decision settled', () => {
    const g = group('kept.pdf', 'differing');
    const settledBy = decision(g);

    const plan = planMembershipRepair([g], [settledBy]);

    expect(plan.needsDecision).toEqual([]);
    expect(plan.settled.map(s => s.fileName)).toEqual(['kept.pdf']);
    expect(plan.settled[0].settledBy).toEqual(settledBy);
  });

  it('does NOT collapse a proven-identical group the owner said keep-both about', () => {
    // Otherwise the automatic arm overrides the decision on the next run, which makes "keep both"
    // advisory rather than binding - and it deletes membership to do it.
    const g = group('p.pdf', 'proven-identical', provenMembers());
    const plan = planMembershipRepair([g], [decision(g)]);

    expect(plan.collapsible).toEqual([]);
    expect(plan.removalCount).toBe(0);
    expect(plan.settled).toHaveLength(1);
  });

  it('does NOT collapse a keep-both group once its members get fingerprinted', () => {
    // The regression guard for the routing rule. `classifyGroup` returns `unverified` until every
    // member carries a hash, so reaching `proven-identical` ALWAYS changes `groupIdentity` - meaning
    // a stale tombstone is the NORMAL state at that transition, not an edge case. Routing on bucket
    // alone would auto-collapse every recorded "keep both" the first time a lake's passages are
    // rebuilt, which is the majority of a real backlog arriving at once.
    const before = group('x.pdf', 'unverified');
    const decided = decision(before);
    const after = group('x.pdf', 'proven-identical', provenMembers());

    const plan = planMembershipRepair([after], [decided]);

    expect(plan.collapsible).toEqual([]);
    expect(plan.removalCount).toBe(0);
    expect(plan.needsDecision.map(g => g.fileName)).toEqual(['x.pdf']);
    expect(plan.needsDecision[0].priorDecision).toEqual(decided);
  });

  it('re-asks when the group changed materially since the decision, carrying the superseded record', () => {
    const g = group('f.pdf', 'differing', [member('x', 'h1'), member('y', 'h2')]);
    const staleDecision = decision(g, { groupIdentity: 'stale-identity' });

    const plan = planMembershipRepair([g], [staleDecision]);

    expect(plan.settled).toEqual([]);
    expect(plan.needsDecision.map(x => x.fileName)).toEqual(['f.pdf']);
    // The tombstone informs the human, it does not decide for them - so it has to reach the surface.
    expect(plan.needsDecision[0].priorDecision).toEqual(staleDecision);
  });

  it('reports what a settled decision has not yet carried out', () => {
    // A keep-newest that never executed leaves the group intact, so its identity never changes and it
    // is settled forever. Without this the plan calls such a lake clean.
    const g = group('f.pdf', 'differing', [member('new'), member('mid'), member('old')]);

    const plan = planMembershipRepair([g], [decision(g, { decision: 'keep-newest' })]);

    expect(plan.settled[0].outstandingRemovalFabFileIds).toEqual(['mid', 'old']);
    // Still nothing an executor reading `removeFabFileIds` would act on.
    expect(plan.settled[0].removeFabFileIds).toEqual([]);
    expect(plan.removalCount).toBe(0);
  });

  it('reports nothing outstanding for a settled keep-both or an executed keep-specific', () => {
    const both = group('b.pdf', 'differing');
    const specific = group('s.pdf', 'differing', [member('new')]);

    const plan = planMembershipRepair(
      [both, specific],
      [decision(both), decision(specific, { decision: 'keep-specific', keptFabFileId: 'new' })]
    );

    expect(plan.settled.map(s => s.outstandingRemovalFabFileIds)).toEqual([[], []]);
  });

  it('ignores a decision for a different file name', () => {
    const plan = planMembershipRepair(
      [group('a.pdf', 'differing')],
      [decision(group('b.pdf', 'differing'), { groupIdentity: 'whatever' })]
    );

    expect(plan.needsDecision).toHaveLength(1);
    expect(plan.needsDecision[0].priorDecision).toBeUndefined();
  });

  it('resolves duplicate decisions for one file name independently of their order', () => {
    // An append-only decision store would otherwise flip the plan on Mongo's return order: the map
    // was last-wins and the record carries nothing to order by.
    const g = group('y.pdf', 'differing');
    const current = decision(g);
    const superseded = decision(g, { groupIdentity: 'stale-identity' });

    expect(planMembershipRepair([g], [superseded, current]).settled).toHaveLength(1);
    expect(planMembershipRepair([g], [current, superseded]).settled).toHaveLength(1);
  });

  it('is stable across runs regardless of the order groups and decisions arrive in', () => {
    // Shuffled rather than rebuilt identically, so the three sorts are actually exercised: two
    // collapsible, three needing a decision (two sharing a bucket, to reach the name tie-break) and
    // two settled. Delete any sort and this fails.
    const build = () => {
      const settledA = group('s1.pdf', 'differing');
      const settledB = group('s2.pdf', 'differing');
      return {
        groups: [
          group('z.pdf', 'differing'),
          group('a.pdf', 'unverified'),
          group('m.pdf', 'proven-identical', provenMembers()),
          group('b.pdf', 'proven-identical', provenMembers()),
          group('y.pdf', 'differing'),
          settledA,
          settledB,
        ],
        decisions: [decision(settledA), decision(settledB)],
      };
    };

    const forward = build();
    const reversed = build();

    const a = planMembershipRepair(forward.groups, forward.decisions);
    const b = planMembershipRepair([...reversed.groups].reverse(), [...reversed.decisions].reverse());

    expect(a.collapsible.map(g => g.fileName)).toEqual(['b.pdf', 'm.pdf']);
    expect(a.needsDecision.map(g => g.fileName)).toEqual(['a.pdf', 'y.pdf', 'z.pdf']);
    expect(a.settled.map(g => g.fileName)).toEqual(['s1.pdf', 's2.pdf']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('reports an empty plan for a lake with no duplicates', () => {
    const plan = planMembershipRepair([]);

    expect(plan).toEqual({ collapsible: [], needsDecision: [], settled: [], removalCount: 0 });
  });
});

describe('membersRemovedByDecision', () => {
  const g = { members: [member('new'), member('mid'), member('old')] };

  it('removes nothing for keep-both', () => {
    expect(membersRemovedByDecision(g, 'keep-both')).toEqual([]);
  });

  it('removes all but the newest for keep-newest', () => {
    expect(membersRemovedByDecision(g, 'keep-newest')).toEqual(['mid', 'old']);
  });

  it('keeps the newest for keep-newest even when members arrive out of order', () => {
    // The parameter is a bare `Pick<..., 'members'>`, so an executor re-reading members from Mongo in
    // natural order gets no type error - only a wrong deletion. Hence the defensive sort.
    const shuffled = { members: [member('old'), member('new'), member('mid')] };

    expect(membersRemovedByDecision(shuffled, 'keep-newest')).toEqual(['mid', 'old']);
  });

  it('removes all but the named member for keep-specific', () => {
    expect(membersRemovedByDecision(g, 'keep-specific', 'mid')).toEqual(['new', 'old']);
  });

  it('removes NOTHING when keep-specific names a member no longer in the group', () => {
    // A stale decision must not fall back to a default the owner did not choose - the fallback here
    // would delete the very copy they had asked to keep.
    expect(membersRemovedByDecision(g, 'keep-specific', 'gone')).toEqual([]);
    expect(membersRemovedByDecision(g, 'keep-specific', null)).toEqual([]);
    expect(membersRemovedByDecision(g, 'keep-specific', undefined)).toEqual([]);
  });
});
