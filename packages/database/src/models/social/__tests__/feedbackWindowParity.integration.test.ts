import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { FeedbackStatus, OrgMemberPopulation } from '@bike4mind/common';
import { FeedbackModel } from '../FeedbackModel';
import { orgFeedbackReport } from '../FeedbackReportQueries';
import User from '../../auth/UserModel';
import { setupMongoTest } from '../../../__test__/utils';
import {
  buildFeedbackRollupPipeline,
  toFeedbackRollupResponse,
  type FeedbackRollupFacet,
} from '../FeedbackRollupQueries';

const oid = () => String(new mongoose.Types.ObjectId());

// The org route rounds `to` to the last instant of the day, so this is the shape the two
// aggregations actually meet on.
const FROM = new Date('2026-01-01T00:00:00.000Z');
const TO = new Date('2026-01-31T23:59:59.999Z');
const MID = new Date('2026-01-15T09:30:00.000Z');

const makeUser = (id: string, name: string) =>
  User.create({
    _id: new mongoose.Types.ObjectId(id),
    username: `user-${id}`,
    name,
    email: `${id}@example.com`,
  });

/** Backdated through the raw collection: `timestamps: true` owns `createdAt` on a model write. */
const makeFeedback = async (attrs: { userId: string; organizationId: string | null; createdAt: Date }) => {
  const { createdAt, ...rest } = attrs;
  const doc = await FeedbackModel.create({
    username: `user-${attrs.userId}`,
    status: FeedbackStatus.New,
    subject: 'product',
    contentStored: false,
    ...rest,
  });
  await FeedbackModel.collection.updateOne({ _id: doc._id }, { $set: { createdAt } });
};

const population = (userIds: string[]): OrgMemberPopulation => ({ userIds, aclOnly: [], stampOnly: [] });

const personalTotal = async (scope: Record<string, unknown>) => {
  const { pipeline, facetStages } = buildFeedbackRollupPipeline(scope, FROM, TO);
  const [facet] = await FeedbackModel.aggregate<FeedbackRollupFacet>([...pipeline, { $facet: facetStages }]);
  return toFeedbackRollupResponse(facet, FROM, TO).total;
};

describe('feedback window parity between the org report and the personal rollup', () => {
  setupMongoTest();

  it('reconciles the org total against the personal totals only when the personal scope carries the org stamp', async () => {
    const orgId = oid();
    const alice = oid();
    const bob = oid();
    await makeUser(alice, 'Alice');
    await makeUser(bob, 'Bob');

    await makeFeedback({ userId: alice, organizationId: orgId, createdAt: FROM });
    await makeFeedback({ userId: alice, organizationId: orgId, createdAt: MID });
    await makeFeedback({ userId: alice, organizationId: orgId, createdAt: TO });
    await makeFeedback({ userId: bob, organizationId: orgId, createdAt: TO });
    // Same author, same window, no org stamp: the personal route has no reason to reject it and
    // the org report has no way to see it.
    await makeFeedback({ userId: alice, organizationId: null, createdAt: MID });

    const report = await orgFeedbackReport({
      organizationId: orgId,
      from: FROM,
      to: TO,
      members: population([alice, bob]),
    });

    const scoped = { organizationId: new mongoose.Types.ObjectId(orgId) };
    const scopedSum =
      (await personalTotal({ userId: alice, ...scoped })) + (await personalTotal({ userId: bob, ...scoped }));

    // Both bounds are inclusive on both sides, so the rows planted on `from` and on `to` land in
    // both counts rather than in one.
    expect(report.totals.count).toBe(4);
    expect(scopedSum).toBe(report.totals.count);

    // The conditional half of the invariant: `{ userId }` alone counts rows carrying any org
    // stamp or none, so an unscoped personal total is NOT the org total's summand.
    expect(await personalTotal({ userId: alice })).toBe(4);
    expect((await personalTotal({ userId: alice })) + (await personalTotal({ userId: bob }))).toBe(5);
  });

  it('agrees on a row sitting exactly on each bound rather than counting it on one side only', async () => {
    const orgId = oid();
    const carol = oid();
    await makeUser(carol, 'Carol');

    await makeFeedback({ userId: carol, organizationId: orgId, createdAt: FROM });
    await makeFeedback({ userId: carol, organizationId: orgId, createdAt: TO });
    // One millisecond past `to`: outside both windows, which is what keeps the bound a bound.
    await makeFeedback({ userId: carol, organizationId: orgId, createdAt: new Date(TO.getTime() + 1) });

    const report = await orgFeedbackReport({
      organizationId: orgId,
      from: FROM,
      to: TO,
      members: population([carol]),
    });

    expect(report.totals.count).toBe(2);
    expect(await personalTotal({ userId: carol, organizationId: new mongoose.Types.ObjectId(orgId) })).toBe(2);
  });
});
