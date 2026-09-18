import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { FeedbackStatus, FeedbackType, OrgMemberPopulation } from '@bike4mind/common';
import { FeedbackModel } from '../FeedbackModel';
import { orgFeedbackItem, orgFeedbackItems } from '../FeedbackReportQueries';
import { setupMongoTest } from '../../../__test__/utils';

/**
 * The drill-down scope is the guard, so it is exercised against real documents: a mock cannot show
 * that a foreign stamp or a departed author drops out of a Mongo filter.
 */

const oid = () => String(new mongoose.Types.ObjectId());

const makeFeedback = async (attrs: {
  userId: string;
  organizationId: string | null;
  createdAt: Date;
  subject?: string;
  content?: string;
}) => {
  const { createdAt, ...rest } = attrs;
  const doc = await FeedbackModel.create({
    username: `user-${attrs.userId}`,
    status: FeedbackStatus.New,
    type: FeedbackType.BUG,
    subject: 'product',
    tags: ['billing'],
    sessionId: 'session-1',
    contentStored: true,
    promptMeta: { model: 'secret-model' },
    ...rest,
  });
  await FeedbackModel.collection.updateOne({ _id: doc._id }, { $set: { createdAt } });
  return String(doc._id);
};

const population = (userIds: string[]): OrgMemberPopulation => ({ userIds, aclOnly: [], stampOnly: [] });

const JAN_10 = new Date('2026-01-10T12:00:00.000Z');
const WINDOW = { from: new Date('2026-01-01T00:00:00.000Z'), to: new Date('2026-01-31T23:59:59.999Z') };

describe('org feedback drill-down queries', () => {
  setupMongoTest();

  it('returns a member-authored row as metadata only, with no verbatim and no promptMeta', async () => {
    const organizationId = oid();
    const alice = oid();
    const id = await makeFeedback({ userId: alice, organizationId, createdAt: JAN_10, content: 'please fix billing' });

    const item = await orgFeedbackItem({ organizationId, feedbackId: id, members: population([alice]) });

    expect(item).toMatchObject({
      id,
      userId: alice,
      username: `user-${alice}`,
      subject: 'product',
      status: FeedbackStatus.New,
      type: FeedbackType.BUG,
      tags: ['billing'],
      sessionId: 'session-1',
      contentStored: true,
    });
    expect(item).not.toHaveProperty('content');
    expect(item).not.toHaveProperty('promptMeta');
    expect(item).not.toHaveProperty('userEmail');
  });

  it('refuses a row stamped to another org', async () => {
    const organizationId = oid();
    const otherOrg = oid();
    const alice = oid();
    const id = await makeFeedback({ userId: alice, organizationId: otherOrg, createdAt: JAN_10 });

    expect(await orgFeedbackItem({ organizationId, feedbackId: id, members: population([alice]) })).toBeNull();
  });

  it('refuses an unstamped row even when its author is a member', async () => {
    const organizationId = oid();
    const alice = oid();
    const id = await makeFeedback({ userId: alice, organizationId: null, createdAt: JAN_10 });

    expect(await orgFeedbackItem({ organizationId, feedbackId: id, members: population([alice]) })).toBeNull();
  });

  it('refuses a stamped row whose author is no longer in the member population', async () => {
    const organizationId = oid();
    const departed = oid();
    const stillHere = oid();
    const id = await makeFeedback({ userId: departed, organizationId, createdAt: JAN_10 });

    expect(await orgFeedbackItem({ organizationId, feedbackId: id, members: population([stillHere]) })).toBeNull();
  });

  it('refuses an unknown id, and refuses everything when the population is empty', async () => {
    const organizationId = oid();
    const alice = oid();
    await makeFeedback({ userId: alice, organizationId, createdAt: JAN_10 });

    expect(await orgFeedbackItem({ organizationId, feedbackId: oid(), members: population([alice]) })).toBeNull();
    expect(await orgFeedbackItem({ organizationId, feedbackId: oid(), members: population([]) })).toBeNull();
  });

  it('lists only in-scope rows, paginating against the full match count', async () => {
    const organizationId = oid();
    const otherOrg = oid();
    const alice = oid();
    const departed = oid();

    await makeFeedback({ userId: alice, organizationId, createdAt: new Date('2026-01-10T01:00:00.000Z') });
    await makeFeedback({ userId: alice, organizationId, createdAt: new Date('2026-01-11T01:00:00.000Z') });
    await makeFeedback({ userId: alice, organizationId, createdAt: new Date('2026-01-12T01:00:00.000Z') });
    // Each of these is excluded by a different arm of the scope.
    await makeFeedback({ userId: alice, organizationId: otherOrg, createdAt: JAN_10 });
    await makeFeedback({ userId: alice, organizationId: null, createdAt: JAN_10 });
    await makeFeedback({ userId: departed, organizationId, createdAt: JAN_10 });
    await makeFeedback({ userId: alice, organizationId, createdAt: new Date('2025-12-10T01:00:00.000Z') });

    const page = await orgFeedbackItems({
      organizationId,
      ...WINDOW,
      members: population([alice]),
      limit: 2,
      offset: 0,
    });

    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    // Newest first.
    expect(page.items.map(row => row.createdAt)).toEqual(['2026-01-12T01:00:00.000Z', '2026-01-11T01:00:00.000Z']);

    const second = await orgFeedbackItems({
      organizationId,
      ...WINDOW,
      members: population([alice]),
      limit: 2,
      offset: 2,
    });
    expect(second.items.map(row => row.createdAt)).toEqual(['2026-01-10T01:00:00.000Z']);
  });

  it('returns an empty page rather than every row when the population is empty', async () => {
    const organizationId = oid();
    await makeFeedback({ userId: oid(), organizationId, createdAt: JAN_10 });

    const page = await orgFeedbackItems({ organizationId, ...WINDOW, members: population([]), limit: 20, offset: 0 });
    expect(page).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
  });
});
