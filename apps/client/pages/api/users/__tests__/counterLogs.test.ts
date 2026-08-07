import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../../../packages/database/src/__test__/createMongoServer';
import { CounterLog, User } from '@bike4mind/database';
import { SAFE_USER_LOOKUP_PROJECT, USER_SECRET_FIELDS } from '@bike4mind/common';

/**
 * End-to-end tests for the `{logs}` branch, driving the real handler against createMongoServer.
 *
 * Originally written for the M1 $lookup reorder; the row shape they pin is now flat (one row per
 * day/counter/user/metadata) rather than nested under `users[]`, because paging moved server-side.
 * The properties each test guards are unchanged: grouping/count correctness, the orphaned-user
 * $ifNull fallback, the $convert onError arm, the $lookup projection, and metadata fragmentation.
 *
 * The projection test asserts on the exported builder the handler actually calls, NOT on a copy of
 * the stages. An earlier version re-declared its own pipeline, which meant deleting the production
 * `$project` failed nothing; it was asserting that MongoDB's `$project` works rather than that this
 * route uses it.
 *
 * Handler-level paging concerns (envelope, clamping, cache keys, auth) are mocked-dependency tests
 * and live in counterLogs.paging.test.ts, which cannot share this file's real-Mongo harness.
 */

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

import handler from '../counterLogs';
import { buildUserActivityPipeline } from '@server/analytics/userActivityQuery';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  // Ensure declared indexes exist before querying. autoIndex is fire-and-forget, so on a fresh
  // database the first query can race the index build.
  await CounterLog.init();
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, 30000);

afterEach(async () => {
  await mongoose.connection.dropDatabase();
  // dropDatabase wipes indexes along with the data - rebuild for the next test.
  await CounterLog.init();
});

const stubLogger = () => {
  const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.withMetadata = vi.fn(() => logger);
  return logger;
};

function run(query: Record<string, string>) {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as Record<string, unknown>).ability = { can: () => true };
  (req as Record<string, unknown>).logger = stubLogger();
  (req as Record<string, unknown>).headers = { 'accept-encoding': 'gzip' };
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
}

describe('GET /api/users/counterLogs (end-to-end, real model + Mongo)', () => {
  it('aggregates counts per user via the post-group lookup', async () => {
    const goodUser = await User.create({
      username: 'e2e-good-user',
      name: 'Good User',
      email: 'good-user@example.com',
    });

    const orphanUserId = new mongoose.Types.ObjectId().toString();

    await CounterLog.create([
      {
        userId: goodUser.id,
        userName: 'Good User',
        userLevel: 'User',
        counterName: 'Session Created',
        counterValue: 1,
        datetime: new Date('2026-07-21T10:00:00.000Z'),
        metadata: { sessionId: 'session-a' },
      },
      {
        // Second event for the same user/date/counterName/metadata -> should collapse into the
        // same group and sum, exactly like the pre-reorder pipeline.
        userId: goodUser.id,
        userName: 'Good User',
        userLevel: 'User',
        counterName: 'Session Created',
        counterValue: 1,
        datetime: new Date('2026-07-21T11:00:00.000Z'),
        metadata: { sessionId: 'session-a' },
      },
      {
        // No matching User document - the orphaned-user path the client's $ifNull fallback
        // exists for. Must not throw, and must resolve to an empty-string email.
        userId: orphanUserId,
        userName: 'Ghost User',
        userLevel: 'User',
        counterName: 'Session Created',
        counterValue: 1,
        datetime: new Date('2026-07-21T12:00:00.000Z'),
        metadata: { sessionId: 'session-b' },
      },
    ]);

    const { res, promise } = run({ startDate: '2026-07-21', endDate: '2026-07-21' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(JSON.stringify(res._getJSONData()));
    const rows = body.logs as Array<{
      date: string;
      counterName: string;
      count: number;
      totalValue: number;
      userId: string;
      userEmail: string;
      metadata: Record<string, unknown>;
    }>;

    expect(rows).toHaveLength(2);

    const goodRow = rows.find(r => (r.metadata as { sessionId: string }).sessionId === 'session-a');
    expect(goodRow).toBeDefined();
    expect(goodRow!.count).toBe(2);
    expect(goodRow!.totalValue).toBe(2);
    expect(goodRow!.userEmail).toBe('good-user@example.com');

    const orphanRow = rows.find(r => (r.metadata as { sessionId: string }).sessionId === 'session-b');
    expect(orphanRow).toBeDefined();
    expect(orphanRow!.userEmail).toBe('');
  });

  it('does not abort the aggregation when a userId is not a valid ObjectId', async () => {
    // Distinct from the orphaned-user case above, which uses a VALID ObjectId with no matching
    // User (that exercises preserveNullAndEmptyArrays). This covers the $convert onError: null
    // arm: a non-ObjectId userId such as 'SYSTEM' must fail to join rather than throw. With the
    // previous $toObjectId, one such row aborted the entire aggregation with a ConversionFailure,
    // 500ing the whole admin analytics page.
    await CounterLog.create({
      userId: 'SYSTEM',
      userName: 'System',
      userLevel: 'System',
      counterName: 'Session Created',
      counterValue: 1,
      datetime: new Date('2026-07-21T10:00:00.000Z'),
      metadata: { sessionId: 'session-system' },
    });

    const { res, promise } = run({ startDate: '2026-07-21', endDate: '2026-07-21' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const rows = JSON.parse(JSON.stringify(res._getJSONData())).logs as Array<{
      metadata: { sessionId: string };
      userId: string;
      userEmail: string;
    }>;

    const systemRow = rows.find(r => r.metadata.sessionId === 'session-system');
    expect(systemRow, 'the row must still be returned, not dropped or thrown on').toBeDefined();
    expect(systemRow!.userId).toBe('SYSTEM');
    expect(systemRow!.userEmail).toBe('');
  });

  it('builds the user $lookup with an inner $project restricted to non-secret fields', () => {
    // Asserts on the EXPORTED builder the handler calls, so deleting or widening the production
    // $project fails here. Do not inline a copy of the stages: the $lookup's projection has no
    // effect on the HTTP response (the outer $group/$project already forward only named scalars),
    // so an output-level assertion cannot pin it - the property is structural.
    const { pipeline: stages } = buildUserActivityPipeline({
      startDate: '2026-07-21',
      endDate: '2026-07-21',
      skip: 0,
      limit: 25,
    });

    const lookup = stages.find((s: Record<string, any>) => s.$lookup?.as === 'user')?.$lookup;
    expect(lookup, 'the pipeline must contain a $lookup aliased to "user"').toBeDefined();

    const projection = lookup!.pipeline?.[0]?.$project;
    expect(projection, 'the user $lookup must carry an inner $project').toBeDefined();

    // Exact key set: an inclusion projection that gains a field is exactly the regression to catch,
    // so assert equality rather than a subset. Secret fields are named explicitly too, so the
    // intent survives even if SAFE_USER_LOOKUP_PROJECT itself is ever widened by mistake.
    expect(new Set(Object.keys(projection!))).toEqual(
      new Set([...Object.keys(SAFE_USER_LOOKUP_PROJECT), 'email', 'organization'])
    );
    for (const secret of USER_SECRET_FIELDS) {
      expect(projection, `secret field "${secret}" must never be projected`).not.toHaveProperty(secret);
    }
  });

  it('keeps metadata fragments in separate groups', async () => {
    const user = await User.create({
      username: 'e2e-frag-user',
      name: 'Frag User',
      email: 'frag-user@example.com',
    });

    await CounterLog.create([
      {
        userId: user.id,
        userName: 'Frag User',
        userLevel: 'User',
        counterName: 'Marketing Report Opened',
        counterValue: 1,
        datetime: new Date('2026-07-21T09:00:00.000Z'),
        metadata: { reportId: 'report-1' },
      },
      {
        userId: user.id,
        userName: 'Frag User',
        userLevel: 'User',
        counterName: 'Marketing Report Opened',
        counterValue: 1,
        datetime: new Date('2026-07-21T09:30:00.000Z'),
        metadata: { reportId: 'report-2' },
      },
    ]);

    const { res, promise } = run({ startDate: '2026-07-21', endDate: '2026-07-21' });
    await promise;

    const body = JSON.parse(JSON.stringify(res._getJSONData()));
    const rows = body.logs as Array<{ metadata: { reportId: string } }>;

    // Still two rows, one per distinct reportId - collapsing the group key is not this change's job.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.metadata.reportId))).toEqual(new Set(['report-1', 'report-2']));
  });
});
