import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { FeedbackModel } from '@bike4mind/database';
import { FeedbackStatus, type IFeedback } from '@bike4mind/common';
import { buildFeedbackRollupPipeline, toFeedbackRollupResponse, type FeedbackRollupFacet } from '../feedbackRollup';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const FROM = new Date('2026-01-01T00:00:00.000Z');
const TO = new Date('2026-02-01T00:00:00.000Z');
// Chosen so the 90-day text cutoff lands mid-window: reports before 2026-01-15 have lost their
// text, reports after it still have it.
const NOW = new Date('2026-04-15T00:00:00.000Z');

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

beforeEach(async () => {
  await FeedbackModel.deleteMany({});
  await FeedbackModel.insertMany(
    [
      // Text still readable: after the cutoff, and the sibling row was written.
      ...seed(10, new Date('2026-01-20T00:00:00.000Z'), {
        userId: USER_A,
        sessionId: 'a-session-1',
        questId: 'a-quest-1',
        subject: 'turn',
        status: FeedbackStatus.New,
        // The same tag twice: the create contract does not dedupe, so this is what a real row
        // can look like and it must still count once.
        tags: ['ux', 'ux'],
        contentStored: true,
      }),
      // Text expired: before the cutoff. No questId at all.
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
});

const runRollup = async (scope: Record<string, unknown>) => {
  const [facet] = await FeedbackModel.aggregate<FeedbackRollupFacet>(buildFeedbackRollupPipeline(scope, FROM, TO, NOW));
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

    // The same report IS counted by the adjoining window, so nothing is lost at the seam.
    const next = await runRollup({ userId: USER_A });
    expect(next.total).toBe(19);
    const [adjoining] = await FeedbackModel.aggregate<FeedbackRollupFacet>(
      buildFeedbackRollupPipeline({ userId: USER_A }, TO, new Date('2026-03-01T00:00:00.000Z'), NOW)
    );
    expect(toFeedbackRollupResponse(adjoining, TO, TO).total).toBe(1);
  });

  it('splits text availability by the retention cutoff and ignores reports that never had text', async () => {
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
    const plan = await FeedbackModel.aggregate(
      buildFeedbackRollupPipeline({ userId: USER_A }, FROM, TO, NOW)
    ).explain();

    expect(JSON.stringify(plan)).toContain('feedback_userId_createdAt');
  });
});
