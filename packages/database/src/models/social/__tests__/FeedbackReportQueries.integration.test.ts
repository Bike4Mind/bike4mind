import { describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import { FeedbackStatus, FeedbackType, ORG_FEEDBACK_BY_TAG_LIMIT, OrgMemberPopulation } from '@bike4mind/common';
import { FeedbackModel } from '../FeedbackModel';
import { orgFeedbackReport } from '../FeedbackReportQueries';
import User, { userRepository } from '../../auth/UserModel';
import { setupMongoTest } from '../../../__test__/utils';

const oid = () => String(new mongoose.Types.ObjectId());

const makeUser = (id: string, name: string) =>
  User.create({
    _id: new mongoose.Types.ObjectId(id),
    username: `user-${id}`,
    name,
    email: `${id}@example.com`,
  });

/**
 * Written through the model so the row has the shape the create handler produces, then backdated
 * through the raw collection: `timestamps: true` owns `createdAt` on every model-level write, and
 * the date range is the thing under test.
 */
const makeFeedback = async (
  attrs: {
    userId: string;
    organizationId: string | null;
    createdAt: Date;
  } & Partial<{ subject: string; type: FeedbackType; status: FeedbackStatus; tags: string[] }>
) => {
  const { createdAt, ...rest } = attrs;
  const doc = await FeedbackModel.create({
    username: `user-${attrs.userId}`,
    status: FeedbackStatus.New,
    subject: 'product',
    contentStored: false,
    ...rest,
  });
  await FeedbackModel.collection.updateOne({ _id: doc._id }, { $set: { createdAt } });
  return doc;
};

const population = (userIds: string[], extra: Partial<OrgMemberPopulation> = {}): OrgMemberPopulation => ({
  userIds,
  aclOnly: [],
  stampOnly: [],
  ...extra,
});

const JAN_10 = new Date('2026-01-10T12:00:00.000Z');
const JAN_11 = new Date('2026-01-11T12:00:00.000Z');
const WINDOW = { from: new Date('2026-01-01T00:00:00.000Z'), to: new Date('2026-01-31T23:59:59.999Z') };

describe('orgFeedbackReport', () => {
  setupMongoTest();

  it('groups a member-authored window by day, subject, type, status, tag and member', async () => {
    const orgId = oid();
    const alice = oid();
    const bob = oid();
    await makeUser(alice, 'Alice');
    await makeUser(bob, 'Bob');

    await makeFeedback({
      userId: alice,
      organizationId: orgId,
      createdAt: JAN_10,
      type: FeedbackType.BUG,
      tags: ['billing', 'urgent'],
    });
    await makeFeedback({
      userId: alice,
      organizationId: orgId,
      createdAt: JAN_11,
      subject: 'session',
      type: FeedbackType.BUG,
      status: FeedbackStatus.Closed,
      tags: ['billing'],
    });
    await makeFeedback({ userId: bob, organizationId: orgId, createdAt: JAN_11, type: FeedbackType.FEEDBACK });

    const report = await orgFeedbackReport({
      organizationId: orgId,
      ...WINDOW,
      members: population([alice, bob]),
    });

    expect(report.totals.count).toBe(3);
    expect(report.byDay).toEqual([
      { day: '2026-01-10', count: 1 },
      { day: '2026-01-11', count: 2 },
    ]);
    expect(report.bySubject).toEqual([
      { key: 'product', count: 2 },
      { key: 'session', count: 1 },
    ]);
    expect(report.byType).toEqual([
      { key: FeedbackType.BUG, count: 2 },
      { key: FeedbackType.FEEDBACK, count: 1 },
    ]);
    expect(report.byStatus).toEqual([
      { key: FeedbackStatus.New, count: 2 },
      { key: FeedbackStatus.Closed, count: 1 },
    ]);
    // Three tag instances across two of the three rows, so byTag does not sum to totals by design.
    expect(report.byTag).toEqual([
      { key: 'billing', count: 2 },
      { key: 'urgent', count: 1 },
    ]);
    expect(report.byMember).toEqual([
      { userId: alice, displayName: 'Alice', count: 2 },
      { userId: bob, displayName: 'Bob', count: 1 },
    ]);
    expect(report.range.from).toBe(WINDOW.from.toISOString());
  });

  it('counts only stamped rows this org owns, inside the window, from a scoped member', async () => {
    const orgId = oid();
    const otherOrgId = oid();
    const member = oid();
    const stranger = oid();
    await makeUser(member, 'Member');
    await makeUser(stranger, 'Stranger');

    await makeFeedback({ userId: member, organizationId: orgId, createdAt: JAN_10 });
    await makeFeedback({ userId: member, organizationId: orgId, createdAt: new Date('2025-12-31T23:59:59.000Z') });
    await makeFeedback({ userId: member, organizationId: orgId, createdAt: new Date('2026-02-01T00:00:01.000Z') });
    // Unstamped: `organizationId` defaults to null, which no ObjectId equals.
    await makeFeedback({ userId: member, organizationId: null, createdAt: JAN_10 });
    await makeFeedback({ userId: member, organizationId: otherOrgId, createdAt: JAN_10 });
    await makeFeedback({ userId: stranger, organizationId: orgId, createdAt: JAN_10 });

    const report = await orgFeedbackReport({
      organizationId: orgId,
      ...WINDOW,
      members: population([member]),
    });

    expect(report.totals.count).toBe(1);
    expect(report.byMember).toEqual([{ userId: member, displayName: 'Member', count: 1 }]);
  });

  it('carries the ACL/stamp disagreement through to the response, resolved to names', async () => {
    const orgId = oid();
    const aclMember = oid();
    const stampAuthor = oid();
    await makeUser(aclMember, 'Idle Seat');
    await makeUser(stampAuthor, 'Manager Only');

    await makeFeedback({ userId: stampAuthor, organizationId: orgId, createdAt: JAN_10 });

    const report = await orgFeedbackReport({
      organizationId: orgId,
      ...WINDOW,
      members: population([aclMember, stampAuthor], { aclOnly: [aclMember], stampOnly: [stampAuthor] }),
    });

    expect(report.membership.memberCount).toBe(2);
    expect(report.membership.aclOnly).toEqual([{ userId: aclMember, displayName: 'Idle Seat' }]);
    expect(report.membership.stampOnly).toEqual([{ userId: stampAuthor, displayName: 'Manager Only' }]);
    // The stamp-only author's row is counted - dropping them is exactly what the union prevents.
    expect(report.totals.count).toBe(1);
  });

  it('returns zeroes for an empty member population without matching anything', async () => {
    const orgId = oid();
    const author = oid();
    await makeUser(author, 'Author');
    await makeFeedback({ userId: author, organizationId: orgId, createdAt: JAN_10 });

    const report = await orgFeedbackReport({ organizationId: orgId, ...WINDOW, members: population([]) });

    expect(report.totals).toEqual({ count: 0 });
    expect(report.byDay).toEqual([]);
    expect(report.byMember).toEqual([]);
    expect(report.membership.memberCount).toBe(0);
    // toBe(false), not toBeFalsy(): undefined is what the contract reserves for an artifact
    // written before the field existed, so the empty path has to answer false out loud.
    expect(report.byTagTruncated).toBe(false);
  });

  it('resolves every display name from one findByIds call, not one per list', async () => {
    const orgId = oid();
    const aclOnlyMember = oid();
    const stampOnlyMember = oid();
    const bothMember = oid();
    await makeUser(aclOnlyMember, 'Acl Only');
    await makeUser(stampOnlyMember, 'Stamp Only');
    await makeUser(bothMember, 'Both Sides');

    await makeFeedback({ userId: bothMember, organizationId: orgId, createdAt: JAN_10 });
    await makeFeedback({ userId: stampOnlyMember, organizationId: orgId, createdAt: JAN_11 });

    const findByIdsSpy = vi.spyOn(userRepository, 'findByIds');

    const report = await orgFeedbackReport({
      organizationId: orgId,
      ...WINDOW,
      members: population([aclOnlyMember, stampOnlyMember, bothMember], {
        aclOnly: [aclOnlyMember, bothMember],
        stampOnly: [stampOnlyMember],
      }),
    });

    expect(findByIdsSpy).toHaveBeenCalledTimes(1);
    expect(report.membership.aclOnly).toEqual(
      expect.arrayContaining([
        { userId: aclOnlyMember, displayName: 'Acl Only' },
        { userId: bothMember, displayName: 'Both Sides' },
      ])
    );
    expect(report.membership.stampOnly).toEqual([{ userId: stampOnlyMember, displayName: 'Stamp Only' }]);
    expect(report.byMember).toEqual(
      expect.arrayContaining([
        { userId: bothMember, displayName: 'Both Sides', count: 1 },
        { userId: stampOnlyMember, displayName: 'Stamp Only', count: 1 },
      ])
    );

    findByIdsSpy.mockRestore();
  });

  it('narrows every bucket to the requested subject, not just the bySubject one', async () => {
    // The route forwards `subject` to the aggregate; nothing until here proved the aggregate
    // actually matches on it rather than quietly counting the whole window.
    const orgId = oid();
    const author = oid();
    await makeUser(author, 'Author');
    await makeFeedback({ userId: author, organizationId: orgId, createdAt: JAN_10, subject: 'product' });
    await makeFeedback({ userId: author, organizationId: orgId, createdAt: JAN_11, subject: 'session' });

    const report = await orgFeedbackReport({
      organizationId: orgId,
      ...WINDOW,
      members: population([author]),
      subject: 'session',
    });

    expect(report.totals).toEqual({ count: 1 });
    expect(report.bySubject).toEqual([{ key: 'session', count: 1 }]);
    expect(report.byDay).toEqual([{ day: '2026-01-11', count: 1 }]);
  });

  it('buckets a row whose optional type was never set rather than dropping it', async () => {
    const orgId = oid();
    const author = oid();
    await makeUser(author, 'Author');
    await makeFeedback({ userId: author, organizationId: orgId, createdAt: JAN_10 });

    const report = await orgFeedbackReport({ organizationId: orgId, ...WINDOW, members: population([author]) });

    expect(report.byType).toEqual([{ key: 'unspecified', count: 1 }]);
    expect(report.byType.reduce((sum, row) => sum + row.count, 0)).toBe(report.totals.count);
  });

  // One row carrying many tags is enough: byTag unwinds tags, so the key space it groups over is
  // the row's tag list, not the row count.
  const tagKeys = (count: number) => Array.from({ length: count }, (_, i) => `tag-${String(i).padStart(2, '0')}`);

  // The personal rollup's tags arm dedupes before unwinding; this side has to agree, or the two
  // byTag breakdowns disagree on any report whose author sent the same tag twice.
  it('counts a repeated tag once rather than once per occurrence', async () => {
    const orgId = oid();
    const author = oid();
    await makeUser(author, 'Author');
    await makeFeedback({
      userId: author,
      organizationId: orgId,
      createdAt: JAN_10,
      tags: ['billing', 'billing', 'ux'],
    });

    const report = await orgFeedbackReport({ organizationId: orgId, ...WINDOW, members: population([author]) });

    expect(report.byTag).toEqual([
      { key: 'billing', count: 1 },
      { key: 'ux', count: 1 },
    ]);
  });

  it('leaves byTag unflagged when the distinct tags land exactly on the ceiling', async () => {
    const orgId = oid();
    const author = oid();
    await makeUser(author, 'Author');
    await makeFeedback({
      userId: author,
      organizationId: orgId,
      createdAt: JAN_10,
      tags: tagKeys(ORG_FEEDBACK_BY_TAG_LIMIT),
    });

    const report = await orgFeedbackReport({ organizationId: orgId, ...WINDOW, members: population([author]) });

    expect(report.byTag).toHaveLength(ORG_FEEDBACK_BY_TAG_LIMIT);
    expect(report.byTagTruncated).toBe(false);
  });

  it('flags byTag one key past the ceiling and keeps the top keys by count, then by key', async () => {
    const orgId = oid();
    const author = oid();
    await makeUser(author, 'Author');
    const tags = tagKeys(ORG_FEEDBACK_BY_TAG_LIMIT + 1);
    const hottest = tags[tags.length - 1];
    await makeFeedback({ userId: author, organizationId: orgId, createdAt: JAN_10, tags });
    // A second row on the alphabetically last key, so the cut is decided by count first and the
    // dropped key is the last of the count-1 group rather than the last tag overall.
    await makeFeedback({ userId: author, organizationId: orgId, createdAt: JAN_11, tags: [hottest] });

    const report = await orgFeedbackReport({ organizationId: orgId, ...WINDOW, members: population([author]) });

    expect(report.byTagTruncated).toBe(true);
    expect(report.byTag).toHaveLength(ORG_FEEDBACK_BY_TAG_LIMIT);
    expect(report.byTag[0]).toEqual({ key: hottest, count: 2 });
    expect(report.byTag[1]).toEqual({ key: tags[0], count: 1 });
    expect(report.byTag.map(row => row.key)).not.toContain(tags[ORG_FEEDBACK_BY_TAG_LIMIT - 1]);
  });
});
