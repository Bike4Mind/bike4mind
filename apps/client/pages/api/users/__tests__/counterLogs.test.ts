import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../../../packages/database/src/__test__/createMongoServer';
import { CounterLog, User } from '@bike4mind/database';
import { SAFE_USER_LOOKUP_PROJECT, USER_SECRET_FIELDS } from '@bike4mind/common';

/**
 * Tests for the M1 $lookup reorder (see counterlogs-phase2-payload-reduction.md).
 *
 * Tests 1 and 3 are AGREEMENT tests: they drive the real handler against createMongoServer and
 * pin the output contract, which is unchanged by the reorder. They pass against both the old and
 * new pipeline by design - that is the point, since the PR's claim is "identical output, faster".
 * The staging before/after diff (13,308 rows, byte-identical once resorted, ~2x faster) is the
 * empirical parity proof.
 *
 * Test 2 asserts on `buildCounterLogsPipeline` - the exported builder the handler actually calls -
 * NOT on a copy of the stages. An earlier version re-declared its own pipeline, which meant
 * deleting the production `$project` failed nothing; it was asserting that MongoDB's `$project`
 * works rather than that this route uses it.
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

import handler, { buildCounterLogsPipeline } from '../counterLogs';

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

  it('builds the user $lookup with an inner $project restricted to non-secret fields', () => {
    // Asserts on the EXPORTED builder the handler calls, so deleting or widening the production
    // $project fails here. Do not inline a copy of the stages: the $lookup's projection has no
    // effect on the HTTP response (the outer $group/$project already forward only named scalars),
    // so an output-level assertion cannot pin it - the property is structural.
    const stages = buildCounterLogsPipeline({ datetime: { $gte: new Date(0) } }) as Array<
      Record<string, { pipeline?: Array<{ $project?: Record<string, unknown> }>; as?: string }>
    >;

    const lookup = stages.find(s => s.$lookup?.as === 'user')?.$lookup;
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
