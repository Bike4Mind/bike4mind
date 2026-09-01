import { describe, it, expect } from 'vitest';
import {
  groupIdentity,
  membersRemovedByDecision,
  planMembershipRepair,
  type MembershipDecisionRecord,
} from './lakeMembershipRepair';
import type { DuplicateBucket, DuplicateGroup } from './lakeMembershipHealth';

const member = (fabFileId: string, serverTextHash: string | null = null) => ({
  fabFileId,
  serverTextHash,
  fileSize: 100,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  arm: 'meta-tag' as const,
});

const group = (
  fileName: string,
  bucket: DuplicateBucket,
  members = [member('new'), member('old')]
): DuplicateGroup => ({
  fileName,
  bucket,
  members,
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
      group('proven.pdf', 'proven-identical'),
      group('differs.pdf', 'differing'),
      group('unknown.pdf', 'unverified'),
    ]);

    expect(plan.collapsible.map(g => g.fileName)).toEqual(['proven.pdf']);
    expect(plan.needsDecision.map(g => g.fileName)).toEqual(['unknown.pdf', 'differs.pdf']);
  });

  it('keeps the newest and removes the rest when collapsing', () => {
    const plan = planMembershipRepair([
      group('p.pdf', 'proven-identical', [member('new'), member('mid'), member('old')]),
    ]);

    expect(plan.collapsible[0].removeFabFileIds).toEqual(['mid', 'old']);
    expect(plan.removalCount).toBe(2);
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
    const decision: MembershipDecisionRecord = {
      fileName: 'kept.pdf',
      decision: 'keep-both',
      groupIdentity: groupIdentity(g),
    };

    const plan = planMembershipRepair([g], [decision]);

    expect(plan.needsDecision).toEqual([]);
    expect(plan.settled.map(s => s.fileName)).toEqual(['kept.pdf']);
    expect(plan.settled[0].settledBy).toEqual(decision);
  });

  it('does NOT collapse a proven-identical group the owner said keep-both about', () => {
    // Otherwise the automatic arm overrides the decision on the next run, which makes "keep both"
    // advisory rather than binding - and it deletes membership to do it.
    const g = group('p.pdf', 'proven-identical');
    const plan = planMembershipRepair(
      [g],
      [{ fileName: 'p.pdf', decision: 'keep-both', groupIdentity: groupIdentity(g) }]
    );

    expect(plan.collapsible).toEqual([]);
    expect(plan.removalCount).toBe(0);
    expect(plan.settled).toHaveLength(1);
  });

  it('re-asks when the group changed materially since the decision', () => {
    const g = group('f.pdf', 'differing', [member('x', 'h1'), member('y', 'h2')]);
    const staleDecision: MembershipDecisionRecord = {
      fileName: 'f.pdf',
      decision: 'keep-both',
      groupIdentity: 'stale-identity',
    };

    const plan = planMembershipRepair([g], [staleDecision]);

    expect(plan.settled).toEqual([]);
    expect(plan.needsDecision.map(x => x.fileName)).toEqual(['f.pdf']);
  });

  it('ignores a decision for a different file name', () => {
    const plan = planMembershipRepair(
      [group('a.pdf', 'differing')],
      [{ fileName: 'b.pdf', decision: 'keep-both', groupIdentity: 'whatever' }]
    );

    expect(plan.needsDecision).toHaveLength(1);
  });

  it('is stable across runs given unchanged input', () => {
    const build = () => [group('z.pdf', 'differing'), group('a.pdf', 'unverified'), group('m.pdf', 'proven-identical')];

    expect(JSON.stringify(planMembershipRepair(build()))).toBe(JSON.stringify(planMembershipRepair(build())));
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
