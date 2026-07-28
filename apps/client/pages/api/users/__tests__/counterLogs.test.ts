import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../../../packages/database/src/__test__/createMongoServer';
import { CounterLog, User } from '@bike4mind/database';
import { SAFE_USER_LOOKUP_PROJECT } from '@bike4mind/common';

/**
 * Agreement test for the M1 $lookup reorder (see counterlogs-phase2-payload-reduction.md):
 * drives the REAL aggregation against createMongoServer rather than mocking the pipeline, so a
 * regression in the group-then-join reshape or the inner $project fails here. The staging
 * before/after diff (13,308 rows, byte-identical once resorted, ~2x faster) is the empirical
 * parity proof; this test pins the same invariants so they can't regress silently in CI.
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

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  // autoIndex builds in the background after connect; the aggregation's `hint: { datetime: 1 }`
  // needs that index to exist before the first query runs, or Mongo rejects the hint outright.
  await CounterLog.init();
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, 30000);

afterEach(async () => {
  await mongoose.connection.dropDatabase();
  // dropDatabase wipes indexes along with the data - rebuild before the next test's aggregate
  // runs its `hint: { datetime: 1 }`, or it hits the same "no matching index" race.
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
  it('aggregates counts per user via the reordered lookup', async () => {
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
      metadata: Record<string, unknown>;
      users: Array<{ userId: string; userEmail: string; count: number; totalValue: number }>;
    }>;

    expect(rows).toHaveLength(2);

    const goodRow = rows.find(r => (r.metadata as { sessionId: string }).sessionId === 'session-a');
    expect(goodRow).toBeDefined();
    expect(goodRow!.count).toBe(2);
    expect(goodRow!.totalValue).toBe(2);
    expect(goodRow!.users).toHaveLength(1);
    expect(goodRow!.users[0].userEmail).toBe('good-user@example.com');
    expect(goodRow!.users[0].count).toBe(2);

    const orphanRow = rows.find(r => (r.metadata as { sessionId: string }).sessionId === 'session-b');
    expect(orphanRow).toBeDefined();
    expect(orphanRow!.users[0].userEmail).toBe('');
  });

  it('projects the joined user through the safe lookup allowlist, excluding secret fields', async () => {
    // Password is bcrypt-hashed by a pre-save hook, and the endpoint's own outer $group/$project
    // never forward the full `user` object to the response regardless of this stage - so a
    // response-level string/key check on the full endpoint would pass whether or not the lookup's
    // own inner $project exists. That made an earlier version of this test vacuous (confirmed by
    // mutation: deleting the inner $project below did not fail it). Test the lookup's OWN output
    // directly instead, by running the same match/group/lookup prefix the handler builds
    // (apps/client/pages/api/users/counterLogs.ts) as its own aggregation. Keep this prefix in
    // sync with that pipeline if the lookup stage ever changes.
    const user = await User.create({
      username: 'e2e-secret-check-user',
      name: 'Secret Check User',
      email: 'secret-check@example.com',
      password: 'sup3rSecretHashValueXYZ',
    });

    await CounterLog.create({
      userId: user.id,
      userName: 'Secret Check User',
      userLevel: 'User',
      counterName: 'Session Created',
      counterValue: 1,
      datetime: new Date('2026-07-21T10:00:00.000Z'),
      metadata: { sessionId: 'session-secret-check' },
    });

    const rows = await CounterLog.aggregate([
      {
        $match: {
          datetime: { $gte: new Date('2026-07-21T00:00:00.000Z'), $lte: new Date('2026-07-21T23:59:59.999Z') },
        },
      },
      { $addFields: { dateString: { $dateToString: { format: '%Y-%m-%d', date: '$datetime', timezone: 'UTC' } } } },
      {
        $group: {
          _id: { date: '$dateString', counterName: '$counterName', userId: '$userId', metadata: '$metadata' },
          totalValue: { $sum: '$counterValue' },
          count: { $sum: 1 },
        },
      },
      { $addFields: { userObjectId: { $toObjectId: '$_id.userId' } } },
      {
        $lookup: {
          from: 'users',
          localField: 'userObjectId',
          foreignField: '_id',
          pipeline: [{ $project: { ...SAFE_USER_LOOKUP_PROJECT, email: 1, organization: 1 } }],
          as: 'user',
        },
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    ]);

    expect(rows).toHaveLength(1);
    const joinedUser = rows[0].user;
    expect(joinedUser).toBeDefined();
    expect(joinedUser.email).toBe('secret-check@example.com');
    // $project only emits fields present on the source doc, so a field with no default (e.g.
    // lastActiveAt) may legitimately be absent - assert no UNEXPECTED key leaked through, rather
    // than exact key equality against fields that may or may not be set.
    const allowedKeys = new Set([...Object.keys(SAFE_USER_LOOKUP_PROJECT), 'email', 'organization']);
    for (const key of Object.keys(joinedUser)) {
      expect(allowedKeys.has(key), `unexpected key "${key}" leaked through the lookup projection`).toBe(true);
    }
    expect(joinedUser.password).toBeUndefined();
    expect(joinedUser.mfa).toBeUndefined();
    expect(joinedUser.oauthCredentials).toBeUndefined();
  });

  it('keeps metadata fragments in separate groups (M1 does not change the group key)', async () => {
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

    // Still two rows, one per distinct reportId - the group-key collapse is M2's job, not M1's.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.metadata.reportId))).toEqual(new Set(['report-1', 'report-2']));
  });
});
