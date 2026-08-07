import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../packages/database/src/__test__/createMongoServer';
import { buildUserActivityPipeline } from './userActivityQuery';

/**
 * Agreement test: the unit tests assert the pipeline's SHAPE, which cannot catch a stage
 * MongoDB rejects or groups differently than intended. This runs the real pipeline against
 * a real server, so paging, the total, and the user join are proven end to end.
 */
let mongoServer: MongoMemoryServer;
let counterLogs: mongoose.Collection;

const USER_A = new mongoose.Types.ObjectId();
const USER_B = new mongoose.Types.ObjectId();

const log = (overrides: Record<string, unknown>) => ({
  userId: USER_A.toString(),
  userName: 'a',
  userLevel: '1',
  userOrganization: 'Acme',
  counterName: 'Login',
  counterValue: 1,
  datetime: new Date('2026-07-24T10:00:00.000Z'),
  metadata: {},
  ...overrides,
});

const run = async (params: Parameters<typeof buildUserActivityPipeline>[0]) => {
  const { pipeline, facetStages } = buildUserActivityPipeline(params);
  const [facet] = await counterLogs.aggregate([...pipeline, { $facet: facetStages }]).toArray();
  return { rows: facet.rows, total: facet.total[0]?.value ?? 0 };
};

const RANGE = { startDate: '2026-07-21', endDate: '2026-07-28' };

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  const db = mongoose.connection.db!;
  counterLogs = db.collection('counterlogs');

  await db.collection('users').insertMany([
    { _id: USER_A, email: 'ada@example.com', organization: 'Acme' },
    { _id: USER_B, email: 'poy@example.com', organization: 'Acme' },
  ]);

  await counterLogs.insertMany([
    // Two same-day Logins for user A collapse into a single row with count 2. Unequal
    // counterValues so `count` (rows) and `totalValue` (summed value) cannot be confused.
    log({ counterValue: 1 }),
    log({ counterValue: 5, datetime: new Date('2026-07-24T11:00:00.000Z') }),
    log({ counterName: 'Logout', datetime: new Date('2026-07-25T10:00:00.000Z') }),
    log({ userId: USER_B.toString(), counterName: 'Login', datetime: new Date('2026-07-26T10:00:00.000Z') }),
    log({ counterName: 'Model Started', metadata: { source: 'cli' }, datetime: new Date('2026-07-23T10:00:00.000Z') }),
    log({ userOrganization: 'Personal', counterName: 'Login', datetime: new Date('2026-07-22T10:00:00.000Z') }),
    // Outside the requested window.
    log({ datetime: new Date('2026-06-01T10:00:00.000Z') }),
  ]);
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, 60000);

describe('user activity pipeline against MongoDB', () => {
  it('groups per day, counter and user, and counts the repeats', async () => {
    const { rows, total } = await run({ ...RANGE, skip: 0, limit: 50 });

    expect(total).toBe(5);
    const login = rows.find((r: any) => r.counterName === 'Login' && r.userEmail === 'ada@example.com');
    expect(login).toMatchObject({ date: '2026-07-24', count: 2, totalValue: 6 });
  });

  it('resolves the email through the user join', async () => {
    const { rows } = await run({ ...RANGE, skip: 0, limit: 50 });

    expect(rows.map((r: any) => r.userEmail)).toContain('poy@example.com');
  });

  it('returns disjoint pages that add up to the total', async () => {
    const first = await run({ ...RANGE, skip: 0, limit: 2 });
    const second = await run({ ...RANGE, skip: 2, limit: 2 });
    const third = await run({ ...RANGE, skip: 4, limit: 2 });

    expect(first.rows).toHaveLength(2);
    expect(first.total).toBe(5);
    const keys = [...first.rows, ...second.rows, ...third.rows].map(
      (r: any) => `${r.date}|${r.counterName}|${r.userEmail}`
    );
    expect(new Set(keys).size).toBe(5);
  });

  it('filters by counter name in Mongo', async () => {
    const { rows, total } = await run({ ...RANGE, skip: 0, limit: 50, counterName: 'logout' });

    expect(total).toBe(1);
    expect(rows[0].counterName).toBe('Logout');
  });

  it('filters by email in Mongo', async () => {
    const { total } = await run({ ...RANGE, skip: 0, limit: 50, userEmail: 'poy@' });

    expect(total).toBe(1);
  });

  it('excludes an organization', async () => {
    const { rows } = await run({ ...RANGE, skip: 0, limit: 50, excludeOrgs: ['Personal'] });

    expect(rows).toHaveLength(4);
  });

  it('filters on a metadata field', async () => {
    const { rows, total } = await run({
      ...RANGE,
      skip: 0,
      limit: 50,
      metadataFilters: [{ field: 'source', operator: 'equals', value: 'cli' }],
    });

    expect(total).toBe(1);
    expect(rows[0].counterName).toBe('Model Started');
  });

  it('ignores activity outside the requested range', async () => {
    const { total } = await run({ startDate: '2026-07-24', endDate: '2026-07-24', skip: 0, limit: 50 });

    expect(total).toBe(1);
  });
});
