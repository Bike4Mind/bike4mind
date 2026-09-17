import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { FeedbackModel, FeedbackTextModel } from '@bike4mind/database';
import { FeedbackStatus, FEEDBACK_ROLLUP_TOP_N, type IFeedback } from '@bike4mind/common';
import { buildFeedbackRollupPipeline, toFeedbackRollupResponse, type FeedbackRollupFacet } from '../feedbackRollup';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const FROM = new Date('2026-01-01T00:00:00.000Z');
const TO = new Date('2026-02-01T00:00:00.000Z');

const USER_A = 'user-a';
const USER_B = 'user-b';

type SeedDoc = Partial<IFeedback> & { createdAt: Date; updatedAt: Date };

function seed(count: number, at: Date, fields: Partial<IFeedback>): SeedDoc[] {
  return Array.from({ length: count }, () => ({
    username: 'seed user',
    status: FeedbackStatus.New,
    subject: 'product',
    contentStored: false,
    ...fields,
    createdAt: at,
    updatedAt: at,
  })) as SeedDoc[];
}

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await FeedbackModel.ensureIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

const textStoredIds = Array.from({ length: 10 }, () => new mongoose.Types.ObjectId());

beforeEach(async () => {
  await FeedbackModel.deleteMany({});
  await FeedbackTextModel.deleteMany({});
  await FeedbackModel.insertMany(
    [
      // Text still readable: each of these carries a live FeedbackText sibling row.
      ...textStoredIds.map(_id => ({
        _id,
        ...seed(1, new Date('2026-01-20T00:00:00.000Z'), {
          userId: USER_A,
          sessionId: 'a-session-1',
          questId: 'a-quest-1',
          subject: 'turn',
          status: FeedbackStatus.New,
          // The same tag twice: the create contract does not dedupe, so this is what a real row
          // can look like and it must still count once.
          tags: ['ux', 'ux'],
          contentStored: true,
        })[0],
      })),
      // Text expired: contentStored is set but no sibling row exists and no inline content
      // remains - the report itself being "old" is irrelevant to the new derivation. No questId
      // at all.
      ...seed(5, new Date('2026-01-10T00:00:00.000Z'), {
        userId: USER_A,
        sessionId: 'a-session-2',
        subject: 'session',
        status: FeedbackStatus.Closed,
        tags: ['bug', 'ux'],
        contentStored: true,
      }),
      // Never had text, and attributable to no session or quest.
      ...seed(3, new Date('2026-01-25T00:00:00.000Z'), {
        userId: USER_A,
        subject: 'product',
        status: FeedbackStatus.InProgress,
      }),
      // Exactly the lower bound: inside a half-open window.
      ...seed(1, FROM, { userId: USER_A, sessionId: 'a-session-3', subject: 'product' }),
      // Exactly the upper bound: belongs to the NEXT window, so it must not appear anywhere.
      ...seed(1, TO, { userId: USER_A, sessionId: 'a-session-excluded', subject: 'product' }),
      // One millisecond before the window.
      ...seed(1, new Date(FROM.getTime() - 1), { userId: USER_A, sessionId: 'a-session-before' }),
      // Another user's reports, inside the window, sharing nothing with A.
      ...seed(6, new Date('2026-01-20T00:00:00.000Z'), {
        userId: USER_B,
        sessionId: 'b-session-1',
        questId: 'b-quest-1',
        subject: 'turn',
        tags: ['ux'],
        contentStored: true,
      }),
    ],
    // Without this Mongoose stamps createdAt at insert time and every seeded window collapses to
    // "now", which would make the bound assertions below vacuous.
    { timestamps: false }
  );
  await FeedbackTextModel.insertMany(
    textStoredIds.map(_id => ({ _id, content: 'still readable', expiresAt: new Date('2099-01-01T00:00:00.000Z') }))
  );
});

const runRollup = async (scope: Record<string, unknown>) => {
  const { pipeline, facetStages } = buildFeedbackRollupPipeline(scope, FROM, TO);
  const [facet] = await FeedbackModel.aggregate<FeedbackRollupFacet>([...pipeline, { $facet: facetStages }]);
  return toFeedbackRollupResponse(facet, FROM, TO);
};

describe('feedback rollup against a real collection', () => {
  it('counts exactly the owner rows inside the half-open window', async () => {
    const response = await runRollup({ userId: USER_A });

    expect(response.total).toBe(19);
    expect(response.buckets.sessionId.buckets).toEqual([
      { key: 'a-session-1', count: 10 },
      { key: 'a-session-2', count: 5 },
      { key: 'a-session-3', count: 1 },
    ]);
    expect(response.buckets.sessionId.truncated).toBe(false);
    // Only the 10 reports that carry one; the other 9 still count in `total`.
    expect(response.buckets.questId.buckets).toEqual([{ key: 'a-quest-1', count: 10 }]);
    expect(response.buckets.subject.buckets).toEqual([
      { key: 'turn', count: 10 },
      { key: 'session', count: 5 },
      { key: 'product', count: 4 },
    ]);
    expect(response.buckets.status.buckets).toEqual([
      { key: FeedbackStatus.New, count: 11 },
      { key: FeedbackStatus.Closed, count: 5 },
      { key: FeedbackStatus.InProgress, count: 3 },
    ]);
  });

  it('counts a duplicated tag once per report', async () => {
    const response = await runRollup({ userId: USER_A });

    // 'ux' appears twice on each of the 10 turn reports and once on each of the 5 session ones.
    expect(response.buckets.tags.buckets).toEqual([
      { key: 'ux', count: 15 },
      { key: 'bug', count: 5 },
    ]);
  });

  it('excludes a report written at exactly the upper bound', async () => {
    const response = await runRollup({ userId: USER_A });
    const keys = response.buckets.sessionId.buckets.map(bucket => bucket.key);

    expect(keys).not.toContain('a-session-excluded');
    expect(keys).not.toContain('a-session-before');

    // The half-open bound moves that report into the adjoining window instead of dropping it,
    // which is what keeps consecutive windows summing to the same total as one wide one.
    const nextTo = new Date('2026-03-01T00:00:00.000Z');
    const adjoiningPipeline = buildFeedbackRollupPipeline({ userId: USER_A }, TO, nextTo);
    const [adjoining] = await FeedbackModel.aggregate<FeedbackRollupFacet>([
      ...adjoiningPipeline.pipeline,
      { $facet: adjoiningPipeline.facetStages },
    ]);
    expect(toFeedbackRollupResponse(adjoining, TO, nextTo).total).toBe(1);
  });

  it('splits text availability by the FeedbackText sibling and ignores reports that never had text', async () => {
    const response = await runRollup({ userId: USER_A });

    expect(response.textAvailability).toEqual({ stored: 10, expired: 5 });
  });

  it('never leaks another user into the owner scope', async () => {
    const response = await runRollup({ userId: USER_A });
    const everyKey = [...response.buckets.sessionId.buckets, ...response.buckets.questId.buckets].map(
      bucket => bucket.key
    );

    expect(everyKey.some(key => key.startsWith('b-'))).toBe(false);
    expect(await runRollup({ userId: USER_B }).then(other => other.total)).toBe(6);
  });

  it('walks the userId/createdAt index rather than scanning the collection', async () => {
    const { pipeline, facetStages } = buildFeedbackRollupPipeline({ userId: USER_A }, FROM, TO);
    const plan = await FeedbackModel.aggregate([...pipeline, { $facet: facetStages }]).explain();

    expect(JSON.stringify(plan)).toContain('feedback_userId_createdAt');
  });

  it('sorts a dimension back into descending count regardless of insertion order', async () => {
    const userId = 'sort-order-user';
    await FeedbackModel.insertMany(
      [
        // Inserted lowest-count-first: only the aggregation's own $sort can make the response
        // descending, since insertion order alone would not.
        ...seed(1, new Date('2026-01-05T00:00:00.000Z'), { userId, subject: 'session' }),
        ...seed(3, new Date('2026-01-05T00:00:00.000Z'), { userId, subject: 'turn' }),
      ],
      { timestamps: false }
    );

    const response = await runRollup({ userId });

    expect(response.buckets.subject.buckets).toEqual([
      { key: 'turn', count: 3 },
      { key: 'session', count: 1 },
    ]);
  });

  it('does not truncate a dimension holding exactly the top-N ceiling', async () => {
    const userId = 'exact-ceiling-user';
    await FeedbackModel.insertMany(
      Array.from({ length: FEEDBACK_ROLLUP_TOP_N }, (_, index) =>
        seed(1, new Date('2026-01-05T00:00:00.000Z'), { userId, sessionId: `session-${index}` })
      ).flat(),
      { timestamps: false }
    );

    const response = await runRollup({ userId });

    expect(response.buckets.sessionId.buckets).toHaveLength(FEEDBACK_ROLLUP_TOP_N);
    expect(response.buckets.sessionId.truncated).toBe(false);
  });

  it('ignores contextQuestId in the questId dimension - only questId itself counts', async () => {
    const userId = 'context-quest-user';
    await FeedbackModel.insertMany(
      seed(1, new Date('2026-01-05T00:00:00.000Z'), { userId, contextQuestId: 'ctx-quest-1' }),
      {
        timestamps: false,
      }
    );

    const response = await runRollup({ userId });

    expect(response.total).toBe(1);
    expect(response.buckets.questId.buckets).toEqual([]);
  });

  it('ties every subject bucket and every status bucket back to the same total', async () => {
    const response = await runRollup({ userId: USER_A });

    const subjectSum = response.buckets.subject.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    const statusSum = response.buckets.status.buckets.reduce((sum, bucket) => sum + bucket.count, 0);

    expect(subjectSum).toBe(response.total);
    expect(statusSum).toBe(response.total);
  });

  it('derives text availability from the sibling row and $content type, per hydrateFeedbackText', async () => {
    const userId = 'text-derivation-user';
    const liveSiblingId = new mongoose.Types.ObjectId();

    await FeedbackModel.insertMany(
      [
        // Pre-split legacy shape: inline content, no sibling row -> STORED.
        ...seed(1, new Date('2026-01-05T00:00:00.000Z'), {
          userId,
          contentStored: true,
          content: 'legacy inline text',
        }),
        // contentStored true, no sibling, no inline content -> EXPIRED.
        ...seed(1, new Date('2026-01-05T00:00:00.000Z'), { userId, contentStored: true }),
        // contentStored false -> counted in neither arm, regardless of content.
        ...seed(1, new Date('2026-01-05T00:00:00.000Z'), { userId, contentStored: false }),
        // A live sibling row -> STORED.
        { _id: liveSiblingId, ...seed(1, new Date('2026-01-05T00:00:00.000Z'), { userId, contentStored: true })[0] },
      ],
      { timestamps: false }
    );
    await FeedbackTextModel.create({
      _id: liveSiblingId,
      content: 'still readable',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    });

    const response = await runRollup({ userId });

    expect(response.total).toBe(4);
    expect(response.textAvailability).toEqual({ stored: 2, expired: 1 });
  });
});
