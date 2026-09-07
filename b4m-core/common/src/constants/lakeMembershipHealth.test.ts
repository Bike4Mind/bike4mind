import { describe, it, expect } from 'vitest';
import {
  isFingerprint,
  summarizeLakeMembership,
  toWireMembershipReport,
  type LakeMembershipMemberInput,
  type MembershipArm,
} from './lakeMembershipHealth';

const SCOPE = { creatorUserId: 'creator1', fileTagPrefix: 'acme:' };

let seq = 0;
const member = (over: Partial<LakeMembershipMemberInput> = {}): LakeMembershipMemberInput => ({
  fabFileId: `f${++seq}`,
  fileName: 'report.pdf',
  arm: 'meta-tag' as MembershipArm,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  fileSize: 100,
  ...over,
});

const summarize = (members: LakeMembershipMemberInput[], opts = {}) =>
  summarizeLakeMembership(members, { scope: SCOPE, ...opts });

describe('isFingerprint', () => {
  // The whole bucketing rule rests on this: `null` is a RECORDED fact ("chunked, no extractable
  // text"), not a missing value, so it reads as comparable until you notice every image in a lake
  // carries it. See FabFileTypes' tri-state note.
  it('accepts any RECORDED hash and rejects null, absent or empty', () => {
    expect(isFingerprint('abc123')).toBe(true);
    expect(isFingerprint(null)).toBe(false);
    expect(isFingerprint(undefined)).toBe(false);
    expect(isFingerprint('')).toBe(false);
  });

  it('does NOT validate the encoding - the only producer is the internal hashing pipeline', () => {
    // Pinning the absence of a format check so the contract and the code cannot drift apart again:
    // the docstring used to claim hex validation this predicate never performed.
    expect(isFingerprint('not-hex!!')).toBe(true);
  });
});

describe('summarizeLakeMembership bucketing', () => {
  it('proves identity only on a matching fingerprint AND size', () => {
    const report = summarize([
      member({ serverTextHash: 'aaa', fileSize: 100 }),
      member({ serverTextHash: 'aaa', fileSize: 100 }),
    ]);

    expect(report.duplicateNameCount).toBe(1);
    expect(report.duplicateGroups[0].bucket).toBe('proven-identical');
    expect(report.duplicateMemberCount).toBe(2);
  });

  it('NEVER collapses two null hashes, which every image in a lake carries', () => {
    // The trap this module exists to avoid. `null` means "chunked, no extractable text" - two
    // different scans both have it, and treating null === null as proof would auto-collapse
    // unrelated documents. It must land in the bucket that asks a human.
    const report = summarize([
      member({ serverTextHash: null, fileSize: 100 }),
      member({ serverTextHash: null, fileSize: 100 }),
    ]);

    expect(report.duplicateGroups[0].bucket).toBe('unverified');
    expect(report.bucketCounts['proven-identical']).toBe(0);
  });

  it('treats an absent hash as unverified, not as a match with a present one', () => {
    // The #1679 timing case: members last chunked before serverTextHash shipped carry none, so most
    // of an existing backlog lands here rather than in the auto-collapse bucket.
    const report = summarize([member({ serverTextHash: 'aaa' }), member({ serverTextHash: undefined })]);

    expect(report.duplicateGroups[0].bucket).toBe('unverified');
  });

  it('sends a same-hash pair with differing sizes to the owner rather than collapsing it', () => {
    // The judgment call, pinned: the hash covers normalized TEXT, so a re-export can share it while
    // differing in bytes. Auto-collapse is the one bucket that mutates without asking, so a size
    // disagreement falls to a human.
    const report = summarize([
      member({ serverTextHash: 'aaa', fileSize: 100 }),
      member({ serverTextHash: 'aaa', fileSize: 250 }),
    ]);

    expect(report.duplicateGroups[0].bucket).toBe('differing');
  });

  it('calls a same-hash pair with no known size UNVERIFIED, not differing', () => {
    // The size conjunct went vacuous exactly where it cannot discriminate: `fileSize` is optional on
    // the schema and coalesces to null, so two size-less members satisfied null === null and reached
    // the one bucket that removes membership with no owner prompt. Same rule as `isFingerprint` - a
    // missing value is never compared for equality.
    //
    // But an unknown size is not a size DISAGREEMENT, and the bucket has to say which happened:
    // `differing` asserts these are different documents, which nothing here established.
    const report = summarize([
      member({ serverTextHash: 'aaa', fileSize: null }),
      member({ serverTextHash: 'aaa', fileSize: null }),
    ]);

    expect(report.duplicateGroups[0].bucket).toBe('unverified');
    expect(report.bucketCounts['proven-identical']).toBe(0);
  });

  it('calls a same-hash pair with only one known size UNVERIFIED', () => {
    const report = summarize([
      member({ serverTextHash: 'aaa', fileSize: 100 }),
      member({ serverTextHash: 'aaa', fileSize: null }),
    ]);

    expect(report.duplicateGroups[0].bucket).toBe('unverified');
    expect(report.bucketCounts['proven-identical']).toBe(0);
  });

  it('still calls a MEASURED size disagreement differing, so the two unknowns stay distinguishable', () => {
    // The pair to the two above: same hashes, both sizes known, and they disagree. This is the case
    // that earns `differing` - a fact was established. Pinned beside them so a future simplification
    // cannot collapse "cannot tell" and "proven different" back into one bucket.
    const report = summarize([
      member({ serverTextHash: 'aaa', fileSize: 100 }),
      member({ serverTextHash: 'aaa', fileSize: 250 }),
    ]);

    expect(report.duplicateGroups[0].bucket).toBe('differing');
  });

  it('classifies differing fingerprints as differing', () => {
    const report = summarize([member({ serverTextHash: 'aaa' }), member({ serverTextHash: 'bbb' })]);

    expect(report.duplicateGroups[0].bucket).toBe('differing');
  });

  it('needs EVERY member proven, not just the first pair', () => {
    // A three-member group where the odd one out is last: a rule written as "compare adjacent pairs"
    // or one that short-circuits on the first match would call this collapsible.
    const report = summarize([
      member({ serverTextHash: 'aaa' }),
      member({ serverTextHash: 'aaa' }),
      member({ serverTextHash: undefined }),
    ]);

    expect(report.duplicateGroups[0].bucket).toBe('unverified');
    expect(report.duplicateGroups[0].members).toHaveLength(3);
  });
});

describe('summarizeLakeMembership grouping', () => {
  it('does not group names that differ only in case', () => {
    // Acting on this report removes membership, so a false pair is the one error it cannot afford.
    const report = summarize([member({ fileName: 'Report.pdf' }), member({ fileName: 'report.pdf' })]);

    expect(report.duplicateNameCount).toBe(0);
    expect(report.duplicateMemberCount).toBe(0);
  });

  it('counts an unnamed member in the totals but never in a group', () => {
    const report = summarize([member({ fileName: null }), member({ fileName: '' }), member({ fileName: 'a.pdf' })]);

    expect(report.totalMembers).toBe(3);
    expect(report.duplicateNameCount).toBe(0);
  });

  it('ignores a name carried by exactly one member', () => {
    const report = summarize([member({ fileName: 'solo.pdf' }), member({ fileName: 'other.pdf' })]);

    expect(report.duplicateNameCount).toBe(0);
  });

  it('orders members newest first, so "keep newest" is always members[0]', () => {
    const older = member({ fabFileId: 'old', createdAt: new Date('2025-01-01T00:00:00Z') });
    const newer = member({ fabFileId: 'new', createdAt: new Date('2026-06-01T00:00:00Z') });
    const report = summarize([older, newer]);

    expect(report.duplicateGroups[0].members.map(m => m.fabFileId)).toEqual(['new', 'old']);
  });

  it('sorts a member with no createdAt last - it cannot be shown to be newer', () => {
    const dated = member({ fabFileId: 'dated', createdAt: new Date('2020-01-01T00:00:00Z') });
    const undatedMember = member({ fabFileId: 'undated', createdAt: null });
    const report = summarize([undatedMember, dated]);

    expect(report.duplicateGroups[0].members.map(m => m.fabFileId)).toEqual(['dated', 'undated']);
  });

  it('is stable across runs for same-instant uploads', () => {
    // A plan an owner already reviewed has to be comparable to the next one; a group whose order
    // jitters would re-present the same decision as if it were new.
    const at = new Date('2026-01-01T00:00:00Z');
    const build = () => [
      member({ fabFileId: 'b', createdAt: at }),
      member({ fabFileId: 'a', createdAt: at }),
      member({ fabFileId: 'c', createdAt: at }),
    ];

    expect(summarize(build()).duplicateGroups[0].members.map(m => m.fabFileId)).toEqual(
      summarize(build()).duplicateGroups[0].members.map(m => m.fabFileId)
    );
    expect(summarize(build()).duplicateGroups[0].members.map(m => m.fabFileId)).toEqual(['a', 'b', 'c']);
  });
});

describe('summarizeLakeMembership disclosure and shape', () => {
  it('reports the arm split without grading either arm', () => {
    const report = summarize([
      member({ arm: 'meta-tag', fileName: 'a.pdf' }),
      member({ arm: 'prefix', fileName: 'b.pdf' }),
      member({ arm: 'prefix', fileName: 'c.pdf' }),
    ]);

    expect(report.armSplit).toEqual({ 'meta-tag': 1, prefix: 2 });
  });

  it('carries the scope every number was computed in', () => {
    // The #2243 lesson: a membership number with no principal attached is the defect itself.
    expect(summarize([member()]).scope).toEqual({ creatorUserId: 'creator1', fileTagPrefix: 'acme:' });
  });

  it('presents the buckets needing a human before the one that collapses itself', () => {
    const report = summarize([
      member({ fileName: 'proven.pdf', serverTextHash: 'aaa' }),
      member({ fileName: 'proven.pdf', serverTextHash: 'aaa' }),
      member({ fileName: 'unknown.pdf', serverTextHash: undefined }),
      member({ fileName: 'unknown.pdf', serverTextHash: undefined }),
      member({ fileName: 'differs.pdf', serverTextHash: 'aaa' }),
      member({ fileName: 'differs.pdf', serverTextHash: 'bbb' }),
    ]);

    expect(report.duplicateGroups.map(g => g.bucket)).toEqual(['unverified', 'differing', 'proven-identical']);
    expect(report.bucketCounts).toEqual({ unverified: 1, differing: 1, 'proven-identical': 1 });
  });

  it('sorts before capping, so a truncated report keeps the groups a human most needs', () => {
    const report = summarize(
      [
        member({ fileName: 'zzz-proven.pdf', serverTextHash: 'aaa' }),
        member({ fileName: 'zzz-proven.pdf', serverTextHash: 'aaa' }),
        member({ fileName: 'aaa-unknown.pdf', serverTextHash: undefined }),
        member({ fileName: 'aaa-unknown.pdf', serverTextHash: undefined }),
      ],
      { maxGroups: 1 }
    );

    expect(report.duplicateGroups).toHaveLength(1);
    expect(report.duplicateGroups[0].bucket).toBe('unverified');
    // The count is of ALL groups, so a capped list never implies fewer duplicates than exist.
    expect(report.duplicateNameCount).toBe(2);
  });

  it('caps a group members array but keeps its exact memberCount', () => {
    // maxGroups bounds the group LIST only; one shared file name is a single group, so without a
    // per-group cap the payload was bounded only by the caller's scan limit.
    const report = summarize(
      [
        member({ createdAt: new Date('2026-01-03T00:00:00Z') }),
        member({ createdAt: new Date('2026-01-02T00:00:00Z') }),
        member({ createdAt: new Date('2026-01-01T00:00:00Z') }),
      ],
      { maxGroupMembers: 2 }
    );

    expect(report.duplicateGroups[0].members).toHaveLength(2);
    expect(report.duplicateGroups[0].memberCount).toBe(3);
    // Newest kept, since that is what "keep newest" reads and what a reviewer needs to see.
    expect(report.duplicateGroups[0].members[0].createdAt).toEqual(new Date('2026-01-03T00:00:00Z'));
    // Both totals stay exact, so no reader is told there are fewer members than there are.
    expect(report.duplicateMemberCount).toBe(3);
    expect(report.totalMembers).toBe(3);
  });

  it('buckets a group over ALL its members, not just the ones that survive the cap', () => {
    // The cap bounds the payload; it must not change what the group IS. If it were applied before
    // classification, dropping the odd member out would silently promote a group to collapsible.
    const report = summarize(
      [
        member({ serverTextHash: 'aaa', createdAt: new Date('2026-01-03T00:00:00Z') }),
        member({ serverTextHash: 'aaa', createdAt: new Date('2026-01-02T00:00:00Z') }),
        member({ serverTextHash: 'bbb', createdAt: new Date('2026-01-01T00:00:00Z') }),
      ],
      { maxGroupMembers: 2 }
    );

    expect(report.duplicateGroups[0].bucket).toBe('differing');
  });

  it('leaves members uncapped when no per-group cap is given', () => {
    const report = summarize([member(), member(), member()]);

    expect(report.duplicateGroups[0].members).toHaveLength(3);
    expect(report.duplicateGroups[0].memberCount).toBe(3);
  });

  it('passes scanTruncated through, so every count reads as a lower bound', () => {
    expect(summarize([member()], { scanTruncated: true }).scanTruncated).toBe(true);
    expect(summarize([member()]).scanTruncated).toBe(false);
  });

  it('reports an empty lake without inventing groups', () => {
    const report = summarize([]);

    expect(report.totalMembers).toBe(0);
    expect(report.duplicateNameCount).toBe(0);
    expect(report.armSplit).toEqual({ 'meta-tag': 0, prefix: 0 });
  });
});

describe('member ownership', () => {
  it('carries each member owner through to the group', () => {
    // Neither arm has an ownership conjunct, so a same-name group can span contributors. The repair
    // arm gates removal on that; it can only do so if the owner survives summarization.
    const report = summarize([
      member({ serverTextHash: 'aaa', fileSize: 100, userId: 'u1' }),
      member({ serverTextHash: 'aaa', fileSize: 100, userId: 'u2' }),
    ]);

    expect(report.duplicateGroups[0].bucket).toBe('proven-identical');
    expect(report.duplicateGroups[0].members.map(m => m.userId).sort()).toEqual(['u1', 'u2']);
  });

  it('records an unknown owner as null rather than dropping the field', () => {
    const report = summarize([member({ serverTextHash: 'aaa' }), member({ serverTextHash: 'aaa' })]);

    expect(report.duplicateGroups[0].members.every(m => m.userId === null)).toBe(true);
  });
});

describe('toWireMembershipReport', () => {
  const inProcess = () =>
    summarize([
      member({ serverTextHash: 'aaa', fileSize: 100, userId: 'u1' }),
      member({ serverTextHash: 'aaa', fileSize: 100, userId: 'u2' }),
    ]);

  it('drops serverTextHash and userId from every member', () => {
    // The hash is a stable global content identifier and the read gate on the health route admits
    // `public`, so neither belongs on the wire. The derived bucket is what a client needs.
    const wire = toWireMembershipReport(inProcess());
    const [m] = wire.duplicateGroups[0].members;

    expect(Object.keys(m).sort()).toEqual(['arm', 'createdAt', 'fabFileId', 'fileSize']);
    expect('serverTextHash' in m).toBe(false);
    expect('userId' in m).toBe(false);
  });

  it('leaves the in-process report untouched, since the repair arm reads it', () => {
    const report = inProcess();
    toWireMembershipReport(report);

    expect(report.duplicateGroups[0].members[0].serverTextHash).toBe('aaa');
    expect(report.duplicateGroups[0].members.map(m => m.userId).sort()).toEqual(['u1', 'u2']);
  });

  it('keeps every derived field a reader actually needs', () => {
    const wire = toWireMembershipReport(inProcess());

    expect(wire.duplicateGroups[0].bucket).toBe('proven-identical');
    expect(wire.duplicateGroups[0].memberCount).toBe(2);
    expect(wire.totalMembers).toBe(2);
    expect(wire.bucketCounts['proven-identical']).toBe(1);
    expect(wire.scope).toEqual(SCOPE);
  });
});
