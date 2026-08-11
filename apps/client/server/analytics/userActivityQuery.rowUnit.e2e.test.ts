import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../packages/database/src/__test__/createMongoServer';
import { buildUserActivityPipeline } from './userActivityQuery';
import {
  asWindow,
  buildWindow,
  sliceWindow,
  windowCoversPage,
  windowRowsFor,
  type UserActivityWindow,
} from './userActivityCache';

/**
 * Acceptance test for the row unit: the server's rows must match what the pre-pagination client
 * rendered, because that client merged rows the server now has to merge itself.
 *
 * `mergedLikeThePrePaginationClient` restates that client's key - date + counter + email, plus
 * reportId on report counters - over the same raw events, so this is a comparison against the
 * old behaviour rather than against a hand-written expectation.
 *
 * Rows are served through the window cache (`servePage`), not straight off the builder: the cache
 * is what the grid actually reads, so pinning the guarantee there covers the slicing too.
 */
let mongoServer: MongoMemoryServer;
let counterLogs: mongoose.Collection;

const USER_A = new mongoose.Types.ObjectId();
const USER_B = new mongoose.Types.ObjectId();
const EMAIL: Record<string, string> = {
  [USER_A.toString()]: 'ada@example.com',
  [USER_B.toString()]: 'poy@example.com',
};

const RANGE = { startDate: '2026-07-21', endDate: '2026-07-28' };

interface RawLog {
  userId: string;
  userName: string;
  userLevel: string;
  userOrganization: string;
  counterName: string;
  counterValue: number;
  datetime: Date;
  metadata: Record<string, unknown>;
}

const log = (overrides: Partial<RawLog>): RawLog => ({
  userId: USER_A.toString(),
  userName: 'a',
  userLevel: '1',
  userOrganization: 'Acme',
  counterName: 'Session Created',
  counterValue: 1,
  datetime: new Date('2026-07-24T10:00:00.000Z'),
  metadata: {},
  ...overrides,
});

const times = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));

/**
 * The production shape: every event carries identity metadata (a session, a request, timings),
 * so with the subdocument in the group key no two events of the same activity ever collapse.
 */
const FIXTURE: RawLog[] = [
  ...times(40, i => log({ metadata: { sessionId: `session-${i}`, sessionName: `chat ${i}` } })),
  ...times(25, i =>
    log({
      counterName: 'Completion API Completed',
      counterValue: 2,
      metadata: {
        requestId: `req-${i}`,
        modelName: i % 2 ? 'claude-opus-5' : 'claude-sonnet-5',
        source: i % 3 ? 'web' : 'cli',
        durationMs: 100 + i,
      },
    })
  ),
  ...times(10, i =>
    log({
      userId: USER_B.toString(),
      datetime: new Date('2026-07-25T10:00:00.000Z'),
      metadata: { sessionId: `b-session-${i}` },
    })
  ),
  ...times(4, i =>
    log({ counterName: 'Marketing Report Opened', metadata: { reportId: 'report-1', viewId: `v${i}` } })
  ),
  ...times(2, i =>
    log({ counterName: 'Marketing Report Opened', metadata: { reportId: 'report-2', viewId: `v${i}` } })
  ),
];

interface Row {
  date: string;
  counterName: string;
  userEmail: string;
  count: number;
  totalValue: number;
}

function mergedLikeThePrePaginationClient(events: RawLog[]): Row[] {
  const merged = new Map<string, Row>();

  for (const event of events) {
    const date = event.datetime.toISOString().slice(0, 10);
    const userEmail = EMAIL[event.userId] ?? '';
    const reportId = event.metadata.reportId;
    const isReportAction = event.counterName.toLowerCase().includes('report');
    const key =
      isReportAction && reportId
        ? `${date}-${event.counterName}-${userEmail}-${reportId}`
        : `${date}-${event.counterName}-${userEmail}`;

    const existing = merged.get(key);
    if (existing) {
      existing.count += 1;
      existing.totalValue += event.counterValue;
    } else {
      merged.set(key, { date, counterName: event.counterName, userEmail, count: 1, totalValue: event.counterValue });
    }
  }

  return [...merged.values()];
}

const identify = (row: Row) => `${row.date}|${row.counterName}|${row.userEmail}`;

type Query = Omit<Parameters<typeof buildUserActivityPipeline>[0], 'skip' | 'limit'>;

/** Stands in for the cache collection, keyed the way the route keys it: by filter set, not page. */
let windowCache = new Map<string, unknown>();

let aggregations = 0;

/**
 * Mirrors the route's read path (pages/api/users/counterLogs.ts): serve the page out of a cached
 * window when one covers it, otherwise aggregate a window from offset 0 and slice this page out.
 */
const servePage = async (query: Query, page = 1, limit = 100) => {
  const cacheKey = JSON.stringify(query);
  const skip = (page - 1) * limit;

  const cachedWindow = asWindow(windowCache.get(cacheKey));
  if (cachedWindow && windowCoversPage(cachedWindow, skip, limit)) {
    return { rows: sliceWindow(cachedWindow, skip, limit) as Row[], total: cachedWindow.total };
  }

  const windowRows = cachedWindow?.truncated ? null : windowRowsFor(skip, limit, cachedWindow?.rows.length);
  const { pipeline, facetStages } = buildUserActivityPipeline({
    ...query,
    skip: windowRows === null ? skip : 0,
    limit: windowRows ?? limit,
  });

  aggregations += 1;
  const [facet] = await counterLogs.aggregate([...pipeline, { $facet: facetStages }]).toArray();
  const fetched: unknown[] = facet.rows ?? [];
  const total = (facet.total[0]?.value ?? 0) as number;

  if (windowRows === null) return { rows: fetched as Row[], total };

  windowCache.set(cacheKey, buildWindow(fetched, total) satisfies UserActivityWindow);
  return { rows: fetched.slice(skip, skip + limit) as Row[], total };
};

/** Rows the group key would have produced with the whole metadata subdocument still in it. */
const countFragments = async () => {
  const fragments = await counterLogs
    .aggregate([
      {
        $group: {
          _id: {
            d: { $dateToString: { format: '%Y-%m-%d', date: '$datetime', timezone: 'UTC' } },
            c: '$counterName',
            u: '$userId',
            m: '$metadata',
          },
        },
      },
      { $count: 'value' },
    ])
    .toArray();
  return (fragments[0]?.value ?? 0) as number;
};

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  const db = mongoose.connection.db!;
  counterLogs = db.collection('counterlogs');

  await db.collection('users').insertMany([
    { _id: USER_A, email: EMAIL[USER_A.toString()] },
    { _id: USER_B, email: EMAIL[USER_B.toString()] },
  ]);
  await counterLogs.insertMany(FIXTURE);
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, 60000);

beforeEach(() => {
  windowCache = new Map();
  aggregations = 0;
});

describe('user activity row unit', () => {
  it('returns the same rows and counts as the pre-pagination client merge', async () => {
    const { rows, total } = await servePage(RANGE);
    const expected = mergedLikeThePrePaginationClient(FIXTURE);

    expect(total).toBe(expected.length);
    expect(rows).toHaveLength(expected.length);

    const byKey = new Map(rows.map(row => [identify(row), row]));
    for (const row of expected) {
      // Two report rows share a key here, so compare their summed count/value per key: the
      // reportId split is asserted separately below.
      expect(byKey.has(identify(row)), `missing row ${identify(row)}`).toBe(true);
    }
    const sum = (list: Row[], field: 'count' | 'totalValue') => list.reduce((acc, row) => acc + row[field], 0);
    expect(sum(rows, 'count')).toBe(sum(expected, 'count'));
    expect(sum(rows, 'totalValue')).toBe(sum(expected, 'totalValue'));
  });

  it('collapses events that differ only in identity metadata', async () => {
    const { rows, total } = await servePage(RANGE);

    // The matched pair: one row per raw event before, one row per activity now.
    expect(await countFragments()).toBe(FIXTURE.length);
    expect(total).toBe(5);

    const sessions = rows.find(r => r.counterName === 'Session Created' && r.userEmail === 'ada@example.com');
    expect(sessions).toMatchObject({ date: '2026-07-24', count: 40, totalValue: 40 });

    const completions = rows.find(r => r.counterName === 'Completion API Completed');
    expect(completions).toMatchObject({ count: 25, totalValue: 50 });
  });

  it('still splits report activity per report', async () => {
    const { rows } = await servePage(RANGE);

    const reports = rows.filter(r => r.counterName === 'Marketing Report Opened');
    expect(reports).toHaveLength(2);
    expect(reports.map(r => r.count).sort()).toEqual([2, 4]);
    expect(new Set(reports.map(r => (r as unknown as { metadata: { reportId: string } }).metadata.reportId))).toEqual(
      new Set(['report-1', 'report-2'])
    );
  });

  it('carries the organization the counter log recorded', async () => {
    const { rows } = await servePage(RANGE);

    expect(rows.every(r => (r as unknown as { userOrganization: string }).userOrganization === 'Acme')).toBe(true);
  });

  it('keeps a metadata sample on the collapsed row for the grid to render', async () => {
    const { rows } = await servePage(RANGE);

    const sessions = rows.find(r => r.counterName === 'Session Created' && r.userEmail === 'ada@example.com');
    // A sample of the group, not a summary of it - which sample is not guaranteed.
    expect((sessions as unknown as { metadata: { sessionId: string } }).metadata.sessionId).toMatch(/^session-\d+$/);
  });

  it('filters on metadata that is no longer part of the group key', async () => {
    // The filter runs before $group, so a key dropped from the group is still filterable.
    const { rows, total } = await servePage({
      ...RANGE,
      metadataFilters: [{ field: 'source', operator: 'equals', value: 'cli' }],
    });

    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({ counterName: 'Completion API Completed', count: 9 });
  });

  it('pages the collapsed rows without repeating or dropping one', async () => {
    // Sequential, not concurrent: page 1 has to populate the window the later pages slice.
    const pages = [];
    for (const page of [1, 2, 3]) pages.push(await servePage(RANGE, page, 2));
    const seen = pages.flatMap(p => p.rows).map(identify);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(4); // the two report rows share a date/counter/email key
    // The window covers all 5 collapsed rows, so paging through them costs one aggregation.
    expect(aggregations).toBe(1);
  });
});
