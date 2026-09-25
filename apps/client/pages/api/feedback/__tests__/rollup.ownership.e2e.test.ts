import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { FeedbackModel } from '@bike4mind/database';
import { FEEDBACK_ROLLUP_TOP_N, FeedbackStatus, type IFeedback } from '@bike4mind/common';

/**
 * The rollup route driven against a real collection: the response a caller receives has to
 * reconstruct exactly that caller's own reports, with no mocked aggregate standing in for the
 * query. baseApi is still captured rather than run - rollup.auth.test.ts owns the auth mode.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    get: (fn: unknown) => {
      mockRefs.getHandler = fn as (req: unknown, res: unknown) => unknown;
      return chain;
    },
    post: () => chain,
    // The route chains rateLimit before .get; the capture harness only needs the chain back.
    use: () => chain,
  };
  return { baseApi: () => chain };
});

import '@pages/api/feedback/rollup';

const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-02-01T00:00:00.000Z';
const INSIDE = new Date('2026-01-15T00:00:00.000Z');

const USER_A = 'owner-a';
const USER_B = 'owner-b';

type SeedDoc = Partial<IFeedback> & { createdAt: Date; updatedAt: Date };

const row = (fields: Partial<IFeedback>): SeedDoc =>
  ({
    username: 'seed user',
    status: FeedbackStatus.New,
    subject: 'product',
    contentStored: false,
    createdAt: INSIDE,
    updatedAt: INSIDE,
    ...fields,
  }) as SeedDoc;

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await FeedbackModel.deleteMany({});
});

const stubLogger = () => {
  const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.withMetadata = vi.fn(() => logger);
  return logger;
};

const callAs = async (userId: string, query: Record<string, unknown> = { from: FROM, to: TO }) => {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as unknown as { user: unknown }).user = { id: userId };
  (req as unknown as { logger: unknown }).logger = stubLogger();
  await mockRefs.getHandler!(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() };
};

describe('GET /api/feedback/rollup against a real collection', () => {
  it('returns exactly the caller own reports and none of the other user', async () => {
    await FeedbackModel.insertMany(
      [
        row({ userId: USER_A, sessionId: 'a1' }),
        row({ userId: USER_A, sessionId: 'a1' }),
        row({ userId: USER_A, sessionId: 'a2' }),
        row({ userId: USER_B, sessionId: 'b1' }),
        row({ userId: USER_B, sessionId: 'b1' }),
        row({ userId: USER_B, sessionId: 'b2' }),
        row({ userId: USER_B, sessionId: 'b3' }),
      ],
      { timestamps: false }
    );

    const { status, body } = await callAs(USER_A);

    expect(status).toBe(200);
    expect(body.total).toBe(3);
    // Exact set, not "no B key found": the latter also passes when both sides are empty.
    expect(body.buckets.sessionId.buckets).toEqual([
      { key: 'a1', count: 2 },
      { key: 'a2', count: 1 },
    ]);

    const asB = await callAs(USER_B);
    expect(asB.body.total).toBe(4);
    expect(asB.body.buckets.sessionId.buckets.map((bucket: { key: string }) => bucket.key)).toEqual(['b1', 'b2', 'b3']);
  });

  it('gives an admin their own rollup only - the unconditional read grant does not widen it', async () => {
    // The route never consults req.ability, so an admin caller is just another userId here. The
    // regression this pins is the CASL shortcut: accessibleBy narrows to {} for an admin, which
    // would have turned this into an aggregate over both users' reports.
    await FeedbackModel.insertMany(
      [row({ userId: 'admin-user', sessionId: 'admin-1' }), row({ userId: USER_B, sessionId: 'b1' })],
      { timestamps: false }
    );

    const { body } = await callAs('admin-user');

    expect(body.total).toBe(1);
    expect(body.buckets.sessionId.buckets).toEqual([{ key: 'admin-1', count: 1 }]);
  });

  it('returns an empty rollup for a user with no reports', async () => {
    await FeedbackModel.insertMany([row({ userId: USER_B, sessionId: 'b1' })], { timestamps: false });

    const { status, body } = await callAs('user-with-nothing');

    expect(status).toBe(200);
    expect(body.total).toBe(0);
    expect(body.buckets.sessionId).toEqual({ buckets: [], truncated: false });
    expect(body.buckets.tags).toEqual({ buckets: [], truncated: false });
    expect(body.textAvailability).toEqual({ stored: 0, expired: 0 });
  });

  it('counts a report with no sessionId or questId in the total but in neither dimension', async () => {
    await FeedbackModel.insertMany(
      [row({ userId: USER_A, tags: [] }), row({ userId: USER_A, sessionId: 'a1', questId: 'q1' })],
      { timestamps: false }
    );

    const { body } = await callAs(USER_A);

    expect(body.total).toBe(2);
    expect(body.buckets.sessionId.buckets).toEqual([{ key: 'a1', count: 1 }]);
    expect(body.buckets.questId.buckets).toEqual([{ key: 'q1', count: 1 }]);
    expect(body.buckets.tags.buckets).toEqual([]);
  });

  it('survives a report stored without a tags field at all', async () => {
    // Mongoose defaults an array path to [], so only a raw write reproduces a document written
    // before `tags` existed. Pins that the $setUnion/$unwind arm drops it instead of failing the
    // aggregate, which would cost the caller the whole response rather than one dimension.
    await FeedbackModel.collection.insertOne({
      userId: USER_A,
      username: 'seed user',
      status: FeedbackStatus.New,
      subject: 'product',
      contentStored: false,
      sessionId: 'a1',
      createdAt: INSIDE,
      updatedAt: INSIDE,
    } as unknown as Parameters<typeof FeedbackModel.collection.insertOne>[0]);

    const { status, body } = await callAs(USER_A);

    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.buckets.tags.buckets).toEqual([]);
    expect(body.buckets.sessionId.buckets).toEqual([{ key: 'a1', count: 1 }]);
  });

  it('drops a non-array tags value instead of failing every arm', async () => {
    // $setUnion hard-errors on a non-array operand, and inside $facet that costs the caller
    // `total` and all five dimensions rather than the tags bucket alone.
    await FeedbackModel.collection.insertOne({
      userId: USER_A,
      username: 'seed user',
      status: FeedbackStatus.New,
      subject: 'product',
      contentStored: false,
      sessionId: 'a1',
      tags: 'not-an-array',
      createdAt: INSIDE,
      updatedAt: INSIDE,
    } as unknown as Parameters<typeof FeedbackModel.collection.insertOne>[0]);

    const { status, body } = await callAs(USER_A);

    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.buckets.tags.buckets).toEqual([]);
    expect(body.buckets.sessionId.buckets).toEqual([{ key: 'a1', count: 1 }]);
  });

  it('truncates at the shared ceiling when one user has far more sessions than it', async () => {
    const many = 2000;
    await FeedbackModel.insertMany(
      Array.from({ length: many }, (_, index) => row({ userId: USER_A, sessionId: `session-${index}` })),
      { timestamps: false }
    );

    const { body } = await callAs(USER_A);

    expect(body.total).toBe(many);
    expect(body.buckets.sessionId.buckets).toHaveLength(FEEDBACK_ROLLUP_TOP_N);
    expect(body.buckets.sessionId.truncated).toBe(true);
    expect(body.topN).toBe(FEEDBACK_ROLLUP_TOP_N);
  });
});
